import { beforeEach, describe, expect, it, vi } from "vitest";

const getMarketsMock = vi.fn();
const getMarketMock = vi.fn();
const getMarketTradesMock = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    getMarkets: (...args: unknown[]) => getMarketsMock(...args),
    getMarket: (...args: unknown[]) => getMarketMock(...args),
    getMarketTrades: (...args: unknown[]) => getMarketTradesMock(...args),
  },
}));

import {
  DEFAULT_MARKETS_QUERY_FILTERS,
  getMarketQueryOptions,
  getMarketsQueryOptions,
  getMarketTradesQueryOptions,
} from "@/lib/market-query-options";

describe("market query options", () => {
  beforeEach(() => {
    getMarketsMock.mockReset();
    getMarketMock.mockReset();
    getMarketTradesMock.mockReset();
  });

  it("exposes stable default market filters for initial hydration", () => {
    expect(DEFAULT_MARKETS_QUERY_FILTERS).toEqual({
      category: undefined,
      search: undefined,
      sortBy: "volume",
      sortOrder: "desc",
    });
  });

  it("creates query options for the markets list", async () => {
    getMarketsMock.mockResolvedValue({ items: [] });

    const options = getMarketsQueryOptions(DEFAULT_MARKETS_QUERY_FILTERS);
    const queryFn = options.queryFn as unknown as () => Promise<{ items: unknown[] }>;

    expect(options.queryKey).toEqual([
      "markets",
      "list",
      DEFAULT_MARKETS_QUERY_FILTERS,
    ]);
    await expect(queryFn()).resolves.toEqual({ items: [] });
    expect(getMarketsMock).toHaveBeenCalledWith(DEFAULT_MARKETS_QUERY_FILTERS);
  });

  it("creates query options for market details and trades", async () => {
    getMarketMock.mockResolvedValue({ id: "m1" });
    getMarketTradesMock.mockResolvedValue({ items: [] });

    const marketOptions = getMarketQueryOptions("m1");
    const tradesOptions = getMarketTradesQueryOptions("m1");
    const marketQueryFn = marketOptions.queryFn as unknown as () => Promise<{ id: string }>;
    const tradesQueryFn = tradesOptions.queryFn as unknown as () => Promise<{ items: unknown[] }>;

    expect(marketOptions.queryKey).toEqual(["markets", "detail", "m1"]);
    await expect(marketQueryFn()).resolves.toEqual({ id: "m1" });
    expect(getMarketMock).toHaveBeenCalledWith("m1");

    expect(tradesOptions.queryKey).toEqual(["markets", "trades", "m1"]);
    await expect(tradesQueryFn()).resolves.toEqual({ items: [] });
    expect(getMarketTradesMock).toHaveBeenCalledWith("m1");
  });
});
