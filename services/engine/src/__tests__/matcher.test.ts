import { describe, it, expect, beforeEach, vi } from "vitest";
import { OrderBook, type OrderEntry } from "../orderbook.js";
import { Matcher, type MatchResult, type AmmConfig, type AmmSignParams } from "../matcher.js";
import { AmmStateManager } from "../amm-state.js";
import { createMockRedis, MockRedisClient } from "./mock-redis.js";

function makeOrder(overrides: Partial<OrderEntry> = {}): OrderEntry {
  const base: OrderEntry = {
    nonce: `nonce_${Math.random().toString(36).slice(2, 8)}`,
    marketId: "market_1",
    outcomeIndex: 0,
    side: "BID",
    price: "0.65",
    amount: "100",
    remainingAmount: "100",
    user: "0xAlice",
    createdAt: new Date().toISOString(),
    signature: "sig_test",
    orderType: "LIMIT",
    expiry: 0,
  };
  const merged: OrderEntry = { ...base, ...overrides };
  return {
    ...merged,
    remainingAmount: overrides.remainingAmount ?? merged.amount,
  };
}

describe("Matcher", () => {
  let redis: ReturnType<typeof createMockRedis>;
  let book: OrderBook;
  let matcher: Matcher;

  beforeEach(() => {
    redis = createMockRedis();
    (redis as unknown as MockRedisClient).clear?.();
    book = new OrderBook(redis);
    matcher = new Matcher(book);
  });

  describe("limit orders — no match", () => {
    it("rests a limit BID on an empty book", async () => {
      const bid = makeOrder({ side: "BID", price: "0.65", amount: "100" });
      const result = await matcher.match(bid);

      expect(result.trades.length).toBe(0);
      expect(result.remainingAmount).toBe(100n);
      expect(result.restingOnBook).toBe(true);

      const best = await book.getBestBid("market_1", 0);
      expect(best).not.toBeNull();
      expect(best!.amount).toBe("100");
      expect(best!.remainingAmount).toBe("100");
    });

    it("rests a limit ASK on an empty book", async () => {
      const ask = makeOrder({ side: "ASK", price: "0.70", amount: "50" });
      const result = await matcher.match(ask);

      expect(result.trades.length).toBe(0);
      expect(result.restingOnBook).toBe(true);
    });

    it("does not match when bid < ask", async () => {
      // Resting ASK at 0.70
      await book.addOrder(makeOrder({ side: "ASK", price: "0.70", nonce: "ask1" }));

      // Incoming BID at 0.65 — not marketable
      const bid = makeOrder({ side: "BID", price: "0.65", amount: "100" });
      const result = await matcher.match(bid);

      expect(result.trades.length).toBe(0);
      expect(result.restingOnBook).toBe(true);
      expect(await book.depth("market_1", 0, "BID")).toBe(1);
      expect(await book.depth("market_1", 0, "ASK")).toBe(1);
    });
  });

  describe("limit orders — full match", () => {
    it("fully matches a BID against a resting ASK at the same price", async () => {
      // Resting ASK at 0.65 for 100
      await book.addOrder(
        makeOrder({
          nonce: "ask_rest",
          side: "ASK",
          price: "0.65",
          amount: "100",
          user: "0xBob",
        }),
      );

      // Incoming BID at 0.65 for 100
      const bid = makeOrder({
        nonce: "bid_incoming",
        side: "BID",
        price: "0.65",
        amount: "100",
        user: "0xAlice",
      });
      const result = await matcher.match(bid);

      expect(result.trades.length).toBe(1);
      expect(result.remainingAmount).toBe(0n);
      expect(result.restingOnBook).toBe(false);

      const trade = result.trades[0];
      expect(trade.buyer).toBe("0xAlice");
      expect(trade.seller).toBe("0xBob");
      expect(trade.fillAmount).toBe("100");
      expect(trade.price).toBe("0.65"); // resting order's price

      // Book should be empty
      expect(await book.depth("market_1", 0, "ASK")).toBe(0);
      expect(await book.depth("market_1", 0, "BID")).toBe(0);
    });

    it("fully matches an ASK against a resting BID", async () => {
      // Resting BID at 0.70 for 50
      await book.addOrder(
        makeOrder({
          nonce: "bid_rest",
          side: "BID",
          price: "0.70",
          amount: "50",
          user: "0xBob",
        }),
      );

      // Incoming ASK at 0.65 for 50 — marketable because ask <= bid
      const ask = makeOrder({
        nonce: "ask_incoming",
        side: "ASK",
        price: "0.65",
        amount: "50",
        user: "0xAlice",
      });
      const result = await matcher.match(ask);

      expect(result.trades.length).toBe(1);
      expect(result.remainingAmount).toBe(0n);

      const trade = result.trades[0];
      expect(trade.buyer).toBe("0xBob"); // resting BID user
      expect(trade.seller).toBe("0xAlice"); // incoming ASK user
      expect(trade.price).toBe("0.70"); // resting order's price (price improvement for taker)
    });
  });

  describe("partial fills", () => {
    it("fills min(incoming, resting) when incoming is larger — remainder rests for LIMIT", async () => {
      // Resting ASK: 50 units at 0.65
      await book.addOrder(
        makeOrder({
          nonce: "ask_rest",
          side: "ASK",
          price: "0.65",
          amount: "50",
          user: "0xBob",
        }),
      );

      // Incoming BID: 100 units at 0.65
      const bid = makeOrder({
        side: "BID",
        price: "0.65",
        amount: "100",
        remainingAmount: "100",
        user: "0xAlice",
      });
      const result = await matcher.match(bid);

      expect(result.trades.length).toBe(1);
      expect(result.trades[0].fillAmount).toBe("50");
      expect(result.remainingAmount).toBe(50n);
      // Limit remainder rests on the book.
      expect(result.restingOnBook).toBe(true);

      // Book should contain the resting remainder BID.
      expect(await book.depth("market_1", 0, "BID")).toBe(1);
      expect(await book.depth("market_1", 0, "ASK")).toBe(0);
    });

    it("fills min(incoming, resting) when incoming is smaller — resting remains with reduced remainingAmount", async () => {
      // Resting ASK: 100 units at 0.65
      await book.addOrder(
        makeOrder({
          nonce: "ask_rest",
          side: "ASK",
          price: "0.65",
          amount: "100",
          user: "0xBob",
        }),
      );

      // Incoming BID: 30 units at 0.65
      const bid = makeOrder({
        side: "BID",
        price: "0.65",
        amount: "30",
        remainingAmount: "30",
      });
      const result = await matcher.match(bid);

      expect(result.trades.length).toBe(1);
      expect(result.trades[0].fillAmount).toBe("30");
      expect(result.remainingAmount).toBe(0n);

      // Resting ASK remains with remainingAmount=70.
      const bestAsk = await book.getBestAsk("market_1", 0);
      expect(bestAsk).not.toBeNull();
      expect(bestAsk!.amount).toBe("100"); // original signed amount
      expect(bestAsk!.remainingAmount).toBe("70");
    });
  });

  describe("multi-level matching", () => {
    it("sweeps multiple resting orders until not marketable or filled", async () => {
      // 3 resting ASKs at various prices
      await book.addOrder(
        makeOrder({ nonce: "a1", side: "ASK", price: "0.60", amount: "30", user: "0xBob" }),
      );
      await book.addOrder(
        makeOrder({ nonce: "a2", side: "ASK", price: "0.65", amount: "40", user: "0xCarol" }),
      );
      await book.addOrder(
        makeOrder({ nonce: "a3", side: "ASK", price: "0.70", amount: "50", user: "0xDave" }),
      );

      // Incoming BID for 100 units at 0.65 — matches a1 (0.60) + a2 (0.65),
      // then stops because a3 (0.70) is not marketable.
      const bid = makeOrder({
        side: "BID",
        price: "0.65",
        amount: "100",
        remainingAmount: "100",
      });
      const result = await matcher.match(bid);

      expect(result.trades.length).toBe(2);
      expect(result.trades[0].fillAmount).toBe("30");
      expect(result.trades[0].price).toBe("0.60");
      expect(result.trades[1].fillAmount).toBe("40");
      expect(result.trades[1].price).toBe("0.65");
      expect(result.remainingAmount).toBe(30n);
      expect(result.restingOnBook).toBe(true); // remainder rests for LIMIT

      // a1 + a2 consumed, a3 remains, and the remainder BID rests.
      expect(await book.depth("market_1", 0, "ASK")).toBe(1);
      expect(await book.depth("market_1", 0, "BID")).toBe(1);
    });
  });

  describe("market orders", () => {
    it("market BID matches best ASK regardless of price", async () => {
      await book.addOrder(
        makeOrder({ nonce: "a1", side: "ASK", price: "0.80", amount: "50", user: "0xBob" }),
      );
      await book.addOrder(
        makeOrder({ nonce: "a2", side: "ASK", price: "0.90", amount: "50", user: "0xCarol" }),
      );

      const marketBid = makeOrder({
        side: "BID",
        price: "0", // irrelevant for market orders
        amount: "100",
        remainingAmount: "100",
        orderType: "MARKET",
      });
      const result = await matcher.match(marketBid);

      // Sweeps the book until filled.
      expect(result.trades.length).toBe(2);
      expect(result.trades[0].fillAmount).toBe("50");
      expect(result.trades[1].fillAmount).toBe("50");
      expect(result.remainingAmount).toBe(0n);
      expect(result.restingOnBook).toBe(false); // market orders never rest
    });

    it("market order with unfilled remainder does NOT rest on book", async () => {
      await book.addOrder(
        makeOrder({ nonce: "a1", side: "ASK", price: "0.65", amount: "30", user: "0xBob" }),
      );

      const marketBid = makeOrder({
        side: "BID",
        price: "0",
        amount: "100",
        remainingAmount: "100",
        orderType: "MARKET",
      });
      const result = await matcher.match(marketBid);

      expect(result.trades.length).toBe(1);
      expect(result.remainingAmount).toBe(70n);
      expect(result.restingOnBook).toBe(false);

      // Book should be empty (resting order consumed)
      expect(await book.depth("market_1", 0, "BID")).toBe(0);
      expect(await book.depth("market_1", 0, "ASK")).toBe(0);
    });
  });

  describe("price improvement", () => {
    it("executes at resting order price, not incoming price", async () => {
      // Resting ASK at 0.60
      await book.addOrder(
        makeOrder({ nonce: "a1", side: "ASK", price: "0.60", amount: "100", user: "0xBob" }),
      );

      // Incoming BID at 0.70 — willing to pay more
      const bid = makeOrder({
        side: "BID",
        price: "0.70",
        amount: "100",
        user: "0xAlice",
      });
      const result = await matcher.match(bid);

      // Execution at 0.60 (resting price) — Alice gets price improvement
      expect(result.trades[0].price).toBe("0.60");
    });
  });

  describe("self-trade", () => {
    it("does not prevent self-trade (engine layer responsibility)", async () => {
      // Both orders from the same user
      await book.addOrder(
        makeOrder({ nonce: "a1", side: "ASK", price: "0.65", amount: "50", user: "0xAlice" }),
      );

      const bid = makeOrder({
        side: "BID",
        price: "0.65",
        amount: "50",
        user: "0xAlice",
      });
      const result = await matcher.match(bid);

      // Matcher does not enforce self-trade prevention (that's a higher-level concern)
      expect(result.trades.length).toBe(1);
    });
  });

  describe("trade metadata", () => {
    it("assigns unique trade IDs with correct format", async () => {
      await book.addOrder(
        makeOrder({ nonce: "a1", side: "ASK", price: "0.60", amount: "30", user: "0xBob" }),
      );

      const bid = makeOrder({ side: "BID", price: "0.65", amount: "30" });
      const result = await matcher.match(bid);

      expect(result.trades.length).toBe(1);
      expect(result.trades[0].id).toMatch(/^trade_/);
    });

    it("correctly assigns buyer/seller nonces", async () => {
      await book.addOrder(
        makeOrder({
          nonce: "seller_nonce",
          side: "ASK",
          price: "0.65",
          amount: "100",
          user: "0xBob",
        }),
      );

      const bid = makeOrder({
        nonce: "buyer_nonce",
        side: "BID",
        price: "0.65",
        amount: "100",
        user: "0xAlice",
      });
      const result = await matcher.match(bid);

      expect(result.trades[0].buyerNonce).toBe("buyer_nonce");
      expect(result.trades[0].sellerNonce).toBe("seller_nonce");
    });
  });
});

