import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @market-zap/shared to provide a stub ABI
vi.mock("@market-zap/shared", () => ({
  CLOBRouterABI: [],
  ConditionalTokensABI: [],
  ERC20ABI: [],
  getContractAddress: () => "0xvault",
}));

// Mock starknet before importing Settler
vi.mock("starknet", () => {
  const mockInvoke = vi.fn();
  const mockWaitForTransaction = vi.fn();
  const mockExecute = vi.fn();
  const mockPopulate = vi.fn().mockImplementation((fn: string, args: unknown[]) => ({
    contractAddress: "0xmock",
    entrypoint: fn,
    calldata: args,
  }));

  return {
    Account: vi.fn().mockImplementation(() => ({ execute: mockExecute })),
    Contract: vi.fn().mockImplementation(() => ({
      invoke: mockInvoke,
      populate: mockPopulate,
    })),
    RpcProvider: vi.fn().mockImplementation(() => ({
      waitForTransaction: mockWaitForTransaction,
    })),
    CallData: { compile: vi.fn() },
    constants: { StarknetChainId: { SN_SEPOLIA: "SN_SEPOLIA" } },
    __mockInvoke: mockInvoke,
    __mockWaitForTransaction: mockWaitForTransaction,
    __mockExecute: mockExecute,
    __mockPopulate: mockPopulate,
  };
});

import { Settler } from "../settler.js";
import type { Trade } from "../matcher.js";

let settler: Settler;
let mockInvoke: ReturnType<typeof vi.fn>;
let mockWaitForTransaction: ReturnType<typeof vi.fn>;
let mockExecute: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const starknetModule = await import("starknet");
  mockInvoke = (starknetModule as any).__mockInvoke;
  mockWaitForTransaction = (starknetModule as any).__mockWaitForTransaction;
  mockExecute = (starknetModule as any).__mockExecute;
  mockInvoke.mockReset();
  mockWaitForTransaction.mockReset();
  mockExecute.mockReset();

  settler = new Settler({
    adminPrivateKey: "0xprivate",
    adminAddress: "0xadmin",
    exchangeAddress: "0xexchange",
    conditionalTokensAddress: "0xconditional",
    rpcUrl: "https://rpc.test",
  });
});

const mockTrade: Trade = {
  id: "trade-1",
  marketId: "1",
  outcomeIndex: 0,
  buyer: "0xbuyer",
  seller: "0xseller",
  price: "500000000000000000",
  fillAmount: "1000000000000000000",
  buyerNonce: "1",
  sellerNonce: "2",
  matchedAt: new Date().toISOString(),
  makerOrder: {
    trader: "0xseller",
    price: "500000000000000000",
    amount: "1000000000000000000",
    nonce: "2",
    expiry: 0,
    signature: "",
    isBuy: false,
  },
  takerOrder: {
    trader: "0xbuyer",
    price: "500000000000000000",
    amount: "1000000000000000000",
    nonce: "1",
    expiry: 0,
    signature: "",
    isBuy: true,
  },
};

describe("settleTrade", () => {
  it("returns success result on successful settlement", async () => {
    mockInvoke.mockResolvedValue({ transaction_hash: "0xtxhash" });
    mockWaitForTransaction.mockResolvedValue({});

    const result = await settler.settleTrade(mockTrade);

    expect(result.success).toBe(true);
    expect(result.txHash).toBe("0xtxhash");
    expect(result.tradeId).toBe("trade-1");

    // Verify invoke was called with named Cairo Order objects + BigInt args
    expect(mockInvoke).toHaveBeenCalledWith("settle_trade", [
      // maker_order as named object
      expect.objectContaining({ trader: mockTrade.makerOrder.trader, is_buy: false }),
      // taker_order as named object
      expect.objectContaining({ trader: mockTrade.takerOrder.trader, is_buy: true }),
      // fill_amount as BigInt (starknet.js 7.x handles u256 encoding)
      BigInt(mockTrade.fillAmount),
      // maker_signature and taker_signature as full arrays
      ["0", "0"], ["0", "0"],
    ]);
  });

  it("passes fill_amount as BigInt directly", async () => {
    mockInvoke.mockResolvedValue({ transaction_hash: "0xtx" });
    mockWaitForTransaction.mockResolvedValue({});

    await settler.settleTrade(mockTrade);

    const args = mockInvoke.mock.calls[0][1];
    // 3rd positional arg (index 2) = fill_amount as BigInt
    expect(args[2]).toBe(BigInt("1000000000000000000"));
  });

  it("returns failure result on invoke error", async () => {
    mockInvoke.mockRejectedValue(new Error("Transaction reverted"));

    const result = await settler.settleTrade(mockTrade);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Transaction reverted");
    expect(result.txHash).toBe("");
  });

  it("returns failure on wait timeout", async () => {
    mockInvoke.mockResolvedValue({ transaction_hash: "0xtx" });
    mockWaitForTransaction.mockRejectedValue(new Error("Timeout waiting for tx"));

    const result = await settler.settleTrade(mockTrade);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Timeout");
  });
});

