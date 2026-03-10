import { describe, it, expect } from "vitest";
import {
  getBookKey,
  getBalanceCacheKey,
  getReservedCacheKey,
  getSessionKey,
} from "../db/redis.js";

describe("getBookKey", () => {
  it("builds BID book key", () => {
    expect(getBookKey("market-1", 0, "BID")).toBe("book:market-1:0:BID");
  });

  it("builds ASK book key", () => {
    expect(getBookKey("market-1", 1, "ASK")).toBe("book:market-1:1:ASK");
  });

  it("encodes market ID and outcome index", () => {
    const key = getBookKey("0xabc", 3, "BID");
    expect(key).toBe("book:0xabc:3:BID");
  });
});

describe("getBalanceCacheKey", () => {
  it("builds balance cache key", () => {
    expect(getBalanceCacheKey("0xuser", "0xtoken")).toBe("bal:0xuser:0xtoken");
  });
});

describe("getReservedCacheKey", () => {
  it("builds reserved cache key", () => {
    expect(getReservedCacheKey("0xuser", "0xtoken")).toBe("reserved:0xuser:0xtoken");
  });
});

describe("getSessionKey", () => {
  it("builds session key", () => {
    expect(getSessionKey("conn-123")).toBe("ws:session:conn-123");
  });
});
