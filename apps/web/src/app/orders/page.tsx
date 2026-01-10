'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Redirect to profile page - orders are now part of the unified profile
export default function OrdersPage() {
  const router = useRouter();
  
  useEffect(() => {
    router.replace('/profile');
  }, [router]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="text-text-muted">Redirecting...</div>
    </div>
  );
}
