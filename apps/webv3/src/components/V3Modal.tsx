import { type ReactNode, useEffect } from 'react';

interface V3ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  width?: number;
}

export default function V3Modal({ open, onClose, title, children, width = 630 }: V3ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width, maxWidth: '95vw', maxHeight: '85vh',
          background: '#1e1e1e', borderRadius: 17, overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
        }}
      >
        {title && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '21px 30px', borderBottom: '1px solid rgba(255,255,255,0.11)',
          }}>
            <span style={{ fontSize: 21, fontWeight: 600, color: '#eee' }}>{title}</span>
            <button
              onClick={onClose}
              style={{
                width: 42, height: 42, borderRadius: 8, border: 'none',
                background: '#232323', color: 'rgba(238,238,238,0.55)',
                cursor: 'pointer', fontSize: 24, display: 'flex',
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              ×
            </button>
          </div>
        )}
        <div style={{ padding: '24px 30px', overflowY: 'auto', flex: 1 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

interface V3PromptProps {
  open: boolean;
  onClose: () => void;
  title: string;
  message: string;
  type?: 'info' | 'success' | 'error' | 'warning';
  actionLabel?: string;
  onAction?: () => void;
}

const TYPE_COLORS = {
  info: '#001eff',
  success: '#95ff94',
  error: '#f55252',
  warning: '#ffdd78',
};

export function V3Prompt({ open, onClose, title, message, type = 'info', actionLabel, onAction }: V3PromptProps) {
  if (!open) return null;

  return (
    <V3Modal open={open} onClose={onClose} width={570}>
      <div style={{ textAlign: 'center', padding: '12px 0' }}>
        <div style={{
          width: 72, height: 72, borderRadius: '50%', margin: '0 auto 24px',
          background: `${TYPE_COLORS[type]}22`, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            width: 18, height: 18, borderRadius: '50%',
            background: TYPE_COLORS[type],
          }} />
        </div>
        <h3 style={{ fontSize: 24, fontWeight: 600, color: '#eee', margin: '0 0 12px' }}>{title}</h3>
        <p style={{ fontSize: 20, color: 'rgba(238,238,238,0.66)', margin: '0 0 30px', lineHeight: 1.5 }}>{message}</p>
        <div style={{ display: 'flex', gap: 15 }}>
          {actionLabel && onAction && (
            <button
              onClick={() => { onAction(); onClose(); }}
              style={{
                flex: 1, padding: '15px 0', borderRadius: 9, border: 'none',
                background: TYPE_COLORS[type], color: type === 'warning' ? '#191919' : '#fff',
                fontSize: 20, fontWeight: 600, cursor: 'pointer',
              }}
            >
              {actionLabel}
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              flex: 1, padding: '15px 0', borderRadius: 9,
              border: '1px solid rgba(255,255,255,0.11)', background: '#232323',
              color: '#eee', fontSize: 20, fontWeight: 500, cursor: 'pointer',
            }}
          >
            {actionLabel ? 'Cancel' : 'OK'}
          </button>
        </div>
      </div>
    </V3Modal>
  );
}
