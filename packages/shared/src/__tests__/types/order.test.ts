import { describe, it, expect } from "vitest";
import {
  OrderSchema,
  OrderSideSchema,
  OrderTypeSchema,
  OrderStatusSchema,
  TimeInForceSchema,
  SubmitOrderInputSchema,
  TradeSchema,
} from "../../types/order";

// ---------------------------------------------------------------------------
// Enum schemas
// ---------------------------------------------------------------------------

describe("OrderSideSchema", () => {
  it("accepts buy and sell", () => {
    expect(OrderSideSchema.safeParse("buy").success).toBe(true);
    expect(OrderSideSchema.safeParse("sell").success).toBe(true);
  });
  it("rejects invalid", () => {
    expect(OrderSideSchema.safeParse("long").success).toBe(false);
  });
});

describe("OrderTypeSchema", () => {
  it("accepts market and limit", () => {
    expect(OrderTypeSchema.safeParse("market").success).toBe(true);
    expect(OrderTypeSchema.safeParse("limit").success).toBe(true);
  });
  it("rejects invalid", () => {
    expect(OrderTypeSchema.safeParse("stop").success).toBe(false);
  });
});

describe("TimeInForceSchema", () => {
  it("accepts GTC, IOC, FOK", () => {
    expect(TimeInForceSchema.safeParse("GTC").success).toBe(true);
    expect(TimeInForceSchema.safeParse("IOC").success).toBe(true);
    expect(TimeInForceSchema.safeParse("FOK").success).toBe(true);
  });
  it("rejects invalid", () => {
    expect(TimeInForceSchema.safeParse("DAY").success).toBe(false);
  });
});

describe("OrderStatusSchema", () => {
  it.each(["open", "partial", "filled", "cancelled", "expired"])(
    "accepts %s",
    (status) => {
      expect(OrderStatusSchema.safeParse(status).success).toBe(true);
    },
  );
  it("rejects invalid", () => {
    expect(OrderStatusSchema.safeParse("pending").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OrderSchema
// ---------------------------------------------------------------------------

describe("OrderSchema", () => {
  const validOrder = {
    id: "order-1",
    marketId: "m1",
    side: "buy",
    type: "limit",
    outcomeIndex: 0,
    price: "500000000000000000",
    amount: "1000000000000000000",
    filledAmount: "0",
    maker: "0xabc",
    nonce: "12345",
    expiry: 0,
    signature: "0xsig",
    timeInForce: "GTC",
    status: "open",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };

  it("accepts a valid order", () => {
    expect(OrderSchema.safeParse(validOrder).success).toBe(true);
  });

  it("rejects negative outcomeIndex", () => {
    expect(OrderSchema.safeParse({ ...validOrder, outcomeIndex: -1 }).success).toBe(false);
  });

  it("rejects invalid datetime format", () => {
    expect(OrderSchema.safeParse({ ...validOrder, createdAt: "yesterday" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SubmitOrderInputSchema
// ---------------------------------------------------------------------------

describe("SubmitOrderInputSchema", () => {
  const validInput = {
    marketId: "m1",
    side: "buy",
    type: "limit",
    outcomeIndex: 0,
    price: "500000000000000000",
    amount: "1000000000000000000",
    maker: "0x1234567890abcdef1234567890abcdef12345678",
    nonce: "12345",
    expiry: 0,
    signature: "0xabcdef",
    timeInForce: "GTC",
  };

  it("accepts valid input", () => {
    expect(SubmitOrderInputSchema.safeParse(validInput).success).toBe(true);
  });

  it("rejects empty marketId", () => {
    expect(SubmitOrderInputSchema.safeParse({ ...validInput, marketId: "" }).success).toBe(false);
  });

  it("rejects non-numeric price", () => {
    expect(SubmitOrderInputSchema.safeParse({ ...validInput, price: "abc" }).success).toBe(false);
  });

  it("rejects non-numeric amount", () => {
    expect(SubmitOrderInputSchema.safeParse({ ...validInput, amount: "1.5" }).success).toBe(false);
  });

  it("rejects invalid maker address format", () => {
    expect(SubmitOrderInputSchema.safeParse({ ...validInput, maker: "not-an-address" }).success).toBe(false);
  });

  it("rejects invalid signature format", () => {
    expect(SubmitOrderInputSchema.safeParse({ ...validInput, signature: "bad" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TradeSchema
// ---------------------------------------------------------------------------

describe("TradeSchema", () => {
  const validTrade = {
    id: "trade-1",
    marketId: "m1",
    maker: "0xmaker",
    taker: "0xtaker",
    outcomeIndex: 0,
    price: "500000000000000000",
    amount: "1000000000000000000",
    fee: "10000000000000000",
    txHash: null,
    timestamp: "2025-01-01T00:00:00Z",
  };

  it("accepts a valid trade", () => {
    expect(TradeSchema.safeParse(validTrade).success).toBe(true);
  });

  it("accepts trade with txHash", () => {
    expect(TradeSchema.safeParse({ ...validTrade, txHash: "0xhash123" }).success).toBe(true);
  });

  it("rejects negative outcomeIndex", () => {
    expect(TradeSchema.safeParse({ ...validTrade, outcomeIndex: -1 }).success).toBe(false);
  });
});
