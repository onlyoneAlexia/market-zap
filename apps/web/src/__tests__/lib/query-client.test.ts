import { describe, it, expect } from "vitest";
import { queryKeys } from "@/lib/query-client";

describe("queryKeys", () => {
  describe("markets", () => {
    it("returns stable all key", () => {
      expect(queryKeys.markets.all).toEqual(["markets"]);
    });

    it("returns list key with filters", () => {
      const filters = { category: "crypto" };
      expect(queryKeys.markets.list(filters)).toEqual(["markets", "list", filters]);
    });

    it("returns list key without filters", () => {
      expect(queryKeys.markets.list()).toEqual(["markets", "list", undefined]);
    });

    it("returns detail key", () => {
      expect(queryKeys.markets.detail("m1")).toEqual(["markets", "detail", "m1"]);
    });

    it("returns trades key", () => {
      expect(queryKeys.markets.trades("m1")).toEqual(["markets", "trades", "m1"]);
    });

    it("returns stats key", () => {
      expect(queryKeys.markets.stats("m1")).toEqual(["markets", "stats", "m1"]);
    });

    it("returns price key with outcome", () => {
      expect(queryKeys.markets.price("m1", 0)).toEqual(["markets", "price", "m1", 0]);
    });
  });

  describe("portfolio", () => {
    it("returns all key with address", () => {
      expect(queryKeys.portfolio.all("0xabc")).toEqual(["portfolio", "0xabc"]);
    });

    it("returns positions key", () => {
      expect(queryKeys.portfolio.positions("0xabc")).toEqual(["portfolio", "positions", "0xabc"]);
    });

    it("returns history key", () => {
      expect(queryKeys.portfolio.history("0xabc")).toEqual(["portfolio", "history", "0xabc"]);
    });

    it("returns claimable key", () => {
      expect(queryKeys.portfolio.claimable("0xabc")).toEqual(["portfolio", "claimable", "0xabc"]);
    });
  });

  describe("leaderboard", () => {
    it("returns all key with period", () => {
      expect(queryKeys.leaderboard.all("7d")).toEqual(["leaderboard", "7d"]);
    });

    it("returns all key without period", () => {
      expect(queryKeys.leaderboard.all()).toEqual(["leaderboard", undefined]);
    });
  });

  describe("quote", () => {
    it("returns quote key with market and outcome", () => {
      expect(queryKeys.quote("m1", 0)).toEqual(["quote", "m1", 0]);
    });
  });

  describe("key uniqueness", () => {
    it("different markets produce different keys", () => {
      const key1 = queryKeys.markets.detail("m1");
      const key2 = queryKeys.markets.detail("m2");
      expect(key1).not.toEqual(key2);
    });

    it("different addresses produce different portfolio keys", () => {
      const key1 = queryKeys.portfolio.all("0x1");
      const key2 = queryKeys.portfolio.all("0x2");
      expect(key1).not.toEqual(key2);
    });
  });
});
