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
  'Access-Control-Allow-Headers': 'Content-Type, Range',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
  'Access-Control-Max-Age': '86400',
};

const PIN_TTL_MS = 24 * 60 * 60 * 1000; // 24h — device-binding for the day
const RENDER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days for buyer-scan viewer tokens
const MAX_FILE_SIZE = 200 * 1024 * 1024;

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
        return json({
          token,
          hasVideo: manifest.hasVideo,
          sizeBytes: manifest.sizeBytes,
          contentType: manifest.contentType,
          boundDevice: manifest.boundDevice ? 'claimed' : null,
          expiresAt: manifest.createdAt + RENDER_TTL_MS,
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
      if (method === 'GET' && rest === '/video') {
        if (!manifest.hasVideo) return json({ error: 'not-uploaded-yet' }, 404);
        const device = url.searchParams.get('device') || '';
        if (!manifest.boundDevice) return json({ error: 'not-claimed' }, 403);
        if (device !== manifest.boundDevice) return json({ error: 'device-mismatch' }, 403);
        const ext = manifest.fileExt || (manifest.contentType?.startsWith('video/mp4') ? 'mp4' : 'webm');
        const key = `renders/${token}/video.${ext}`;
        const contentType = manifest.contentType || (ext === 'mp4' ? 'video/mp4' : 'video/webm');

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
            headers.set('Cache-Control', 'private, no-cache');
            headers.set('Accept-Ranges', 'bytes');
            headers.set('Content-Range', `bytes ${start}-${actualEnd}/${total}`);
            headers.set('Content-Length', String(actualEnd - start + 1));
            return new Response(obj.body, { status: 206, headers });
          }
        }

        const obj = await env.MEDIA.get(key);
        if (!obj) return json({ error: 'file-missing' }, 404);
        const headers = new Headers(CORS_HEADERS);
        headers.set('Content-Type', contentType);
        headers.set('Cache-Control', 'private, no-cache');
        headers.set('Accept-Ranges', 'bytes');
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

      // DELETE /pin/:pin
      if (method === 'DELETE' && (rest === '' || rest === '/')) {
        const list = await env.MEDIA.list({ prefix: `${pin}/` });
        await Promise.all(list.objects.map((o) => env.MEDIA.delete(o.key)));
        return json({ ok: true, deleted: list.objects.length });
      }
    }

    return json({ error: 'route-not-found', method, path: pathname }, 404);
  },
};
