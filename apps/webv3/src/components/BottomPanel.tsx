import { useState, useCallback, useEffect, useRef } from 'react';
import { useUser } from '@/hooks/useUser';
import { useOrder } from '@/hooks/useOrder';
import { useSessionKey } from '@/hooks/useSessionKey';
import { useAuth } from '@/hooks/useAuth';
import { usePriceStore } from '@/stores/priceStore';
import { useOrderbookStore } from '@/stores/orderbookStore';
import { useUserStore } from '@/stores/userStore';
import type { Position } from '@/lib/api';

const dim = 'rgba(238,238,238,0.33)';

export default function BottomPanel() {
  const [tab, setTab] = useState<'positions' | 'history'>('positions');
  const { isAuthenticated } = useAuth();
  const { positions, orders, transactions, positionsLoading, transactionsLoading } = useUser();
  const sessionKey = useSessionKey();
  const { placeOrder, isPlacing, cancelOrder, isCancelling } = useOrder(sessionKey.sessionSigner);
  const prices = usePriceStore(s => s.prices);
  const yesBook = useOrderbookStore(s => s.yes);
  const noBook = useOrderbookStore(s => s.no);
  const [closingMarket, setClosingMarket] = useState<string | null>(null);

  const handleClosePosition = useCallback(async (pos: Position) => {
    const shares = pos.yesShares > 0 ? pos.yesShares : pos.noShares;
    const outcome = pos.yesShares > 0 ? 'yes' : 'no';
    setClosingMarket(pos.marketAddress);
    try {
      await placeOrder({
        marketAddress: pos.marketAddress,
        side: 'ask',
        outcome: outcome as 'yes' | 'no',
        orderType: 'market',
        price: outcome === 'yes' ? 0.01 : 0.99,
        size: shares,
      });
    } finally {
      setClosingMarket(null);
    }
  }, [placeOrder]);

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
  const openOrders = orders.filter(o => o.status === 'open' || o.status === 'partial');
  const allItems = [...openPositions, ...openOrders];

  const totalExposure = openPositions.reduce((sum, p) => sum + (p.totalCost ?? Math.abs(p.yesShares + p.noShares) * p.avgEntryPrice), 0);

  const columns = ['OUTCOME', 'ASSET', 'SIZE', 'ENTRY', 'MARK', 'UNREAL.PNL', 'ACTION'];

  return (
    <div style={{ background: '#1e1e1e', borderRadius: 22, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 32px', height: 80 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 36 }}>
          <button onClick={() => setTab('positions')} style={{
            fontSize: 32, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer',
            color: tab === 'positions' ? '#eee' : dim,
          }}>Positions ({openPositions.length})</button>
          <button onClick={() => setTab('history')} style={{
            fontSize: 32, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer',
            color: tab === 'history' ? '#eee' : dim,
          }}>History</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 40, fontSize: 24 }}>
          <span style={{ color: dim }}>
            EXPOSURE <span style={{ fontSize: 32, color: '#eee', fontWeight: 500 }}>${totalExposure.toFixed(2)}</span>
          </span>
        </div>
      </div>

      <div style={{ height: 1, background: 'rgba(255,255,255,0.11)' }} />
      <div style={{ position: 'relative', marginTop: -1 }}>
        <div style={{ width: 244, height: 1, background: '#fff', marginLeft: tab === 'positions' ? 32 : 296 }} />
      </div>

      {tab === 'positions' ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', padding: '0 32px', height: 56 }}>
            {columns.map((col) => (
              <div key={col} style={{ flex: 1, fontSize: 24, color: dim, fontWeight: 400 }}>{col}</div>
            ))}
          </div>

          {!isAuthenticated ? (
            <div style={{ padding: '32px', textAlign: 'center', fontSize: 24, color: dim }}>
              Connect wallet to view positions
            </div>
          ) : openPositions.length === 0 && openOrders.length === 0 ? (
            <div style={{ padding: '32px', textAlign: 'center', fontSize: 24, color: dim }}>
              {positionsLoading ? 'Loading...' : 'No open positions'}
            </div>
          ) : (
            <div style={{ maxHeight: 400, overflowY: 'auto' }}>
              {openPositions.map((pos) => {
                const shares = pos.yesShares > 0 ? pos.yesShares : pos.noShares;
                const isYes = pos.yesShares > 0;
                const outcomeLabel = isYes ? 'Above' : 'Below';
                const bestAsk = isYes ? yesBook.bestAsk : noBook.bestAsk;
                const hasLiquidity = bestAsk > 0 && bestAsk < 1;
                const liveMark = hasLiquidity ? bestAsk : 0;
                const costBasis = pos.totalCost ?? (shares * pos.avgEntryPrice);
                const pnl = hasLiquidity ? (liveMark - pos.avgEntryPrice) * shares : -costBasis;
                const pnlColor = pnl >= 0 ? '#95ff94' : '#f55252';
                const roe = costBasis > 0 ? ((pnl / costBasis) * 100) : 0;
                const isClosing = closingMarket === pos.marketAddress;

                return (
                  <div key={pos.marketAddress} style={{ display: 'flex', alignItems: 'center', padding: '8px 32px', fontSize: 24 }}>
                    <div style={{ flex: 1, color: isYes ? '#95ff94' : '#f55252', fontWeight: 500 }}>{outcomeLabel}</div>
                    <div style={{ flex: 1, color: '#eee' }}>{pos.asset}</div>
                    <div style={{ flex: 1, color: '#eee' }}>{shares.toFixed(1)}</div>
                    <div style={{ flex: 1, color: '#eee' }}>${pos.avgEntryPrice.toFixed(4)}</div>
                    <div style={{ flex: 1, color: hasLiquidity ? (liveMark >= pos.avgEntryPrice ? '#95ff94' : '#f55252') : '#f55252' }}>
                      {hasLiquidity ? `$${liveMark.toFixed(4)}` : 'No Liq.'}
                    </div>
                    <div style={{ flex: 1, color: pnlColor, fontWeight: 500 }}>
                      {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} <span style={{ fontSize: 20, opacity: 0.8 }}>({roe >= 0 ? '+' : ''}{roe.toFixed(0)}%)</span>
                    </div>
                    <div style={{ flex: 1 }}>
                      <button
                        onClick={() => handleClosePosition(pos)}
                        disabled={isClosing || isPlacing}
                        style={{
                          fontSize: 20, padding: '4px 16px', borderRadius: 8, border: 'none',
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
              {openOrders.map((order) => (
                <div key={order.id} style={{ display: 'flex', alignItems: 'center', padding: '8px 32px', fontSize: 24 }}>
                  <div style={{ flex: 1, color: order.outcome === 'yes' ? '#95ff94' : '#f55252', fontWeight: 500 }}>
                    {order.outcome === 'yes' ? 'Above' : 'Below'} {order.side === 'bid' ? 'BUY' : 'SELL'}
                  </div>
                  <div style={{ flex: 1, color: '#eee' }}>{order.asset}</div>
                  <div style={{ flex: 1, color: '#eee' }}>{order.size.toFixed(1)}</div>
                  <div style={{ flex: 1, color: '#eee' }}>${order.price.toFixed(4)}</div>
                  <div style={{ flex: 1, color: dim }}>--</div>
                  <div style={{ flex: 1, color: dim }}>--</div>
                  <div style={{ flex: 1 }}>
                    <button
                      onClick={() => cancelOrder(order.id)}
                      disabled={isCancelling}
                      style={{
                        fontSize: 20, padding: '4px 16px', borderRadius: 8, border: 'none',
                        background: '#f55252', color: '#fff', cursor: 'pointer',
                        opacity: isCancelling ? 0.5 : 1,
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', padding: '0 32px', height: 56 }}>
            {['TYPE', 'ASSET', 'SIDE', 'PRICE', 'SIZE', 'PNL', 'TIME', 'TX'].map((col) => (
              <div key={col} style={{ flex: 1, fontSize: 24, color: dim, fontWeight: 400 }}>{col}</div>
            ))}
          </div>

          {!isAuthenticated ? (
            <div style={{ padding: '32px', textAlign: 'center', fontSize: 24, color: dim }}>
              Connect wallet to view history
            </div>
          ) : transactions.length === 0 ? (
            <div style={{ padding: '32px', textAlign: 'center', fontSize: 24, color: dim }}>
              {transactionsLoading ? 'Loading...' : 'No trade history'}
            </div>
          ) : (
            <div style={{ maxHeight: 400, overflowY: 'auto' }}>
              {transactions.slice(0, 20).map((tx) => {
                const pnlColor = (tx.pnl ?? 0) >= 0 ? '#95ff94' : '#f55252';
                return (
                  <div key={tx.id} style={{ display: 'flex', alignItems: 'center', padding: '8px 32px', fontSize: 24 }}>
                    <div style={{ flex: 1, color: '#eee' }}>{tx.type}</div>
                    <div style={{ flex: 1, color: '#eee' }}>{tx.asset}</div>
                    <div style={{ flex: 1, color: tx.side === 'buy' ? '#95ff94' : '#f55252' }}>{tx.side.toUpperCase()}</div>
                    <div style={{ flex: 1, color: '#eee' }}>${tx.price.toFixed(4)}</div>
                    <div style={{ flex: 1, color: '#eee' }}>{tx.size.toFixed(1)}</div>
                    <div style={{ flex: 1, color: pnlColor }}>{tx.pnl != null ? `${tx.pnl >= 0 ? '+' : ''}$${tx.pnl.toFixed(2)}` : '--'}</div>
                    <div style={{ flex: 1, color: dim }}>{new Date(tx.timestamp).toLocaleTimeString()}</div>
                    <div style={{ flex: 1 }}>
                      {tx.txSignature ? (
                        <a
                          href={`https://solscan.io/tx/${tx.txSignature}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: '#7B93FF', textDecoration: 'none', fontSize: 20 }}
                        >
                          {tx.txSignature.slice(0, 6)}...
                        </a>
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
    </div>
  );
}
