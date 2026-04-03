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
import type { Timeframe } from '@degen/types';
import { usePriceStore } from '@/stores/priceStore';
import { useOrderbook, useBestPrices } from '@/hooks/useOrderbook';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';

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
          width: 18, height: 18, borderRadius: '50%', border: `1px solid ${dim}`,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          cursor: text ? 'pointer' : 'default',
        }}
      >
        <span style={{ fontSize: 11, color: dim, fontWeight: 500 }}>i</span>
      </div>
      {open && text && (
        <div style={{
          position: 'absolute', top: 24, left: '50%', transform: 'translateX(-50%)',
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

export default function LiteSidebar() {
  const { isAuthenticated, wallet, signIn } = useAuth();
  const { balance, positions } = useUser();
  const sessionKey = useSessionKey();
  const { placeOrder, isPlacing } = useOrder(sessionKey.sessionSigner);
  const delegation = useDelegation();
  const market = useSelectedMarket();
  useOrderbook(market?.address ?? null);
  const yesPrices = useBestPrices('YES');
  const noPrices = useBestPrices('NO');

  const { setVisible: setWalletModalVisible } = useWalletModal();
  const { selectedAsset, selectedTimeframe, setTimeframe: setStoreTimeframe } = useMarketStore();
  const assetPrice = usePriceStore(s => s.prices[selectedAsset as keyof typeof s.prices]);
  const [amount, setAmount] = useState(25);
  const [timeframe, setTimeframe] = useState(selectedTimeframe);
  const [chatOpen, setChatOpen] = useState(false);
  const [delegationModalOpen, setDelegationModalOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [closingPosition, setClosingPosition] = useState<string | null>(null);
  const [pnlToasts, setPnlToasts] = useState<{ id: number; pnl: number }[]>([]);
  const [promptMsg, setPromptMsg] = useState({ title: '', message: '', type: 'info' as 'info' | 'error' | 'success' | 'warning' });
  const amountPresets = [25, 50, 100, 250];

  const showPrompt = useCallback((title: string, message: string, type: 'info' | 'error' | 'success' | 'warning' = 'info') => {
    setPromptMsg({ title, message, type });
    setPromptOpen(true);
  }, []);

  const yesHasBuyLiquidity = yesPrices.bestAskSize > 0 && yesPrices.bestAsk > 0 && yesPrices.bestAsk < 1;
  const noHasBuyLiquidity = noPrices.bestAskSize > 0 && noPrices.bestAsk > 0 && noPrices.bestAsk < 1;

  const handlePlaceOrder = useCallback(async (outcome: 'yes' | 'no') => {
    if (!wallet.connected) { setWalletModalVisible(true); return; }
    if (!isAuthenticated) {
      try { await signIn(); } catch { return; }
    }
    const approved = await delegation.checkApproval();
    if (!approved) { showPrompt('Delegation Required', 'Please delegate USDC.', 'warning'); setDelegationModalOpen(true); return; }
    const delegatedUsd = delegation.delegatedAmount / 1_000_000;
    if (amount > delegatedUsd) {
      showPrompt('Insufficient Delegation', `You have $${delegatedUsd.toFixed(2)} delegated but need $${amount}. Please increase your delegation.`, 'warning');
      setDelegationModalOpen(true);
      return;
    }
    if (!market) { showPrompt('No Market', 'No active market.', 'error'); return; }

    const prices = outcome === 'yes' ? yesPrices : noPrices;
    const hasLiquidity = outcome === 'yes' ? yesHasBuyLiquidity : noHasBuyLiquidity;
    if (!hasLiquidity) {
      showPrompt('No Liquidity', `No liquidity available to buy ${outcome === 'yes' ? 'Above' : 'Below'} right now.`, 'warning');
      return;
    }
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
      setTimeout(() => delegation.checkApproval(), 500);
    } else if (result?.error) {
      showPrompt('Order Failed', result.error, 'error');
    }
  }, [wallet.connected, isAuthenticated, market, amount, yesPrices, noPrices, yesHasBuyLiquidity, noHasBuyLiquidity, placeOrder, showPrompt, delegation, signIn, setWalletModalVisible]);

  const showPnlToast = useCallback((pnl: number) => {
    const id = Date.now();
    setPnlToasts(prev => [...prev, { id, pnl }]);
    setTimeout(() => setPnlToasts(prev => prev.filter(t => t.id !== id)), 2000);
  }, []);

  const handleClosePosition = useCallback(async (entry: { pos: { marketAddress: string }; isYes: boolean; shares: number; entryPrice: number; costBasis: number }) => {
    const outcome = entry.isYes ? 'yes' : 'no';
    const key = `${entry.pos.marketAddress}-${outcome}`;
    setClosingPosition(key);
    try {
      const result = await placeOrder({
        marketAddress: entry.pos.marketAddress,
        side: 'ask',
        outcome: outcome as 'yes' | 'no',
        orderType: 'market',
        price: 0.01,
        size: entry.shares,
      });
      if (result?.error) {
        showPrompt('Close Failed', result.error, 'error');
      } else if (result && result.filledSize > 0) {
        const proceeds = (result.avgPrice ?? 0) * result.filledSize;
        const sellFee = result.totalFee ?? 0;
        showPnlToast(proceeds - entry.costBasis - sellFee);
      } else if (result && result.filledSize === 0) {
        showPrompt('No Liquidity', 'No liquidity available to close your position. It will settle automatically at market expiry.', 'warning');
      }
    } finally {
      setClosingPosition(null);
    }
  }, [placeOrder, showPrompt, showPnlToast]);

  const balanceDisplay = balance ? `$${balance.available.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '$0';
  const delegatedDisplay = delegation.delegatedAmount > 0 ? `$${(delegation.delegatedAmount / 1_000_000).toLocaleString()}` : '$0';

  const strikePrice = market?.strike ?? 0;
  const expiryMs = market?.expiry ?? 0;
  const isActivating = !market || strikePrice <= 0;
  const timeLeft = Math.max(0, Math.floor((expiryMs - Date.now()) / 1000));
  const timeDisplay = isActivating ? '—:——' : `${Math.floor(timeLeft / 60)}:${String(timeLeft % 60).padStart(2, '0')}`;

  const yesMultiplier = yesHasBuyLiquidity ? (1 / yesPrices.bestAsk).toFixed(2) : '--';
  const noMultiplier = noHasBuyLiquidity ? (1 / noPrices.bestAsk).toFixed(2) : '--';
  const yesPayout = yesHasBuyLiquidity ? `+$${Math.round(amount * (1 / yesPrices.bestAsk - 1))}` : '--';
  const noPayout = noHasBuyLiquidity ? `+$${Math.round(amount * (1 / noPrices.bestAsk - 1))}` : '--';


  // Listen for sell events from TradeBubbles overlay
  const handleBubbleSell = useCallback(async (outcome: 'yes' | 'no', mktAddr: string) => {
    const pos = positions.find(p =>
      (p.marketAddress === mktAddr || p.market === mktAddr) && p.status === 'open'
    );
    if (!pos) return;
    const shares = outcome === 'yes' ? pos.yesShares : pos.noShares;
    if (shares <= 0) return;
    const entryPrice = outcome === 'yes'
      ? (pos.avgEntryYes ?? pos.avgEntryPrice)
      : (pos.avgEntryNo ?? pos.avgEntryPrice);
    const costBasis = pos.totalCost ?? (shares * entryPrice);
    const result = await placeOrder({
      marketAddress: pos.marketAddress,
      side: 'ask',
      outcome,
      orderType: 'market',
      price: 0.01,
      size: shares,
    });
    if (result && result.filledSize > 0) {
      const proceeds = (result.avgPrice ?? 0) * result.filledSize;
      const sellFee = result.totalFee ?? 0;
      showPnlToast(proceeds - costBasis - sellFee);
    } else if (result && result.filledSize === 0) {
      showPrompt('No Liquidity', 'No liquidity available to close your position. It will settle automatically at market expiry.', 'warning');
    }
  }, [positions, placeOrder, showPrompt, showPnlToast]);

  useEffect(() => {
    const handler = (e: Event) => {
      const { outcome, marketAddress: mktAddr } = (e as CustomEvent).detail;
      handleBubbleSell(outcome, mktAddr);
    };
    window.addEventListener('trade-bubble-sell', handler);
    return () => window.removeEventListener('trade-bubble-sell', handler);
  }, [handleBubbleSell]);

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

  // Split positions with both YES and NO shares into separate display entries
  type DisplayEntry = { pos: typeof openPositions[0]; isYes: boolean; shares: number; costBasis: number; entryPrice: number };
  const displayEntries: DisplayEntry[] = [];
  for (const pos of openPositions) {
    const hasYes = pos.yesShares > 0;
    const hasNo = pos.noShares > 0;
    if (hasYes && hasNo) {
      const yesEntry = pos.avgEntryYes ?? pos.avgEntryPrice;
      const noEntry = pos.avgEntryNo ?? pos.avgEntryPrice;
      const yesNotional = pos.yesShares * yesEntry;
      const noNotional = pos.noShares * noEntry;
      const totalNotional = yesNotional + noNotional;
      const yesCost = pos.totalCost ? pos.totalCost * (yesNotional / totalNotional) : yesNotional;
      const noCost = pos.totalCost ? pos.totalCost - yesCost : noNotional;
      displayEntries.push({ pos, isYes: true, shares: pos.yesShares, costBasis: yesCost, entryPrice: yesEntry });
      displayEntries.push({ pos, isYes: false, shares: pos.noShares, costBasis: noCost, entryPrice: noEntry });
    } else if (hasYes) {
      const yesEntry = pos.avgEntryYes ?? pos.avgEntryPrice;
      displayEntries.push({ pos, isYes: true, shares: pos.yesShares, costBasis: pos.totalCost ?? pos.yesShares * yesEntry, entryPrice: yesEntry });
    } else if (hasNo) {
      const noEntry = pos.avgEntryNo ?? pos.avgEntryPrice;
      displayEntries.push({ pos, isYes: false, shares: pos.noShares, costBasis: pos.totalCost ?? pos.noShares * noEntry, entryPrice: noEntry });
    }
  }
  const firstEntry = displayEntries[0];

  const liteBestBid = firstEntry
    ? (firstEntry.isYes ? yesPrices.bestBid : noPrices.bestBid)
    : 0;
  const liteHasLiquidity = liteBestBid > 0 && liteBestBid < 1;
  let liveMark = firstEntry
    ? (liteHasLiquidity ? liteBestBid : 0)
    : 0;
  let liteFallback = false;
  if (firstEntry && !liteHasLiquidity && strikePrice > 0 && assetPrice) {
    if (assetPrice > strikePrice) {
      liveMark = firstEntry.isYes ? 0.999 : 0.001;
      liteFallback = true;
    } else if (assetPrice < strikePrice) {
      liveMark = firstEntry.isYes ? 0.001 : 0.999;
      liteFallback = true;
    }
  }
  const liveShares = firstEntry?.shares ?? 0;
  const liteCostBasis = firstEntry?.costBasis ?? 0;
  const _livePnL = firstEntry
    ? ((liteHasLiquidity || liteFallback) ? (liveMark * liveShares) - liteCostBasis : -liteCostBasis)
    : 0;

  return (
    <>
      <div style={{
        width: 'var(--sidebar-width)', minWidth: 'var(--sidebar-width)', background: '#1e1e1e', borderRadius: 17,
        display: 'flex', flexDirection: 'column', overflow: 'hidden', height: '100%',
      }}>
        {/* Balance */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 21px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 15, color: dim, fontWeight: 500 }}>BAL</span>
            <span style={{ fontSize: 20, fontWeight: 500, color: '#eee' }}>{balanceDisplay}</span>
          </div>
          <button
            onClick={() => setDelegationModalOpen(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5, padding: '3px 11px',
              borderRadius: 6, background: 'rgba(81,176,72,0.12)', border: 'none',
              color: '#95ff94', fontSize: 17, fontWeight: 500, cursor: 'pointer',
            }}>
            <Zap size={14} />
            <span>{delegatedDisplay}</span>
            <ChevronDown size={12} />
          </button>
        </div>

        <div style={{ height: 1, background: 'rgba(255,255,255,0.11)', flexShrink: 0 }} />

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
            <div style={{ padding: '11px 27px 3px' }}>
              <h2 style={{ fontSize: 36, fontWeight: 500, color: '#fff', margin: 0, lineHeight: '41px' }}>Up or Down?</h2>
              <p style={{ fontSize: 15, color: 'rgba(238,238,238,0.44)', lineHeight: '20px', margin: '3px 0 0' }}>
                Predict outcomes within timeframes.<br />0DTE Binary Options.
              </p>
            </div>

            <div style={{ padding: '6px 27px 6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <span style={{ fontSize: 17, color: '#eee', fontWeight: 500 }}>1. SELECT ROUND TIMEFRAME</span>
                <InfoDot text="Choose how long your prediction window lasts." />
              </div>
              <div style={{ display: 'flex', borderRadius: 9, background: 'rgba(238,238,238,0.05)', padding: 5, overflow: 'hidden' }}>
                {['1m', '5m', '15m', '1h'].map((tf) => {
                  const isActive = tf === timeframe;
                  const isDisabled = tf === '15m' || tf === '1h';
                  return (
                    <button key={tf} disabled={isDisabled} onClick={() => { if (!isDisabled) { setTimeframe(tf as Timeframe); setStoreTimeframe(tf as Timeframe); } }} style={{
                      flex: 1, padding: '9px 0', borderRadius: 9, border: 'none',
                      fontSize: 20, fontWeight: 600,
                      cursor: isDisabled ? 'not-allowed' : 'pointer',
                      background: isActive ? '#001eff' : 'transparent',
                      color: isActive ? '#fff' : dim,
                      opacity: isDisabled ? 0.4 : 1,
                    }}>{tf}</button>
                  );
                })}
              </div>
            </div>

            <div style={{ padding: '5px 27px 6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <span style={{ fontSize: 17, color: '#eee', fontWeight: 500 }}>2. SELECT AMOUNT</span>
                <InfoDot text="Set how much USDC to wager on this round. Minimum $1." />
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                {amountPresets.map((p) => (
                  <button key={p} onClick={() => setAmount(p)} style={{
                    flex: 1, padding: '8px 0', borderRadius: 9, fontSize: 20, fontWeight: 600, cursor: 'pointer',
                    border: 'none', background: amount === p ? '#424242' : '#232323', color: amount === p ? '#eee' : dim,
                  }}>${p}</button>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={() => setAmount(Math.max(1, amount - 5))} style={{
                  width: 45, height: 45, borderRadius: 9, border: bdr, background: '#232323', color: dim,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, fontWeight: 600,
                }}>-</button>
                <div style={{
                  flex: 1, height: 45, borderRadius: 9, border: bdr, background: '#232323',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
                }}>
                  <span style={{ fontSize: 21, fontWeight: 600, color: '#eee', position: 'absolute', left: 12, pointerEvents: 'none' }}>$</span>
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
                      textAlign: 'center', fontSize: 21, fontWeight: 600, color: '#eee',
                      outline: 'none', fontFamily: 'inherit', padding: '0 18px',
                    }}
                  />
                </div>
                <button onClick={() => setAmount(amount + 5)} style={{
                  width: 45, height: 45, borderRadius: 9, border: bdr, background: '#232323', color: dim,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, fontWeight: 600,
                }}>+</button>
              </div>
            </div>

            <div style={{ padding: '5px 27px 6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                <span style={{ fontSize: 17, color: '#eee', fontWeight: 500 }}>3. PLACE ORDER</span>
                <InfoDot text="Predict whether BTC will close above or below the strike price before the round ends." />
              </div>
              {isActivating ? (
                <p style={{
                  fontSize: 15, color: '#f7931a', lineHeight: '20px',
                  margin: '0 0 6px', fontWeight: 500,
                }}>
                  Activating next market...
                </p>
              ) : (
                <p style={{ fontSize: 15, color: 'rgba(238,238,238,0.55)', lineHeight: '20px', margin: '0 0 6px' }}>
                  Will BTC close above or below{' '}
                  <span style={{ color: '#4d7fff', fontWeight: 600 }}>${strikePrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                  {' '}in <span style={{ color: '#f7931a', fontWeight: 600 }}>{timeDisplay}</span> minutes?
                </p>
              )}
              <button
                onClick={() => handlePlaceOrder('yes')}
                disabled={isPlacing || isActivating || !yesHasBuyLiquidity}
                style={{
                  width: '100%', padding: '12px 21px', borderRadius: 9, border: bdr,
                  background: 'rgba(238,238,238,0.05)',
                  cursor: isPlacing || isActivating || !yesHasBuyLiquidity ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6,
                  opacity: isPlacing || isActivating || !yesHasBuyLiquidity ? 0.4 : 1,
                }}>
                <span style={{ fontSize: 21, fontWeight: 600, color: '#95ff94' }}>Above</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 17, color: dim }}>{yesMultiplier}x</span>
                  <span style={{ fontSize: 21, fontWeight: 700, color: '#eee' }}>{yesPayout}</span>
                </div>
              </button>
              <button
                onClick={() => handlePlaceOrder('no')}
                disabled={isPlacing || isActivating || !noHasBuyLiquidity}
                style={{
                  width: '100%', padding: '12px 21px', borderRadius: 9, border: bdr,
                  background: 'rgba(238,238,238,0.05)',
                  cursor: isPlacing || isActivating || !noHasBuyLiquidity ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  opacity: isPlacing || isActivating || !noHasBuyLiquidity ? 0.4 : 1,
                }}>
                <span style={{ fontSize: 21, fontWeight: 600, color: '#f55252' }}>Below</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 17, color: dim }}>{noMultiplier}x</span>
                  <span style={{ fontSize: 21, fontWeight: 700, color: '#eee' }}>{noPayout}</span>
                </div>
              </button>
            </div>

            <div style={{ padding: '9px 27px', position: 'relative' }}>
              {pnlToasts.map(t => (
                <div key={t.id} style={{
                  position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)',
                  fontSize: 28, fontWeight: 800, letterSpacing: '-0.5px',
                  color: t.pnl >= 0 ? '#95ff94' : '#f55252',
                  textShadow: `0 0 24px ${t.pnl >= 0 ? 'rgba(149,255,148,0.6)' : 'rgba(245,82,82,0.6)'}`,
                  animation: 'pnl-float 1.8s ease-out forwards',
                  pointerEvents: 'none', zIndex: 20,
                }}>
                  {t.pnl >= 0 ? '+' : ''}{t.pnl < 0 ? '-' : ''}${Math.abs(t.pnl).toFixed(2)}
                </div>
              ))}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <span style={{ fontSize: 17, color: '#eee', fontWeight: 500 }}>POSITIONS</span>
                <InfoDot text="Your active positions for the current round. PnL updates live." />
              </div>
              {displayEntries.length > 0 ? displayEntries.map((entry, idx) => {
                const eBestBid = entry.isYes ? yesPrices.bestBid : noPrices.bestBid;
                const eHasLiq = eBestBid > 0 && eBestBid < 1;
                let eMark = eHasLiq ? eBestBid : 0;
                let eFallback = false;
                if (!eHasLiq && strikePrice > 0 && assetPrice) {
                  if (assetPrice > strikePrice) {
                    eMark = entry.isYes ? 0.999 : 0.001;
                    eFallback = true;
                  } else if (assetPrice < strikePrice) {
                    eMark = entry.isYes ? 0.001 : 0.999;
                    eFallback = true;
                  }
                }
                const ePnl = (eHasLiq || eFallback) ? (eMark * entry.shares) - entry.costBasis : -entry.costBasis;
                return (
                <div key={`${entry.pos.marketAddress}-${entry.isYes ? 'yes' : 'no'}`} style={{ padding: '12px 18px', borderRadius: 9, border: bdr, background: 'rgba(238,238,238,0.05)', marginBottom: idx < displayEntries.length - 1 ? 6 : 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                      <span style={{ fontSize: 18, fontWeight: 600, color: entry.isYes ? '#95ff94' : '#f55252' }}>
                        {entry.isYes ? 'Above' : 'Below'}
                      </span>
                      <span style={{ fontSize: 15, color: dim }}>{entry.pos.asset}</span>
                    </div>
                    <span style={{ fontSize: 18, fontWeight: 500, color: '#eee' }}>
                      ${entry.costBasis.toFixed(2)}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: 15, color: '#eee' }}>
                      Entry: ${entry.entryPrice.toFixed(4)}
                      {eMark > 0 && (
                        <span style={{ color: dim }}>{' → '}<span style={{ color: eMark >= entry.entryPrice ? '#95ff94' : '#f55252' }}>${eMark.toFixed(4)}</span></span>
                      )}
                    </span>
                    <span style={{
                      fontSize: 18, fontWeight: 700,
                      color: ePnl >= 0 ? '#95ff94' : '#f55252',
                    }}>
                      ${ePnl >= 0 ? '+' : ''}{ePnl.toFixed(2)}
                    </span>
                  </div>
                  <button
                    onClick={() => handleClosePosition(entry)}
                    disabled={closingPosition === `${entry.pos.marketAddress}-${entry.isYes ? 'yes' : 'no'}`}
                    style={{
                      width: '100%', padding: '11px 0', borderRadius: 9,
                      background: closingPosition === `${entry.pos.marketAddress}-${entry.isYes ? 'yes' : 'no'}` ? 'rgba(149,255,148,0.4)' : '#95ff94',
                      border: 'none', color: '#232323',
                      fontSize: 18, fontWeight: 700,
                      cursor: closingPosition === `${entry.pos.marketAddress}-${entry.isYes ? 'yes' : 'no'}` ? 'not-allowed' : 'pointer',
                      opacity: closingPosition === `${entry.pos.marketAddress}-${entry.isYes ? 'yes' : 'no'}` ? 0.6 : 1,
                    }}>
                    {closingPosition === `${entry.pos.marketAddress}-${entry.isYes ? 'yes' : 'no'}` ? 'Closing...' : 'Close Position'}
                  </button>
                </div>
                );
              }) : (
                <div style={{ padding: '18px 18px', borderRadius: 9, border: bdr, background: 'rgba(238,238,238,0.05)', textAlign: 'center' }}>
                  <span style={{ fontSize: 17, color: dim }}>No open positions</span>
                </div>
              )}
            </div>
          </div>

        <div style={{ flexShrink: 0 }}>
          <div style={{ height: 1, background: 'rgba(255,255,255,0.11)' }} />
          <div
            onClick={() => setChatOpen(!chatOpen)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '6px 21px', cursor: 'pointer',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 15, color: '#eee', fontWeight: 500 }}>CHATROOM</span>
              <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#001eff' }} />
            </div>
            <ChevronUp size={17} color={dim} style={{
              transform: chatOpen ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s',
            }} />
          </div>
          {chatOpen && <ChatPanel />}
        </div>
      </div>

      <DelegationModal open={delegationModalOpen} onClose={() => setDelegationModalOpen(false)} onDelegationChange={() => delegation.checkApproval()} />
      <V3Prompt open={promptOpen} onClose={() => setPromptOpen(false)} {...promptMsg} />
    </>
  );
}
