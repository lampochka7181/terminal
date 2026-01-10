'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import type { Asset } from '@degen/types';
import { ViewSelector, getViewPreference, setViewPreference } from './view-selector';
import { MobileView } from './mobile-view';
import { DesktopView } from './desktop-view';

export default function MarketPage() {
  const params = useParams();
  const asset = (params.asset as string)?.toUpperCase() as Asset || 'BTC';
  
  // View state: null means show selector, 'desktop' or 'mobile' shows that view
  const [currentView, setCurrentView] = useState<'desktop' | 'mobile' | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // On mount, check for stored preference
  useEffect(() => {
    const stored = getViewPreference();
    if (stored) {
      setCurrentView(stored);
    }
    setIsLoading(false);
  }, []);

  // Handle view selection
  const handleSelectView = (view: 'desktop' | 'mobile') => {
    setViewPreference(view);
    setCurrentView(view);
  };

  // Handle view switch (from within desktop/mobile views)
  const handleSwitchView = () => {
    const newView = currentView === 'desktop' ? 'mobile' : 'desktop';
    setViewPreference(newView);
    setCurrentView(newView);
  };

  // Show loading state briefly while checking preference
  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // If no preference set, show view selector
  if (!currentView) {
    return <ViewSelector asset={asset} onSelect={handleSelectView} />;
  }

  // Render the appropriate view
  if (currentView === 'desktop') {
    return <DesktopView asset={asset} onSwitchView={handleSwitchView} />;
  }

  return <MobileView asset={asset} onSwitchView={handleSwitchView} />;
}
