import { useState } from 'react';
import V3Modal from './V3Modal';
import { useDelegation } from '@/hooks/useDelegation';

interface Props {
  open: boolean;
  onClose: () => void;
  onDelegationChange?: () => void;
}

const PRESETS = [100, 500, 1_000, 5_000, 10_000];
const USDC_DECIMALS = 1_000_000;

export default function DelegationModal({ open, onClose, onDelegationChange }: Props) {
  const delegation = useDelegation();
  const [customAmount, setCustomAmount] = useState(5_000);

  const delegatedUsd = delegation.delegatedAmount / USDC_DECIMALS;

  const handleApprove = async () => {
    const ok = await delegation.approve(customAmount * USDC_DECIMALS);
    if (ok) {
      onDelegationChange?.();
      onClose();
    }
  };

  const handleRevoke = async () => {
    const ok = await delegation.revoke();
    if (ok) {
      onDelegationChange?.();
      onClose();
    }
  };

  return (
    <V3Modal open={open} onClose={onClose} title="Delegate USDC for Trading">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {delegation.isApproved && (
          <div style={{
            padding: '18px 24px', borderRadius: 12, background: '#232323',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span style={{ fontSize: 18, color: 'rgba(238,238,238,0.66)' }}>Current Delegation</span>
            <span style={{ fontSize: 21, fontWeight: 600, color: '#95ff94' }}>
              ${delegatedUsd.toLocaleString()}
            </span>
          </div>
        )}

        <div>
          <span style={{ fontSize: 17, color: 'rgba(238,238,238,0.55)', display: 'block', marginBottom: 12 }}>
            Select Amount
          </span>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {PRESETS.map((amt) => (
              <button
                key={amt}
                onClick={() => setCustomAmount(amt)}
                style={{
                  padding: '12px 21px', borderRadius: 9, border: 'none',
                  background: customAmount === amt ? '#001eff' : '#232323',
                  color: customAmount === amt ? '#fff' : 'rgba(238,238,238,0.55)',
                  fontSize: 18, fontWeight: 600, cursor: 'pointer',
                }}
              >
                ${amt.toLocaleString()}
              </button>
            ))}
          </div>
        </div>

        <div>
          <span style={{ fontSize: 17, color: 'rgba(238,238,238,0.55)', display: 'block', marginBottom: 12 }}>
            Custom Amount
          </span>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px',
            borderRadius: 9, border: '1px solid rgba(255,255,255,0.11)',
            background: '#232323', height: 60,
          }}>
            <span style={{ fontSize: 21, color: 'rgba(238,238,238,0.44)' }}>$</span>
            <input
              type="number"
              value={customAmount}
              onChange={(e) => setCustomAmount(Number(e.target.value))}
              style={{
                flex: 1, border: 'none', background: 'transparent', outline: 'none',
                color: '#eee', fontSize: 21, fontWeight: 500, fontFamily: 'inherit',
              }}
            />
            <span style={{ fontSize: 17, color: 'rgba(238,238,238,0.44)' }}>USDC</span>
          </div>
        </div>

        <p style={{ fontSize: 17, color: 'rgba(238,238,238,0.44)', margin: 0, lineHeight: 1.5 }}>
          Delegation allows the platform to execute trades on your behalf without requiring
          a wallet signature for each order. Your USDC stays in your wallet.
        </p>

        {delegation.error && (
          <p style={{ fontSize: 18, color: '#f55252', margin: 0 }}>{delegation.error}</p>
        )}

        <div style={{ display: 'flex', gap: 15 }}>
          <button
            onClick={handleApprove}
            disabled={delegation.isApproving || customAmount <= 0}
            style={{
              flex: 1, padding: '18px 0', borderRadius: 9, border: 'none',
              background: '#95ff94', color: '#191919', fontSize: 20, fontWeight: 600,
              cursor: delegation.isApproving ? 'wait' : 'pointer',
              opacity: delegation.isApproving ? 0.7 : 1,
            }}
          >
            {delegation.isApproving ? 'Approving...' : 'Approve Delegation'}
          </button>
          {delegation.isApproved && (
            <button
              onClick={handleRevoke}
              disabled={delegation.isApproving}
              style={{
                padding: '18px 30px', borderRadius: 9, border: 'none',
                background: '#f55252', color: '#fff', fontSize: 20, fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Revoke
            </button>
          )}
        </div>
      </div>
    </V3Modal>
  );
}
