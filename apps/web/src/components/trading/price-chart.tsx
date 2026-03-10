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

type Interval = "1h" | "6h" | "1d";

const RANGE_CONFIG: Record<
  string,
  { interval: Interval; limit: number; bucketSec: number }
> = {
  "1h": { interval: "1h", limit: 1, bucketSec: 3600 },
  "24h": { interval: "1h", limit: 24, bucketSec: 3600 },
  "7d": { interval: "6h", limit: 28, bucketSec: 21600 },
  all: { interval: "1d", limit: 365, bucketSec: 86400 },
};

const COLORS = {
  yes: "#4AE8A0",
  no: "#E85D4A",
  grid: "rgba(245, 240, 235, 0.03)",
  text: "rgba(245, 240, 235, 0.4)",
  crosshair: "rgba(245, 240, 235, 0.15)",
};

interface ChartData {
  timestamps: number[];
  yesPrices: (number | null)[];
  noPrices: (number | null)[];
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
  const yesSeriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const noSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const volSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const [range, setRange] = useState("24h");
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

  const hasMultipleOutcomes = outcomes.length >= 2;

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

      const rawPrice = parseFloat(latest.price);
      const yesPct =
        latest.outcomeIndex === 1
          ? (1 - rawPrice) * 100
          : rawPrice * 100;
      const noPct = 100 - yesPct;

      const tradeAmount = parseFloat(latest.amount || "0");

      const { bucketSec, limit } =
        RANGE_CONFIG[rangeRef.current] ?? RANGE_CONFIG["24h"];

