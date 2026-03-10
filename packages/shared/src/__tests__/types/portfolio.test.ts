import { describe, it, expect } from "vitest";
import {
  PositionSchema,
  PortfolioSummarySchema,
  TradeHistorySchema,
  ClaimableRewardSchema,
} from "../../types/portfolio";

// ---------------------------------------------------------------------------
// Shared valid market fixture (minimal)
// ---------------------------------------------------------------------------

const validMarket = {
  id: "0xabc",
  creator: "0x1234",
  question: "Will BTC hit $100k?",
  description: "Bitcoin prediction",
  category: "crypto",
  outcomes: [
    { index: 0, label: "Yes", price: "600000000000000000" },
    { index: 1, label: "No", price: "400000000000000000" },
  ],
  collateralToken: "0xusdc",
  conditionId: "0xcondition",
  createdAt: "2025-01-01T00:00:00Z",
  resolutionTime: 1735689600,
  status: "active",
  resolved: false,
  resolvedOutcomeIndex: null,
  voided: false,
  totalVolume: "1000000",
  bondRefunded: false,
};

// ---------------------------------------------------------------------------
// PositionSchema
// ---------------------------------------------------------------------------

describe("PositionSchema", () => {
  const validPosition = {
    marketId: "m1",
    outcomeIndex: 0,
    quantity: "1000000000000000000",
    avgPrice: "500000000000000000",
    currentPrice: "600000000000000000",
    unrealizedPnl: "100000000000000000",
    market: validMarket,
  };

  it("accepts a valid position", () => {
    expect(PositionSchema.safeParse(validPosition).success).toBe(true);
  });

  it("rejects negative outcomeIndex", () => {
    expect(PositionSchema.safeParse({ ...validPosition, outcomeIndex: -1 }).success).toBe(false);
  });

  it("requires market sub-object", () => {
    const { market: _, ...noMarket } = validPosition;
    expect(PositionSchema.safeParse(noMarket).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PortfolioSummarySchema
// ---------------------------------------------------------------------------

describe("PortfolioSummarySchema", () => {
  const validSummary = {
    totalValue: "5000000000000000000",
    totalPnl: "500000000000000000",
    winRate: 0.65,
    positionsCount: 2,
    positions: [
      {
        marketId: "m1",
        outcomeIndex: 0,
        quantity: "1000000000000000000",
        avgPrice: "500000000000000000",
        currentPrice: "600000000000000000",
        unrealizedPnl: "100000000000000000",
        market: validMarket,
      },
    ],
  };

  it("accepts a valid portfolio summary", () => {
    expect(PortfolioSummarySchema.safeParse(validSummary).success).toBe(true);
  });

  it("rejects winRate > 1", () => {
    expect(PortfolioSummarySchema.safeParse({ ...validSummary, winRate: 1.5 }).success).toBe(false);
  });

  it("rejects winRate < 0", () => {
    expect(PortfolioSummarySchema.safeParse({ ...validSummary, winRate: -0.1 }).success).toBe(false);
  });

  it("accepts empty positions array", () => {
    expect(
      PortfolioSummarySchema.safeParse({ ...validSummary, positions: [], positionsCount: 0 }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TradeHistorySchema
// ---------------------------------------------------------------------------

describe("TradeHistorySchema", () => {
  const validHistory = {
    trades: [
      {
        id: "t1",
        marketId: "m1",
        maker: "0xmaker",
        taker: "0xtaker",
        outcomeIndex: 0,
        price: "500000000000000000",
        amount: "1000000000000000000",
        fee: "10000000000000000",
        txHash: null,
        timestamp: "2025-01-01T00:00:00Z",
      },
    ],
    total: 1,
    page: 1,
    pageSize: 20,
    hasMore: false,
  };

  it("accepts valid trade history", () => {
    expect(TradeHistorySchema.safeParse(validHistory).success).toBe(true);
  });

  it("accepts empty trades", () => {
    expect(
      TradeHistorySchema.safeParse({ ...validHistory, trades: [], total: 0 }).success,
    ).toBe(true);
  });

  it("rejects page 0", () => {
    expect(TradeHistorySchema.safeParse({ ...validHistory, page: 0 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClaimableRewardSchema
// ---------------------------------------------------------------------------

describe("ClaimableRewardSchema", () => {
  const validReward = {
    marketId: "m1",
    outcomeIndex: 0,
    amount: "1000000000000000000",
    market: { ...validMarket, resolved: true, resolvedOutcomeIndex: 0 },
  };

  it("accepts a valid claimable reward", () => {
    expect(ClaimableRewardSchema.safeParse(validReward).success).toBe(true);
  });

  it("rejects missing amount", () => {
    const { amount: _, ...noAmount } = validReward;
    expect(ClaimableRewardSchema.safeParse(noAmount).success).toBe(false);
  });
});
