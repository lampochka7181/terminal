'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Monitor, Smartphone, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Asset } from '@degen/types';

const VIEW_PREFERENCE_KEY = 'degen-terminal-view-preference';

interface ViewSelectorProps {
  asset: Asset;
  onSelect: (view: 'desktop' | 'mobile') => void;
}

export function ViewSelector({ asset, onSelect }: ViewSelectorProps) {
  const [hoveredView, setHoveredView] = useState<'desktop' | 'mobile' | null>(null);

  const assetNames: Record<string, string> = {
    BTC: 'Bitcoin',
    ETH: 'Ethereum',
    SOL: 'Solana',
  };

  return (
    <div className="fixed inset-0 bg-background flex items-center justify-center p-4 z-50">
      <div className="max-w-2xl w-full">
        {/* Header */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-full bg-surface-light flex items-center justify-center font-bold text-accent text-xl border border-border">
              {asset.charAt(0)}
            </div>
            <div className="text-left">
              <h1 className="text-3xl font-bold">{asset}</h1>
              <p className="text-text-muted">{assetNames[asset] || asset} Markets</p>
            </div>
          </div>
          <p className="text-text-secondary text-lg">Choose your trading experience</p>
        </div>

        {/* View Options */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Desktop View */}
          <button
            onClick={() => onSelect('desktop')}
            onMouseEnter={() => setHoveredView('desktop')}
            onMouseLeave={() => setHoveredView(null)}
            className={cn(
              'group relative p-8 rounded-2xl border-2 transition-all duration-300 text-left overflow-hidden',
              'bg-surface hover:bg-surface-light',
              hoveredView === 'desktop' 
                ? 'border-accent shadow-lg shadow-accent/20' 
                : 'border-border hover:border-accent/50'
            )}
          >
            {/* Glow effect */}
            <div className={cn(
              'absolute inset-0 bg-gradient-to-br from-accent/10 to-transparent opacity-0 transition-opacity duration-300',
              hoveredView === 'desktop' && 'opacity-100'
            )} />
            
            <div className="relative">
              <div className={cn(
                'w-16 h-16 rounded-xl bg-surface-light flex items-center justify-center mb-6 transition-colors',
                'border border-border group-hover:border-accent/50'
              )}>
                <Monitor className={cn(
                  'w-8 h-8 transition-colors',
                  hoveredView === 'desktop' ? 'text-accent' : 'text-text-secondary'
                )} />
              </div>
              
              <h3 className="text-xl font-bold mb-2 flex items-center gap-2">
                Desktop Trading
                <span className="px-2 py-0.5 text-xs rounded-full bg-accent/20 text-accent font-bold">
                  NEW
                </span>
              </h3>
              <p className="text-text-muted text-sm mb-4">
                Full-featured trading interface with live chart, orderbook depth, and quick execution.
              </p>
              
              <ul className="space-y-2 text-sm text-text-secondary">
                <li className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                  Live candlestick chart with strike line
                </li>
                <li className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                  Side-by-side ABOVE/BELOW trading
                </li>
                <li className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                  Portfolio overview at a glance
                </li>
              </ul>

              <div className={cn(
                'mt-6 flex items-center gap-2 text-sm font-bold transition-colors',
                hoveredView === 'desktop' ? 'text-accent' : 'text-text-muted'
              )}>
                <span>Enter Desktop Mode</span>
                <ArrowRight className={cn(
                  'w-4 h-4 transition-transform',
                  hoveredView === 'desktop' && 'translate-x-1'
                )} />
              </div>
            </div>
          </button>

          {/* Mobile View */}
          <button
            onClick={() => onSelect('mobile')}
            onMouseEnter={() => setHoveredView('mobile')}
            onMouseLeave={() => setHoveredView(null)}
            className={cn(
              'group relative p-8 rounded-2xl border-2 transition-all duration-300 text-left overflow-hidden',
              'bg-surface hover:bg-surface-light',
              hoveredView === 'mobile' 
                ? 'border-accent shadow-lg shadow-accent/20' 
                : 'border-border hover:border-accent/50'
            )}
          >
            {/* Glow effect */}
            <div className={cn(
              'absolute inset-0 bg-gradient-to-br from-accent/10 to-transparent opacity-0 transition-opacity duration-300',
              hoveredView === 'mobile' && 'opacity-100'
            )} />
            
            <div className="relative">
              <div className={cn(
                'w-16 h-16 rounded-xl bg-surface-light flex items-center justify-center mb-6 transition-colors',
                'border border-border group-hover:border-accent/50'
              )}>
                <Smartphone className={cn(
                  'w-8 h-8 transition-colors',
                  hoveredView === 'mobile' ? 'text-accent' : 'text-text-secondary'
                )} />
              </div>
              
              <h3 className="text-xl font-bold mb-2">Mobile Trading</h3>
              <p className="text-text-muted text-sm mb-4">
                Streamlined interface optimized for touch and smaller screens.
              </p>
              
              <ul className="space-y-2 text-sm text-text-secondary">
                <li className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                  Compact vertical layout
                </li>
                <li className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                  Touch-optimized buttons
                </li>
                <li className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                  Quick trade modals
                </li>
              </ul>

              <div className={cn(
                'mt-6 flex items-center gap-2 text-sm font-bold transition-colors',
                hoveredView === 'mobile' ? 'text-accent' : 'text-text-muted'
              )}>
                <span>Enter Mobile Mode</span>
                <ArrowRight className={cn(
                  'w-4 h-4 transition-transform',
                  hoveredView === 'mobile' && 'translate-x-1'
                )} />
              </div>
            </div>
          </button>
        </div>

        {/* Remember preference hint */}
        <p className="text-center text-text-muted text-xs mt-8">
          Your preference will be remembered for future visits.
          <br />
          You can always switch views from the market page.
        </p>
      </div>
    </div>
  );
}

// Utility functions for preference storage
export function getViewPreference(): 'desktop' | 'mobile' | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(VIEW_PREFERENCE_KEY) as 'desktop' | 'mobile' | null;
}

export function setViewPreference(view: 'desktop' | 'mobile'): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(VIEW_PREFERENCE_KEY, view);
}

