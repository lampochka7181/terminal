import { useState, useEffect, useRef, useCallback } from 'react';
import { Send } from 'lucide-react';
import { getWebSocket, type GlobalTradeUpdate } from '@/lib/websocket';
import { useAuthStore } from '@/stores/authStore';
import { supabase } from '@/lib/supabase';
import { walletAvatar } from '@/lib/utils';

const dim = 'rgba(238,238,238,0.33)';

interface ChatMessage {
  id: string;
  user: string;
  avatar: string;
  text?: string;
  isOwn?: boolean;
  isAction?: boolean;
  actionBold?: string;
  actionText?: string;
  timestamp: number;
}

function shortWallet(addr: string) {
  return addr.slice(0, 4);
}

function shortenAddr(addr: string) {
  if (addr.length > 12) return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
  return addr;
}

export default function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const { isAuthenticated, walletAddress } = useAuthStore();
  const sendingRef = useRef(false);

  const appendMessage = useCallback((msg: ChatMessage) => {
    setMessages(prev => [...prev.slice(-80), msg]);
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('chat_messages')
        .select('*')
        .order('created_at', { ascending: true })
        .limit(50);

      if (error) console.error('[Chat] fetch failed', error.message);
      if (cancelled || !data) return;

      const loaded: ChatMessage[] = data.map((row: any) => ({
        id: row.id,
        user: shortWallet(row.wallet_address),
        avatar: walletAvatar(row.wallet_address),
        text: row.message,
        isOwn: walletAddress ? row.wallet_address === walletAddress : false,
        timestamp: new Date(row.created_at).getTime(),
      }));

      setMessages(loaded);
    })();

    const channel = supabase
      .channel('chat_messages_realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_messages' },
        (payload) => {
          const row = payload.new as any;
          appendMessage({
            id: row.id,
            user: shortWallet(row.wallet_address),
            avatar: walletAvatar(row.wallet_address),
            text: row.message,
            isOwn: walletAddress ? row.wallet_address === walletAddress : false,
            timestamp: new Date(row.created_at).getTime(),
          });
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress]);

  useEffect(() => {
    const ws = getWebSocket();
    ws.subscribeGlobalTrades();

    const unsubscribe = ws.onMessage((msg) => {
      if ((msg as any).channel !== 'trades:global') return;
      const trade = msg as GlobalTradeUpdate;
      const d = trade.data;
      if (!d) return;

      const direction = d.outcome === 'yes' ? 'Up' : 'Down';
      const notional = d.notional > 0 ? `$${Math.round(d.notional)}` : `$${Math.round(d.size * d.price)}`;
      const user = shortenAddr(d.id || 'anon');

      appendMessage({
        id: `trade-${d.id}-${d.timestamp}`,
        user,
        avatar: walletAvatar(user),
        isAction: true,
        actionBold: user,
        actionText: `placed ${notional} on ${direction}`,
        timestamp: d.timestamp || Date.now(),
      });
    });

    return () => { unsubscribe(); };
  }, [appendMessage]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || !walletAddress || sendingRef.current) return;
    sendingRef.current = true;
    setInput('');

    const { error } = await supabase.from('chat_messages').insert({
      wallet_address: walletAddress,
      message: text,
    });
    if (error) console.error('[Chat] send failed', error.message);
    sendingRef.current = false;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <div ref={scrollRef} style={{
        flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 28px',
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        {messages.map((msg) => {
          if (msg.isOwn) {
            return (
              <div key={msg.id} style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <div style={{ padding: '10px 20px', borderRadius: 12, background: 'rgba(0,30,255,0.66)', maxWidth: '80%' }}>
                  <span style={{ fontSize: 24, color: '#eee' }}>{msg.text}</span>
                </div>
              </div>
            );
          }

          return (
            <div key={msg.id} style={{ display: 'flex', gap: 16, alignItems: 'flex-end' }}>
              <div style={{
                width: 50, height: 50, borderRadius: '50%', background: '#333',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 28, flexShrink: 0,
              }}>
                {msg.avatar}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: '80%' }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: dim }}>{msg.user}</span>
                {msg.isAction ? (
                  <div style={{ padding: '10px 20px', borderRadius: 12, background: '#232323' }}>
                    <span style={{ fontSize: 24, fontWeight: 700, color: '#eee' }}>{msg.actionBold}</span>
                    <span style={{ fontSize: 24, color: '#eee' }}> {msg.actionText}</span>
                  </div>
                ) : (
                  <div style={{ padding: '10px 20px', borderRadius: 12, background: '#232323' }}>
                    <span style={{ fontSize: 24, color: '#eee' }}>{msg.text}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 16, padding: '16px 28px', flexShrink: 0 }}>
        <input
          type="text"
          placeholder={isAuthenticated ? 'Leave a message' : 'Connect wallet to chat'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }}
          disabled={!isAuthenticated}
          style={{
            flex: 1, height: 70, borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.11)',
            background: '#232323', color: '#eee', fontSize: 24,
            padding: '0 24px', outline: 'none',
            fontFamily: "'IBM Plex Mono', monospace",
            opacity: isAuthenticated ? 1 : 0.5,
          }}
        />
        <button
          onClick={handleSend}
          disabled={!isAuthenticated || !input.trim()}
          style={{
            width: 70, height: 70, borderRadius: 12,
            background: '#001eff', border: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: isAuthenticated ? 'pointer' : 'not-allowed', flexShrink: 0,
            opacity: isAuthenticated && input.trim() ? 1 : 0.5,
          }}>
          <Send size={28} color="#eee" />
        </button>
      </div>
    </div>
  );
}
