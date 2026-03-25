"use client";

import React from "react";
import { ArrowSquareOut, CheckCircle, Clock, XCircle, ShieldCheck } from "@phosphor-icons/react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

const VOYAGER_BASE = "https://sepolia.voyager.online";

export interface TradeProof {
  id: string;
  price: string;
  amount: string;
  fee?: string;
  side: "buy" | "sell";
  outcome: string;
  timestamp: string;
  txHash: string | null;
  settled: boolean;
  settlementStatus?: "pending" | "settled" | "failed";
  settlementError?: string | null;
  maker?: string;
  taker?: string;
}

interface TradeProofDialogProps {
  trade: TradeProof | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function truncateAddress(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

function StatusBadge({ status }: { status: "pending" | "settled" | "failed" | undefined }) {
  if (status === "settled") {
    return (
      <Badge className="border-yes/20 bg-yes/10 text-yes gap-1">
        <CheckCircle className="h-3.5 w-3.5" weight="fill" />
        Settled on-chain
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle className="h-3.5 w-3.5" weight="fill" />
        Settlement failed
      </Badge>
    );
  }
  return (
    <Badge className="border-amber/20 bg-amber/10 text-amber gap-1">
      <Clock className="h-3.5 w-3.5" weight="fill" />
      Pending settlement
    </Badge>
  );
}

export function TradeProofDialog({ trade, open, onOpenChange }: TradeProofDialogProps) {
  if (!trade) return null;

  const pricePct = (parseFloat(trade.price) * 100).toFixed(1);
  const voyagerTxUrl = trade.txHash ? `${VOYAGER_BASE}/tx/${trade.txHash}` : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-muted-foreground" weight="duotone" />
            Trade Proof
          </DialogTitle>
          <DialogDescription>
            On-chain settlement verification for this trade
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Settlement status */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Status</span>
            <StatusBadge status={trade.settlementStatus} />
          </div>

          {/* Trade details */}
          <div className="rounded border bg-card/30 p-3 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Side</span>
              <Badge variant={trade.side === "buy" ? "yes" : "no"}>
                {trade.side === "buy" ? "Buy" : "Sell"} {trade.outcome}
              </Badge>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Price</span>
              <span className="font-mono font-medium">{pricePct}%</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Shares</span>
              <span className="font-mono font-medium">{trade.amount}</span>
            </div>
            {trade.fee && parseFloat(trade.fee) > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Fee</span>
                <span className="font-mono font-medium">${trade.fee}</span>
              </div>
            )}
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Time</span>
              <span className="text-xs text-muted-foreground">
                {new Date(trade.timestamp).toLocaleString()}
              </span>
            </div>
          </div>

          {/* Tx hash */}
          {trade.txHash && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Tx Hash</span>
              <a
                href={voyagerTxUrl!}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 font-mono text-xs text-primary hover:underline"
              >
                {truncateAddress(trade.txHash)}
                <ArrowSquareOut className="h-3 w-3" weight="bold" />
              </a>
            </div>
          )}

          {/* Settlement error */}
          {trade.settlementStatus === "failed" && trade.settlementError && (
            <div className="rounded border border-no/30 bg-no/5 p-3">
              <p className="text-xs text-destructive">{trade.settlementError}</p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
