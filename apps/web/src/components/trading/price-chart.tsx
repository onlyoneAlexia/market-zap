"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useAppStore } from "@/hooks/use-store";
import { useQueryClient } from "@tanstack/react-query";
import {
  createChart,
  ColorType,
  LineStyle,
  LineType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type HistogramData,
  type Time,
  type MouseEventParams,
} from "lightweight-charts";
import type { PricePoint, Trade, PaginatedResponse } from "@market-zap/shared";

interface PriceChartProps {
  marketId: string;
  outcomes: string[];
  currentPrices?: number[];
  isDark?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Interval = "5m" | "15m" | "1h" | "6h" | "1d";

const RANGE_CONFIG: Record<
  string,
  { interval: Interval; limit: number; bucketSec: number }
> = {
  "1h": { interval: "5m", limit: 12, bucketSec: 300 },
  "6h": { interval: "15m", limit: 24, bucketSec: 900 },
  "24h": { interval: "1h", limit: 24, bucketSec: 3600 },
  "7d": { interval: "1h", limit: 168, bucketSec: 3600 },
  all: { interval: "6h", limit: 730, bucketSec: 21600 },
};

const OUTCOME_COLORS = [
  { line: "#4AE8A0", areaTop: "rgba(74, 232, 160, 0.15)", areaBottom: "rgba(74, 232, 160, 0.0)" },
  { line: "#E85D4A", areaTop: "rgba(232, 93, 74, 0.15)", areaBottom: "rgba(232, 93, 74, 0.0)" },
  { line: "#F5A623", areaTop: "rgba(245, 166, 35, 0.15)", areaBottom: "rgba(245, 166, 35, 0.0)" },
  { line: "#4A90D9", areaTop: "rgba(74, 144, 217, 0.15)", areaBottom: "rgba(74, 144, 217, 0.0)" },
  { line: "#9B59B6", areaTop: "rgba(155, 89, 182, 0.15)", areaBottom: "rgba(155, 89, 182, 0.0)" },
  { line: "#E84A8A", areaTop: "rgba(232, 74, 138, 0.15)", areaBottom: "rgba(232, 74, 138, 0.0)" },
  { line: "#2DD4BF", areaTop: "rgba(45, 212, 191, 0.15)", areaBottom: "rgba(45, 212, 191, 0.0)" },
  { line: "#F97316", areaTop: "rgba(249, 115, 22, 0.15)", areaBottom: "rgba(249, 115, 22, 0.0)" },
];

const CHART_COLORS = {
  grid: "rgba(245, 240, 235, 0.03)",
  text: "rgba(245, 240, 235, 0.4)",
  crosshair: "rgba(245, 240, 235, 0.15)",
};

interface ChartData {
  timestamps: number[];
  /** outcomePrices[outcomeIndex][pointIndex] — values in 0-100 range */
  outcomePrices: (number | null)[][];
  volumes: (number | null)[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PriceChart({
  marketId,
  outcomes,
  currentPrices,
  isDark,
}: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const outcomeSeriesRefs = useRef<(ISeriesApi<"Area"> | ISeriesApi<"Line">)[]>([]);
  const volSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const [range, setRange] = useState("all");
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);
  const [chartData, setChartData] = useState<ChartData | null>(null);

  const currentPricesRef = useRef(currentPrices);
  currentPricesRef.current = currentPrices;
  const lastProcessedTradeRef = useRef<string | null>(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const queryClient = useQueryClient();
  const wsConnected = useAppStore((s) => s.wsConnected);
  const subscribeChannels = useAppStore((s) => s.subscribeChannels);
  const unsubscribeChannels = useAppStore((s) => s.unsubscribeChannels);

  // -------------------------------------------------------------------------
  // WS: subscribe to trades channel for real-time updates
  // -------------------------------------------------------------------------
  useEffect(() => {
    const channel = `trades:${marketId}`;
    subscribeChannels([channel]);
    return () => unsubscribeChannels([channel]);
  }, [marketId, subscribeChannels, unsubscribeChannels]);

  // Watch for new trades and append live data points
  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const key = event.query.queryKey;
      if (
        !Array.isArray(key) ||
        key[0] !== "markets" ||
        key[1] !== "trades" ||
        key[2] !== marketId
      )
        return;

      const data = event.query.state.data as
        | PaginatedResponse<Trade>
        | undefined;
      const latest = data?.items?.[0];
      if (!latest) return;

      if (latest.id === lastProcessedTradeRef.current) return;
      lastProcessedTradeRef.current = latest.id;

      const tradeTime = latest.timestamp
        ? Math.floor(new Date(latest.timestamp).getTime() / 1000)
        : Math.floor(Date.now() / 1000);

      const tradePrice = parseFloat(latest.price);
      const tradeOutcome = latest.outcomeIndex;
      const tradeAmount = parseFloat(latest.amount || "0");

      const { bucketSec, limit } =
        RANGE_CONFIG[rangeRef.current] ?? RANGE_CONFIG["24h"];

      setChartData((prev) => {
        if (!prev || prev.timestamps.length === 0 || prev.outcomePrices.length === 0) return prev;

        const numOutcomes = prev.outcomePrices.length;
        const lastTs = prev.timestamps[prev.timestamps.length - 1] ?? 0;

        // Build new prices: update traded outcome, derive others
        const newPrices = prev.outcomePrices.map((arr, oi) => {
          const lastVal = arr[arr.length - 1] ?? 50;
          if (oi === tradeOutcome) return tradePrice * 100;
          if (numOutcomes === 2) return (1 - tradePrice) * 100;
          return lastVal; // multi-outcome: carry forward
        });

        let next: ChartData;
        if (tradeTime - lastTs < bucketSec) {
          // Update last bucket
          const op = prev.outcomePrices.map((arr, oi) => {
            const updated = [...arr];
            updated[updated.length - 1] = newPrices[oi];
            return updated;
          });
          const vol = [...prev.volumes];
          vol[vol.length - 1] = (vol[vol.length - 1] ?? 0) + tradeAmount;
          next = { timestamps: [...prev.timestamps], outcomePrices: op, volumes: vol };
        } else {
          // New bucket
          next = {
            timestamps: [...prev.timestamps, tradeTime],
            outcomePrices: prev.outcomePrices.map((arr, oi) => [...arr, newPrices[oi]]),
            volumes: [...prev.volumes, tradeAmount],
          };
        }

        if (next.timestamps.length > limit) {
          const excess = next.timestamps.length - limit;
          next.timestamps = next.timestamps.slice(excess);
          next.outcomePrices = next.outcomePrices.map((arr) => arr.slice(excess));
          next.volumes = next.volumes.slice(excess);
        }

        return next;
      });
    });

