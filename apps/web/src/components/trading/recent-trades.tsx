"use client";

import React, { useState } from "react";
import { ArrowUp, ArrowDown, Spinner, Warning } from "@phosphor-icons/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { TradeProofDialog, type TradeProof } from "./trade-proof-dialog";

interface Trade {
  id?: string;
  price: string;
  amount: string;
  side: "buy" | "sell";
  timestamp: number;
  outcome: string;
  settled?: boolean;
  settlementStatus?: "pending" | "settled" | "failed";
  settlementError?: string | null;
  txHash?: string | null;
  fee?: string;
}

interface RecentTradesProps {
  trades: Trade[];
}

function formatTime(ts: number) {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export const RecentTrades = React.memo(function RecentTrades({ trades }: RecentTradesProps) {
  const [selectedTradeKey, setSelectedTradeKey] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Show all trades — failed ones get a distinct status indicator
  const visibleTrades = trades;
  const selectedTrade = selectedTradeKey
    ? visibleTrades.find((trade) => getTradeKey(trade) === selectedTradeKey) ?? null
    : null;

  function getTradeKey(trade: Trade): string {
    return trade.id ?? `${trade.timestamp}`;
  }

  function toTradeProof(trade: Trade): TradeProof {
    return {
      id: trade.id ?? `${trade.timestamp}`,
      price: trade.price,
      amount: trade.amount,
      fee: trade.fee,
      side: trade.side,
      outcome: trade.outcome,
      timestamp: new Date(trade.timestamp * 1000).toISOString(),
      txHash: trade.txHash ?? null,
      settled: trade.settled ?? true,
      settlementStatus: trade.settlementStatus,
      settlementError: trade.settlementError,
    };
  }

  function handleTradeClick(trade: Trade) {
    setSelectedTradeKey(getTradeKey(trade));
    setDialogOpen(true);
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">Recent trades</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Header */}
          <div className="mb-1 grid grid-cols-4 gap-2 text-[10px] font-mono font-bold tracking-wider text-muted-foreground">
            <span>Price</span>
            <span>Shares</span>
            <span>Side</span>
            <span className="text-right">Time</span>
          </div>

          {/* Trade rows */}
          <div className="max-h-[240px] space-y-0 overflow-y-auto scrollbar-thin">
            {visibleTrades.map((trade, i) => (
              <div
                key={`${trade.timestamp}-${i}`}
                onClick={() => handleTradeClick(trade)}
                className={cn(
                  "grid grid-cols-4 gap-2 rounded px-1 py-1 text-xs font-mono cursor-pointer hover:bg-muted/50 transition-colors",
                  i === 0 &&
                    (trade.side === "buy"
                      ? "bg-yes/5"
                      : "bg-no/5")
                )}
              >
                <span
                  className={cn(
                    "font-medium",
                    trade.side === "buy" ? "text-yes" : "text-no"
                  )}
                >
                  {(parseFloat(trade.price) * 100).toFixed(1)}%
                </span>
                <span>{trade.amount}</span>
                <span className="flex items-center gap-0.5">
                  {trade.side === "buy" ? (
                    <ArrowUp className="h-3 w-3 text-yes" weight="bold" />
                  ) : (
                    <ArrowDown className="h-3 w-3 text-no" weight="bold" />
                  )}
                  {trade.outcome}
                </span>
                <span className={cn(
                  "text-right flex items-center justify-end gap-1",
                  trade.settlementStatus === "failed" ? "text-destructive" : "text-muted-foreground",
                )}>
                  {trade.settlementStatus === "failed" ? (
                    <>
                      <Warning className="h-3 w-3" weight="bold" />
                      failed
                    </>
                  ) : trade.settled === false ? (
                    <>
                      <Spinner className="h-3 w-3 animate-spin" weight="bold" />
                      settling
                    </>
                  ) : (
                    formatTime(trade.timestamp)
                  )}
                </span>
              </div>
            ))}

            {visibleTrades.length === 0 && (
              <div className="py-6 text-center">
                <p className="text-xs text-muted-foreground">No trades yet</p>
                <p className="mt-1 text-[10px] text-muted-foreground/60">
                  Be the first to trade on this market. Place a buy or sell order using the panel on the right.
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <TradeProofDialog
        trade={selectedTrade ? toTradeProof(selectedTrade) : null}
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setSelectedTradeKey(null);
        }}
      />
    </>
  );
});
