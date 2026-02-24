import { useState } from 'react';
import { Gift, Settings, Key } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useSessionKey, SESSION_DURATIONS } from '@/hooks/useSessionKey';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import V3Modal from './V3Modal';
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

  const handleConnectClick = () => {
    if (wallet.connected && !isAuthenticated) {
      signIn().catch(() => {});
    } else {
      setVisible(true);
    }
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
        height: 96, minHeight: 96, padding: '0 40px',
        background: '#191919',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <svg width="44" height="80" viewBox="0 0 24 44" fill="none">
            <path d="M13 2L4 14h7l-2 8 11-12h-7l2-8z" fill="#eee" />
          </svg>
          <span style={{ fontSize: 44, fontWeight: 400, color: '#eee' }}>flip</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <button
            onClick={onHowItWorks}
            style={{
              fontSize: 32, fontWeight: 500, color: dim,
              background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.11)',
              borderRadius: 12, padding: '12px 24px', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 12,
            }}
          >
            How it Works
          </button>
          <button style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '12px 28px',
            borderRadius: 12, background: '#ffdd78', border: 'none',
            color: '#191919', fontSize: 32, fontWeight: 500, cursor: 'pointer',
          }}>
            <Gift size={32} />
            REWARDS
          </button>

          {isAuthenticated && (
            <button
              onClick={() => setSessionModalOpen(true)}
              style={{
                padding: '12px 20px', borderRadius: 12, border: 'none', cursor: 'pointer',
                background: sessionKey.isActive ? 'rgba(0,30,255,0.15)' : '#232323',
                color: sessionKey.isActive ? '#6b8aff' : dim,
                display: 'flex', alignItems: 'center', gap: 10, fontSize: 24, fontWeight: 500,
              }}
            >
              <Key size={28} />
              {sessionKey.isActive ? formatTime(sessionKey.getTimeRemaining()) : 'Session'}
            </button>
          )}

          <button style={{
            padding: 16, borderRadius: 12, background: 'transparent',
            border: 'none', color: dim, cursor: 'pointer',
          }}>
            <Settings size={36} />
          </button>

          {isAuthenticated && wallet.publicKey ? (
            <div
              onClick={signOut}
              style={{
                height: 68, borderRadius: 12, background: '#001eff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', padding: '0 24px', gap: 12,
              }}
            >
              <div style={{
                width: 40, height: 40, borderRadius: '50%', background: 'rgba(255,255,255,0.2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 22,
              }}>
                {walletAvatar(wallet.publicKey)}
              </div>
              <span style={{ fontSize: 24, fontWeight: 500, color: '#fff' }}>
                {shortenAddress(wallet.publicKey)}
              </span>
            </div>
          ) : (
            <button
              onClick={handleConnectClick}
              disabled={isAuthenticating}
              style={{
                height: 68, borderRadius: 12, background: '#001eff',
                border: 'none', color: '#fff', fontSize: 26, fontWeight: 500,
                cursor: isAuthenticating ? 'wait' : 'pointer',
                padding: '0 32px', display: 'flex', alignItems: 'center', gap: 12,
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
          {/* Status */}
          <div style={{
            padding: '24px 32px', borderRadius: 16, background: '#232323',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span style={{ fontSize: 24, color: 'rgba(238,238,238,0.66)' }}>Status</span>
            <span style={{
              fontSize: 24, fontWeight: 600,
              color: sessionKey.isActive ? '#95ff94' : '#f55252',
            }}>
              {sessionKey.isActive ? 'Active' : 'Inactive'}
            </span>
          </div>

          {sessionKey.isActive && sessionKey.expiresAt && (
            <div style={{
              padding: '24px 32px', borderRadius: 16, background: '#232323',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span style={{ fontSize: 24, color: 'rgba(238,238,238,0.66)' }}>Expires</span>
              <span style={{ fontSize: 24, fontWeight: 500, color: '#eee' }}>
                {new Date(sessionKey.expiresAt * 1000).toLocaleTimeString()}
              </span>
            </div>
          )}

          {!sessionKey.isActive && (
            <>
              <div>
                <span style={{ fontSize: 22, color: 'rgba(238,238,238,0.55)', display: 'block', marginBottom: 16 }}>
                  Duration
                </span>
                <div style={{ display: 'flex', gap: 16 }}>
                  {([
                    { value: SESSION_DURATIONS.SHORT, label: '1h' },
                    { value: SESSION_DURATIONS.MEDIUM, label: '4h' },
                    { value: SESSION_DURATIONS.LONG, label: '24h' },
                  ]).map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => setSessionDuration(value)}
                      style={{
                        flex: 1, padding: '16px 0', borderRadius: 12, border: 'none',
                        background: sessionDuration === value ? '#001eff' : '#232323',
                        color: sessionDuration === value ? '#fff' : 'rgba(238,238,238,0.55)',
                        fontSize: 24, fontWeight: 600, cursor: 'pointer',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: 16, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={rememberSession}
                  onChange={(e) => setRememberSession(e.target.checked)}
                  style={{ accentColor: '#001eff', width: 20, height: 20 }}
                />
                <span style={{ fontSize: 24, color: 'rgba(238,238,238,0.66)' }}>
                  Remember session (persist in browser)
                </span>
              </label>
            </>
          )}

          <p style={{ fontSize: 22, color: 'rgba(238,238,238,0.44)', margin: 0, lineHeight: 1.5 }}>
            Session keys allow one-click trading without wallet popups for each order.
            You sign once to authorize a temporary key.
          </p>

          {sessionKey.error && (
            <p style={{ fontSize: 24, color: '#f55252', margin: 0 }}>{sessionKey.error}</p>
          )}

          {sessionKey.isActive ? (
            <button
              onClick={sessionKey.revokeSession}
              style={{
                width: '100%', padding: '24px 0', borderRadius: 12, border: 'none',
                background: '#f55252', color: '#fff', fontSize: 26, fontWeight: 600,
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
                width: '100%', padding: '24px 0', borderRadius: 12, border: 'none',
                background: '#001eff', color: '#fff', fontSize: 26, fontWeight: 600,
                cursor: sessionKey.isCreating ? 'wait' : 'pointer',
                opacity: sessionKey.isCreating ? 0.7 : 1,
              }}
            >
              {sessionKey.isCreating ? 'Authorizing...' : 'Enable Session Key'}
            </button>
          )}
        </div>
      </V3Modal>
    </>
  );
}
