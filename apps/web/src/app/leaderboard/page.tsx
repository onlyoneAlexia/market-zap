"use client";

import { useState } from "react";
import { Trophy, Medal, ArrowUpRight, ArrowDownRight } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useLeaderboard } from "@/hooks/use-leaderboard";
import { Skeleton } from "@/components/ui/skeleton";
import { shortenAddress } from "@market-zap/shared";
import { PageTransition } from "@/components/ui/page-transition";
import { AnimatedTabs, AnimatedTabsList, AnimatedTabsTrigger } from "@/components/ui/animated-tabs";
import { motion } from "framer-motion";

function getRankIcon(rank: number) {
  if (rank === 1) return <Trophy className="h-5 w-5 text-yellow-500" weight="fill" />;
  if (rank === 2) return <Medal className="h-5 w-5 text-gray-400" weight="fill" />;
  if (rank === 3) return <Medal className="h-5 w-5 text-amber-600" weight="fill" />;
  return <span className="text-sm font-mono text-muted-foreground">{rank}</span>;
}

export default function LeaderboardPage() {
  const [period, setPeriod] = useState<"24h" | "7d" | "30d" | "all">("7d");
  const { data, isLoading, error } = useLeaderboard(period);

  const traders = data?.items ?? [];

  return (
    <PageTransition>
    <div className="container mx-auto max-w-screen-xl px-4 py-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="font-heading text-xl font-bold tracking-wider">Leaderboard</h1>
          <p className="text-[10px] font-mono text-muted-foreground mt-0.5 tracking-wider">
            Top traders by realized P&L
          </p>
        </div>
        <AnimatedTabs value={period} onValueChange={(v) => setPeriod(v as typeof period)}>
          <AnimatedTabsList>
            <AnimatedTabsTrigger value="24h" isActive={period === "24h"} layoutGroup="leaderboard-period">24h</AnimatedTabsTrigger>
            <AnimatedTabsTrigger value="7d" isActive={period === "7d"} layoutGroup="leaderboard-period">7d</AnimatedTabsTrigger>
            <AnimatedTabsTrigger value="30d" isActive={period === "30d"} layoutGroup="leaderboard-period">30d</AnimatedTabsTrigger>
            <AnimatedTabsTrigger value="all" isActive={period === "all"} layoutGroup="leaderboard-period">All</AnimatedTabsTrigger>
          </AnimatedTabsList>
        </AnimatedTabs>
      </div>

      <div className="rounded-lg border bg-card/50 backdrop-blur-xl terminal-glow">
          {isLoading ? (
            <div className="divide-y">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="flex items-center gap-4 px-4 py-3">
                  <Skeleton className="h-4 w-8" />
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="ml-auto h-4 w-20" />
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-12" />
                  <Skeleton className="h-4 w-8" />
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
              Failed to load leaderboard
            </div>
          ) : traders.length === 0 ? (
            <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
              <span className="animate-float">No traders yet</span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-[10px] font-mono font-bold tracking-wider text-muted-foreground">
                    <th className="w-12 px-4 py-3 text-center">Rank</th>
                    <th className="px-4 py-3">Trader</th>
                    <th className="px-4 py-3 text-right">P&L</th>
                    <th className="px-4 py-3 text-right">Volume</th>
                    <th className="px-4 py-3 text-right">Win %</th>
                    <th className="px-4 py-3 text-right">Txns</th>
                  </tr>
                </thead>
                <tbody>
                  {traders.map((trader, index) => {
                    const isPositive = !trader.totalPnl.startsWith("-");
                    return (
                      <motion.tr
                        key={trader.rank}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.04, duration: 0.25 }}
                        className="border-b last:border-0 hover:bg-primary/5 transition-colors"
                      >
                        <td className="px-4 py-3 text-center">
                          <div className="flex items-center justify-center">
                            {getRankIcon(trader.rank)}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="font-mono text-sm">
                            {shortenAddress(trader.address)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div
                            className={cn(
                              "flex items-center justify-end gap-1 font-mono text-sm font-medium",
                              isPositive ? "text-yes" : "text-no"
                            )}
                          >
                            {isPositive ? (
                              <ArrowUpRight className="h-3 w-3" weight="bold" />
                            ) : (
                              <ArrowDownRight className="h-3 w-3" weight="bold" />
                            )}
                            ${trader.totalPnl}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-sm">
                          ${trader.totalVolume}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Badge
                            variant={trader.winRate >= 60 ? "yes" : "secondary"}
                          >
                            {trader.winRate}%
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-sm text-muted-foreground">
                          {trader.tradesCount}
                        </td>
                      </motion.tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </div>
    </PageTransition>
  );
}
