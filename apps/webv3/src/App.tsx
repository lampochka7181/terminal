import { useState, useCallback, useEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import Header from './components/Header';
import ChartToolbar from './components/ChartToolbar';
import Chart from './components/Chart';
import LiteChart from './components/LiteChart';
import ChartOverlay from './components/ChartOverlay';
import RightSidebar from './components/RightSidebar';
import LiteSidebar from './components/LiteSidebar';
import BottomPanel from './components/BottomPanel';
import OnboardingOverlay from './components/OnboardingOverlay';
import HowItWorks from './components/HowItWorks';
import { V3Prompt } from './components/V3Modal';
import { useMarkets } from '@/hooks/useMarkets';
import { usePrices } from '@/hooks/usePrices';
import { useLiquidationNotifications } from '@/hooks/useLiquidationNotifications';
import { useSelectedMarket, useMarketStore } from '@/stores/marketStore';
import { usePriceStore } from '@/stores/priceStore';
import { useAuthStore } from '@/stores/authStore';
import './App.css';

function isWalletOnboarded(wallet: string | null): boolean {
  if (!wallet) return false;
  try {
    const list: string[] = JSON.parse(localStorage.getItem('degen-onboarded-wallets') || '[]');
    return list.includes(wallet);
  } catch { return false; }
}

function markWalletOnboarded(wallet: string | null): void {
  if (!wallet) return;
  try {
    const list: string[] = JSON.parse(localStorage.getItem('degen-onboarded-wallets') || '[]');
    if (!list.includes(wallet)) {
      list.push(wallet);
      localStorage.setItem('degen-onboarded-wallets', JSON.stringify(list));
    }
  } catch {
    localStorage.setItem('degen-onboarded-wallets', JSON.stringify([wallet]));
  }
}

export default function App() {
  const walletAddress = useAuthStore((s) => s.walletAddress);
  const [showOnboarding, setShowOnboarding] = useState(() => !isWalletOnboarded(walletAddress));
  const [showHowItWorks, setShowHowItWorks] = useState(false);
  const [viewMode, setViewMode] = useState<'pro' | 'lite'>('lite');
  const [liqPrompt, setLiqPrompt] = useState({ open: false, title: '', message: '', type: 'warning' as const });

  // Re-evaluate onboarding when wallet changes (connect, disconnect, switch)
  useEffect(() => {
    if (walletAddress) {
      // Known wallet → skip onboarding, new wallet → show it
      setShowOnboarding(!isWalletOnboarded(walletAddress));
    } else {
      // No wallet connected → show onboarding
      setShowOnboarding(true);
    }
  }, [walletAddress]);

  useLiquidationNotifications({
    onLiquidation: useCallback((n: any) => {
      setLiqPrompt({
        open: true,
        title: 'Position Liquidated',
        message: `Your ${n.side} position was liquidated. Returned: $${n.returnedToUser?.toFixed(2) ?? '0.00'}`,
        type: 'warning',
      });
    }, []),
  });

  const isPro = viewMode === 'pro';

  // --- Panel resize (pro mode) ---
  const DEFAULT_BOTTOM_H = 280;
  const defaultSidebarW = () => (window.innerWidth <= 1600 ? 405 : 540);

  const [bottomHeight, setBottomHeight] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('degen-panel-bottom') || '') || DEFAULT_BOTTOM_H; }
    catch { return DEFAULT_BOTTOM_H; }
  });
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('degen-panel-sidebar') || '') || defaultSidebarW(); }
    catch { return defaultSidebarW(); }
  });

  const resizingRef = useRef<'bottom' | 'sidebar' | null>(null);
  const startPosRef = useRef(0);
  const startSizeRef = useRef(0);
  const bottomHRef = useRef(bottomHeight);
  bottomHRef.current = bottomHeight;
  const sidebarWRef = useRef(sidebarWidth);
  sidebarWRef.current = sidebarWidth;

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      e.preventDefault();
      if (resizingRef.current === 'bottom') {
        const delta = startPosRef.current - e.clientY;
        setBottomHeight(Math.max(150, Math.min(600, startSizeRef.current + delta)));
      } else {
        const delta = startPosRef.current - e.clientX;
        setSidebarWidth(Math.max(320, Math.min(750, startSizeRef.current + delta)));
      }
    };
    const onUp = () => {
      if (!resizingRef.current) return;
      if (resizingRef.current === 'bottom') {
        localStorage.setItem('degen-panel-bottom', bottomHRef.current.toString());
      } else {
        localStorage.setItem('degen-panel-sidebar', sidebarWRef.current.toString());
      }
      resizingRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  const startBottomResize = useCallback((e: React.MouseEvent) => {
    resizingRef.current = 'bottom';
    startPosRef.current = e.clientY;
    startSizeRef.current = bottomHeight;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, [bottomHeight]);

  const startSidebarResize = useCallback((e: React.MouseEvent) => {
    resizingRef.current = 'sidebar';
    startPosRef.current = e.clientX;
    startSizeRef.current = sidebarWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [sidebarWidth]);

  const resetBottomHeight = useCallback(() => {
    setBottomHeight(DEFAULT_BOTTOM_H);
    localStorage.removeItem('degen-panel-bottom');
  }, []);

  const resetSidebarWidth = useCallback(() => {
    setSidebarWidth(defaultSidebarW());
    localStorage.removeItem('degen-panel-sidebar');
  }, []);

  // Wire up real market + price data
  useMarkets({ asset: 'BTC', status: 'OPEN' });
  usePrices();

  const market = useSelectedMarket();
  const { selectedAsset } = useMarketStore();
  const currentPrice = usePriceStore(s => s.prices[selectedAsset]);

  const strikePrice = market?.strike ?? 0;
  const priceDisplay = currentPrice
    ? currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })
    : '--';

  const isActivating = !market || strikePrice <= 0;
  const changePct = strikePrice > 0 && currentPrice
    ? (((currentPrice - strikePrice) / strikePrice) * 100).toFixed(2)
    : '0.00';
  const isAbove = currentPrice != null && strikePrice > 0 && currentPrice >= strikePrice;

  return (
    <div className="app-root">
      <Header onHowItWorks={() => setShowHowItWorks(true)} />

      <div className="app-body" style={isPro ? { gap: 0 } : undefined}>
        <div className="left-column" style={isPro ? { gap: 0 } : undefined}>
          <div className="chart-row">
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
              {/* Asset info bar — identical layout in both modes */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '9px 21px', background: '#1e1e1e', flexShrink: 0,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 15 }}>
                  <button style={{
                    display: 'flex', alignItems: 'center', gap: 9, padding: '8px 15px', borderRadius: 8,
                    background: '#232323', border: 'none', cursor: 'pointer',
                  }}>
                    <div style={{ width: 33, height: 33, borderRadius: '50%', background: '#f7931a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <span style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>₿</span>
                    </div>
                    <span style={{ fontSize: 21, color: '#eee', fontWeight: 400 }}>BTC/USD</span>
                    <span style={{ fontSize: 15, color: 'rgba(238,238,238,0.66)' }}>Bitcoin</span>
                    <ChevronDown size={16} color="rgba(238,238,238,0.33)" />
                  </button>

                  <span style={{
                    padding: '6px 15px', borderRadius: 8, fontSize: 20, fontWeight: 700,
                    letterSpacing: '0.02em', background: '#001eff', color: '#eee',
                  }}>
                    0DTE
                  </span>

                  <span style={{
                    fontSize: 33, fontWeight: 500, color: '#eee',
                    fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em',
                  }}>
                    ${priceDisplay}
                  </span>

                  {isActivating ? (
                    <span style={{
                      padding: '4px 12px',
                      borderRadius: 8, fontSize: 16, fontWeight: 600,
                      background: '#424242', color: '#f7931a',
                    }}>
                      Activating...
                    </span>
                  ) : (
                    <span style={{
                      padding: '4px 12px',
                      borderRadius: 8, fontSize: 16, fontWeight: 700,
                      background: isAbove ? '#95ff94' : '#f55252',
                      color: isAbove ? '#1e1e1e' : '#fff',
                    }}>
                      {changePct}% {isAbove ? 'ABOVE' : 'BELOW'}
                    </span>
                  )}
                </div>

                {/* Pro/Lite toggle */}
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer' }}
                  onClick={() => setViewMode(isPro ? 'lite' : 'pro')}
                >
                  <span style={{ fontSize: 18, color: '#fff', fontWeight: 700 }}>
                    {isPro ? 'Pro' : 'Lite'}
                  </span>
                  <div style={{
                    width: 60, height: 33, borderRadius: 66,
                    background: isPro ? '#474747' : '#191919',
                    display: 'flex', alignItems: 'center', padding: '0 3px',
                  }}>
                    <div style={{
                      width: 27, height: 27, borderRadius: '50%', background: '#eee',
                      marginLeft: isPro ? 'auto' : 0,
                      transition: 'margin-left 0.2s',
                    }} />
                  </div>
                </div>
              </div>

              <div className="chart-container">
                {isPro ? <Chart mode="pro" /> : <LiteChart />}
                {isPro && <ChartToolbar />}
                <ChartOverlay mode={viewMode} />
              </div>
            </div>
          </div>

          {isPro && (
            <>
              <div className="resize-handle-h" onMouseDown={startBottomResize} onDoubleClick={resetBottomHeight} />
              <BottomPanel height={bottomHeight} />
            </>
          )}
        </div>

        {isPro ? (
          <>
            <div className="resize-handle-v" onMouseDown={startSidebarResize} onDoubleClick={resetSidebarWidth} />
            <RightSidebar width={sidebarWidth} />
          </>
        ) : <LiteSidebar />}
      </div>

      {showOnboarding && (
        <OnboardingOverlay onStart={() => {
          markWalletOnboarded(walletAddress);
          setShowOnboarding(false);
        }} />
      )}

      {showHowItWorks && (
        <HowItWorks onClose={() => setShowHowItWorks(false)} />
      )}

      <V3Prompt
        open={liqPrompt.open}
        onClose={() => setLiqPrompt(p => ({ ...p, open: false }))}
        title={liqPrompt.title}
        message={liqPrompt.message}
        type={liqPrompt.type}
      />
    </div>
  );
}
