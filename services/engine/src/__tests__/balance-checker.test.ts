import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockRedisClient, createMockRedis } from "./mock-redis.js";

// Mock @market-zap/shared to provide a stub ABI
vi.mock("@market-zap/shared", () => ({
  CLOBRouterABI: [],
}));

// We test the BalanceChecker logic by mocking the RPC contract calls.
// Since BalanceChecker imports starknet's Contract/RpcProvider, we mock them.

vi.mock("starknet", () => ({
  Contract: vi.fn().mockImplementation(() => ({
    call: vi.fn(),
  })),
  RpcProvider: vi.fn().mockImplementation(() => ({})),
}));

import { BalanceChecker } from "../balance-checker.js";

let redis: MockRedisClient;
let checker: BalanceChecker;

beforeEach(() => {
  redis = new MockRedisClient();
  checker = new BalanceChecker(redis as any, {
    exchangeAddress: "0xexchange",
    rpcUrl: "https://rpc.test",
    cacheTtl: 5,
  });
});

describe("checkBalance", () => {
  it("returns cached balance if available", async () => {
    await redis.cacheBalance("0xuser", "0xtoken", "1000000", 60);

    const result = await checker.checkBalance("0xuser", "0xtoken");
    expect(result).toBe(1000000n);
  });

  it("calls on-chain and caches result on cache miss", async () => {
    // Access private exchange contract to mock its call
    const exchange = (checker as any).exchange;
    exchange.call = vi.fn().mockResolvedValue(500000n);

    const result = await checker.checkBalance("0xuser", "0xtoken");
    expect(result).toBe(500000n);

    // Verify it was cached
    const cached = await redis.getCachedBalance("0xuser", "0xtoken");
    expect(cached).toBe("500000");
  });

  it("throws on RPC failure", async () => {
    const exchange = (checker as any).exchange;
    exchange.call = vi.fn().mockRejectedValue(new Error("RPC timeout"));

    await expect(checker.checkBalance("0xuser", "0xtoken")).rejects.toThrow(
      "Failed to fetch on-chain balance",
    );
  });

  it("handles Uint256 {low, high} object shape from RPC", async () => {
    const exchange = (checker as any).exchange;
    exchange.call = vi.fn().mockResolvedValue({ low: "1000000", high: "0" });

    const result = await checker.checkBalance("0xuser2", "0xtoken2");
    expect(result).toBe(1000000n);
  });

  it("handles nested {balance: {low, high}} wrapper from RPC", async () => {
    const exchange = (checker as any).exchange;
    exchange.call = vi.fn().mockResolvedValue({ balance: { low: "500", high: "0" } });

    const result = await checker.checkBalance("0xuser3", "0xtoken3");
    expect(result).toBe(500n);
  });

  it("handles string result from RPC", async () => {
    const exchange = (checker as any).exchange;
    exchange.call = vi.fn().mockResolvedValue("999");

    const result = await checker.checkBalance("0xuser4", "0xtoken4");
    expect(result).toBe(999n);
  });

  it("handles high bits in Uint256", async () => {
    const exchange = (checker as any).exchange;
    // Value = 1 * 2^128 + 0 = 340282366920938463463374607431768211456
    exchange.call = vi.fn().mockResolvedValue({ low: "0", high: "1" });

    const result = await checker.checkBalance("0xuser5", "0xtoken5");
    expect(result).toBe(1n << 128n);
  });
});

describe("checkReserved", () => {
  it("returns cached reserved if available", async () => {
    await redis.cacheReserved("0xuser", "0xtoken", "200000", 60);

    const result = await checker.checkReserved("0xuser", "0xtoken");
    expect(result).toBe(200000n);
  });

  it("calls on-chain for reserved on cache miss", async () => {
    const exchange = (checker as any).exchange;
    exchange.call = vi.fn().mockResolvedValue(300000n);

    const result = await checker.checkReserved("0xuser", "0xtoken");
    expect(result).toBe(300000n);
  });
});

describe("availableBalance", () => {
  it("returns balance directly (get_balance already returns available)", async () => {
    // On-chain get_balance() returns available (non-reserved) amount.
    // So cached balance IS the available balance.
    await redis.cacheBalance("0xuser", "0xtoken", "1000000", 60);
    await redis.cacheReserved("0xuser", "0xtoken", "300000", 60);

    const result = await checker.availableBalance("0xuser", "0xtoken");
    // availableBalance now returns checkBalance directly (1000000)
    expect(result).toBe(1000000n);
  });
});

describe("hasSufficientBalance", () => {
  it("returns true when balance covers required amount", async () => {
    await redis.cacheBalance("0xuser", "0xtoken", "1000000", 60);
    await redis.cacheReserved("0xuser", "0xtoken", "0", 60);

    const result = await checker.hasSufficientBalance("0xuser", "0xtoken", 500000n);
    expect(result).toBe(true);
  });

  it("returns false when balance is insufficient", async () => {
    await redis.cacheBalance("0xuser", "0xtoken", "100000", 60);
    await redis.cacheReserved("0xuser", "0xtoken", "0", 60);

    const result = await checker.hasSufficientBalance("0xuser", "0xtoken", 500000n);
    expect(result).toBe(false);
  });

  it("checks against available balance (get_balance returns available)", async () => {
    // get_balance on-chain already returns available (non-reserved) amount.
    // If cached balance is 200000, that IS the available balance.
    await redis.cacheBalance("0xuser", "0xtoken", "200000", 60);

    const result = await checker.hasSufficientBalance("0xuser", "0xtoken", 500000n);
    expect(result).toBe(false);
  });
});

describe("invalidateCache", () => {
  it("removes both balance and reserved cache entries", async () => {
    await redis.cacheBalance("0xuser", "0xtoken", "1000000", 60);
    await redis.cacheReserved("0xuser", "0xtoken", "200000", 60);

    await checker.invalidateCache("0xuser", "0xtoken");

    const balance = await redis.getCachedBalance("0xuser", "0xtoken");
    const reserved = await redis.getCachedReserved("0xuser", "0xtoken");
    expect(balance).toBeNull();
    expect(reserved).toBeNull();
  });
});

describe("balance snapshot cache", () => {
  it("stores and retrieves a cached balance snapshot", async () => {
    await checker.cacheBalanceSnapshot("0xuser", "0xtoken", {
      balance: "100",
      reserved: "20",
      available: "80",
      walletBalance: "5",
      walletDecimals: 6,
      exchangeDecimals: 6,
    });

    await expect(
      checker.getCachedBalanceSnapshot("0xuser", "0xtoken"),
    ).resolves.toEqual({
      balance: "100",
      reserved: "20",
      available: "80",
      walletBalance: "5",
      walletDecimals: 6,
      exchangeDecimals: 6,
    });
  });

  it("removes the cached balance snapshot during invalidation", async () => {
    await checker.cacheBalanceSnapshot("0xuser", "0xtoken", {
      balance: "100",
      reserved: "20",
      available: "80",
      walletBalance: "5",
      walletDecimals: 6,
      exchangeDecimals: 6,
    });

    await checker.invalidateCache("0xuser", "0xtoken");

    await expect(
      checker.getCachedBalanceSnapshot("0xuser", "0xtoken"),
    ).resolves.toBeNull();
  });
});
