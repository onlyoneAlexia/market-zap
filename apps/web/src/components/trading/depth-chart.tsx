"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { OrderBookLevel } from "@market-zap/shared";

interface DepthChartProps {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  spread: string | null;
}

/**
 * Simple CSS-based depth chart showing cumulative bid/ask depth bars.
 * No heavy charting library needed.
 */
export function DepthChart({ bids, asks, spread }: DepthChartProps) {
  const { bidLevels, askLevels, maxCumulative } = useMemo(() => {
    let cumBid = 0;
    const bidL = bids.map((l) => {
      cumBid += Number(l.size);
      return { price: Number(l.price), size: Number(l.size), cumulative: cumBid };
    });

    let cumAsk = 0;
    const askL = asks.map((l) => {
      cumAsk += Number(l.size);
      return { price: Number(l.price), size: Number(l.size), cumulative: cumAsk };
    });

    const maxC = Math.max(cumBid, cumAsk, 1);
    return { bidLevels: bidL, askLevels: askL, maxCumulative: maxC };
  }, [bids, asks]);

  if (bidLevels.length === 0 && askLevels.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">Depth</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="py-4 text-center text-sm text-muted-foreground">No depth data available</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">Depth</CardTitle>
          {spread && (
            <span className="text-[10px] font-mono text-muted-foreground tracking-wider">
              Spread: {(Number(spread) * 100).toFixed(2)}%
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3">
          {/* Bids (right-aligned bars, green) */}
          <div className="space-y-0.5">
            <div className="mb-1.5 text-[10px] font-mono font-bold tracking-wider text-muted-foreground">Bids</div>
            {bidLevels.map((level) => (
              <div key={`bd-${level.price}`} className="relative flex items-center h-5">
                <div
                  className="absolute inset-y-0 right-0 rounded-l bg-yes/15"
                  style={{ width: `${(level.cumulative / maxCumulative) * 100}%` }}
                />
                <div className="relative z-10 flex w-full justify-between px-1 text-[11px]">
                  <span className="font-mono text-yes">{(level.price * 100).toFixed(1)}%</span>
                  <span className="font-mono">{level.cumulative.toFixed(0)}</span>
                </div>
              </div>
            ))}
          </div>

          {/* Asks (left-aligned bars, red) */}
          <div className="space-y-0.5">
            <div className="mb-1.5 text-[10px] font-mono font-bold tracking-wider text-muted-foreground">Asks</div>
            {askLevels.map((level) => (
              <div key={`ad-${level.price}`} className="relative flex items-center h-5">
                <div
                  className="absolute inset-y-0 left-0 rounded-r bg-no/15"
                  style={{ width: `${(level.cumulative / maxCumulative) * 100}%` }}
                />
                <div className="relative z-10 flex w-full justify-between px-1 text-[11px]">
                  <span className="font-mono text-no">{(level.price * 100).toFixed(1)}%</span>
                  <span className="font-mono">{level.cumulative.toFixed(0)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
