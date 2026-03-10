export const queryKeys = {
  markets: {
    all: ["markets"] as const,
    list: (filters?: object) =>
      ["markets", "list", filters] as const,
    detail: (id: string) => ["markets", "detail", id] as const,
    trades: (id: string) => ["markets", "trades", id] as const,
    stats: (id: string) => ["markets", "stats", id] as const,
    price: (id: string, outcome: number) =>
      ["markets", "price", id, outcome] as const,
  },
  portfolio: {
    all: (address: string) => ["portfolio", address] as const,
    positions: (address: string) => ["portfolio", "positions", address] as const,
    history: (address: string) => ["portfolio", "history", address] as const,
    claimable: (address: string) =>
      ["portfolio", "claimable", address] as const,
  },
  leaderboard: {
    all: (period?: string) => ["leaderboard", period] as const,
  },
  balance: (address: string, token: string) =>
    ["balance", address, token] as const,
  quote: (marketId: string, outcome: number) =>
    ["quote", marketId, outcome] as const,
  liquidity: (marketId: string, outcome: number, side: string) =>
    ["liquidity", marketId, outcome, side] as const,
  liquidityQuote: (
    marketId: string,
    outcome: number,
    side: string,
    amount?: number,
  ) => ["liquidity", marketId, outcome, side, amount ?? null] as const,
  orderbook: (marketId: string, outcome: number, depth: number) =>
    ["orderbook", marketId, outcome, depth] as const,
  orders: {
    open: (address: string, marketId?: string) =>
      ["orders", "open", address, marketId] as const,
  },
} as const;
