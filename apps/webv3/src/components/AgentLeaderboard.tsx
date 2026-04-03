import { useState, useEffect } from 'react';
import { Trophy, TrendingUp, TrendingDown, BarChart3, RefreshCw } from 'lucide-react';
import V3Modal from './V3Modal';
import { getAgentLeaderboard, type AgentLeaderboardEntry } from '@/lib/api';
import { walletAvatar } from '@/lib/utils';

const dim = 'rgba(238,238,238,0.33)';
const muted = 'rgba(238,238,238,0.55)';

function formatUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

function shortenWallet(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

type SortKey = 'lifetimePnl' | 'volume' | 'trades' | 'winRate';

interface AgentLeaderboardProps {
  open: boolean;
  onClose: () => void;
}

export default function AgentLeaderboard({ open, onClose }: AgentLeaderboardProps) {
  const [agents, setAgents] = useState<AgentLeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('lifetimePnl');
  const [updatedAt, setUpdatedAt] = useState(0);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getAgentLeaderboard();
      setAgents(data.agents);
      setUpdatedAt(data.updatedAt);
    } catch (err: any) {
      setError(err.message || 'Failed to load leaderboard');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) fetchData();
  }, [open]);

  const sorted = [...agents].sort((a, b) => {
    if (sortKey === 'lifetimePnl') return b.lifetimePnl - a.lifetimePnl;
    if (sortKey === 'volume') return b.volume - a.volume;
    if (sortKey === 'trades') return b.trades - a.trades;
    return b.winRate - a.winRate;
  });

  const sortTabs: { key: SortKey; label: string }[] = [
    { key: 'lifetimePnl', label: 'PnL' },
    { key: 'volume', label: 'Volume' },
    { key: 'trades', label: 'Trades' },
    { key: 'winRate', label: 'Win Rate' },
  ];

  return (
    <V3Modal open={open} onClose={onClose} title="Agent Leaderboard" width={720}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Sort tabs + refresh */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {sortTabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setSortKey(tab.key)}
                style={{
                  padding: '6px 14px', borderRadius: 7, border: 'none', cursor: 'pointer',
                  fontSize: 13, fontWeight: 600,
                  background: sortKey === tab.key ? '#001eff' : '#232323',
                  color: sortKey === tab.key ? '#fff' : muted,
                  transition: 'all 0.15s',
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <button
            onClick={fetchData}
            disabled={loading}
            style={{
              width: 32, height: 32, borderRadius: 7, border: 'none', cursor: 'pointer',
              background: '#232323', color: muted,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} />
          </button>
        </div>

        {/* Loading state */}
        {loading && agents.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 0', color: muted, fontSize: 15 }}>
            Loading agents...
          </div>
        )}

        {/* Error state */}
        {error && (
          <div style={{
            padding: '14px 18px', borderRadius: 10, background: 'rgba(245,82,82,0.1)',
            color: '#f55252', fontSize: 14,
          }}>
            {error}
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && agents.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <BarChart3 size={36} style={{ color: muted, marginBottom: 12 }} />
            <p style={{ color: muted, fontSize: 15, margin: 0 }}>
              No agents on the leaderboard yet.
            </p>
          </div>
        )}

        {/* Leaderboard table */}
        {sorted.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {/* Header row */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '40px 1fr 100px 70px 80px 80px',
              padding: '8px 12px', gap: 8,
              color: dim, fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
              letterSpacing: '0.05em',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
            }}>
              <span>#</span>
              <span>Agent</span>
              <span style={{ textAlign: 'right' }}>Lifetime PnL</span>
              <span style={{ textAlign: 'right' }}>Trades</span>
              <span style={{ textAlign: 'right' }}>Volume</span>
              <span style={{ textAlign: 'right' }}>Win Rate</span>
            </div>

            {sorted.map((agent, idx) => {
              const isPositive = agent.lifetimePnl >= 0;
              const isTop3 = idx < 3;
              const rankColors = ['#FFD700', '#C0C0C0', '#CD7F32'];

              return (
                <div
                  key={agent.wallet}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '40px 1fr 100px 70px 80px 80px',
                    padding: '12px 12px', gap: 8,
                    alignItems: 'center',
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    transition: 'background 0.12s',
                    borderRadius: 8,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  {/* Rank */}
                  <span style={{
                    fontSize: 14, fontWeight: 700,
                    color: isTop3 ? rankColors[idx] : muted,
                    display: 'flex', alignItems: 'center', gap: 4,
                  }}>
                    {isTop3 && <Trophy size={12} />}
                    {idx + 1}
                  </span>

                  {/* Agent name + wallet */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, overflow: 'hidden' }}>
                    <div style={{
                      width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
                      background: 'rgba(0,30,255,0.15)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 14,
                    }}>
                      {walletAvatar(agent.wallet)}
                    </div>
                    <div style={{ overflow: 'hidden' }}>
                      <div style={{
                        fontSize: 14, fontWeight: 600, color: '#eee',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>
                        {agent.name}
                      </div>
                      <div style={{ fontSize: 11, color: dim, fontFamily: 'monospace' }}>
                        {shortenWallet(agent.wallet)}
                      </div>
                    </div>
                  </div>

                  {/* PnL */}
                  <div style={{
                    textAlign: 'right', fontSize: 14, fontWeight: 600,
                    color: isPositive ? '#95ff94' : '#f55252',
                    display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4,
                  }}>
                    {isPositive
                      ? <TrendingUp size={12} />
                      : <TrendingDown size={12} />
                    }
                    {isPositive ? '+' : ''}{formatUsd(agent.lifetimePnl)}
                  </div>

                  {/* Trades */}
                  <span style={{ textAlign: 'right', fontSize: 13, color: '#eee', fontWeight: 500 }}>
                    {agent.trades.toLocaleString()}
                  </span>

                  {/* Volume */}
                  <span style={{ textAlign: 'right', fontSize: 13, color: '#eee', fontWeight: 500 }}>
                    {formatUsd(agent.volume)}
                  </span>

                  {/* Win Rate */}
                  <span style={{
                    textAlign: 'right', fontSize: 13, fontWeight: 600,
                    color: agent.winRate >= 50 ? '#95ff94' : agent.winRate > 0 ? '#ffdd78' : muted,
                  }}>
                    {agent.winRate}%
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Footer */}
        {updatedAt > 0 && (
          <div style={{ textAlign: 'center', fontSize: 11, color: dim, paddingTop: 4 }}>
            Updated {new Date(updatedAt).toLocaleTimeString()}
          </div>
        )}
      </div>

      {/* spin animation for refresh icon */}
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </V3Modal>
  );
}
