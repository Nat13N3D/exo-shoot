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
  'Access-Control-Allow-Headers': 'Content-Type, Range, If-Range, If-None-Match, Authorization, X-Phone-Token',
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

// ---------------- INVITE HELPERS ----------------
// Invite code: 12 alphanumeric chars, uppercase, dashed 4-4-4 (A3F9-K2LP-8QM6).
// Alphabet excludes 0/O and 1/I/L to avoid handwritten/QR-scan ambiguity.
const INVITE_CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// Password: 6-char pure alphanumeric, no separators, no ambiguous chars
// (0/O/o/1/I/l excluded). Simplest possible for the artist to read off
// her phone + type on her laptop. 54^6 = ~24 billion possibilities;
// paired with edge rate limits, brute force is impractical.
const INVITE_PASSWORD_ALPHA = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_PASSWORD_LEN = 6;
const INVITE_CODE_LEN = 12;
const INVITE_RSVP_TTL_MS = 24 * 60 * 60 * 1000; // 24-hour hold after ACCEPT

function pickFromAlphabet(alpha, len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alpha[b % alpha.length]).join('');
}
function generateInviteCode() {
  const raw = pickFromAlphabet(INVITE_CODE_ALPHA, INVITE_CODE_LEN);
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}
function generateInvitePassword() {
  return pickFromAlphabet(INVITE_PASSWORD_ALPHA, INVITE_PASSWORD_LEN);
}
// Reverse lookup: password → invite code. R2 key allows most chars but
// slashes create pseudo-folders; encodeURIComponent handles it.
async function savePasswordIndex(env, password, code) {
  const key = `invite/_pwindex/${encodeURIComponent(password)}.txt`;
  await env.MEDIA.put(key, code, {
    httpMetadata: { contentType: 'text/plain' },
  });
  console.log('[invite pw save] key:', key, '-> code:', code);
}
async function loadInviteCodeByPassword(env, password) {
  const key = `invite/_pwindex/${encodeURIComponent(password)}.txt`;
  const obj = await env.MEDIA.get(key);
  if (!obj) {
    console.warn('[invite pw lookup] MISS — key:', key, '(password length:', password?.length, ')');
    return null;
  }
  console.log('[invite pw lookup] HIT — key:', key);
  return (await obj.text()).trim();
}
async function deletePasswordIndex(env, password) {
  try { await env.MEDIA.delete(`invite/_pwindex/${encodeURIComponent(password)}.txt`); } catch {}
}
function newPhoneDeviceToken() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function normalizeInviteCode(s) {
  // Accept "a3f9k2lp8qm6" or "A3F9-K2LP-8QM6" or spaces — normalize to
  // uppercase dashed 4-4-4 for lookup.
  const clean = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== INVITE_CODE_LEN) return null;
  return `${clean.slice(0, 4)}-${clean.slice(4, 8)}-${clean.slice(8, 12)}`;
}
async function loadInvite(env, code) {
  const obj = await env.MEDIA.get(`invite/${code}/_manifest.json`);
  if (!obj) return null;
  try { return JSON.parse(await obj.text()); } catch { return null; }
}
async function saveInvite(env, code, manifest) {
  await env.MEDIA.put(`invite/${code}/_manifest.json`, JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
  });
}
function inviteIsRsvpExpired(m) {
  return m.status === 'rsvp-hold' && m.rsvpExpiresAt && Date.now() > m.rsvpExpiresAt;
}
// Phone-safe subset — never leak internal fields or the deviceToken
// beyond the phone that owns it. Password IS included so the paired
// phone can display it for the artist to type on desktop.
function publicInvite(m, opts = {}) {
  const base = {
    code: m.code,
    status: m.status,
    createdAt: m.createdAt,
    phoneModel: m.phoneModel || null,
    rsvpExpiresAt: m.rsvpExpiresAt || null,
    consumedAt: m.consumedAt || null,
  };
  if (opts.includePassword) base.password = m.password;
  if (opts.includeDeviceToken) base.phoneDeviceToken = m.phoneDeviceToken;
  return base;
}
// Admin-view — full manifest minus nothing.
function adminInvite(m) { return { ...m }; }

