import { useState, useCallback } from 'react';
import { Zap, ChevronDown, ChevronUp } from 'lucide-react';
import Orderbook from './Orderbook';
import ChatPanel from './ChatPanel';
import DelegationModal from './DelegationModal';
import { V3Prompt } from './V3Modal';
import { useAuth } from '@/hooks/useAuth';
import { useUser } from '@/hooks/useUser';
import { useOrder } from '@/hooks/useOrder';
import { useSessionKey } from '@/hooks/useSessionKey';
import { useDelegation } from '@/hooks/useDelegation';
import { useMarketStore, useSelectedMarket } from '@/stores/marketStore';
import { useBestPrices } from '@/hooks/useOrderbook';
import { useSettingsStore } from '@/stores/settingsStore';

const bdr = '1px solid rgba(255,255,255,0.11)';
const dim = 'rgba(238,238,238,0.33)';



export default function RightSidebar() {
  const { isAuthenticated, wallet } = useAuth();
  const { balance } = useUser();
  const sessionKey = useSessionKey();
  const { placeOrder, isPlacing, error: orderError, clearError: clearOrderError } = useOrder(sessionKey.sessionSigner);
  const delegation = useDelegation();
  const market = useSelectedMarket();
  const yesPrices = useBestPrices('YES');
  const noPrices = useBestPrices('NO');
  const { defaultOrderType } = useSettingsStore();

  const [orderType, setOrderType] = useState<'market' | 'limit'>(defaultOrderType);
  const [amount, setAmount] = useState(25);
  const [limitPrice, setLimitPrice] = useState('0.50');
  const [leverage, setLeverage] = useState(1);
  const [tradeType, setTradeType] = useState<'direction' | 'volatility'>('direction');
  const [obView, setObView] = useState<'book' | 'market'>('book');
  const [chatOpen, setChatOpen] = useState(false);
  const [delegationModalOpen, setDelegationModalOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptMsg, setPromptMsg] = useState({ title: '', message: '', type: 'info' as const });
  
  const leverageOptions = [1, 2, 3, 5, 10];

  const amountPresets = [25, 50, 100, 250];

  const showPrompt = useCallback((title: string, message: string, type: 'info' | 'error' | 'success' | 'warning' = 'info') => {
    setPromptMsg({ title, message, type });
    setPromptOpen(true);
  }, []);

  const executePlaceOrder = useCallback(async (outcome: 'yes' | 'no', side: 'bid' | 'ask') => {
    if (!market) return;

    const prices = outcome === 'yes' ? yesPrices : noPrices;
    const price = orderType === 'market' ? prices.bestAsk || 0.50 : prices.bestAsk || 0.50;
    const isLeveraged = leverage > 1;
    const marginAmount = isLeveraged ? amount / leverage : undefined;
    const size = amount / price;

    const result = await placeOrder({
      marketAddress: market.address,
      side,
      outcome,
      orderType,
      price,
      size,
      dollarAmount: orderType === 'market' ? amount : undefined,
      maxPrice: orderType === 'market' ? 0.99 : undefined,
      ...(isLeveraged && { leverage, marginAmount }),
    });

    if (result && result.status !== 'error') {
      setTimeout(() => delegation.checkApproval(), 500);
    } else if (result?.error) {
      showPrompt('Order Failed', result.error, 'error');
    }
  }, [market, orderType, amount, leverage, yesPrices, noPrices, placeOrder, showPrompt, delegation]);

  const handlePlaceOrder = useCallback(async (outcome: 'yes' | 'no', side: 'bid') => {
    if (!wallet.connected) {
      showPrompt('Connect Wallet', 'Please connect your wallet to place orders.', 'warning');
      return;
    }
    if (!isAuthenticated) {
      showPrompt('Sign In Required', 'Please sign in to place orders.', 'warning');
      return;
    }
    if (!delegation.isApproved) {
      showPrompt('Delegation Required', 'Please delegate USDC to start trading.', 'warning');
      setDelegationModalOpen(true);
      return;
    }
    if (!market) {
      showPrompt('No Market', 'No active market available.', 'error');
      return;
    }

    await executePlaceOrder(outcome, side);
  }, [wallet.connected, isAuthenticated, delegation.isApproved, market, executePlaceOrder, showPrompt]);

  const handleVolatilityOrder = useCallback(async (type: 'volatile' | 'stable') => {
    if (!wallet.connected) {
      showPrompt('Connect Wallet', 'Please connect your wallet to place orders.', 'warning');
      return;
    }
    if (!isAuthenticated) {
      showPrompt('Sign In Required', 'Please sign in to place orders.', 'warning');
      return;
    }
    if (!delegation.isApproved) {
      showPrompt('Delegation Required', 'Please delegate USDC to start trading.', 'warning');
      setDelegationModalOpen(true);
      return;
    }
    if (!market) {
      showPrompt('No Market', 'No active market available.', 'error');
      return;
    }

    const isLeveraged = leverage > 1;
    const leverageParams = isLeveraged ? { leverage, marginAmount: amount / leverage / 2 } : {};

    if (type === 'volatile') {
      const halfAmount = amount / 2;
      const yesPrice = yesPrices.bestAsk || 0.50;
      const noPrice = noPrices.bestAsk || 0.50;

      await placeOrder({
        marketAddress: market.address,
        side: 'bid',
        outcome: 'yes',
        orderType,
        price: yesPrice,
        size: halfAmount / yesPrice,
        dollarAmount: orderType === 'market' ? halfAmount : undefined,
        maxPrice: orderType === 'market' ? 0.99 : undefined,
        ...leverageParams,
      });

      await placeOrder({
        marketAddress: market.address,
        side: 'bid',
        outcome: 'no',
        orderType,
        price: noPrice,
        size: halfAmount / noPrice,
        dollarAmount: orderType === 'market' ? halfAmount : undefined,
        maxPrice: orderType === 'market' ? 0.99 : undefined,
        ...leverageParams,
      });

      setTimeout(() => delegation.checkApproval(), 500);
    } else {
      const halfAmount = amount / 2;
      const yesPrice = yesPrices.bestBid || 0.50;
      const noPrice = noPrices.bestBid || 0.50;

      await placeOrder({
        marketAddress: market.address,
        side: 'ask',
        outcome: 'yes',
        orderType: 'market',
        price: yesPrice,
        size: halfAmount / yesPrice,
        dollarAmount: halfAmount,
      });

      await placeOrder({
        marketAddress: market.address,
        side: 'ask',
        outcome: 'no',
        orderType: 'market',
        price: noPrice,
        size: halfAmount / noPrice,
        dollarAmount: halfAmount,
      });

      setTimeout(() => delegation.checkApproval(), 500);
    }
  }, [wallet.connected, isAuthenticated, delegation.isApproved, market, orderType, amount, yesPrices, noPrices, placeOrder, showPrompt, delegation]);

  const balanceDisplay = balance ? `$${balance.available.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '$0';
  const delegatedDisplay = delegation.delegatedAmount > 0
    ? `$${(delegation.delegatedAmount / 1_000_000).toLocaleString()}`
    : '$0';

  const strikePrice = market?.strike ?? 0;
  const expiryMs = market?.expiry ?? 0;
  const isActivating = !market || strikePrice <= 0;
  const timeLeft = Math.max(0, Math.floor((expiryMs - Date.now()) / 1000));
  const timeDisplay = isActivating ? '—:——' : `${Math.floor(timeLeft / 60)}:${String(timeLeft % 60).padStart(2, '0')}`;

  const yesMultiplier = yesPrices.bestAsk > 0 ? (1 / yesPrices.bestAsk).toFixed(2) : '--';
  const noMultiplier = noPrices.bestAsk > 0 ? (1 / noPrices.bestAsk).toFixed(2) : '--';
  const yesPayout = yesPrices.bestAsk > 0 ? `+$${Math.round(amount * (1 / yesPrices.bestAsk - 1))}` : '--';
  const noPayout = noPrices.bestAsk > 0 ? `+$${Math.round(amount * (1 / noPrices.bestAsk - 1))}` : '--';

  return (
    <>
      <div style={{
        width: 720, minWidth: 720, background: '#1e1e1e', borderRadius: 22,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Balance */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 28px', flexShrink: 0 }}>
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

        {/* Order Type */}
        <div style={{ padding: '12px 28px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 20, color: '#eee', fontWeight: 500 }}>ORDER TYPE</span>
          </div>
          <div style={{ display: 'flex', borderRadius: 10, background: '#181818', overflow: 'hidden' }}>
            {(['market', 'limit'] as const).map((t) => (
              <button key={t} onClick={() => setOrderType(t)} style={{
                flex: 1, padding: '12px 0', border: 'none', fontSize: 22, fontWeight: 500, cursor: 'pointer',
                background: orderType === t ? 'rgba(238,238,238,0.22)' : 'rgba(238,238,238,0.05)',
                color: orderType === t ? '#eee' : dim,
              }}>{t === 'market' ? 'Market' : 'Limit'}</button>
            ))}
          </div>
        </div>

        {/* Mode-specific sections — limit trimmed to match market height exactly */}
        {orderType === 'limit' ? (
          <>
            {/* Limit Price */}
            <div style={{ padding: '8px 28px 8px', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 20, color: '#eee', fontWeight: 500 }}>LIMIT PRICE</span>
                <span style={{ fontSize: 16, color: dim, marginLeft: 'auto' }}>$0.01 – $0.99</span>
              </div>
              <div style={{
                height: 52, borderRadius: 10, border: bdr, background: '#232323',
                position: 'relative', display: 'flex', alignItems: 'center',
              }}>
                <span style={{ fontSize: 22, fontWeight: 600, color: '#eee', position: 'absolute', left: 16, pointerEvents: 'none' }}>$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={limitPrice}
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^0-9.]/g, '');
                    if (v === '' || v === '.' || v === '0.' || /^\d*\.?\d{0,2}$/.test(v)) {
                      setLimitPrice(v);
                    }
                  }}
                  onBlur={() => {
                    const n = parseFloat(limitPrice);
                    if (isNaN(n) || n < 0.01) setLimitPrice('0.01');
                    else if (n > 0.99) setLimitPrice('0.99');
                    else setLimitPrice(n.toFixed(2));
                  }}
                  style={{
                    width: '100%', height: '100%', border: 'none', background: 'transparent',
                    textAlign: 'center', fontSize: 24, fontWeight: 600, color: '#eee',
                    outline: 'none', fontFamily: 'inherit', padding: '0 36px',
                  }}
                />
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                {[0.10, 0.25, 0.50, 0.75, 0.90].map((p) => (
                  <button key={p} onClick={() => setLimitPrice(p.toFixed(2))} style={{
                    flex: 1, padding: '6px 0', borderRadius: 8, fontSize: 18, fontWeight: 600, cursor: 'pointer',
                    border: 'none',
                    background: limitPrice === p.toFixed(2) ? '#424242' : '#232323',
                    color: limitPrice === p.toFixed(2) ? '#eee' : dim,
                  }}>${p.toFixed(2)}</button>
                ))}
              </div>
            </div>

            {/* Amount */}
            <div style={{ padding: '6px 28px 10px', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 20, color: '#eee', fontWeight: 500 }}>AMOUNT</span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                {amountPresets.map((p) => (
                  <button key={p} onClick={() => setAmount(p)} style={{
                    flex: 1, padding: '10px 0', borderRadius: 10, fontSize: 20, fontWeight: 600, cursor: 'pointer',
                    border: 'none',
                    background: amount === p ? '#424242' : '#232323', color: amount === p ? '#eee' : dim,
                  }}>${p}</button>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={() => setAmount(Math.max(5, amount - 5))} style={{
                  width: 56, height: 56, borderRadius: 10, border: bdr,
                  background: '#232323', color: dim, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, fontWeight: 600,
                }}>-</button>
                <div style={{
                  flex: 1, height: 56, borderRadius: 10, border: bdr, background: '#232323',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
                }}>
                  <span style={{ fontSize: 22, fontWeight: 600, color: '#eee', position: 'absolute', left: 14, pointerEvents: 'none' }}>$</span>
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
                      textAlign: 'center', fontSize: 22, fontWeight: 600, color: '#eee',
                      outline: 'none', fontFamily: 'inherit', padding: '0 20px',
                    }}
                  />
                </div>
                <button onClick={() => setAmount(amount + 5)} style={{
                  width: 56, height: 56, borderRadius: 10, border: bdr,
                  background: '#232323', color: dim, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, fontWeight: 600,
                }}>+</button>
              </div>
            </div>

            {/* Summary */}
            <div style={{ padding: '2px 28px 6px', flexShrink: 0 }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '6px 14px', borderRadius: 8, background: 'rgba(238,238,238,0.04)',
                border: bdr, fontSize: 18,
              }}>
                <span style={{ color: dim }}>
                  {parseFloat(limitPrice) > 0 ? Math.floor(amount / parseFloat(limitPrice)) : '—'} contracts
                </span>
                <span style={{ color: dim }}>
                  payout <span style={{ color: '#95ff94', fontWeight: 600 }}>
                    {parseFloat(limitPrice) > 0 ? `$${Math.floor(amount / parseFloat(limitPrice))}` : '—'}
                  </span>
                </span>
                <span style={{ color: '#95ff94', fontWeight: 600 }}>
                  {parseFloat(limitPrice) > 0 ? `+$${Math.floor(amount / parseFloat(limitPrice)) - amount}` : '—'}
                </span>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* Amount */}
            <div style={{ padding: '8px 28px 10px', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 20, color: '#eee', fontWeight: 500 }}>AMOUNT</span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                {amountPresets.map((p) => (
                  <button key={p} onClick={() => setAmount(p)} style={{
                    flex: 1, padding: '10px 0', borderRadius: 10, fontSize: 20, fontWeight: 600, cursor: 'pointer',
                    border: 'none',
                    background: amount === p ? '#424242' : '#232323', color: amount === p ? '#eee' : dim,
                  }}>${p}</button>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={() => setAmount(Math.max(5, amount - 5))} style={{
                  width: 56, height: 56, borderRadius: 10, border: bdr,
                  background: '#232323', color: dim, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, fontWeight: 600,
                }}>-</button>
                <div style={{
                  flex: 1, height: 56, borderRadius: 10, border: bdr, background: '#232323',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
                }}>
                  <span style={{ fontSize: 22, fontWeight: 600, color: '#eee', position: 'absolute', left: 14, pointerEvents: 'none' }}>$</span>
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
                      textAlign: 'center', fontSize: 22, fontWeight: 600, color: '#eee',
                      outline: 'none', fontFamily: 'inherit', padding: '0 20px',
                    }}
                  />
                </div>
                <button onClick={() => setAmount(amount + 5)} style={{
                  width: 56, height: 56, borderRadius: 10, border: bdr,
                  background: '#232323', color: dim, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, fontWeight: 600,
                }}>+</button>
              </div>
            </div>

            {/* Leverage */}
            <div style={{ padding: '6px 28px 10px', flexShrink: 0, opacity: 0.45 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 20, color: '#eee', fontWeight: 500 }}>LEVERAGE</span>
                <span style={{ fontSize: 16, color: dim, marginLeft: 'auto', fontStyle: 'italic' }}>Coming Soon</span>
              </div>
              <div style={{ display: 'flex', gap: 8, pointerEvents: 'none' }}>
                {leverageOptions.map((l) => (
                  <button key={l} style={{
                    flex: 1, padding: '8px 0', borderRadius: 10, fontSize: 20, fontWeight: 600,
                    cursor: 'default', border: 'none',
                    background: l === 1 ? '#424242' : '#232323',
                    color: l === 1 ? '#eee' : dim,
                  }}>{l}x</button>
                ))}
              </div>
            </div>

            {/* Trade Type */}
            <div style={{ padding: '6px 28px 10px', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 20, color: '#eee', fontWeight: 500 }}>TRADE TYPE</span>
              </div>
              <div style={{ display: 'flex', borderRadius: 10, background: '#181818', overflow: 'hidden' }}>
                <button style={{
                  flex: 1, padding: '10px 0', border: 'none', fontSize: 20, fontWeight: 500, cursor: 'default',
                  background: 'rgba(238,238,238,0.22)', color: '#eee',
                }}>Direction</button>
                <button disabled style={{
                  flex: 1, padding: '10px 0', border: 'none', fontSize: 20, fontWeight: 500,
                  cursor: 'default', background: 'rgba(238,238,238,0.05)', color: dim, position: 'relative',
                }}>
                  <span style={{ opacity: 0.5 }}>Volatility</span>
                  <span style={{ fontSize: 14, position: 'absolute', top: 2, right: 8, color: dim, fontStyle: 'italic' }}>Soon</span>
                </button>
              </div>
            </div>
          </>
        )}

        {/* Place Order — shared */}
        <div style={{ padding: '4px 28px 8px', flexShrink: 0 }}>
          {isActivating ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6,
            }}>
              <span style={{
                  padding: '4px 12px', borderRadius: 6, fontSize: 16, fontWeight: 700,
                  background: '#001eff', color: '#fff', letterSpacing: '0.04em',
                }}>STRIKE</span>
              <span style={{ fontSize: 18, color: '#f7931a', fontWeight: 500, animation: 'pulse 1.5s ease-in-out infinite' }}>
                Activating...
              </span>
            </div>
          ) : (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{
                  padding: '4px 12px', borderRadius: 6, fontSize: 16, fontWeight: 700,
                  background: '#001eff', color: '#fff', letterSpacing: '0.04em',
                }}>STRIKE</span>
                <span style={{ fontSize: 20, color: '#eee', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                  ${strikePrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </span>
              </div>
              <span style={{ fontSize: 20, color: '#f7931a', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                {timeDisplay}
              </span>
            </div>
          )}
          <button
            onClick={() => handlePlaceOrder('yes', 'bid')}
            disabled={isPlacing || isActivating}
            style={{
              width: '100%', padding: '10px 20px', borderRadius: 10,
              border: bdr, background: 'rgba(238,238,238,0.05)',
              cursor: isPlacing || isActivating ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', marginBottom: 6,
              opacity: isPlacing || isActivating ? 0.4 : 1,
            }}>
            <span style={{ fontSize: 22, fontWeight: 500, color: '#95ff94' }}>
              {orderType === 'limit' ? 'Buy Above' : 'Above'}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {orderType === 'market' ? (
                <>
                  <span style={{ fontSize: 18, color: dim }}>{yesMultiplier}x</span>
                  <span style={{ fontSize: 22, fontWeight: 700, color: '#eee' }}>{yesPayout}</span>
                </>
              ) : (
                <span style={{ fontSize: 18, color: dim }}>@ ${limitPrice}</span>
              )}
            </div>
          </button>
          <button
            onClick={() => handlePlaceOrder('no', 'bid')}
            disabled={isPlacing || isActivating}
            style={{
              width: '100%', padding: '10px 20px', borderRadius: 10,
              border: bdr, background: 'rgba(238,238,238,0.05)',
              cursor: isPlacing || isActivating ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center',
              justifyContent: 'space-between',
              opacity: isPlacing || isActivating ? 0.4 : 1,
            }}>
            <span style={{ fontSize: 22, fontWeight: 500, color: '#f55252' }}>
              {orderType === 'limit' ? 'Buy Below' : 'Below'}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {orderType === 'market' ? (
                <>
                  <span style={{ fontSize: 18, color: dim }}>{noMultiplier}x</span>
                  <span style={{ fontSize: 22, fontWeight: 700, color: '#eee' }}>{noPayout}</span>
                </>
              ) : (
                <span style={{ fontSize: 18, color: dim }}>@ ${limitPrice}</span>
              )}
            </div>
          </button>
        </div>

        {/* Win Chain */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 28px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 20, color: '#eee', fontWeight: 500 }}>WIN CHAIN</span>
          </div>
          <div style={{
            width: 32, height: 32, borderRadius: 6, border: bdr, background: '#232323',
          }} />
        </div>

        <div style={{ height: 1, background: 'rgba(255,255,255,0.11)', flexShrink: 0 }} />

        {chatOpen ? (
          <>
            <div
              onClick={() => setChatOpen(false)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '8px 28px', flexShrink: 0, cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 20, color: '#eee', fontWeight: 500 }}>CHATROOM</span>
                <div style={{ width: 16, height: 16, borderRadius: '50%', background: '#001eff' }} />
              </div>
              <ChevronUp size={22} color={dim} style={{ transform: 'rotate(180deg)', transition: 'transform 0.2s' }} />
            </div>
            <ChatPanel />
          </>
        ) : (
          <>
            <div style={{ padding: '8px 28px 4px', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 20, color: '#eee', fontWeight: 500 }}>ORDER BOOK</span>
                </div>
                <div style={{ display: 'flex', borderRadius: 6, background: 'rgba(238,238,238,0.11)', overflow: 'hidden' }}>
                  {(['book', 'market'] as const).map((v) => (
                    <button key={v} onClick={() => setObView(v)} style={{
                      padding: '4px 14px', border: 'none', fontSize: 20, fontWeight: 500, cursor: 'pointer',
                      background: obView === v ? 'rgba(238,238,238,0.22)' : 'transparent',
                      color: '#eee',
                    }}>{v === 'book' ? 'Book' : 'Market'}</button>
                  ))}
                </div>
              </div>
              <Orderbook />
            </div>

            <div
              onClick={() => setChatOpen(true)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '6px 28px', flexShrink: 0, cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 20, color: '#eee', fontWeight: 500 }}>CHATROOM</span>
                <div style={{ width: 16, height: 16, borderRadius: '50%', background: '#001eff' }} />
              </div>
              <ChevronUp size={22} color={dim} />
            </div>
          </>
        )}
      </div>

      <DelegationModal open={delegationModalOpen} onClose={() => setDelegationModalOpen(false)} onDelegationChange={() => delegation.checkApproval()} />
      <V3Prompt open={promptOpen} onClose={() => setPromptOpen(false)} {...promptMsg} />
      {orderError && (
        <V3Prompt
          open={!!orderError}
          onClose={clearOrderError}
          title="Order Error"
          message={orderError}
          type="error"
        />
      )}
    </>
  );
}
