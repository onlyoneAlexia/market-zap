"use client";

import { useState, useMemo, useCallback, useRef, useEffect, startTransition } from "react";
import Link from "next/link";
import { MarketFilters } from "@/components/market/market-filters";
import { MarketGrid } from "@/components/market/market-grid";
import { PageTransition } from "@/components/ui/page-transition";
import { useMarkets } from "@/hooks/use-market";
import { DEFAULT_MARKETS_QUERY_FILTERS } from "@/lib/market-query-options";
import type { GetMarketsParams } from "@market-zap/shared";

function formatVolume(raw: string | undefined): string {
  const n = parseFloat(raw ?? "0") / 1e6;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function getSortBy(sort: string): NonNullable<GetMarketsParams["sortBy"]> {
  switch (sort) {
    case "newest":
      return "createdAt";
    case "ending-soon":
      return "resolutionTime";
    default:
      return "volume";
  }
}

export function MarketsPageClient() {
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState("trending");
  const [search, setSearch] = useState("");
  const [marketType, setMarketType] = useState("all");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      startTransition(() => {
        setDebouncedSearch(value);
      });
    }, 300);
  }, []);

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const filters = useMemo<GetMarketsParams>(
    () => ({
      ...DEFAULT_MARKETS_QUERY_FILTERS,
      category: category !== "all" ? category : undefined,
      search: debouncedSearch || undefined,
      sortBy: getSortBy(sort),
    }),
    [category, debouncedSearch, sort],
  );

  const { data, isLoading, error } = useMarkets(filters);

  const markets = useMemo(() => {
    const all = (data?.items ?? []).map((m) => ({
      id: m.id,
      question: m.question,
      category: m.category,
      outcomes: m.outcomes.map((o) => o.label),
      prices: m.outcomes.map((o) => parseFloat(o.price)),
      volume: formatVolume(m.totalVolume),
      endsAt: m.resolutionTime,
      traders: m.traders ?? 0,
      marketType: m.marketType,
      resolved: m.resolved,
      voided: m.voided,
    }));
    if (marketType === "all") return all;
    return all.filter((m) => (m.marketType ?? "public") === marketType);
  }, [data, marketType]);

  return (
    <PageTransition>
      <div className="container mx-auto max-w-screen-xl px-2 py-4 sm:px-4">
        {/* Command bar — terminal search + new market */}
        <div className="flex gap-2 mb-3">
          <div className="flex-1 flex items-center bg-card/50 border border-border rounded px-3 py-2 backdrop-blur-xl">
            <span className="text-primary font-mono text-sm mr-2 font-bold">&gt;</span>
            <input
              type="text"
              placeholder="Search markets..."
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="bg-transparent text-cyan font-mono text-xs w-full focus:outline-none placeholder:text-muted-foreground"
            />
          </div>
          <Link
            href="/create"
            className="shrink-0 px-4 py-2 bg-primary/15 border border-primary/30 text-primary rounded text-xs font-mono font-bold hover:bg-primary/25 transition-colors tracking-wider"
          >
            + New Market
          </Link>
        </div>

        {/* Filter pills */}
        <MarketFilters
          selectedCategory={category}
          onCategoryChange={setCategory}
          selectedSort={sort}
          onSortChange={setSort}
          selectedMarketType={marketType}
          onMarketTypeChange={setMarketType}
        />

        {/* Data table */}
        <div className="mt-3">
          {isLoading ? (
            <MarketGrid markets={[]} isLoading />
          ) : error ? (
            <div className="bg-card/50 border border-border rounded overflow-hidden backdrop-blur-xl terminal-glow">
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <p className="text-sm font-mono text-muted-foreground">Failed to load markets</p>
                <p className="mt-1 text-[10px] font-mono text-muted-foreground/60">
                  Engine: {process.env.NEXT_PUBLIC_ENGINE_URL || "http://localhost:3001"}
                </p>
              </div>
            </div>
          ) : (
            <MarketGrid markets={markets} />
          )}
        </div>
      </div>
    </PageTransition>
  );
}
