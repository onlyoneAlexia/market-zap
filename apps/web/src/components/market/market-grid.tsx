"use client";

import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LockKey } from "@phosphor-icons/react";
import { Skeleton } from "@/components/ui/skeleton";

interface MarketData {
  id: string;
  question: string;
  category: string;
  outcomes: string[];
  prices: number[];
  volume: string;
  endsAt: number;
  traders?: number;
  marketType?: "public" | "private";
  resolved?: boolean;
  voided?: boolean;
  thumbnailUrl?: string | null;
}

interface MarketGridProps {
  markets: MarketData[];
  isLoading?: boolean;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const CATEGORY_COLORS: Record<string, string> = {
  crypto: "from-amber-500/20 to-amber-600/5",
  politics: "from-blue-500/20 to-blue-600/5",
  sports: "from-green-500/20 to-green-600/5",
  culture: "from-purple-500/20 to-purple-600/5",
  science: "from-cyan-500/20 to-cyan-600/5",
};

function compactCountdown(endsAt: number): { text: string; urgent: boolean } {
  const diff = endsAt * 1000 - Date.now();
  if (diff <= 0) return { text: "Ended", urgent: false };
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (days > 0) return { text: `${days}d ${hours}h`, urgent: days < 1 };
  if (hours > 0) return { text: `${hours}h ${minutes}m`, urgent: hours < 12 };
  return { text: `${minutes}m`, urgent: true };
}

function getStatus(market: MarketData): { label: string; color: string } {
  if (market.voided) return { label: "Voided", color: "text-no" };
  if (market.resolved) return { label: "Resolved", color: "text-muted-foreground" };
  const diff = market.endsAt * 1000 - Date.now();
  if (diff < 86400000 && diff > 0) return { label: "Hot", color: "text-amber" };
  return { label: "Open", color: "text-yes" };
}

function TableSkeleton() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="grid grid-cols-12 gap-0 px-3 py-2.5 items-center">
          <div className="col-span-1"><Skeleton className="h-3 w-12" /></div>
          <div className="col-span-5"><Skeleton className="h-3 w-3/4" /></div>
          <div className="col-span-1 flex justify-end"><Skeleton className="h-3 w-10" /></div>
          <div className="col-span-1 flex justify-end"><Skeleton className="h-3 w-10" /></div>
          <div className="col-span-1 flex justify-end"><Skeleton className="h-3 w-12" /></div>
          <div className="col-span-1 flex justify-end"><Skeleton className="h-3 w-8" /></div>
          <div className="col-span-1 flex justify-end"><Skeleton className="h-3 w-10" /></div>
          <div className="col-span-1 flex justify-end"><Skeleton className="h-3 w-10" /></div>
        </div>
      ))}
    </div>
  );
}

function MobileMarketRow({ market }: { market: MarketData }) {
  const router = useRouter();
  const hasPrefetched = React.useRef(false);
  const href = `/markets/${market.id}`;
  const countdown = compactCountdown(market.endsAt);
  const status = getStatus(market);

  const prefetch = () => {
    if (!hasPrefetched.current) {
      hasPrefetched.current = true;
      void router.prefetch(href);
    }
  };

  return (
    <Link
      href={href}
      prefetch={false}
      onMouseEnter={prefetch}
      onTouchStart={prefetch}
      className="block border-b border-border px-3 py-3 hover:bg-primary/5 transition-colors"
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono font-bold text-primary">{capitalize(market.category)}</span>
          {market.marketType === "private" && (
            <LockKey className="h-2.5 w-2.5 text-primary" weight="duotone" />
          )}
          <span className={`text-[10px] font-mono ${status.color}`}>{status.label}</span>
        </div>
        <span className={`text-[10px] font-mono ${countdown.urgent ? "text-amber blink" : "text-muted-foreground"}`}>
          {countdown.text}
        </span>
      </div>
      <div className="flex gap-2.5 mb-2">
        <div className={`h-10 w-10 rounded shrink-0 overflow-hidden bg-gradient-to-br ${CATEGORY_COLORS[market.category] ?? "from-muted/20 to-muted/5"}`}>
          {market.thumbnailUrl && (
            <img src={market.thumbnailUrl} alt="" className="h-full w-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
          )}
        </div>
        <p className="text-xs line-clamp-2">{market.question}</p>
      </div>
      <div className="flex items-center gap-4 text-[10px] font-mono">
        {market.prices.slice(0, 2).map((p, i) => (
          <span key={i} className={i === 0 ? "text-yes font-bold" : "text-no"}>
            {(p * 100).toFixed(1)}%
          </span>
        ))}
        {market.outcomes.length > 2 && (
          <span className="text-muted-foreground">+{market.outcomes.length - 2}</span>
        )}
        <span className="text-muted-foreground">{market.volume}</span>
        {market.traders !== undefined && (
          <span className="text-muted-foreground">{market.traders} traders</span>
        )}
      </div>
    </Link>
  );
}

