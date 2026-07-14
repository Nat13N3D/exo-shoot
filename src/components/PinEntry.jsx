import { useState } from 'react';
import { checkPin } from '../lib/syncApi.js';

export default function PinEntry({ onConnect }) {
  const [digits, setDigits] = useState('');
  const [status, setStatus] = useState('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const setDigit = (n) => {
    if (digits.length >= 6) return;
    setDigits((d) => d + String(n));
    setErrorMsg('');
  };

  const del = () => {
    setDigits((d) => d.slice(0, -1));
    setErrorMsg('');
  };

  const connect = async () => {
    if (digits.length !== 6) return;
    setStatus('checking');
    setErrorMsg('');
    const result = await checkPin(digits);
    if (!result.ok) {
      setStatus('error');
      if (result.reason === 'not-found') setErrorMsg('CODE NOT FOUND — CHECK YOUR EDITOR');
      else if (result.reason === 'expired') setErrorMsg('CODE EXPIRED — GENERATE A NEW ONE');
      else setErrorMsg('NETWORK ERROR — CHECK CONNECTION');
      setTimeout(() => setStatus('idle'), 200);
      return;
    }
    onConnect(digits, result.data?.expiresAt);
  };

  const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9, 'del', 0, 'go'];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: '100%',
        padding: '32px 24px 40px',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, marginTop: 20 }}>
        <img
          src="/encorexo-logo.png"
          alt=""
          style={{ maxWidth: 200, filter: 'drop-shadow(0 0 12px rgba(255,255,255,0.15))' }}
          draggable={false}
        />
        <div style={{ fontSize: 10, letterSpacing: '0.3em', color: '#8a7a9e', fontWeight: 700 }}>
          SHOOT
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}>
        <div style={{ fontSize: 11, color: '#8a7a9e', letterSpacing: '0.18em', fontWeight: 700, textAlign: 'center' }}>
          ENTER CODE FROM YOUR EDITOR
        </div>
        <div
          style={{
            fontSize: 44,
            fontFamily: 'ui-monospace, Consolas, monospace',
            fontWeight: 700,
            letterSpacing: '0.15em',
            color: '#c084fc',
            background: '#0f0a18',
            border: `2px solid ${errorMsg ? '#f88' : '#4a3560'}`,
            padding: '14px 22px',
            borderRadius: 8,
            minWidth: 260,
            textAlign: 'center',
            textShadow: '0 0 20px rgba(192,132,252,0.5)',
          }}
        >
          {digits.padEnd(6, '·').split('').map((c, i) => (
            <span key={i} style={{ opacity: c === '·' ? 0.25 : 1 }}>{c}</span>
          ))}
        </div>
        {errorMsg && (
          <div style={{ color: '#f88', fontSize: 10, letterSpacing: '0.15em', fontWeight: 700 }}>
            {errorMsg}
          </div>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 12,
          width: '100%',
          maxWidth: 320,
        }}
      >
        {keys.map((k) => {
          if (k === 'del') {
            return (
              <button
                key="del"
                type="button"
                onClick={del}
                style={{
                  background: 'transparent',
                  border: '1px solid #4a3560',
                  color: '#c084fc',
                  padding: '18px 0',
                  fontSize: 16,
                  fontWeight: 700,
                  letterSpacing: '0.15em',
                  borderRadius: 6,
                }}
              >
                DEL
              </button>
            );
          }
          if (k === 'go') {
            const ready = digits.length === 6;
            return (
              <button
                key="go"
                type="button"
                onClick={connect}
                disabled={!ready || status === 'checking'}
                style={{
                  background: ready && status !== 'checking' ? '#c084fc' : '#2b1f3a',
                  color: ready && status !== 'checking' ? '#0a0a0a' : '#5a4a68',
                  border: 'none',
                  padding: '18px 0',
                  fontSize: 16,
                  fontWeight: 700,
                  letterSpacing: '0.18em',
                  borderRadius: 6,
                  boxShadow: ready ? '0 4px 14px rgba(192,132,252,0.5)' : 'none',
                }}
              >
                {status === 'checking' ? '…' : 'GO →'}
              </button>
            );
          }
          return (
            <button
              key={k}
              type="button"
              onClick={() => setDigit(k)}
              style={{
                background: '#161020',
                border: '1px solid #2b1f3a',
                color: '#e0d0ff',
                padding: '18px 0',
                fontSize: 24,
                fontWeight: 700,
                fontFamily: 'ui-monospace, Consolas, monospace',
                borderRadius: 6,
              }}
            >
              {k}
            </button>
          );
        })}
      </div>
    </div>
  );
}
