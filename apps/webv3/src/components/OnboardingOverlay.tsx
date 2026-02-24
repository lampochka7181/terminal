import { useState } from 'react';
import HowItWorks from './HowItWorks';

interface Props {
  onStart: () => void;
}

export default function OnboardingOverlay({ onStart }: Props) {
  const [showHowItWorks, setShowHowItWorks] = useState(false);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0, 0, 0, 0.55)',
      backdropFilter: 'blur(12px)',
      display: 'flex', flexDirection: 'column',
    }}>
      {showHowItWorks && <HowItWorks onClose={() => setShowHowItWorks(false)} />}
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '20px 28px', flexShrink: 0,
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="22" height="40" viewBox="0 0 24 44" fill="none">
            <path d="M13 2L4 14h7l-2 8 11-12h-7l2-8z" fill="#eee" />
          </svg>
          <span style={{ fontSize: 22, fontWeight: 400, color: '#eee' }}>flip</span>
        </div>

        {/* Nav links */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
          {['HOW IT WORKS', 'JOIN WAITLIST', 'ENTER CODE'].map((label) => (
            <button key={label} onClick={label === 'HOW IT WORKS' ? () => setShowHowItWorks(true) : undefined} style={{
              fontSize: 16, fontWeight: 500, color: 'rgba(238,238,238,0.33)',
              background: 'none', border: 'none', cursor: 'pointer',
              lineHeight: '21px',
            }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Center content */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '0 40px', marginTop: -40,
      }}>
        {/* Heading */}
        <h1 style={{
          fontSize: 77, fontWeight: 500, color: '#eee',
          textAlign: 'center', lineHeight: '100px',
          margin: 0, maxWidth: 700,
        }}>
          Up or Down. Simple, right?
        </h1>

        {/* Subtitle */}
        <p style={{
          fontSize: 22, fontWeight: 500, color: 'rgba(238,238,238,0.44)',
          textAlign: 'center', lineHeight: '29px',
          margin: '32px 0 0', maxWidth: 500,
        }}>
          Predict outcomes within timeframes.
          <br />
          0TDE Binary Options.
        </p>

        {/* CTA Button */}
        <button
          onClick={onStart}
          style={{
            marginTop: 60,
            padding: '15px 48px',
            borderRadius: 6,
            background: '#001eff',
            border: 'none',
            color: '#eee',
            fontSize: 22,
            fontWeight: 700,
            cursor: 'pointer',
            lineHeight: '29px',
            transition: 'opacity 0.2s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.9')}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
        >
          Start Trading
        </button>
      </div>
    </div>
  );
}
