"use client";

import Link from "next/link";
import { ArrowUpRight, ArrowDownRight } from "@phosphor-icons/react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Position } from "@market-zap/shared";

interface PositionsTableProps {
  positions?: Position[];
}

export function PositionsTable({ positions }: PositionsTableProps) {
  if (!positions || positions.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <p className="text-sm text-muted-foreground">
            No open positions
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <div className="divide-y md:hidden">
          {positions.map((pos) => {
            const pnl = parseFloat(pos.unrealizedPnl);
            const isProfit = pnl >= 0;

            return (
              <div
                key={`${pos.marketId}-${pos.outcomeIndex}-mobile`}
                className="space-y-3 p-4"
              >
                <div className="space-y-2">
                  <Link
                    href={`/markets/${pos.marketId}`}
                    className="line-clamp-2 text-sm font-medium hover:text-primary transition-colors"
                  >
                    {pos.market.question}
                  </Link>
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant={pos.outcomeIndex === 0 ? "yes" : "no"}>
                      {pos.outcomeIndex === 0 ? "Yes" : "No"}
                    </Badge>
                    <div
                      className={cn(
                        "flex items-center gap-1 font-mono text-sm font-medium",
                        isProfit ? "text-yes" : "text-no"
                      )}
                    >
                      {isProfit ? (
                        <ArrowUpRight className="h-3 w-3" weight="bold" />
                      ) : (
                        <ArrowDownRight className="h-3 w-3" weight="bold" />
                      )}
                      ${pos.unrealizedPnl}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div>
                    <div className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">Quantity</div>
                    <div className="font-mono text-sm text-foreground">
                      {pos.quantity}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">Average price</div>
                    <div className="font-mono text-sm text-foreground">
                      {(parseFloat(pos.avgPrice) * 100).toFixed(1)}%
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">Current price</div>
                    <div className="font-mono text-sm text-foreground">
                      {(parseFloat(pos.currentPrice) * 100).toFixed(1)}%
                    </div>
                  </div>
                </div>

                <Link href={`/markets/${pos.marketId}`}>
                  <Button variant="outline" size="sm" className="w-full">
                    Trade Position
                  </Button>
                </Link>
              </div>
            );
          })}
        </div>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-[10px] font-mono font-bold tracking-wider text-muted-foreground">
                <th className="px-4 py-3">Market</th>
                <th className="px-4 py-3">Side</th>
                <th className="px-4 py-3 text-right">Quantity</th>
                <th className="px-4 py-3 text-right">Average price</th>
                <th className="px-4 py-3 text-right">Current price</th>
                <th className="px-4 py-3 text-right">Profit / loss</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {positions.map((pos) => {
                const pnl = parseFloat(pos.unrealizedPnl);
                const isProfit = pnl >= 0;
                return (
                  <tr
                    key={`${pos.marketId}-${pos.outcomeIndex}`}
                    className="border-b last:border-0 hover:bg-muted/50 transition-colors"
                  >
                    <td className="max-w-[200px] truncate px-4 py-3 text-sm font-medium">
                      <Link
                        href={`/markets/${pos.marketId}`}
                        className="hover:text-primary transition-colors"
                      >
                        {pos.market.question}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={pos.outcomeIndex === 0 ? "yes" : "no"}>
                        {pos.outcomeIndex === 0 ? "Yes" : "No"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-sm">
                      {pos.quantity}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-sm">
                      {(parseFloat(pos.avgPrice) * 100).toFixed(1)}%
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-sm">
                      {(parseFloat(pos.currentPrice) * 100).toFixed(1)}%
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div
                        className={cn(
                          "flex items-center justify-end gap-1 font-mono text-sm font-medium",
                          isProfit ? "text-yes" : "text-no"
                        )}
                      >
                        {isProfit ? (
                          <ArrowUpRight className="h-3 w-3" weight="bold" />
                        ) : (
                          <ArrowDownRight className="h-3 w-3" weight="bold" />
                        )}
                        ${pos.unrealizedPnl}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/markets/${pos.marketId}`}>
                        <Button variant="ghost" size="sm">
                          Trade
                        </Button>
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
