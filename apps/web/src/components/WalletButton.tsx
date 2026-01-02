'use client';

import { useState, useEffect } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

/**
 * Client-only wallet button wrapper
 * Prevents hydration mismatch by only rendering after mount
 */
export function WalletButton({ className }: { className?: string }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Render a placeholder with same dimensions during SSR
  if (!mounted) {
    return (
      <button 
        className={className || "!bg-accent !text-background hover:!bg-accent-dim !rounded-lg !font-semibold !h-10 !px-4"}
        style={{ minWidth: '150px' }}
        disabled
      >
        Loading...
      </button>
    );
  }

  return (
    <WalletMultiButton className={className} />
  );
}

export default WalletButton;









