import { useState } from 'react';
import { Minus, Trash2 } from 'lucide-react';
import { create } from 'zustand';

interface ChartToolbarStore {
  tickSize: number;
  setTickSize: (size: number) => void;
  drawingMode: boolean;
  setDrawingMode: (on: boolean) => void;
  clearDrawings: number;
  triggerClear: () => void;
}

export const useChartToolbarStore = create<ChartToolbarStore>((set) => ({
  tickSize: 6,
  setTickSize: (size) => set({ tickSize: size }),
  drawingMode: false,
  setDrawingMode: (on) => set({ drawingMode: on }),
  clearDrawings: 0,
  triggerClear: () => set((s) => ({ clearDrawings: s.clearDrawings + 1 })),
}));

const TICK_OPTIONS = [
  { label: 'S', value: 3 },
  { label: 'M', value: 6 },
  { label: 'L', value: 12 },
];

export default function ChartToolbar() {
  const { tickSize, setTickSize, drawingMode, setDrawingMode, triggerClear } = useChartToolbarStore();
  const [tickOpen, setTickOpen] = useState(false);

  const activeTick = TICK_OPTIONS.find(t => t.value === tickSize) ?? TICK_OPTIONS[1];

  return (
    <div style={{
      position: 'absolute', top: 8, left: 8, zIndex: 10,
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
      padding: '6px 4px',
      borderRadius: 12,
      pointerEvents: 'auto',
    }}>
      {/* Tick size */}
      <div style={{ position: 'relative' }}>
        <button
          title="Tick Size"
          onClick={() => setTickOpen(o => !o)}
          style={{
            width: 48, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column',
            borderRadius: 10, border: 'none', cursor: 'pointer',
            background: tickOpen ? 'rgba(66,66,66,0.8)' : 'transparent',
            color: '#eee',
            transition: 'background 0.15s',
            fontSize: 13, fontWeight: 600, lineHeight: 1.2, letterSpacing: '0.02em',
          }}
        >
          <span style={{ fontSize: 11, opacity: 0.5 }}>TICK</span>
          <span>{activeTick.label} ▸</span>
        </button>
        {tickOpen && (
          <div style={{
            position: 'absolute', left: 56, top: 0,
            display: 'flex', flexDirection: 'column', gap: 2,
            background: '#2a2a2a', borderRadius: 10, padding: 4,
            border: '1px solid rgba(255,255,255,0.11)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          }}>
            {TICK_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => { setTickSize(opt.value); setTickOpen(false); }}
                style={{
                  width: 44, height: 36, borderRadius: 8, border: 'none', cursor: 'pointer',
                  background: opt.value === tickSize ? '#001eff' : 'transparent',
                  color: '#eee', fontSize: 14, fontWeight: 600,
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Line draw */}
      <button
        title="Draw Line"
        onClick={() => setDrawingMode(!drawingMode)}
        style={{
          width: 48, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 10, border: 'none', cursor: 'pointer',
          background: drawingMode ? 'rgba(66,66,66,0.8)' : 'transparent',
          color: drawingMode ? '#eee' : 'rgba(238,238,238,0.33)',
          transition: 'color 0.15s, background 0.15s',
        }}
      >
        <Minus size={28} strokeWidth={1.5} />
      </button>

      {/* Clear all drawings */}
      <button
        title="Clear Drawings"
        onClick={triggerClear}
        style={{
          width: 48, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 10, border: 'none', cursor: 'pointer',
          background: 'transparent',
          color: 'rgba(238,238,238,0.33)',
          transition: 'color 0.15s, background 0.15s',
        }}
      >
        <Trash2 size={22} strokeWidth={1.5} />
      </button>
    </div>
  );
}
