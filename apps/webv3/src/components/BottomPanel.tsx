import { useState, useCallback, useEffect, useRef } from 'react';
import { Share2, Copy } from 'lucide-react';
import { V3Prompt } from './V3Modal';
import { useUser } from '@/hooks/useUser';
import { useOrder } from '@/hooks/useOrder';
import { useSessionKey } from '@/hooks/useSessionKey';
import { useAuth } from '@/hooks/useAuth';
import { usePriceStore } from '@/stores/priceStore';
import { useOrderbookStore } from '@/stores/orderbookStore';
import { useUserStore } from '@/stores/userStore';
import { useMarketStore } from '@/stores/marketStore';
import type { Position, UserTransaction } from '@/lib/api';

const dim = 'rgba(238,238,238,0.33)';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function renderPnLCanvas(tx: UserTransaction): Promise<HTMLCanvasElement> {
  const w = 600, h = 340;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  const pnl = tx.pnl ?? 0;
  const isWin = pnl >= 0;
  const outcomeLabel = tx.outcome?.toLowerCase() === 'yes' ? 'ABOVE' : 'BELOW';
  const accentColor = isWin ? '#95ff94' : '#f55252';

  // Clip to rounded rect
  const r = 20;
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.arcTo(w, 0, w, h, r); ctx.arcTo(w, h, 0, h, r);
  ctx.arcTo(0, h, 0, 0, r); ctx.arcTo(0, 0, w, 0, r);
  ctx.closePath();
  ctx.clip();

  // Dark base fill
  ctx.fillStyle = '#0a0a0c';
  ctx.fillRect(0, 0, w, h);

  // Draw pepe background image
  try {
    const bgSrc = isWin ? '/pepe-win.png' : '/pepe-loss.jpg';
    const bgImg = await loadImage(bgSrc);
    const imgRatio = bgImg.width / bgImg.height;
    const canvasRatio = w / h;
    let sw = bgImg.width, sh = bgImg.height, sx = 0, sy = 0;
    if (imgRatio > canvasRatio) {
      sw = bgImg.height * canvasRatio;
      sx = (bgImg.width - sw) / 2;
    } else {
      sh = bgImg.width / canvasRatio;
      sy = (bgImg.height - sh) / 2;
    }
    ctx.drawImage(bgImg, sx, sy, sw, sh, 0, 0, w, h);
  } catch {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#111113');
    grad.addColorStop(1, '#1a1a22');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }

  // Dark overlay for text readability
  const overlayGrad = ctx.createLinearGradient(0, 0, 0, h);
  overlayGrad.addColorStop(0, 'rgba(8,8,10,0.75)');
  overlayGrad.addColorStop(0.35, 'rgba(8,8,10,0.45)');
  overlayGrad.addColorStop(0.65, 'rgba(8,8,10,0.45)');
  overlayGrad.addColorStop(1, 'rgba(8,8,10,0.8)');
  ctx.fillStyle = overlayGrad;
  ctx.fillRect(0, 0, w, h);

  // Accent tint
  ctx.fillStyle = accentColor;
  ctx.globalAlpha = 0.05;
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1;

  // Accent border
  ctx.strokeStyle = isWin ? 'rgba(149,255,148,0.25)' : 'rgba(245,82,82,0.25)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.arcTo(w, 0, w, h, r); ctx.arcTo(w, h, 0, h, r);
  ctx.arcTo(0, h, 0, 0, r); ctx.arcTo(0, 0, w, 0, r);
  ctx.closePath();
  ctx.stroke();

  // --- Content ---
  ctx.fillStyle = '#eee';
  ctx.font = 'bold 18px system-ui, -apple-system, sans-serif';
  ctx.fillText('DEGEN TERMINAL', 32, 42);

  ctx.fillStyle = 'rgba(238,238,238,0.4)';
  ctx.font = '14px system-ui, sans-serif';
  ctx.fillText('0DTE Binary Options', 32, 64);

  ctx.fillStyle = accentColor;
  ctx.font = 'bold 14px system-ui, sans-serif';
  const badge = isWin ? 'WIN' : 'LOSS';
  const badgeW = ctx.measureText(badge).width + 20;
  const bx = w - 32 - badgeW;
  ctx.globalAlpha = 0.2;
  ctx.beginPath();
  ctx.roundRect(bx, 28, badgeW, 26, 6);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillText(badge, bx + 10, 46);

  ctx.fillStyle = '#eee';
  ctx.font = 'bold 48px system-ui, sans-serif';
  const pnlStr = `${isWin ? '+' : ''}$${pnl.toFixed(2)}`;
  ctx.fillText(pnlStr, 32, 130);

  ctx.fillStyle = 'rgba(238,238,238,0.5)';
  ctx.font = '16px system-ui, sans-serif';
  ctx.fillText('PnL', 32, 155);

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(24, 175, w - 48, 1);

  const labels = ['Asset', 'Prediction', 'Side', 'Entry', 'Size'];
  const side = tx.side === 'settlement' ? 'SETTLED' : tx.side.toUpperCase();
  const values = [tx.asset, outcomeLabel, side, `$${tx.price.toFixed(4)}`, tx.size.toFixed(1)];
  const colW = (w - 64) / labels.length;

  ctx.font = '13px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(238,238,238,0.4)';
  labels.forEach((l, i) => ctx.fillText(l, 32 + i * colW, 208));

  ctx.font = 'bold 16px system-ui, sans-serif';
  ctx.fillStyle = '#eee';
  values.forEach((v, i) => {
    if (i === 1) ctx.fillStyle = tx.outcome?.toLowerCase() === 'yes' ? '#95ff94' : '#f55252';
    else ctx.fillStyle = '#eee';
    ctx.fillText(v, 32 + i * colW, 232);
  });

  ctx.fillStyle = 'rgba(238,238,238,0.25)';
  ctx.font = '13px system-ui, sans-serif';
  const ts = new Date(tx.timestamp).toLocaleString();
  ctx.fillText(ts, 32, h - 24);

  if (tx.txSignature) {
    const sig = `solscan.io/tx/${tx.txSignature.slice(0, 8)}...`;
    ctx.fillText(sig, w - 32 - ctx.measureText(sig).width, h - 24);
  }

  return canvas;
}

