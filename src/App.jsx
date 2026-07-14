import { useEffect, useState } from 'react';
import PinEntry from './components/PinEntry.jsx';
import CameraCapture from './components/CameraCapture.jsx';
import ClipPreview from './components/ClipPreview.jsx';
import { checkPin } from './lib/syncApi.js';

const STORAGE_KEY = 'exo_shoot_pin';

function loadStoredPin() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.pin || !parsed.expiresAt) return null;
    if (Date.now() > parsed.expiresAt) return null;
    return parsed;
  } catch { return null; }
}

function storePin(pin, expiresAt) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ pin, expiresAt })); }
  catch {}
}

function clearStoredPin() {
  try { localStorage.removeItem(STORAGE_KEY); }
  catch {}
}

export default function App() {
  const [pin, setPin] = useState(null);
  const [pendingClip, setPendingClip] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const stored = loadStoredPin();
    if (!stored) { setChecking(false); return; }
    checkPin(stored.pin).then((res) => {
      if (res.ok) setPin(stored.pin);
      else clearStoredPin();
      setChecking(false);
    });
  }, []);

  const handleConnect = (newPin, expiresAt) => {
    if (expiresAt) storePin(newPin, expiresAt);
    setPin(newPin);
  };

  const handleSignOut = () => {
    clearStoredPin();
    setPin(null);
  };

  const handleUploadFatal = () => {
    clearStoredPin();
    setPendingClip(null);
    setPin(null);
  };

  if (checking) {
    return (
      <div style={{
        position: 'fixed', inset: 0, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: '#0a0a0a', color: '#c084fc',
        fontSize: 11, letterSpacing: '0.2em', fontWeight: 700,
      }}>
        RECONNECTING…
      </div>
    );
  }

  if (!pin) return <PinEntry onConnect={handleConnect} />;

  if (pendingClip) {
    return (
      <ClipPreview
        clip={pendingClip}
        pin={pin}
        onRetake={() => setPendingClip(null)}
        onSent={() => setPendingClip(null)}
        onSessionLost={handleUploadFatal}
      />
    );
  }

  return (
    <CameraCapture
      pin={pin}
      onClipRecorded={(clip) => setPendingClip(clip)}
      onSignOut={handleSignOut}
    />
  );
}
