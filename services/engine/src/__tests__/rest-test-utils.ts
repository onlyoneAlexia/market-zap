import express, { type Express } from "express";
import { EventEmitter } from "node:events";
import { vi } from "vitest";
import { createRestRouter, errorHandler, type RestDeps } from "../api/rest.js";

export function createMockDeps(): RestDeps {
  return {
    orderBook: {
      addOrder: vi.fn(),
      removeOrder: vi.fn(),
      removeOrderByNonce: vi.fn().mockResolvedValue(true),
      findOrderByNonce: vi.fn().mockResolvedValue(null),
      getBestBid: vi.fn().mockResolvedValue(null),
      getBestAsk: vi.fn().mockResolvedValue(null),
      getSpread: vi.fn().mockResolvedValue(null),
      getOrdersByNonce: vi.fn().mockResolvedValue([]),
      getAllOrders: vi.fn().mockResolvedValue([]),
      getTopOrders: vi.fn().mockResolvedValue([]),
      depth: vi.fn().mockResolvedValue(0),
    } as any,
    matcher: {
      match: vi.fn().mockResolvedValue({
        trades: [],
        remainingAmount: 0n,
        restingOnBook: false,
        consumedOrders: [],
        preMatchAmmState: null,
        postClobAmmState: null,
        restedOrder: null,
      }),
      withLock: vi.fn().mockImplementation(async (_marketId, _outcomeIndex, fn) => fn()),
    } as any,
    balanceChecker: {
      hasSufficientBalance: vi.fn().mockResolvedValue(true),
      checkBalance: vi.fn().mockResolvedValue(0n),
      checkReserved: vi.fn().mockResolvedValue(0n),
      checkWalletBalance: vi.fn().mockResolvedValue(0n),
      checkDecimals: vi.fn().mockResolvedValue(6),
      getCachedBalanceSnapshot: vi.fn().mockResolvedValue(null),
      cacheBalanceSnapshot: vi.fn().mockResolvedValue(undefined),
      checkErc1155Balance: vi.fn().mockResolvedValue(0n),
      invalidateCache: vi.fn().mockResolvedValue(undefined),
    } as any,
    settler: {
      settleTrade: vi.fn().mockResolvedValue({ success: true, txHash: "0x123", tradeId: "t1" }),
      settleTradesAtomic: vi.fn().mockResolvedValue({ success: true, txHash: "0x123" }),
      settleAmmTradeAtomic: vi.fn().mockResolvedValue({ success: true, txHash: "0xamm", tradeId: "t1" }),
      settleDarkTrade: vi.fn().mockResolvedValue({ success: true, txHash: "0xdark", tradeId: "t1" }),
      settleDarkTradesAtomic: vi.fn().mockResolvedValue({ success: true, txHash: "0xdark" }),
      proposeResolution: vi.fn().mockResolvedValue({ success: true, txHash: "0xpropose" }),
      finalizeResolution: vi.fn().mockResolvedValue({ success: true, txHash: "0xfinalize" }),
      registerDarkMarket: vi.fn().mockResolvedValue({ success: true, txHash: "0xregister" }),
      setupSeedLiquidity: vi.fn().mockResolvedValue({ success: true, txHash: "0xseed" }),
      adminAddr: "0xAdmin",
      exchangeAddr: "0xExchange",
      rpcProvider: {
        getTransactionByHash: vi.fn().mockResolvedValue({ sender_address: "0xuser1" }),
      } as any,
    } as any,
    db: {
      getMarkets: vi.fn().mockResolvedValue([]),
      getMarketById: vi.fn().mockResolvedValue(null),
      getTradesByMarket: vi.fn().mockResolvedValue([]),
      getTradesByUser: vi.fn().mockResolvedValue([]),
      getMarketStats: vi.fn().mockResolvedValue({}),
      getPriceHistory: vi.fn().mockResolvedValue([]),
      getPortfolio: vi.fn().mockResolvedValue([]),
      getLeaderboard: vi.fn().mockResolvedValue([]),
      refreshLeaderboard: vi.fn().mockResolvedValue(undefined),
      upsertOrder: vi.fn(),
      insertTrade: vi.fn().mockResolvedValue({ id: "t1" }),
      markTradeSettled: vi.fn(),
      markTradeFailed: vi.fn(),
      updateMarketVolume: vi.fn(),
      updateOrderStatus: vi.fn(),
      findMarketByTitle: vi.fn().mockResolvedValue(null),
      upsertMarket: vi.fn().mockResolvedValue({ id: "m1", market_id: "m1" }),
      getTraderCount: vi.fn().mockResolvedValue(0),
      getTraderCountsByMarket: vi.fn().mockResolvedValue({}),
      getUnsettledBuyCosts: vi.fn().mockResolvedValue(0n),
      insertOrderReservation: vi.fn(),
      deleteOrderReservation: vi.fn(),
      getOpenOrderReservations: vi.fn().mockResolvedValue(0n),
      insertOutcomeOrderReservation: vi.fn(),
      deleteOutcomeOrderReservation: vi.fn(),
      getOpenOutcomeOrderReservations: vi.fn().mockResolvedValue(0n),
      getUnsettledSellAmount: vi.fn().mockResolvedValue(0n),
      getMarketsByIds: vi.fn().mockResolvedValue(new Map()),
      updateMarketStatus: vi.fn().mockResolvedValue(undefined),
      getClaimableRewards: vi.fn().mockResolvedValue([]),
      insertRedemption: vi.fn().mockResolvedValue(undefined),
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getOrderByNonce: vi.fn().mockResolvedValue(null),
      healthCheck: vi.fn().mockResolvedValue(true),
    } as any,
    ws: { broadcast: vi.fn() } as any,
    ammState: {
      loadState: vi.fn().mockResolvedValue(null),
      mgetStates: vi.fn().mockResolvedValue(new Map()),
      saveState: vi.fn(),
      initPool: vi.fn().mockResolvedValue({ marketId: "m1", b: 100, quantities: [0, 0], active: true }),
      deactivatePool: vi.fn(),
      hasActivePool: vi.fn().mockResolvedValue(false),
      deletePool: vi.fn(),
      updateState: vi.fn().mockResolvedValue(null),
    } as any,
  };
}