// ---------------- MESSAGES ----------------
function newMessageId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return 'msg_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function newThreadId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return 'thr_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
async function listMessagesForAccount(env, accountId) {
  const list = await env.MEDIA.list({ prefix: `account/${accountId}/messages/` });
  const messages = [];
  for (const obj of list.objects) {
    if (!obj.key.endsWith('.json')) continue;
    const r = await env.MEDIA.get(obj.key);
    if (!r) continue;
    try { messages.push(JSON.parse(await r.text())); } catch {}
  }
  messages.sort((a, b) => (a.sentAt || 0) - (b.sentAt || 0));
  return messages;
}
async function saveMessage(env, accountId, msg) {
  await env.MEDIA.put(`account/${accountId}/messages/${msg.messageId}.json`, JSON.stringify(msg), {
    httpMetadata: { contentType: 'application/json' },
  });
}
async function loadMessage(env, accountId, messageId) {
  const obj = await env.MEDIA.get(`account/${accountId}/messages/${messageId}.json`);
  if (!obj) return null;
  try { return JSON.parse(await obj.text()); } catch { return null; }
}

// ---------------- PRIVACY POLICY EMAIL ----------------
// Pre-built for future Resend paid-tier activation. Gated by
// artistEmailsEnabled(env).
function buildPrivacyPolicyEmail(m) {
  const name = escapeHtml(m.displayName || m.stageName || 'artist');
  return `
<div style="font-family: system-ui, -apple-system, sans-serif; max-width: 620px; margin: 0 auto; padding: 24px; background: #0a0a0a; color: #e0d0ff;">
  <div style="font-size: 22px; font-weight: 900; letter-spacing: 0.28em; color: #d4af37; margin-bottom: 20px; text-align: center;">ENCORE XO&trade;</div>
  <div style="font-size: 13px; letter-spacing: 0.22em; color: #d4af37; font-weight: 700; margin-bottom: 12px;">YOUR PRIVACY POLICY</div>
  <p style="line-height: 1.7;">Hi ${name}, here is a copy of the privacy notice you acknowledged. Keep this for your records.</p>

  <div style="font-size: 11px; letter-spacing: 0.22em; color: #d4af37; font-weight: 700; margin-top: 18px;">WHO WE ARE</div>
  <p style="line-height: 1.7; font-size: 13px;">ENCORE XO&trade; is a service operated by <strong>707G HOLDINGS LLC</strong>, a Georgia limited liability company based in Atlanta, GA.</p>
  <div style="background: #161020; border: 1px solid #4a3560; border-radius: 4px; padding: 10px 14px; margin: 10px 0; font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: #d4af37; line-height: 1.9;">
    707G HOLDINGS LLC<br />1445 Woodmont Lane, Suite 853<br />Atlanta, GA 30318<br />&#9742; 470-491-5972<br />&#9993; admin@seventy7g.com
  </div>

  <div style="font-size: 11px; letter-spacing: 0.22em; color: #d4af37; font-weight: 700; margin-top: 18px;">WHY WE'RE ASKING</div>
  <p style="line-height: 1.7; font-size: 13px;">Federal law (18 U.S.C. &sect;2257) requires that we verify the age and identity of every performer before their content is published. This is a one-time compliance step.</p>

  <div style="font-size: 11px; letter-spacing: 0.22em; color: #d4af37; font-weight: 700; margin-top: 18px;">HOW WE PROTECT YOU</div>
  <p style="line-height: 1.7; font-size: 13px;">Your documents are stored encrypted, accessible only to our custodian of records and to you. They are never shared publicly, never sold, never used for marketing.</p>

  <div style="font-size: 11px; letter-spacing: 0.22em; color: #d4af37; font-weight: 700; margin-top: 18px;">CUSTODIAN OF RECORDS</div>
  <p style="line-height: 1.7; font-size: 13px;">Records required by <strong>18 U.S.C. &sect;&sect; 2257 and 2257A</strong> and the implementing regulations at <strong>28 C.F.R. Part 75</strong> are maintained by 707G HOLDINGS LLC at the address above. 707G HOLDINGS LLC serves as the <strong>OFFICIAL CUSTODIAN OF RECORDS</strong> for ENCORE XO&trade;.</p>

  <div style="font-size: 11px; letter-spacing: 0.22em; color: #d4af37; font-weight: 700; margin-top: 18px;">YOUR RIGHTS</div>
  <p style="line-height: 1.7; font-size: 13px;">You may request a copy of your record or request its deletion (subject to the federal retention period) by emailing <strong>admin@seventy7g.com</strong> from your registered address.</p>

  <p style="line-height: 1.7; font-size: 11px; color: #8a7a9e; margin-top: 24px; text-align: center;">This is a one-time step. We will never ask you for these documents again unless you request a replacement.</p>
</div>`;
}