export function MarketGrid({ markets, isLoading }: MarketGridProps) {
  if (isLoading) {
    return (
      <div className="bg-card/50 border border-border rounded overflow-hidden backdrop-blur-xl terminal-glow">
        {/* Header */}
        <div className="hidden md:grid grid-cols-12 gap-0 px-3 py-2 border-b border-border text-[10px] font-mono font-bold text-muted-foreground tracking-wider">
          <div className="col-span-1">Category</div>
          <div className="col-span-1"></div>
          <div className="col-span-4">Question</div>
          <div className="col-span-2 text-right">Prices</div>
          <div className="col-span-1 text-right">Volume</div>
          <div className="col-span-1 text-right">Traders</div>
          <div className="col-span-1 text-right">Expiry</div>
          <div className="col-span-1 text-right">Status</div>
        </div>
        <div className="hidden md:block"><TableSkeleton /></div>
        {/* Mobile skeleton */}
        <div className="md:hidden divide-y divide-border">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="px-3 py-3 space-y-2">
              <div className="flex justify-between">
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-3 w-10" />
              </div>
              <Skeleton className="h-4 w-full" />
              <div className="flex gap-4">
                <Skeleton className="h-3 w-10" />
                <Skeleton className="h-3 w-10" />
                <Skeleton className="h-3 w-12" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (markets.length === 0) {
    return (
      <div className="bg-card/50 border border-border rounded overflow-hidden backdrop-blur-xl terminal-glow">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <p className="text-sm font-mono text-muted-foreground">No markets found</p>
          <p className="mt-1 text-[10px] font-mono text-muted-foreground/60">
            Adjust your filters or{" "}
            <Link href="/create" className="text-primary hover:underline">
              create a new market
            </Link>
          </p>
        </div>
      </div>
    );
  }

  const totalTraders = markets.reduce((sum, m) => sum + (m.traders ?? 0), 0);

  return (
    <>
      {/* Desktop: Bloomberg data table */}
      <div className="hidden md:block bg-card/50 border border-border rounded overflow-hidden backdrop-blur-xl terminal-glow">
        {/* Header */}
        <div className="grid grid-cols-12 gap-0 px-3 py-2 border-b border-border text-[10px] font-mono font-bold text-muted-foreground tracking-wider">
          <div className="col-span-1">Category</div>
          <div className="col-span-1"></div>
          <div className="col-span-4">Question</div>
          <div className="col-span-2 text-right">Prices</div>
          <div className="col-span-1 text-right">Volume</div>
          <div className="col-span-1 text-right">Traders</div>
          <div className="col-span-1 text-right">Expiry</div>
          <div className="col-span-1 text-right">Status</div>
        </div>
        {/* Rows */}
        <div className="divide-y divide-border">
          {markets.map((market) => {
            const countdown = compactCountdown(market.endsAt);
            const status = getStatus(market);

            return (
              <Link
                key={market.id}
                href={`/markets/${market.id}`}
                prefetch={false}
                className="grid grid-cols-12 gap-0 px-3 py-2.5 hover:bg-primary/5 transition-colors items-center cursor-pointer group"
              >
                <div className="col-span-1">
                  <span className="text-[10px] font-mono font-bold text-primary">{capitalize(market.category)}</span>
                </div>
                <div className="col-span-1 flex items-center">
                  <div className={`h-8 w-8 rounded overflow-hidden bg-gradient-to-br ${CATEGORY_COLORS[market.category] ?? "from-muted/20 to-muted/5"}`}>
                    {market.thumbnailUrl && (
                      <img src={market.thumbnailUrl} alt="" className="h-full w-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                    )}
                  </div>
                </div>
                <div className="col-span-4 text-xs truncate group-hover:text-cyan transition-colors flex items-center gap-1.5">
                  {market.marketType === "private" && (
                    <LockKey className="h-2.5 w-2.5 shrink-0 text-primary" weight="duotone" />
                  )}
                  {market.question}
                </div>
                <div className="col-span-2 flex justify-end gap-2 font-mono text-xs">
                  {market.prices.slice(0, 2).map((p, i) => (
                    <span key={i} className={i === 0 ? "text-yes font-bold" : "text-no"}>
                      {market.outcomes[i] ?? (i === 0 ? "Yes" : "No")} {(p * 100).toFixed(0)}%
                    </span>
                  ))}
                  {market.outcomes.length > 2 && (
                    <span className="text-muted-foreground">+{market.outcomes.length - 2}</span>
                  )}
                </div>
                <div className="col-span-1 text-right font-mono text-xs">{market.volume}</div>
                <div className="col-span-1 text-right font-mono text-xs">{market.traders ?? 0}</div>
                <div className={`col-span-1 text-right font-mono text-xs ${countdown.urgent ? "text-amber blink" : "text-muted-foreground"}`}>
                  {countdown.text}
                </div>
                <div className="col-span-1 text-right">
                  <span className={`text-[10px] font-mono font-bold ${status.color}`}>{status.label}</span>
                </div>
              </Link>
            );
          })}
        </div>
        {/* Footer stats */}
        <div className="px-3 py-1.5 border-t border-border flex items-center justify-between text-[10px] font-mono text-muted-foreground">
          <span>{markets.length} markets shown</span>
          <span>Total traders: {totalTraders.toLocaleString()}</span>
        </div>
      </div>

      {/* Mobile: Compact terminal list */}
      <div className="md:hidden bg-card/50 border border-border rounded overflow-hidden backdrop-blur-xl terminal-glow">
        {markets.map((market) => (
          <MobileMarketRow key={market.id} market={market} />
        ))}
        <div className="px-3 py-1.5 border-t border-border text-[10px] font-mono text-muted-foreground">
          {markets.length} markets
        </div>
      </div>
    </>
  );
}
