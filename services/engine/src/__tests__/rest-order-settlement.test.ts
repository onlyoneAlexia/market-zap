import { describe, expect, it, vi } from "vitest";
import { scheduleOrderSettlement } from "../api/rest-order-settlement.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("scheduleOrderSettlement", () => {
  it("cancels MARKET taker order when AMM settlement rolls back the entire fill", async () => {
    const done = deferred<void>();

    const deps: any = {
      ws: { broadcast: vi.fn() },
      redis: undefined,
      matcher: {
        withLock: vi.fn().mockImplementation(async (_m: string, _o: number, fn: () => Promise<void>) => fn()),
      },
      orderBook: {
        findOrderByNonce: vi.fn().mockResolvedValue(null),
        addOrder: vi.fn().mockResolvedValue(undefined),
        removeOrder: vi.fn().mockResolvedValue(true),
      },
      ammState: { saveState: vi.fn().mockResolvedValue(undefined) },
      balanceChecker: {
        checkErc1155Balance: vi.fn().mockResolvedValue(0n),
        checkWalletBalance: vi.fn().mockResolvedValue(0n),
        checkBalance: vi.fn().mockResolvedValue(0n),
        invalidateCache: vi.fn().mockResolvedValue(undefined),
      },
      settler: {
        adminAddr: "0xadmin",
        settleAmmTradeAtomic: vi.fn().mockResolvedValue({
          success: false,
          txHash: "0x0",
          tradeId: "t1",
          error: "TX reverted: insufficient balance",
        }),
      },
      db: {
        markTradeFailed: vi.fn().mockResolvedValue(undefined),
        markTradeSettled: vi.fn().mockResolvedValue(undefined),
        updateMarketVolume: vi.fn().mockResolvedValue(undefined),
        deleteOrderReservation: vi.fn().mockResolvedValue(undefined),
        deleteOutcomeOrderReservation: vi.fn().mockResolvedValue(undefined),
        insertOrderReservation: vi.fn().mockResolvedValue(undefined),
        insertOutcomeOrderReservation: vi.fn().mockResolvedValue(undefined),
        updateOrderStatus: vi
          .fn()
          .mockImplementation(async (nonce: string, status: string, filledAmount?: string) => {
            if (nonce === "n1" && status === "CANCELLED" && filledAmount === "0") {
              done.resolve();
            }
          }),
      },
    };

    scheduleOrderSettlement({
      data: {
        amount: "100",
        marketId: "m1",
        nonce: "n1",
        orderType: "MARKET",
        outcomeIndex: 0,
        price: "0.5",
        side: "BID",
        signature: "0x0,0x0",
        user: "0xuser",
        expiry: Math.floor(Date.now() / 1000) + 3600,
      },
      conditionalTokensAddress: "0xct",
      deps,
      requestId: "req1",
      dbMarketId: "m1",
      conditionId: "0xcond",
      tokenId: "123",
      onChainMarketId: "1",
      reserveExpiry: Math.floor(Date.now() / 1000) + 3600,
      market: { collateral_token: "0xusdc", outcome_count: 2 },
      marketIsDark: false,
      matchResult: {
        trades: [],
        remainingAmount: 0n,
        restingOnBook: false,
        consumedOrders: [],
        preMatchAmmState: null,
        postClobAmmState: null,
        restedOrder: null,
      },
      tradeDbRows: [
        {
          dbId: "t1",
          trade: {
            id: "t1",
            marketId: "m1",
            outcomeIndex: 0,
            buyer: "0xuser",
            seller: "0xadmin",
            price: "0.5",
            fillAmount: "100",
            buyerNonce: "n1",
            sellerNonce: "admin-nonce",
            matchedAt: new Date().toISOString(),
            makerOrder: {
              trader: "0xadmin",
              price: "0.5",
              amount: "100",
              nonce: "admin-nonce",
              expiry: Math.floor(Date.now() / 1000) + 3600,
              signature: "0xadminSig",
              isBuy: false,
            },
            takerOrder: {
              trader: "0xuser",
              price: "1",
              amount: "100",
              nonce: "n1",
              expiry: Math.floor(Date.now() / 1000) + 3600,
              signature: "0x0,0x0",
              isBuy: true,
            },
            needsAutoSplit: false,
          },
        },
      ],
      broadcastQuote: vi.fn().mockResolvedValue(undefined),
    });

    await Promise.race([
      done.promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000)),
    ]);

    expect(deps.db.updateOrderStatus).toHaveBeenCalledWith("n1", "CANCELLED", "0");
    expect(deps.ws.broadcast).toHaveBeenCalledWith(
      "trades:m1",
      expect.objectContaining({ type: "order_cancelled", nonce: "n1" }),
    );
  });

  it("uses atomic dark settlement and rolls back the match on failure", async () => {
    const done = deferred<void>();

    const deps: any = {
      ws: { broadcast: vi.fn() },
      redis: undefined,
      matcher: {
        withLock: vi.fn().mockImplementation(async (_m: string, _o: number, fn: () => Promise<void>) => fn()),
      },
      orderBook: {
        addOrder: vi.fn().mockResolvedValue(undefined),
        removeOrder: vi.fn().mockResolvedValue(true),
        findOrderByNonce: vi.fn().mockResolvedValue(null),
      },
      ammState: { saveState: vi.fn().mockResolvedValue(undefined) },
      balanceChecker: {
        invalidateCache: vi.fn().mockResolvedValue(undefined),
      },
      settler: {
        exchangeAddr: "0x123",
        settleDarkTradesAtomic: vi.fn().mockResolvedValue({
          success: false,
          txHash: "0x0",
          error: "TX reverted: self-trade",
        }),
      },
      db: {
        markTradeFailed: vi.fn().mockResolvedValue(undefined),
        updateMarketVolume: vi.fn().mockResolvedValue(undefined),
        deleteOrderReservation: vi.fn().mockResolvedValue(undefined),
        deleteOutcomeOrderReservation: vi.fn().mockResolvedValue(undefined),
        insertOrderReservation: vi.fn().mockResolvedValue(undefined),
        insertOutcomeOrderReservation: vi.fn().mockResolvedValue(undefined),
        updateOrderStatus: vi
          .fn()
          .mockImplementation(async (nonce: string, status: string, filledAmount?: string) => {
            if (nonce === "444" && status === "CANCELLED" && filledAmount === "0") {
              done.resolve();
            }
          }),
      },
    };

    scheduleOrderSettlement({
      data: {
        amount: "100",
        marketId: "m2",
        nonce: "444",
        orderType: "LIMIT",
        outcomeIndex: 0,
        price: "0.5",
        side: "BID",
        signature: "0x0,0x0",
        user: "0x222",
        expiry: Math.floor(Date.now() / 1000) + 3600,
      },
      conditionalTokensAddress: "0xct",
      deps,
      requestId: "req2",
      dbMarketId: "m2",
      conditionId: "0xabc",
      tokenId: "123",
      onChainMarketId: "2",
      reserveExpiry: Math.floor(Date.now() / 1000) + 3600,
      market: { collateral_token: "0xusdc", outcome_count: 2 },
      marketIsDark: true,
      matchResult: {
        trades: [],
        remainingAmount: 0n,
        restingOnBook: false,
        consumedOrders: [],
        preMatchAmmState: null,
        postClobAmmState: null,
        restedOrder: null,
      },
      tradeDbRows: [
        {
          dbId: "t2",
          trade: {
            id: "t2",
            marketId: "m2",
            outcomeIndex: 0,
            buyer: "0x222",
            seller: "0x111",
            price: "0.5",
            fillAmount: "100",
            buyerNonce: "444",
            sellerNonce: "333",
            matchedAt: new Date().toISOString(),
            makerOrder: {
              trader: "0x111",
              price: "0.5",
              amount: "100",
              nonce: "333",
              expiry: Math.floor(Date.now() / 1000) + 3600,
              signature: "0xmakerSig",
              isBuy: false,
            },
            takerOrder: {
              trader: "0x222",
              price: "1",
              amount: "100",
              nonce: "444",
              expiry: Math.floor(Date.now() / 1000) + 3600,
              signature: "0x0,0x0",
              isBuy: true,
            },
          },
        },
      ],
      broadcastQuote: vi.fn().mockResolvedValue(undefined),
    });

    await Promise.race([
      done.promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000)),
    ]);

    expect(deps.settler.settleDarkTradesAtomic).toHaveBeenCalledTimes(1);
    expect(deps.db.updateOrderStatus).toHaveBeenCalledWith("444", "CANCELLED", "0");
  });
});