// ---------------- ADMIN PASSWORD (mutable, self-service) ----------------
// Priority:
//   1. R2 admin/_password.json (hashed) — set via /admin/change-password
//   2. env.ADMIN_SECRET plaintext — bootstrap only; once R2 exists, ignored.
async function loadAdminPasswordRecord(env) {
  const obj = await env.MEDIA.get('admin/_password.json');
  if (!obj) return null;
  try { return JSON.parse(await obj.text()); } catch { return null; }
}
async function saveAdminPasswordRecord(env, record) {
  await env.MEDIA.put('admin/_password.json', JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json' },
  });
}
async function checkAdminPassword(env, provided) {
  if (!provided) return false;
  const rec = await loadAdminPasswordRecord(env);
  if (rec && rec.passwordHash && rec.passwordSalt) {
    return await verifyPassword(provided, rec.passwordHash, rec.passwordSalt);
  }
  // Bootstrap: env.ADMIN_SECRET literal match.
  const boot = env.ADMIN_SECRET || '';
  return !!boot && provided === boot;
}

// ---------------- EMAIL (Resend) ----------------
// Free-tier sender: onboarding@resend.dev — no domain verification needed.
// Reply-To is set to env.ADMIN_EMAIL so operator replies land in that inbox.
// Failures are logged but do NOT throw — email is best-effort, never blocks
// account/render flows.
//
// ARTIST EMAILS ON/OFF SWITCH — Captain's flag. Free-tier Resend blocks
// all recipients except admin@seventy7g.com. When Captain upgrades Resend
// to a verified domain, set env.EMAILS_TO_ARTISTS_ENABLED = "1" (via
// wrangler secret put) — the email code paths that go to arbitrary artist
// addresses will start firing. Admin-bound emails (new-artist-pending,
// resubmission-required) always fire regardless.
function artistEmailsEnabled(env) {
  return (env.EMAILS_TO_ARTISTS_ENABLED || '').trim() === '1';
}
async function sendEmail(env, { to, subject, html, text, replyTo }) {
  const key = env.RESEND_API_KEY;
  if (!key) {
    console.warn('[EMAIL] RESEND_API_KEY not set — skipping send to', to);
    return { ok: false, reason: 'no-key' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        from: 'ENCORE XO <onboarding@resend.dev>',
        to: Array.isArray(to) ? to : [to],
        subject,
        html: html || undefined,
        text: text || undefined,
        reply_to: replyTo || env.ADMIN_EMAIL || undefined,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[EMAIL] send failed', res.status, body);
      return { ok: false, status: res.status, body };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, id: data.id };
  } catch (e) {
    console.warn('[EMAIL] send threw', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
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

    // ------- ADMIN ENDPOINTS (Bearer <admin password>) -------
    if (pathname.startsWith('/admin/')) {
      const auth = request.headers.get('Authorization') || '';
      const m = auth.match(/^Bearer\s+(.+)$/i);
      const provided = m ? m[1] : '';
      const ok = await checkAdminPassword(env, provided);
      if (!ok) {
        return json({ error: 'admin-auth-required' }, 401);
      }

      // POST /admin/change-password  { newPassword }
      // Authorization Bearer must be the CURRENT admin password.
      if (method === 'POST' && pathname === '/admin/change-password') {
        const body = await safeJson(request);
        const newPassword = String(body?.newPassword || '');
        if (newPassword.length < 8) {
          return json({ error: 'password-too-short', min: 8 }, 400);
        }
        const { hash, salt } = await hashPassword(newPassword);
        await saveAdminPasswordRecord(env, {
          passwordHash: hash,
          passwordSalt: salt,
          updatedAt: Date.now(),
        });
        return json({ ok: true });
      }

      // GET /admin/accounts?status=&search=
      if (method === 'GET' && pathname === '/admin/accounts') {
        const statusFilter = (url.searchParams.get('status') || '').toLowerCase();
        const search = (url.searchParams.get('search') || '').toLowerCase();
        const list = await env.MEDIA.list({ prefix: 'account/' });
        const manifests = [];
        for (const obj of list.objects) {
          if (!obj.key.endsWith('/_manifest.json')) continue;
          if (obj.key.startsWith('account/_')) continue; // skip _email _session index
          const r = await env.MEDIA.get(obj.key);
          if (!r) continue;
          let m;
          try { m = JSON.parse(await r.text()); } catch { continue; }
          if (statusFilter && (m.verification2257?.status || 'not_started') !== statusFilter) continue;
          if (search) {
            const hay = `${m.email || ''} ${m.displayName || ''} ${m.stageName || ''}`.toLowerCase();
            if (!hay.includes(search)) continue;
          }
          manifests.push(publicAccount(m));
        }
        manifests.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return json({ ok: true, accounts: manifests, count: manifests.length });
      }

      // /admin/account/:id/...
      const acctMatch = pathname.match(/^\/admin\/account\/([A-Za-z0-9_]+)(\/.*)?$/);
      if (acctMatch) {
        const accountId = acctMatch[1];
        const rest = acctMatch[2] || '';
        const acct = await loadAccount(env, accountId);
        if (!acct) return json({ error: 'account-not-found', accountId }, 404);

        // GET /admin/account/:id
        if (method === 'GET' && rest === '') {
          return json({ ok: true, account: publicAccount(acct) });
        }

        // GET /admin/account/:id/2257/:type
        const fileMatch = rest.match(/^\/2257\/(id-front|id-back|selfie)$/);
        if (method === 'GET' && fileMatch) {
          const type = fileMatch[1];
          const jpg = await env.MEDIA.get(`account/${accountId}/2257/${type}.jpg`);
          const png = jpg ? null : await env.MEDIA.get(`account/${accountId}/2257/${type}.png`);
          const obj = jpg || png;
          if (!obj) return json({ error: 'file-not-found', type }, 404);
          const headers = new Headers(CORS_HEADERS);
          headers.set('Content-Type', obj.httpMetadata?.contentType || 'image/jpeg');
          headers.set('Cache-Control', 'private, no-store');
          return new Response(obj.body, { headers });
        }

        // POST /admin/account/:id/approve
        if (method === 'POST' && rest === '/approve') {
          acct.verification2257 = {
            ...acct.verification2257,
            status: 'approved',
            reviewedAt: Date.now(),
            resubmissionReason: null,
          };
          await saveAccount(env, accountId, acct);
          return json({ ok: true, account: publicAccount(acct) });
        }

        // POST /admin/account/:id/resubmit — { reason }
        if (method === 'POST' && rest === '/resubmit') {
          const body = await safeJson(request);
          const reason = String(body?.reason || '').trim();
          if (!reason) return json({ error: 'reason-required' }, 400);
          acct.verification2257 = {
            ...acct.verification2257,
            status: 'resubmission_required',
            reviewedAt: Date.now(),
            resubmissionReason: reason,
          };
          await saveAccount(env, accountId, acct);

          // Job 4: email the artist with the reason + link to redo it.
          const dispName = escapeHtml(acct.displayName || '');
          const reasonEsc = escapeHtml(reason);
          const editorLink = 'https://editor.encorexo.com';
          const html = `
            <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; background: #0a0a0a; color: #e0d0ff;">
              <div style="font-size: 18px; font-weight: 900; letter-spacing: 0.28em; color: #d4af37; margin-bottom: 18px;">ENCORE XO&trade;</div>
              <div style="font-size: 13px; letter-spacing: 0.16em; color: #d4af37; font-weight: 700;">PLEASE RESUBMIT YOUR APPLICATION</div>
              <p style="line-height: 1.7;">Hi ${dispName},</p>
              <p style="line-height: 1.7;">We reviewed your documentation and need one small adjustment before we can activate your account. Please resubmit with the change below.</p>
              <div style="background: #161020; border: 1px solid #4a3560; border-radius: 4px; padding: 14px 18px; margin: 14px 0; line-height: 1.7;">${reasonEsc}</div>
              <p><a href="${editorLink}" style="display: inline-block; background: #d4af37; color: #0a0a0a; padding: 10px 22px; text-decoration: none; border-radius: 3px; font-weight: 700; letter-spacing: 0.18em; margin-top: 8px;">RESUBMIT ON ENCOREXO</a></p>
            </div>`;
          const rsEmail = await sendEmail(env, {
            to: acct.email,
            subject: 'Please resubmit your ENCORE XO documentation',
            html,
          });
          if (!rsEmail.ok) {
            console.warn('[admin resubmit] artist notify failed (expected on free tier if artist email != Resend account email):', rsEmail);
          }

          return json({ ok: true, account: publicAccount(acct), emailSent: rsEmail.ok });
        }

        // GET /admin/account/:id/messages — list all messages
        if (method === 'GET' && rest === '/messages') {
          const messages = await listMessagesForAccount(env, accountId);
          return json({ ok: true, messages });
        }

        // POST /admin/account/:id/message — send a message from admin
        //   Body: { subject, body, threadId? }
        //   New thread if no threadId. Notification email to artist gated by
        //   artist-emails flag (silent when free-tier).
        if (method === 'POST' && rest === '/message') {
          const body = await safeJson(request);
          const subject = String(body?.subject || '').trim() || null;
          const text = String(body?.body || '').trim();
          if (!text) return json({ error: 'body-required' }, 400);
          const threadId = String(body?.threadId || '').trim() || newThreadId();
          const msg = {
            messageId: newMessageId(),
            threadId,
            from: 'admin',
            subject,
            body: text,
            sentAt: Date.now(),
            readAt: null,
          };
          await saveMessage(env, accountId, msg);
          // Pre-built artist email — gated. Flip on with EMAILS_TO_ARTISTS_ENABLED=1
          // when Resend is upgraded.
          if (artistEmailsEnabled(env)) {
            const html = `<div style="font-family: system-ui, sans-serif; padding: 24px; background: #0a0a0a; color: #e0d0ff; max-width: 520px; margin: 0 auto;">
              <div style="font-size: 18px; font-weight: 900; letter-spacing: 0.28em; color: #d4af37; text-align: center;">ENCORE XO&trade;</div>
              <div style="font-size: 12px; letter-spacing: 0.2em; color: #d4af37; font-weight: 700; margin-top: 18px;">NEW MESSAGE FROM ENCORE XO</div>
              ${subject ? `<div style="font-size: 15px; font-weight: 700; margin-top: 10px;">${escapeHtml(subject)}</div>` : ''}
              <div style="background: #161020; border: 1px solid #4a3560; border-radius: 4px; padding: 14px; margin: 14px 0; line-height: 1.7; font-size: 13px;">${escapeHtml(text)}</div>
              <p><a href="https://editor.encorexo.com" style="display: inline-block; background: #d4af37; color: #0a0a0a; padding: 10px 22px; text-decoration: none; border-radius: 3px; font-weight: 700; letter-spacing: 0.18em; margin-top: 8px;">OPEN ON ENCOREXO</a></p>
            </div>`;
            sendEmail(env, {
              to: acct.email,
              subject: subject ? `ENCORE XO: ${subject}` : 'You have a new message from ENCORE XO',
              html,
            }).catch(() => {});
          }
          return json({ ok: true, message: msg });
        }

        // DELETE /admin/account/:id — hard delete (manifest + email index + sessions + 2257 files)
        if (method === 'DELETE' && rest === '') {
          const email = acct.email;
          // Delete all files under account/{id}/
          const list = await env.MEDIA.list({ prefix: `account/${accountId}/` });
          await Promise.all(list.objects.map((o) => env.MEDIA.delete(o.key)));
          // Delete email index
          if (email) {
            try { await env.MEDIA.delete(`account/_email/${normalizeEmail(email)}.txt`); } catch {}
          }
          // Delete session records that point to this account
          const sessList = await env.MEDIA.list({ prefix: 'account/_session/' });
          for (const so of sessList.objects) {
            try {
              const sr = await env.MEDIA.get(so.key);
              if (!sr) continue;
              const s = JSON.parse(await sr.text());
              if (s.accountId === accountId) await env.MEDIA.delete(so.key);
            } catch {}
          }
          return json({ ok: true, deleted: accountId, emailFreed: email });
        }
      }

      // ------- ADMIN INVITE ENDPOINTS -------

      // POST /admin/invites/generate { count }
      if (method === 'POST' && pathname === '/admin/invites/generate') {
        const body = await safeJson(request);
        const count = Math.max(1, Math.min(200, parseInt(body?.count, 10) || 0));
        if (!count) return json({ error: 'bad-count' }, 400);
        const invites = [];
        for (let i = 0; i < count; i++) {
          // Collision guard: retry up to 5x if the code already exists.
          let code = generateInviteCode();
          for (let k = 0; k < 5 && await loadInvite(env, code); k++) code = generateInviteCode();
          const password = generateInvitePassword();
          const manifest = {
            code,
            password,
            createdAt: Date.now(),
            status: 'unused',
            phoneDeviceToken: null,
            phoneModel: null,
            phoneScannedAt: null,
            rsvpAcceptedAt: null,
            rsvpExpiresAt: null,
            consumedBy: null,
            consumedAt: null,
            forfeitedAt: null,
          };
          await saveInvite(env, code, manifest);
          await savePasswordIndex(env, password, code);
          invites.push(adminInvite(manifest));
        }
        return json({ ok: true, count: invites.length, invites });
      }

      // GET /admin/invites
      if (method === 'GET' && pathname === '/admin/invites') {
        const list = await env.MEDIA.list({ prefix: 'invite/' });
        const invites = [];
        for (const obj of list.objects) {
          if (!obj.key.endsWith('/_manifest.json')) continue;
          const r = await env.MEDIA.get(obj.key);
          if (!r) continue;
          try { invites.push(adminInvite(JSON.parse(await r.text()))); } catch {}
        }
        invites.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return json({ ok: true, count: invites.length, invites });
      }

      // DELETE /admin/invite/:code — hard delete a single invite
      const invMatch = pathname.match(/^\/admin\/invite\/([A-Z0-9-]{14})$/);
      if (method === 'DELETE' && invMatch) {
        const code = normalizeInviteCode(invMatch[1]);
        if (!code) return json({ error: 'bad-code' }, 400);
        // Clean up password index too so future signups can't find a ghost invite.
        const inv = await loadInvite(env, code);
        if (inv?.password) await deletePasswordIndex(env, inv.password);
        try { await env.MEDIA.delete(`invite/${code}/_manifest.json`); } catch {}
        return json({ ok: true, deleted: code });
      }

      return json({ error: 'admin-route-not-found', method, path: pathname }, 404);
    }

    // ------- PUBLIC INVITE ENDPOINTS (phone-side) -------
    // GET  /invite/:code                    → status + password + phoneModel (no deviceToken)
    // POST /invite/:code/pair-phone         → issues phoneDeviceToken, sets status phone-paired
    // POST /invite/:code/rsvp-accept        → status rsvp-hold, rsvpExpiresAt = now+24h
    // POST /invite/:code/forfeit            → status forfeited (hard end)
    const publicInviteMatch = pathname.match(/^\/invite\/([A-Za-z0-9-]{12,14})(\/.*)?$/);
    if (publicInviteMatch) {
      const code = normalizeInviteCode(publicInviteMatch[1]);
      const rest = publicInviteMatch[2] || '';
      if (!code) return json({ error: 'bad-code' }, 400);
      const inv = await loadInvite(env, code);
      if (!inv) return json({ error: 'invite-not-found' }, 404);

      // If forfeited, only allow GET (to show "This invite is closed").
      // If rsvp-hold expired, treat as forfeited for public purposes.
      if (inviteIsRsvpExpired(inv)) {
        inv.status = 'forfeited';
        inv.forfeitedAt = Date.now();
        await saveInvite(env, code, inv);
      }

      // GET /invite/:code
      if (method === 'GET' && rest === '') {
        return json({ ok: true, invite: publicInvite(inv, { includePassword: true }) });
      }

      // POST /invite/:code/pair-phone   { phoneModel }
      if (method === 'POST' && rest === '/pair-phone') {
        if (inv.status === 'consumed') return json({ error: 'already-consumed' }, 409);
        if (inv.status === 'forfeited') return json({ error: 'forfeited' }, 410);
        const body = await safeJson(request);
        const phoneModel = String(body?.phoneModel || '').trim() || null;
        // If already paired, return the same deviceToken (idempotent scan-again).
        if (!inv.phoneDeviceToken) inv.phoneDeviceToken = newPhoneDeviceToken();
        inv.phoneModel = phoneModel || inv.phoneModel;
        inv.phoneScannedAt = inv.phoneScannedAt || Date.now();
        if (inv.status === 'unused') inv.status = 'phone-paired';
        await saveInvite(env, code, inv);
        return json({
          ok: true,
          invite: publicInvite(inv, { includePassword: true, includeDeviceToken: true }),
        });
      }

      // POST /invite/:code/rsvp-accept   header X-Phone-Token
      if (method === 'POST' && rest === '/rsvp-accept') {
        const token = request.headers.get('X-Phone-Token') || '';
        if (!inv.phoneDeviceToken || token !== inv.phoneDeviceToken) {
          return json({ error: 'phone-token-mismatch' }, 403);
        }
        if (inv.status === 'consumed') return json({ error: 'already-consumed' }, 409);
        if (inv.status === 'forfeited') return json({ error: 'forfeited' }, 410);
        inv.status = 'rsvp-hold';
        inv.rsvpAcceptedAt = Date.now();
        inv.rsvpExpiresAt = Date.now() + INVITE_RSVP_TTL_MS;
        await saveInvite(env, code, inv);
        return json({ ok: true, invite: publicInvite(inv, { includePassword: true }) });
      }

      // POST /invite/:code/forfeit   header X-Phone-Token
      if (method === 'POST' && rest === '/forfeit') {
        const token = request.headers.get('X-Phone-Token') || '';
        if (!inv.phoneDeviceToken || token !== inv.phoneDeviceToken) {
          return json({ error: 'phone-token-mismatch' }, 403);
        }
        if (inv.status === 'consumed') return json({ error: 'already-consumed' }, 409);
        inv.status = 'forfeited';
        inv.forfeitedAt = Date.now();
        await saveInvite(env, code, inv);
        return json({ ok: true, invite: publicInvite(inv) });
      }
    }

    // ------- ACCOUNT ENDPOINTS -------

    // POST /account/create — invite-gated (Job 8 → strip-down)
    // Body: { password, email, stageName }
    //   Password IS the credential — server looks up invite via password index.
    //   stageName populates both stageName + displayName on the account.
    if (method === 'POST' && pathname === '/account/create') {
      const body = await safeJson(request);
      if (!body) return json({ error: 'invalid-body' }, 400);
      const password = String(body.password || '').trim();
      const email = normalizeEmail(body.email);
      const stageName = String(body.stageName || '').trim();
      if (!password) return json({ error: 'password-required' }, 400);
      if (!email || !stageName) return json({ error: 'missing-fields' }, 400);

      const inviteCode = await loadInviteCodeByPassword(env, password);
      if (!inviteCode) return json({ error: 'invite-not-found' }, 404);
      const inv = await loadInvite(env, inviteCode);
      if (!inv) return json({ error: 'invite-not-found' }, 404);
      if (inv.status === 'consumed') return json({ error: 'invite-consumed' }, 409);
      if (inv.status === 'forfeited') return json({ error: 'invite-forfeited' }, 410);
      if (inviteIsRsvpExpired(inv)) return json({ error: 'invite-expired' }, 410);
      if (inv.status !== 'phone-paired' && inv.status !== 'rsvp-hold') {
        return json({ error: 'invite-not-paired', hint: 'scan the QR on your phone first' }, 400);
      }
      // Defense in depth: password index lookup is definitive, but re-verify
      // the invite manifest's stored password too.
      if (!inv.password || password !== inv.password) {
        return json({ error: 'password-mismatch' }, 401);
      }

      const existingId = await loadAccountIdByEmail(env, email);
      if (existingId) return json({ error: 'email-taken' }, 409);

      const accountId = newAccountId();
      const { hash, salt } = await hashPassword(password);
      const manifest = {
        accountId,
        email,
        passwordHash: hash,
        passwordSalt: salt,
        displayName: stageName, // mirrored — one name field on the client
        stageName,
        createdAt: Date.now(),
        // Phone auto-paired at signup — no separate SYNC PHONE flow needed
        // for the invite path. Sync uploads from her phone with this token
        // route to her account.
        pairedPhoneDeviceToken: inv.phoneDeviceToken || null,
        pairedPhoneModel: inv.phoneModel || null,
        invitedByCode: inviteCode,
        verification2257: {
          status: 'not_started',
          submittedAt: null,
          reviewedAt: null,
          legalName: null,
          dob: null,
        },
        magazineSubmissions: [],
      };
      await saveAccount(env, accountId, manifest);
      await saveEmailIndex(env, email, accountId);

      // Consume the invite atomically after account save. Clear the
      // password field + delete the password index for hygiene — the
      // password now lives (hashed) on the account, and no future signup
      // should be able to find this invite.
      const consumedPassword = inv.password;
      inv.status = 'consumed';
      inv.consumedBy = accountId;
      inv.consumedAt = Date.now();
      inv.password = null;
      await saveInvite(env, inviteCode, inv);
      if (consumedPassword) await deletePasswordIndex(env, consumedPassword);

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

    // GET /account/me/messages — list all messages for this artist
    if (method === 'GET' && pathname === '/account/me/messages') {
      const sess = await resolveSession(env, request);
      if (!sess) return json({ error: 'not-authenticated' }, 401);
      const messages = await listMessagesForAccount(env, sess.accountId);
      return json({ ok: true, messages });
    }

    // POST /account/me/messages — artist replies to a thread
    if (method === 'POST' && pathname === '/account/me/messages') {
      const sess = await resolveSession(env, request);
      if (!sess) return json({ error: 'not-authenticated' }, 401);
      const body = await safeJson(request);
      const text = String(body?.body || '').trim();
      const threadId = String(body?.threadId || '').trim();
      if (!text) return json({ error: 'body-required' }, 400);
      if (!threadId) return json({ error: 'thread-required' }, 400);
      const msg = {
        messageId: newMessageId(),
        threadId,
        from: 'artist',
        subject: null,
        body: text,
        sentAt: Date.now(),
        readAt: null,
      };
      await saveMessage(env, sess.accountId, msg);
      // Notify admin — always works (admin@seventy7g.com is Resend account email).
      const html = `<div style="font-family: system-ui, sans-serif; padding: 20px; background: #0a0a0a; color: #e0d0ff;">
        <div style="font-size: 14px; font-weight: 900; letter-spacing: 0.24em; color: #d4af37;">ENCORE XO&trade; — ARTIST REPLIED</div>
        <p><strong>${escapeHtml(sess.manifest.displayName)}</strong> (${escapeHtml(sess.manifest.email)}) replied:</p>
        <div style="background: #161020; border: 1px solid #4a3560; border-radius: 4px; padding: 12px; margin: 10px 0; line-height: 1.6;">${escapeHtml(text)}</div>
        <p><a href="https://editor.encorexo.com/admin" style="color: #d4af37;">Open admin dashboard</a></p>
      </div>`;
      sendEmail(env, {
        to: env.ADMIN_EMAIL || 'admin@seventy7g.com',
        subject: `ENCORE XO — ${sess.manifest.displayName} replied`,
        html,
      }).catch(() => {});
      return json({ ok: true, message: msg });
    }

    // POST /account/me/messages/:id/read — mark a message read
    const msgReadMatch = pathname.match(/^\/account\/me\/messages\/(msg_[a-f0-9]{16})\/read$/);
    if (method === 'POST' && msgReadMatch) {
      const sess = await resolveSession(env, request);
      if (!sess) return json({ error: 'not-authenticated' }, 401);
      const messageId = msgReadMatch[1];
      const msg = await loadMessage(env, sess.accountId, messageId);
      if (!msg) return json({ error: 'not-found' }, 404);
      if (msg.readAt) return json({ ok: true, alreadyRead: true });
      msg.readAt = Date.now();
      await saveMessage(env, sess.accountId, msg);
      return json({ ok: true, message: msg });
    }

    // POST /account/privacy-ack — timestamp + IP consent record
    // Fired once per account, before the 2257 wizard is interactive.
    // Idempotent — repeat calls return the original ackedAt.
    if (method === 'POST' && pathname === '/account/privacy-ack') {
      const sess = await resolveSession(env, request);
      if (!sess) return json({ error: 'not-authenticated' }, 401);
      if (sess.manifest.privacyAckedAt) {
        return json({
          ok: true,
          alreadyAcked: true,
          privacyAckedAt: sess.manifest.privacyAckedAt,
        });
      }
      sess.manifest.privacyAckedAt = Date.now();
      sess.manifest.privacyAckedIp = request.headers.get('CF-Connecting-IP') || null;
      await saveAccount(env, sess.accountId, sess.manifest);

      // Best-effort courtesy email of the policy to the artist. Gated by the
      // artist-emails flag — flip on when Resend paid tier is active.
      if (artistEmailsEnabled(env)) {
        const html = buildPrivacyPolicyEmail(sess.manifest);
        sendEmail(env, {
          to: sess.manifest.email,
          subject: 'Your ENCORE XO privacy policy',
          html,
        }).catch(() => {});
      }

      return json({ ok: true, privacyAckedAt: sess.manifest.privacyAckedAt });
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
        // Job 1: real pending state. Admin reviews via /admin dashboard
        // and either approves or requests resubmission with a reason.
        status: 'pending',
        submittedAt: Date.now(),
        reviewedAt: null,
        legalName,
        dob,
        resubmissionReason: null,
      };
      await saveAccount(env, sess.accountId, m);

      // Job 4: alert the admin so she can be reviewed.
      const adminTo = env.ADMIN_EMAIL || 'admin@seventy7g.com';
      const dispName = escapeHtml(m.displayName);
      const stage = m.stageName ? ` · ${escapeHtml(m.stageName)}` : '';
      const emailForBody = escapeHtml(m.email);
      const legalNameEsc = escapeHtml(legalName);
      const dobEsc = escapeHtml(dob);
      const adminLink = 'https://editor.encorexo.com/admin';
      const html = `
        <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; background: #0a0a0a; color: #e0d0ff;">
          <div style="font-size: 18px; font-weight: 900; letter-spacing: 0.28em; color: #d4af37; margin-bottom: 18px;">ENCORE XO&trade;</div>
          <div style="font-size: 13px; letter-spacing: 0.16em; color: #d4af37; font-weight: 700;">NEW ARTIST PENDING REVIEW</div>
          <p style="line-height: 1.7;">
            <strong>${dispName}${stage}</strong> just submitted her 2257 documentation.
          </p>
          <ul style="line-height: 1.9; padding-left: 20px;">
            <li>Email: ${emailForBody}</li>
            <li>Legal name: ${legalNameEsc}</li>
            <li>DOB: ${dobEsc}</li>
          </ul>
          <p><a href="${adminLink}" style="display: inline-block; background: #d4af37; color: #0a0a0a; padding: 10px 22px; text-decoration: none; border-radius: 3px; font-weight: 700; letter-spacing: 0.18em; margin-top: 8px;">OPEN ADMIN DASHBOARD</a></p>
        </div>`;
      // AWAIT so the fetch is not terminated when the Worker returns.
      // Cloudflare Workers kill orphan promises when the response goes out.
      // Adds ~200-500ms to submit; user is already at a busy spinner.
      const emailResult = await sendEmail(env, {
        to: adminTo,
        subject: `New EXO artist pending review — ${m.displayName}`,
        html,
      });
      if (!emailResult.ok) {
        console.warn('[2257 submit] admin notify failed:', emailResult);
      }

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
    pairedPhoneModel: m.pairedPhoneModel || null,
    invitedByCode: m.invitedByCode || null,
    privacyAckedAt: m.privacyAckedAt || null,
    verification2257: m.verification2257,
    magazineSubmissions: m.magazineSubmissions || [],
  };
}
