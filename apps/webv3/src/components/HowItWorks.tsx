import { X } from 'lucide-react';

interface Props {
  onClose: () => void;
}

const dim = 'rgba(238,238,238,0.33)';

function SectionTitle({ children }: { children: string }) {
  return (
    <h2 style={{
      fontSize: 36, fontWeight: 600, color: '#eee', margin: '0 0 16px',
      display: 'flex', alignItems: 'center', gap: 14,
    }}>
      {children}
    </h2>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: '28px 32px', borderRadius: 16,
      background: 'rgba(255,255,255,0.04)',
      border: '1px solid rgba(255,255,255,0.08)',
    }}>
      {children}
    </div>
  );
}

export default function HowItWorks({ onClose }: Props) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0, 0, 0, 0.85)',
      backdropFilter: 'blur(16px)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '32px 56px', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <svg width="44" height="80" viewBox="0 0 24 44" fill="none">
            <path d="M13 2L4 14h7l-2 8 11-12h-7l2-8z" fill="#eee" />
          </svg>
          <span style={{ fontSize: 44, fontWeight: 400, color: '#eee' }}>flip</span>
        </div>
        <button
          onClick={onClose}
          style={{
            width: 64, height: 64, borderRadius: 16,
            background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', color: '#eee',
          }}
        >
          <X size={32} />
        </button>
      </div>

      {/* Scrollable content */}
      <div style={{
        flex: 1, overflowY: 'auto', padding: '0 56px 80px',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
      }}>
        <div style={{ maxWidth: 1100, width: '100%' }}>
          {/* Hero */}
          <div style={{ textAlign: 'center', marginBottom: 64 }}>
            <h1 style={{
              fontSize: 72, fontWeight: 500, color: '#eee', margin: '0 0 20px',
              letterSpacing: '-0.01em',
            }}>
              How It Works
            </h1>
            <p style={{
              fontSize: 30, color: 'rgba(238,238,238,0.5)', margin: 0,
              lineHeight: 1.5, maxWidth: 700, marginLeft: 'auto', marginRight: 'auto',
            }}>
              Predict whether BTC will close above or below a strike price within a 5-minute window. That's it.
            </p>
          </div>

          {/* Step-by-step */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 40, marginBottom: 64 }}>
            <SectionTitle>Getting Started</SectionTitle>

            <div style={{ display: 'flex', gap: 24 }}>
              <Card>
                <div style={{
                  width: 56, height: 56, borderRadius: 14, background: '#001eff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 28, fontWeight: 700, color: '#fff', marginBottom: 16,
                }}>1</div>
                <h3 style={{ fontSize: 28, fontWeight: 600, color: '#eee', margin: '0 0 10px' }}>Connect Wallet</h3>
                <p style={{ fontSize: 22, color: 'rgba(238,238,238,0.55)', margin: 0, lineHeight: 1.6 }}>
                  Click <strong style={{ color: '#eee' }}>Connect Wallet</strong> in the top right. We support Phantom, Solflare, and other Solana wallets. You'll sign a message to verify ownership — no transaction, no cost.
                </p>
              </Card>

              <Card>
                <div style={{
                  width: 56, height: 56, borderRadius: 14, background: '#001eff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 28, fontWeight: 700, color: '#fff', marginBottom: 16,
                }}>2</div>
                <h3 style={{ fontSize: 28, fontWeight: 600, color: '#eee', margin: '0 0 10px' }}>Delegate USDC</h3>
                <p style={{ fontSize: 22, color: 'rgba(238,238,238,0.55)', margin: 0, lineHeight: 1.6 }}>
                  Click the green <strong style={{ color: '#95ff94' }}>⚡ balance</strong> button in the sidebar. Choose an amount to delegate — this lets the platform execute trades with your USDC. Only delegate the amount you plan to trade, there's no need to delegate your full balance. You can revoke your delegation at any time from the same menu.
                </p>
              </Card>

              <Card>
                <div style={{
                  width: 56, height: 56, borderRadius: 14, background: '#001eff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 28, fontWeight: 700, color: '#fff', marginBottom: 16,
                }}>3</div>
                <h3 style={{ fontSize: 28, fontWeight: 600, color: '#eee', margin: '0 0 10px' }}>Place a Trade</h3>
                <p style={{ fontSize: 22, color: 'rgba(238,238,238,0.55)', margin: 0, lineHeight: 1.6 }}>
                  Pick your amount, then click <strong style={{ color: '#95ff94' }}>Above</strong> or <strong style={{ color: '#f55252' }}>Below</strong>. You're predicting whether BTC closes above or below the strike price when the 5-minute round ends.
                </p>
              </Card>
            </div>
          </div>

          {/* Session Keys */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24, marginBottom: 64 }}>
            <SectionTitle>Session Keys</SectionTitle>
            <Card>
              <div style={{ display: 'flex', gap: 40, alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: 24, color: 'rgba(238,238,238,0.66)', margin: '0 0 16px', lineHeight: 1.6 }}>
                    Every trade normally requires a wallet signature popup. <strong style={{ color: '#eee' }}>Session keys</strong> eliminate this friction — you sign once and trade freely for the session duration.
                  </p>
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    {['1 hour', '4 hours', '24 hours'].map(d => (
                      <span key={d} style={{
                        padding: '10px 24px', borderRadius: 10,
                        background: 'rgba(0,30,255,0.15)', color: '#6b8aff',
                        fontSize: 22, fontWeight: 600,
                      }}>{d}</span>
                    ))}
                  </div>
                  <p style={{ fontSize: 20, color: 'rgba(238,238,238,0.4)', margin: '16px 0 0', lineHeight: 1.5 }}>
                    Click the 🔑 key icon in the header to create or manage your session. Sessions can optionally persist across browser reloads.
                  </p>
                </div>
              </div>
            </Card>
          </div>

          {/* Lite vs Pro */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24, marginBottom: 64 }}>
            <SectionTitle>Lite Mode vs Pro Mode</SectionTitle>
            <div style={{ display: 'flex', gap: 24 }}>
              <Card>
                <div style={{
                  display: 'inline-flex', padding: '8px 20px', borderRadius: 10,
                  background: 'rgba(238,238,238,0.08)', marginBottom: 16,
                }}>
                  <span style={{ fontSize: 24, fontWeight: 700, color: '#eee' }}>Lite</span>
                </div>
                <p style={{ fontSize: 22, color: 'rgba(238,238,238,0.55)', margin: '0 0 16px', lineHeight: 1.6 }}>
                  The default view. A clean, streamlined interface designed for fast one-click trading.
                </p>
                <ul style={{ margin: 0, paddingLeft: 28, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {[
                    'Simple sidebar: timeframe → amount → trade',
                    'Live position tracking with real-time PnL',
                    'Built-in chatroom',
                  ].map((item, i) => (
                    <li key={i} style={{ fontSize: 22, color: 'rgba(238,238,238,0.55)', lineHeight: 1.5 }}>{item}</li>
                  ))}
                </ul>
              </Card>

              <Card>
                <div style={{
                  display: 'inline-flex', padding: '8px 20px', borderRadius: 10,
                  background: 'rgba(0,30,255,0.2)', marginBottom: 16,
                }}>
                  <span style={{ fontSize: 24, fontWeight: 700, color: '#6b8aff' }}>Pro</span>
                </div>
                <p style={{ fontSize: 22, color: 'rgba(238,238,238,0.55)', margin: '0 0 16px', lineHeight: 1.6 }}>
                  Full trading terminal with candlestick charts and advanced features for experienced traders.
                </p>
                <ul style={{ margin: 0, paddingLeft: 28, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {[
                    'Candlestick chart with zoom/scroll',
                    'Full orderbook with bid/ask depth',
                    'Market & Limit order types',
                    'Leverage options (coming soon)',
                    'Positions table with detailed PnL',
                  ].map((item, i) => (
                    <li key={i} style={{ fontSize: 22, color: 'rgba(238,238,238,0.55)', lineHeight: 1.5 }}>{item}</li>
                  ))}
                </ul>
              </Card>
            </div>
            <p style={{ fontSize: 22, color: 'rgba(238,238,238,0.4)', margin: 0, lineHeight: 1.5 }}>
              Toggle between modes with the <strong style={{ color: '#eee' }}>Pro / Lite</strong> switch at the top right of the chart area.
            </p>
          </div>

          {/* How Payouts Work */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24, marginBottom: 64 }}>
            <SectionTitle>How Payouts Work</SectionTitle>
            <Card>
              <p style={{ fontSize: 24, color: 'rgba(238,238,238,0.66)', margin: '0 0 20px', lineHeight: 1.6 }}>
                Each round is a <strong style={{ color: '#eee' }}>0TDE binary option</strong> — zero days to expiry. When a round starts, a strike price is set at the current BTC price.
              </p>
              <div style={{ display: 'flex', gap: 20, marginBottom: 20 }}>
                <div style={{
                  flex: 1, padding: '20px 24px', borderRadius: 12,
                  background: 'rgba(149,255,148,0.06)', border: '1px solid rgba(149,255,148,0.15)',
                }}>
                  <div style={{ fontSize: 26, fontWeight: 700, color: '#95ff94', marginBottom: 8 }}>Above wins</div>
                  <p style={{ fontSize: 20, color: 'rgba(238,238,238,0.55)', margin: 0, lineHeight: 1.5 }}>
                    BTC closes above the strike when the timer hits zero. Payout = your amount × the multiplier shown.
                  </p>
                </div>
                <div style={{
                  flex: 1, padding: '20px 24px', borderRadius: 12,
                  background: 'rgba(245,82,82,0.06)', border: '1px solid rgba(245,82,82,0.15)',
                }}>
                  <div style={{ fontSize: 26, fontWeight: 700, color: '#f55252', marginBottom: 8 }}>Below wins</div>
                  <p style={{ fontSize: 20, color: 'rgba(238,238,238,0.55)', margin: 0, lineHeight: 1.5 }}>
                    BTC closes below the strike when the timer hits zero. Payout = your amount × the multiplier shown.
                  </p>
                </div>
              </div>
              <p style={{ fontSize: 20, color: 'rgba(238,238,238,0.4)', margin: 0, lineHeight: 1.5 }}>
                Multipliers are determined by real-time orderbook prices. Higher risk = higher multiplier. If your prediction is wrong, you lose the amount wagered.
              </p>
            </Card>
          </div>

          {/* CTA */}
          <div style={{ textAlign: 'center', paddingBottom: 40 }}>
            <button
              onClick={onClose}
              style={{
                padding: '28px 80px', borderRadius: 14,
                background: '#001eff', border: 'none',
                color: '#eee', fontSize: 32, fontWeight: 700,
                cursor: 'pointer', letterSpacing: '0.01em',
                transition: 'opacity 0.2s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.9')}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
            >
              Start Trading
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
