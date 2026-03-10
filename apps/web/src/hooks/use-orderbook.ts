"use client";

import { useEffect } from "react";
import { useAppStore } from "./use-store";

/**
 * Subscribe to real-time market data channels for a specific market.
 *
 * This hook manages channel subscriptions via the Zustand store.
 * The actual WebSocket connection and message handling is done by
 * the global useGlobalWebSocket hook mounted in Providers.
 */
export function useMarketStream(
  marketId: string | null,
  outcomeCount: number = 2,
) {
  const subscribeChannels = useAppStore((s) => s.subscribeChannels);
  const unsubscribeChannels = useAppStore((s) => s.unsubscribeChannels);

  useEffect(() => {
    if (!marketId) return;

    const safeOutcomeCount = Number.isFinite(outcomeCount)
      ? Math.max(2, Math.min(32, Math.floor(outcomeCount)))
      : 2;

    const channels = [
      ...Array.from({ length: safeOutcomeCount }, (_, i) => `price:${marketId}:${i}`),
      `trades:${marketId}`,
    ];

    subscribeChannels(channels);

    return () => {
      unsubscribeChannels(channels);
    };
  }, [marketId, outcomeCount, subscribeChannels, unsubscribeChannels]);
}
