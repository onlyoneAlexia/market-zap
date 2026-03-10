import { describe, it, expect, vi, beforeEach } from "vitest";
import { MarketZapAPI, MarketZapApiError } from "../api-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetchResponse(data: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? "OK" : "Bad Request",
    json: () => Promise.resolve(ok ? { success: true, data } : data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

let api: MarketZapAPI;

beforeEach(() => {
  api = new MarketZapAPI("https://api.example.com");
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe("MarketZapAPI constructor", () => {
  it("strips trailing slashes from base URL", () => {
    const client = new MarketZapAPI("https://api.example.com///");
    // We verify by making a request and inspecting the URL
    const fetchSpy = mockFetchResponse({ items: [], total: 0, page: 0, pageSize: 20, hasMore: false });
    vi.stubGlobal("fetch", fetchSpy);
    client.getMarkets();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("https://api.example.com/markets"),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

describe("getMarkets", () => {
  it("calls GET /markets with query params", async () => {
    const responseData = { items: [], total: 0, page: 0, pageSize: 20, hasMore: false };
    const fetchSpy = mockFetchResponse(responseData);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await api.getMarkets({ category: "crypto", limit: 20, offset: 0 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0][0];
    expect(url).toContain("/markets");
    expect(url).toContain("category=crypto");
    expect(url).toContain("limit=20");
    expect(result).toEqual(responseData);
  });

  it("omits undefined query params", async () => {
    const fetchSpy = mockFetchResponse({ items: [], total: 0, page: 0, pageSize: 20, hasMore: false });
    vi.stubGlobal("fetch", fetchSpy);

    await api.getMarkets({ category: undefined });

    const url = fetchSpy.mock.calls[0][0];
    expect(url).not.toContain("category");
  });
});

describe("getMarket", () => {
  it("calls GET /markets/:id", async () => {
    const marketData = { id: "abc", question: "Test?" };
    const fetchSpy = mockFetchResponse(marketData);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await api.getMarket("abc");

    const url = fetchSpy.mock.calls[0][0];
    expect(url).toContain("/markets/abc");
    expect(result).toEqual(marketData);
  });

  it("encodes special characters in market ID", async () => {
    const fetchSpy = mockFetchResponse({});
    vi.stubGlobal("fetch", fetchSpy);

    await api.getMarket("a b/c");

    const url = fetchSpy.mock.calls[0][0];
    expect(url).toContain("/markets/a%20b%2Fc");
  });
});

describe("getMarketTrades", () => {
  it("calls GET /markets/:id/trades", async () => {
    const trades = { items: [], total: 0, page: 0, pageSize: 20, hasMore: false };
    const fetchSpy = mockFetchResponse(trades);
    vi.stubGlobal("fetch", fetchSpy);

    await api.getMarketTrades("m1", { limit: 20, offset: 20 });

    const url = fetchSpy.mock.calls[0][0];
    expect(url).toContain("/markets/m1/trades");
    expect(url).toContain("offset=20");
  });
});

describe("getMarketStats", () => {
  it("calls GET /markets/:id/stats", async () => {
    const stats = { volume24h: "100", trades24h: 5, liquidity: "200", priceHistory: [] };
    const fetchSpy = mockFetchResponse(stats);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await api.getMarketStats("m1");
    expect(result).toEqual(stats);
  });
});

describe("getMarketPrice", () => {
  it("calls GET /markets/:id/price", async () => {
    const priceData = { marketId: "m1", prices: ["0.5", "0.5"], timestamp: "2025-01-01T00:00:00Z" };
    const fetchSpy = mockFetchResponse(priceData);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await api.getMarketPrice("m1");
    expect(result).toEqual(priceData);
  });
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

describe("submitOrder", () => {
  it("translates shared order fields to engine payload", async () => {
    const fetchSpy = mockFetchResponse({ id: "o1" });
    vi.stubGlobal("fetch", fetchSpy);

    await api.submitOrder({
      marketId: "m1",
      side: "buy",
      type: "limit",
      outcomeIndex: 0,
      price: "500000000000000000",
      amount: "1000000000000000000",
      maker: "0x1234",
      nonce: "123",
      expiry: 0,
      signature: "0xabc",
      timeInForce: "GTC",
    });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.side).toBe("BID");
    expect(body.orderType).toBe("LIMIT");
    expect(body.user).toBe("0x1234");
    expect(body.signature).toBe("0xabc");
  });

  it("maps sell side to ASK", async () => {
    const fetchSpy = mockFetchResponse({ id: "o1" });
    vi.stubGlobal("fetch", fetchSpy);

    await api.submitOrder({
      marketId: "m1",
      side: "sell",
      type: "market",
      outcomeIndex: 0,
      price: "0",
      amount: "1000",
      maker: "0x1234",
      nonce: "123",
      expiry: 0,
      signature: "0xabc",
      timeInForce: "IOC",
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.side).toBe("ASK");
    expect(body.orderType).toBe("MARKET");
  });

  it("uses fallback signature when none provided", async () => {
    const fetchSpy = mockFetchResponse({ id: "o1" });
    vi.stubGlobal("fetch", fetchSpy);

    await api.submitOrder({
      marketId: "m1",
      side: "buy",
      type: "limit",
      outcomeIndex: 0,
      price: "500",
      amount: "1000",
      maker: "0x1234",
      nonce: "123",
      expiry: 0,
      signature: "",
      timeInForce: "GTC",
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.signature).toBe("0xdev");
  });
});

describe("cancelOrder", () => {
  it("calls DELETE /orders/:id with user and signature query params", async () => {
    const fetchSpy = mockFetchResponse({ cancelled: true });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await api.cancelOrder("order-123", "0xAlice", "0xsig123");
    expect(result.cancelled).toBe(true);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain("/orders/order-123");
    expect(url).toContain("user=0xAlice");
    expect(url).toContain("signature=0xsig123");
    expect(init.method).toBe("DELETE");
  });
});

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

describe("getPortfolio", () => {
  it("calls GET /portfolio/:address", async () => {
    const portfolio = { totalValue: "1000", totalPnl: "50", winRate: 0.6, positionsCount: 2, positions: [] };
    const fetchSpy = mockFetchResponse(portfolio);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await api.getPortfolio("0xabc");
    expect(result).toEqual(portfolio);
    expect(fetchSpy.mock.calls[0][0]).toContain("/portfolio/0xabc");
  });
});

describe("getTradeHistory", () => {
  it("calls GET /portfolio/:address/trades", async () => {
    const history = { trades: [], total: 0, page: 1, pageSize: 20, hasMore: false };
    const fetchSpy = mockFetchResponse(history);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await api.getTradeHistory("0xabc", { limit: 20, offset: 0 });
    expect(result).toEqual(history);
  });
});

describe("getClaimableRewards", () => {
  it("calls GET /portfolio/:address/rewards", async () => {
    const fetchSpy = mockFetchResponse([]);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await api.getClaimableRewards("0xabc");
    expect(result).toEqual([]);
    expect(fetchSpy.mock.calls[0][0]).toContain("/portfolio/0xabc/rewards");
  });
});

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

describe("getLeaderboard", () => {
  it("calls GET /leaderboard with period", async () => {
    const data = { items: [], total: 0, page: 0, pageSize: 20, hasMore: false };
    const fetchSpy = mockFetchResponse(data);
    vi.stubGlobal("fetch", fetchSpy);

    await api.getLeaderboard({ period: "7d" });

    const url = fetchSpy.mock.calls[0][0];
    expect(url).toContain("/leaderboard");
    expect(url).toContain("period=7d");
  });
});

// ---------------------------------------------------------------------------
// Auth policy
// ---------------------------------------------------------------------------

describe("Auth policy", () => {
  it("does not call auth provider for endpoints with no auth policy", async () => {
    const authProvider = vi.fn().mockResolvedValue("0xAuth:123:0xsig");
    api.setAuthProvider(authProvider);

    const fetchSpy = mockFetchResponse({ id: "o1" });
    vi.stubGlobal("fetch", fetchSpy);

    await api.submitOrder({
      marketId: "m1",
      side: "buy",
      type: "limit",
      outcomeIndex: 0,
      price: "500",
      amount: "1000",
      maker: "0x1234",
      nonce: "123",
      expiry: 0,
      signature: "0xabc",
      timeInForce: "GTC",
    });

    expect(authProvider).not.toHaveBeenCalled();
    const headers = fetchSpy.mock.calls[0][1].headers;
    expect(headers["X-MZ-Auth"]).toBeUndefined();
  });

  it("calls auth provider with 'ifAvailable' for balance endpoint", async () => {
    const authProvider = vi.fn().mockResolvedValue("0xAuth:123:0xsig");
    api.setAuthProvider(authProvider);

    const fetchSpy = mockFetchResponse({
      address: "0xabc",
      token: "0xusdc",
      balance: "1000",
      reserved: "0",
      available: "1000",
    });
    vi.stubGlobal("fetch", fetchSpy);

    await api.getBalance("0xabc", "0xusdc");

    expect(authProvider).toHaveBeenCalledWith("ifAvailable");
    const headers = fetchSpy.mock.calls[0][1].headers;
    expect(headers["X-MZ-Auth"]).toBe("0xAuth:123:0xsig");
  });

  it("attaches no auth header when provider returns null for ifAvailable", async () => {
    const authProvider = vi.fn().mockResolvedValue(null);
    api.setAuthProvider(authProvider);

    const fetchSpy = mockFetchResponse({
      address: "0xabc",
      token: "0xusdc",
      balance: "1000",
      reserved: "0",
      available: "1000",
    });
    vi.stubGlobal("fetch", fetchSpy);

    await api.getBalance("0xabc", "0xusdc");

    expect(authProvider).toHaveBeenCalledWith("ifAvailable");
    const headers = fetchSpy.mock.calls[0][1].headers;
    expect(headers["X-MZ-Auth"]).toBeUndefined();
  });

  it("does not call auth provider for cancelOrder (auth via order signature)", async () => {
    const authProvider = vi.fn().mockResolvedValue("0xAuth:123:0xsig");
    api.setAuthProvider(authProvider);

    const fetchSpy = mockFetchResponse({ cancelled: true });
    vi.stubGlobal("fetch", fetchSpy);

    await api.cancelOrder("nonce-1", "0xAlice", "0xsig");

    expect(authProvider).not.toHaveBeenCalled();
  });

  it("calls auth provider with 'ifAvailable' for portfolio endpoint", async () => {
    const authProvider = vi.fn().mockResolvedValue("cached-auth-value");
    api.setAuthProvider(authProvider);

    const fetchSpy = mockFetchResponse({ totalValue: "0", totalPnl: "0", winRate: 0, positions: [] });
    vi.stubGlobal("fetch", fetchSpy);

    await api.getPortfolio("0xabc");

    expect(authProvider).toHaveBeenCalledWith("ifAvailable");
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("Error handling", () => {
  it("throws MarketZapApiError on HTTP error", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: () => Promise.resolve({ error: "Market not found" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(api.getMarket("nonexistent")).rejects.toThrow(MarketZapApiError);
    await expect(api.getMarket("nonexistent")).rejects.toThrow("404");
  });

  it("throws MarketZapApiError when success is false", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve({ success: false, error: "Something failed" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(api.getMarkets()).rejects.toThrow(MarketZapApiError);
    await expect(api.getMarkets()).rejects.toThrow("Something failed");
  });

  it("MarketZapApiError includes status and body", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: () => Promise.resolve({ detail: "db error" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(api.getMarkets()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(MarketZapApiError);
      const apiErr = err as MarketZapApiError;
      expect(apiErr.status).toBe(500);
      expect(apiErr.body).toEqual({ detail: "db error" });
      return true;
    });
  });

  it("includes backend error details in the thrown message", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: () => Promise.resolve({ error: "Insufficient on-chain balance" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(api.getMarkets()).rejects.toThrow("Insufficient on-chain balance");
  });

  it("handles non-JSON error responses", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: () => Promise.reject(new Error("not json")),
      text: () => Promise.resolve("Bad Gateway"),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(api.getMarkets()).rejects.toThrow(MarketZapApiError);
  });

  it("throws on network failure (fetch rejects)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(api.getMarkets()).rejects.toThrow("Failed to fetch");
  });
});
