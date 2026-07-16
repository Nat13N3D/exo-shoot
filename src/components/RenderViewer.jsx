import { useEffect, useRef, useState } from 'react';
import { fetchRenderMeta, claimRenderDevice, renderVideoUrl } from '../lib/syncApi.js';

// Device-bound render viewer.
// URL: shoot.encorexo.com/v/{token}
// First device to load it claims it via POST /render/:token/claim and
// stores the returned deviceToken in localStorage keyed by render token.
// Subsequent visits from the same device replay the video. Other devices
// hit a 403 and see the "bound to another device" screen.

const DEVICE_STORE = 'exo_render_devices';

function loadDeviceMap() {
  try {
    const raw = localStorage.getItem(DEVICE_STORE);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveDeviceMap(map) {
  try { localStorage.setItem(DEVICE_STORE, JSON.stringify(map)); } catch {}
}

export default function RenderViewer({ token }) {
  const [state, setState] = useState('loading'); // loading | ready | not-found | expired | bound-elsewhere | error
  const [videoSrc, setVideoSrc] = useState('');
  const videoRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const meta = await fetchRenderMeta(token);
      if (cancelled) return;
      if (!meta.ok) {
        if (meta.reason === 'not-found') setState('not-found');
        else if (meta.reason === 'expired') setState('expired');
        else setState('error');
        return;
      }
      if (!meta.data.hasVideo) {
        setState('error');
        return;
      }

      const deviceMap = loadDeviceMap();
      let deviceToken = deviceMap[token];

      if (!deviceToken) {
        // First time this device sees this render. Try to claim.
        if (meta.data.boundDevice) {
          setState('bound-elsewhere');
          return;
        }
        const claim = await claimRenderDevice(token);
        if (cancelled) return;
        if (!claim.ok) {
          if (claim.reason === 'already-claimed') setState('bound-elsewhere');
          else setState('error');
          return;
        }
        deviceToken = claim.data.deviceToken;
        deviceMap[token] = deviceToken;
        saveDeviceMap(deviceMap);
      }

      setVideoSrc(renderVideoUrl(token, deviceToken));
      setState('ready');
    }

    run();
    return () => { cancelled = true; };
  }, [token]);

  if (state === 'loading') {
    return (
      <div style={containerStyle}>
        <div style={brandStyle}>ENCORE XO™</div>
        <div style={{ ...msgStyle, marginTop: 20 }}>LOADING…</div>
      </div>
    );
  }

  if (state === 'not-found') {
    return (
      <div style={containerStyle}>
        <div style={brandStyle}>ENCORE XO™</div>
        <div style={{ ...msgStyle, marginTop: 30, color: '#f88' }}>THIS VIDEO WAS NOT FOUND</div>
        <div style={hintStyle}>The QR code may be old or the video was removed.</div>
      </div>
    );
  }

  if (state === 'expired') {
    return (
      <div style={containerStyle}>
        <div style={brandStyle}>ENCORE XO™</div>
        <div style={{ ...msgStyle, marginTop: 30, color: '#f88' }}>THIS VIDEO HAS EXPIRED</div>
        <div style={hintStyle}>Ask the artist for a fresh QR code.</div>
      </div>
    );
  }

  if (state === 'bound-elsewhere') {
    return (
      <div style={containerStyle}>
        <div style={brandStyle}>ENCORE XO™</div>
        <div style={{ ...msgStyle, marginTop: 30, color: '#d4af37', fontSize: 16 }}>
          🔒 BOUND TO ANOTHER DEVICE
        </div>
        <div style={{ ...hintStyle, maxWidth: 300 }}>
          This video was already claimed by another phone. Only that device can play it.
        </div>
        <div style={{ ...hintStyle, opacity: 0.5, marginTop: 20 }}>
          One buyer, one device. That's how EXO™ works.
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div style={containerStyle}>
        <div style={brandStyle}>ENCORE XO™</div>
        <div style={{ ...msgStyle, marginTop: 30, color: '#f88' }}>SOMETHING WENT WRONG</div>
        <div style={hintStyle}>Try scanning the QR code again.</div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: '#000',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <video
        ref={videoRef}
        src={videoSrc}
        controls
        playsInline
        autoPlay
        style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
      />
      <div
        style={{
          position: 'absolute', top: 12, left: 0, right: 0, textAlign: 'center',
          color: '#d4af37', fontSize: 10, letterSpacing: '0.28em', fontWeight: 800,
          textShadow: '0 1px 6px rgba(0,0,0,0.8)', pointerEvents: 'none',
        }}
      >
        ENCORE XO™
      </div>
    </div>
  );
}

const containerStyle = {
  position: 'fixed', inset: 0, background: 'linear-gradient(180deg, #0a0a0a 0%, #000 100%)',
  color: '#fff', display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center',
  padding: '32px 24px', fontFamily: 'system-ui, -apple-system, sans-serif', textAlign: 'center',
};
const brandStyle = {
  fontSize: 24, fontWeight: 900, letterSpacing: 4,
  background: 'linear-gradient(90deg, #d4af37, #f5d76e, #d4af37)',
  WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
};
const msgStyle = {
  fontSize: 14, fontWeight: 700, letterSpacing: '0.2em',
};
const hintStyle = {
  fontSize: 12, opacity: 0.7, marginTop: 12, lineHeight: 1.6, maxWidth: 320,
};
