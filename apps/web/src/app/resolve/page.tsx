"use client";

import { useState } from "react";
import { ShieldCheck, Clock, Spinner, CheckCircle, Warning } from "@phosphor-icons/react";
import { PageTransition } from "@/components/ui/page-transition";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useAppStore } from "@/hooks/use-store";
import { useMarkets } from "@/hooks/use-market";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

const ADMIN_ADDRESS = process.env.NEXT_PUBLIC_ADMIN_ADDRESS?.toLowerCase();

function normalizeAddress(addr: string): string {
  // Strip 0x, remove leading zeros, lowercase
  return "0x" + addr.replace(/^0x0*/i, "").toLowerCase();
}

export default function ResolvePage() {
  const wallet = useAppStore((s) => s.wallet);
  const isConnected = !!wallet.address;
  const isAdmin =
    isConnected &&
    !!ADMIN_ADDRESS &&
    normalizeAddress(wallet.address!) === normalizeAddress(ADMIN_ADDRESS);

  const { data, isLoading } = useMarkets();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<{
    marketId: string;
    outcomeIndex: number;
    outcomeLabel: string;
    question: string;
  } | null>(null);

  // Filter to markets past their resolution time that haven't been resolved
  const now = Math.floor(Date.now() / 1000);
  const resolvableMarkets = (data?.items ?? []).filter(
    (m) => m.resolutionTime <= now && !m.resolved && !m.voided,
  );

  const handleResolve = async (marketId: string, winningOutcome: number) => {
    setPendingAction(`${marketId}-${winningOutcome}`);
    setConfirmTarget(null);
    try {
      const result = await api.resolveMarket(marketId, winningOutcome);
      toast({
        title: "Market resolved",
        description: `Tx: ${result.txHash.slice(0, 10)}...${result.txHash.slice(-6)}`,
      });
      // Refetch markets to update the list
      queryClient.invalidateQueries({ queryKey: ["markets"] });
    } catch (err) {
      toast({
        title: "Resolution failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setPendingAction(null);
    }
  };

  // Not connected
  if (!isConnected) {
    return (
      <div className="container mx-auto flex max-w-screen-xl flex-col items-center justify-center px-4 py-20">
        <ShieldCheck className="mb-4 h-8 w-8 text-muted-foreground" weight="duotone" />
        <h2 className="mb-2 text-lg font-bold font-mono tracking-wider">Connect Wallet</h2>
        <p className="text-[11px] font-mono text-muted-foreground tracking-wider">
          Admin wallet required for resolution dashboard
        </p>
      </div>
    );
  }

  // Connected but not admin
  if (!isAdmin) {
    return (
      <div className="container mx-auto flex max-w-screen-xl flex-col items-center justify-center px-4 py-20">
        <Warning className="mb-4 h-8 w-8 text-no" weight="fill" />
        <h2 className="mb-2 text-lg font-bold font-mono tracking-wider text-no">Access Denied</h2>
        <p className="text-[11px] font-mono text-muted-foreground tracking-wider">
          Restricted to admin address only
        </p>
      </div>
    );
  }

  return (
    <PageTransition>
    <div className="container mx-auto max-w-screen-xl px-4 py-6">
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" weight="duotone" />
          <h1 className="font-heading text-xl font-bold tracking-wider">Resolve Markets</h1>
        </div>
        <p className="text-[10px] font-mono text-muted-foreground mt-0.5 tracking-wider">
          Select winning outcome — resolution is irreversible
        </p>
      </div>

      {/* Confirmation dialog */}
      {confirmTarget && (
        <div className="mb-4 rounded border border-cyan/30 bg-cyan/5 p-4">
          <p className="mb-3 text-xs font-mono">
            Resolve &ldquo;{confirmTarget.question}&rdquo; as{" "}
            <span className="font-bold text-cyan">
              {confirmTarget.outcomeLabel}
            </span>
            ?
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="default"
              onClick={() =>
                handleResolve(
                  confirmTarget.marketId,
                  confirmTarget.outcomeIndex,
                )
              }
            >
              Confirm Resolution
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirmTarget(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Spinner className="h-6 w-6 animate-spin text-muted-foreground" weight="bold" />
        </div>
      ) : resolvableMarkets.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-sm text-muted-foreground">
          <CheckCircle className="mb-3 h-8 w-8 text-muted-foreground" weight="fill" />
          <p>All markets are up to date. Nothing to resolve.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {resolvableMarkets.map((market) => {
            const expired = new Date(market.resolutionTime * 1000);
            const ago = Math.floor((Date.now() - expired.getTime()) / 60_000);
            const agoLabel =
              ago < 60
                ? `${ago}m ago`
                : ago < 1440
                  ? `${Math.floor(ago / 60)}h ago`
                  : `${Math.floor(ago / 1440)}d ago`;

            return (
              <Card key={market.id}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-center gap-2">
                        <Badge variant="outline" className="border-amber/30 bg-amber/10 text-amber">
                          Ended {agoLabel}
                        </Badge>
                        <Badge variant="outline">{market.category}</Badge>
                      </div>
                      <h3 className="text-sm font-medium mt-1">
                        {market.question}
                      </h3>
                      <div className="mt-1 flex items-center gap-3 text-[10px] font-mono text-muted-foreground tracking-wider">
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" weight="bold" />
                          {expired.toLocaleString("en-US", {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        <span>Vol: ${(Number(market.totalVolume) / 1e6).toFixed(2)}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {market.outcomes.map((outcome, i) => {
                        const actionKey = `${market.id}-${i}`;
                        const isPending = pendingAction === actionKey;
                        return (
                          <Button
                            key={i}
                            variant={i === 0 ? "yes" : "no"}
                            size="sm"
                            disabled={pendingAction !== null}
                            onClick={() =>
                              setConfirmTarget({
                                marketId: market.id,
                                outcomeIndex: i,
                                outcomeLabel: outcome.label,
                                question: market.question,
                              })
                            }
                          >
                            {isPending && (
                              <Spinner className="mr-1 h-3.5 w-3.5 animate-spin" weight="bold" />
                            )}
                            {outcome.label}
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
    </PageTransition>
  );
}
