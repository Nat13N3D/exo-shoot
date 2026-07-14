import { useEffect, useRef, useState } from 'react';
import { uploadClip } from '../lib/syncApi.js';

export default function ClipPreview({ clip, pin, onRetake, onSent }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState('preview');
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const urlRef = useRef(null);

  useEffect(() => {
    if (!clip?.blob) return;
    const url = URL.createObjectURL(clip.blob);
    urlRef.current = url;
    if (videoRef.current) {
      videoRef.current.src = url;
      videoRef.current.play().catch(() => {});
    }
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [clip]);

  const send = async () => {
    setStatus('sending');
    setProgress(0);
    setErrorMsg('');
    try {
      await uploadClip(pin, clip.blob, clip.filename, (p) => setProgress(p));
      setStatus('sent');
      setTimeout(() => { onSent(); }, 900);
    } catch (err) {
      setStatus('error');
      setErrorMsg(err?.message || 'Upload failed');
    }
  };

  const sizeMB = clip?.blob ? (clip.blob.size / (1024 * 1024)).toFixed(1) : '0.0';

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#000' }}>
      <video
        ref={videoRef}
        loop
        playsInline
        controls={false}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          background: '#000',
        }}
      />

      <div
        style={{
          position: 'absolute',
          top: 'env(safe-area-inset-top, 12px)',
          left: 0,
          right: 0,
          padding: '12px 16px',
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            background: 'rgba(0,0,0,0.55)',
            border: '1px solid #4a3560',
            padding: '6px 12px',
            borderRadius: 20,
            fontSize: 10,
            letterSpacing: '0.15em',
            color: '#c084fc',
            fontWeight: 700,
            fontFamily: 'ui-monospace, Consolas, monospace',
          }}
        >
          {sizeMB} MB · CODE {pin}
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          bottom: 'calc(env(safe-area-inset-bottom, 12px) + 24px)',
          left: 0,
          right: 0,
          padding: '0 20px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 14,
        }}
      >
        {status === 'preview' && (
          <div style={{ display: 'flex', gap: 12, width: '100%', maxWidth: 380 }}>
            <button
              type="button"
              onClick={onRetake}
              style={{
                flex: 1,
                background: 'rgba(0,0,0,0.55)',
                border: '1px solid #4a3560',
                color: '#c084fc',
                padding: '14px 0',
                fontSize: 13,
                fontWeight: 700,
                letterSpacing: '0.18em',
                borderRadius: 6,
                backdropFilter: 'blur(4px)',
              }}
            >
              RETAKE
            </button>
            <button
              type="button"
              onClick={send}
              style={{
                flex: 2,
                background: '#c084fc',
                border: 'none',
                color: '#0a0a0a',
                padding: '14px 0',
                fontSize: 13,
                fontWeight: 700,
                letterSpacing: '0.18em',
                borderRadius: 6,
                boxShadow: '0 4px 16px rgba(192,132,252,0.5)',
              }}
            >
              SEND TO EDITOR →
            </button>
          </div>
        )}

        {status === 'sending' && (
          <div style={{ width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 11, color: '#c084fc', letterSpacing: '0.2em', fontWeight: 700, textAlign: 'center' }}>
              SENDING TO EDITOR · {Math.round(progress * 100)}%
            </div>
            <div style={{ width: '100%', height: 6, background: '#2b1f3a', borderRadius: 3, overflow: 'hidden' }}>
              <div
                style={{
                  width: `${Math.max(2, Math.round(progress * 100))}%`,
                  height: '100%',
                  background: 'linear-gradient(90deg, #c084fc, #8a5ff0)',
                  transition: 'width 200ms ease-out',
                }}
              />
            </div>
          </div>
        )}

        {status === 'sent' && (
          <div style={{ fontSize: 13, color: '#8fc48f', letterSpacing: '0.2em', fontWeight: 700 }}>
            ✓ SENT — SHOOT ANOTHER
          </div>
        )}

        {status === 'error' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
            <div style={{ color: '#f88', fontSize: 11, letterSpacing: '0.15em', fontWeight: 700, textAlign: 'center' }}>
              {errorMsg.toUpperCase()}
            </div>
            <button
              type="button"
              onClick={send}
              style={{
                background: '#c084fc',
                border: 'none',
                color: '#0a0a0a',
                padding: '10px 22px',
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: '0.18em',
                borderRadius: 6,
              }}
            >
              TRY AGAIN
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
