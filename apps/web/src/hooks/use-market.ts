"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-client";
import { api } from "@/lib/api";
import {
  getMarketQueryOptions,
  getMarketsQueryOptions,
  getMarketTradesQueryOptions,
} from "@/lib/market-query-options";
import type { GetMarketsParams } from "@market-zap/shared";

export function useMarkets(filters?: GetMarketsParams) {
  return useQuery(getMarketsQueryOptions(filters));
}

export function useMarket(
  id: string,
  options?: { refetchInterval?: number | false },
) {
  return useQuery({
    ...getMarketQueryOptions(id),
    refetchInterval: options?.refetchInterval,
  });
}

export function useMarketStats(id: string) {
  return useQuery({
    queryKey: queryKeys.markets.stats(id),
    queryFn: () => api.getMarketStats(id),
    enabled: !!id,
    staleTime: 60_000,
  });
}

export function useMarketTrades(id: string) {
  return useQuery(getMarketTradesQueryOptions(id));
}

export function useMarketPrice(id: string) {
  return useQuery({
    queryKey: queryKeys.markets.price(id, -1),
    queryFn: () => api.getMarketPrice(id),
    enabled: !!id,
    staleTime: 5_000,
  });
}
