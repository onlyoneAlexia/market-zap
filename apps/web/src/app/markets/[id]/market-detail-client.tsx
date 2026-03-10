"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { Spinner, LockKey } from "@phosphor-icons/react";
import { MarketHeader } from "@/components/market/market-header";
import { LatencyBadge } from "@/components/trading/latency-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageTransition } from "@/components/ui/page-transition";
import { useMarketStream } from "@/hooks/use-orderbook";
import { useMarket, useMarketTrades } from "@/hooks/use-market";
import { MyOrders } from "@/components/trading/my-orders";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-client";
import { useMediaQuery } from "@/hooks/use-media-query";

const PriceChart = dynamic(
  () =>
    import("@/components/trading/price-chart").then((mod) => ({
      default: mod.PriceChart,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-[260px] items-center justify-center rounded-lg border bg-card">
        <Spinner className="h-5 w-5 animate-spin text-muted-foreground" weight="bold" />
      </div>
    ),
  },
);

const TradePanel = dynamic(
  () =>
    import("@/components/trading/trade-panel").then((mod) => ({
      default: mod.TradePanel,
    })),
  {
    loading: () => (
      <div className="flex min-h-[420px] items-center justify-center rounded-lg border bg-card">
        <Spinner className="h-5 w-5 animate-spin text-muted-foreground" weight="bold" />
      </div>
    ),
  },
);

const RecentTrades = dynamic(
  () =>
    import("@/components/trading/recent-trades").then((mod) => ({
      default: mod.RecentTrades,
    })),
  {
    loading: () => (
      <div className="flex min-h-[220px] items-center justify-center rounded-lg border bg-card">
        <Spinner className="h-5 w-5 animate-spin text-muted-foreground" weight="bold" />
      </div>
    ),
  },
);

function formatVolume(raw: string | undefined): string {
  const n = parseFloat(raw ?? "0") / 1e6;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function formatPct(price: string | null | undefined): string {
  if (!price) return "--";
  const n = Number(price);
  if (!Number.isFinite(n)) return "--";
  return `${(n * 100).toFixed(1)}%`;
}

export function MarketDetailClient({ id }: { id: string }) {
  const { data: market, isLoading, error } = useMarket(id);
  const { data: tradesData } = useMarketTrades(id);
  const isMobile = useMediaQuery("(max-width: 1023px)");

  useMarketStream(id, market?.outcomes.length ?? 2);

  const { data: quote0 } = useQuery<{
    bestBid: string | null;
    bestAsk: string | null;
    spread: string;
    lastPrice: string | null;
    lastTradeTime?: number;
  }>({
    queryKey: queryKeys.quote(id, 0),
    queryFn: async () => ({
      bestBid: null,
      bestAsk: null,
      spread: "0",
      lastPrice: null,
      lastTradeTime: 0,
    }),
    enabled: false,
  });

  const outcomes = useMemo(
    () => market?.outcomes.map((o) => o.label) ?? [],
    [market?.outcomes],
  );
  const prices = useMemo(
    () => market?.outcomes.map((o) => parseFloat(o.price)) ?? [],
    [market?.outcomes],
  );
  const trades = useMemo(
    () =>
      (tradesData?.items ?? []).map((t) => ({
        id: t.id,
        price: t.price,
        amount: t.amount,
        fee: t.fee,
        side: (parseFloat(t.price) >= 0.5 ? "buy" : "sell") as "buy" | "sell",
        timestamp: t.timestamp
          ? new Date(t.timestamp).getTime() / 1000
          : Date.now() / 1000,
        outcome: outcomes[t.outcomeIndex] ?? "Yes",
        settled: t.settled,
        settlementStatus: t.settlementStatus,
        settlementError: t.settlementError,
        txHash: t.txHash,
      })),
    [tradesData, outcomes],
  );

  if (isLoading) {
    return (
      <div className="container mx-auto max-w-screen-xl px-4 py-6">
        <div className="mb-6 space-y-3">
          <Skeleton className="h-8 w-3/4" />
          <div className="flex gap-2">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-20" />
          </div>
        </div>
        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
          <div className="space-y-6">
            <Skeleton className="h-[260px] w-full rounded-lg" />
            <Skeleton className="h-[120px] w-full rounded-lg" />
            <Skeleton className="h-[200px] w-full rounded-lg" />
          </div>
          <div className="space-y-6">
            <Skeleton className="h-[420px] w-full rounded-lg" />
            <Skeleton className="h-[160px] w-full rounded-lg" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !market) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-sm text-muted-foreground">
        <p>Market not found</p>
      </div>
    );
  }

  const isDark = market.marketType === "private";
  const bestBid = (quote0?.bestBid != null) ? formatPct(quote0.bestBid) : (prices[0] ? `${(prices[0] * 100).toFixed(1)}%` : "--");
  const bestAsk = (quote0?.bestAsk != null) ? formatPct(quote0.bestAsk) : (prices[0] ? `${(prices[0] * 100 + 1).toFixed(1)}%` : "--");
  const spread = quote0?.spread ? `${(Number(quote0.spread) * 100).toFixed(2)}%` : "1.0%";
  const tradePanelProps = {
    marketId: id,
    outcomes,
    prices,
    collateralToken: market.collateralToken,
    conditionId: market.conditionId ?? "",
    onChainMarketId: market.onChainMarketId ?? "",
    resolutionTime: market.resolutionTime,
    resolved: market.resolved,
    voided: market.voided,
    resolvedOutcomeIndex: market.resolvedOutcomeIndex,
  };

  return (
    <PageTransition>
      <div className="container mx-auto max-w-screen-xl px-4 py-6">
        {isDark ? (
          <div className="mb-4 flex items-center gap-2 rounded border border-cyan/20 bg-cyan/5 px-4 py-3 text-[11px] font-mono">
            <LockKey className="h-4 w-4 text-cyan" weight="duotone" />
            <span>
              <span className="font-bold tracking-wider text-cyan">Dark Pool</span>
              <span className="text-muted-foreground ml-2">Orders + identities hidden. AMM-derived pricing only.</span>
            </span>
          </div>
        ) : null}

        <MarketHeader
          question={market.question}
          category={market.category}
          volume={formatVolume(market.totalVolume)}
          traders={market.traders ?? 0}
          endsAt={market.resolutionTime}
          resolved={market.resolved}
          voided={market.voided}
        />

        {isMobile ? (
          <div className="mt-6">
            <TradePanel {...tradePanelProps} />
          </div>
        ) : null}

        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_360px]">
          <div className="space-y-6">
            <div className="relative">
              <PriceChart
                marketId={id}
                outcomes={outcomes}
                currentPrices={prices}
                isDark={isDark}
              />
              {isDark && (
                <div className="absolute inset-0 flex items-end justify-center rounded-lg bg-gradient-to-t from-background/80 via-transparent to-transparent pointer-events-none">
                  <div className="mb-4 flex items-center gap-1.5 rounded border border-cyan/20 bg-background/90 px-3 py-1.5 text-[10px] font-mono tracking-wider text-muted-foreground backdrop-blur-sm">
                    <LockKey className="h-3.5 w-3.5 text-cyan" weight="duotone" />
                    AMM-derived — orderbook hidden
                  </div>
                </div>
              )}
            </div>

            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">Market Data</CardTitle>
                  <LatencyBadge />
                </div>
              </CardHeader>
              <CardContent>
                {isDark ? (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-[10px] font-mono tracking-wider text-muted-foreground">
                        24h Volume
                      </div>
                      <div className="font-mono text-sm font-semibold">
                        {formatVolume(market.volume24h ?? market.totalVolume)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] font-mono tracking-wider text-muted-foreground">
                        Orderbook
                      </div>
                      <div className="text-sm text-muted-foreground">Hidden</div>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    <div>
                      <div className="text-[10px] font-mono tracking-wider text-muted-foreground">
                        Best Bid
                      </div>
                      <div className="font-mono text-sm font-semibold text-yes">
                        {bestBid}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] font-mono tracking-wider text-muted-foreground">
                        Best Ask
                      </div>
                      <div className="font-mono text-sm font-semibold text-no">
                        {bestAsk}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] font-mono tracking-wider text-muted-foreground">
                        Spread
                      </div>
                      <div className="font-mono text-sm font-semibold">
                        {spread}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] font-mono tracking-wider text-muted-foreground">
                        24h Volume
                      </div>
                      <div className="font-mono text-sm font-semibold">
                        {formatVolume(market.volume24h ?? market.totalVolume)}
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {isDark ? (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  Trade details are hidden for private markets.
                </CardContent>
              </Card>
            ) : (
              <RecentTrades trades={trades} />
            )}

            {isMobile ? (
              <>
                <MyOrders marketId={id} collateralToken={market.collateralToken} />

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">About This Market</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm text-muted-foreground">
                    <p>{market.description}</p>
                    <div>
                      <div className="mb-1 text-[10px] font-mono font-bold tracking-wider text-primary">
                        Execution Policy
                      </div>
                      <p>
                        Orders are matched off-chain using price-time priority.
                        Each trade is individually settled on Starknet. 0% maker
                        fee, 1% taker fee. Order privacy: no participant can see
                        others' pending orders.
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </>
            ) : null}
          </div>

          {!isMobile ? (
            <div className="space-y-6">
              <TradePanel {...tradePanelProps} />

              <MyOrders marketId={id} collateralToken={market.collateralToken} />

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">About This Market</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  <p>{market.description}</p>
                  <div>
                    <div className="mb-1 text-xs font-medium text-foreground">
                      Execution Policy
                    </div>
                    <p>
                      Orders are matched off-chain using price-time priority.
                      Each trade is individually settled on Starknet. 0% maker
                      fee, 1% taker fee. Order privacy: no participant can see
                      others' pending orders.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          ) : null}
        </div>
      </div>
    </PageTransition>
  );
}
