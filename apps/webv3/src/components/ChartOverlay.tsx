import { useState, useEffect, useRef, useCallback } from 'react';
import { getCurrentRound, formatTime, timeframeSec } from '@/lib/timeframe';
import { Eye } from 'lucide-react';
import { useSelectedMarket, useMarketStore } from '@/stores/marketStore';
import { useBestPrices } from '@/hooks/useOrderbook';
import { getWebSocket } from '@/lib/websocket';
import { useAuth } from '@/hooks/useAuth';
import { useUserStore } from '@/stores/userStore';
import TradeBubbles from './TradeBubbles';

interface SettlementAnim {
  id: number;
  profit: number;
  payout: number;
  outcome: 'yes' | 'no';
  shares: number;
  phase: 'enter' | 'hold' | 'exit' | 'done';
}

function PnLSettlementOverlay() {
  const [anim, setAnim] = useState<SettlementAnim | null>(null);
  const { isAuthenticated } = useAuth();
  const idCounter = useRef(0);

  const trigger = useCallback((outcome: 'yes' | 'no', winShares: number, payout: number, totalCost: number) => {
    const id = ++idCounter.current;
    const profit = payout - totalCost;
    console.log('[PnL Overlay] Market resolved → outcome:', outcome, 'winShares:', winShares, 'payout:', payout, 'cost:', totalCost, 'profit:', profit);
    setAnim({
      id,
      profit,
      payout,
      outcome,
      shares: winShares,
      phase: 'enter',
    });

    setTimeout(() => setAnim(prev => prev?.id === id ? { ...prev, phase: 'hold' } : prev), 50);
    setTimeout(() => setAnim(prev => prev?.id === id ? { ...prev, phase: 'exit' } : prev), 4500);
    setTimeout(() => setAnim(prev => prev?.id === id ? null : prev), 5500);
  }, []);

  const lastResolvedMarketRef = useRef<string>('');

  useEffect(() => {
    if (!isAuthenticated) return;
    const ws = getWebSocket();
    const unsub = ws.onMessage((msg) => {
      const m = msg as any;

      const isResolved = m.type === 'market_resolved' ||
        (m.channel === 'market' && (m.event === 'resolved' || m.type === 'market_resolved'));
      if (!isResolved || !m.data) return;

      const data = m.data;
      const marketId = data.marketId || m.market || '';

      if (lastResolvedMarketRef.current === marketId) return;

      const rawOutcome = (data.outcome || '').toString().toLowerCase();
      const outcome: 'yes' | 'no' = rawOutcome === 'yes' ? 'yes' : 'no';

      const positions = useUserStore.getState().positions;

      const matching = positions.filter(p =>
        p.marketAddress === marketId || p.market === marketId
      );

      if (matching.length === 0) return;

      lastResolvedMarketRef.current = marketId;

      let totalPayout = 0;
      let totalCost = 0;
      let totalWinShares = 0;

      for (const pos of matching) {
        const cost = pos.totalCost ?? (pos.yesShares * (pos.avgEntryYes ?? pos.avgEntryPrice) + pos.noShares * (pos.avgEntryNo ?? pos.avgEntryPrice));
        totalCost += cost;

        if (outcome === 'yes') {
          totalPayout += pos.yesShares;
          totalWinShares += pos.yesShares;
        } else {
          totalPayout += pos.noShares;
          totalWinShares += pos.noShares;
        }
      }

      if (totalCost <= 0 && totalPayout <= 0) return;

      trigger(outcome, totalWinShares, totalPayout, totalCost);
    });
    return unsub;
  }, [isAuthenticated, trigger]);

  if (!anim || anim.phase === 'done') return null;

  const profit = anim.profit ?? 0;
  const payout = anim.payout ?? 0;
  const shares = anim.shares ?? 0;
  const isWin = profit >= 0;
  const accentColor = isWin ? '#95ff94' : '#f55252';
  const glowColor = isWin ? 'rgba(149,255,148,0.15)' : 'rgba(245,82,82,0.15)';
  const pnlStr = `${isWin ? '+' : ''}$${profit.toFixed(2)}`;
  const label = isWin ? 'WINNER' : 'LOSS';
  const outcomeLabel = anim.outcome === 'yes' ? 'Above' : 'Below';

  const opacity = anim.phase === 'enter' ? 0 : anim.phase === 'exit' ? 0 : 1;
  const scale = anim.phase === 'enter' ? 0.7 : anim.phase === 'exit' ? 1.1 : 1;

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      pointerEvents: 'none',
      background: anim.phase === 'hold' ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0)',
      transition: 'background 0.6s ease',
    }}>
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
        padding: '30px 48px', borderRadius: 18,
        background: `radial-gradient(ellipse at center, ${glowColor} 0%, rgba(30,30,30,0.95) 70%)`,
        border: `1px solid ${isWin ? 'rgba(149,255,148,0.25)' : 'rgba(245,82,82,0.25)'}`,
        boxShadow: `0 0 60px ${glowColor}, 0 0 120px ${glowColor}`,
        opacity,
        transform: `scale(${scale})`,
        transition: 'opacity 0.5s ease, transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)',
      }}>
        <div style={{
          fontSize: 14, fontWeight: 700, letterSpacing: 3,
          color: accentColor, textTransform: 'uppercase',
          padding: '3px 15px', borderRadius: 6,
          background: isWin ? 'rgba(149,255,148,0.1)' : 'rgba(245,82,82,0.1)',
          border: `1px solid ${isWin ? 'rgba(149,255,148,0.2)' : 'rgba(245,82,82,0.2)'}`,
        }}>
          {label}
        </div>

        <div style={{
          fontSize: 48, fontWeight: 800, color: accentColor,
          lineHeight: 1.1, marginTop: 6,
          textShadow: `0 0 30px ${glowColor}`,
        }}>
          {pnlStr}
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 18,
          fontSize: 15, color: 'rgba(238,238,238,0.6)', marginTop: 3,
        }}>
          <span>
            Predicted{' '}
            <span style={{
              color: anim.outcome === 'yes' ? '#95ff94' : '#f55252',
              fontWeight: 600,
            }}>{outcomeLabel}</span>
          </span>
          <span style={{ color: 'rgba(238,238,238,0.2)' }}>|</span>
          <span>Payout <span style={{ color: '#eee', fontWeight: 600 }}>${payout.toFixed(2)}</span></span>
          <span style={{ color: 'rgba(238,238,238,0.2)' }}>|</span>
          <span>{shares.toFixed(1)} shares</span>
        </div>

        <div style={{
          fontSize: 11, color: 'rgba(238,238,238,0.25)', marginTop: 9,
          letterSpacing: 2, textTransform: 'uppercase',
        }}>
          Round Settled
        </div>
      </div>
    </div>
  );
}

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
          width: 24, height: 24, borderRadius: '50%',
          border: '1px solid rgba(238,238,238,0.33)',
          background: 'none', cursor: 'pointer', color: 'rgba(238,238,238,0.33)', padding: 0,
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 500 }}>i</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', bottom: 33, left: '50%', transform: 'translateX(-50%)',
          width: 210, padding: '9px 12px', borderRadius: 8,
          background: '#333', border: '1px solid rgba(255,255,255,0.15)',
          fontSize: 14, lineHeight: '18px', color: '#ddd', zIndex: 50,
          boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
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
  const { setTimeframe: setStoreTimeframe } = useMarketStore();
  const yesPrices = useBestPrices('YES');

  const isActivating = !market || (market.strike ?? 0) <= 0;

  const delta = yesPrices.midPrice > 0 ? yesPrices.midPrice.toFixed(2) : '0.50';
  const timeToExpiry = market?.expiry ? Math.max(0, (market.expiry - Date.now()) / 1000) : 300;
  const theta = timeToExpiry > 0 ? (-1 / (timeToExpiry / 60)).toFixed(4) : '0.00';
  const iv = yesPrices.spread > 0 ? (yesPrices.spread * 100 * 4).toFixed(0) : '45';

  useEffect(() => {
    const roundDuration = timeframeSec(market?.timeframe);
    const update = () => {
      if (market?.expiry) {
        const expiryS = Math.floor(market.expiry / 1000);
        const startS = expiryS - roundDuration;
        const now = Math.floor(Date.now() / 1000);
        const remaining = Math.max(0, expiryS - now);
        const total = expiryS - startS;
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        setCountdown(`${mins}:${secs.toString().padStart(2, '0')}`);
        setRoundLabel(`${formatTime(startS)} - ${formatTime(expiryS)}`);
        setProgress(total > 0 ? 1 - remaining / total : 0);
      } else {
        const { roundStart, roundEnd, now } = getCurrentRound(market?.timeframe);
        const remaining = Math.max(0, roundEnd - now);
        const total = roundEnd - roundStart;
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        setCountdown(`${mins}:${secs.toString().padStart(2, '0')}`);
        setRoundLabel(`${formatTime(roundStart)} - ${formatTime(roundStart + roundDuration)}`);
        setProgress(total > 0 ? 1 - remaining / total : 0);
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [market?.expiry, market?.timeframe]);

  const sep = (
    <div style={{ width: 1, height: 42, background: 'rgba(255,255,255,0.11)', flexShrink: 0 }} />
  );

  return (
    <>
      <TradeBubbles mode={mode} />

      {mode === 'pro' && (
        <>
          {/* Greeks overlay — top right, inside chart */}
          <div style={{
            position: 'absolute', top: 12, right: 132,
            display: 'flex', alignItems: 'center', gap: 18,
            padding: '9px 21px', borderRadius: 9,
            fontSize: 20, zIndex: 10,
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
                width: 33, height: 33, borderRadius: '50%', border: '1px solid rgba(238,238,238,0.22)',
                background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', color: greeksVisible ? 'rgba(238,238,238,0.4)' : 'rgba(238,238,238,0.15)',
                marginLeft: greeksVisible ? 3 : 0, padding: 0,
              }}
            >
              <Eye size={17} />
            </button>
          </div>

          {/* TradingView watermark — bottom left, inside chart */}
          <div style={{
            position: 'absolute', bottom: 93, left: 12, zIndex: 10,
            display: 'flex', alignItems: 'center', gap: 6, opacity: 0.25,
          }}>
            <svg width="30" height="21" viewBox="0 0 36 28" fill="none">
              <path d="M14 0H22V28H14V0Z" fill="#888" />
              <path d="M0 0H8V18H0V0Z" fill="#888" />
              <path d="M28 0H36V10H28V0Z" fill="#888" />
            </svg>
          </div>
        </>
      )}

      {/* Round type bar — inside chart, above time axis */}
      <div style={{
        position: 'absolute', bottom: mode === 'pro' ? 51 : 78, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', alignItems: 'center', gap: 0, height: 63,
        borderRadius: 12,
        background: 'transparent',
        zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px' }}>
          <span style={{ fontSize: 20, color: '#eee', fontWeight: 500, whiteSpace: 'nowrap' }}>
            ROUND TYPE:
          </span>
          <div style={{
            display: 'flex', alignItems: 'center', borderRadius: 8,
            background: 'transparent', padding: 3,
          }}>
            {['1m', '5m', '15m', '1h'].map((tf) => {
              const isActive = tf === (market?.timeframe || '5m');
              const isDisabled = tf === '15m' || tf === '1h';
              return (
                <button key={tf} disabled={isDisabled} onClick={() => { if (!isDisabled) setStoreTimeframe(tf as any); }} style={{
                  padding: '6px 15px', borderRadius: 6, fontSize: 20, fontWeight: 700,
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

        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 18px' }}>
          <ToolbarInfoDot text="Each round has a fixed timeframe. When a round ends, positions settle and a new round begins automatically." />
          <span style={{ fontSize: 20, color: '#eee', fontWeight: 500, whiteSpace: 'nowrap' }}>{roundLabel}</span>
        </div>

        {sep}

        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 18px' }}>
          {isActivating ? (
            <span style={{
              fontSize: 18, fontWeight: 500, color: '#f7931a',
              animation: 'pulse 1.5s ease-in-out infinite',
            }}>Activating...</span>
          ) : (
            <>
              <span style={{ fontSize: 17, color: 'rgba(238,238,238,0.33)', whiteSpace: 'nowrap' }}>Round End in</span>
              <span style={{
                fontSize: 21, fontWeight: 500, color: '#f7931a',
                fontVariantNumeric: 'tabular-nums',
              }}>{countdown}</span>
              <svg width="21" height="21" viewBox="0 0 28 28" style={{ flexShrink: 0 }}>
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
