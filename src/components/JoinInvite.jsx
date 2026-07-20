import { useEffect, useState } from 'react';
import {
  fetchInvite, pairInvitePhone, rsvpAcceptInvite, forfeitInvite,
} from '../lib/syncApi.js';

// ENCORE XO™ invite acceptance wizard — phone-facing.
// URL: shoot.encorexo.com/join/{code}
//
// Steps:
//   1. Fetch invite → if bad/forfeited/consumed, show terminal screen
//   2. Approved-phone checklist (radio) + laptop checklist
//   3. Desk-check YES/NO
//   4a. YES → show INVITE CODE + PASSWORD, tell her to open editor on laptop
//   4b. NO  → RSVP splash: ACCEPT 24 HR HOLD / FORFEIT
//        FORFEIT → server, then logo splash → fade to black → lock screen
//        ACCEPT → server, then live 24hr countdown
//   5. Return with existing RSVP hold → welcome-back → tap → go to step 4a

const GOLD = '#d4af37';
const CYAN = '#39d0ff';
const RED = '#ff5555';
const BG = '#0a0a0a';
const PANEL = '#161020';
const BORDER = '#4a3560';
const INPUT_BG = '#0f0a18';
const TEXT = '#e0d0ff';
const MUTED = '#8a7a9e';

const APPROVED_PHONES = [
  'iPhone 12 Pro',
  'iPhone 12 Pro Max',
  'iPhone 13 Pro',
  'iPhone 13 Pro Max',
  'iPhone 14 Pro',
  'iPhone 14 Pro Max',
  'iPhone 15 Pro',
  'iPhone 15 Pro Max',
  'iPhone 16 Pro',
  'iPhone 16 Pro Max',
];

const PHONE_TOKEN_STORAGE_PREFIX = 'exo_invite_token_';
function loadPhoneToken(code) {
  try { return localStorage.getItem(PHONE_TOKEN_STORAGE_PREFIX + code) || null; } catch { return null; }
}
function savePhoneToken(code, token) {
  try { localStorage.setItem(PHONE_TOKEN_STORAGE_PREFIX + code, token); } catch {}
}
function clearPhoneToken(code) {
  try { localStorage.removeItem(PHONE_TOKEN_STORAGE_PREFIX + code); } catch {}
}

