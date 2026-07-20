// ENCORE XO™ sync Worker — 6-digit PIN handshake + R2 clip relay
//                        + rendered-video device-bound viewer tokens
//
// Bindings required (dashboard → Worker → Settings → Bindings):
//   R2 bucket:  MEDIA  ->  encorexo-media
//
// Endpoints:
//   GET    /health
//   POST   /pin/new                       -> { pin, ttlMs, expiresAt }
//   GET    /pin/:pin/list                 -> { pin, files, expiresAt }
//   POST   /pin/:pin/upload?filename=     -> { ok, filename, key }
//   GET    /pin/:pin/file/:name           -> binary blob
//   DELETE /pin/:pin                      -> { ok, deleted }
//
//   Render viewer (device-bound):
//   POST   /render/new                    -> { token, uploadUrl, viewerUrl, expiresAt }
//   POST   /render/:token/upload          -> { ok, sizeBytes }
//   GET    /render/:token/meta            -> { hasVideo, boundDevice, expiresAt }
//   POST   /render/:token/claim           -> { ok, deviceToken }  (first caller wins)
//   GET    /render/:token/video?device=X  -> binary stream (403 unless device matches)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range, If-Range, If-None-Match, Authorization',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, ETag',
  'Access-Control-Max-Age': '86400',
};

const PIN_TTL_MS = 24 * 60 * 60 * 1000; // 24h — device-binding for the day
const RENDER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days for buyer-scan viewer tokens
// TESTING MODE: once a render has been claimed (device-bound), it expires
// after 5 min. Lets Captain iterate on stream/playback quality without R2
// clutter. Un-bound renders still use the full 30-day TTL.
const PREVIEWED_RENDER_TTL_MS = 5 * 60 * 1000;
const MAX_FILE_SIZE = 200 * 1024 * 1024;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 day sliding session
const MAX_2257_FILE_SIZE = 20 * 1024 * 1024;     // 20 MB per ID/selfie
const PBKDF2_ITERS = 100_000; // Cloudflare Workers hard-cap PBKDF2 iterations at 100k

// ---------------- ACCOUNT HELPERS ----------------

function toB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(s) {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hashPassword(password, saltBytes) {
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder().encode(password);
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc, 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    keyMaterial, 256,
  );
  return { hash: toB64(new Uint8Array(bits)), salt: toB64(salt) };
}

async function verifyPassword(password, hashB64, saltB64) {
  const salt = fromB64(saltB64);
  const { hash } = await hashPassword(password, salt);
  return hash === hashB64;
}

function newAccountId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return 'acc_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function newSessionToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function normalizeEmail(e) {
  return String(e || '').trim().toLowerCase();
}

async function loadAccount(env, accountId) {
  const obj = await env.MEDIA.get(`account/${accountId}/_manifest.json`);
  if (!obj) return null;
  try { return JSON.parse(await obj.text()); } catch { return null; }
}
async function saveAccount(env, accountId, manifest) {
  await env.MEDIA.put(`account/${accountId}/_manifest.json`, JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
  });
}
async function loadAccountIdByEmail(env, email) {
  const obj = await env.MEDIA.get(`account/_email/${normalizeEmail(email)}.txt`);
  if (!obj) return null;
  return (await obj.text()).trim();
}
async function saveEmailIndex(env, email, accountId) {
  await env.MEDIA.put(`account/_email/${normalizeEmail(email)}.txt`, accountId, {
    httpMetadata: { contentType: 'text/plain' },
  });
}
async function loadSession(env, token) {
  const obj = await env.MEDIA.get(`account/_session/${token}.json`);
  if (!obj) return null;
  try { return JSON.parse(await obj.text()); } catch { return null; }
}
async function saveSession(env, token, session) {
  await env.MEDIA.put(`account/_session/${token}.json`, JSON.stringify(session), {
    httpMetadata: { contentType: 'application/json' },
  });
}
async function deleteSession(env, token) {
  try { await env.MEDIA.delete(`account/_session/${token}.json`); } catch {}
}

// Resolve Authorization: Bearer <token> → { accountId, manifest } or null
async function resolveSession(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+([a-f0-9]+)$/i);
  if (!m) return null;
  const token = m[1];
  const session = await loadSession(env, token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    await deleteSession(env, token);
    return null;
  }
  const manifest = await loadAccount(env, session.accountId);
  if (!manifest) return null;
  // Slide session
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  await saveSession(env, token, session);
  return { accountId: session.accountId, manifest, token };
}