function PnLShareModal({ tx, onClose }: { tx: UserTransaction; onClose: () => void }) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    renderPnLCanvas(tx).then(canvas => {
      if (cancelled) return;
      canvasRef.current = canvas;
      setImgUrl(canvas.toDataURL('image/png'));
    });
    return () => { cancelled = true; canvasRef.current = null; };
  }, [tx]);

  const handleCopy = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'));
      if (!blob) return;
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const url = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = `pnl-${tx.asset}-${Date.now()}.png`;
      a.click();
    }
  }, [tx.asset]);

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        cursor: 'default', position: 'relative',
      }}>
        {imgUrl && (
          <img
            src={imgUrl} alt="PnL Card"
            onClick={handleCopy}
            style={{
              width: 500, borderRadius: 16, cursor: 'pointer',
              transition: 'transform 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.01)')}
            onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')}
          />
        )}
        <span style={{
          position: 'absolute', bottom: -28, left: '50%', transform: 'translateX(-50%)',
          fontSize: 12, color: copied ? '#95ff94' : 'rgba(238,238,238,0.35)',
          transition: 'color 0.2s', whiteSpace: 'nowrap',
        }}>
          {copied ? 'Copied to clipboard!' : 'Click image to copy'}
        </span>
      </div>
    </div>
  );
}

