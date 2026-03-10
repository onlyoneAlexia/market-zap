"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-client";
import { api } from "@/lib/api";

export function useLeaderboard(period?: "24h" | "7d" | "30d" | "all") {
  return useQuery({
    queryKey: queryKeys.leaderboard.all(period),
    queryFn: () => api.getLeaderboard({ period }),
    staleTime: 60_000,
  });
}
