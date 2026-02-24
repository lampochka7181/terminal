import { useState, useCallback, useEffect, useRef } from 'react';
import { Zap, ChevronDown, ChevronUp } from 'lucide-react';
import ChatPanel from './ChatPanel';
import DelegationModal from './DelegationModal';
import { V3Prompt } from './V3Modal';
import { useAuth } from '@/hooks/useAuth';
import { useUser } from '@/hooks/useUser';
import { useOrder } from '@/hooks/useOrder';
import { useSessionKey } from '@/hooks/useSessionKey';
import { useDelegation } from '@/hooks/useDelegation';
import { useSelectedMarket, useMarketStore } from '@/stores/marketStore';
import { useOrderbook, useBestPrices } from '@/hooks/useOrderbook';

const bdr = '1px solid rgba(255,255,255,0.11)';
const dim = 'rgba(238,238,238,0.33)';

function InfoDot({ text }: { text?: string }) {
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
      <div
        onClick={() => text && setOpen(o => !o)}
        style={{
          width: 24, height: 24, borderRadius: '50%', border: `1px solid ${dim}`,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          cursor: text ? 'pointer' : 'default',
        }}
      >
        <span style={{ fontSize: 14, color: dim, fontWeight: 500 }}>i</span>
      </div>
      {open && text && (
        <div style={{
          position: 'absolute', top: 32, left: '50%', transform: 'translateX(-50%)',
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

export default function LiteSidebar() {
  const { isAuthenticated, wallet } = useAuth();
  const { balance, positions } = useUser();
  const sessionKey = useSessionKey();
  const { placeOrder, isPlacing } = useOrder(sessionKey.sessionSigner);
  const delegation = useDelegation();
  const market = useSelectedMarket();
  useOrderbook(market?.address ?? null);
  const yesPrices = useBestPrices('YES');
  const noPrices = useBestPrices('NO');

  const [amount, setAmount] = useState(25);
  const [timeframe, setTimeframe] = useState('5m');
  const [chatOpen, setChatOpen] = useState(false);
  const [delegationModalOpen, setDelegationModalOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptMsg, setPromptMsg] = useState({ title: '', message: '', type: 'info' as 'info' | 'error' | 'success' | 'warning' });
  const amountPresets = [25, 50, 100, 250];

  const showPrompt = useCallback((title: string, message: string, type: 'info' | 'error' | 'success' | 'warning' = 'info') => {
    setPromptMsg({ title, message, type });
    setPromptOpen(true);
  }, []);

  const handlePlaceOrder = useCallback(async (outcome: 'yes' | 'no') => {
    if (!wallet.connected) { showPrompt('Connect Wallet', 'Please connect your wallet.', 'warning'); return; }
    if (!isAuthenticated) { showPrompt('Sign In', 'Please sign in first.', 'warning'); return; }
    if (!delegation.isApproved) { showPrompt('Delegation Required', 'Please delegate USDC.', 'warning'); setDelegationModalOpen(true); return; }
    if (!market) { showPrompt('No Market', 'No active market.', 'error'); return; }

    const prices = outcome === 'yes' ? yesPrices : noPrices;
    const result = await placeOrder({
      marketAddress: market.address,
      side: 'bid',
      outcome,
      orderType: 'market',
      price: prices.bestAsk || 0.50,
      size: amount / (prices.bestAsk || 0.50),
      dollarAmount: amount,
      maxPrice: 0.99,
    });

    if (result && result.status !== 'error') {
      // Refresh delegation amount so the displayed balance updates immediately
      setTimeout(() => delegation.checkApproval(), 500);
    } else if (result?.error) {
      showPrompt('Order Failed', result.error, 'error');
    }
  }, [wallet.connected, isAuthenticated, delegation.isApproved, market, amount, yesPrices, noPrices, placeOrder, showPrompt, delegation]);

  const balanceDisplay = balance ? `$${balance.available.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '$0';
  const delegatedDisplay = delegation.delegatedAmount > 0 ? `$${(delegation.delegatedAmount / 1_000_000).toLocaleString()}` : '$0';

  const strikePrice = market?.strike ?? 0;
  const expiryMs = market?.expiry ?? 0;
  const isActivating = !market || strikePrice <= 0;
  const timeLeft = Math.max(0, Math.floor((expiryMs - Date.now()) / 1000));
  const timeDisplay = isActivating ? '—:——' : `${Math.floor(timeLeft / 60)}:${String(timeLeft % 60).padStart(2, '0')}`;

  const yesMultiplier = yesPrices.bestAsk > 0 ? (1 / yesPrices.bestAsk).toFixed(2) : '--';
  const noMultiplier = noPrices.bestAsk > 0 ? (1 / noPrices.bestAsk).toFixed(2) : '--';
  const yesPayout = yesPrices.bestAsk > 0 ? `+$${Math.round(amount * (1 / yesPrices.bestAsk - 1))}` : '--';
  const noPayout = noPrices.bestAsk > 0 ? `+$${Math.round(amount * (1 / noPrices.bestAsk - 1))}` : '--';

  const { selectedAsset } = useMarketStore();

  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const openPositions = positions.filter(p => {
    if (p.status !== 'open') return false;
    if ((p.yesShares + p.noShares) <= 0) return false;
    if (p.expiryAt > 0) {
      const expiryMs = p.expiryAt < 1e12 ? p.expiryAt * 1000 : p.expiryAt;
      if (Date.now() > expiryMs) return false;
    }
    return true;
  });
  const firstPosition = openPositions[0];

  const liteBestAsk = firstPosition
    ? (firstPosition.yesShares > 0 ? yesPrices.bestAsk : noPrices.bestAsk)
    : 0;
  const liteHasLiquidity = liteBestAsk > 0 && liteBestAsk < 1;
  const liveMark = firstPosition
    ? (liteHasLiquidity ? liteBestAsk : 0)
    : 0;
  const liveShares = firstPosition
    ? (firstPosition.yesShares > 0 ? firstPosition.yesShares : firstPosition.noShares)
    : 0;
  const liteCostBasis = firstPosition
    ? (firstPosition.totalCost ?? (liveShares * firstPosition.avgEntryPrice))
    : 0;
  const livePnL = firstPosition
    ? (liteHasLiquidity ? (liveMark - firstPosition.avgEntryPrice) * liveShares : -liteCostBasis)
    : 0;

  return (
    <>
      <div style={{
        width: 720, minWidth: 720, background: '#1e1e1e', borderRadius: 22,
        display: 'flex', flexDirection: 'column', overflow: 'hidden', height: '100%',
      }}>
        {/* Balance */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 28px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20, color: dim, fontWeight: 500 }}>BAL</span>
            <span style={{ fontSize: 26, fontWeight: 500, color: '#eee' }}>{balanceDisplay}</span>
          </div>
          <button
            onClick={() => setDelegationModalOpen(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '4px 14px',
              borderRadius: 8, background: 'rgba(81,176,72,0.12)', border: 'none',
              color: '#95ff94', fontSize: 22, fontWeight: 500, cursor: 'pointer',
            }}>
            <Zap size={18} />
            <span>{delegatedDisplay}</span>
            <ChevronDown size={16} />
          </button>
        </div>

        <div style={{ height: 1, background: 'rgba(255,255,255,0.11)', flexShrink: 0 }} />

        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
            <div style={{ padding: '14px 36px 4px' }}>
              <h2 style={{ fontSize: 48, fontWeight: 500, color: '#fff', margin: 0, lineHeight: '54px' }}>Up or Down?</h2>
              <p style={{ fontSize: 20, color: 'rgba(238,238,238,0.44)', lineHeight: '26px', margin: '4px 0 0' }}>
                Predict outcomes within timeframes.<br />0TDE Binary Options.
              </p>
            </div>

            <div style={{ padding: '8px 36px 8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 22, color: '#eee', fontWeight: 500 }}>1. SELECT ROUND TIMEFRAME</span>
                <InfoDot text="Choose how long your prediction window lasts. Currently only 5-minute rounds are active." />
              </div>
              <div style={{ display: 'flex', borderRadius: 12, background: 'rgba(238,238,238,0.05)', padding: 6, overflow: 'hidden' }}>
                {['1m', '5m', '15m', '1h'].map((tf) => {
                  const isActive = tf === '5m';
                  const isDisabled = !isActive;
                  return (
                    <button key={tf} disabled={isDisabled} onClick={() => !isDisabled && setTimeframe(tf)} style={{
                      flex: 1, padding: '12px 0', borderRadius: 12, border: 'none',
                      fontSize: 26, fontWeight: 600,
                      cursor: isDisabled ? 'not-allowed' : 'pointer',
                      background: isActive ? '#001eff' : 'transparent',
                      color: isActive ? '#fff' : dim,
                      opacity: isDisabled ? 0.4 : 1,
                    }}>{tf}</button>
                  );
                })}
              </div>
            </div>

            <div style={{ padding: '6px 36px 8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 22, color: '#eee', fontWeight: 500 }}>2. SELECT AMOUNT</span>
                <InfoDot text="Set how much USDC to wager on this round. Minimum $5." />
              </div>
              <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                {amountPresets.map((p) => (
                  <button key={p} onClick={() => setAmount(p)} style={{
                    flex: 1, padding: '10px 0', borderRadius: 12, fontSize: 26, fontWeight: 600, cursor: 'pointer',
                    border: 'none', background: amount === p ? '#424242' : '#232323', color: amount === p ? '#eee' : dim,
                  }}>${p}</button>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button onClick={() => setAmount(Math.max(5, amount - 5))} style={{
                  width: 60, height: 60, borderRadius: 12, border: bdr, background: '#232323', color: dim,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 34, fontWeight: 600,
                }}>-</button>
                <div style={{
                  flex: 1, height: 60, borderRadius: 12, border: bdr, background: '#232323',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
                }}>
                  <span style={{ fontSize: 28, fontWeight: 600, color: '#eee', position: 'absolute', left: 16, pointerEvents: 'none' }}>$</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={amount}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^0-9]/g, '');
                      setAmount(v === '' ? 0 : parseInt(v, 10));
                    }}
                    onBlur={() => { if (amount < 1) setAmount(5); }}
                    style={{
                      width: '100%', height: '100%', border: 'none', background: 'transparent',
                      textAlign: 'center', fontSize: 28, fontWeight: 600, color: '#eee',
                      outline: 'none', fontFamily: 'inherit', padding: '0 24px',
                    }}
                  />
                </div>
                <button onClick={() => setAmount(amount + 5)} style={{
                  width: 60, height: 60, borderRadius: 12, border: bdr, background: '#232323', color: dim,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 34, fontWeight: 600,
                }}>+</button>
              </div>
            </div>

            <div style={{ padding: '6px 36px 8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 22, color: '#eee', fontWeight: 500 }}>3. PLACE ORDER</span>
                <InfoDot text="Predict whether BTC will close above or below the strike price before the round ends." />
              </div>
              {isActivating ? (
                <p style={{
                  fontSize: 20, color: '#f7931a', lineHeight: '26px',
                  margin: '0 0 8px', fontWeight: 500,
                }}>
                  Activating next market...
                </p>
              ) : (
                <p style={{ fontSize: 20, color: 'rgba(238,238,238,0.55)', lineHeight: '26px', margin: '0 0 8px' }}>
                  Will BTC close above or below{' '}
                  <span style={{ color: '#4d7fff', fontWeight: 600 }}>${strikePrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                  {' '}in <span style={{ color: '#f7931a', fontWeight: 600 }}>{timeDisplay}</span> minutes?
                </p>
              )}
              <button
                onClick={() => handlePlaceOrder('yes')}
                disabled={isPlacing || isActivating}
                style={{
                  width: '100%', padding: '16px 28px', borderRadius: 12, border: bdr,
                  background: 'rgba(238,238,238,0.05)',
                  cursor: isPlacing || isActivating ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8,
                  opacity: isPlacing || isActivating ? 0.4 : 1,
                }}>
                <span style={{ fontSize: 28, fontWeight: 600, color: '#95ff94' }}>Above</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <span style={{ fontSize: 22, color: dim }}>{yesMultiplier}x</span>
                  <span style={{ fontSize: 28, fontWeight: 700, color: '#eee' }}>{yesPayout}</span>
                </div>
              </button>
              <button
                onClick={() => handlePlaceOrder('no')}
                disabled={isPlacing || isActivating}
                style={{
                  width: '100%', padding: '16px 28px', borderRadius: 12, border: bdr,
                  background: 'rgba(238,238,238,0.05)',
                  cursor: isPlacing || isActivating ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  opacity: isPlacing || isActivating ? 0.4 : 1,
                }}>
                <span style={{ fontSize: 28, fontWeight: 600, color: '#f55252' }}>Below</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <span style={{ fontSize: 22, color: dim }}>{noMultiplier}x</span>
                  <span style={{ fontSize: 28, fontWeight: 700, color: '#eee' }}>{noPayout}</span>
                </div>
              </button>
            </div>
          </div>

          {/* Bottom group */}
          <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, ...(chatOpen ? { flex: 1, minHeight: 0 } : {}) }}>
            <div style={{ height: 1, background: 'rgba(255,255,255,0.11)', flexShrink: 0 }} />

            {!chatOpen && (
              <>
                <div style={{ padding: '12px 36px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span style={{ fontSize: 22, color: '#eee', fontWeight: 500 }}>POSITIONS</span>
                    <InfoDot text="Your active positions for the current round. PnL updates live." />
                  </div>
                  {firstPosition ? (
                    <div style={{ padding: '16px 24px', borderRadius: 12, border: bdr, background: 'rgba(238,238,238,0.05)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                          <span style={{ fontSize: 24, fontWeight: 600, color: firstPosition.yesShares > 0 ? '#95ff94' : '#f55252' }}>
                            {firstPosition.yesShares > 0 ? 'Above' : 'Below'}
                          </span>
                          <span style={{ fontSize: 20, color: dim }}>{firstPosition.asset}</span>
                        </div>
                        <span style={{ fontSize: 24, fontWeight: 500, color: '#eee' }}>
                          ${(firstPosition.totalCost ?? ((firstPosition.yesShares + firstPosition.noShares) * firstPosition.avgEntryPrice)).toFixed(2)}
                        </span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                        <span style={{ fontSize: 20, color: '#eee' }}>
                          Entry: ${firstPosition.avgEntryPrice.toFixed(4)}
                          {liveMark > 0 && (
                            <span style={{ color: dim }}>{' → '}<span style={{ color: liveMark >= firstPosition.avgEntryPrice ? '#95ff94' : '#f55252' }}>${liveMark.toFixed(4)}</span></span>
                          )}
                        </span>
                        <span style={{
                          fontSize: 24, fontWeight: 700,
                          color: livePnL >= 0 ? '#95ff94' : '#f55252',
                        }}>
                          ${livePnL >= 0 ? '+' : ''}{livePnL.toFixed(2)}
                        </span>
                      </div>
                      <button style={{
                        width: '100%', padding: '14px 0', borderRadius: 12,
                        background: '#95ff94', border: 'none', color: '#232323',
                        fontSize: 24, fontWeight: 700, cursor: 'pointer',
                      }}>
                        Close Position
                      </button>
                    </div>
                  ) : (
                    <div style={{ padding: '24px 24px', borderRadius: 12, border: bdr, background: 'rgba(238,238,238,0.05)', textAlign: 'center' }}>
                      <span style={{ fontSize: 22, color: dim }}>No open positions</span>
                    </div>
                  )}
                </div>

                <div style={{ height: 1, background: 'rgba(255,255,255,0.11)' }} />

                <div style={{ padding: '10px 36px' }}>
                  <span style={{ fontSize: 22, color: '#eee', fontWeight: 500 }}>LIVE WINS</span>
                </div>

                <div style={{ height: 1, background: 'rgba(255,255,255,0.11)' }} />
              </>
            )}

            <div
              onClick={() => setChatOpen(!chatOpen)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '8px 28px', flexShrink: 0, cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 20, color: '#eee', fontWeight: 500 }}>CHATROOM</span>
                <div style={{ width: 16, height: 16, borderRadius: '50%', background: '#001eff' }} />
              </div>
              <ChevronUp size={22} color={dim} style={{
                transform: chatOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s',
              }} />
            </div>

            {chatOpen && <ChatPanel />}
          </div>
        </div>
      </div>

      <DelegationModal open={delegationModalOpen} onClose={() => setDelegationModalOpen(false)} onDelegationChange={() => delegation.checkApproval()} />
      <V3Prompt open={promptOpen} onClose={() => setPromptOpen(false)} {...promptMsg} />
    </>
  );
}
