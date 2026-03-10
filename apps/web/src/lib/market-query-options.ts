import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-client";
import type { GetMarketsParams } from "@market-zap/shared";

export const DEFAULT_MARKETS_QUERY_FILTERS = Object.freeze({
  category: undefined,
  search: undefined,
  sortBy: "volume",
  sortOrder: "desc",
}) satisfies GetMarketsParams;

export function getMarketsQueryOptions(
  filters: GetMarketsParams = DEFAULT_MARKETS_QUERY_FILTERS,
) {
  return queryOptions({
    queryKey: queryKeys.markets.list(filters),
    queryFn: () => api.getMarkets(filters),
    staleTime: 30_000,
  });
}

export function getMarketQueryOptions(id: string) {
  return queryOptions({
    queryKey: queryKeys.markets.detail(id),
    queryFn: () => api.getMarket(id),
    enabled: !!id,
  });
}

export function getMarketTradesQueryOptions(id: string) {
  return queryOptions({
    queryKey: queryKeys.markets.trades(id),
    queryFn: () => api.getMarketTrades(id),
    enabled: !!id,
    staleTime: 10_000,
  });
}
