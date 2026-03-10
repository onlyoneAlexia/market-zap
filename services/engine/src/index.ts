import "dotenv/config";

import { createServer } from "node:http";
import express from "express";
import cors from "cors";
import compression from "compression";

import { RedisClient } from "./db/redis.js";
import { Database } from "./db/postgres.js";
import { OrderBook } from "./orderbook.js";
import type { OrderEntry } from "./orderbook.js";
import { Matcher } from "./matcher.js";
import { AmmStateManager } from "./amm-state.js";
import { BalanceChecker } from "./balance-checker.js";
import { Settler } from "./settler.js";
import { createRestRouter, errorHandler } from "./api/rest.js";
import { WebSocketManager } from "./api/websocket.js";
import { ApibaraIndexer } from "./indexer/apibara.js";
import { computeTokenId, scalePrice, getContractAddress } from "@market-zap/shared";
import type { SupportedNetwork } from "@market-zap/shared";
import { logger } from "./logger.js";
import { loadAdminPrivateKey } from "./keystore.js";

const PORT = Number(process.env.PORT) || 3001;
const NETWORK = (process.env.STARKNET_NETWORK ?? "sepolia") as SupportedNetwork;
const EXCHANGE_ADDRESS = process.env.EXCHANGE_ADDRESS ?? getContractAddress("CLOBRouter", NETWORK);
const ADMIN_PRIVATE_KEY = loadAdminPrivateKey();
const ADMIN_ADDRESS = requireEnv("ADMIN_ADDRESS");
const CONDITIONAL_TOKENS_ADDRESS = process.env.CONDITIONAL_TOKENS_ADDRESS ?? getContractAddress("ConditionalTokens", NETWORK);
const MARKET_FACTORY_ADDRESS = process.env.MARKET_FACTORY_ADDRESS ?? getContractAddress("MarketFactory", NETWORK);
const RESOLVER_ADDRESS =
  process.env.RESOLVER_ADDRESS ?? getContractAddress("Resolver", NETWORK);

async function main(): Promise<void> {
  logger.info("starting Market-Zap CLOB engine...");

  const redis = new RedisClient({
    url: process.env.REDIS_URL,
  });
  await redis.ping();
  logger.info("Redis connected");

  const db = new Database({
    connectionString: process.env.DATABASE_URL,
  });
  await db.createTables();
  logger.info("Postgres tables ready");

  const orderBook = new OrderBook(redis);
  const ammState = new AmmStateManager(redis);

  const balanceChecker = new BalanceChecker(redis, {
    exchangeAddress: EXCHANGE_ADDRESS,
  });

  const settler = new Settler({
    adminPrivateKey: ADMIN_PRIVATE_KEY,
    adminAddress: ADMIN_ADDRESS,
    exchangeAddress: EXCHANGE_ADDRESS,
    conditionalTokensAddress: CONDITIONAL_TOKENS_ADDRESS,
  });

  const matcher = new Matcher(orderBook, {
    ammState,
    adminAddress: ADMIN_ADDRESS,
    signAdminOrder: (params) => settler.signSeedOrder(params),
    getMarketInfo: async (marketId: string) => {
      const market = await db.getMarketById(marketId);
      if (!market?.on_chain_market_id || !market?.condition_id) return null;
      return {
        onChainMarketId: market.on_chain_market_id,
        conditionId: market.condition_id,
        collateralDecimals: 6,
        collateralToken: market.collateral_token,
      };
    },
    computeTokenId: (conditionId: string, outcomeIndex: number) =>
      computeTokenId(conditionId, outcomeIndex),
    scalePrice: (price: string | number) => scalePrice(price),
    checkAdminCollateralBalance: (token: string) =>
      balanceChecker.checkBalance(ADMIN_ADDRESS, token),
    checkAdminOutcomeBalance: (tokenId: string) =>
      balanceChecker.checkErc1155Balance(
        CONDITIONAL_TOKENS_ADDRESS,
        ADMIN_ADDRESS,
        tokenId,
      ),
  });

  await rebuildOrderbook(db, orderBook);

  const app = express();
  app.use(cors());
  app.use(compression());
  app.use(express.json());

  const wsManager = new WebSocketManager();

  const router = createRestRouter({
    orderBook,
    matcher,
    balanceChecker,
    settler,
    db,
    ws: wsManager,
    ammState,
    redis,
  });
  app.use(router);
  app.use(errorHandler);

  const httpServer = createServer(app);
  wsManager.attach(httpServer);

  const indexer = new ApibaraIndexer(db, {
    exchangeAddress: EXCHANGE_ADDRESS,
    conditionalTokensAddress: CONDITIONAL_TOKENS_ADDRESS,
    marketFactoryAddress: MARKET_FACTORY_ADDRESS,
    resolverAddress: RESOLVER_ADDRESS,
    startBlock: 0,
  });
  await indexer.start();

  httpServer.listen(PORT, () => {
    logger.info({ port: PORT }, `HTTP server listening on port ${PORT}`);
    logger.info(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
  });

  retryPendingSettlements(db, settler, wsManager).catch((err) => {
    logger.error({ err }, "settlement retry failed");
  });

  const SWEEP_INTERVAL_MS = 60_000;
  const sweepTimer = setInterval(async () => {
    try {
      await sweepExpiredOrders(db, orderBook);
    } catch (err) {
      logger.warn({ err }, "expired order sweep failed");
    }
  }, SWEEP_INTERVAL_MS);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, `received ${signal}, shutting down...`);

    httpServer.close();
    clearInterval(sweepTimer);
    try {
      await indexer.stop();
    } catch (err) {
      logger.warn({ err }, "indexer stop error");
    }
    try {
      await wsManager.shutdown();
    } catch (err) {
      logger.warn({ err }, "ws shutdown error");
    }
    try {
      await redis.disconnect();
    } catch (err) {
      logger.warn({ err }, "redis disconnect error");
    }
    try {
      await db.disconnect();
    } catch (err) {
      logger.warn({ err }, "db disconnect error");
    }

    logger.info("shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "unhandled rejection");
  });
}