export default function JoinInvite({ code }) {
  const [invite, setInvite] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [step, setStep] = useState('booting');
  // steps: booting | terminal-notfound | terminal-forfeited | terminal-consumed
  //        landing | checklist | desk-check | code-display
  //        rsvp-prompt | rsvp-active | forfeited-splash

  const [phoneModel, setPhoneModel] = useState('');
  const [laptopOk, setLaptopOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await fetchInvite(code);
      if (cancelled) return;
      if (!r.ok) {
        if (r.reason === 'not-found') setStep('terminal-notfound');
        else setLoadErr(r.reason || 'network');
        return;
      }
      const inv = r.data.invite;
      setInvite(inv);
      routeFromInvite(inv);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  function routeFromInvite(inv) {
    if (!inv) { setStep('booting'); return; }
    if (inv.status === 'consumed') { setStep('terminal-consumed'); return; }
    if (inv.status === 'forfeited') { setStep('terminal-forfeited'); return; }
    if (inv.status === 'rsvp-hold') { setStep('rsvp-active'); return; }
    if (inv.status === 'phone-paired') {
      // Returning phone — has token, straight to code display (welcome-back UI).
      setStep('code-display');
      return;
    }
    setStep('landing');
  }

  // Landing → checklist
  const enterChecklist = () => setStep('checklist');

  // Checklist → desk-check (pairs the phone with the server here)
  const submitChecklist = async () => {
    if (!phoneModel) { setErr('Select your phone.'); return; }
    if (!laptopOk) { setErr('Confirm your laptop.'); return; }
    setErr(''); setBusy(true);
    const r = await pairInvitePhone(code, phoneModel);
    setBusy(false);
    if (!r.ok) {
      if (r.status === 409) setStep('terminal-consumed');
      else if (r.status === 410) setStep('terminal-forfeited');
      else setErr(`Pair failed (${r.status}).`);
      return;
    }
    const inv = r.data.invite;
    setInvite(inv);
    if (inv.phoneDeviceToken) savePhoneToken(code, inv.phoneDeviceToken);
    setStep('desk-check');
  };

  // Desk check YES → code display
  const deskYes = () => setStep('code-display');
  // Desk check NO → RSVP prompt
  const deskNo = () => setStep('rsvp-prompt');

  const acceptRsvp = async () => {
    const token = loadPhoneToken(code);
    if (!token) { setErr('Phone session lost — rescan your QR.'); return; }
    setBusy(true); setErr('');
    const r = await rsvpAcceptInvite(code, token);
    setBusy(false);
    if (!r.ok) { setErr(`RSVP failed (${r.status}).`); return; }
    setInvite(r.data.invite);
    setStep('rsvp-active');
  };

  const doForfeit = async () => {
    const token = loadPhoneToken(code);
    if (!token) { setStep('forfeited-splash'); return; }
    setBusy(true); setErr('');
    await forfeitInvite(code, token);
    setBusy(false);
    clearPhoneToken(code);
    setStep('forfeited-splash');
  };

  // ---------- RENDER ----------

  if (step === 'booting') {
    return <FullPanel><Brand /><Muted>LOADING…</Muted></FullPanel>;
  }

  if (loadErr) {
    return <FullPanel><Brand /><Muted style={{ color: RED, marginTop: 20 }}>NETWORK ERROR — RETRY</Muted></FullPanel>;
  }

  if (step === 'terminal-notfound') {
    return <FullPanel>
      <Brand />
      <Muted style={{ color: RED, marginTop: 20 }}>INVITATION NOT FOUND</Muted>
      <Muted style={{ marginTop: 8 }}>Ask ENCORE XO for a new invite.</Muted>
    </FullPanel>;
  }
  if (step === 'terminal-forfeited') {
    return <FullPanel>
      <Brand />
      <Muted style={{ color: RED, marginTop: 20 }}>INVITATION CLOSED</Muted>
      <Muted style={{ marginTop: 8 }}>This invite is no longer active.</Muted>
    </FullPanel>;
  }
  if (step === 'terminal-consumed') {
    return <FullPanel>
      <Brand />
      <Muted style={{ color: GOLD, marginTop: 20 }}>ALREADY USED</Muted>
      <Muted style={{ marginTop: 8 }}>This invite has already been redeemed.</Muted>
    </FullPanel>;
  }

  if (step === 'landing') {
    return <FullPanel>
      <Brand />
      <div style={{ ...heading, marginTop: 18 }}>YOU'VE BEEN INVITED</div>
      <div style={{ ...body, marginTop: 14, textAlign: 'center', maxWidth: 340 }}>
        ENCORE XO extends this invitation because we believe you are the best of the best.
      </div>
      <Primary onClick={enterChecklist}>CONTINUE</Primary>
    </FullPanel>;
  }

  if (step === 'checklist') {
    return <FullPanel>
      <Brand />
      <div style={{ ...heading, marginTop: 18 }}>CONTENT MUST BE UPLOADED FROM AN APPROVED PHONE</div>
      <div style={{ marginTop: 10, width: '100%', maxWidth: 320 }}>
        {APPROVED_PHONES.map((p) => (
          <label key={p} style={radioRow}>
            <input
              type="radio"
              name="phone"
              value={p}
              checked={phoneModel === p}
              onChange={() => setPhoneModel(p)}
              style={{ marginRight: 10 }}
            />
            {p}
          </label>
        ))}
      </div>
      <label style={{ ...radioRow, marginTop: 14, borderTop: `1px solid ${BORDER}`, paddingTop: 14, width: '100%', maxWidth: 320 }}>
        <input
          type="checkbox"
          checked={laptopOk}
          onChange={(e) => setLaptopOk(e.target.checked)}
          style={{ marginRight: 10 }}
        />
        I HAVE A 2020 OR NEWER LAPTOP
      </label>
      {err && <Muted style={{ color: RED, marginTop: 10 }}>{err}</Muted>}
      <Primary onClick={submitChecklist} disabled={busy || !phoneModel || !laptopOk}>
        {busy ? 'CHECKING…' : 'CONTINUE'}
      </Primary>
    </FullPanel>;
  }

  if (step === 'desk-check') {
    return <FullPanel>
      <Brand />
      <div style={{ ...heading, marginTop: 18 }}>ARE YOU AT YOUR DESK NOW?</div>
      <div style={{ ...body, marginTop: 12, textAlign: 'center', maxWidth: 320 }}>
        With your laptop and your {phoneModel || 'phone'}.
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
        <Primary onClick={deskYes}>YES</Primary>
        <Secondary onClick={deskNo}>NO</Secondary>
      </div>
    </FullPanel>;
  }

  if (step === 'code-display') {
    return <FullPanel>
      <Brand />
      <div style={{ ...heading, marginTop: 18 }}>OPEN editor.encorexo.com ON YOUR LAPTOP</div>
      <CodeBox label="INVITE CODE" value={invite.code} />
      <CodeBox label="PASSWORD" value={invite.password} />
      <Muted style={{ marginTop: 14, fontSize: 10, textAlign: 'center', maxWidth: 320 }}>
        Type both on your laptop to complete signup. This screen stays open.
      </Muted>
    </FullPanel>;
  }

  if (step === 'rsvp-prompt') {
    return <FullPanel>
      <Brand />
      <div style={{ ...heading, marginTop: 18, color: GOLD }}>ENCORE XO EXTENDED THIS INVITATION</div>
      <div style={{ ...body, marginTop: 14, textAlign: 'center', maxWidth: 340, lineHeight: 1.7 }}>
        We believe you are the best of the best. Please accept this invitation within 24 hours &amp; your seat will not be forfeited.
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
        <Primary onClick={acceptRsvp} disabled={busy}>{busy ? 'HOLDING…' : 'ACCEPT 24 HR HOLD'}</Primary>
        <Secondary onClick={doForfeit} disabled={busy} style={{ borderColor: RED, color: RED }}>FORFEIT</Secondary>
      </div>
      {err && <Muted style={{ color: RED, marginTop: 10 }}>{err}</Muted>}
    </FullPanel>;
  }

  if (step === 'rsvp-active') {
    return <FullPanel>
      <Brand />
      <div style={{ ...heading, marginTop: 18, color: GOLD }}>WELCOME BACK</div>
      <div style={{ ...body, marginTop: 12, textAlign: 'center', maxWidth: 320 }}>
        Please make sure you are using the phone from the list.
      </div>
      <Countdown expiresAt={invite?.rsvpExpiresAt || 0} />
      <Primary onClick={() => setStep('code-display')}>TAP TO CREATE YOUR ACCOUNT</Primary>
    </FullPanel>;
  }

  if (step === 'forfeited-splash') {
    return <ForfeitSplash />;
  }

  return <FullPanel><Muted>Unknown state.</Muted></FullPanel>;
}

// ---------- FORFEIT SPLASH ----------
function ForfeitSplash() {
  const [fading, setFading] = useState(false);
  const [blackout, setBlackout] = useState(false);
  useEffect(() => {
    const t1 = setTimeout(() => setFading(true), 2000);
    const t2 = setTimeout(() => setBlackout(true), 4000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);
  if (blackout) {
    return <div style={{ position: 'fixed', inset: 0, background: '#000' }} onClick={(e) => e.preventDefault()} />;
  }
  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#000',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      transition: 'opacity 2s ease-out',
      opacity: fading ? 0 : 1,
    }}>
      <style>{`@keyframes exoJoinLogoZoom { 0% { transform: scale(0.5); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }`}</style>
      <img
        src="/encorexo-logo.png"
        alt=""
        draggable={false}
        style={{
          width: 200, maxWidth: '60vw',
          filter: 'drop-shadow(0 0 24px rgba(212,175,55,0.5))',
          animation: 'exoJoinLogoZoom 1.2s ease-out both',
        }}
      />
    </div>
  );
}

