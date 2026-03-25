"use client";

import React, { useState } from "react";
import { Spinner, ArrowSquareOut } from "@phosphor-icons/react";
import type { Trade } from "@market-zap/shared";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useTradeHistory } from "@/hooks/use-portfolio";
import { TradeProofDialog, type TradeProof } from "@/components/trading/trade-proof-dialog";

function formatDate(ts: string) {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TradeHistory() {
  const { data, isLoading } = useTradeHistory();
  const trades = data?.trades ?? [];
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const selectedTrade = selectedTradeId
    ? trades.find((trade) => trade.id === selectedTradeId) ?? null
    : null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner className="h-5 w-5 animate-spin text-muted-foreground" weight="bold" />
      </div>
    );
  }

  if (trades.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <p className="text-sm text-muted-foreground">No trades yet</p>
        </CardContent>
      </Card>
    );
  }

  function toTradeProof(trade: Trade): TradeProof {
    const side = parseFloat(trade.price) >= 0.5 ? "buy" : "sell";

    return {
      id: trade.id,
      price: trade.price,
      amount: trade.amount,
      fee: trade.fee,
      side,
      outcome: trade.outcomeIndex === 0 ? "Yes" : "No",
      timestamp: trade.timestamp,
      txHash: trade.txHash,
      settled: trade.settled,
      settlementStatus: trade.settlementStatus,
      settlementError: trade.settlementError,
      maker: trade.maker,
      taker: trade.taker,
    };
  }

  function handleRowClick(trade: (typeof trades)[number]) {
    setSelectedTradeId(trade.id);
    setDialogOpen(true);
  }

  return (
    <>
      <Card>
        <CardContent className="p-0">
          <div className="divide-y md:hidden">
            {trades.map((trade) => {
              const side = parseFloat(trade.price) >= 0.5 ? "buy" : "sell";

              return (
                <button
                  key={`${trade.id}-mobile`}
                  onClick={() => handleRowClick(trade)}
                  className="w-full space-y-3 p-4 text-left transition-colors hover:bg-muted/40"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {trade.marketId}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatDate(trade.timestamp)}
                      </p>
                    </div>
                    <Badge variant={side === "buy" ? "yes" : "no"}>
                      {side}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-3 gap-3 text-xs">
                    <div>
                      <div className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">Price</div>
                      <div className="font-mono text-sm text-foreground">
                        {(parseFloat(trade.price) * 100).toFixed(1)}%
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">Shares</div>
                      <div className="font-mono text-sm text-foreground">
                        {trade.amount}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">Fee</div>
                      <div className="font-mono text-sm text-foreground">
                        ${trade.fee ?? "0"}
                      </div>
                    </div>
                  </div>

                  <div className="text-xs">
                    {trade.settlementStatus === "settled" ? (
                      <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                        <ArrowSquareOut className="h-3 w-3" />
                        Settled on-chain
                      </span>
                    ) : trade.settlementStatus === "failed" ? (
                      <span className="text-destructive">Settlement failed</span>
                    ) : (
                      <span className="text-yellow-600 dark:text-yellow-400">
                        Settlement pending
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="hidden overflow-x-auto md:block">
            <table className="w-full">
              <thead>
                <tr className="border-b text-left text-[10px] font-mono font-bold tracking-wider text-muted-foreground">
                  <th className="px-4 py-3">Market</th>
                  <th className="px-4 py-3">Side</th>
                  <th className="px-4 py-3 text-right">Price</th>
                  <th className="px-4 py-3 text-right">Shares</th>
                  <th className="px-4 py-3 text-right">Fee</th>
                  <th className="px-4 py-3 text-right">Status</th>
                  <th className="px-4 py-3 text-right">Date</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((trade) => {
                  const side = parseFloat(trade.price) >= 0.5 ? "buy" : "sell";
                  return (
                    <tr
                      key={trade.id}
                      onClick={() => handleRowClick(trade)}
                      className="border-b last:border-0 hover:bg-muted/50 transition-colors cursor-pointer"
                    >
                      <td className="max-w-[200px] truncate px-4 py-3 text-sm font-medium">
                        {trade.marketId}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={side === "buy" ? "yes" : "no"}>
                          {side}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-sm">
                        {(parseFloat(trade.price) * 100).toFixed(1)}%
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-sm">
                        {trade.amount}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-sm text-muted-foreground">
                        ${trade.fee ?? "0"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {trade.settlementStatus === "settled" ? (
                          <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                            <ArrowSquareOut className="h-3 w-3" />
                            on-chain
                          </span>
                        ) : trade.settlementStatus === "failed" ? (
                          <span className="text-xs text-destructive">failed</span>
                        ) : (
                          <span className="text-xs text-yellow-600 dark:text-yellow-400">pending</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-xs text-muted-foreground">
                        {formatDate(trade.timestamp)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <TradeProofDialog
        trade={selectedTrade ? toTradeProof(selectedTrade) : null}
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setSelectedTradeId(null);
        }}
      />
    </>
  );
}
