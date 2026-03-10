import { describe, it, expect } from "vitest";
import {
  MarketSchema,
  MarketCategorySchema,
  MarketStatusSchema,
  OutcomeSchema,
  MarketStatsSchema,
  MarketWithStatsSchema,
  CreateMarketInputSchema,
  PricePointSchema,
} from "../../types/market";

// ---------------------------------------------------------------------------
// Valid fixtures
// ---------------------------------------------------------------------------

const validOutcome = { index: 0, label: "Yes", price: "500000000000000000" };

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
// MarketCategorySchema
// ---------------------------------------------------------------------------

describe("MarketCategorySchema", () => {
  it.each(["crypto", "politics", "sports", "culture", "science"])(
    "accepts valid category: %s",
    (category) => {
      expect(MarketCategorySchema.safeParse(category).success).toBe(true);
    },
  );

  it("rejects invalid category", () => {
    expect(MarketCategorySchema.safeParse("finance").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MarketStatusSchema
// ---------------------------------------------------------------------------

describe("MarketStatusSchema", () => {
  it.each(["active", "paused", "resolved", "voided"])(
    "accepts valid status: %s",
    (status) => {
      expect(MarketStatusSchema.safeParse(status).success).toBe(true);
    },
  );

  it("rejects invalid status", () => {
    expect(MarketStatusSchema.safeParse("closed").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OutcomeSchema
// ---------------------------------------------------------------------------

describe("OutcomeSchema", () => {
  it("accepts valid outcome", () => {
    expect(OutcomeSchema.safeParse(validOutcome).success).toBe(true);
  });

  it("rejects negative index", () => {
    expect(OutcomeSchema.safeParse({ ...validOutcome, index: -1 }).success).toBe(false);
  });

  it("rejects empty label", () => {
    expect(OutcomeSchema.safeParse({ ...validOutcome, label: "" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MarketSchema
// ---------------------------------------------------------------------------

describe("MarketSchema", () => {
  it("accepts a valid market", () => {
    const result = MarketSchema.safeParse(validMarket);
    expect(result.success).toBe(true);
  });

  it("rejects empty question", () => {
    const result = MarketSchema.safeParse({ ...validMarket, question: "" });
    expect(result.success).toBe(false);
  });

  it("rejects fewer than 2 outcomes", () => {
    const result = MarketSchema.safeParse({
      ...validMarket,
      outcomes: [validOutcome],
    });
    expect(result.success).toBe(false);
  });

  it("accepts null resolvedOutcomeIndex", () => {
    const result = MarketSchema.safeParse({
      ...validMarket,
      resolvedOutcomeIndex: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts numeric resolvedOutcomeIndex", () => {
    const result = MarketSchema.safeParse({
      ...validMarket,
      resolvedOutcomeIndex: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid createdAt format", () => {
    const result = MarketSchema.safeParse({
      ...validMarket,
      createdAt: "not-a-date",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PricePointSchema
// ---------------------------------------------------------------------------

describe("PricePointSchema", () => {
  it("accepts valid price point", () => {
    expect(PricePointSchema.safeParse({ timestamp: 1234567890, prices: ["0.5", "0.5"] }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MarketStatsSchema
// ---------------------------------------------------------------------------

describe("MarketStatsSchema", () => {
  it("accepts valid stats", () => {
    const stats = {
      volume24h: "1000",
      trades24h: 42,
      liquidity: "5000",
      priceHistory: [{ timestamp: 1234567890, prices: ["0.5", "0.5"] }],
    };
    expect(MarketStatsSchema.safeParse(stats).success).toBe(true);
  });

  it("rejects negative trades24h", () => {
    expect(
      MarketStatsSchema.safeParse({
        volume24h: "1000",
        trades24h: -1,
        liquidity: "5000",
        priceHistory: [],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MarketWithStatsSchema
// ---------------------------------------------------------------------------

describe("MarketWithStatsSchema", () => {
  it("accepts market + stats merged", () => {
    const full = {
      ...validMarket,
      volume24h: "1000",
      trades24h: 42,
      liquidity: "5000",
      priceHistory: [],
    };
    expect(MarketWithStatsSchema.safeParse(full).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CreateMarketInputSchema
// ---------------------------------------------------------------------------

describe("CreateMarketInputSchema", () => {
  const validInput = {
    question: "Will ETH flip BTC in 2025?",
    description: "Market cap flippening",
    category: "crypto",
    outcomes: ["Yes", "No"],
    collateralToken: "0x1234567890abcdef1234567890abcdef12345678",
    resolutionTime: Math.floor(Date.now() / 1000) + 86400,
  };

  it("accepts valid input", () => {
    expect(CreateMarketInputSchema.safeParse(validInput).success).toBe(true);
  });

  it("rejects question shorter than 10 chars", () => {
    expect(CreateMarketInputSchema.safeParse({ ...validInput, question: "Short?" }).success).toBe(false);
  });

  it("rejects fewer than 2 outcomes", () => {
    expect(CreateMarketInputSchema.safeParse({ ...validInput, outcomes: ["Yes"] }).success).toBe(false);
  });

  it("rejects more than 8 outcomes", () => {
    const nineOutcomes = Array.from({ length: 9 }, (_, i) => `Option ${i}`);
    expect(CreateMarketInputSchema.safeParse({ ...validInput, outcomes: nineOutcomes }).success).toBe(false);
  });

  it("rejects past resolution time", () => {
    expect(
      CreateMarketInputSchema.safeParse({ ...validInput, resolutionTime: 1000 }).success,
    ).toBe(false);
  });

  it("rejects invalid collateral token address", () => {
    expect(
      CreateMarketInputSchema.safeParse({ ...validInput, collateralToken: "invalid" }).success,
    ).toBe(false);
  });
});
