'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

interface CountdownProps {
  expiryTime: number; // Unix timestamp in milliseconds
  onExpire?: () => void;
  className?: string;
}

export function Countdown({ expiryTime, onExpire, className }: CountdownProps) {
  // Initialize with null to avoid hydration mismatch
  const [timeLeft, setTimeLeft] = useState<{ minutes: number; seconds: number; total: number } | null>(null);

  useEffect(() => {
    function calculateTimeLeft() {
      const diff = expiryTime - Date.now();
      if (diff <= 0) return { minutes: 0, seconds: 0, total: 0 };
      
      return {
        minutes: Math.floor(diff / 60000),
        seconds: Math.floor((diff % 60000) / 1000),
        total: diff,
      };
    }

    // Set initial value on client
    setTimeLeft(calculateTimeLeft());

    const timer = setInterval(() => {
      const newTimeLeft = calculateTimeLeft();
      setTimeLeft(newTimeLeft);
      
      if (newTimeLeft.total <= 0) {
        clearInterval(timer);
        onExpire?.();
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [expiryTime, onExpire]);

  // Show loading state during SSR/hydration
  if (!timeLeft) {
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <div className="flex items-center gap-1 font-mono text-text-muted">
          <span>--:--</span>
        </div>
      </div>
    );
  }

  const isUrgent = timeLeft.total < 60000; // Less than 1 minute
  const isCritical = timeLeft.total < 30000; // Less than 30 seconds

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className={cn(
        'flex items-center gap-1 font-mono',
        isCritical ? 'text-short animate-pulse' : isUrgent ? 'text-warning' : 'text-text-primary'
      )}>
        <TimeUnit value={timeLeft.minutes} label="m" />
        <span className="text-text-muted">:</span>
        <TimeUnit value={timeLeft.seconds} label="s" />
      </div>
      
      {/* Progress ring */}
      <div className="relative w-6 h-6">
        <svg className="w-6 h-6 transform -rotate-90">
          <circle
            cx="12"
            cy="12"
            r="10"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-surface-light"
          />
          <circle
            cx="12"
            cy="12"
            r="10"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray={`${2 * Math.PI * 10}`}
            strokeDashoffset={`${2 * Math.PI * 10 * (1 - timeLeft.total / (5 * 60 * 1000))}`}
            className={cn(
              'transition-all duration-1000',
              isCritical ? 'text-short' : isUrgent ? 'text-warning' : 'text-accent'
            )}
          />
        </svg>
      </div>
    </div>
  );
}

function TimeUnit({ value, label }: { value: number; label: string }) {
  return (
    <span className="tabular-nums">
      {value.toString().padStart(2, '0')}
      <span className="text-text-muted text-xs">{label}</span>
    </span>
  );
}

// Larger countdown for prominent display
export function CountdownLarge({ expiryTime, onExpire, className }: CountdownProps) {
  const [timeLeft, setTimeLeft] = useState<{ hours: number; minutes: number; seconds: number; total: number } | null>(null);

  useEffect(() => {
    function calculateTimeLeft() {
      const diff = expiryTime - Date.now();
      if (diff <= 0) return { hours: 0, minutes: 0, seconds: 0, total: 0 };
      
      return {
        hours: Math.floor(diff / 3600000),
        minutes: Math.floor((diff % 3600000) / 60000),
        seconds: Math.floor((diff % 60000) / 1000),
        total: diff,
      };
    }

    setTimeLeft(calculateTimeLeft());

    const timer = setInterval(() => {
      const newTimeLeft = calculateTimeLeft();
      setTimeLeft(newTimeLeft);
      
      if (newTimeLeft.total <= 0) {
        clearInterval(timer);
        onExpire?.();
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [expiryTime, onExpire]);

  if (!timeLeft) {
    return (
      <div className={cn('flex flex-col items-center gap-1 p-4 rounded-lg bg-surface-light', className)}>
        <span className="text-xs text-text-muted uppercase tracking-wider">Expires In</span>
        <div className="flex items-center gap-2 font-mono text-2xl font-bold text-text-muted">
          --:--
        </div>
      </div>
    );
  }

  const isUrgent = timeLeft.total < 60000;
  const isCritical = timeLeft.total < 30000;

  return (
    <div className={cn(
      'flex flex-col items-center gap-1 p-4 rounded-lg bg-surface-light',
      isCritical && 'ring-2 ring-short animate-pulse',
      isUrgent && !isCritical && 'ring-2 ring-warning',
      className
    )}>
      <span className="text-xs text-text-muted uppercase tracking-wider">Expires In</span>
      <div className={cn(
        'flex items-center gap-2 font-mono text-2xl font-bold',
        isCritical ? 'text-short' : isUrgent ? 'text-warning' : 'text-text-primary'
      )}>
        {timeLeft.hours > 0 && (
          <>
            <span>{timeLeft.hours.toString().padStart(2, '0')}</span>
            <span className="text-text-muted">:</span>
          </>
        )}
        <span>{timeLeft.minutes.toString().padStart(2, '0')}</span>
        <span className="text-text-muted">:</span>
        <span>{timeLeft.seconds.toString().padStart(2, '0')}</span>
      </div>
      {isCritical && (
        <span className="text-xs text-short font-medium">CLOSING SOON</span>
      )}
    </div>
  );
}
