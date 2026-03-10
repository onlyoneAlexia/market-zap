import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";
import { MarketsPageClient } from "@/app/markets/markets-page-client";
import {
  DEFAULT_MARKETS_QUERY_FILTERS,
  getMarketsQueryOptions,
} from "@/lib/market-query-options";

export default async function MarketsPage() {
  const queryClient = new QueryClient();
  await queryClient.prefetchQuery(
    getMarketsQueryOptions(DEFAULT_MARKETS_QUERY_FILTERS),
  );

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <MarketsPageClient />
    </HydrationBoundary>
  );
}
