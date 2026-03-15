import type { Metadata } from "next";
import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";
import { MarketDetailClient } from "@/app/markets/[id]/market-detail-client";
import {
  getMarketQueryOptions,
  getMarketTradesQueryOptions,
} from "@/lib/market-query-options";
import { api } from "@/lib/api";

function formatPrice(raw: string | undefined): string {
  if (!raw) return "—";
  const n = parseFloat(raw);
  if (isNaN(n)) return "—";
  return `${Math.round(n * 100)}¢`;
}

function formatVolume(raw: string | undefined): string {
  if (!raw) return "$0";
  const n = parseFloat(raw);
  if (isNaN(n) || n === 0) return "$0";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;

  try {
    const market = await api.getMarket(id);

    const yesOutcome = market.outcomes?.find((o) => o.label.toLowerCase() === "yes");
    const noOutcome = market.outcomes?.find((o) => o.label.toLowerCase() === "no");
    const yesPrice = formatPrice(yesOutcome?.price);
    const noPrice = formatPrice(noOutcome?.price);

    const title = market.question;
    const description = market.description
      ? `${market.description.slice(0, 150)}${market.description.length > 150 ? "…" : ""}`
      : `Yes ${yesPrice} · No ${noPrice} — Trade on MarketZap`;

    const endDate = market.resolutionTime
      ? new Date(market.resolutionTime * 1000).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "";

    const ogParams = new URLSearchParams({
      question: market.question,
      yes: yesPrice,
      no: noPrice,
      volume: formatVolume(market.totalVolume),
      traders: String(market.traders ?? 0),
      status: market.status,
      category: market.category ?? "",
      end: endDate,
    });

    const ogImageUrl = `/api/og/market?${ogParams.toString()}`;

    return {
      title,
      description,
      openGraph: {
        title,
        description,
        type: "website",
        siteName: "MarketZap",
        images: [{ url: ogImageUrl, width: 1200, height: 630, alt: market.question }],
      },
      twitter: {
        card: "summary_large_image",
        title,
        description,
        images: [ogImageUrl],
      },
    };
  } catch {
    return {
      title: "Market",
      description: "Prediction market on MarketZap",
    };
  }
}

export default async function MarketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const queryClient = new QueryClient();

  await Promise.all([
    queryClient.prefetchQuery(getMarketQueryOptions(id)),
    queryClient.prefetchQuery(getMarketTradesQueryOptions(id)),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <MarketDetailClient id={id} />
    </HydrationBoundary>
  );
}
