import { useState, useCallback } from 'react';
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
import './App.css';

export default function App() {
  const [showOnboarding, setShowOnboarding] = useState(true);
  const [showHowItWorks, setShowHowItWorks] = useState(false);
  const [viewMode, setViewMode] = useState<'pro' | 'lite'>('lite');
  const [liqPrompt, setLiqPrompt] = useState({ open: false, title: '', message: '', type: 'warning' as const });

  useLiquidationNotifications({
    onLiquidation: useCallback((n) => {
      setLiqPrompt({
        open: true,
        title: 'Position Liquidated',
        message: `Your ${n.side} position was liquidated. Returned: $${n.returnedToUser?.toFixed(2) ?? '0.00'}`,
        type: 'warning',
      });
    }, []),
  });

  const isPro = viewMode === 'pro';

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

      <div className="app-body">
        <div className="left-column">
          <div className="chart-row">
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
              {/* Asset info bar — identical layout in both modes */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 28px', background: '#1e1e1e', flexShrink: 0,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                  <button style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '10px 20px', borderRadius: 10,
                    background: '#232323', border: 'none', cursor: 'pointer',
                  }}>
                    <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#f7931a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <span style={{ fontSize: 22, fontWeight: 700, color: '#fff' }}>₿</span>
                    </div>
                    <span style={{ fontSize: 28, color: '#eee', fontWeight: 400 }}>BTC/USD</span>
                    <span style={{ fontSize: 20, color: 'rgba(238,238,238,0.66)' }}>Bitcoin</span>
                    <ChevronDown size={22} color="rgba(238,238,238,0.33)" />
                  </button>

                  <span style={{
                    padding: '8px 20px', borderRadius: 10, fontSize: 26, fontWeight: 700,
                    letterSpacing: '0.02em', background: '#001eff', color: '#eee',
                  }}>
                    0TDE
                  </span>

                  <span style={{
                    fontSize: 44, fontWeight: 500, color: '#eee',
                    fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em',
                  }}>
                    ${priceDisplay}
                  </span>

                  {isActivating ? (
                    <span style={{
                      padding: '6px 16px',
                      borderRadius: 10, fontSize: 22, fontWeight: 600,
                      background: '#424242', color: '#f7931a',
                    }}>
                      Activating...
                    </span>
                  ) : (
                    <span style={{
                      padding: '6px 16px',
                      borderRadius: 10, fontSize: 22, fontWeight: 700,
                      background: isAbove ? '#95ff94' : '#f55252',
                      color: isAbove ? '#1e1e1e' : '#fff',
                    }}>
                      {changePct}% {isAbove ? 'ABOVE' : 'BELOW'}
                    </span>
                  )}
                </div>

                {/* Pro/Lite toggle */}
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}
                  onClick={() => setViewMode(isPro ? 'lite' : 'pro')}
                >
                  <span style={{ fontSize: 24, color: '#fff', fontWeight: 700 }}>
                    {isPro ? 'Pro' : 'Lite'}
                  </span>
                  <div style={{
                    width: 80, height: 44, borderRadius: 88,
                    background: isPro ? '#474747' : '#191919',
                    display: 'flex', alignItems: 'center', padding: '0 4px',
                  }}>
                    <div style={{
                      width: 36, height: 36, borderRadius: '50%', background: '#eee',
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

          {isPro && <BottomPanel />}
        </div>

        {isPro ? <RightSidebar /> : <LiteSidebar />}
      </div>

      {showOnboarding && (
        <OnboardingOverlay onStart={() => setShowOnboarding(false)} />
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