export default function BottomPanel() {
  const [tab, setTab] = useState<'positions' | 'history'>('positions');
  const [shareTx, setShareTx] = useState<UserTransaction | null>(null);
  const { isAuthenticated } = useAuth();
  const { positions, orders, transactions, positionsLoading, transactionsLoading, refetchTransactions } = useUser();

  // Auto-refresh transactions when switching to history tab
  const switchToHistory = useCallback(() => {
    setTab('history');
    if (isAuthenticated) refetchTransactions();
  }, [isAuthenticated, refetchTransactions]);
  const sessionKey = useSessionKey();
  const { placeOrder, isPlacing, cancelOrder, isCancelling } = useOrder(sessionKey.sessionSigner);
  const prices = usePriceStore(s => s.prices);
  const yesBook = useOrderbookStore(s => s.yes);
  const noBook = useOrderbookStore(s => s.no);
  const markets = useMarketStore(s => s.markets);
  const [closingMarket, setClosingMarket] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptMsg, setPromptMsg] = useState({ title: '', message: '', type: 'info' as 'info' | 'error' | 'success' | 'warning' });

  const showPrompt = useCallback((title: string, message: string, type: 'info' | 'error' | 'success' | 'warning' = 'info') => {
    setPromptMsg({ title, message, type });
    setPromptOpen(true);
  }, []);

  const handleClosePosition = useCallback(async (pos: Position, closeOutcome?: 'yes' | 'no') => {
    const outcome = closeOutcome ?? (pos.yesShares > 0 ? 'yes' : 'no');
    const shares = outcome === 'yes' ? pos.yesShares : pos.noShares;
    setClosingMarket(pos.marketAddress + '-' + outcome);
    try {
      const result = await placeOrder({
        marketAddress: pos.marketAddress,
        side: 'ask',
        outcome,
        orderType: 'market',
        price: 0.01, // Market sell floor — accept any price (NO effective price = 1 - yesAskPrice, so 0.01 allows yesAsk ≤ 0.99)
        size: shares,
      });
      if (result && result.filledSize === 0) {
        showPrompt('No Liquidity', 'No liquidity available to close your position. It will settle automatically at market expiry.', 'warning');
      }
    } finally {
      setClosingMarket(null);
    }
  }, [placeOrder, showPrompt]);

  // Listen for sell events from TradeBubbles overlay
  useEffect(() => {
    const handler = (e: Event) => {
      const { outcome, marketAddress } = (e as CustomEvent).detail;
      const pos = positions.find(p =>
        (p.marketAddress === marketAddress || p.market === marketAddress) && p.status === 'open'
      );
      if (pos) handleClosePosition(pos, outcome);
    };
    window.addEventListener('trade-bubble-sell', handler);
    return () => window.removeEventListener('trade-bubble-sell', handler);
  }, [positions, handleClosePosition]);

  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // When positions drop to 0 (market settled), poll for settlement data.
  // First attempt 3s after, then every 5s until we see a new settlement entry.
  const prevOpenCount = useRef(0);
  const settlementPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const txCountBeforeRef = useRef(0);
  useEffect(() => {
    const currentCount = positions.filter(p => {
      if (p.status !== 'open') return false;
      if ((p.yesShares + p.noShares) <= 0) return false;
      if (p.expiryAt > 0) {
        const ms = p.expiryAt < 1e12 ? p.expiryAt * 1000 : p.expiryAt;
        if (Date.now() > ms) return false;
      }
      return true;
    }).length;
    if (prevOpenCount.current > 0 && currentCount === 0) {
      txCountBeforeRef.current = useUserStore.getState().transactions.length;
      if (settlementPollRef.current) clearInterval(settlementPollRef.current);

      const poll = () => {
        const store = useUserStore.getState();
        store.fetchTransactions();
        store.fetchBalance();
        if (store.transactions.length > txCountBeforeRef.current) {
          if (settlementPollRef.current) clearInterval(settlementPollRef.current);
          settlementPollRef.current = null;
        }
      };

      setTimeout(() => {
        poll();
        settlementPollRef.current = setInterval(poll, 5000);
      }, 3000);
    }
    prevOpenCount.current = currentCount;
    return () => {
      if (settlementPollRef.current) clearInterval(settlementPollRef.current);
    };
  }, [positions]);

  const openPositions = positions.filter(p => {
    if (p.status !== 'open') return false;
    if ((p.yesShares + p.noShares) <= 0) return false;
    if (p.expiryAt > 0) {
      const ms = p.expiryAt < 1e12 ? p.expiryAt * 1000 : p.expiryAt;
      if (Date.now() > ms) return false;
    }
    return true;
  });
  const openOrders = orders.filter(o => {
    if (o.status !== 'open' && o.status !== 'partial') return false;
    // Don't show orders for expired markets (defense-in-depth)
    if (o.expiryAt > 0) {
      const ms = o.expiryAt < 1e12 ? o.expiryAt * 1000 : o.expiryAt;
      if (Date.now() > ms) return false;
    }
    return true;
  });
  const allItems = [...openPositions, ...openOrders];

  // Split positions with both YES and NO shares into separate display rows
  type PosEntry = { pos: typeof openPositions[0]; isYes: boolean; shares: number; costBasis: number; entryPrice: number };
  const posEntries: PosEntry[] = [];
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
      posEntries.push({ pos, isYes: true, shares: pos.yesShares, costBasis: yesCost, entryPrice: yesEntry });
      posEntries.push({ pos, isYes: false, shares: pos.noShares, costBasis: noCost, entryPrice: noEntry });
    } else if (hasYes) {
      const yesEntry = pos.avgEntryYes ?? pos.avgEntryPrice;
      posEntries.push({ pos, isYes: true, shares: pos.yesShares, costBasis: pos.totalCost ?? pos.yesShares * yesEntry, entryPrice: yesEntry });
    } else if (hasNo) {
      const noEntry = pos.avgEntryNo ?? pos.avgEntryPrice;
      posEntries.push({ pos, isYes: false, shares: pos.noShares, costBasis: pos.totalCost ?? pos.noShares * noEntry, entryPrice: noEntry });
    }
  }

  const orderExposure = openOrders.reduce((sum, o) => {
    const filledNotional = o.filledSize * o.price;
    return sum + (o.dollarAmount
      ? Math.max(0, o.dollarAmount - filledNotional)
      : (o.remainingSize > 0 ? o.remainingSize : o.size) * o.price);
  }, 0);
  const totalExposure = posEntries.reduce((sum, e) => sum + e.costBasis, 0) + orderExposure;

  const columns = ['OUTCOME', 'ASSET', 'SIZE', 'TOKENS', 'ENTRY', 'MARK', 'UNREAL.PNL', 'ACTION'];

  return (
    <div style={{ background: '#1e1e1e', borderRadius: 17, display: 'flex', flexDirection: 'column', minHeight: 240 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', height: 60 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 27 }}>
          <button onClick={() => setTab('positions')} style={{
            fontSize: 24, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer',
            color: tab === 'positions' ? '#eee' : dim,
          }}>Positions ({posEntries.length})</button>
          <button onClick={switchToHistory} style={{
            fontSize: 24, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer',
            color: tab === 'history' ? '#eee' : dim,
          }}>History</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 30, fontSize: 18 }}>
          <span style={{ color: dim }}>
            EXPOSURE <span style={{ fontSize: 24, color: '#eee', fontWeight: 500 }}>${totalExposure.toFixed(2)}</span>
          </span>
        </div>
      </div>

      <div style={{ height: 1, background: 'rgba(255,255,255,0.11)' }} />
      <div style={{ position: 'relative', marginTop: -1 }}>
        <div style={{ width: 183, height: 1, background: '#fff', marginLeft: tab === 'positions' ? 24 : 222 }} />
      </div>

      {tab === 'positions' ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', padding: '0 24px', height: 42 }}>
            {columns.map((col) => (
              <div key={col} style={{ flex: 1, fontSize: 18, color: dim, fontWeight: 400 }}>{col}</div>
            ))}
          </div>

          {!isAuthenticated ? (
            <div style={{ padding: '24px', textAlign: 'center', fontSize: 18, color: dim }}>
              Connect wallet to view positions
            </div>
          ) : posEntries.length === 0 && openOrders.length === 0 ? (
            <div style={{ padding: '24px', textAlign: 'center', fontSize: 18, color: dim }}>
              {positionsLoading ? 'Loading...' : 'No open positions'}
            </div>
          ) : (
            <div style={{ maxHeight: 360, overflowY: 'auto' }}>
              {posEntries.map((entry) => {
                const { pos, isYes, shares, costBasis, entryPrice } = entry;
                const outcomeLabel = isYes ? 'Above' : 'Below';
                const bestAsk = isYes ? yesBook.bestAsk : noBook.bestAsk;
                const hasLiquidity = bestAsk > 0 && bestAsk < 1;
                let liveMark = hasLiquidity ? bestAsk : 0;
                let hasFallback = false;
                if (!hasLiquidity) {
                  const assetPrice = prices[pos.asset as keyof typeof prices];
                  const mkt = markets.find(m => m.address === pos.marketAddress);
                  if (assetPrice && mkt?.strike && mkt.strike > 0) {
                    if (assetPrice > mkt.strike) {
                      liveMark = isYes ? 0.999 : 0.001;
                      hasFallback = true;
                    } else if (assetPrice < mkt.strike) {
                      liveMark = isYes ? 0.001 : 0.999;
                      hasFallback = true;
                    }
                  }
                }
                const pnl = (hasLiquidity || hasFallback) ? (liveMark * shares) - costBasis : -costBasis;
                const pnlColor = pnl >= 0 ? '#95ff94' : '#f55252';
                const roe = costBasis > 0 ? ((pnl / costBasis) * 100) : 0;
                const closingKey = pos.marketAddress + '-' + (isYes ? 'yes' : 'no');
                const isClosing = closingMarket === closingKey;

                return (
                  <div key={`${pos.marketAddress}-${isYes ? 'yes' : 'no'}`} style={{ display: 'flex', alignItems: 'center', padding: '6px 24px', fontSize: 18 }}>
                    <div style={{ flex: 1, color: isYes ? '#95ff94' : '#f55252', fontWeight: 500 }}>{outcomeLabel}</div>
                    <div style={{ flex: 1, color: '#eee' }}>{pos.asset}</div>
                    <div style={{ flex: 1, color: '#eee' }}>${costBasis.toFixed(2)}</div>
                    <div style={{ flex: 1, color: '#eee' }}>{shares.toFixed(1)}</div>
                    <div style={{ flex: 1, color: '#eee' }}>${entryPrice.toFixed(4)}</div>
                    <div style={{ flex: 1, color: (hasLiquidity || hasFallback) ? (liveMark >= entryPrice ? '#95ff94' : '#f55252') : '#f55252' }}>
                      {(hasLiquidity || hasFallback) ? `$${liveMark.toFixed(4)}` : 'No Liq.'}
                    </div>
                    <div style={{ flex: 1, color: pnlColor, fontWeight: 500 }}>
                      {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} <span style={{ fontSize: 15, opacity: 0.8 }}>({roe >= 0 ? '+' : ''}{roe.toFixed(0)}%)</span>
                    </div>
                    <div style={{ flex: 1 }}>
                      <button
                        onClick={() => handleClosePosition(pos, isYes ? 'yes' : 'no')}
                        disabled={isClosing || isPlacing}
                        style={{
                          fontSize: 15, padding: '3px 12px', borderRadius: 6, border: 'none',
                          background: '#f55252', color: '#fff', cursor: 'pointer',
                          opacity: isClosing || isPlacing ? 0.5 : 1,
                        }}
                      >
                        {isClosing ? 'Closing...' : 'Close'}
                      </button>
                    </div>
                  </div>
                );
              })}
              {openOrders.map((order) => {
                // For dollar-based market orders: remaining = dollarAmount - filledNotional
                // For limit orders: remaining = remainingSize * price
                const filledNotional = order.filledSize * order.price;
                const dollarValue = order.dollarAmount
                  ? Math.max(0, order.dollarAmount - filledNotional)
                  : (order.remainingSize > 0 ? order.remainingSize : order.size) * order.price;
                return (
                  <div key={order.id} style={{ display: 'flex', alignItems: 'center', padding: '6px 24px', fontSize: 18 }}>
                    <div style={{ flex: 1, color: order.outcome === 'yes' ? '#95ff94' : '#f55252', fontWeight: 500 }}>
                      {order.outcome === 'yes' ? 'Above' : 'Below'}
                    </div>
                    <div style={{ flex: 1, color: '#eee' }}>{order.asset}</div>
                    <div style={{ flex: 1, color: '#eee' }}>${dollarValue.toFixed(2)}</div>
                    <div style={{ flex: 1, color: dim }}>--</div>
                    <div style={{ flex: 1, color: dim }}>--</div>
                    <div style={{ flex: 1, color: dim }}>--</div>
                    <div style={{ flex: 1, color: dim }}>--</div>
                    <div style={{ flex: 1 }}>
                      <button
                        onClick={() => cancelOrder(order.id)}
                        disabled={isCancelling}
                        style={{
                          fontSize: 15, padding: '3px 12px', borderRadius: 6, border: 'none',
                          background: '#f55252', color: '#fff', cursor: 'pointer',
                          opacity: isCancelling ? 0.5 : 1,
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', padding: '0 24px', height: 42 }}>
            {['TYPE', 'ASSET', 'OUTCOME', 'SIDE', 'PRICE', 'SIZE', 'PNL', 'TIME', 'TX', 'SHARE'].map((col) => (
              <div key={col} style={{ flex: 1, fontSize: 18, color: dim, fontWeight: 400 }}>{col}</div>
            ))}
          </div>

          {!isAuthenticated ? (
            <div style={{ padding: '24px', textAlign: 'center', fontSize: 18, color: dim }}>
              Connect wallet to view history
            </div>
          ) : transactions.length === 0 ? (
            <div style={{ padding: '24px', textAlign: 'center', fontSize: 18, color: dim }}>
              {transactionsLoading ? 'Loading...' : 'No trade history'}
            </div>
          ) : (
            <div style={{ maxHeight: 158, overflowY: 'auto' }}>
              {transactions.slice(0, 20).map((tx) => {
                const pnlColor = (tx.pnl ?? 0) >= 0 ? '#95ff94' : '#f55252';
                return (
                  <div key={tx.id} style={{ display: 'flex', alignItems: 'center', padding: '6px 24px', fontSize: 18 }}>
                    <div style={{ flex: 1, color: '#eee' }}>{tx.type}</div>
                    <div style={{ flex: 1, color: '#eee' }}>{tx.asset}</div>
                    <div style={{ flex: 1, color: tx.outcome?.toLowerCase() === 'yes' ? '#95ff94' : '#f55252', fontWeight: 500 }}>
                      {tx.outcome?.toLowerCase() === 'yes' ? 'Above' : tx.outcome?.toLowerCase() === 'no' ? 'Below' : '--'}
                    </div>
                    <div style={{ flex: 1, color: tx.side === 'buy' ? '#95ff94' : '#f55252' }}>{tx.side.toUpperCase()}</div>
                    <div style={{ flex: 1, color: '#eee' }}>${tx.price.toFixed(4)}</div>
                    <div style={{ flex: 1, color: '#eee' }}>{tx.size.toFixed(1)}</div>
                    <div style={{ flex: 1, color: pnlColor }}>{tx.pnl != null ? `${tx.pnl >= 0 ? '+' : ''}$${tx.pnl.toFixed(2)}` : '--'}</div>
                    <div style={{ flex: 1, color: dim }}>{new Date(tx.timestamp).toLocaleTimeString()}</div>
                    <div style={{ flex: 1 }}>
                      {tx.txStatus === 'FAILED' ? (
                        <span style={{ color: '#f55252', fontWeight: 600, fontSize: 15 }} title={tx.errorCode || 'Unknown error'}>
                          Failed{tx.errorCode === 'INSUFFICIENT_FUNDS' ? ' (Low USDC)' : ''}
                        </span>
                      ) : tx.txSignature ? (
                        <a
                          href={`https://solscan.io/tx/${tx.txSignature}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: '#7B93FF', textDecoration: 'none', fontSize: 15 }}
                        >
                          {tx.txSignature.slice(0, 6)}...
                        </a>
                      ) : tx.txStatus === 'PENDING' ? (
                        <span style={{ color: '#FFB547', fontSize: 15 }}>Pending</span>
                      ) : (
                        <span style={{ color: dim }}>--</span>
                      )}
                    </div>
                    <div style={{ flex: 1 }}>
                      {(tx.side === 'sell' || tx.side === 'settlement') && tx.pnl != null ? (
                        <button
                          onClick={() => setShareTx(tx)}
                          style={{
                            background: 'none', border: '1px solid rgba(238,238,238,0.15)',
                            borderRadius: 6, padding: '3px 8px', cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: 5,
                            color: '#eee', fontSize: 14,
                          }}
                        >
                          <Share2 size={11} />
                          Share
                        </button>
                      ) : (
                        <span style={{ color: dim }}>--</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {shareTx && <PnLShareModal tx={shareTx} onClose={() => setShareTx(null)} />}
      <V3Prompt open={promptOpen} onClose={() => setPromptOpen(false)} {...promptMsg} />
    </div>
  );
}