describe("reserveBalance", () => {
  it("returns success with tx hash", async () => {
    mockInvoke.mockResolvedValue({ transaction_hash: "0xreserve-tx" });
    mockWaitForTransaction.mockResolvedValue({});

    const result = await settler.reserveBalance("0xuser", "0xtoken", "1000", 3600, "1");

    expect(result.success).toBe(true);
    expect(result.txHash).toBe("0xreserve-tx");
  });

  it("returns failure on error", async () => {
    mockInvoke.mockRejectedValue(new Error("Insufficient balance on chain"));

    const result = await settler.reserveBalance("0xuser", "0xtoken", "1000", 3600, "1");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Insufficient balance");
  });
});

describe("releaseBalance", () => {
  it("returns success on release", async () => {
    mockInvoke.mockResolvedValue({ transaction_hash: "0xrelease-tx" });
    mockWaitForTransaction.mockResolvedValue({});

    const result = await settler.releaseBalance("0xuser", "0xtoken", "1000");

    expect(result.success).toBe(true);
    expect(result.txHash).toBe("0xrelease-tx");
  });

  it("returns failure on error", async () => {
    mockInvoke.mockRejectedValue(new Error("Release failed"));

    const result = await settler.releaseBalance("0xuser", "0xtoken", "1000");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Release failed");
  });
});