/**
 * On engine startup, rebuild the Redis orderbook from Postgres.
 * Redis sorted sets are ephemeral — if Redis was flushed or the engine
 * restarted, open LIMIT orders from DB need to be restored to the book.
 */
async function rebuildOrderbook(
  db: Database,
  orderBook: OrderBook,
): Promise<void> {
  const openOrders = await db.getOpenOrdersForRebuild();
  if (openOrders.length === 0) {
    logger.info("orderbook rebuild: no open orders to restore");
    return;
  }

  let restored = 0;
  const nowSec = Math.floor(Date.now() / 1000);
  for (const row of openOrders) {
    const remaining = BigInt(row.amount) - BigInt(row.filled_amount);
    if (remaining <= 0n) continue;

    if (row.expiry > 0 && row.expiry <= nowSec) {
      await db.updateOrderStatus(row.nonce, "CANCELLED");
      await db.deleteOrderReservation(row.nonce);
      await db.deleteOutcomeOrderReservation(row.nonce);
      continue;
    }

    const entry: OrderEntry = {
      nonce: row.nonce,
      marketId: row.market_id,
      outcomeIndex: row.outcome_index,
      side: row.side as "BID" | "ASK",
      price: row.price,
      amount: row.amount,
      remainingAmount: remaining.toString(),
      user: row.user_address,
      createdAt: new Date(row.created_at).toISOString(),
      signature: row.signature,
      orderType: row.order_type as "LIMIT" | "MARKET",
      expiry: row.expiry,
    };

    await orderBook.addOrder(entry);
    restored++;
  }

  logger.info({ restored, total: openOrders.length }, `orderbook rebuilt: ${restored} orders restored`);
}

/**
 * Scan the Redis orderbook for expired orders and remove them.
 * Also marks them CANCELLED in Postgres and cleans up reservations.
 */
async function sweepExpiredOrders(
  db: Database,
  orderBook: OrderBook,
): Promise<void> {
  // Use DB expiry directly — no need for O(N) Redis book scan
  const openOrders = await db.getOpenOrdersForRebuild();
  const now = Math.floor(Date.now() / 1000);
  let swept = 0;

  for (const row of openOrders) {
    if (row.expiry <= 0 || row.expiry > now) continue;

    try {
      const bookOrder = await orderBook.findOrderByNonce(
        row.market_id,
        row.outcome_index,
        row.nonce,
      );
      if (bookOrder) {
        await orderBook.removeOrder(bookOrder);
      }
    } catch {}
    await db.updateOrderStatus(row.nonce, "CANCELLED");
    await db.deleteOrderReservation(row.nonce);
    await db.deleteOutcomeOrderReservation(row.nonce);
    swept++;
  }

  if (swept > 0) {
    logger.info({ swept }, `expired order sweep: removed ${swept} orders`);
  }
}

