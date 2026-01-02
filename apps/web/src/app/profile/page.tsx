'use client';

import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Header } from '@/components/layout/Header';
import { useSettingsStore, QuickTradePreset } from '@/stores/settingsStore';
import { useDelegation } from '@/hooks/useDelegation';
import { useBalance, useTotalPnL } from '@/hooks/useUser';
import { cn } from '@/lib/utils';
import { 
  ArrowLeft, 
  Zap, 
  Settings, 
  DollarSign, 
  Volume2, 
  VolumeX,
  Eye,
  EyeOff,
  Check,
  Plus,
  X,
  Trash2,
  RefreshCw,
  Shield,
  Wallet,
  TrendingUp,
  TrendingDown,
  Copy,
  ExternalLink,
  AlertCircle
} from 'lucide-react';
import Link from 'next/link';

export default function ProfilePage() {
  const { connected, publicKey, disconnect } = useWallet();
  const { balance } = useBalance();
  const totalPnL = useTotalPnL();
  const { 
    isApproved: isDelegationApproved, 
    delegatedAmount, 
    approve: approveDelegation, 
    revoke: revokeDelegation, 
    isApproving 
  } = useDelegation();

  const {
    oneClickEnabled,
    oneClickAmount,
    quickTradePresets,
    showPnLPercent,
    confirmTrades,
    soundEnabled,
    defaultOrderType,
    defaultSlippage,
    setOneClickEnabled,
    setOneClickAmount,
    setShowPnLPercent,
    setConfirmTrades,
    setSoundEnabled,
    setDefaultOrderType,
    setDefaultSlippage,
    addQuickTradePreset,
    removeQuickTradePreset,
    resetToDefaults,
  } = useSettingsStore();

  const [newPresetAmount, setNewPresetAmount] = useState('');
  const [showAddPreset, setShowAddPreset] = useState(false);
  const [delegationInput, setDelegationInput] = useState('');
  const [showDelegationEdit, setShowDelegationEdit] = useState(false);
  const [copied, setCopied] = useState(false);

  const walletAddress = publicKey?.toBase58() || '';
  const truncatedAddress = walletAddress 
    ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
    : '';

  const copyAddress = async () => {
    if (walletAddress) {
      await navigator.clipboard.writeText(walletAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleAddPreset = () => {
    const amount = parseFloat(newPresetAmount);
    if (amount > 0 && amount <= 10000) {
      addQuickTradePreset(amount);
      setNewPresetAmount('');
      setShowAddPreset(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="max-w-2xl mx-auto p-4 pb-24">
        {/* Back Button */}
        <Link 
          href="/"
          className="inline-flex items-center gap-2 text-text-muted hover:text-text-primary transition-colors text-sm font-medium mb-6 btn-press"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Markets
        </Link>

        {/* Page Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold mb-2">Settings</h1>
          <p className="text-text-muted">Configure your trading preferences</p>
        </div>

        {/* Account Section */}
        {connected && (
          <section className="mb-8 animate-fade-in">
            <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
              <Wallet className="w-5 h-5 text-accent" />
              Account
            </h2>
            
            <div className="bg-surface rounded-xl border border-border overflow-hidden">
              {/* Wallet Address */}
              <div className="p-4 border-b border-border">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm text-text-muted mb-1">Wallet Address</div>
                    <div className="font-mono text-text-primary">{truncatedAddress}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={copyAddress}
                      className={cn(
                        "p-2 rounded-lg transition-all btn-press",
                        copied ? "bg-long/20 text-long" : "bg-surface-light text-text-muted hover:text-text-primary"
                      )}
                    >
                      {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                    <a
                      href={`https://solscan.io/account/${walletAddress}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2 rounded-lg bg-surface-light text-text-muted hover:text-accent transition-all btn-press"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </div>
                </div>
              </div>

              {/* Balance & P&L */}
              <div className="p-4 grid grid-cols-2 gap-4">
                <div>
                  <div className="text-sm text-text-muted mb-1">Balance</div>
                  <div className="text-xl font-bold font-mono text-accent">
                    ${balance?.total?.toFixed(2) || '0.00'}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-text-muted mb-1">Total P&L</div>
                  <div className={cn(
                    "text-xl font-bold font-mono flex items-center gap-1",
                    totalPnL >= 0 ? 'text-long' : 'text-short'
                  )}>
                    {totalPnL >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                    {totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
                  </div>
                </div>
              </div>

              {/* Disconnect */}
              <div className="p-4 bg-surface-light/30 border-t border-border">
                <button
                  onClick={() => disconnect()}
                  className="w-full py-2 text-sm text-text-muted hover:text-short transition-colors"
                >
                  Disconnect Wallet
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Fast Trading (Delegation) Section */}
        <section className="mb-8 animate-fade-in stagger-1">
          <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
            <Shield className="w-5 h-5 text-accent" />
            Fast Trading
          </h2>
          
          <div className="bg-surface rounded-xl border border-border p-4">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="font-medium">Token Delegation</div>
                <div className="text-sm text-text-muted">
                  Skip wallet approvals for faster trades
                </div>
              </div>
              <div className={cn(
                "px-3 py-1 rounded-full text-sm font-bold",
                isDelegationApproved ? "bg-long/20 text-long" : "bg-surface-light text-text-muted"
              )}>
                {isDelegationApproved ? 'Active' : 'Inactive'}
              </div>
            </div>

            {isDelegationApproved ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 bg-surface-light rounded-lg">
                  <span className="text-text-muted">Delegated Amount</span>
                  <span className="font-mono font-bold text-accent">
                    ${(delegatedAmount / 1_000_000).toFixed(2)} USDC
                  </span>
                </div>
                
                {showDelegationEdit ? (
                  <div className="space-y-3">
                    <input
                      type="number"
                      value={delegationInput}
                      onChange={(e) => setDelegationInput(e.target.value)}
                      placeholder="New amount"
                      className="w-full px-4 py-3 rounded-lg bg-surface-light border border-border text-text-primary font-mono focus:border-accent transition-colors"
                    />
                    <div className="flex gap-2">
                      {[1000, 5000, 10000].map((amt) => (
                        <button
                          key={amt}
                          onClick={() => setDelegationInput(amt.toString())}
                          className="flex-1 py-2 text-sm rounded-lg bg-surface-light hover:bg-border transition-colors btn-press"
                        >
                          ${amt.toLocaleString()}
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setShowDelegationEdit(false)}
                        className="flex-1 py-2 rounded-lg border border-border text-text-muted hover:text-text-primary transition-colors btn-press"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={async () => {
                          const amount = parseFloat(delegationInput) * 1_000_000;
                          if (amount > 0) {
                            await approveDelegation(amount);
                            setShowDelegationEdit(false);
                          }
                        }}
                        disabled={isApproving}
                        className="flex-1 py-2 rounded-lg bg-accent text-background font-bold hover:bg-accent-dim transition-colors btn-press"
                      >
                        {isApproving ? 'Updating...' : 'Update'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setDelegationInput((delegatedAmount / 1_000_000).toString());
                        setShowDelegationEdit(true);
                      }}
                      className="flex-1 py-2 rounded-lg bg-surface-light text-text-primary hover:bg-border transition-colors btn-press"
                    >
                      Adjust Amount
                    </button>
                    <button
                      onClick={() => revokeDelegation()}
                      disabled={isApproving}
                      className="px-4 py-2 rounded-lg border border-short/30 text-short hover:bg-short/10 transition-colors btn-press"
                    >
                      Revoke
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                onClick={() => approveDelegation()}
                disabled={isApproving || !connected}
                className="w-full py-3 rounded-lg bg-accent text-background font-bold hover:bg-accent-dim transition-all btn-press flex items-center justify-center gap-2"
              >
                {isApproving ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Enabling...
                  </>
                ) : (
                  <>
                    <Zap className="w-4 h-4" />
                    Enable Fast Trading
                  </>
                )}
              </button>
            )}
          </div>
        </section>

        {/* One-Click Trading Section */}
        <section className="mb-8 animate-fade-in stagger-2">
          <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
            <Zap className="w-5 h-5 text-warning" />
            One-Click Trading
          </h2>
          
          <div className="bg-surface rounded-xl border border-border p-4 space-y-4">
            {/* Enable Toggle */}
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">Enable One-Click Mode</div>
                <div className="text-sm text-text-muted">
                  Trade instantly by tapping the price
                </div>
              </div>
              <button
                onClick={() => setOneClickEnabled(!oneClickEnabled)}
                className={cn(
                  "w-12 h-7 rounded-full transition-all relative btn-press",
                  oneClickEnabled ? "bg-accent" : "bg-surface-light border border-border"
                )}
              >
                <div className={cn(
                  "w-5 h-5 rounded-full bg-white shadow-md absolute top-1 transition-all",
                  oneClickEnabled ? "left-6" : "left-1"
                )} />
              </button>
            </div>

            {/* Default Amount */}
            <div className={cn("space-y-3 transition-opacity", !oneClickEnabled && "opacity-50 pointer-events-none")}>
              <div className="flex items-center justify-between">
                <span className="text-text-muted">Default Trade Amount</span>
                <span className="font-mono font-bold text-accent">${oneClickAmount}</span>
              </div>
              
              <input
                type="range"
                value={oneClickAmount}
                onChange={(e) => setOneClickAmount(parseInt(e.target.value))}
                min="10"
                max="1000"
                step="10"
                className="w-full accent-accent"
              />
              
              <div className="flex justify-between text-xs text-text-muted">
                <span>$10</span>
                <span>$1000</span>
              </div>
            </div>

            {/* Quick Presets */}
            <div className={cn("space-y-3 transition-opacity", !oneClickEnabled && "opacity-50 pointer-events-none")}>
              <div className="text-sm text-text-muted">Quick Presets</div>
              <div className="flex flex-wrap gap-2">
                {quickTradePresets.map((preset) => (
                  <div
                    key={preset.id}
                    className="group flex items-center gap-1 px-3 py-2 rounded-lg bg-surface-light border border-border"
                  >
                    <button
                      onClick={() => setOneClickAmount(preset.amount)}
                      className={cn(
                        "font-mono font-bold transition-colors",
                        oneClickAmount === preset.amount ? "text-accent" : "text-text-primary"
                      )}
                    >
                      {preset.label}
                    </button>
                    <button
                      onClick={() => removeQuickTradePreset(preset.id)}
                      className="p-1 text-text-muted hover:text-short opacity-0 group-hover:opacity-100 transition-all"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                
                {showAddPreset ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={newPresetAmount}
                      onChange={(e) => setNewPresetAmount(e.target.value)}
                      placeholder="$"
                      className="w-20 px-3 py-2 rounded-lg bg-surface-light border border-border text-text-primary font-mono text-center focus:border-accent"
                      autoFocus
                    />
                    <button
                      onClick={handleAddPreset}
                      className="p-2 rounded-lg bg-accent text-background btn-press"
                    >
                      <Check className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => {
                        setShowAddPreset(false);
                        setNewPresetAmount('');
                      }}
                      className="p-2 rounded-lg bg-surface-light text-text-muted btn-press"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : quickTradePresets.length < 6 && (
                  <button
                    onClick={() => setShowAddPreset(true)}
                    className="flex items-center gap-1 px-3 py-2 rounded-lg border border-dashed border-border text-text-muted hover:text-accent hover:border-accent transition-colors btn-press"
                  >
                    <Plus className="w-4 h-4" />
                    Add
                  </button>
                )}
              </div>
            </div>

            {oneClickEnabled && (
              <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg">
                <AlertCircle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                <p className="text-xs text-warning">
                  One-click trading will execute trades immediately when you tap a price. 
                  Make sure you have Fast Trading enabled.
                </p>
              </div>
            )}
          </div>
        </section>

        {/* Trading Preferences */}
        <section className="mb-8 animate-fade-in stagger-3">
          <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
            <Settings className="w-5 h-5 text-text-secondary" />
            Preferences
          </h2>
          
          <div className="bg-surface rounded-xl border border-border divide-y divide-border">
            {/* Default Order Type */}
            <div className="p-4 flex items-center justify-between">
              <div>
                <div className="font-medium">Default Order Type</div>
                <div className="text-sm text-text-muted">For manual trades</div>
              </div>
              <div className="flex gap-1 bg-surface-light rounded-lg p-1">
                <button
                  onClick={() => setDefaultOrderType('market')}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-sm font-medium transition-all btn-press",
                    defaultOrderType === 'market' 
                      ? "bg-accent text-background" 
                      : "text-text-muted hover:text-text-primary"
                  )}
                >
                  Market
                </button>
                <button
                  onClick={() => setDefaultOrderType('limit')}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-sm font-medium transition-all btn-press",
                    defaultOrderType === 'limit' 
                      ? "bg-accent text-background" 
                      : "text-text-muted hover:text-text-primary"
                  )}
                >
                  Limit
                </button>
              </div>
            </div>

            {/* Default Slippage */}
            <div className="p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="font-medium">Max Slippage</div>
                  <div className="text-sm text-text-muted">Price protection for market orders</div>
                </div>
                <span className="font-mono font-bold text-accent">${defaultSlippage.toFixed(2)}</span>
              </div>
              <input
                type="range"
                value={defaultSlippage * 100}
                onChange={(e) => setDefaultSlippage(parseInt(e.target.value) / 100)}
                min="1"
                max="25"
                className="w-full accent-accent"
              />
              <div className="flex justify-between text-xs text-text-muted mt-1">
                <span>$0.01</span>
                <span>$0.25</span>
              </div>
            </div>

            {/* Show P&L Percent */}
            <div className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                {showPnLPercent ? <Eye className="w-5 h-5 text-text-muted" /> : <EyeOff className="w-5 h-5 text-text-muted" />}
                <div>
                  <div className="font-medium">Show P&L Percentage</div>
                  <div className="text-sm text-text-muted">Display % change alongside dollar P&L</div>
                </div>
              </div>
              <button
                onClick={() => setShowPnLPercent(!showPnLPercent)}
                className={cn(
                  "w-12 h-7 rounded-full transition-all relative btn-press",
                  showPnLPercent ? "bg-accent" : "bg-surface-light border border-border"
                )}
              >
                <div className={cn(
                  "w-5 h-5 rounded-full bg-white shadow-md absolute top-1 transition-all",
                  showPnLPercent ? "left-6" : "left-1"
                )} />
              </button>
            </div>

            {/* Confirm Trades */}
            <div className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Check className="w-5 h-5 text-text-muted" />
                <div>
                  <div className="font-medium">Confirm Trades</div>
                  <div className="text-sm text-text-muted">Show confirmation before placing orders</div>
                </div>
              </div>
              <button
                onClick={() => setConfirmTrades(!confirmTrades)}
                className={cn(
                  "w-12 h-7 rounded-full transition-all relative btn-press",
                  confirmTrades ? "bg-accent" : "bg-surface-light border border-border"
                )}
              >
                <div className={cn(
                  "w-5 h-5 rounded-full bg-white shadow-md absolute top-1 transition-all",
                  confirmTrades ? "left-6" : "left-1"
                )} />
              </button>
            </div>

            {/* Sound Effects */}
            <div className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                {soundEnabled ? <Volume2 className="w-5 h-5 text-text-muted" /> : <VolumeX className="w-5 h-5 text-text-muted" />}
                <div>
                  <div className="font-medium">Sound Effects</div>
                  <div className="text-sm text-text-muted">Play sounds for trades and alerts</div>
                </div>
              </div>
              <button
                onClick={() => setSoundEnabled(!soundEnabled)}
                className={cn(
                  "w-12 h-7 rounded-full transition-all relative btn-press",
                  soundEnabled ? "bg-accent" : "bg-surface-light border border-border"
                )}
              >
                <div className={cn(
                  "w-5 h-5 rounded-full bg-white shadow-md absolute top-1 transition-all",
                  soundEnabled ? "left-6" : "left-1"
                )} />
              </button>
            </div>
          </div>
        </section>

        {/* Reset Section */}
        <section className="animate-fade-in stagger-4">
          <button
            onClick={() => {
              if (confirm('Reset all settings to defaults?')) {
                resetToDefaults();
              }
            }}
            className="w-full py-3 rounded-xl border border-border text-text-muted hover:text-short hover:border-short/30 transition-colors btn-press flex items-center justify-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            Reset to Defaults
          </button>
        </section>

        {/* Version Info */}
        <div className="mt-8 text-center text-xs text-text-muted">
          <p>Degen Terminal v0.1.0</p>
          <p className="text-accent">Devnet</p>
        </div>
      </main>
    </div>
  );
}