describe("settleOrRollback", () => {
  it("settles trade without rollback on success", async () => {
    mockInvoke.mockResolvedValue({ transaction_hash: "0xtx" });
    mockWaitForTransaction.mockResolvedValue({});

    const result = await settler.settleOrRollback(
      mockTrade,
      "0xusdc",
      "500000000000000000",  // buyerReservedAmount
      "1000000000000000000", // sellerReservedAmount
    );

    expect(result.success).toBe(true);
    // Only the settle_trade invoke should have been called
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("releases both reservations on settlement failure", async () => {
    // First call (settleTrade) fails, then release calls succeed
    mockInvoke
      .mockRejectedValueOnce(new Error("Settlement failed"))
      .mockResolvedValue({ transaction_hash: "0xrelease" });
    mockWaitForTransaction.mockResolvedValue({});

    const result = await settler.settleOrRollback(
      mockTrade,
      "0xusdc",
      "500000000000000000",  // buyerReservedAmount
      "1000000000000000000", // sellerReservedAmount
    );

    expect(result.success).toBe(false);
    // settle_trade (1) + 2 release_balance calls
    expect(mockInvoke).toHaveBeenCalledTimes(3);
  });
});

describe("settleAmmTradeAtomic", () => {
  const ammTrade: Trade = {
    ...mockTrade,
    id: "amm-trade-1",
    seller: "0xadmin",
    makerOrder: {
      ...mockTrade.makerOrder,
      trader: "0xadmin",
    },
    needsAutoSplit: false,
  };

  it("settles without split when admin has enough tokens", async () => {
    mockExecute.mockResolvedValue({ transaction_hash: "0xamm-tx" });
    mockWaitForTransaction.mockResolvedValue({});

    const result = await settler.settleAmmTradeAtomic({
      trade: ammTrade,
      collateralToken: "0xusdc",
      tokenId: "123",
      onChainMarketId: "1",
      reserveExpiry: 9999999,
      conditionId: "0xcondition",
      adminOutcomeBalance: 2000000000000000000n, // enough
      adminWalletBalance: 1000000n,
      adminExchangeBalance: 1000000n,
    });

    expect(result.success).toBe(true);
    expect(result.txHash).toBe("0xamm-tx");
    // execute called once with multicall (reserve + settle, no split)
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const calls = mockExecute.mock.calls[0][0];
    // Should have 2 calls: reserve_balance + settle_trade (no split)
    expect(calls.length).toBe(2);
  });

  it("includes split calls when admin lacks outcome tokens", async () => {
    mockExecute.mockResolvedValue({ transaction_hash: "0xsplit-tx" });
    mockWaitForTransaction.mockResolvedValue({});

    const result = await settler.settleAmmTradeAtomic({
      trade: { ...ammTrade, needsAutoSplit: true },
      collateralToken: "0xusdc",
      tokenId: "123",
      onChainMarketId: "1",
      reserveExpiry: 9999999,
      conditionId: "0xcondition",
      adminOutcomeBalance: 0n, // no tokens
      adminWalletBalance: 5000000000000000000n, // wallet has USDC
      adminExchangeBalance: 0n,
    });

    expect(result.success).toBe(true);
    expect(result.txHash).toBe("0xsplit-tx");
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const calls = mockExecute.mock.calls[0][0];
    // Should have 5 calls: reserve_balance + approve + split_position + set_approval_for_all + settle_trade
    expect(calls.length).toBe(5);
  });

  it("withdraws from exchange when wallet USDC is insufficient for split", async () => {
    mockExecute.mockResolvedValue({ transaction_hash: "0xwithdraw-tx" });
    mockWaitForTransaction.mockResolvedValue({});

    const result = await settler.settleAmmTradeAtomic({
      trade: { ...ammTrade, needsAutoSplit: true },
      collateralToken: "0xusdc",
      tokenId: "123",
      onChainMarketId: "1",
      reserveExpiry: 9999999,
      conditionId: "0xcondition",
      adminOutcomeBalance: 0n,
      adminWalletBalance: 0n, // no wallet USDC
      adminExchangeBalance: 5000000000000000000n, // exchange has USDC
    });

    expect(result.success).toBe(true);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const calls = mockExecute.mock.calls[0][0];
    // Should have 6 calls: reserve + withdraw + approve + split + set_approval_for_all + settle
    expect(calls.length).toBe(6);
  });

  it("returns solvency error when admin has no USDC anywhere", async () => {
    const result = await settler.settleAmmTradeAtomic({
      trade: { ...ammTrade, needsAutoSplit: true },
      collateralToken: "0xusdc",
      tokenId: "123",
      onChainMarketId: "1",
      reserveExpiry: 9999999,
      conditionId: "0xcondition",
      adminOutcomeBalance: 0n,
      adminWalletBalance: 0n,
      adminExchangeBalance: 0n,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Insufficient admin solvency");
    // No execute called — pre-flight solvency check failed.
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("returns failure on tx revert", async () => {
    mockExecute.mockResolvedValue({ transaction_hash: "0xreverted-tx" });
    mockWaitForTransaction.mockResolvedValue({
      execution_status: "REVERTED",
      revert_reason: "out of gas",
    });

    const result = await settler.settleAmmTradeAtomic({
      trade: ammTrade,
      collateralToken: "0xusdc",
      tokenId: "123",
      onChainMarketId: "1",
      reserveExpiry: 9999999,
      conditionId: "0xcondition",
      adminOutcomeBalance: 2000000000000000000n,
      adminWalletBalance: 1000000n,
      adminExchangeBalance: 1000000n,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("reverted");
    expect(result.txHash).toBe("0xreverted-tx");
  });

  it("does NOT split when admin is the buyer (user sells)", async () => {
    // Admin is buyer, user is seller — no split needed even with 0 outcome tokens.
    const adminBuyTrade: Trade = {
      ...mockTrade,
      id: "amm-buy-1",
      buyer: "0xadmin",
      seller: "0xuser",
      makerOrder: {
        ...mockTrade.makerOrder,
        trader: "0xadmin",
        isBuy: true,
      },
      takerOrder: {
        ...mockTrade.takerOrder,
        trader: "0xuser",
        isBuy: false,
      },
    };

    mockExecute.mockResolvedValue({ transaction_hash: "0xadmin-buy-tx" });
    mockWaitForTransaction.mockResolvedValue({});

    const result = await settler.settleAmmTradeAtomic({
      trade: adminBuyTrade,
      collateralToken: "0xusdc",
      tokenId: "123",
      onChainMarketId: "1",
      reserveExpiry: 9999999,
      conditionId: "0xcondition",
      adminOutcomeBalance: 0n, // 0 tokens — but admin is buyer, not seller
      adminWalletBalance: 0n,
      adminExchangeBalance: 0n,
    });

    expect(result.success).toBe(true);
    expect(result.didSplit).toBeFalsy();
    const calls = mockExecute.mock.calls[0][0];
    // Only 2 calls: reserve_balance + settle_trade (no split)
    expect(calls.length).toBe(2);
  });

  it("returns didSplit=true when auto-split occurs", async () => {
    mockExecute.mockResolvedValue({ transaction_hash: "0xsplit-tx" });
    mockWaitForTransaction.mockResolvedValue({});

    const result = await settler.settleAmmTradeAtomic({
      trade: ammTrade,
      collateralToken: "0xusdc",
      tokenId: "123",
      onChainMarketId: "1",
      reserveExpiry: 9999999,
      conditionId: "0xcondition",
      adminOutcomeBalance: 0n,
      adminWalletBalance: 5000000000000000000n,
      adminExchangeBalance: 0n,
    });

    expect(result.success).toBe(true);
    expect(result.didSplit).toBe(true);
  });

  it("rejects zero fillAmount", async () => {
    const zeroTrade: Trade = {
      ...ammTrade,
      fillAmount: "0",
    };

    const result = await settler.settleAmmTradeAtomic({
      trade: zeroTrade,
      collateralToken: "0xusdc",
      tokenId: "123",
      onChainMarketId: "1",
      reserveExpiry: 9999999,
      conditionId: "0xcondition",
      adminOutcomeBalance: 1000000n,
      adminWalletBalance: 1000000n,
      adminExchangeBalance: 1000000n,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("fillAmount must be > 0");
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
