import { useEffect, useRef, useState } from 'react';

const MAX_CLIP_SECONDS = 60;

function chooseMimeType() {
  const candidates = [
    'video/mp4;codecs=avc1,mp4a',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return 'video/webm';
}

export default function CameraCapture({ onClipRecorded, onSignOut, pin }) {
  const [permissionError, setPermissionError] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [facingMode, setFacingMode] = useState('user');
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const startTimeRef = useRef(0);
  const timerRef = useRef(null);
  const stopRequestedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      try {
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop());
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: true,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch (err) {
        setPermissionError(err?.message || 'Camera access denied');
      }
    };
    start();
    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        try { recorderRef.current.stop(); } catch {}
      }
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [facingMode]);

  const startRec = () => {
    if (!streamRef.current) return;
    const mimeType = chooseMimeType();
    const recorder = new MediaRecorder(streamRef.current, { mimeType });
    chunksRef.current = [];
    stopRequestedRef.current = false;
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
      const filename = `clip_${Date.now()}.${ext}`;
      onClipRecorded({ blob, filename, mimeType });
    };
    recorder.start(500);
    recorderRef.current = recorder;
    startTimeRef.current = performance.now();
    setElapsedSec(0);
    setIsRecording(true);
    timerRef.current = setInterval(() => {
      const s = (performance.now() - startTimeRef.current) / 1000;
      setElapsedSec(s);
      if (s >= MAX_CLIP_SECONDS && !stopRequestedRef.current) {
        stopRequestedRef.current = true;
        stopRec();
      }
    }, 100);
  };

  const stopRec = () => {
    if (!recorderRef.current || recorderRef.current.state === 'inactive') return;
    try { recorderRef.current.stop(); } catch {}
    setIsRecording(false);
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };

  const toggleRec = () => {
    if (isRecording) stopRec();
    else startRec();
  };

  const flipCamera = () => {
    setFacingMode((m) => (m === 'user' ? 'environment' : 'user'));
  };

  const mins = Math.floor(elapsedSec / 60);
  const secs = Math.floor(elapsedSec % 60);
  const timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#000', overflow: 'hidden' }}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: facingMode === 'user' ? 'scaleX(-1)' : 'none',
        }}
      />

      <div
        style={{
          position: 'absolute',
          top: 'env(safe-area-inset-top, 12px)',
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'space-between',
          padding: '12px 16px',
          pointerEvents: 'none',
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
            pointerEvents: 'auto',
          }}
        >
          CODE {pin}
        </div>
        <button
          type="button"
          onClick={onSignOut}
          style={{
            background: 'rgba(0,0,0,0.55)',
            border: '1px solid #4a3560',
            color: '#c084fc',
            padding: '6px 12px',
            borderRadius: 20,
            fontSize: 10,
            letterSpacing: '0.15em',
            fontWeight: 700,
            pointerEvents: 'auto',
          }}
        >
          × EXIT
        </button>
      </div>

      {isRecording && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(env(safe-area-inset-top, 12px) + 54px)',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(200,20,20,0.85)',
            padding: '6px 14px',
            borderRadius: 20,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.2em',
            color: '#fff',
            fontFamily: 'ui-monospace, Consolas, monospace',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ width: 8, height: 8, background: '#fff', borderRadius: '50%', animation: 'pulse 1s infinite' }} />
          REC · {timeStr}
        </div>
      )}

      <div
        style={{
          position: 'absolute',
          bottom: 'calc(env(safe-area-inset-bottom, 12px) + 24px)',
          left: 0,
          right: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 40,
          padding: '0 20px',
        }}
      >
        <div style={{ width: 44 }} />

        <button
          type="button"
          onClick={toggleRec}
          disabled={!!permissionError}
          style={{
            width: 80,
            height: 80,
            background: isRecording ? '#ff3333' : 'transparent',
            border: '4px solid #fff',
            borderRadius: '50%',
            padding: 4,
            boxShadow: '0 0 0 3px rgba(0,0,0,0.4), 0 6px 18px rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              width: isRecording ? 28 : 62,
              height: isRecording ? 28 : 62,
              background: isRecording ? '#fff' : '#ff3333',
              borderRadius: isRecording ? 6 : '50%',
              transition: 'all 180ms ease-out',
            }}
          />
        </button>

        <button
          type="button"
          onClick={flipCamera}
          disabled={isRecording}
          style={{
            width: 44,
            height: 44,
            background: 'rgba(0,0,0,0.5)',
            border: '1px solid #4a3560',
            borderRadius: '50%',
            color: '#c084fc',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: isRecording ? 0.4 : 1,
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      {permissionError && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.9)',
            padding: 24,
            textAlign: 'center',
          }}
        >
          <div>
            <div style={{ color: '#f88', fontSize: 14, letterSpacing: '0.15em', fontWeight: 700, marginBottom: 12 }}>
              CAMERA ACCESS DENIED
            </div>
            <div style={{ color: '#8a7a9e', fontSize: 12, lineHeight: 1.6 }}>
              Grant camera + microphone permission in your browser settings, then reload.
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
      `}</style>
    </div>
  );
}
