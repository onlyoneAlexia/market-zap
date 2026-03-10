import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";
import { MarketDetailClient } from "@/app/markets/[id]/market-detail-client";
import {
  getMarketQueryOptions,
  getMarketTradesQueryOptions,
} from "@/lib/market-query-options";

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
