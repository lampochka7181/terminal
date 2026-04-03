import { useState, useRef, useEffect } from 'react';
import { Gift, Key, LogOut, Copy, Check, Bot } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useSessionKey, SESSION_DURATIONS } from '@/hooks/useSessionKey';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import V3Modal from './V3Modal';
import AgentLeaderboard from './AgentLeaderboard';
import { walletAvatar } from '@/lib/utils';

const dim = 'rgba(238,238,238,0.33)';

function shortenAddress(address: string) {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

interface HeaderProps {
  onHowItWorks?: () => void;
}

export default function Header({ onHowItWorks }: HeaderProps) {
  const { wallet, isAuthenticated, isAuthenticating, signIn, signOut } = useAuth();
  const { setVisible } = useWalletModal();
  const sessionKey = useSessionKey();
  const [sessionModalOpen, setSessionModalOpen] = useState(false);
  const [sessionDuration, setSessionDuration] = useState(SESSION_DURATIONS.MEDIUM);
  const [rememberSession, setRememberSession] = useState(true);
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [addressCopied, setAddressCopied] = useState(false);
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const walletMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!walletMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (walletMenuRef.current && !walletMenuRef.current.contains(e.target as Node)) {
        setWalletMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [walletMenuOpen]);

  // Auto sign-in when wallet connects but user isn't authenticated
  useEffect(() => {
    if (wallet.connected && !isAuthenticated && !isAuthenticating) {
      signIn().catch(() => {});
    }
  }, [wallet.connected, isAuthenticated, isAuthenticating, signIn]);

  const handleConnectClick = () => {
    if (wallet.connected && !isAuthenticated) {
      signIn().catch(() => {});
    } else {
      setVisible(true);
    }
  };

  const handleCopyAddress = () => {
    if (!wallet.publicKey) return;
    navigator.clipboard.writeText(wallet.publicKey);
    setAddressCopied(true);
    setTimeout(() => setAddressCopied(false), 1500);
  };

  const handleSessionCreate = async () => {
    const ok = await sessionKey.createSession(sessionDuration, rememberSession);
    if (ok) setSessionModalOpen(false);
  };

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  return (
    <>
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        height: 51, minHeight: 51, padding: '0 18px',
        background: '#191919',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="24" height="44" viewBox="0 0 24 44" fill="none">
            <path d="M13 2L4 14h7l-2 8 11-12h-7l2-8z" fill="#eee" />
          </svg>
          <span style={{ fontSize: 24, fontWeight: 400, color: '#eee' }}>flip</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={onHowItWorks}
            style={{
              fontSize: 16, fontWeight: 500, color: dim,
              background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.11)',
              borderRadius: 8, padding: '6px 14px', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            How it Works
          </button>
          <button
            onClick={() => setLeaderboardOpen(true)}
            style={{
              fontSize: 16, fontWeight: 500, color: dim,
              background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.11)',
              borderRadius: 8, padding: '6px 14px', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <Bot size={16} />
            Agents
          </button>
          <button style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 15px',
            borderRadius: 8, background: '#ffdd78', border: 'none',
            color: '#191919', fontSize: 16, fontWeight: 500, cursor: 'pointer',
          }}>
            <Gift size={16} />
            REWARDS
          </button>

          {isAuthenticated && (
            <button
              onClick={() => setSessionModalOpen(true)}
              style={{
                padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
                background: sessionKey.isActive ? 'rgba(0,30,255,0.15)' : '#232323',
                color: sessionKey.isActive ? '#6b8aff' : dim,
                display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 500,
              }}
            >
              <Key size={15} />
              {sessionKey.isActive ? formatTime(sessionKey.getTimeRemaining()) : '1-Click Trade'}
            </button>
          )}

          {isAuthenticated && wallet.publicKey ? (
            <div ref={walletMenuRef} style={{ position: 'relative' }}>
              <div
                onClick={() => setWalletMenuOpen(v => !v)}
                style={{
                  height: 36, borderRadius: 8, background: '#001eff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', padding: '0 14px', gap: 8,
                  userSelect: 'none',
                }}
              >
                <div style={{
                  width: 23, height: 23, borderRadius: '50%', background: 'rgba(255,255,255,0.2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12,
                }}>
                  {walletAvatar(wallet.publicKey)}
                </div>
                <span style={{ fontSize: 14, fontWeight: 500, color: '#fff' }}>
                  {shortenAddress(wallet.publicKey)}
                </span>
              </div>

              {walletMenuOpen && (
                <div style={{
                  position: 'absolute', top: 42, right: 0, minWidth: 180,
                  background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 10, padding: 4, zIndex: 100,
                  boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
                }}>
                  <div
                    onClick={handleCopyAddress}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '10px 12px', borderRadius: 7, cursor: 'pointer',
                      color: addressCopied ? '#95ff94' : '#eee', fontSize: 14, fontWeight: 500,
                      transition: 'background 0.12s',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    {addressCopied ? <Check size={15} /> : <Copy size={15} />}
                    {addressCopied ? 'Copied!' : 'Copy Address'}
                  </div>
                  <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '2px 8px' }} />
                  <div
                    onClick={() => { setWalletMenuOpen(false); signOut(); }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '10px 12px', borderRadius: 7, cursor: 'pointer',
                      color: '#f55252', fontSize: 14, fontWeight: 500,
                      transition: 'background 0.12s',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(245,82,82,0.08)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <LogOut size={15} />
                    Log Out
                  </div>
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={handleConnectClick}
              disabled={isAuthenticating}
              style={{
                height: 36, borderRadius: 8, background: '#001eff',
                border: 'none', color: '#fff', fontSize: 15, fontWeight: 500,
                cursor: isAuthenticating ? 'wait' : 'pointer',
                padding: '0 18px', display: 'flex', alignItems: 'center', gap: 8,
                opacity: isAuthenticating ? 0.7 : 1,
              }}
            >
              {isAuthenticating ? 'Signing in...' : 'Connect Wallet'}
            </button>
          )}
        </div>
      </header>

      {/* Session Key Modal */}
      <V3Modal open={sessionModalOpen} onClose={() => setSessionModalOpen(false)} title="Trading Session">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* Status */}
          <div style={{
            padding: '18px 24px', borderRadius: 12, background: '#232323',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span style={{ fontSize: 18, color: 'rgba(238,238,238,0.66)' }}>Status</span>
            <span style={{
              fontSize: 18, fontWeight: 600,
              color: sessionKey.isActive ? '#95ff94' : '#f55252',
            }}>
              {sessionKey.isActive ? 'Active' : 'Inactive'}
            </span>
          </div>

          {sessionKey.isActive && sessionKey.expiresAt && (
            <div style={{
              padding: '18px 24px', borderRadius: 12, background: '#232323',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span style={{ fontSize: 18, color: 'rgba(238,238,238,0.66)' }}>Expires</span>
              <span style={{ fontSize: 18, fontWeight: 500, color: '#eee' }}>
                {new Date(sessionKey.expiresAt * 1000).toLocaleTimeString()}
              </span>
            </div>
          )}

          {!sessionKey.isActive && (
            <>
              <div>
                <span style={{ fontSize: 16, color: 'rgba(238,238,238,0.55)', display: 'block', marginBottom: 12 }}>
                  Duration
                </span>
                <div style={{ display: 'flex', gap: 12 }}>
                  {([
                    { value: SESSION_DURATIONS.SHORT, label: '1h' },
                    { value: SESSION_DURATIONS.MEDIUM, label: '4h' },
                    { value: SESSION_DURATIONS.LONG, label: '24h' },
                  ]).map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => setSessionDuration(value)}
                      style={{
                        flex: 1, padding: '12px 0', borderRadius: 9, border: 'none',
                        background: sessionDuration === value ? '#001eff' : '#232323',
                        color: sessionDuration === value ? '#fff' : 'rgba(238,238,238,0.55)',
                        fontSize: 18, fontWeight: 600, cursor: 'pointer',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={rememberSession}
                  onChange={(e) => setRememberSession(e.target.checked)}
                  style={{ accentColor: '#001eff', width: 15, height: 15 }}
                />
                <span style={{ fontSize: 18, color: 'rgba(238,238,238,0.66)' }}>
                  Remember session (persist in browser)
                </span>
              </label>
            </>
          )}

          <p style={{ fontSize: 16, color: 'rgba(238,238,238,0.44)', margin: 0, lineHeight: 1.5 }}>
            Session keys allow one-click trading without wallet popups for each order.
            You sign once to authorize a temporary key.
          </p>

          {sessionKey.error && (
            <p style={{ fontSize: 18, color: '#f55252', margin: 0 }}>{sessionKey.error}</p>
          )}

          {sessionKey.isActive ? (
            <button
              onClick={sessionKey.revokeSession}
              style={{
                width: '100%', padding: '18px 0', borderRadius: 9, border: 'none',
                background: '#f55252', color: '#fff', fontSize: 20, fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Revoke Session
            </button>
          ) : (
            <button
              onClick={handleSessionCreate}
              disabled={sessionKey.isCreating}
              style={{
                width: '100%', padding: '18px 0', borderRadius: 9, border: 'none',
                background: '#001eff', color: '#fff', fontSize: 20, fontWeight: 600,
                cursor: sessionKey.isCreating ? 'wait' : 'pointer',
                opacity: sessionKey.isCreating ? 0.7 : 1,
              }}
            >
              {sessionKey.isCreating ? 'Authorizing...' : 'Enable Session Key'}
            </button>
          )}
        </div>
      </V3Modal>

      <AgentLeaderboard open={leaderboardOpen} onClose={() => setLeaderboardOpen(false)} />
    </>
  );
}