    return unsubscribe;
  }, [marketId, queryClient]);

  // -------------------------------------------------------------------------
  // Fetch data
  // -------------------------------------------------------------------------
  const buildData = useCallback(
    async (interval: Interval, limit: number): Promise<ChartData | null> => {
      try {
        const result = await api.getMarketStats(marketId, { interval, limit });
        const history: PricePoint[] = result.priceHistory ?? [];

        if (history.length > 0) {
          const outcomeCount = Math.max(2, history[0]?.prices?.length ?? 2);

          const points = history
            .map((p) => ({
              time:
                typeof p.timestamp === "number"
                  ? p.timestamp
                  : Math.floor(new Date(String(p.timestamp)).getTime() / 1000),
              prices: Array.from({ length: outcomeCount }, (_, oi) => {
                const raw = parseFloat(p.prices[oi] ?? "0.5");
                return isNaN(raw) || raw < 0 || raw > 1 ? null : raw;
              }),
              volume: parseFloat(p.volume ?? "0") / 1e6,
            }))
            .filter((d) => d.prices[0] !== null)
            .sort((a, b) => a.time - b.time)
            .slice(-limit);

          if (points.length > 0) {
            const now = Math.floor(Date.now() / 1000);
            const last = points[points.length - 1];
            const cp = currentPricesRef.current;
            if (now > last.time) {
              points.push({
                time: now,
                prices: Array.from({ length: outcomeCount }, (_, oi) =>
                  cp?.[oi] ?? last.prices[oi],
                ),
                volume: 0,
              });
            }

            return {
              timestamps: points.map((p) => p.time),
              outcomePrices: Array.from({ length: outcomeCount }, (_, oi) =>
                points.map((p) => (p.prices[oi] != null ? p.prices[oi]! * 100 : null)),
              ),
              volumes: points.map((p) => p.volume),
            };
          }
        }
      } catch (err) {
        console.error("[PriceChart] failed to fetch price history:", err);
        throw err;
      }

      // Fallback: no historical data — show flat line at current prices
      const cp = currentPricesRef.current;
      if (cp && cp.length > 0) {
        const now = Math.floor(Date.now() / 1000);
        const rangeSeconds = limit * ({ "5m": 300, "15m": 900, "1h": 3600, "6h": 21600, "1d": 86400 }[interval] ?? 3600);
        const start = now - rangeSeconds;
        const oc = cp.length;
        return {
          timestamps: [start, now],
          outcomePrices: Array.from({ length: oc }, (_, oi) => [cp[oi] * 100, cp[oi] * 100]),
          volumes: [0, 0],
        };
      }

      return null;
    },
    [marketId],
  );

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setErrored(false);

    const { interval, limit } = RANGE_CONFIG[range] ?? RANGE_CONFIG["24h"];

    buildData(interval, limit)
      .then((data) => {
        if (disposed) return;
        setChartData(data);
        setLoading(false);
      })
      .catch(() => {
        if (disposed) return;
        setErrored(true);
        setLoading(false);
      });

    return () => {
      disposed = true;
    };
  }, [marketId, range, buildData]);

  // -------------------------------------------------------------------------
  // Price change delta (based on first outcome)
  // -------------------------------------------------------------------------
  const priceChange = useMemo(() => {
    if (!chartData || chartData.outcomePrices.length === 0) return null;
    const first = chartData.outcomePrices[0];
    if (first.length < 2) return null;
    const start = first[0];
    const end = first[first.length - 1];
    if (start == null || end == null) return null;
    const delta = end - start;
    return {
      delta,
      sign: delta > 0 ? "+" : "",
      color:
        delta > 0
          ? "text-yes"
          : delta < 0
            ? "text-no"
            : "text-muted-foreground",
    };
  }, [chartData]);

  // -------------------------------------------------------------------------
  // Create / update Lightweight Chart
  // -------------------------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !chartData || chartData.timestamps.length === 0) return;

    const numOutcomes = chartData.outcomePrices.length;

    // Always recreate chart — destroy previous if any
    if (chartRef.current) {
      try { chartRef.current.remove(); } catch { /* already disposed */ }
      chartRef.current = null;
      outcomeSeriesRefs.current = [];
      volSeriesRef.current = null;
    }

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: CHART_COLORS.text,
        fontSize: 10,
        fontFamily: "'JetBrains Mono', monospace",
      },
      grid: {
        vertLines: { color: CHART_COLORS.grid },
        horzLines: { color: CHART_COLORS.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: CHART_COLORS.crosshair,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#1a1816",
        },
        horzLine: {
          color: CHART_COLORS.crosshair,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#1a1816",
        },
      },
      timeScale: {
        borderColor: "rgba(245, 240, 235, 0.06)",
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: "rgba(245, 240, 235, 0.06)",
      },
      width: container.clientWidth,
      height: container.clientHeight,
    });

    // Create a series per outcome
    // Binary markets: first outcome gets area fill, second gets line
    // Multi-outcome (3+): all line series, added in reverse order so outcome 0
    // renders on top (last added = highest z-order in lightweight-charts)
    const useBinaryLayout = numOutcomes === 2;
    const seriesArr = new Array<ISeriesApi<"Area"> | ISeriesApi<"Line">>(numOutcomes);

    // For multi-outcome, add in reverse so outcome 0 draws last (on top).
    // For binary, keep natural order (area first, line on top).
    const addOrder = useBinaryLayout
      ? Array.from({ length: numOutcomes }, (_, i) => i)
      : Array.from({ length: numOutcomes }, (_, i) => numOutcomes - 1 - i);

    for (const oi of addOrder) {
      const color = OUTCOME_COLORS[oi] ?? OUTCOME_COLORS[0];

      // Build data for this outcome
      const lineData: LineData[] = [];
      for (let i = 0; i < chartData.timestamps.length; i++) {
        const v = chartData.outcomePrices[oi]?.[i];
        if (v != null) lineData.push({ time: chartData.timestamps[i] as Time, value: v });
      }

      if (useBinaryLayout && oi === 0) {
        // Binary: first outcome gets area series with gradient fill
        const series = chart.addAreaSeries({
          topColor: color.areaTop,
          bottomColor: color.areaBottom,
          lineColor: color.line,
          lineWidth: 2,
          lineType: LineType.Curved,
          priceFormat: {
            type: "custom",
            formatter: (p: number) => p.toFixed(1) + "%",
          },
          lastValueVisible: true,
          priceLineVisible: true,
          priceLineStyle: LineStyle.Dashed,
          priceLineColor: color.line,
        });
        series.setData(lineData);
        seriesArr[oi] = series;
      } else {
        // Multi-outcome or binary non-first: line series
        const series = chart.addLineSeries({
          color: color.line,
          lineWidth: 2,
          lineType: LineType.Curved,
          priceFormat: {
            type: "custom",
            formatter: (p: number) => p.toFixed(1) + "%",
          },
          lastValueVisible: true,
          priceLineVisible: false,
        });
        series.setData(lineData);
        seriesArr[oi] = series;
      }
    }

    outcomeSeriesRefs.current = seriesArr;

    // Volume histogram (separate price scale)
    const volData: HistogramData[] = [];
    for (let i = 0; i < chartData.timestamps.length; i++) {
      const t = chartData.timestamps[i] as Time;
      const vol = chartData.volumes[i];
      const firstPrice = chartData.outcomePrices[0]?.[i] ?? 50;
      if (vol != null) {
        volData.push({
          time: t,
          value: vol,
          color: firstPrice >= 50 ? "rgba(74, 232, 160, 0.3)" : "rgba(232, 93, 74, 0.3)",
        });
      }
    }

    const volSeries = chart.addHistogramSeries({
      priceFormat: {
        type: "custom",
        formatter: (p: number) => "$" + p.toFixed(2),
      },
      priceScaleId: "vol",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volSeries.setData(volData);
    volSeriesRef.current = volSeries;

    // Volume scale: invisible, pinned to bottom 20%
    chart.priceScale("vol").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
      borderVisible: false,
      visible: false,
    });

    // Tooltip on crosshair move
    const tooltip = tooltipRef.current;
    if (tooltip) {
      chart.subscribeCrosshairMove((param: MouseEventParams) => {
        if (
          !param.time ||
          !param.point ||
          param.point.x < 0 ||
          param.point.y < 0
        ) {
          tooltip.style.opacity = "0";
          return;
        }

        const ts = typeof param.time === "number" ? param.time : 0;
        const d = new Date(ts * 1000);
        const timeStr = d.toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });

        let html = `<div style="font-weight:600;margin-bottom:3px;color:rgba(245,240,235,0.6)">${timeStr}</div>`;
        let hasValue = false;

        for (let oi = 0; oi < seriesArr.length; oi++) {
          const val = param.seriesData.get(seriesArr[oi]) as LineData | undefined;
          if (val) {
            hasValue = true;
            const c = OUTCOME_COLORS[oi] ?? OUTCOME_COLORS[0];
            const label = outcomes[oi] ?? `Outcome ${oi + 1}`;
            html += `<div style="color:${c.line}">${label}: ${val.value.toFixed(1)}%</div>`;
          }
        }

        const volVal = param.seriesData.get(volSeries) as HistogramData | undefined;
        if (volVal && volVal.value > 0) {
          html += `<div style="color:rgba(245,240,235,0.4)">Vol: $${volVal.value.toFixed(2)}</div>`;
        }

        if (!hasValue) {
          tooltip.style.opacity = "0";
          return;
        }

        tooltip.innerHTML = html;
        tooltip.style.opacity = "1";

        // Position tooltip
        const containerRect = container.getBoundingClientRect();
        let left = param.point.x + 16;
        let top = param.point.y - 16;
        const tW = tooltip.offsetWidth;
        const tH = tooltip.offsetHeight;
        if (left + tW > containerRect.width) left = param.point.x - tW - 16;
        if (top < 0) top = 4;
        if (top + tH > containerRect.height) top = containerRect.height - tH - 4;
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
      });
    }

    chart.timeScale().fitContent();
    chartRef.current = chart;

    // Resize observer
    const ro = new ResizeObserver((entries) => {
      if (!chartRef.current || !entries[0]) return;
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) chartRef.current.resize(width, height);
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      try { chart.remove(); } catch { /* already disposed */ }
      chartRef.current = null;
      outcomeSeriesRefs.current = [];
      volSeriesRef.current = null;
    };
  }, [chartData, outcomes, range]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div className="flex items-center gap-3">
          <CardTitle className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">Probability</CardTitle>
          {priceChange && !loading && (
            <span className={`text-xs font-semibold ${priceChange.color}`}>
              {priceChange.sign}
              {priceChange.delta.toFixed(1)}pp
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {wsConnected && (
            <span className="flex items-center gap-1 text-[10px] text-yes">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-yes animate-pulse" />
              Live
            </span>
          )}
          <Tabs value={range} onValueChange={setRange}>
            <TabsList className="h-7">
              <TabsTrigger value="1h" className="px-2 text-xs">
                1h
              </TabsTrigger>
              <TabsTrigger value="6h" className="px-2 text-xs">
                6h
              </TabsTrigger>
              <TabsTrigger value="24h" className="px-2 text-xs">
                24h
              </TabsTrigger>
              <TabsTrigger value="7d" className="px-2 text-xs">
                7d
              </TabsTrigger>
              <TabsTrigger value="all" className="px-2 text-xs">
                All
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="flex h-[300px] w-full flex-col gap-2 p-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-full w-full" />
          </div>
        ) : errored ? (
          <div className="flex h-[300px] w-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <p>Failed to load chart data</p>
            <button
              onClick={() => {
                setErrored(false);
                setLoading(true);
                const { interval, limit } =
                  RANGE_CONFIG[range] ?? RANGE_CONFIG["24h"];
                buildData(interval, limit)
                  .then((data) => {
                    setChartData(data);
                    setLoading(false);
                  })
                  .catch(() => {
                    setErrored(true);
                    setLoading(false);
                  });
              }}
              className="rounded border px-3 py-1 text-xs transition-colors hover:bg-accent"
            >
              Retry
            </button>
          </div>
        ) : !chartData || chartData.timestamps.length === 0 ? (
          <div className="flex h-[300px] w-full items-center justify-center text-sm text-muted-foreground">
            {isDark ? "Waiting for AMM price data" : "No trading activity yet"}
          </div>
        ) : (
          <div className="relative">
            <div ref={containerRef} className="h-[300px] w-full" />
            <div
              ref={tooltipRef}
              className="pointer-events-none absolute z-50 rounded border border-border bg-popover px-2.5 py-2 font-mono text-[11px] leading-relaxed shadow-lg"
              style={{ opacity: 0, transition: "opacity 0.12s" }}
            />
          </div>
        )}

        {/* Legend */}
        {chartData && chartData.timestamps.length > 0 && !loading && !errored && (
          <div className="flex items-center gap-4 px-4 pb-3 pt-1 text-[10px] font-mono flex-wrap">
            {chartData.outcomePrices.map((_, oi) => {
              const color = OUTCOME_COLORS[oi] ?? OUTCOME_COLORS[0];
              return (
                <span key={oi} className="flex items-center gap-1.5">
                  <span className="inline-block h-0.5 w-3 rounded" style={{ background: color.line }} />
                  <span style={{ color: color.line }}>{outcomes[oi] ?? `Outcome ${oi + 1}`}</span>
                </span>
              );
            })}
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-3 rounded-sm" style={{ background: "rgba(245, 240, 235, 0.15)" }} />
              <span className="text-muted-foreground">Vol</span>
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