// ---------------------------------------------------------------------------
// Hybrid CLOB + AMM tests
// ---------------------------------------------------------------------------

function makeAmmConfig(redis: ReturnType<typeof createMockRedis>): AmmConfig {
  const ammState = new AmmStateManager(redis);
  return {
    ammState,
    adminAddress: "0xAdmin",
    signAdminOrder: (_params: AmmSignParams) => "amm_sig_test",
    getMarketInfo: async (_marketId: string) => ({
      onChainMarketId: "1",
      conditionId: "0xCond",
      collateralDecimals: 6, // amounts in test are small, treated as 6-decimal
    }),
    computeTokenId: (_conditionId: string, _outcomeIndex: number) => 123n,
    scalePrice: (price: string | number) => {
      const p = typeof price === "number" ? price : Number(price);
      return BigInt(Math.round(p * 1e18));
    },
    checkAdminCollateralBalance: async () => 1_000_000_000n,
    checkAdminOutcomeBalance: async () => 1_000_000_000n,
  };
}

describe("Matcher — AMM fallback", () => {
  let redis: ReturnType<typeof createMockRedis>;
  let book: OrderBook;
  let ammConfig: AmmConfig;
  let matcher: Matcher;

  beforeEach(async () => {
    redis = createMockRedis();
    (redis as unknown as MockRedisClient).clear?.();
    book = new OrderBook(redis);
    ammConfig = makeAmmConfig(redis);
    matcher = new Matcher(book, ammConfig);

    // Initialize an AMM pool for market_1 with b=100, 2 outcomes
    await ammConfig.ammState.initPool("market_1", 100, 2);
  });

  it("fills a market BID via AMM on empty book", async () => {
    // Amount = 5_000_000 = 5 shares (6 decimals)
    const bid = makeOrder({
      side: "BID",
      price: "0",
      amount: "5000000",
      orderType: "MARKET",
      user: "0xAlice",
    });
    const result = await matcher.match(bid);

    expect(result.trades.length).toBe(1);
    expect(result.trades[0].buyer).toBe("0xAlice");
    expect(result.trades[0].seller).toBe("0xAdmin"); // AMM admin
    expect(result.trades[0].fillAmount).toBe("5000000");
    expect(result.trades[0].makerOrder.trader).toBe("0xAdmin");
    expect(result.trades[0].makerOrder.signature).toBe("amm_sig_test");
    expect(result.remainingAmount).toBe(0n);
    expect(result.restingOnBook).toBe(false);
  });

  it("fills AMM BID with needsAutoSplit when admin inventory is low", async () => {
    ammConfig.checkAdminOutcomeBalance = vi.fn().mockResolvedValue(2_000_000n);

    const bid = makeOrder({
      side: "BID",
      price: "0",
      amount: "5000000",
      orderType: "MARKET",
      user: "0xAlice",
    });
    const result = await matcher.match(bid);

    expect(result.trades.length).toBe(1);
    // Full amount fills — auto-split will mint the missing tokens at settlement.
    expect(result.trades[0].fillAmount).toBe("5000000");
    expect(result.trades[0].needsAutoSplit).toBe(true);
    expect(result.remainingAmount).toBe(0n);
  });

  it("fills both CLOB + AMM across admin inventory with auto-split", async () => {
    ammConfig.checkAdminOutcomeBalance = vi.fn().mockResolvedValue(100_000_000n);

    await book.addOrder(
      makeOrder({
        nonce: "admin_ask_100",
        side: "ASK",
        price: "0.50",
        amount: "100000000",
        user: "0xAdmin",
      }),
    );

    const bid = makeOrder({
      side: "BID",
      price: "0",
      amount: "150000000",
      orderType: "MARKET",
      user: "0xAlice",
    });
    const result = await matcher.match(bid);

    // CLOB fills 100M from the resting ASK, AMM fills the remaining 50M.
    expect(result.trades.length).toBe(2);
    expect(result.trades[0].seller).toBe("0xAdmin");
    expect(result.trades[0].fillAmount).toBe("100000000");
    // AMM trade fills the rest with auto-split since inventory was consumed by CLOB.
    expect(result.trades[1].seller).toBe("0xAdmin");
    expect(result.trades[1].fillAmount).toBe("50000000");
    expect(result.trades[1].needsAutoSplit).toBe(true);
    expect(result.remainingAmount).toBe(0n);
  });

  it("fills AMM BID with needsAutoSplit when admin has zero outcome-token inventory", async () => {
    ammConfig.checkAdminOutcomeBalance = vi.fn().mockResolvedValue(0n);

    const bid = makeOrder({
      side: "BID",
      price: "0",
      amount: "1000000",
      orderType: "MARKET",
      user: "0xAlice",
    });
    const result = await matcher.match(bid);

    // Trade proceeds with needsAutoSplit — settlement will auto-split tokens.
    expect(result.trades.length).toBe(1);
    expect(result.trades[0].needsAutoSplit).toBe(true);
    expect(result.remainingAmount).toBe(0n);
  });

  it("fills AMM BID with needsAutoSplit when inventory check fails", async () => {
    ammConfig.checkAdminOutcomeBalance = vi
      .fn()
      .mockRejectedValue(new Error("rpc down"));

    const bid = makeOrder({
      side: "BID",
      price: "0",
      amount: "1000000",
      orderType: "MARKET",
      user: "0xAlice",
    });
    const result = await matcher.match(bid);

    // Trade proceeds with needsAutoSplit — settlement will check and split.
    expect(result.trades.length).toBe(1);
    expect(result.trades[0].needsAutoSplit).toBe(true);
    expect(result.remainingAmount).toBe(0n);
  });

  it("fills a limit BID via AMM when price is acceptable", async () => {
    // AMM starts at 50/50 (price = 0.50). Limit at 0.60 should fill.
    const bid = makeOrder({
      side: "BID",
      price: "0.60",
      amount: "1000000", // 1 share
      orderType: "LIMIT",
      user: "0xAlice",
    });
    const result = await matcher.match(bid);

    expect(result.trades.length).toBe(1);
    const avgPrice = Number(result.trades[0].price);
    expect(avgPrice).toBeGreaterThan(0.49);
    expect(avgPrice).toBeLessThan(0.61); // within limit
    expect(result.restingOnBook).toBe(false);
  });

  it("rests a limit BID on book when AMM price exceeds limit", async () => {
    // AMM at 50%. Limit at 0.40 — AMM won't fill at that price.
    const bid = makeOrder({
      side: "BID",
      price: "0.40",
      amount: "1000000",
      orderType: "LIMIT",
      user: "0xAlice",
    });
    const result = await matcher.match(bid);

    expect(result.trades.length).toBe(0);
    expect(result.restingOnBook).toBe(true); // limit order rests
  });

  it("fills an ASK (sell) via AMM on empty book", async () => {
    // First buy some shares to move the AMM state, then sell
    // But even at initial state, selling is possible (quantities go negative for LMSR)
    const ask = makeOrder({
      side: "ASK",
      price: "0.40",
      amount: "1000000",
      orderType: "LIMIT",
      user: "0xAlice",
    });
    const result = await matcher.match(ask);

    expect(result.trades.length).toBe(1);
    expect(result.trades[0].seller).toBe("0xAlice");
    expect(result.trades[0].buyer).toBe("0xAdmin"); // AMM buys
    expect(result.trades[0].makerOrder.isBuy).toBe(true); // admin buys
  });

  it("skips AMM ASK when admin collateral check fails", async () => {
    ammConfig.checkAdminCollateralBalance = vi
      .fn()
      .mockRejectedValue(new Error("rpc down"));

    const ask = makeOrder({
      side: "ASK",
      price: "0.40",
      amount: "1000000",
      orderType: "LIMIT",
      user: "0xAlice",
    });
    const result = await matcher.match(ask);

    expect(result.trades.length).toBe(0);
    expect(result.restingOnBook).toBe(true);
  });

  it("does not overfill admin collateral across CLOB + AMM in one match", async () => {
    ammConfig.checkAdminCollateralBalance = vi.fn().mockResolvedValue(50_000_000n);

    await book.addOrder(
      makeOrder({
        nonce: "admin_bid_100",
        side: "BID",
        price: "0.50",
        amount: "100000000",
        user: "0xAdmin",
      }),
    );

    const ask = makeOrder({
      side: "ASK",
      price: "0",
      amount: "150000000",
      orderType: "MARKET",
      user: "0xAlice",
    });
    const result = await matcher.match(ask);

    expect(result.trades.length).toBe(1);
    expect(result.trades[0].buyer).toBe("0xAdmin");
    expect(result.trades[0].fillAmount).toBe("100000000");
    expect(result.remainingAmount).toBe(50000000n);
  });

  it("CLOB takes priority over AMM", async () => {
    // Resting ASK at 0.55 (better than AMM's ~0.50)
    await book.addOrder(
      makeOrder({
        nonce: "clob_ask",
        side: "ASK",
        price: "0.55",
        amount: "1000000",
        user: "0xBob",
      }),
    );

    const bid = makeOrder({
      side: "BID",
      price: "0.60",
      amount: "1000000",
      user: "0xAlice",
    });
    const result = await matcher.match(bid);

    expect(result.trades.length).toBe(1);
    // Should match CLOB, not AMM
    expect(result.trades[0].seller).toBe("0xBob"); // CLOB maker, not 0xAdmin
    expect(result.trades[0].price).toBe("0.55"); // CLOB price
  });

  it("does not use AMM when pool is inactive", async () => {
    await ammConfig.ammState.deactivatePool("market_1");

    const bid = makeOrder({
      side: "BID",
      price: "0",
      amount: "1000000",
      orderType: "MARKET",
      user: "0xAlice",
    });
    const result = await matcher.match(bid);

    // No CLOB match, AMM inactive → nothing
    expect(result.trades.length).toBe(0);
    expect(result.restingOnBook).toBe(false);
  });

  it("does not use AMM when pool does not exist for market", async () => {
    const bid = makeOrder({
      side: "BID",
      price: "0",
      amount: "1000000",
      orderType: "MARKET",
      user: "0xAlice",
      marketId: "unknown_market",
    });
    const result = await matcher.match(bid);

    expect(result.trades.length).toBe(0);
  });

  it("updates AMM state after a fill", async () => {
    const bid = makeOrder({
      side: "BID",
      price: "0",
      amount: "5000000",
      orderType: "MARKET",
      user: "0xAlice",
    });
    await matcher.match(bid);

    // Check that quantities were updated
    const state = await ammConfig.ammState.loadState("market_1");
    expect(state).not.toBeNull();
    expect(state!.quantities[0]).toBeGreaterThan(0); // bought outcome 0
    expect(state!.quantities[1]).toBe(0); // outcome 1 unchanged
  });

  it("works without AMM config (backward compatible)", async () => {
    const matcherNoAmm = new Matcher(book); // no ammConfig
    const bid = makeOrder({
      side: "BID",
      price: "0",
      amount: "1000000",
      orderType: "MARKET",
      user: "0xAlice",
    });
    const result = await matcherNoAmm.match(bid);

    // Empty book, no AMM → no trades
    expect(result.trades.length).toBe(0);
    expect(result.restingOnBook).toBe(false);
  });
});
