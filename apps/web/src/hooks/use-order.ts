"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-client";
import { api } from "@/lib/api";
import { useAppStore } from "@/hooks/use-store";
import type { SubmitOrderInput } from "@market-zap/shared";

export function useSubmitOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (order: SubmitOrderInput) => api.submitOrder(order),

    onMutate: async (order) => {
      // Cancel outgoing balance refetches so they don't overwrite our
      // optimistic deduction.
      await queryClient.cancelQueries({ queryKey: ["balance"] });

      // Snapshot current balance queries for rollback on error.
      const balanceQueries = queryClient.getQueriesData<{
        available: string;
        [k: string]: unknown;
      }>({ queryKey: ["balance"] });

      // Optimistically deduct the estimated cost from displayed balance.
      if (order.side === "buy") {
        const estimatedCost = BigInt(
          Math.round(parseFloat(order.amount) * parseFloat(order.price)),
        );
        for (const [key, data] of balanceQueries) {
          if (data && key[1] === order.maker) {
            const available = BigInt(data.available || "0");
            const newAvailable =
              available > estimatedCost ? available - estimatedCost : 0n;
            queryClient.setQueryData(key, {
              ...data,
              available: newAvailable.toString(),
            });
          }
        }
      }

      return { previousBalances: balanceQueries };
    },

    onError: (_err, _order, context) => {
      // Rollback optimistic balance deduction.
      if (context?.previousBalances) {
        for (const [key, data] of context.previousBalances) {
          queryClient.setQueryData(key, data);
        }
      }
    },

    onSuccess: (_data, order) => {
      // Save order signature for later cancel authentication.
      if (order.nonce && order.signature) {
        useAppStore.getState().saveOrderSignature(order.nonce, order.signature);
      }
      // Invalidate only affected query scopes to avoid global refetch storms.
      queryClient.invalidateQueries({
        queryKey: queryKeys.markets.detail(order.marketId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.markets.trades(order.marketId),
      });
      queryClient.invalidateQueries({
        queryKey: ["markets", "list"],
      });
      queryClient.invalidateQueries({
        queryKey: ["liquidity", order.marketId],
      });
      // Refresh open orders for this user
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.open(order.maker),
      });

      queryClient.invalidateQueries({
        predicate: (query) =>
          Array.isArray(query.queryKey) &&
          query.queryKey[0] === "balance" &&
          query.queryKey[1] === order.maker,
      });
      queryClient.invalidateQueries({
        predicate: (query) =>
          Array.isArray(query.queryKey) &&
          query.queryKey[0] === "portfolio" &&
          query.queryKey[1] === order.maker,
      });
    },

    onSettled: (_data, _err, order) => {
      // Always refresh the submitting wallet's balances.
      queryClient.invalidateQueries({
        predicate: (query) =>
          Array.isArray(query.queryKey) &&
          query.queryKey[0] === "balance" &&
          query.queryKey[1] === order.maker,
      });
    },
  });
}

export function useCancelOrder() {
  return useMutation({
    mutationFn: ({ nonce, user, signature }: { nonce: string; user: string; signature: string }) =>
      api.cancelOrder(nonce, user, signature),
    onSuccess: (_data, { nonce }) => {
      useAppStore.getState().removeOrderSignature(nonce);
    },
  });
}
