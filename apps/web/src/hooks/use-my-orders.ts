"use client";

import { useQuery } from "@tanstack/react-query";
import { useWallet } from "@/features/wallet/use-wallet";
import { queryKeys } from "@/lib/query-client";
import { api } from "@/lib/api";
import { visibleRefetchInterval } from "@/lib/polling";
import type { OpenOrderEntry, PaginatedResponse } from "@market-zap/shared";

export function useMyOrders(marketId?: string) {
  const { address, isConnected } = useWallet();

  return useQuery<PaginatedResponse<OpenOrderEntry>>({
    queryKey: queryKeys.orders.open(address ?? "", marketId),
    queryFn: () =>
      api.getOpenOrders(address!, { limit: 50, marketId }),
    enabled: isConnected && !!address,
    staleTime: 15_000,
    refetchInterval: () => visibleRefetchInterval(15_000),
  });
}