      setChartData((prev) => {
        if (!prev || prev.timestamps.length === 0) return prev;
        const lastTs = prev.timestamps[prev.timestamps.length - 1] ?? 0;

        let next: ChartData;
        if (tradeTime - lastTs < bucketSec) {
          const ts = [...prev.timestamps];
          const yes = [...prev.yesPrices];
          const no = [...prev.noPrices];
          const vol = [...prev.volumes];
          yes[yes.length - 1] = yesPct;
          no[no.length - 1] = noPct;
          vol[vol.length - 1] = (vol[vol.length - 1] ?? 0) + tradeAmount;
          next = { timestamps: ts, yesPrices: yes, noPrices: no, volumes: vol };
        } else {
          next = {
            timestamps: [...prev.timestamps, tradeTime],
            yesPrices: [...prev.yesPrices, yesPct],
            noPrices: [...prev.noPrices, noPct],
            volumes: [...prev.volumes, tradeAmount],
          };
        }

        if (next.timestamps.length > limit) {
          const excess = next.timestamps.length - limit;
          next.timestamps = next.timestamps.slice(excess);
          next.yesPrices = next.yesPrices.slice(excess);
          next.noPrices = next.noPrices.slice(excess);
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
          const points = history
            .map((p) => ({
              time:
                typeof p.timestamp === "number"
                  ? p.timestamp
                  : Math.floor(new Date(String(p.timestamp)).getTime() / 1000),
              yesPrice: parseFloat(p.prices[0] ?? "0.5"),
              volume: parseFloat(p.volume ?? "0") / 1e6,
            }))
            .filter((d) => !isNaN(d.yesPrice) && d.yesPrice >= 0 && d.yesPrice <= 1)
            .sort((a, b) => a.time - b.time)
            .slice(-limit);

          if (points.length > 0) {
            const now = Math.floor(Date.now() / 1000);
            const last = points[points.length - 1];
            const cp = currentPricesRef.current?.[0] ?? last.yesPrice;
            if (now > last.time) {
              points.push({ time: now, yesPrice: cp, volume: 0 });
            }

            return {
              timestamps: points.map((p) => p.time),
              yesPrices: points.map((p) => p.yesPrice * 100),
              noPrices: points.map((p) => (1 - p.yesPrice) * 100),
              volumes: points.map((p) => p.volume),
            };
          }
        }
      } catch (err) {
        console.error("[PriceChart] failed to fetch price history:", err);
        throw err;
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
  // Price change delta
  // -------------------------------------------------------------------------
  const priceChange = useMemo(() => {
    if (!chartData || chartData.yesPrices.length < 2) return null;
    const first = chartData.yesPrices[0];
    const last = chartData.yesPrices[chartData.yesPrices.length - 1];
    if (first == null || last == null) return null;
    const delta = last - first;
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

    // Convert to series data formats
    const yesAreaData: LineData[] = [];
    const noLineData: LineData[] = [];
    const volData: HistogramData[] = [];
    for (let i = 0; i < chartData.timestamps.length; i++) {
      const t = chartData.timestamps[i] as Time;
      const yv = chartData.yesPrices[i];
      const nv = chartData.noPrices[i];
      const vol = chartData.volumes[i];
      if (yv != null) yesAreaData.push({ time: t, value: yv });
      if (nv != null) noLineData.push({ time: t, value: nv });
      if (vol != null) {
        volData.push({
          time: t,
          value: vol,
          color: (yv ?? 50) >= 50 ? "rgba(74, 232, 160, 0.3)" : "rgba(232, 93, 74, 0.3)",
        });
      }
    }

    // Always recreate chart — destroy previous if any
    if (chartRef.current) {
      try { chartRef.current.remove(); } catch { /* already disposed */ }
      chartRef.current = null;
      yesSeriesRef.current = null;
      noSeriesRef.current = null;
      volSeriesRef.current = null;
    }

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: COLORS.text,
        fontSize: 10,
        fontFamily: "'JetBrains Mono', monospace",
      },
      grid: {
        vertLines: { color: COLORS.grid },
        horzLines: { color: COLORS.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: COLORS.crosshair,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#1a1816",
        },
        horzLine: {
          color: COLORS.crosshair,
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

    // YES area (gradient fill)
    const yesSeries = chart.addAreaSeries({
      topColor: "rgba(74, 232, 160, 0.2)",
      bottomColor: "rgba(74, 232, 160, 0.0)",
      lineColor: COLORS.yes,
      lineWidth: 2,
      priceFormat: {
        type: "custom",
        formatter: (p: number) => p.toFixed(1) + "%",
      },
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineStyle: LineStyle.Dashed,
      priceLineColor: COLORS.yes,
    });
    yesSeries.setData(yesAreaData);
    yesSeriesRef.current = yesSeries;

    // NO line
    if (hasMultipleOutcomes) {
      const noSeries = chart.addLineSeries({
        color: COLORS.no,
        lineWidth: 2,
        priceFormat: {
          type: "custom",
          formatter: (p: number) => p.toFixed(1) + "%",
        },
        lastValueVisible: true,
        priceLineVisible: false,
      });
      noSeries.setData(noLineData);
      noSeriesRef.current = noSeries;
    }

    // Volume histogram (separate price scale)
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

        const yesVal = param.seriesData.get(yesSeries) as LineData | undefined;
        const noVal = noSeriesRef.current
          ? (param.seriesData.get(noSeriesRef.current) as LineData | undefined)
          : undefined;
        const volVal = param.seriesData.get(volSeries) as HistogramData | undefined;

        if (!yesVal) {
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
        html += `<div style="color:${COLORS.yes}">Yes: ${yesVal.value.toFixed(1)}%</div>`;
        if (noVal) {
          html += `<div style="color:${COLORS.no}">No: ${noVal.value.toFixed(1)}%</div>`;
        }
        if (volVal && volVal.value > 0) {
          html += `<div style="color:rgba(245,240,235,0.4)">Vol: $${volVal.value.toFixed(2)}</div>`;
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
      yesSeriesRef.current = null;
      noSeriesRef.current = null;
      volSeriesRef.current = null;
    };
  }, [chartData, hasMultipleOutcomes, range]);

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
          <div className="flex items-center gap-4 px-4 pb-3 pt-1 text-[10px] font-mono">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-3 rounded" style={{ background: COLORS.yes }} />
              <span style={{ color: COLORS.yes }}>{outcomes[0] ?? "Yes"}</span>
            </span>
            {hasMultipleOutcomes && (
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-3 rounded" style={{ background: COLORS.no }} />
                <span style={{ color: COLORS.no }}>{outcomes[1] ?? "No"}</span>
              </span>
            )}
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
