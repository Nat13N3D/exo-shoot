import { useEffect, useRef, useState } from 'react';
import { uploadClip } from '../lib/syncApi.js';

export default function ClipPreview({ clip, pin, onRetake, onSent }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState('preview');
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const urlRef = useRef(null);

  useEffect(() => {
    if (!clip?.blob) return;
    const url = URL.createObjectURL(clip.blob);
    urlRef.current = url;
    if (videoRef.current) {
      videoRef.current.src = url;
      videoRef.current.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    }
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [clip]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) {
      if (v.ended) v.currentTime = 0;
      v.play().then(() => setIsPlaying(true)).catch(() => {});
    } else {
      v.pause();
      setIsPlaying(false);
    }
  };

  const restart = () => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = 0;
    v.play().then(() => setIsPlaying(true)).catch(() => {});
  };

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
        playsInline
        controls={false}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
        onClick={togglePlay}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          background: '#000',
        }}
      />

      {!isPlaying && status === 'preview' && (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="Play"
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 84,
            height: 84,
            borderRadius: '50%',
            background: 'rgba(192,132,252,0.85)',
            border: '2px solid rgba(255,255,255,0.6)',
            color: '#0a0a0a',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 6px 24px rgba(0,0,0,0.6)',
            padding: 0,
          }}
        >
          <svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="6,4 20,12 6,20" />
          </svg>
        </button>
      )}

      <div
        style={{
          position: 'absolute',
          top: 'env(safe-area-inset-top, 12px)',
          left: 0,
          right: 0,
          padding: '12px 16px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 10,
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

        {status === 'preview' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={togglePlay}
              aria-label={isPlaying ? 'Pause' : 'Play'}
              style={{
                background: 'rgba(0,0,0,0.55)',
                border: '1px solid #4a3560',
                color: '#c084fc',
                width: 36,
                height: 36,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
              }}
            >
              {isPlaying ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="4" width="4" height="16" />
                  <rect x="14" y="4" width="4" height="16" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="6,4 20,12 6,20" />
                </svg>
              )}
            </button>
            <button
              type="button"
              onClick={restart}
              aria-label="Restart"
              style={{
                background: 'rgba(0,0,0,0.55)',
                border: '1px solid #4a3560',
                color: '#c084fc',
                width: 36,
                height: 36,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
            </button>
          </div>
        )}
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
