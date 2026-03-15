"use client";

import { useMemo } from "react";
import { WarningCircle, Spinner, X } from "@phosphor-icons/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useMyOrders } from "@/hooks/use-my-orders";
import { useCancelOrder } from "@/hooks/use-order";
import { useToast } from "@/hooks/use-toast";
import { useWallet } from "@/features/wallet/use-wallet";
import { useAppStore } from "@/hooks/use-store";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-client";
import { getTokenByAddress } from "@market-zap/shared";
import type { OpenOrderEntry } from "@market-zap/shared";

interface MyOrdersProps {
  marketId?: string;
  collateralToken?: string;
}

export function MyOrders({ marketId, collateralToken }: MyOrdersProps) {
  const { data, isLoading, isError } = useMyOrders(marketId);
  const { address } = useWallet();
  const cancelOrder = useCancelOrder();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const decimals = useMemo(() => {
    if (!collateralToken) return 6; // USDC default
    const token = getTokenByAddress(collateralToken, "sepolia");
    return token?.decimals ?? 6;
  }, [collateralToken]);

  const formatAmount = (raw: string) => {
    const num = Number(raw) / 10 ** decimals;
    return num.toFixed(2);
  };

  const handleCancel = (order: OpenOrderEntry) => {
    if (!address) return;
    const signature = useAppStore.getState().orderSignatures[order.nonce];
    if (!signature) {
      toast({
        title: "Cannot cancel",
        description: "Order signature not found. Orders submitted before this update cannot be cancelled from the UI.",
        variant: "destructive",
      });
      return;
    }
    cancelOrder.mutate({ nonce: order.nonce, user: address, signature }, {
      onSuccess: () => {
        toast({ title: "Order cancelled" });
        queryClient.invalidateQueries({
          queryKey: queryKeys.orders.open(address ?? "", marketId),
        });
      },
      onError: (err) => {
        toast({
          title: "Cancel failed",
          description: err instanceof Error ? err.message : "Something went wrong",
          variant: "destructive",
        });
      },
    });
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Spinner className="h-5 w-5 animate-spin text-muted-foreground" weight="bold" />
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <WarningCircle className="h-4 w-4" weight="fill" />
          Failed to load orders
        </CardContent>
      </Card>
    );
  }

  const orders = data?.items ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">
          Open orders{orders.length > 0 ? ` (${orders.length})` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {orders.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-xs text-muted-foreground">No open orders</p>
            <p className="mt-1 text-[10px] text-muted-foreground/60">
              Limit orders you place will appear here until they are filled or cancelled.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-3 md:hidden">
              {orders.map((order) => (
                <div
                  key={`${order.nonce}-mobile`}
                  className="rounded border p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div
                        className={
                          order.side === "BID"
                            ? "text-sm font-medium text-yes"
                            : "text-sm font-medium text-no"
                        }
                      >
                        {order.side === "BID" ? "Buy" : "Sell"} {order.orderType.toLowerCase()}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Nonce {order.nonce}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => handleCancel(order)}
                      disabled={cancelOrder.isPending}
                    >
                      <X className="h-3.5 w-3.5" weight="bold" />
                    </Button>
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
                    <div>
                      <div className="text-muted-foreground">Price</div>
                      <div className="font-mono text-sm text-foreground">
                        {(Number(order.price) * 100).toFixed(1)}%
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Amount</div>
                      <div className="font-mono text-sm text-foreground">
                        {formatAmount(order.amount)}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Filled</div>
                      <div className="font-mono text-sm text-foreground">
                        {formatAmount(order.filledAmount)}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="hidden grid-cols-6 gap-2 px-1 text-[10px] font-mono font-bold tracking-wider text-muted-foreground md:grid">
              <span>Side</span>
              <span>Type</span>
              <span className="text-right">Price</span>
              <span className="text-right">Amount</span>
              <span className="text-right">Filled</span>
              <span />
            </div>
            <div className="hidden space-y-2 md:block">
              {orders.map((order) => (
                <div
                  key={order.nonce}
                  className="grid grid-cols-6 items-center gap-2 rounded border px-2 py-1.5 text-xs"
                >
                  <span
                    className={
                      order.side === "BID"
                        ? "font-medium text-yes"
                        : "font-medium text-no"
                    }
                  >
                    {order.side === "BID" ? "Buy" : "Sell"}
                  </span>
                  <span className="capitalize">
                    {order.orderType.toLowerCase()}
                  </span>
                  <span className="text-right font-mono">
                    {(Number(order.price) * 100).toFixed(1)}%
                  </span>
                  <span className="text-right font-mono">{formatAmount(order.amount)}</span>
                  <span className="text-right font-mono text-muted-foreground">
                    {formatAmount(order.filledAmount)}
                  </span>
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => handleCancel(order)}
                      disabled={cancelOrder.isPending}
                    >
                      <X className="h-3.5 w-3.5" weight="bold" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
