import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";
import type { SupportedNetwork } from "@market-zap/shared";
import type { OrderBook } from "../orderbook.js";
import type { Matcher } from "../matcher.js";
import type { BalanceChecker } from "../balance-checker.js";
import type { Settler } from "../settler.js";
import type { Database } from "../db/postgres.js";
import type { WebSocketManager } from "./websocket.js";
import type { AmmStateManager } from "../amm-state.js";

export interface RestDeps {
  orderBook: OrderBook;
  matcher: Matcher;
  balanceChecker: BalanceChecker;
  settler: Settler;
  db: Database;
  ws: WebSocketManager;
  ammState: AmmStateManager;
  redis?: import("../db/redis.js").RedisClient;
}

export interface BroadcastQuoteParams {
  channelMarketId: string;
  bookMarketId: string;
  outcomeIndex: number;
  lastPrice?: string | null;
  lastTradeTime?: number;
  isDark?: boolean;
}

export interface RestRouteContext {
  createMarketLimiter: ReturnType<typeof rateLimit>;
  conditionalTokensAddress: string;
  deps: RestDeps;
  factoryAddress: string;
  network: SupportedNetwork;
  orderLimiter: ReturnType<typeof rateLimit>;
  broadcastQuote(params: BroadcastQuoteParams): Promise<void>;
  requireDarkAuth(
    req: Request,
    res: Response,
    requestedAddress: string,
  ): Promise<boolean>;
}
