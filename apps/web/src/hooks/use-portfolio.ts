"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-client";
import { api } from "@/lib/api";
import { useWallet } from "@/features/wallet/use-wallet";
import {
  getCartridgeClient,
  getClient,
  restoreWalletConnection,
} from "@/features/wallet/wallet-client";
import { useAppStore } from "./use-store";

export function usePortfolio() {
  const { address, isConnected } = useWallet();

  return useQuery({
    queryKey: queryKeys.portfolio.all(address ?? ""),
    queryFn: () => api.getPortfolio(address!),
    enabled: isConnected && !!address,
    staleTime: 15_000,
  });
}

export function useTradeHistory(limit = 50, offset = 0) {
  const { address, isConnected } = useWallet();

  return useQuery({
    queryKey: queryKeys.portfolio.history(address ?? ""),
    queryFn: () => api.getTradeHistory(address!, { limit, offset }),
    enabled: isConnected && !!address,
    staleTime: 15_000,
  });
}

export function useClaimableRewards() {
  const { address, isConnected } = useWallet();

  return useQuery({
    queryKey: queryKeys.portfolio.claimable(address ?? ""),
    queryFn: () => api.getClaimableRewards(address!),
    enabled: isConnected && !!address,
    staleTime: 30_000,
  });
}

/**
 * Attempt to re-establish the StarkZap client account from the persisted
 * wallet provider. This handles the case where the Zustand store hydrated
 * from localStorage (so the UI shows "connected") but the in-memory
 * StarkZap singleton lost its `account` reference (e.g. after page refresh).
 */
async function ensureStarkZapConnected(): Promise<boolean> {
  const store = useAppStore.getState();
  try {
    const client = await restoreWalletConnection(
      store.wallet,
      store.setWallet,
      store.disconnectWallet,
    );
    return client !== null;
  } catch {
    store.disconnectWallet();
  }
  return false;
}

export function useClaimReward() {
  const { address } = useWallet();
  const queryClient = useQueryClient();
  const walletProvider = useAppStore((s) => s.wallet.provider);

  return useMutation({
    mutationFn: async ({
      collateralToken,
      conditionId,
      marketId,
      outcomeIndex,
    }: {
      collateralToken: string;
      conditionId: string;
      marketId: string;
      outcomeIndex: number;
    }) => {
      // Ensure StarkZap client has the account before attempting on-chain call
      const connected = await ensureStarkZapConnected();
      if (!connected) {
        throw new Error(
          "Wallet not connected. Please reconnect your wallet and try again.",
        );
      }

      // Use the correct client for the current provider
      const client = walletProvider === "cartridge"
        ? await getCartridgeClient()
        : await getClient();
      const result = await client.redeemPosition(collateralToken, conditionId);
      if (!result.success) {
        throw new Error(result.error ?? "Claim failed");
      }

      return {
        ...result,
        marketId,
        outcomeIndex,
      };
    },
    onSuccess: (_result, variables) => {
      if (address) {
        queryClient.setQueryData(
          queryKeys.portfolio.claimable(address),
          (
            current:
              | Array<{ marketId: string; outcomeIndex: number }>
              | undefined,
          ) =>
            current?.filter(
              (reward) =>
                !(
                  reward.marketId === variables.marketId &&
                  reward.outcomeIndex === variables.outcomeIndex
                ),
            ) ?? [],
        );
      }
      queryClient.invalidateQueries({ queryKey: ["balance"] });
      queryClient.invalidateQueries({ queryKey: ["wallet-balance"] });
      queryClient.invalidateQueries({ queryKey: ["exchange-balance"] });
      if (address) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.portfolio.all(address),
        });
      }
      queryClient.invalidateQueries({ queryKey: ["outcome-token"] });
    },
  });
}