async function safeJson(request) {
  try { return await request.json(); } catch { return null; }
}

function newRenderToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function loadRenderManifest(env, token) {
  const obj = await env.MEDIA.get(`renders/${token}/_manifest.json`);
  if (!obj) return null;
  try { return JSON.parse(await obj.text()); }
  catch { return null; }
}

async function saveRenderManifest(env, token, manifest) {
  await env.MEDIA.put(`renders/${token}/_manifest.json`, JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
  });
}

function isRenderExpired(manifest) {
  // Previewed (device-bound) renders expire 5 min after bind — testing mode.
  if (manifest.boundAt && Date.now() - manifest.boundAt > PREVIEWED_RENDER_TTL_MS) {
    return true;
  }
  return Date.now() - manifest.createdAt > RENDER_TTL_MS;
}

function withCors(resp) {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, headers });
}

function json(obj, status = 200) {
  return withCors(new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

function newPin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function loadManifest(env, pin) {
  const obj = await env.MEDIA.get(`${pin}/_manifest.json`);
  if (!obj) return null;
  try { return JSON.parse(await obj.text()); }
  catch { return null; }
}

async function saveManifest(env, pin, manifest) {
  await env.MEDIA.put(`${pin}/_manifest.json`, JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
  });
}

function isExpired(manifest) {
  return Date.now() - manifest.createdAt > PIN_TTL_MS;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (pathname === '/health') return json({ ok: true, ts: Date.now() });

    // ------- Rendered-video device-bound viewer -------

    // POST /render/new — mint a token; return upload + viewer URLs
    if (method === 'POST' && pathname === '/render/new') {
      const token = newRenderToken();
      const manifest = {
        token,
        createdAt: Date.now(),
        hasVideo: false,
        sizeBytes: 0,
        contentType: '',
        boundDevice: null,
        boundAt: null,
      };
      await saveRenderManifest(env, token, manifest);
      return json({
        token,
        uploadUrl: `/render/${token}/upload`,
        viewerUrl: `https://shoot.encorexo.com/v/${token}`,
        expiresAt: manifest.createdAt + RENDER_TTL_MS,
      });
    }

    // /render/:token/...
    const renderMatch = pathname.match(/^\/render\/([a-f0-9]{32})(\/.*)?$/);
    if (renderMatch) {
      const token = renderMatch[1];
      const rest = renderMatch[2] || '';

      const manifest = await loadRenderManifest(env, token);
      if (!manifest) return json({ error: 'render-not-found', token }, 404);
      if (isRenderExpired(manifest)) return json({ error: 'render-expired', token }, 410);

      // POST /render/:token/upload — one-shot only; refuse if video already stored
      if (method === 'POST' && rest === '/upload') {
        if (manifest.hasVideo) return json({ error: 'already-uploaded' }, 409);
        const contentType = request.headers.get('Content-Type') || 'video/mp4';
        const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
        if (contentLength && contentLength > MAX_FILE_SIZE) {
          return json({ error: 'too-large', maxBytes: MAX_FILE_SIZE }, 413);
        }
        const ext = contentType.startsWith('video/mp4') ? 'mp4' : 'webm';
        const key = `renders/${token}/video.${ext}`;
        await env.MEDIA.put(key, request.body, {
          httpMetadata: { contentType },
        });
        manifest.hasVideo = true;
        manifest.sizeBytes = contentLength || 0;
        manifest.contentType = contentType;
        manifest.fileExt = ext;
        await saveRenderManifest(env, token, manifest);
        return json({ ok: true, sizeBytes: manifest.sizeBytes });
      }

      // GET /render/:token/meta — non-video status for viewer page
      if (method === 'GET' && rest === '/meta') {
        // Report the EFFECTIVE expiry (5-min bind-based if claimed, else 30-day).
        const effectiveExpiresAt = manifest.boundAt
          ? manifest.boundAt + PREVIEWED_RENDER_TTL_MS
          : manifest.createdAt + RENDER_TTL_MS;
        return json({
          token,
          hasVideo: manifest.hasVideo,
          sizeBytes: manifest.sizeBytes,
          contentType: manifest.contentType,
          boundDevice: manifest.boundDevice ? 'claimed' : null,
          expiresAt: effectiveExpiresAt,
        });
      }

      // POST /render/:token/claim — first caller wins; returns device token
      if (method === 'POST' && rest === '/claim') {
        if (manifest.boundDevice) {
          return json({ error: 'already-claimed' }, 403);
        }
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        const deviceToken = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        manifest.boundDevice = deviceToken;
        manifest.boundAt = Date.now();
        await saveRenderManifest(env, token, manifest);
        return json({ ok: true, deviceToken });
      }

      // GET /render/:token/video?device=X — device-gated video stream
      // Handles Range: requests (206 Partial Content) so iOS Safari can seek.
      // Stable strong ETag + private cache: iOS Safari fires many Range
      // requests during playback; without a stable validator it silently
      // stalls when revalidation-forced 206s land inconsistently. ETag is
      // derived from immutable token + sizeBytes so it never drifts.
      if (method === 'GET' && rest === '/video') {
        if (!manifest.hasVideo) return json({ error: 'not-uploaded-yet' }, 404);
        const device = url.searchParams.get('device') || '';
        if (!manifest.boundDevice) return json({ error: 'not-claimed' }, 403);
        if (device !== manifest.boundDevice) return json({ error: 'device-mismatch' }, 403);
        const ext = manifest.fileExt || (manifest.contentType?.startsWith('video/mp4') ? 'mp4' : 'webm');
        const key = `renders/${token}/video.${ext}`;
        const contentType = manifest.contentType || (ext === 'mp4' ? 'video/mp4' : 'video/webm');
        const etag = `"${token}-${manifest.sizeBytes}"`;
        const cacheControl = 'private, max-age=3600';

        const rangeHeader = request.headers.get('Range');
        if (rangeHeader) {
          const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
          if (m) {
            const start = parseInt(m[1], 10);
            const end = m[2] ? parseInt(m[2], 10) : undefined;
            const obj = await env.MEDIA.get(key, {
              range: end !== undefined
                ? { offset: start, length: end - start + 1 }
                : { offset: start },
            });
            if (!obj) return json({ error: 'file-missing' }, 404);
            const total = obj.size || manifest.sizeBytes;
            const actualEnd = end !== undefined ? end : total - 1;
            const headers = new Headers(CORS_HEADERS);
            headers.set('Content-Type', contentType);
            headers.set('Cache-Control', cacheControl);
            headers.set('Accept-Ranges', 'bytes');
            headers.set('ETag', etag);
            headers.set('Content-Range', `bytes ${start}-${actualEnd}/${total}`);
            headers.set('Content-Length', String(actualEnd - start + 1));
            return new Response(obj.body, { status: 206, headers });
          }
        }

        const obj = await env.MEDIA.get(key);
        if (!obj) return json({ error: 'file-missing' }, 404);
        const headers = new Headers(CORS_HEADERS);
        headers.set('Content-Type', contentType);
        headers.set('Cache-Control', cacheControl);
        headers.set('Accept-Ranges', 'bytes');
        headers.set('ETag', etag);
        headers.set('Content-Length', String(manifest.sizeBytes));
        return new Response(obj.body, { headers });
      }
    }
    // ------- end render endpoints -------


    // POST /pin/new
    if (method === 'POST' && pathname === '/pin/new') {
      let pin = newPin();
      for (let i = 0; i < 5; i++) {
        const existing = await loadManifest(env, pin);
        if (!existing) break;
        pin = newPin();
      }
      const manifest = { pin, createdAt: Date.now(), files: [] };
      await saveManifest(env, pin, manifest);
      return json({ pin, ttlMs: PIN_TTL_MS, expiresAt: manifest.createdAt + PIN_TTL_MS });
    }

    // /pin/:pin/...
    const pinMatch = pathname.match(/^\/pin\/(\d{6})(\/.*)?$/);
    if (pinMatch) {
      const pin = pinMatch[1];
      const rest = pinMatch[2] || '';

      const manifest = await loadManifest(env, pin);
      if (!manifest) return json({ error: 'pin-not-found', pin }, 404);
      if (isExpired(manifest)) return json({ error: 'pin-expired', pin }, 410);

      // GET /pin/:pin/list
      if (method === 'GET' && (rest === '' || rest === '/' || rest === '/list')) {
        return json({
          pin,
          files: manifest.files || [],
          expiresAt: manifest.createdAt + PIN_TTL_MS,
        });
      }

      // POST /pin/:pin/upload?filename=&kind=clip|audio&direction=to-editor|to-phone
      if (method === 'POST' && rest === '/upload') {
        const filename = url.searchParams.get('filename') || `clip_${Date.now()}.webm`;
        const kind = url.searchParams.get('kind') || 'clip';
        const direction = url.searchParams.get('direction') || 'to-editor';
        const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
        const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
        if (contentLength && contentLength > MAX_FILE_SIZE) {
          return json({ error: 'too-large', maxBytes: MAX_FILE_SIZE }, 413);
        }

        const key = `${pin}/${safeName}`;
        await env.MEDIA.put(key, request.body, {
          httpMetadata: { contentType },
        });

        const files = Array.isArray(manifest.files) ? manifest.files : [];
        files.push({
          filename: safeName,
          contentType,
          size: contentLength || 0,
          uploadedAt: Date.now(),
          kind,
          direction,
        });
        manifest.files = files;
        await saveManifest(env, pin, manifest);
        return json({ ok: true, filename: safeName, key, kind, direction });
      }

      // GET /pin/:pin/file/:name
      const fileMatch = rest.match(/^\/file\/(.+)$/);
      if (method === 'GET' && fileMatch) {
        const filename = decodeURIComponent(fileMatch[1]);
        const obj = await env.MEDIA.get(`${pin}/${filename}`);
        if (!obj) return json({ error: 'file-not-found', filename }, 404);
        const headers = new Headers(CORS_HEADERS);
        headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
        headers.set('Cache-Control', 'private, no-cache');
        return new Response(obj.body, { headers });
      }

      // DELETE /pin/:pin/file/:name — permanent library delete of one clip
      if (method === 'DELETE' && fileMatch) {
        const filename = decodeURIComponent(fileMatch[1]);
        await env.MEDIA.delete(`${pin}/${filename}`);
        const files = Array.isArray(manifest.files) ? manifest.files : [];
        manifest.files = files.filter((f) => f && f.filename !== filename);
        await saveManifest(env, pin, manifest);
        return json({ ok: true, deleted: filename });
      }

      // DELETE /pin/:pin/files — clear R2 files, keep session alive
      if (method === 'DELETE' && rest === '/files') {
        const list = await env.MEDIA.list({ prefix: `${pin}/` });
        const toDelete = list.objects.filter((o) => !o.key.endsWith('/_manifest.json'));
        await Promise.all(toDelete.map((o) => env.MEDIA.delete(o.key)));
        manifest.files = [];
        await saveManifest(env, pin, manifest);
        return json({ ok: true, deleted: toDelete.length, sessionKept: true });
      }

      // DELETE /pin/:pin
      if (method === 'DELETE' && (rest === '' || rest === '/')) {
        const list = await env.MEDIA.list({ prefix: `${pin}/` });
        await Promise.all(list.objects.map((o) => env.MEDIA.delete(o.key)));
        return json({ ok: true, deleted: list.objects.length });
      }
    }

    // ------- ACCOUNT ENDPOINTS -------

    // POST /account/create — { email, password, displayName, stageName }
    if (method === 'POST' && pathname === '/account/create') {
      const body = await safeJson(request);
      if (!body) return json({ error: 'invalid-body' }, 400);
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      const displayName = String(body.displayName || '').trim();
      const stageName = String(body.stageName || '').trim();
      if (!email || !password || !displayName) {
        return json({ error: 'missing-fields' }, 400);
      }
      if (password.length < 8) return json({ error: 'password-too-short' }, 400);
      const existingId = await loadAccountIdByEmail(env, email);
      if (existingId) return json({ error: 'email-taken' }, 409);
      const accountId = newAccountId();
      const { hash, salt } = await hashPassword(password);
      const manifest = {
        accountId,
        email,
        passwordHash: hash,
        passwordSalt: salt,
        displayName,
        stageName,
        createdAt: Date.now(),
        verification2257: {
          status: 'not_started', // not_started | pending | approved | rejected
          submittedAt: null,
          reviewedAt: null,
          legalName: null,
          dob: null,
        },
        magazineSubmissions: [],
      };
      await saveAccount(env, accountId, manifest);
      await saveEmailIndex(env, email, accountId);
      const token = newSessionToken();
      await saveSession(env, token, {
        accountId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS,
      });
      return json({
        ok: true,
        accountId,
        sessionToken: token,
        account: publicAccount(manifest),
      });
    }

    // POST /account/login — { email, password }
    if (method === 'POST' && pathname === '/account/login') {
      const body = await safeJson(request);
      if (!body) return json({ error: 'invalid-body' }, 400);
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      if (!email || !password) return json({ error: 'missing-fields' }, 400);
      const accountId = await loadAccountIdByEmail(env, email);
      if (!accountId) return json({ error: 'invalid-credentials' }, 401);
      const manifest = await loadAccount(env, accountId);
      if (!manifest) return json({ error: 'invalid-credentials' }, 401);
      const ok = await verifyPassword(password, manifest.passwordHash, manifest.passwordSalt);
      if (!ok) return json({ error: 'invalid-credentials' }, 401);
      const token = newSessionToken();
      await saveSession(env, token, {
        accountId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS,
      });
      return json({
        ok: true,
        accountId,
        sessionToken: token,
        account: publicAccount(manifest),
      });
    }

    // POST /account/logout — invalidate current session
    if (method === 'POST' && pathname === '/account/logout') {
      const sess = await resolveSession(env, request);
      if (sess) await deleteSession(env, sess.token);
      return json({ ok: true });
    }

    // GET /account/me — current session's account
    if (method === 'GET' && pathname === '/account/me') {
      const sess = await resolveSession(env, request);
      if (!sess) return json({ error: 'not-authenticated' }, 401);
      return json({ ok: true, account: publicAccount(sess.manifest) });
    }

    // POST /account/2257/upload?type=id-front|id-back|selfie — raw body = image bytes
    if (method === 'POST' && pathname === '/account/2257/upload') {
      const sess = await resolveSession(env, request);
      if (!sess) return json({ error: 'not-authenticated' }, 401);
      const type = url.searchParams.get('type') || '';
      if (!['id-front', 'id-back', 'selfie'].includes(type)) {
        return json({ error: 'bad-type', validTypes: ['id-front', 'id-back', 'selfie'] }, 400);
      }
      const contentType = request.headers.get('Content-Type') || 'image/jpeg';
      const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
      if (contentLength && contentLength > MAX_2257_FILE_SIZE) {
        return json({ error: 'too-large', maxBytes: MAX_2257_FILE_SIZE }, 413);
      }
      const ext = contentType.includes('png') ? 'png' : 'jpg';
      const key = `account/${sess.accountId}/2257/${type}.${ext}`;
      await env.MEDIA.put(key, request.body, { httpMetadata: { contentType } });
      return json({ ok: true, type, sizeBytes: contentLength || 0 });
    }

    // POST /account/2257/submit — { dob (YYYY-MM-DD), legalName }
    if (method === 'POST' && pathname === '/account/2257/submit') {
      const sess = await resolveSession(env, request);
      if (!sess) return json({ error: 'not-authenticated' }, 401);
      const body = await safeJson(request);
      if (!body) return json({ error: 'invalid-body' }, 400);
      const dob = String(body.dob || '').trim();
      const legalName = String(body.legalName || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return json({ error: 'bad-dob' }, 400);
      if (!legalName) return json({ error: 'missing-legal-name' }, 400);
      // 18+ check
      const dobDate = new Date(dob);
      const ageMs = Date.now() - dobDate.getTime();
      const ageYears = ageMs / (365.25 * 24 * 60 * 60 * 1000);
      if (!isFinite(ageYears) || ageYears < 18) {
        return json({ error: 'must-be-18-plus' }, 403);
      }
      // Verify all 3 files uploaded
      const parts = ['id-front', 'id-back', 'selfie'];
      for (const p of parts) {
        const jpg = await env.MEDIA.head(`account/${sess.accountId}/2257/${p}.jpg`).catch(() => null);
        const png = await env.MEDIA.head(`account/${sess.accountId}/2257/${p}.png`).catch(() => null);
        if (!jpg && !png) return json({ error: 'missing-file', part: p }, 400);
      }
      const m = sess.manifest;
      m.verification2257 = {
        status: 'approved', // TESTING: auto-approve for MVP. Real flow → 'pending' + admin approves.
        submittedAt: Date.now(),
        reviewedAt: Date.now(),
        legalName,
        dob,
      };
      await saveAccount(env, sess.accountId, m);
      return json({ ok: true, verification2257: m.verification2257 });
    }

    // GET /account/2257/status — current 2257 status
    if (method === 'GET' && pathname === '/account/2257/status') {
      const sess = await resolveSession(env, request);
      if (!sess) return json({ error: 'not-authenticated' }, 401);
      return json({ ok: true, verification2257: sess.manifest.verification2257 });
    }

    // ------- end account endpoints -------

    return json({ error: 'route-not-found', method, path: pathname }, 404);
  },
};

// Never leak passwordHash/salt/sessions to clients.
function publicAccount(m) {
  return {
    accountId: m.accountId,
    email: m.email,
    displayName: m.displayName,
    stageName: m.stageName,
    createdAt: m.createdAt,
    verification2257: m.verification2257,
    magazineSubmissions: m.magazineSubmissions || [],
  };
}
