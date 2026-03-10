"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-client";
import { api } from "@/lib/api";
import { visibleRefetchInterval } from "@/lib/polling";

/**
 * Fetch pre-trade liquidity quote for a market outcome.
 * Returns max available tokens (CLOB + AMM combined).
 *
 * Refetches every 10s and on outcome/side change.
 */
export function useQuote(
  marketId: string,
  outcomeIndex: number,
  side: "BUY" | "SELL" = "BUY",
  amount?: number,
) {
  const normalizedAmount =
    amount !== undefined && Number.isFinite(amount) && amount > 0
      ? Math.floor(amount * 100) / 100
      : undefined;

  return useQuery({
    queryKey: queryKeys.liquidityQuote(
      marketId,
      outcomeIndex,
      side,
      normalizedAmount,
    ),
    queryFn: () =>
      api.getMarketQuote(marketId, {
        outcomeIndex,
        side,
        amount: normalizedAmount,
      }),
    enabled: !!marketId,
    staleTime: 8_000,
    refetchInterval: () => visibleRefetchInterval(15_000),
  });
}
