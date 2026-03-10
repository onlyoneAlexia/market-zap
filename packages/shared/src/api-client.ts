import type {
  Market,
  MarketWithStats,
  MarketStats,
  Trade,
  Order,
  SubmitOrderInput,
  PortfolioSummary,
  TradeHistory,
  ClaimableReward,
} from "./types/index";

// ---------------------------------------------------------------------------
// Response wrappers
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface LeaderboardEntry {
  address: string;
  totalPnl: string;
  totalVolume: string;
  tradesCount: number;
  winRate: number;
  rank: number;
}

export interface MarketPriceResponse {
  marketId: string;
  prices: string[];
  timestamp: string;
}

export interface OpenOrderEntry {
  nonce: string;
  marketId: string;
  outcomeIndex: number;
  side: "BID" | "ASK";
  orderType: "LIMIT" | "MARKET";
  price: string;
  amount: string;
  filledAmount: string;
  status: "OPEN" | "PARTIALLY_FILLED";
  expiry: number;
  createdAt: string;
}

export interface SubmitOrderResponse {
  order: {
    nonce: string;
    status: string;
    filledAmount: string;
    remainingAmount: string;
    restingOnBook: boolean;
  };
  trades: Array<{
    id: string;
    price: string;
    fillAmount: string;
    txHash: string | null;
    settled: boolean;
    /** Whether this fill came from the CLOB order book or the AMM. */
    source?: "clob" | "amm";
  }>;
}

export interface BalanceResponse {
  address: string;
  token: string;
  balance: string;
  reserved: string;
  available: string;
  /** Raw ERC-20 wallet balance (not deposited into the exchange). */
  walletBalance?: string;
  /** On-chain ERC-20 decimals for the wallet balance. */
  walletDecimals?: number;
  /** Decimals used by the exchange engine for this token. */
  exchangeDecimals?: number;
}

export interface QuoteResponse {
  marketId: string;
  outcomeIndex: number;
  side: "BUY" | "SELL";
  maxAvailable: string;
  clobAvailable: string;
  ammAvailable: string;
  spotPrice: string;
  quote: {
    amount: string;
    avgPrice: string;
    totalCost: string;
    slippage: string;
    canFill: boolean;
    clobFill: string;
    ammFill: string;
  } | null;
  timestamp: string;
}

export interface OrderBookLevel {
  price: string;
  size: string;
  orders: number;
}

export interface OrderBookResponse {
  marketId: string;
  outcomeIndex: number;
  depth: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  spread: string | null;
  timestamp: string;
}

export interface TxTraceEvent {
  index: number;
  fromAddress: string;
  fromLabel: string;
  selector: string;
  kind: "erc20_transfer" | "erc1155_transfer_single" | "contract_event";
  summary: string;
  operator?: string;
  from?: string;
  to?: string;
  tokenId?: string;
  amount?: string;
  raw: {
    keys: string[];
    data: string[];
  };
}

export interface TxTraceResponse {
  txHash: string;
  executionStatus: string;
  finalityStatus: string;
  eventCount: number;
  events: TxTraceEvent[];
}

export interface GetQuoteParams {
  outcomeIndex?: number;
  side?: "BUY" | "SELL";
  amount?: number;
}

export interface GetOrderBookParams {
  outcomeIndex?: number;
  depth?: number;
}

// ---------------------------------------------------------------------------
// Query parameter types
// ---------------------------------------------------------------------------

export interface GetMarketsParams {
  category?: string;
  status?: string;
  marketType?: "public" | "private";
  limit?: number;
  offset?: number;
  sortBy?: "volume" | "createdAt" | "resolutionTime";
  sortOrder?: "asc" | "desc";
  search?: string;
}

export interface GetTradesParams {
  limit?: number;
  offset?: number;
}

export interface GetLeaderboardParams {
  limit?: number;
  offset?: number;
  period?: "24h" | "7d" | "30d" | "all";
}

// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------

export class MarketZapApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "MarketZapApiError";
  }
}

/**
 * REST API client for the Market-Zap CLOB engine.
 *
 * All methods return typed responses and throw {@link MarketZapApiError} on
 * non-2xx HTTP responses.
 *
 * @example
 * ```ts
 * const api = new MarketZapAPI("https://api.marketzap.xyz");
 * const markets = await api.getMarkets({ category: "crypto" });
 * ```
 */
/**
 * Auth policy for individual API requests.
 * - `none`        — No auth header attached.
 * - `ifAvailable` — Attach cached auth if available; never trigger wallet signing.
 * - `interactive` — May trigger a wallet signing popup if cache is expired.
 */
export type AuthPolicy = "none" | "ifAvailable" | "interactive";

/**
 * Callback that produces an `X-MZ-Auth` header value for dark market auth.
 * @param mode — `ifAvailable` returns cached value only; `interactive` may prompt.
 * Returns `"address:timestamp:r,s"` or null if no auth is available.
 */
export type DarkAuthProvider = (mode: "ifAvailable" | "interactive") => Promise<string | null> | string | null;

export class MarketZapAPI {
  private readonly baseUrl: string;
  private authProvider: DarkAuthProvider | null = null;

  constructor(baseUrl: string) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /**
   * Set a callback that produces `X-MZ-Auth` headers for dark market endpoints.
   * The provider is called on every request to user-specific endpoints.
   */
  setAuthProvider(provider: DarkAuthProvider | null): void {
    this.authProvider = provider;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string | number | undefined>,
    extraHeaders?: Record<string, string>,
    authPolicy: AuthPolicy = "none",
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    // Attach auth header based on per-request policy
    const authHeaders: Record<string, string> = {};
    if (authPolicy !== "none" && this.authProvider) {
      const authValue = await this.authProvider(authPolicy);
      if (authValue) {
        authHeaders["X-MZ-Auth"] = authValue;
      }
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...authHeaders,
      ...extraHeaders,
    };

    const init: RequestInit = {
      method,
      headers,
    };

    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url.toString(), init);

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text().catch(() => undefined);
      }

      const detail = extractErrorDetail(errorBody);
      const message = detail
        ? `API request failed: ${response.status} ${response.statusText} - ${detail}`
        : `API request failed: ${response.status} ${response.statusText}`;

      throw new MarketZapApiError(
        message,
        response.status,
        errorBody,
      );
    }

    const json = (await response.json()) as ApiResponse<T>;

    if (!json.success) {
      throw new MarketZapApiError(
        json.error ?? "Unknown API error",
        response.status,
        json,
      );
    }

    return json.data;
  }

  private get<T>(
    path: string,
    params?: Record<string, string | number | undefined>,
    authPolicy: AuthPolicy = "none",
  ): Promise<T> {
    return this.request<T>("GET", path, undefined, params, undefined, authPolicy);
  }

  private post<T>(path: string, body: unknown, authPolicy: AuthPolicy = "none"): Promise<T> {
    return this.request<T>("POST", path, body, undefined, undefined, authPolicy);
  }

  private delete<T>(
    path: string,
    params?: Record<string, string | number | undefined>,
    authPolicy: AuthPolicy = "none",
  ): Promise<T> {
    return this.request<T>("DELETE", path, undefined, params, undefined, authPolicy);
  }

  // -----------------------------------------------------------------------
  // Markets
  // -----------------------------------------------------------------------

  /**
   * Fetch a paginated list of markets with optional filtering.
   */
  async getMarkets(
    params?: GetMarketsParams,
  ): Promise<PaginatedResponse<Market>> {
    return this.get<PaginatedResponse<Market>>("/markets", params as Record<string, string | number | undefined>);
  }

  /**
   * Fetch a single market by ID.
   */
  async getMarket(marketId: string): Promise<MarketWithStats> {
    return this.get<MarketWithStats>(`/markets/${encodeURIComponent(marketId)}`);
  }

  /**
   * Fetch recent trades for a market.
   */
  async getMarketTrades(
    marketId: string,
    params?: GetTradesParams,
  ): Promise<PaginatedResponse<Trade>> {
    return this.get<PaginatedResponse<Trade>>(
      `/markets/${encodeURIComponent(marketId)}/trades`,
      params as Record<string, string | number | undefined>,
    );
  }

  /**
   * Fetch aggregated stats for a market (volume, liquidity, price history).
   */
  async getMarketStats(
    marketId: string,
    opts?: { interval?: "1h" | "6h" | "1d"; limit?: number },
  ): Promise<MarketStats> {
    const params: Record<string, string | number> = {};
    if (opts?.interval) params.interval = opts.interval;
    if (opts?.limit) params.limit = opts.limit;
    return this.get<MarketStats>(
      `/markets/${encodeURIComponent(marketId)}/stats`,
      Object.keys(params).length > 0 ? params : undefined,
    );
  }

  /**
   * Fetch the latest prices for all outcomes in a market.
   */
  async getMarketPrice(marketId: string): Promise<MarketPriceResponse> {
    return this.get<MarketPriceResponse>(
      `/markets/${encodeURIComponent(marketId)}/price`,
    );
  }

  /**
   * Fetch a pre-trade liquidity quote for a market outcome.
   * Returns max available tokens and optionally a detailed quote with slippage.
   */
  async getMarketQuote(
    marketId: string,
    params?: GetQuoteParams,
  ): Promise<QuoteResponse> {
    return this.get<QuoteResponse>(
      `/markets/${encodeURIComponent(marketId)}/quote`,
      params as Record<string, string | number | undefined>,
    );
  }

  /**
   * Fetch aggregated order book levels for one outcome.
   */
  async getMarketOrderBook(
    marketId: string,
    params?: GetOrderBookParams,
  ): Promise<OrderBookResponse> {
    return this.get<OrderBookResponse>(
      `/markets/${encodeURIComponent(marketId)}/orderbook`,
      params as Record<string, string | number | undefined>,
    );
  }

  // -----------------------------------------------------------------------
  // Orders
  // -----------------------------------------------------------------------

  /**
   * Submit a signed order to the CLOB engine.
   *
   * Translates the shared {@link SubmitOrderInput} field names to the engine's
   * internal schema (e.g. `buy` → `BID`, `type` → `orderType`, `maker` → `user`).
   */
  async submitOrder(order: SubmitOrderInput): Promise<SubmitOrderResponse> {
    const enginePayload = {
      marketId: order.marketId,
      outcomeIndex: order.outcomeIndex,
      side: order.side === "buy" ? "BID" : "ASK",
      orderType: order.type.toUpperCase(),
      price: order.price,
      amount: order.amount,
      user: order.maker,
      nonce: order.nonce,
      expiry: order.expiry,
      signature: order.signature && order.signature.length > 0 ? order.signature : "0xdev",
    };
    return this.post<SubmitOrderResponse>("/orders", enginePayload);
  }

  /**
   * Cancel an open order by nonce. The caller must prove ownership by
   * providing their address and the order's original signature.
   * @param nonce - The order nonce to cancel.
   * @param user - The caller's address (must match the order maker).
   * @param signature - The order's original signature (proof of ownership).
   */
  async cancelOrder(nonce: string, user: string, signature: string): Promise<{ cancelled: boolean }> {
    return this.delete<{ cancelled: boolean }>(
      `/orders/${encodeURIComponent(nonce)}`,
      { user, signature },
    );
  }

  /**
   * Fetch open/partially-filled orders for a user.
   */
  async getOpenOrders(
    user: string,
    params?: { limit?: number; offset?: number; marketId?: string },
  ): Promise<PaginatedResponse<OpenOrderEntry>> {
    return this.get<PaginatedResponse<OpenOrderEntry>>("/orders", {
      user,
      ...params,
    } as Record<string, string | number | undefined>, "ifAvailable");
  }

  // -----------------------------------------------------------------------
  // Portfolio
  // -----------------------------------------------------------------------

  /**
   * Fetch the portfolio summary for an address.
   */
  async getPortfolio(address: string): Promise<PortfolioSummary> {
    return this.get<PortfolioSummary>(
      `/portfolio/${encodeURIComponent(address)}`,
      undefined,
      "ifAvailable",
    );
  }

  /**
   * Fetch trade history for an address.
   */
  async getTradeHistory(
    address: string,
    params?: GetTradesParams,
  ): Promise<TradeHistory> {
    return this.get<TradeHistory>(
      `/portfolio/${encodeURIComponent(address)}/trades`,
      params as Record<string, string | number | undefined>,
      "ifAvailable",
    );
  }

  /**
   * Fetch claimable rewards for an address (resolved markets).
   */
  async getClaimableRewards(address: string): Promise<ClaimableReward[]> {
    return this.get<ClaimableReward[]>(
      `/portfolio/${encodeURIComponent(address)}/rewards`,
      undefined,
      "ifAvailable",
    );
  }

  // -----------------------------------------------------------------------
  // Balance
  // -----------------------------------------------------------------------

  /**
   * Fetch the on-chain balance for a user and token.
   */
  async getBalance(address: string, token: string): Promise<BalanceResponse> {
    return this.get<BalanceResponse>(
      `/balance/${encodeURIComponent(address)}/${encodeURIComponent(token)}`,
      undefined,
      "ifAvailable",
    );
  }

  /**
   * Decode token/settlement events for a Starknet transaction hash.
   */
  async getTxTrace(txHash: string): Promise<TxTraceResponse> {
    return this.get<TxTraceResponse>(
      `/tx/${encodeURIComponent(txHash)}/events`,
    );
  }

  // -----------------------------------------------------------------------
  // Leaderboard
  // -----------------------------------------------------------------------

  /**
   * Fetch the trader leaderboard.
   */
  async getLeaderboard(
    params?: GetLeaderboardParams,
  ): Promise<PaginatedResponse<LeaderboardEntry>> {
    return this.get<PaginatedResponse<LeaderboardEntry>>("/leaderboard", params as Record<string, string | number | undefined>);
  }

  /**
   * Record a successful on-chain claim so the position stops showing as claimable.
   */
  async recordClaim(
    address: string,
    marketId: string,
    outcomeIndex: number,
    txHash: string,
  ): Promise<{ claimed: boolean }> {
    return this.post<{ claimed: boolean }>(
      `/portfolio/${encodeURIComponent(address)}/claim`,
      { marketId, outcomeIndex, txHash },
    );
  }

  // -----------------------------------------------------------------------
  // Admin
  // -----------------------------------------------------------------------

  /**
   * Resolve a market on-chain and in the DB (admin only).
   *
   * Calls the engine's admin endpoint which handles both the propose +
   * finalize phases atomically.
   */
  async resolveMarket(
    marketId: string,
    winningOutcome: number,
    apiKey?: string,
  ): Promise<{ market: Market; txHash: string }> {
    const authHeaders: Record<string, string> = apiKey
      ? { Authorization: `Bearer ${apiKey}` }
      : {};
    return this.request<{ market: Market; txHash: string }>(
      "POST",
      "/admin/resolve-market",
      { marketId, winningOutcome },
      undefined,
      authHeaders,
    );
  }
}

function extractErrorDetail(errorBody: unknown): string | null {
  if (typeof errorBody === "string") {
    const trimmed = errorBody.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (!errorBody || typeof errorBody !== "object") {
    return null;
  }

  const candidates: unknown[] = [
    (errorBody as Record<string, unknown>).error,
    (errorBody as Record<string, unknown>).message,
    (errorBody as Record<string, unknown>).detail,
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}
