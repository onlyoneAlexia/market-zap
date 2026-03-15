"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CONTRACT_ADDRESSES } from "@market-zap/shared";
import { useWallet } from "@/features/wallet/use-wallet";
import { getClient, getClientSync } from "@/features/wallet/wallet-client";
import { visibleRefetchInterval } from "@/lib/polling";

const USDC_ADDRESS = CONTRACT_ADDRESSES.sepolia.USDC;

/**
 * Query on-chain balances directly via the StarkZap client.
 * Unlike use-balance.ts (which queries the engine API), this reads
 * directly from Starknet RPC so it reflects the most recent state.
 */

export function useWalletUSDCBalance(tokenAddress?: string) {
  const { address, isConnected } = useWallet();
  const token = tokenAddress || USDC_ADDRESS;

  return useQuery({
    queryKey: ["wallet-balance", token, address],
    queryFn: async () => {
      const client = getClientSync() ?? await getClient();
      const bal = await client.getTokenBalance(token, address!);
      // Return as string — BigInt can't be structurally shared by TanStack Query
      return bal.toString();
    },
    enabled: isConnected && !!address,
    staleTime: 15_000,
    refetchOnMount: "always",
    refetchInterval: () => visibleRefetchInterval(20_000),
  });
}

export function useExchangeBalance(tokenAddress?: string) {
  const { address, isConnected } = useWallet();
  const token = tokenAddress || USDC_ADDRESS;

  return useQuery({
    queryKey: ["exchange-balance", token, address],
    queryFn: async () => {
      const client = getClientSync() ?? await getClient();
      return client.getExchangeBalance(address!, token);
    },
    enabled: isConnected && !!address,
    staleTime: 15_000,
    refetchInterval: () => visibleRefetchInterval(20_000),
  });
}

export function useExchangeReserved(tokenAddress?: string) {
  const { address, isConnected } = useWallet();
  const token = tokenAddress || USDC_ADDRESS;

  return useQuery({
    queryKey: ["exchange-reserved", token, address],
    queryFn: async () => {
      const client = getClientSync() ?? await getClient();
      return client.getExchangeReserved(address!, token);
    },
    enabled: isConnected && !!address,
    staleTime: 15_000,
    refetchInterval: () => visibleRefetchInterval(20_000),
  });
}

export function useOutcomeTokenBalance(tokenId: bigint | undefined) {
  const { address, isConnected } = useWallet();

  return useQuery({
    queryKey: ["outcome-token", tokenId?.toString(), address],
    queryFn: async () => {
      const client = getClientSync() ?? await getClient();
      return client.getOutcomeTokenBalance(address!, tokenId!);
    },
    enabled: isConnected && !!address && tokenId !== undefined,
    staleTime: 15_000,
    refetchInterval: () => visibleRefetchInterval(20_000),
  });
}

/** Invalidate all on-chain balance queries to force refetch. */
export function useInvalidateBalances() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ["balance"] });
    queryClient.invalidateQueries({ queryKey: ["wallet-balance"] });
    queryClient.invalidateQueries({ queryKey: ["exchange-balance"] });
    queryClient.invalidateQueries({ queryKey: ["exchange-reserved"] });
    queryClient.invalidateQueries({ queryKey: ["outcome-token"] });
  };
}

/**
 * Poll balance queries after a transaction until data actually changes.
 * Returns a function that invalidates and then polls every `intervalMs`
 * for up to `maxWaitMs` to ensure updated data is reflected.
 *
 * This replaces the brittle fixed-delay pattern. Starknet nodes may take
 * variable time to index a block, especially across different RPC providers.
 */
export function useInvalidateAndPoll() {
  const queryClient = useQueryClient();

  return async (opts?: { intervalMs?: number; maxWaitMs?: number }) => {
    const interval = opts?.intervalMs ?? 2000;
    const maxWait = opts?.maxWaitMs ?? 15000;

    // Snapshot current cached balance values before invalidating
    const balanceKeys = ["balance", "wallet-balance", "exchange-balance", "exchange-reserved"];
    const snapshots = new Map<string, unknown>();
    for (const key of balanceKeys) {
      const queries = queryClient.getQueriesData({ queryKey: [key] });
      for (const [qk, data] of queries) {
        snapshots.set(JSON.stringify(qk), data);
      }
    }

    // Invalidate to trigger refetches
    for (const key of balanceKeys) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
    queryClient.invalidateQueries({ queryKey: ["outcome-token"] });

    // Poll until at least one balance value changes or timeout
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      await new Promise((r) => setTimeout(r, interval));

      let changed = false;
      for (const key of balanceKeys) {
        const queries = queryClient.getQueriesData({ queryKey: [key] });
        for (const [qk, data] of queries) {
          const prev = snapshots.get(JSON.stringify(qk));
          if (data !== undefined && JSON.stringify(data) !== JSON.stringify(prev)) {
            changed = true;
            break;
          }
        }
        if (changed) break;
      }

      if (changed) return;

      // Re-invalidate to force another fetch attempt
      for (const key of balanceKeys) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    }
  };
}
