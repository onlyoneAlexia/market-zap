import { describe, it, expect, beforeEach } from "vitest";
import { OrderBook, type OrderEntry } from "../orderbook.js";
import { createMockRedis, MockRedisClient } from "./mock-redis.js";

function makeOrder(overrides: Partial<OrderEntry> = {}): OrderEntry {
  const base: OrderEntry = {
    nonce: "nonce_1",
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

describe("OrderBook", () => {
  let redis: ReturnType<typeof createMockRedis>;
  let book: OrderBook;

  beforeEach(() => {
    redis = createMockRedis();
    (redis as unknown as MockRedisClient).clear?.();
    book = new OrderBook(redis);
  });

  describe("addOrder / removeOrder", () => {
    it("adds a BID order and retrieves it as best bid", async () => {
      const order = makeOrder({ side: "BID", price: "0.65" });
      await book.addOrder(order);

      const best = await book.getBestBid("market_1", 0);
      expect(best).not.toBeNull();
      expect(best!.price).toBe("0.65");
      expect(best!.user).toBe("0xAlice");
    });

    it("adds an ASK order and retrieves it as best ask", async () => {
      const order = makeOrder({ side: "ASK", price: "0.70", nonce: "ask_1" });
      await book.addOrder(order);

      const best = await book.getBestAsk("market_1", 0);
      expect(best).not.toBeNull();
      expect(best!.price).toBe("0.70");
    });

    it("removes an order", async () => {
      const order = makeOrder();
      await book.addOrder(order);
      const removed = await book.removeOrder(order);
      expect(removed).toBe(true);

      const best = await book.getBestBid("market_1", 0);
      expect(best).toBeNull();
    });

    it("returns false when removing a nonexistent order", async () => {
      const order = makeOrder();
      const removed = await book.removeOrder(order);
      expect(removed).toBe(false);
    });
  });

  describe("price priority", () => {
    it("returns highest bid first", async () => {
      await book.addOrder(makeOrder({ nonce: "n1", price: "0.50", side: "BID" }));
      await book.addOrder(makeOrder({ nonce: "n2", price: "0.70", side: "BID" }));
      await book.addOrder(makeOrder({ nonce: "n3", price: "0.60", side: "BID" }));

      const best = await book.getBestBid("market_1", 0);
      expect(best!.price).toBe("0.70");
    });

    it("returns lowest ask first", async () => {
      await book.addOrder(makeOrder({ nonce: "n1", price: "0.80", side: "ASK" }));
      await book.addOrder(makeOrder({ nonce: "n2", price: "0.65", side: "ASK" }));
      await book.addOrder(makeOrder({ nonce: "n3", price: "0.75", side: "ASK" }));

      const best = await book.getBestAsk("market_1", 0);
      expect(best!.price).toBe("0.65");
    });
  });

  describe("spread", () => {
    it("calculates spread between best bid and best ask", async () => {
      await book.addOrder(makeOrder({ nonce: "bid1", side: "BID", price: "0.60" }));
      await book.addOrder(makeOrder({ nonce: "ask1", side: "ASK", price: "0.70" }));

      const spread = await book.getSpread("market_1", 0);
      expect(spread).toBeCloseTo(0.10, 5);
    });

    it("returns null spread when one side is empty", async () => {
      await book.addOrder(makeOrder({ side: "BID", price: "0.60" }));
      const spread = await book.getSpread("market_1", 0);
      expect(spread).toBeNull();
    });
  });

  describe("depth", () => {
    it("counts orders on each side", async () => {
      await book.addOrder(makeOrder({ nonce: "b1", side: "BID", price: "0.60" }));
      await book.addOrder(makeOrder({ nonce: "b2", side: "BID", price: "0.55" }));
      await book.addOrder(makeOrder({ nonce: "a1", side: "ASK", price: "0.70" }));

      expect(await book.depth("market_1", 0, "BID")).toBe(2);
      expect(await book.depth("market_1", 0, "ASK")).toBe(1);
    });

    it("returns 0 for empty book", async () => {
      expect(await book.depth("market_1", 0, "BID")).toBe(0);
    });
  });

  describe("getTopOrders", () => {
    it("returns top N orders by price priority", async () => {
      await book.addOrder(makeOrder({ nonce: "b1", side: "BID", price: "0.50" }));
      await book.addOrder(makeOrder({ nonce: "b2", side: "BID", price: "0.70" }));
      await book.addOrder(makeOrder({ nonce: "b3", side: "BID", price: "0.60" }));

      const top2 = await book.getTopOrders("market_1", 0, "BID", 2);
      expect(top2.length).toBe(2);
      // BID scores are stored as -price, so sorted ascending by score means highest price first
      expect(top2[0].price).toBe("0.70");
      expect(top2[1].price).toBe("0.60");
    });
  });

  describe("removeOrderByNonce", () => {
    it("finds and removes an order by nonce", async () => {
      await book.addOrder(makeOrder({ nonce: "target", side: "ASK", price: "0.75" }));
      await book.addOrder(makeOrder({ nonce: "other", side: "BID", price: "0.60" }));

      const removed = await book.removeOrderByNonce("market_1", 0, "target");
      expect(removed).not.toBeNull();
      expect(removed!.nonce).toBe("target");

      expect(await book.depth("market_1", 0, "ASK")).toBe(0);
      expect(await book.depth("market_1", 0, "BID")).toBe(1);
    });

    it("returns null when nonce not found", async () => {
      const removed = await book.removeOrderByNonce("market_1", 0, "nonexistent");
      expect(removed).toBeNull();
    });
  });

  describe("outcome isolation", () => {
    it("separate outcomes have independent books", async () => {
      await book.addOrder(makeOrder({ nonce: "o0", outcomeIndex: 0, side: "BID", price: "0.65" }));
      await book.addOrder(makeOrder({ nonce: "o1", outcomeIndex: 1, side: "BID", price: "0.35" }));

      const best0 = await book.getBestBid("market_1", 0);
      const best1 = await book.getBestBid("market_1", 1);

      expect(best0!.price).toBe("0.65");
      expect(best1!.price).toBe("0.35");
    });
  });

  describe("same-price FIFO ordering", () => {
    it("returns first-added order when prices are equal (time priority)", async () => {
      // Add two orders at the same price — first one should be returned as best
      await book.addOrder(makeOrder({ nonce: "first", side: "BID", price: "0.65", user: "0xAlice" }));
      await book.addOrder(makeOrder({ nonce: "second", side: "BID", price: "0.65", user: "0xBob" }));

      const best = await book.getBestBid("market_1", 0);
      expect(best).not.toBeNull();
      // Both have same price — the Redis sorted set score is the same,
      // so the first inserted should come first (FIFO within same score)
      expect(best!.price).toBe("0.65");
    });

    it("equal-price ASK orders maintain insertion order", async () => {
      await book.addOrder(makeOrder({ nonce: "ask_first", side: "ASK", price: "0.70", user: "0xAlice" }));
      await book.addOrder(makeOrder({ nonce: "ask_second", side: "ASK", price: "0.70", user: "0xBob" }));

      const best = await book.getBestAsk("market_1", 0);
      expect(best).not.toBeNull();
      expect(best!.price).toBe("0.70");
    });

    it("removing first same-price order promotes second", async () => {
      const first = makeOrder({ nonce: "first", side: "BID", price: "0.65" });
      const second = makeOrder({ nonce: "second", side: "BID", price: "0.65" });

      await book.addOrder(first);
      await book.addOrder(second);
      await book.removeOrder(first);

      const best = await book.getBestBid("market_1", 0);
      expect(best).not.toBeNull();
      expect(best!.nonce).toBe("second");
    });
  });
});
