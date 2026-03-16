import { Suspense } from "react";
import Link from "next/link";
import { ArrowRight } from "@/components/ui/phosphor-icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CountUp } from "@/components/ui/count-up";

export const revalidate = 30;

const features = [
  {
    title: "Gasless Trading",
    description: "Trade without gas fees. Powered by StarkZap on Starknet for instant, free transactions.",
  },
  {
    title: "On-Chain Settlement",
    description: "Every trade is individually settled on Starknet. Your funds, your keys, fully verifiable.",
  },
  {
    title: "Fair Execution",
    description: "Dark pool matching prevents front-running. Price-time priority ensures fair fills.",
  },
  {
    title: "Multi-Outcome Markets",
    description: "Beyond binary. Trade on complex events with complementary pricing across outcomes.",
  },
];

type MarketListItem = {
  totalVolume?: string;
  traders?: number;
};

type MarketListData = {
  items?: MarketListItem[];
  total?: number;
};

type LeaderboardData = {
  total?: number;
};

type ApiEnvelope<T> = {
  success?: boolean;
  data?: T;
};

async function fetchJsonWithTimeout<T>(url: string, timeoutMs = 2_000): Promise<ApiEnvelope<T> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      next: { revalidate },
    });
    if (!response.ok) return null;
    const json = (await response.json()) as ApiEnvelope<T>;
    if (!json.success || !json.data) return null;
    return json;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function compactUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function compactInt(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.floor(value));
}

function toBigInt(value: string | undefined): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

async function loadHomeStats(): Promise<{
  totalVolume: string;
  markets: string;
  traders: string;
}> {
  const defaults = { totalVolume: "$0", markets: "0", traders: "0" };
  const internal = process.env.ENGINE_INTERNAL_URL || "http://localhost:3001";
  const base = `${internal.replace(/\/+$/, "")}/api`;

  try {
    const [marketsJson, leaderboardJson] = await Promise.all([
      fetchJsonWithTimeout<MarketListData>(`${base}/markets?page=1&pageSize=200`),
      fetchJsonWithTimeout<LeaderboardData>(`${base}/leaderboard?page=1&pageSize=1`),
    ]);

    if (!marketsJson?.data) return defaults;

    const items = marketsJson.data.items ?? [];
    const totalMarkets = typeof marketsJson.data.total === "number" ? marketsJson.data.total : items.length;

    const totalVolumeRaw = items.reduce((sum, item) => sum + toBigInt(item.totalVolume), 0n);
    const totalVolume = compactUsd(Number(totalVolumeRaw) / 1_000_000);

    const fallbackTraders = items.reduce((sum, item) => sum + (item.traders ?? 0), 0);
    const totalTraders = typeof leaderboardJson?.data?.total === "number" ? leaderboardJson.data.total : fallbackTraders;

    return {
      totalVolume,
      markets: compactInt(totalMarkets),
      traders: compactInt(totalTraders),
    };
  } catch {
    return defaults;
  }
}

const statsMeta = [
  { key: "totalVolume", label: "Volume", delay: 0 },
  { key: "markets", label: "Markets", delay: 150 },
  { key: "traders", label: "Traders", delay: 300 },
] as const;

async function HomeStats() {
  const stats = await loadHomeStats();
  return (
    <>
      {statsMeta.map(({ key, label, delay }) => (
        <div
          key={key}
          className="animate-stat-reveal glass-panel flex flex-col items-center justify-center rounded-lg px-6 py-5 min-w-[120px] sm:min-w-[140px]"
          style={{ animationDelay: `${delay}ms` }}
        >
          <CountUp value={stats[key]} className="font-mono text-2xl font-bold text-primary text-glow-amber sm:text-3xl" />
          <span className="mt-1 font-mono text-[10px] font-semibold tracking-[0.2em] text-muted-foreground/60 uppercase">{label}</span>
        </div>
      ))}
    </>
  );
}

function StatsBarSkeleton() {
  return (
    <>
      {statsMeta.map(({ key, label, delay }) => (
        <div
          key={key}
          className="animate-stat-reveal glass-panel flex flex-col items-center justify-center rounded-lg px-6 py-5 min-w-[120px] sm:min-w-[140px]"
          style={{ animationDelay: `${delay}ms` }}
        >
          <Skeleton className="h-8 w-16 rounded" />
          <span className="mt-1 font-mono text-[10px] font-semibold tracking-[0.2em] text-muted-foreground/60 uppercase">{label}</span>
        </div>
      ))}
    </>
  );
}

export default function HomePage() {
  return (
    <div className="flex flex-col">
      {/* Hero — terminal style */}
      <section className="container mx-auto max-w-screen-xl px-4 pt-16 pb-14 sm:pt-24 sm:pb-20 lg:pt-32 lg:pb-24">
        <div className="max-w-2xl">
          <div className="animate-appear mb-4 inline-flex items-center gap-2 rounded bg-primary/10 border border-primary/20 px-3 py-1.5 text-[10px] font-mono font-bold text-primary tracking-widest">
            <span className="h-1.5 w-1.5 rounded-full bg-primary blink" />
            Prediction Markets on Starknet
          </div>
          <h1 className="animate-appear font-heading text-4xl font-bold tracking-tight leading-none md:text-6xl">
            Predict the future.
            <br />
            <span className="text-primary text-glow-amber">Trade on outcomes.</span>
          </h1>
          <p className="mt-6 animate-appear max-w-[50ch] text-base leading-relaxed text-muted-foreground [animation-delay:100ms] sm:text-lg">
            Create and trade predictions on real-world events. Fast, gasless, and fully on-chain.
          </p>
          <div className="mt-8 flex animate-appear flex-col gap-3 [animation-delay:200ms] sm:flex-row sm:items-center">
            <Link href="/markets" prefetch>
              <Button size="xl" className="w-full sm:w-auto font-mono tracking-wider">
                Start Trading
              </Button>
            </Link>
            <Link href="/create" prefetch>
              <Button variant="outline" size="xl" className="w-full sm:w-auto font-mono tracking-wider">
                Create Market
              </Button>
            </Link>
          </div>
        </div>

        {/* Stats — prominent centered cards */}
        <div className="mt-14 flex flex-wrap justify-center gap-4 sm:gap-6">
          <Suspense fallback={<StatsBarSkeleton />}>
            <HomeStats />
          </Suspense>
        </div>
      </section>

      {/* Divider — glow line */}
      <div className="mx-auto w-full max-w-3xl px-4">
        <div className="glow-line" />
      </div>

      {/* Features — glass panels */}
      <section className="container mx-auto max-w-3xl px-4 py-16 sm:py-20">
        <div className="grid gap-4 sm:grid-cols-2">
          {features.map((feature) => (
            <div key={feature.title} className="glass-panel rounded-lg p-5 transition-all hover:border-primary/20">
              <h3 className="flex items-center gap-2 font-mono text-xs font-bold tracking-wider text-primary">
                <span className="inline-block h-px w-4 bg-primary" />
                {feature.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{feature.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Bridge CTA */}
      <div className="mx-auto w-full max-w-3xl px-4">
        <div className="glow-line" />
      </div>
      <section className="container mx-auto max-w-3xl px-4 py-10">
        <Link
          href="/markets"
          className="group inline-flex items-center gap-1.5 font-mono text-xs font-bold tracking-wider text-primary transition-colors duration-snappy ease-snappy hover:text-primary/80"
        >
          Explore all markets
          <ArrowRight className="h-3.5 w-3.5 transition-transform duration-snappy ease-snappy group-hover:translate-x-0.5" weight="bold" />
        </Link>
      </section>

    </div>
  );
}
