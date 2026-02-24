import { useState, useEffect, useRef } from 'react';
import { getCurrentRound, formatTime, ROUND_DURATION } from '../mockData';
import { Eye } from 'lucide-react';
import { useSelectedMarket } from '@/stores/marketStore';
import { useBestPrices } from '@/hooks/useOrderbook';

function ToolbarInfoDot({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 32, height: 32, borderRadius: '50%',
          border: '1px solid rgba(238,238,238,0.33)',
          background: 'none', cursor: 'pointer', color: 'rgba(238,238,238,0.33)', padding: 0,
        }}
      >
        <span style={{ fontSize: 20, fontWeight: 500 }}>i</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', bottom: 44, left: '50%', transform: 'translateX(-50%)',
          width: 280, padding: '12px 16px', borderRadius: 10,
          background: '#333', border: '1px solid rgba(255,255,255,0.15)',
          fontSize: 18, lineHeight: '24px', color: '#ddd', zIndex: 50,
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        }}>
          {text}
        </div>
      )}
    </div>
  );
}

interface ChartOverlayProps {
  mode?: 'pro' | 'lite';
}

export default function ChartOverlay({ mode = 'pro' }: ChartOverlayProps) {
  const [countdown, setCountdown] = useState('');
  const [roundLabel, setRoundLabel] = useState('');
  const [progress, setProgress] = useState(0);
  const [greeksVisible, setGreeksVisible] = useState(true);

  const market = useSelectedMarket();
  const yesPrices = useBestPrices('YES');

  const isActivating = !market || (market.strike ?? 0) <= 0;

  const delta = yesPrices.midPrice > 0 ? yesPrices.midPrice.toFixed(2) : '0.50';
  const timeToExpiry = market?.expiry ? Math.max(0, (market.expiry - Date.now()) / 1000) : 300;
  const theta = timeToExpiry > 0 ? (-1 / (timeToExpiry / 60)).toFixed(4) : '0.00';
  const iv = yesPrices.spread > 0 ? (yesPrices.spread * 100 * 4).toFixed(0) : '45';

  useEffect(() => {
    const update = () => {
      if (market?.expiry) {
        const expiryS = Math.floor(market.expiry / 1000);
        const startS = expiryS - 5 * 60;
        const now = Math.floor(Date.now() / 1000);
        const remaining = Math.max(0, expiryS - now);
        const total = expiryS - startS;
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        setCountdown(`${mins}:${secs.toString().padStart(2, '0')}`);
        setRoundLabel(`${formatTime(startS)} - ${formatTime(expiryS)}`);
        setProgress(total > 0 ? 1 - remaining / total : 0);
      } else {
        const { roundStart, roundEnd, now } = getCurrentRound();
        const remaining = Math.max(0, roundEnd - now);
        const total = roundEnd - roundStart;
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        setCountdown(`${mins}:${secs.toString().padStart(2, '0')}`);
        setRoundLabel(`${formatTime(roundStart)} - ${formatTime(roundStart + ROUND_DURATION)}`);
        setProgress(total > 0 ? 1 - remaining / total : 0);
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [market?.expiry]);

  const sep = (
    <div style={{ width: 1, height: 56, background: 'rgba(255,255,255,0.11)', flexShrink: 0 }} />
  );

  return (
    <>
      {mode === 'pro' && (
        <>
          {/* Greeks overlay — top right, inside chart */}
          <div style={{
            position: 'absolute', top: 16, right: 176,
            display: 'flex', alignItems: 'center', gap: 24,
            padding: '12px 28px', borderRadius: 12,
            fontSize: 26, zIndex: 10,
            fontFamily: "'IBM Plex Mono', monospace",
          }}>
            {greeksVisible && (
              <>
                <span style={{ color: 'rgba(238,238,238,0.5)' }}>
                  Δ{' '}
                  <span style={{ color: '#eee', fontWeight: 600 }}>{delta}</span>
                </span>
                <span style={{ color: 'rgba(238,238,238,0.5)' }}>
                  Θ{' '}
                  <span style={{ color: '#ff5c5f', fontWeight: 600 }}>{theta}/m</span>
                </span>
                <span style={{ color: 'rgba(238,238,238,0.5)' }}>
                  IV{' '}
                  <span style={{ color: '#eee', fontWeight: 600 }}>{iv}%</span>
                </span>
              </>
            )}
            <button
              onClick={() => setGreeksVisible(v => !v)}
              style={{
                width: 44, height: 44, borderRadius: '50%', border: '1px solid rgba(238,238,238,0.22)',
                background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', color: greeksVisible ? 'rgba(238,238,238,0.4)' : 'rgba(238,238,238,0.15)',
                marginLeft: greeksVisible ? 4 : 0, padding: 0,
              }}
            >
              <Eye size={22} />
            </button>
          </div>

          {/* TradingView watermark — bottom left, inside chart */}
          <div style={{
            position: 'absolute', bottom: 124, left: 16, zIndex: 10,
            display: 'flex', alignItems: 'center', gap: 8, opacity: 0.25,
          }}>
            <svg width="40" height="28" viewBox="0 0 36 28" fill="none">
              <path d="M14 0H22V28H14V0Z" fill="#888" />
              <path d="M0 0H8V18H0V0Z" fill="#888" />
              <path d="M28 0H36V10H28V0Z" fill="#888" />
            </svg>
          </div>
        </>
      )}

      {/* Round type bar — inside chart, above time axis */}
      <div style={{
        position: 'absolute', bottom: mode === 'pro' ? 68 : 104, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', alignItems: 'center', gap: 0, height: 84,
        borderRadius: 16,
        background: 'transparent',
        zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '0 24px' }}>
          <span style={{ fontSize: 26, color: '#eee', fontWeight: 500, whiteSpace: 'nowrap' }}>
            ROUND TYPE:
          </span>
          <div style={{
            display: 'flex', alignItems: 'center', borderRadius: 10,
            background: 'transparent', padding: 4,
          }}>
            {['1m', '5m', '15m', '1hr'].map((tf) => {
              const isActive = tf === '5m';
              const isDisabled = !isActive;
              return (
                <button key={tf} disabled={isDisabled} style={{
                  padding: '8px 20px', borderRadius: 8, fontSize: 26, fontWeight: 700,
                  border: 'none',
                  cursor: isDisabled ? 'not-allowed' : 'pointer',
                  background: isActive ? '#001eff' : 'transparent',
                  color: '#eee',
                  opacity: isDisabled ? 0.4 : 1,
                }}>{tf}</button>
              );
            })}
          </div>
        </div>

        {sep}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 24px' }}>
          <ToolbarInfoDot text="Each round has a fixed timeframe. When a round ends, positions settle and a new round begins automatically." />
          <span style={{ fontSize: 26, color: '#eee', fontWeight: 500, whiteSpace: 'nowrap' }}>{roundLabel}</span>
        </div>

        {sep}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 24px' }}>
          {isActivating ? (
            <span style={{
              fontSize: 24, fontWeight: 500, color: '#f7931a',
              animation: 'pulse 1.5s ease-in-out infinite',
            }}>Activating...</span>
          ) : (
            <>
              <span style={{ fontSize: 22, color: 'rgba(238,238,238,0.33)', whiteSpace: 'nowrap' }}>Round End in</span>
              <span style={{
                fontSize: 28, fontWeight: 500, color: '#f7931a',
                fontVariantNumeric: 'tabular-nums',
              }}>{countdown}</span>
              <svg width="28" height="28" viewBox="0 0 28 28" style={{ flexShrink: 0 }}>
                <circle cx="14" cy="14" r="11" fill="none" stroke="rgba(238,238,238,0.11)" strokeWidth="3" />
                <circle cx="14" cy="14" r="11" fill="none" stroke="#f7931a" strokeWidth="3"
                  strokeDasharray={`${2 * Math.PI * 11}`}
                  strokeDashoffset={`${2 * Math.PI * 11 * (1 - progress)}`}
                  strokeLinecap="round"
                  transform="rotate(-90 14 14)"
                  style={{ transition: 'stroke-dashoffset 0.5s linear' }}
                />
              </svg>
            </>
          )}
        </div>
      </div>
    </>
  );
}
