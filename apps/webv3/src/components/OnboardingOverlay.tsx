import { useState, useCallback } from 'react';
import HowItWorks from './HowItWorks';
import { api } from '@/lib/api';

const ACCESS_CODE = '0dtetrade';

interface Props {
  onStart: () => void;
}

export default function OnboardingOverlay({ onStart }: Props) {
  const [showHowItWorks, setShowHowItWorks] = useState(false);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState(false);

  // Waitlist state
  const [showWaitlist, setShowWaitlist] = useState(false);
  const [waitlistEmail, setWaitlistEmail] = useState('');
  const [waitlistStatus, setWaitlistStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [waitlistError, setWaitlistError] = useState('');

  const isUnlocked = code.toLowerCase() === ACCESS_CODE;

  const handleStart = () => {
    if (isUnlocked) {
      onStart();
    } else {
      setCodeError(true);
      setTimeout(() => setCodeError(false), 1500);
    }
  };

  const handleWaitlistSubmit = useCallback(async () => {
    const email = waitlistEmail.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setWaitlistError('Please enter a valid email address.');
      setWaitlistStatus('error');
      return;
    }
    setWaitlistStatus('submitting');
    try {
      await api.joinWaitlist(email);
      setWaitlistStatus('success');
    } catch {
      setWaitlistError('Something went wrong. Please try again.');
      setWaitlistStatus('error');
    }
  }, [waitlistEmail]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0, 0, 0, 0.55)',
      backdropFilter: 'blur(9px)',
      display: 'flex', flexDirection: 'column',
    }}>
      {showHowItWorks && <HowItWorks onClose={() => setShowHowItWorks(false)} />}
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: 'calc(45px * var(--onboard-scale)) calc(63px * var(--onboard-scale))', flexShrink: 0,
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 15 }}>
          <svg style={{ width: 'calc(51px * var(--onboard-scale))', height: 'calc(90px * var(--onboard-scale))' }} viewBox="0 0 24 44" fill="none">
            <path d="M13 2L4 14h7l-2 8 11-12h-7l2-8z" fill="#eee" />
          </svg>
          <span style={{ fontSize: 'calc(51px * var(--onboard-scale))', fontWeight: 400, color: '#eee' }}>flip</span>
        </div>

        {/* Nav links */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 42 }}>
          <button onClick={() => setShowHowItWorks(true)} style={{
            fontSize: 'calc(36px * var(--onboard-scale))', fontWeight: 500, color: 'rgba(238,238,238,0.33)',
            background: 'none', border: 'none', cursor: 'pointer',
          }}>
            HOW IT WORKS
          </button>
          <button onClick={() => { setShowWaitlist(true); setWaitlistStatus('idle'); setWaitlistError(''); }} style={{
            fontSize: 'calc(36px * var(--onboard-scale))', fontWeight: 500, color: 'rgba(238,238,238,0.33)',
            background: 'none', border: 'none', cursor: 'pointer',
          }}>
            JOIN WAITLIST
          </button>
        </div>
      </div>

      {/* Center content */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '0 45px', marginTop: 'calc(-45px * var(--onboard-scale))',
      }}>
        {/* Heading */}
        <h1 style={{
          fontSize: 'calc(87px * var(--onboard-scale))', fontWeight: 500, color: '#eee',
          textAlign: 'center', lineHeight: 1.3,
          margin: 0, maxWidth: 788,
        }}>
          Up or Down. Simple, right?
        </h1>

        {/* Subtitle */}
        <p style={{
          fontSize: 'calc(26px * var(--onboard-scale))', fontWeight: 500, color: 'rgba(238,238,238,0.44)',
          textAlign: 'center', lineHeight: 1.3,
          margin: 'calc(36px * var(--onboard-scale)) 0 0', maxWidth: 563,
        }}>
          Predict outcomes within timeframes.
          <br />
          0DTE Binary Options.
        </p>

        {/* Code input */}
        <div style={{
          marginTop: 'calc(48px * var(--onboard-scale))', display: 'flex', flexDirection: 'column',
          alignItems: 'center', gap: 16,
        }}>
          <input
            type="text"
            value={code}
            onChange={(e) => { setCode(e.target.value); setCodeError(false); }}
            onKeyDown={(e) => e.key === 'Enter' && handleStart()}
            placeholder="Enter access code"
            style={{
              width: 280, padding: '14px 20px',
              borderRadius: 8, fontSize: 18, fontWeight: 500,
              background: '#1a1a1a',
              border: codeError ? '1px solid #f55252' : '1px solid rgba(255,255,255,0.12)',
              color: '#eee', textAlign: 'center',
              outline: 'none',
              transition: 'border-color 0.2s',
            }}
          />
          {codeError && (
            <span style={{ fontSize: 14, color: '#f55252' }}>Invalid code</span>
          )}
        </div>

        {/* CTA Button */}
        <button
          onClick={handleStart}
          disabled={!isUnlocked}
          style={{
            marginTop: 20,
            padding: 'calc(17px * var(--onboard-scale)) calc(54px * var(--onboard-scale))',
            borderRadius: 8,
            background: isUnlocked ? '#001eff' : '#333',
            border: 'none',
            color: isUnlocked ? '#eee' : 'rgba(238,238,238,0.3)',
            fontSize: 'calc(26px * var(--onboard-scale))',
            fontWeight: 700,
            cursor: isUnlocked ? 'pointer' : 'not-allowed',
            transition: 'background 0.2s, color 0.2s, opacity 0.2s',
          }}
          onMouseEnter={(e) => { if (isUnlocked) e.currentTarget.style.opacity = '0.9'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
        >
          Start Trading
        </button>
      </div>

      {/* Waitlist modal */}
      {showWaitlist && (
        <div
          onClick={() => setShowWaitlist(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 200,
            background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#1e1e1e', borderRadius: 16, padding: '36px 40px',
              width: 400, display: 'flex', flexDirection: 'column', alignItems: 'center',
              border: '1px solid rgba(255,255,255,0.1)',
            }}
          >
            {waitlistStatus === 'success' ? (
              <>
                <span style={{ fontSize: 36, marginBottom: 12 }}>&#10003;</span>
                <h2 style={{ fontSize: 22, fontWeight: 600, color: '#eee', margin: '0 0 8px' }}>You're on the list!</h2>
                <p style={{ fontSize: 15, color: 'rgba(238,238,238,0.5)', textAlign: 'center', margin: '0 0 20px' }}>
                  We'll notify you when access opens up.
                </p>
                <button
                  onClick={() => setShowWaitlist(false)}
                  style={{
                    padding: '10px 32px', borderRadius: 8, border: 'none',
                    background: '#001eff', color: '#eee', fontSize: 16, fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  Done
                </button>
              </>
            ) : (
              <>
                <h2 style={{ fontSize: 22, fontWeight: 600, color: '#eee', margin: '0 0 6px' }}>Join the Waitlist</h2>
                <p style={{ fontSize: 15, color: 'rgba(238,238,238,0.5)', textAlign: 'center', margin: '0 0 24px' }}>
                  Get notified when we open access.
                </p>
                <input
                  type="email"
                  value={waitlistEmail}
                  onChange={(e) => { setWaitlistEmail(e.target.value); if (waitlistStatus === 'error') setWaitlistStatus('idle'); }}
                  onKeyDown={(e) => e.key === 'Enter' && handleWaitlistSubmit()}
                  placeholder="you@email.com"
                  autoFocus
                  style={{
                    width: '100%', padding: '13px 18px',
                    borderRadius: 8, fontSize: 16, fontWeight: 500,
                    background: '#141414',
                    border: waitlistStatus === 'error' ? '1px solid #f55252' : '1px solid rgba(255,255,255,0.12)',
                    color: '#eee', outline: 'none',
                    transition: 'border-color 0.2s',
                  }}
                />
                {waitlistStatus === 'error' && (
                  <span style={{ fontSize: 13, color: '#f55252', marginTop: 8 }}>{waitlistError}</span>
                )}
                <button
                  onClick={handleWaitlistSubmit}
                  disabled={waitlistStatus === 'submitting'}
                  style={{
                    marginTop: 16, width: '100%', padding: '12px 0', borderRadius: 8,
                    border: 'none', background: '#001eff', color: '#eee',
                    fontSize: 16, fontWeight: 600,
                    cursor: waitlistStatus === 'submitting' ? 'not-allowed' : 'pointer',
                    opacity: waitlistStatus === 'submitting' ? 0.6 : 1,
                    transition: 'opacity 0.15s',
                  }}
                >
                  {waitlistStatus === 'submitting' ? 'Submitting...' : 'Join Waitlist'}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
