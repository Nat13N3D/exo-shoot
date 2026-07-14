// ENCORE XO™ sync Worker — 6-digit PIN handshake + R2 clip relay
//
// Bindings required (dashboard → Worker → Settings → Bindings):
//   R2 bucket:  MEDIA  ->  encorexo-media
//
// Endpoints:
//   GET    /health
//   POST   /pin/new                   -> { pin, ttlMs, expiresAt }
//   GET    /pin/:pin/list             -> { pin, files, expiresAt }
//   POST   /pin/:pin/upload?filename= -> { ok, filename, key }
//   GET    /pin/:pin/file/:name       -> binary blob
//   DELETE /pin/:pin                  -> { ok, deleted }

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const PIN_TTL_MS = 24 * 60 * 60 * 1000; // 24h — device-binding for the day
const MAX_FILE_SIZE = 200 * 1024 * 1024;

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
