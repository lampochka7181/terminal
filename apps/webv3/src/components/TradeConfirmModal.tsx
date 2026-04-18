import { useState, useEffect } from 'react';
import V3Modal from './V3Modal';
import { api } from '@/lib/api';
import type { FeeSchedule } from '@degen/types';

interface TradeConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  side: 'bid' | 'ask';
  outcome: 'yes' | 'no';
  amount: number;
  price: number;
  orderType: 'market' | 'limit';
  isPlacing: boolean;
}

const dim = 'rgba(238,238,238,0.33)';

export default function TradeConfirmModal({
  open, onClose, onConfirm, side, outcome, amount, price, orderType, isPlacing,
}: TradeConfirmModalProps) {
  const [fees, setFees] = useState<FeeSchedule | null>(null);

  useEffect(() => {
    if (!open) return;
    api.getFees().then(setFees).catch(() => {});
  }, [open]);

  const feeRate = fees
    ? (orderType === 'limit' ? fees.trading.makerFee : fees.trading.takerFee)
    : 0.02;
  const estimatedFee = amount * feeRate;
  const multiplier = price > 0 ? (1 / price).toFixed(2) : '--';
  const potentialPayout = price > 0 ? (amount / price).toFixed(2) : '--';
  const direction = outcome === 'yes' ? 'Above' : 'Below';

  return (
    <V3Modal open={open} onClose={onClose} title="Confirm Trade" width={570}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
        <div style={{
          padding: '15px 21px', borderRadius: 12,
          background: outcome === 'yes' ? 'rgba(149,255,148,0.08)' : 'rgba(245,82,82,0.08)',
          border: `1px solid ${outcome === 'yes' ? 'rgba(149,255,148,0.22)' : 'rgba(245,82,82,0.22)'}`,
        }}>
          <div style={{ fontSize: 27, fontWeight: 700, color: outcome === 'yes' ? '#95ff94' : '#f55252', marginBottom: 6 }}>
            {side === 'bid' ? 'BUY' : 'SELL'} {direction}
          </div>
          <div style={{ fontSize: 18, color: dim }}>
            {orderType === 'market' ? 'Market Order' : 'Limit Order'}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          <Row label="Amount" value={`$${amount.toFixed(2)}`} />
          <Row label="Price" value={`$${price.toFixed(4)}`} />
          <Row label="Multiplier" value={`${multiplier}x`} />
          <Row label="Est. Payout" value={`$${potentialPayout}`} />
          <div style={{ height: 1, background: 'rgba(255,255,255,0.11)', margin: '3px 0' }} />
          <Row label={`Fee (${(feeRate * 100).toFixed(1)}%)`} value={`$${estimatedFee.toFixed(2)}`} />
          <Row label="Total Cost" value={`$${(amount + estimatedFee).toFixed(2)}`} bold />
        </div>

        <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
          <button onClick={onClose} style={{
            flex: 1, padding: '15px 0', borderRadius: 9,
            background: '#232323', border: '1px solid rgba(255,255,255,0.11)',
            color: '#eee', fontSize: 20, fontWeight: 600, cursor: 'pointer',
          }}>Cancel</button>
          <button
            onClick={onConfirm}
            disabled={isPlacing}
            style={{
              flex: 1, padding: '15px 0', borderRadius: 9, border: 'none',
              background: outcome === 'yes' ? '#95ff94' : '#f55252',
              color: outcome === 'yes' ? '#1e1e1e' : '#fff',
              fontSize: 20, fontWeight: 700, cursor: isPlacing ? 'wait' : 'pointer',
              opacity: isPlacing ? 0.7 : 1,
            }}>
            {isPlacing ? 'Placing...' : 'Confirm'}
          </button>
        </div>
      </div>
    </V3Modal>
  );
}

function Row({ label, value, bold, highlight }: { label: string; value: string; bold?: boolean; highlight?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 17, color: dim }}>{label}</span>
      <span style={{
        fontSize: 18, fontWeight: bold ? 700 : 500,
        color: highlight ? '#f7931a' : '#eee',
      }}>{value}</span>
    </div>
  );
}
