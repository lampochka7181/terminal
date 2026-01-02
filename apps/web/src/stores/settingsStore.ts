'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface QuickTradePreset {
  id: string;
  amount: number;
  label: string;
}

export interface UserSettings {
  // One-click trading
  oneClickEnabled: boolean;
  oneClickAmount: number;
  quickTradePresets: QuickTradePreset[];
  
  // Display preferences
  showPnLPercent: boolean;
  showOrderbook: boolean;
  confirmTrades: boolean;
  soundEnabled: boolean;
  
  // Default order settings
  defaultOrderType: 'market' | 'limit';
  defaultSlippage: number; // 0.01 to 0.25
}

interface SettingsStore extends UserSettings {
  // Actions
  setOneClickEnabled: (enabled: boolean) => void;
  setOneClickAmount: (amount: number) => void;
  setQuickTradePresets: (presets: QuickTradePreset[]) => void;
  addQuickTradePreset: (amount: number, label?: string) => void;
  removeQuickTradePreset: (id: string) => void;
  
  setShowPnLPercent: (show: boolean) => void;
  setShowOrderbook: (show: boolean) => void;
  setConfirmTrades: (confirm: boolean) => void;
  setSoundEnabled: (enabled: boolean) => void;
  
  setDefaultOrderType: (type: 'market' | 'limit') => void;
  setDefaultSlippage: (slippage: number) => void;
  
  resetToDefaults: () => void;
}

const DEFAULT_PRESETS: QuickTradePreset[] = [
  { id: 'preset-25', amount: 25, label: '$25' },
  { id: 'preset-50', amount: 50, label: '$50' },
  { id: 'preset-100', amount: 100, label: '$100' },
  { id: 'preset-250', amount: 250, label: '$250' },
];

const DEFAULT_SETTINGS: UserSettings = {
  oneClickEnabled: false,
  oneClickAmount: 50,
  quickTradePresets: DEFAULT_PRESETS,
  
  showPnLPercent: true,
  showOrderbook: false,
  confirmTrades: true,
  soundEnabled: true,
  
  defaultOrderType: 'market',
  defaultSlippage: 0.10,
};

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      ...DEFAULT_SETTINGS,
      
      setOneClickEnabled: (enabled) => set({ oneClickEnabled: enabled }),
      setOneClickAmount: (amount) => set({ oneClickAmount: Math.max(1, amount) }),
      
      setQuickTradePresets: (presets) => set({ quickTradePresets: presets }),
      
      addQuickTradePreset: (amount, label) => {
        const presets = get().quickTradePresets;
        if (presets.length >= 6) return; // Max 6 presets
        const newPreset: QuickTradePreset = {
          id: `preset-${Date.now()}`,
          amount,
          label: label || `$${amount}`,
        };
        set({ quickTradePresets: [...presets, newPreset] });
      },
      
      removeQuickTradePreset: (id) => {
        const presets = get().quickTradePresets;
        set({ quickTradePresets: presets.filter(p => p.id !== id) });
      },
      
      setShowPnLPercent: (show) => set({ showPnLPercent: show }),
      setShowOrderbook: (show) => set({ showOrderbook: show }),
      setConfirmTrades: (confirm) => set({ confirmTrades: confirm }),
      setSoundEnabled: (enabled) => set({ soundEnabled: enabled }),
      
      setDefaultOrderType: (type) => set({ defaultOrderType: type }),
      setDefaultSlippage: (slippage) => set({ defaultSlippage: Math.max(0.01, Math.min(0.25, slippage)) }),
      
      resetToDefaults: () => set(DEFAULT_SETTINGS),
    }),
    {
      name: 'degen-settings',
      version: 1,
    }
  )
);

// Helper hook for one-click trading
export function useOneClickTrading() {
  const { oneClickEnabled, oneClickAmount, setOneClickEnabled, setOneClickAmount } = useSettingsStore();
  return { oneClickEnabled, oneClickAmount, setOneClickEnabled, setOneClickAmount };
}

// Helper hook for quick trade presets
export function useQuickTradePresets() {
  const { quickTradePresets, setQuickTradePresets, addQuickTradePreset, removeQuickTradePreset } = useSettingsStore();
  return { quickTradePresets, setQuickTradePresets, addQuickTradePreset, removeQuickTradePreset };
}