/**
 * Cancel an order if it's still in a non-terminal state.
 */
async function cancelOrderIfUnsettled(db: Database, nonce: string): Promise<void> {
  try {
    await db.updateOrderStatus(nonce, "CANCELLED", "0");
  } catch {}
}

async function retryPendingSettlements(
  db: Database,
  settler: Settler,
  ws: WebSocketManager,
): Promise<void> {
  const pendingTrades = await db.getPendingTrades();
  if (pendingTrades.length === 0) return;

  logger.info(
    { count: pendingTrades.length },
    `found ${pendingTrades.length} pending trade(s) — retrying settlement...`,
  );

  for (const row of pendingTrades) {
    const market = await db.getMarketById(row.market_id);
    if (!market?.condition_id || !market?.on_chain_market_id) {
      const err = "Market missing on-chain IDs — cannot settle";
      logger.warn({ tradeId: row.id }, err);
      await db.markTradeFailed(row.id, err);
      await cancelOrderIfUnsettled(db, row.buyer_nonce);
      await cancelOrderIfUnsettled(db, row.seller_nonce);
      ws.broadcast(`trades:${row.market_id}`, {
        type: "trade_failed",
        tradeId: row.id,
        error: err,
        buyer: row.buyer,
        seller: row.seller,
      });
      continue;
    }

    const tokenId = computeTokenId(
      market.condition_id,
      row.outcome_index,
    ).toString();

    try {
      const result = await settler.settleTradeAtomic(
        {
          id: row.id,
          marketId: row.market_id,
          outcomeIndex: row.outcome_index,
          buyer: row.buyer,
          seller: row.seller,
          price: row.price.toString(),
          fillAmount: row.amount.toString(),
          buyerNonce: row.buyer_nonce,
          sellerNonce: row.seller_nonce,
          matchedAt: row.created_at.toString(),
          makerOrder: {
            trader: row.seller,
            price: row.price.toString(),
            amount: row.amount.toString(),
            nonce: row.seller_nonce,
            expiry: Math.floor(Date.now() / 1000) + 3600,
            signature: "",
            isBuy: false,
          },
          takerOrder: {
            trader: row.buyer,
            price: row.price.toString(),
            amount: row.amount.toString(),
            nonce: row.buyer_nonce,
            expiry: Math.floor(Date.now() / 1000) + 3600,
            signature: "",
            isBuy: true,
          },
        },
        market.collateral_token,
        tokenId,
        market.on_chain_market_id,
        Math.floor(Date.now() / 1000) + 3600,
      );

      if (result.success) {
        await db.markTradeSettled(row.id, result.txHash);
        ws.broadcast(`trades:${row.market_id}`, {
          type: "trade_settled",
          tradeId: row.id,
          txHash: result.txHash,
          buyer: row.buyer,
          seller: row.seller,
        });
        logger.info({ tradeId: row.id, txHash: result.txHash }, "retry settled trade");
      } else {
        await db.markTradeFailed(row.id, result.error ?? "Settlement failed on retry");
        await cancelOrderIfUnsettled(db, row.buyer_nonce);
        await cancelOrderIfUnsettled(db, row.seller_nonce);
        ws.broadcast(`trades:${row.market_id}`, {
          type: "trade_failed",
          tradeId: row.id,
          error: result.error ?? "Settlement failed on retry",
          buyer: row.buyer,
          seller: row.seller,
        });
        logger.warn({ tradeId: row.id, error: result.error }, "retry failed for trade");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db.markTradeFailed(row.id, msg);
      await cancelOrderIfUnsettled(db, row.buyer_nonce);
      await cancelOrderIfUnsettled(db, row.seller_nonce);
      ws.broadcast(`trades:${row.market_id}`, {
        type: "trade_failed",
        tradeId: row.id,
        error: msg,
        buyer: row.buyer,
        seller: row.seller,
      });
      logger.error({ tradeId: row.id, err }, "retry error for trade");
    }
  }

  logger.info("pending settlement retry complete");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    logger.fatal({ name }, `missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

main().catch((err) => {
  logger.fatal({ err }, "fatal error during startup");
  process.exit(1);
});
