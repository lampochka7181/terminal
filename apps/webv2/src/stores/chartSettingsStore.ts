import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ChartType = 'candlestick' | 'line' | 'area';
export type ColorScheme = 'classic' | 'monochrome' | 'colorblind';

export interface ChartSettings {
  // Display
  chartType: ChartType;
  showGrid: boolean;
  showCrosshair: boolean;
  showStrikeLine: boolean;
  showVolume: boolean;
  
  // Candle intervals (in seconds)
  candleInterval: number;
  
  // Colors
  colorScheme: ColorScheme;
  upColor: string;
  downColor: string;
  
  // Behavior
  autoScale: boolean;
  
  // Actions
  setChartType: (type: ChartType) => void;
  setCandleInterval: (interval: number) => void;
  setColorScheme: (scheme: ColorScheme) => void;
  toggleGrid: () => void;
  toggleCrosshair: () => void;
  toggleStrikeLine: () => void;
  toggleVolume: () => void;
  toggleAutoScale: () => void;
  resetToDefaults: () => void;
}

const COLOR_SCHEMES: Record<ColorScheme, { up: string; down: string }> = {
  classic: { up: '#00ff88', down: '#ff3366' },
  monochrome: { up: '#ffffff', down: '#666666' },
  colorblind: { up: '#0077bb', down: '#ee7733' },
};

const DEFAULT_SETTINGS = {
  chartType: 'candlestick' as ChartType,
  showGrid: true,
  showCrosshair: true,
  showStrikeLine: true,
  showVolume: false,
  candleInterval: 15, // 15 seconds default
  colorScheme: 'classic' as ColorScheme,
  upColor: COLOR_SCHEMES.classic.up,
  downColor: COLOR_SCHEMES.classic.down,
  autoScale: true,
};

export const useChartSettingsStore = create<ChartSettings>()(
  persist(
    (set, get) => ({
      ...DEFAULT_SETTINGS,
      
      setChartType: (type) => set({ chartType: type }),
      
      setCandleInterval: (interval) => set({ candleInterval: interval }),
      
      setColorScheme: (scheme) => set({
        colorScheme: scheme,
        upColor: COLOR_SCHEMES[scheme].up,
        downColor: COLOR_SCHEMES[scheme].down,
      }),
      
      toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
      toggleCrosshair: () => set((s) => ({ showCrosshair: !s.showCrosshair })),
      toggleStrikeLine: () => set((s) => ({ showStrikeLine: !s.showStrikeLine })),
      toggleVolume: () => set((s) => ({ showVolume: !s.showVolume })),
      toggleAutoScale: () => set((s) => ({ autoScale: !s.autoScale })),
      
      resetToDefaults: () => set(DEFAULT_SETTINGS),
    }),
    {
      name: 'chart-settings',
    }
  )
);

// Candle interval presets
export const CANDLE_INTERVALS = [
  { value: 5, label: '5s' },
  { value: 10, label: '10s' },
  { value: 15, label: '15s' },
  { value: 30, label: '30s' },
  { value: 60, label: '1m' },
] as const;

