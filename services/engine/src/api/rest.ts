import { type NextFunction, type Request, type Response, Router } from "express";
import rateLimit from "express-rate-limit";
import { v4 as uuidv4 } from "uuid";
import { constants } from "starknet";
import {
  computeOrderHash,
  computeTokenId,
  getContractAddress,
} from "@market-zap/shared";
import type { OrderHashParams, SupportedNetwork } from "@market-zap/shared";
import type { OrderEntry } from "../orderbook.js";
import {
  httpRequestDuration,
  ordersSubmitted,
} from "../metrics.js";
import { createDarkAuthGuard } from "./rest-dark-auth.js";
import { registerAdminRoutes } from "./rest-admin-routes.js";
import { registerGeneralRoutes } from "./rest-general-routes.js";
import { registerMarketRoutes } from "./rest-market-routes.js";
import { registerMiscRoutes } from "./rest-misc-routes.js";
import { registerOrderRoutes } from "./rest-order-routes.js";
import { scheduleOrderSettlement } from "./rest-order-settlement.js";
import { registerPortfolioRoutes } from "./rest-portfolio-routes.js";
import {
  asyncHandler,
  computeBidReservation,
  errorHandler,
  formatTrade,
  scalePriceStr,
  SubmitOrderSchema,
  verifyOrderSignature,
} from "./rest-shared.js";
import type {
  BroadcastQuoteParams,
  RestDeps,
  RestHealthChecks,
  RestRouteContext,
} from "./rest-types.js";

export type { RestDeps } from "./rest-types.js";
export { errorHandler } from "./rest-shared.js";

