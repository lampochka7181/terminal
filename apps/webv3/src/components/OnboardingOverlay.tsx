import { useState } from 'react';
import HowItWorks from './HowItWorks';

const ACCESS_CODE = '0dtetrade';

interface Props {
  onStart: () => void;
}

export default function OnboardingOverlay({ onStart }: Props) {
  const [showHowItWorks, setShowHowItWorks] = useState(false);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState(false);

  const isUnlocked = code.toLowerCase() === ACCESS_CODE;

  const handleStart = () => {
    if (isUnlocked) {
      onStart();
    } else {
      setCodeError(true);
      setTimeout(() => setCodeError(false), 1500);
    }
  };

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
        padding: '45px 63px', flexShrink: 0,
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 15 }}>
          <svg width="51" height="90" viewBox="0 0 24 44" fill="none">
            <path d="M13 2L4 14h7l-2 8 11-12h-7l2-8z" fill="#eee" />
          </svg>
          <span style={{ fontSize: 51, fontWeight: 400, color: '#eee' }}>flip</span>
        </div>

        {/* Nav links */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 63 }}>
          <button onClick={() => setShowHowItWorks(true)} style={{
            fontSize: 36, fontWeight: 500, color: 'rgba(238,238,238,0.33)',
            background: 'none', border: 'none', cursor: 'pointer',
            lineHeight: '48px',
          }}>
            HOW IT WORKS
          </button>
        </div>
      </div>

      {/* Center content */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '0 45px', marginTop: -45,
      }}>
        {/* Heading */}
        <h1 style={{
          fontSize: 87, fontWeight: 500, color: '#eee',
          textAlign: 'center', lineHeight: '112px',
          margin: 0, maxWidth: 788,
        }}>
          Up or Down. Simple, right?
        </h1>

        {/* Subtitle */}
        <p style={{
          fontSize: 26, fontWeight: 500, color: 'rgba(238,238,238,0.44)',
          textAlign: 'center', lineHeight: '33px',
          margin: '36px 0 0', maxWidth: 563,
        }}>
          Predict outcomes within timeframes.
          <br />
          0DTE Binary Options.
        </p>

        {/* Code input */}
        <div style={{
          marginTop: 48, display: 'flex', flexDirection: 'column',
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
            padding: '17px 54px',
            borderRadius: 8,
            background: isUnlocked ? '#001eff' : '#333',
            border: 'none',
            color: isUnlocked ? '#eee' : 'rgba(238,238,238,0.3)',
            fontSize: 26,
            fontWeight: 700,
            cursor: isUnlocked ? 'pointer' : 'not-allowed',
            lineHeight: '33px',
            transition: 'background 0.2s, color 0.2s, opacity 0.2s',
          }}
          onMouseEnter={(e) => { if (isUnlocked) e.currentTarget.style.opacity = '0.9'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
        >
          Start Trading
        </button>
      </div>
    </div>
  );
}
