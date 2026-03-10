"use client";

import React from "react";
import { Timer } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

interface CountdownProps {
  /** Unix timestamp (seconds) when market closes */
  endsAt: number;
  /** Compact mode for cards (no icon, shorter text) */
  compact?: boolean;
  className?: string;
}

function computeRemaining(endsAt: number, now: number) {
  const diff = endsAt - now;
  if (diff <= 0) return null;

  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  const seconds = diff % 60;

  return { days, hours, minutes, seconds, total: diff };
}

function formatCountdown(
  r: { days: number; hours: number; minutes: number; seconds: number },
  compact: boolean,
) {
  if (r.days > 0) {
    return compact
      ? `${r.days}d ${r.hours}h`
      : `${r.days}d ${r.hours}h ${r.minutes}m`;
  }
  if (r.hours > 0) {
    return compact
      ? `${r.hours}h ${r.minutes}m`
      : `${r.hours}h ${r.minutes}m ${r.seconds}s`;
  }
  return `${r.minutes}m ${r.seconds}s`;
}

// Shared global second ticker for all Countdown instances.
let nowSeconds = Math.floor(Date.now() / 1000);
const listeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

function startTicker(): void {
  if (ticker) return;
  ticker = setInterval(() => {
    nowSeconds = Math.floor(Date.now() / 1000);
    for (const listener of listeners) {
      listener();
    }
  }, 1000);
}

function stopTicker(): void {
  if (!ticker || listeners.size > 0) return;
  clearInterval(ticker);
  ticker = null;
}

function subscribeClock(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    startTicker();
  }
  return () => {
    listeners.delete(listener);
    stopTicker();
  };
}

function subscribeNoop(): () => void {
  return () => {};
}

export function Countdown({ endsAt, compact = false, className }: CountdownProps) {
  const clockActive = endsAt > 0;
  const now = React.useSyncExternalStore(
    clockActive ? subscribeClock : subscribeNoop,
    () => nowSeconds,
    () => nowSeconds,
  );
  const remaining = clockActive ? computeRemaining(endsAt, now) : null;

  if (!endsAt || endsAt <= 0) {
    return (
      <span className={cn("text-muted-foreground", className)}>TBD</span>
    );
  }

  if (!remaining) {
    return (
      <span className={cn("font-medium text-no", className)}>Ended</span>
    );
  }

  // Urgent = less than 1 hour
  const urgent = remaining.total < 3600;
  // Warning = less than 24 hours
  const warning = remaining.total < 86400;

  return (
    <span
      className={cn(
        "font-mono tabular-nums",
        urgent ? "font-medium text-no" : warning ? "text-amber" : "text-muted-foreground",
        className,
      )}
    >
      {!compact && <Timer className="mr-1 inline h-3.5 w-3.5" weight="duotone" />}
      {formatCountdown(remaining, compact)}
    </span>
  );
}
