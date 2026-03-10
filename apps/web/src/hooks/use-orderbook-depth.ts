"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-client";
import { api } from "@/lib/api";
import { visibleRefetchInterval } from "@/lib/polling";

export function useOrderBookDepth(
  marketId: string,
  outcomeIndex: number,
  depth = 8,
) {
  return useQuery({
    queryKey: queryKeys.orderbook(marketId, outcomeIndex, depth),
    queryFn: () =>
      api.getMarketOrderBook(marketId, {
        outcomeIndex,
        depth,
      }),
    enabled: !!marketId,
    staleTime: 8_000,
    refetchInterval: () => visibleRefetchInterval(15_000),
  });
}

