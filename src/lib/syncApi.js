const API_BASE = 'https://summer-queen-bb7c.natx3.workers.dev';

export async function fetchRenderMeta(token) {
  const res = await fetch(`${API_BASE}/render/${token}/meta`);
  if (res.status === 404) return { ok: false, reason: 'not-found' };
  if (res.status === 410) return { ok: false, reason: 'expired' };
  if (!res.ok) return { ok: false, reason: 'network' };
  return { ok: true, data: await res.json() };
}

export async function claimRenderDevice(token) {
  const res = await fetch(`${API_BASE}/render/${token}/claim`, { method: 'POST' });
  if (res.status === 403) return { ok: false, reason: 'already-claimed' };
  if (!res.ok) return { ok: false, reason: 'network' };
  return { ok: true, data: await res.json() };
}

export function renderVideoUrl(token, deviceToken) {
  return `${API_BASE}/render/${token}/video?device=${encodeURIComponent(deviceToken)}`;
}

export async function checkPin(pin) {
  const res = await fetch(`${API_BASE}/pin/${pin}/list`);
  if (res.status === 404) return { ok: false, reason: 'not-found' };
  if (res.status === 410) return { ok: false, reason: 'expired' };
  if (!res.ok) return { ok: false, reason: 'network' };
  const data = await res.json();
  return { ok: true, data };
}

// ---------------- INVITE (phone-side) ----------------

export async function fetchInvite(code) {
  const res = await fetch(`${API_BASE}/invite/${encodeURIComponent(code)}`);
  if (res.status === 404) return { ok: false, reason: 'not-found' };
  if (res.status === 410) return { ok: false, reason: 'expired' };
  if (!res.ok) return { ok: false, reason: 'network' };
  return { ok: true, data: await res.json() };
}

export async function pairInvitePhone(code, phoneModel) {
  const res = await fetch(`${API_BASE}/invite/${encodeURIComponent(code)}/pair-phone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneModel }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function rsvpAcceptInvite(code, phoneDeviceToken) {
  const res = await fetch(`${API_BASE}/invite/${encodeURIComponent(code)}/rsvp-accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Phone-Token': phoneDeviceToken },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function forfeitInvite(code, phoneDeviceToken) {
  const res = await fetch(`${API_BASE}/invite/${encodeURIComponent(code)}/forfeit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Phone-Token': phoneDeviceToken },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function uploadClip(pin, blob, filename, onProgress) {
  const url = `${API_BASE}/pin/${pin}/upload?filename=${encodeURIComponent(filename)}`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', blob.type || 'video/webm');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(e.loaded / e.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          resolve({ ok: true });
        }
      } else {
        reject(new Error(`upload failed: ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('upload network error'));
    xhr.send(blob);
  });
}