function createApp(deps: RestDeps): Express {
  const app = express();
  app.use(createRestRouter(deps));
  app.use(errorHandler as any);
  return app;
}

export async function request(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const reqEm = new EventEmitter() as any;
  reqEm.method = method.toUpperCase();
  reqEm.url = path;
  reqEm.headers = {
    "content-type": "application/json",
    accept: "application/json",
    ...(headers ?? {}),
  };
  if (body !== undefined) reqEm.body = body;

  const chunks: Buffer[] = [];
  const resEm = new EventEmitter() as any;
  resEm.statusCode = 200;
  resEm.headers = {} as Record<string, string>;
  resEm.setHeader = (name: string, value: string) => {
    resEm.headers[name.toLowerCase()] = value;
  };
  resEm.getHeader = (name: string) => resEm.headers[name.toLowerCase()];
  resEm.removeHeader = (name: string) => { delete resEm.headers[name.toLowerCase()]; };
  resEm.writeHead = (status: number, headers?: Record<string, string>) => {
    resEm.statusCode = status;
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        resEm.setHeader(key, value);
      }
    }
    return resEm;
  };
  resEm.write = (chunk: unknown) => {
    const buffer =
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(String(chunk));
    chunks.push(buffer);
    return true;
  };
  resEm.end = (chunk?: unknown) => {
    if (chunk !== undefined) resEm.write(chunk);
    resEm.body = Buffer.concat(chunks).toString("utf8");
    resEm.emit("finish");
    return resEm;
  };

  await new Promise<void>((resolve) => {
    resEm.once("finish", () => resolve());
    (app as unknown as (req: unknown, res: unknown, next: () => void) => void)(
      reqEm,
      resEm,
      () => {},
    );
  });

  let parsedBody: any = null;
  if (typeof resEm.body === "string" && resEm.body.length > 0) {
    try {
      parsedBody = JSON.parse(resEm.body);
    } catch {
      parsedBody = resEm.body;
    }
  }

  return { status: resEm.statusCode, body: parsedBody };
}

export function resetMockDeps(deps: RestDeps): void {
  vi.clearAllMocks();
  (deps.db.getMarkets as any).mockResolvedValue([]);
  (deps.db.getMarketById as any).mockResolvedValue(null);
  (deps.db.getMarketsByIds as any).mockResolvedValue(new Map());
  (deps.db.getTradesByMarket as any).mockResolvedValue([]);
  (deps.db.getTradesByUser as any).mockResolvedValue([]);
  (deps.db.getLeaderboard as any).mockResolvedValue([]);
  (deps.db.getPortfolio as any).mockResolvedValue([]);
  (deps.db.getClaimableRewards as any).mockResolvedValue([]);
  (deps.ammState.mgetStates as any).mockResolvedValue(new Map());
  (deps.matcher.match as any).mockResolvedValue({
    trades: [],
    remainingAmount: 0n,
    restingOnBook: false,
    consumedOrders: [],
    preMatchAmmState: null,
    postClobAmmState: null,
    restedOrder: null,
  });
  (deps.orderBook.findOrderByNonce as any).mockResolvedValue(null);
  (deps.orderBook.removeOrderByNonce as any).mockResolvedValue(true);
  (deps.settler.rpcProvider.getTransactionByHash as any).mockResolvedValue({
    sender_address: "0xuser1",
  });
}

export function createRestTestHarness() {
  const deps = createMockDeps();
  const app = createApp(deps);
  return {
    app,
    deps,
    req(
      method: string,
      path: string,
      body?: unknown,
      headers?: Record<string, string>,
    ) {
      return request(app, method, path, body, headers);
    },
    reset() {
      resetMockDeps(deps);
    },
  };
}
