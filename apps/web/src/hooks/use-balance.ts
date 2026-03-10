"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-client";
import { api } from "@/lib/api";
import { visibleRefetchInterval } from "@/lib/polling";
import { useWallet } from "./use-wallet";

export function useBalance(tokenAddress: string | undefined) {
  const { address, isConnected } = useWallet();

  return useQuery({
    queryKey: queryKeys.balance(address ?? "", tokenAddress ?? ""),
    queryFn: () => api.getBalance(address!, tokenAddress!),
    enabled: isConnected && !!address && !!tokenAddress,
    staleTime: 15_000,
    refetchInterval: () => visibleRefetchInterval(20_000),
  });
}