export function createRestRouter(
  deps: RestDeps,
  options: { health?: RestHealthChecks } = {},
): Router {
  const router = Router();
  const network = (process.env.STARKNET_NETWORK ?? "sepolia") as SupportedNetwork;
  const conditionalTokensAddress =
    process.env.CONDITIONAL_TOKENS_ADDRESS ??
    getContractAddress("ConditionalTokens", network);
  const factoryAddress =
    process.env.MARKET_FACTORY_ADDRESS ??
    getContractAddress("MarketFactory", network);

  router.use((req: Request, _res: Response, next: NextFunction) => {
    const requestId = (req.headers["x-request-id"] as string) ?? uuidv4();
    req.headers["x-request-id"] = requestId;
    next();
  });

  router.use((req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
      const route = req.route?.path ?? req.path.replace(/\/[0-9a-fx]+/gi, "/:id");
      httpRequestDuration.observe(
        { method: req.method, route, status_code: res.statusCode.toString() },
        durationSec,
      );
    });
    next();
  });

  const safeIpKey = (req: Request): string => {
    try {
      return req.ip ?? "unknown";
    } catch {
      return "unknown";
    }
  };

  const generalLimiter = rateLimit({
    windowMs: 60_000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    message: { error: "Too many requests, please try again later" },
    keyGenerator: safeIpKey,
  });
  const orderLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    message: { error: "Order rate limit exceeded — max 20 orders per minute" },
    keyGenerator: (req) => (req.body?.user as string) ?? safeIpKey(req),
  });
  const createMarketLimiter = rateLimit({
    windowMs: 60_000,
    max: 2,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    message: { error: "Market creation rate limit exceeded — max 2 per minute" },
    keyGenerator: safeIpKey,
  });

  router.use(generalLimiter);

  const requireDarkAuth = createDarkAuthGuard(deps.db);

  async function broadcastQuote(params: BroadcastQuoteParams): Promise<void> {
    if (params.isDark) {
      deps.ws.broadcast(`price:${params.channelMarketId}:${params.outcomeIndex}`, {
        bestBid: null,
        bestAsk: null,
        spread: null,
        lastPrice: params.lastPrice ?? null,
        lastTradeTime: params.lastTradeTime ?? 0,
      });
      return;
    }

    const [bestBid, bestAsk, spread] = await Promise.all([
      deps.orderBook.getBestBid(params.bookMarketId, params.outcomeIndex),
      deps.orderBook.getBestAsk(params.bookMarketId, params.outcomeIndex),
      deps.orderBook.getSpread(params.bookMarketId, params.outcomeIndex),
    ]);

    deps.ws.broadcast(`price:${params.channelMarketId}:${params.outcomeIndex}`, {
      bestBid: bestBid?.price ?? null,
      bestAsk: bestAsk?.price ?? null,
      spread: spread === null ? "0" : spread.toFixed(6),
      lastPrice: params.lastPrice ?? null,
      lastTradeTime: params.lastTradeTime ?? 0,
    });
  }

  const healthChecks: RestHealthChecks = {
    checkDatabase: () => deps.db.healthCheck(),
    checkRedis: deps.redis
      ? async () => (await deps.redis?.ping()) === "PONG"
      : undefined,
    ...options.health,
  };

  router.post(
    "/api/orders",
    orderLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = SubmitOrderSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }

      const data = parsed.data;
      const requestId = req.headers["x-request-id"] as string;
      ordersSubmitted.inc({ side: data.side, orderType: data.orderType });

      const market = await deps.db.getMarketById(data.marketId);
      if (!market) {
        res.status(404).json({ error: "Market not found" });
        return;
      }
      if (market.status !== "ACTIVE") {
        res.status(400).json({ error: `Market is ${market.status}` });
        return;
      }
      if (market.resolution_time && new Date(market.resolution_time).getTime() <= Date.now()) {
        res.status(400).json({ error: "Market has ended and can no longer be traded" });
        return;
      }
      if (data.outcomeIndex >= market.outcome_count) {
        res.status(400).json({ error: "Invalid outcome index" });
        return;
      }
      if (!market.condition_id || !market.on_chain_market_id) {
        res.status(400).json({
          error: "Market is not set up for on-chain trading. Missing condition_id or on_chain_market_id.",
        });
        return;
      }
      if (data.user.toLowerCase() === deps.settler.adminAddr.toLowerCase()) {
        res.status(400).json({
          error: "The operator account cannot place trades. Connect a different wallet.",
        });
        return;
      }
      if (data.expiry > 0 && data.expiry <= Math.floor(Date.now() / 1000)) {
        res.status(400).json({ error: "Order has already expired" });
        return;
      }

      const marketIsDark = market.market_type === "private";

      if (
        data.signature !== "0x0,0x0" &&
        data.user.toLowerCase() !== deps.settler.adminAddr.toLowerCase()
      ) {
        const tokenIdForSig = computeTokenId(market.condition_id, data.outcomeIndex);
        const signedPrice =
          data.orderType === "MARKET"
            ? data.side === "BID"
              ? BigInt("1000000000000000000")
              : 1n
            : scalePriceStr(data.price);
        const signatureParams: OrderHashParams = {
          trader: data.user,
          marketId: BigInt(market.on_chain_market_id),
          tokenId: tokenIdForSig,
          isBuy: data.side === "BID",
          price: signedPrice,
          amount: BigInt(data.amount),
          nonce: BigInt(data.nonce),
          expiry: BigInt(data.expiry > 0 ? data.expiry : 0),
        };
        const orderHash = computeOrderHash(
          signatureParams,
          deps.settler.exchangeAddr,
          constants.StarknetChainId.SN_SEPOLIA,
        );
        const signatureValid = await verifyOrderSignature(
          deps.settler.rpcProvider,
          data.user,
          orderHash,
          data.signature,
        );
        if (!signatureValid) {
          res.status(403).json({
            error: "Invalid order signature",
            details: "The signature does not match the order parameters for your account.",
          });
          return;
        }
      }

      const dbMarketId = market.market_id;
      const conditionId = market.condition_id;
      const tokenIdByOutcome = (outcomeIndex: number): string =>
        computeTokenId(conditionId, outcomeIndex).toString();
      const tokenId = tokenIdByOutcome(data.outcomeIndex);

      if (process.env.SKIP_BALANCE_CHECK !== "true") {
        if (data.side === "BID") {
          const amount = BigInt(data.amount);
          const price =
            data.orderType === "MARKET"
              ? BigInt("1000000000000000000")
              : scalePriceStr(data.price);
          const cost = (amount * price) / BigInt(1e18);
          const takerFee = (cost * 100n) / 10000n;
          const requiredAmount = cost + takerFee;

          try {
            const [rawAvailable, pendingCosts, openOrderReservations] = await Promise.all([
              deps.balanceChecker.checkBalance(data.user, market.collateral_token, {
                allowStaleOnError: false,
              }),
              deps.db.getUnsettledBuyCosts(data.user),
              deps.db.getOpenOrderReservations(data.user),
            ]);
            const totalHeld = pendingCosts + openOrderReservations;
            const available = rawAvailable > totalHeld ? rawAvailable - totalHeld : 0n;
            if (available < requiredAmount) {
              res.status(400).json({
                error: "Insufficient deposited balance",
                details: {
                  required: requiredAmount.toString(),
                  available: available.toString(),
                  hint: "Deposit USDC into the exchange before placing orders.",
                },
              });
              return;
            }
          } catch (error) {
            res.status(503).json({
              error:
                error instanceof Error
                  ? `Balance check unavailable: ${error.message}`
                  : "Balance check unavailable",
            });
            return;
          }
        } else {
          if (!conditionalTokensAddress) {
            res.status(503).json({
              error: "Inventory check unavailable: CONDITIONAL_TOKENS_ADDRESS is not configured",
            });
            return;
          }

          try {
            const [rawOutcomeBalance, pendingSellAmount, openReservations] =
              await Promise.all([
                deps.balanceChecker.checkErc1155Balance(
                  conditionalTokensAddress,
                  data.user,
                  tokenId,
                ),
                deps.db.getUnsettledSellAmount(data.user, dbMarketId, data.outcomeIndex),
                deps.db.getOpenOutcomeOrderReservations(
                  data.user,
                  dbMarketId,
                  data.outcomeIndex,
                ),
              ]);
            const totalHeld = pendingSellAmount + openReservations;
            const available = rawOutcomeBalance > totalHeld ? rawOutcomeBalance - totalHeld : 0n;
            if (available < BigInt(data.amount)) {
              res.status(400).json({
                error: "Insufficient outcome-token balance",
                details: {
                  required: data.amount,
                  available: available.toString(),
                  tokenId,
                  hint: "Acquire more shares before placing sell orders.",
                },
              });
              return;
            }
          } catch (error) {
            res.status(503).json({
              error:
                error instanceof Error
                  ? `Inventory check unavailable: ${error.message}`
                  : "Inventory check unavailable",
            });
            return;
          }
        }
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const expiry =
        data.expiry > 0
          ? data.expiry
          : nowSec + (data.orderType === "MARKET" ? 120 : 3600);
      const orderPrice =
        data.orderType === "MARKET"
          ? data.side === "BID"
            ? "1000000000000000000"
            : "1"
          : data.price;
      const order: OrderEntry = {
        nonce: data.nonce,
        marketId: dbMarketId,
        outcomeIndex: data.outcomeIndex,
        side: data.side,
        price: orderPrice,
        amount: data.amount,
        remainingAmount: data.amount,
        user: data.user,
        createdAt: new Date().toISOString(),
        signature: data.signature,
        orderType: data.orderType,
        expiry,
      };

      const matchResult = await deps.matcher.match(order);
      await broadcastQuote({
        channelMarketId: data.marketId,
        bookMarketId: dbMarketId,
        outcomeIndex: data.outcomeIndex,
        lastPrice: null,
        lastTradeTime: 0,
        isDark: marketIsDark,
      });

      const filledAmount = BigInt(data.amount) - matchResult.remainingAmount;
      let status: "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" = "OPEN";
      if (matchResult.remainingAmount === 0n) {
        status = "FILLED";
      } else if (filledAmount > 0n) {
        status = "PARTIALLY_FILLED";
      }
      if (data.orderType === "MARKET" && matchResult.remainingAmount > 0n) {
        status = filledAmount > 0n ? "PARTIALLY_FILLED" : "CANCELLED";
      }

      await deps.db.upsertOrder({
        marketId: dbMarketId,
        outcomeIndex: data.outcomeIndex,
        userAddress: data.user,
        side: data.side,
        orderType: data.orderType,
        price: data.price,
        amount: data.amount,
        filledAmount: filledAmount.toString(),
        status,
        nonce: data.nonce,
        signature: data.signature,
        expiry,
      });

      if (matchResult.restingOnBook) {
        if (data.side === "BID") {
          await deps.db.insertOrderReservation(
            data.nonce,
            data.user,
            market.collateral_token,
            computeBidReservation(matchResult.remainingAmount, data.price).toString(),
          );
        } else {
          await deps.db.insertOutcomeOrderReservation(
            data.nonce,
            data.user,
            dbMarketId,
            data.outcomeIndex,
            tokenId,
            matchResult.remainingAmount.toString(),
          );
        }
      }

      for (const consumed of matchResult.consumedOrders) {
        const originalRemaining = BigInt(consumed.original.remainingAmount);
        const nextRemaining =
          consumed.newRemaining === null ? 0n : BigInt(consumed.newRemaining);
        const nextFilled = BigInt(consumed.original.amount) - nextRemaining;
        const nextStatus: "OPEN" | "PARTIALLY_FILLED" | "FILLED" =
          nextRemaining === 0n
            ? "FILLED"
            : nextFilled > 0n
              ? "PARTIALLY_FILLED"
              : "OPEN";

        await deps.db.updateOrderStatus(
          consumed.original.nonce,
          nextStatus,
          nextFilled.toString(),
        );

        if (consumed.original.side === "BID") {
          await deps.db.deleteOrderReservation(consumed.original.nonce);
          if (nextRemaining > 0n) {
            await deps.db.insertOrderReservation(
              consumed.original.nonce,
              consumed.original.user,
              market.collateral_token,
              computeBidReservation(nextRemaining, consumed.original.price).toString(),
            );
          }
        } else {
          await deps.db.deleteOutcomeOrderReservation(consumed.original.nonce);
          if (nextRemaining > 0n) {
            await deps.db.insertOutcomeOrderReservation(
              consumed.original.nonce,
              consumed.original.user,
              consumed.original.marketId,
              consumed.original.outcomeIndex,
              tokenIdByOutcome(consumed.original.outcomeIndex),
              nextRemaining.toString(),
            );
          }
        }
      }

      const onChainMarketId = market.on_chain_market_id;
      const reserveExpiry = Math.floor(Date.now() / 1000) + 3600;
      const tradeDbRows: Array<{ dbId: string; trade: typeof matchResult.trades[0] }> = [];

      for (const trade of matchResult.trades) {
        const fillBig = BigInt(trade.fillAmount);
        const priceBig = scalePriceStr(trade.price);
        const cost = (fillBig * priceBig) / BigInt(1e18);
        const tradeFee = ((cost * 100n) / 10000n).toString();

        const dbRow = await deps.db.insertTrade({
          marketId: trade.marketId,
          outcomeIndex: trade.outcomeIndex,
          buyer: trade.buyer,
          seller: trade.seller,
          price: trade.price,
          amount: trade.fillAmount,
          fee: tradeFee,
          side: data.side,
          buyerNonce: trade.buyerNonce,
          sellerNonce: trade.sellerNonce,
          settled: false,
        });
        tradeDbRows.push({ dbId: dbRow.id, trade });

        const volumeDelta = ((fillBig * priceBig) / BigInt(1e18)).toString();
        await deps.db.updateMarketVolume(trade.marketId, volumeDelta);
        await deps.balanceChecker.invalidateCache(trade.buyer, market.collateral_token);
        await deps.balanceChecker.invalidateCache(trade.seller, market.collateral_token);

        const formatted = formatTrade(dbRow);
        deps.ws.broadcast(`trades:${data.marketId}`, {
          type: "trade",
          trade: marketIsDark
            ? {
                id: formatted.id,
                marketId: formatted.marketId,
                outcomeIndex: formatted.outcomeIndex,
                amount: formatted.amount,
                timestamp: formatted.timestamp,
                settled: false,
              }
            : { ...formatted, settled: false },
        });

        await broadcastQuote({
          channelMarketId: data.marketId,
          bookMarketId: dbMarketId,
          outcomeIndex: trade.outcomeIndex,
          lastPrice: trade.price,
          lastTradeTime: Math.floor(Date.now() / 1000),
          isDark: marketIsDark,
        });
      }

      res.status(201).json({
        success: true,
        data: {
          order: {
            nonce: data.nonce,
            status,
            filledAmount: filledAmount.toString(),
            remainingAmount: matchResult.remainingAmount.toString(),
            restingOnBook: matchResult.restingOnBook,
          },
          trades: matchResult.trades.map((trade) => ({
            id: trade.id,
            price: trade.price,
            fillAmount: trade.fillAmount,
            txHash: null,
            settled: false,
            source: (trade.needsAutoSplit !== undefined ? "amm" : "clob") as "amm" | "clob",
          })),
        },
      });
      scheduleOrderSettlement({
        data: { ...data, expiry },
        deps,
        requestId,
        dbMarketId,
        conditionalTokensAddress,
        conditionId,
        tokenId,
        onChainMarketId,
        reserveExpiry,
        market,
        marketIsDark,
        matchResult,
        tradeDbRows,
        broadcastQuote,
      });
    }),
  );

  const context: RestRouteContext = {
    createMarketLimiter,
    conditionalTokensAddress,
    deps,
    factoryAddress,
    health: healthChecks,
    network,
    orderLimiter,
    broadcastQuote,
    requireDarkAuth,
  };

  registerGeneralRoutes(router, context);
  registerOrderRoutes(router, context);
  registerMarketRoutes(router, context);
  registerPortfolioRoutes(router, context);
  registerAdminRoutes(router, context);
  registerMiscRoutes(router, context);

  return router;
}