// ---------- COUNTDOWN ----------
function Countdown({ expiresAt }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remainingMs = Math.max(0, (expiresAt || 0) - now);
  const hh = Math.floor(remainingMs / 3600000);
  const mm = Math.floor((remainingMs % 3600000) / 60000);
  const ss = Math.floor((remainingMs % 60000) / 1000);
  const fmt = (n) => String(n).padStart(2, '0');
  return (
    <div style={{
      marginTop: 16,
      padding: '10px 18px',
      fontFamily: 'ui-monospace, Consolas, monospace',
      fontSize: 24, letterSpacing: '0.24em', color: GOLD, fontWeight: 700,
      border: `1px solid ${GOLD}`, borderRadius: 4,
      background: 'rgba(212,175,55,0.06)',
    }}>
      {fmt(hh)}:{fmt(mm)}:{fmt(ss)}
    </div>
  );
}

// ---------- SHARED UI ----------
function FullPanel({ children }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: BG, color: TEXT,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      overflowY: 'auto', padding: '24px 20px',
    }}>
      <div style={{
        background: PANEL, border: `1px solid ${BORDER}`, borderRadius: 8,
        padding: '24px 24px 28px', width: '100%', maxWidth: 380,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        boxShadow: '0 20px 60px rgba(0,0,0,0.9), 0 0 0 1px rgba(212,175,55,0.35)',
      }}>
        {children}
      </div>
    </div>
  );
}
function Brand() {
  return (
    <div style={{
      fontSize: 22, fontWeight: 900, letterSpacing: '0.28em',
      background: `linear-gradient(90deg, ${GOLD}, #f5d76e, ${GOLD})`,
      WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
    }}>ENCORE XO™</div>
  );
}
function Muted({ children, style }) {
  return <div style={{ fontSize: 11, color: MUTED, letterSpacing: '0.14em', textAlign: 'center', lineHeight: 1.6, ...style }}>{children}</div>;
}
function Primary({ children, disabled, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        marginTop: 20,
        background: disabled ? '#5a4a68' : GOLD,
        border: 'none', color: '#0a0a0a',
        padding: '12px 26px', fontSize: 12, fontWeight: 700, letterSpacing: '0.22em',
        borderRadius: 3, cursor: disabled ? 'default' : 'pointer',
        boxShadow: disabled ? 'none' : '0 4px 14px rgba(212,175,55,0.4)',
      }}
    >{children}</button>
  );
}
function Secondary({ children, disabled, onClick, style }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        marginTop: 20,
        background: 'transparent', border: `1px solid ${BORDER}`, color: GOLD,
        padding: '11px 22px', fontSize: 11, fontWeight: 700, letterSpacing: '0.2em',
        borderRadius: 3, cursor: disabled ? 'default' : 'pointer',
        ...style,
      }}
    >{children}</button>
  );
}
function CodeBox({ label, value }) {
  return (
    <div style={{
      marginTop: 14, width: '100%',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    }}>
      <div style={{ fontSize: 9, letterSpacing: '0.24em', color: MUTED, fontWeight: 700 }}>{label}</div>
      <div style={{
        fontSize: 20, letterSpacing: '0.16em', color: GOLD, fontWeight: 900,
        fontFamily: 'ui-monospace, Consolas, monospace',
        padding: '10px 14px',
        border: `1px solid ${GOLD}`, borderRadius: 4,
        background: 'rgba(212,175,55,0.08)',
        wordBreak: 'break-all', textAlign: 'center',
      }}>{value}</div>
    </div>
  );
}

const heading = {
  fontSize: 13, fontWeight: 700, letterSpacing: '0.18em', color: TEXT, textAlign: 'center',
};
const body = {
  fontSize: 12, color: MUTED, letterSpacing: '0.08em',
};
const radioRow = {
  display: 'flex', alignItems: 'center',
  padding: '10px 12px', color: TEXT, fontSize: 13, letterSpacing: '0.06em',
  cursor: 'pointer', borderBottom: `1px solid rgba(74,53,96,0.4)`,
  background: INPUT_BG,
};
