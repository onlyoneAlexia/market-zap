import { type Request, type Response, type Router } from "express";
import { z } from "zod";
import {
  computeTokenId,
  getTokenByAddress,
  scalePrice as scalePriceShared,
} from "@market-zap/shared";
import { getAllPrices, maxFillableAmount, quoteAmm } from "../amm.js";
import type { OrderEntry } from "../orderbook.js";
import {
  asyncHandler,
  formatMarket,
  formatTrade,
  isDarkMarket,
  MarketListSchema,
  mapPriceHistoryPoint,
  ok,
  paginated,
  PaginationSchema,
  PriceHistorySchema,
} from "./rest-shared.js";
import type { RestRouteContext } from "./rest-types.js";

export function registerMarketRoutes(
  router: Router,
  context: RestRouteContext,
): void {
  router.get(
    "/api/markets",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = MarketListSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }

      const { limit, offset, category, status, marketType, sortBy, sortOrder, search } = parsed.data;
      const rows = await context.deps.db.getMarkets(limit, offset, category, status, {
        marketType,
        sortBy,
        sortOrder,
        search,
      });
      const traderCounts = await context.deps.db.getTraderCountsByMarket(
        rows.map((row) => row.market_id),
        context.deps.settler.adminAddr,
      );
      const ammStates = await context.deps.ammState.mgetStates(
        rows.map((row) => row.market_id),
      );

      const markets = rows.map((row) => {
        const market = formatMarket(row);
        const traders = traderCounts[row.market_id] ?? 0;
        const ammState = ammStates.get(row.market_id);

        if (ammState && ammState.active) {
          const ammPrices = getAllPrices(ammState.quantities, ammState.b);
          for (let index = 0; index < market.outcomes.length; index++) {
            (market.outcomes[index] as Record<string, unknown>).price =
              ammPrices[index]?.toFixed(4) ?? market.outcomes[index].price;
          }
        }

        return { ...market, traders };
      });

      ok(res, paginated(markets, markets.length, Math.floor(offset / limit), limit));
    }),
  );

  router.get(
    "/api/markets/:id",
    asyncHandler(async (req: Request, res: Response) => {
      const row = await context.deps.db.getMarketById(req.params.id as string);
      if (!row) {
        res.status(404).json({ error: "Market not found" });
        return;
      }

      const market = formatMarket(row);
      const ammState = await context.deps.ammState.loadState(row.market_id);
      const ammPrices =
        ammState && ammState.active
          ? getAllPrices(ammState.quantities, ammState.b)
          : null;

      if (row.market_type !== "private") {
        const enrichments = await Promise.all(
          market.outcomes.map((_, index) =>
            Promise.all([
              context.deps.orderBook.getBestBid(row.market_id, index),
              context.deps.orderBook.getBestAsk(row.market_id, index),
              context.deps.orderBook.getSpread(row.market_id, index),
            ]),
          ),
        );

        for (let index = 0; index < market.outcomes.length; index++) {
          const [bestBid, bestAsk, spread] = enrichments[index];
          const outcome = market.outcomes[index] as Record<string, unknown>;
          outcome.bestBid = bestBid?.price ?? null;
          outcome.bestAsk = bestAsk?.price ?? null;
          outcome.spread = spread;
        }
      } else {
        for (const outcome of market.outcomes) {
          const redacted = outcome as Record<string, unknown>;
          redacted.bestBid = null;
          redacted.bestAsk = null;
          redacted.spread = null;
        }
      }

      if (ammPrices) {
        for (let index = 0; index < market.outcomes.length; index++) {
          const outcome = market.outcomes[index] as Record<string, unknown>;
          outcome.ammPrice = ammPrices[index]?.toFixed(4) ?? null;
          outcome.price = ammPrices[index]?.toFixed(4) ?? outcome.price;
        }
      }

      const [traderCount, rawHistory] = await Promise.all([
        context.deps.db.getTraderCount(
          row.market_id,
          context.deps.settler.adminAddr,
        ),
        context.deps.db.getPriceHistory(row.market_id, row.outcome_count, "1h", 168),
      ]);

      ok(res, {
        ...market,
        traders: traderCount,
        volume24h: row.total_volume ?? "0",
        trades24h: 0,
        liquidity: row.liquidity ?? "0",
        priceHistory: rawHistory.map(mapPriceHistoryPoint),
      });
    }),
  );

  router.get(
    "/api/markets/:id/trades",
    asyncHandler(async (req: Request, res: Response) => {
      if (await isDarkMarket(context.deps.db, req.params.id as string)) {
        ok(res, {
          items: [],
          total: 0,
          page: 1,
          pageSize: 50,
          hasMore: false,
          redacted: true,
        });
        return;
      }

      const parsed = PaginationSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }

      const { limit, offset } = parsed.data;
      const market = await context.deps.db.getMarketById(req.params.id as string);
      const resolvedId = market?.market_id ?? (req.params.id as string);
      const trades = (
        await context.deps.db.getTradesByMarket(resolvedId, limit, offset)
      ).map(formatTrade);

      ok(res, paginated(trades, trades.length, Math.floor(offset / limit), limit));
    }),
  );

  router.get(
    "/api/markets/:id/stats",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = PriceHistorySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }

      const market = await context.deps.db.getMarketById(req.params.id as string);
      const marketId = market?.market_id ?? (req.params.id as string);
      const { interval, limit } = parsed.data;
      const isPrivate = market?.market_type === "private";
      const outcomeCount = market?.outcome_count ?? 2;

      const [stats, rawHistory] = await Promise.all([
        context.deps.db.getMarketStats(marketId),
        isPrivate
          ? Promise.resolve([])
          : context.deps.db.getPriceHistory(marketId, outcomeCount, interval, limit),
      ]);

      ok(res, {
        volume24h: stats.volume24h,
        trades24h: isPrivate ? 0 : stats.tradeCount,
        liquidity: stats.liquidity,
        priceHistory: rawHistory.map(mapPriceHistoryPoint),
      });
    }),
  );

  router.get(
    "/api/markets/:id/price",
    asyncHandler(async (req: Request, res: Response) => {
      const market = await context.deps.db.getMarketById(req.params.id as string);
      if (!market) {
        res.status(404).json({ error: "Market not found" });
        return;
      }

      const marketId = market.market_id;
      const ammState = await context.deps.ammState.loadState(marketId);
      const ammPrices =
        ammState && ammState.active
          ? getAllPrices(ammState.quantities, ammState.b)
          : null;

      const prices: string[] = [];
      for (let outcomeIndex = 0; outcomeIndex < market.outcome_count; outcomeIndex++) {
        if (market.market_type === "private") {
          prices.push(
            ammPrices
              ? (ammPrices[outcomeIndex]?.toFixed(4) ?? "0")
              : (1 / market.outcome_count).toFixed(4),
          );
          continue;
        }

        const [bestBid, bestAsk] = await Promise.all([
          context.deps.orderBook.getBestBid(marketId, outcomeIndex),
          context.deps.orderBook.getBestAsk(marketId, outcomeIndex),
        ]);
        const recentTrades = await context.deps.db.getTradesByMarket(marketId, 1, 0);
        const lastTrade = recentTrades.find(
          (trade) => trade.outcome_index === outcomeIndex,
        );

        if (ammPrices) {
          prices.push(ammPrices[outcomeIndex]?.toFixed(4) ?? "0");
        } else if (bestBid && bestAsk) {
          prices.push(((Number(bestBid.price) + Number(bestAsk.price)) / 2).toFixed(4));
        } else if (lastTrade?.price) {
          prices.push(Number(lastTrade.price).toFixed(4));
        } else {
          prices.push((1 / market.outcome_count).toFixed(4));
        }
      }

      ok(res, {
        marketId: req.params.id as string,
        prices,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  const QuoteSchema = z.object({
    outcomeIndex: z.coerce.number().int().min(0).default(0),
    side: z.enum(["BUY", "SELL"]).default("BUY"),
    amount: z.coerce.number().min(0).optional(),
  });

  router.get(
    "/api/markets/:id/quote",
    asyncHandler(async (req: Request, res: Response) => {
      const market = await context.deps.db.getMarketById(req.params.id as string);
      if (!market) {
        res.status(404).json({ error: "Market not found" });
        return;
      }

      const parsed = QuoteSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }

      const { outcomeIndex, side, amount: requestedAmount } = parsed.data;
      if (outcomeIndex >= market.outcome_count) {
        res.status(400).json({ error: "Invalid outcome index" });
        return;
      }

      const marketId = market.market_id;
      const collateralDecimals = 6;
      const divisor = 10 ** collateralDecimals;
      const isPrivate = market.market_type === "private";

      let clobAvailableHuman = 0;
      let restingOrders: OrderEntry[] = [];
      if (!isPrivate) {
        const bookSide = side === "BUY" ? "ASK" : "BID";
        restingOrders = await context.deps.orderBook.getAllOrders(
          marketId,
          outcomeIndex,
          bookSide as "BID" | "ASK",
        );
        let clobAvailableRaw = 0n;
        for (const order of restingOrders) {
          clobAvailableRaw += BigInt(order.remainingAmount);
        }
        clobAvailableHuman = Number(clobAvailableRaw) / divisor;
      }

      const ammState = await context.deps.ammState.loadState(marketId);
      let ammMaxHuman = 0;
      let spotPrice = 1 / market.outcome_count;
      if (ammState && ammState.active) {
        const prices = getAllPrices(ammState.quantities, ammState.b);
        spotPrice = prices[outcomeIndex] ?? spotPrice;
        const ammDirection = side === "BUY" ? 1 : -1;
        const upperBound = ammState.b * 10;
        ammMaxHuman = Math.abs(
          maxFillableAmount(
            ammState,
            outcomeIndex,
            ammDirection * upperBound,
            0.01,
          ),
        );
      }

      let quote: {
        amount: string;
        avgPrice: string;
        totalCost: string;
        slippage: string;
        canFill: boolean;
        clobFill: string;
        ammFill: string;
      } | null = null;

      if (requestedAmount !== undefined && requestedAmount > 0) {
        const priceScale = 1_000_000_000_000_000_000n;
        const adminAddressLower = context.deps.settler.adminAddr.toLowerCase();
        let remaining = requestedAmount;
        let clobFill = 0;
        let clobCost = 0;
        let adminOutcomeConsumedByClob = 0n;
        let adminCollateralConsumedByClob = 0n;

        for (const order of restingOrders) {
          if (remaining <= 0) break;
          const orderRemaining = Number(BigInt(order.remainingAmount)) / divisor;
          const fillAmount = Math.min(remaining, orderRemaining);
          const orderPrice = Number(order.price);
          clobFill += fillAmount;
          clobCost += fillAmount * orderPrice;

          const fillRaw = BigInt(Math.round(fillAmount * divisor));
          const fillCostRaw =
            (fillRaw * scalePriceShared(order.price)) / priceScale;

          if (
            typeof order.user === "string" &&
            order.user.toLowerCase() === adminAddressLower
          ) {
            if (side === "BUY") {
              adminOutcomeConsumedByClob += fillRaw;
            } else {
              adminCollateralConsumedByClob += fillCostRaw;
            }
          }

          remaining -= fillAmount;
        }

        let ammFill = 0;
        let ammCost = 0;
        let canFill = true;

        if (remaining > 0 && ammState && ammState.active) {
          const maxAmmFillByBudget = (
            requestedShares: number,
            direction: 1 | -1,
            maxCost: number,
          ): number => {
            const tolerance = 0.01;
            if (requestedShares <= 0 || maxCost <= 0) return 0;

            const fullQuote = quoteAmm(
              ammState,
              outcomeIndex,
              direction * requestedShares,
            );
            if (fullQuote.canFill && Math.abs(fullQuote.cost) <= maxCost) {
              return requestedShares;
            }

            const tinyQuote = quoteAmm(ammState, outcomeIndex, direction * tolerance);
            if (!tinyQuote.canFill || Math.abs(tinyQuote.cost) > maxCost) {
              return 0;
            }

            let low = tolerance;
            let high = requestedShares;
            while (high - low > tolerance) {
              const mid = (low + high) / 2;
              const candidate = quoteAmm(ammState, outcomeIndex, direction * mid);
              if (candidate.canFill && Math.abs(candidate.cost) <= maxCost) {
                low = mid;
              } else {
                high = mid;
              }
            }

            return low;
          };

          let ammRequest = remaining;
          if (side === "BUY") {
            if (!context.conditionalTokensAddress || !market.condition_id) {
              ammRequest = 0;
            } else {
              try {
                const tokenId = computeTokenId(
                  market.condition_id,
                  outcomeIndex,
                ).toString();
                const [
                  rawAdminOutcomeBalance,
                  pendingSellAmount,
                  openOutcomeReservations,
                ] = await Promise.all([
                  context.deps.balanceChecker.checkErc1155Balance(
                    context.conditionalTokensAddress,
                    context.deps.settler.adminAddr,
                    tokenId,
                  ),
                  context.deps.db.getUnsettledSellAmount(
                    context.deps.settler.adminAddr,
                    marketId,
                    outcomeIndex,
                  ),
                  context.deps.db.getOpenOutcomeOrderReservations(
                    context.deps.settler.adminAddr,
                    marketId,
                    outcomeIndex,
                  ),
                ]);
                const totalHeld =
                  pendingSellAmount +
                  openOutcomeReservations +
                  adminOutcomeConsumedByClob;
                const outcomeAvailable =
                  rawAdminOutcomeBalance > totalHeld
                    ? rawAdminOutcomeBalance - totalHeld
                    : 0n;

                // Account for auto-split: settlement can mint outcome tokens
                // from admin USDC, so the effective AMM capacity is outcome
                // balance + USDC available for splitting.
                let effectiveCapacity = outcomeAvailable;
                if (Number(outcomeAvailable) / divisor < remaining) {
                  try {
                    const [adminWalletBal, adminExchangeBal] =
                      await Promise.all([
                        context.deps.balanceChecker.checkWalletBalance(
                          context.deps.settler.adminAddr,
                          market.collateral_token,
                        ),
                        context.deps.balanceChecker
                          .checkBalance(
                            context.deps.settler.adminAddr,
                            market.collateral_token,
                          )
                          .catch(() => 0n),
                      ]);
                    // Splitting X USDC mints X tokens of each outcome.
                    effectiveCapacity =
                      outcomeAvailable + adminWalletBal + adminExchangeBal;
                  } catch {
                    // Keep effectiveCapacity at outcomeAvailable only.
                  }
                }
                ammRequest = Math.min(
                  ammRequest,
                  Number(effectiveCapacity) / divisor,
                );
              } catch (error) {
                console.warn(
                  "[quote] failed admin outcome-inventory check; capping AMM fill to 0",
                  error instanceof Error ? error.message : error,
                );
                ammRequest = 0;
              }
            }
          } else {
            try {
              const [rawAdminBalance, pendingCosts, openReservations] =
                await Promise.all([
                  context.deps.balanceChecker.checkBalance(
                    context.deps.settler.adminAddr,
                    market.collateral_token,
                    { allowStaleOnError: false },
                  ),
                  context.deps.db.getUnsettledBuyCosts(context.deps.settler.adminAddr),
                  context.deps.db.getOpenOrderReservations(context.deps.settler.adminAddr),
                ]);
              const totalHeld =
                pendingCosts +
                openReservations +
                adminCollateralConsumedByClob;
              const available =
                rawAdminBalance > totalHeld ? rawAdminBalance - totalHeld : 0n;
              ammRequest = Math.min(
                ammRequest,
                maxAmmFillByBudget(ammRequest, -1, Number(available) / divisor),
              );
            } catch (error) {
              console.warn(
                "[quote] failed admin collateral check; capping AMM fill to 0",
                error instanceof Error ? error.message : error,
              );
              ammRequest = 0;
            }
          }

          const ammDirection = side === "BUY" ? 1 : -1;
          if (ammRequest > 0) {
            const fullQuote = quoteAmm(
              ammState,
              outcomeIndex,
              ammDirection * ammRequest,
            );
            if (fullQuote.canFill) {
              ammFill = ammRequest;
              ammCost = Math.abs(fullQuote.cost);
              remaining -= ammFill;
            } else {
              const maxFill = Math.abs(
                maxFillableAmount(
                  ammState,
                  outcomeIndex,
                  ammDirection * ammRequest,
                  0.01,
                ),
              );
              if (maxFill > 0) {
                const partialQuote = quoteAmm(
                  ammState,
                  outcomeIndex,
                  ammDirection * maxFill,
                );
                ammFill = maxFill;
                ammCost = Math.abs(partialQuote.cost);
                remaining -= maxFill;
              }
            }
          }

          canFill = remaining <= 0;
        } else if (remaining > 0) {
          canFill = false;
        }

        const totalFill = clobFill + ammFill;
        const totalCost = clobCost + ammCost;
        const avgPrice = totalFill > 0 ? totalCost / totalFill : 0;
        const slippage =
          spotPrice > 0 ? Math.abs(avgPrice - spotPrice) / spotPrice : 0;

        quote = {
          amount: requestedAmount.toFixed(2),
          avgPrice: avgPrice.toFixed(6),
          totalCost: totalCost.toFixed(2),
          slippage: slippage.toFixed(6),
          canFill,
          clobFill: clobFill.toFixed(2),
          ammFill: ammFill.toFixed(2),
        };
      }

      ok(res, {
        marketId: req.params.id as string,
        outcomeIndex,
        side,
        maxAvailable: (clobAvailableHuman + ammMaxHuman).toFixed(2),
        clobAvailable: clobAvailableHuman.toFixed(2),
        ammAvailable: ammMaxHuman.toFixed(2),
        spotPrice: spotPrice.toFixed(6),
        quote,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  const OrderBookSchema = z.object({
    outcomeIndex: z.coerce.number().int().min(0).default(0),
    depth: z.coerce.number().int().min(1).max(25).default(10),
  });

  router.get(
    "/api/markets/:id/orderbook",
    asyncHandler(async (req: Request, res: Response) => {
      const market = await context.deps.db.getMarketById(req.params.id as string);
      if (!market) {
        res.status(404).json({ error: "Market not found" });
        return;
      }

      if (market.market_type === "private") {
        ok(res, {
          marketId: req.params.id as string,
          outcomeIndex: parseInt(req.query.outcomeIndex as string) || 0,
          depth: 0,
          bids: [],
          asks: [],
          spread: null,
          timestamp: new Date().toISOString(),
          redacted: true,
        });
        return;
      }

      const parsed = OrderBookSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }

      const { outcomeIndex, depth } = parsed.data;
      if (outcomeIndex >= market.outcome_count) {
        res.status(400).json({ error: "Invalid outcome index" });
        return;
      }

      const decimals =
        getTokenByAddress(market.collateral_token, "sepolia")?.decimals ?? 6;
      const divisor = 10 ** decimals;
      const [rawBids, rawAsks] = await Promise.all([
        context.deps.orderBook.getTopOrders(
          market.market_id,
          outcomeIndex,
          "BID",
          depth * 8,
        ),
        context.deps.orderBook.getTopOrders(
          market.market_id,
          outcomeIndex,
          "ASK",
          depth * 8,
        ),
      ]);

      const aggregateByPrice = (
        orders: OrderEntry[],
        side: "BID" | "ASK",
      ) => {
        const levels = new Map<string, { sizeRaw: bigint; orders: number }>();
        for (const order of orders) {
          const key = Number(order.price).toFixed(6);
          const current = levels.get(key) ?? { sizeRaw: 0n, orders: 0 };
          current.sizeRaw += BigInt(order.remainingAmount);
          current.orders += 1;
          levels.set(key, current);
        }

        return Array.from(levels.entries())
          .map(([price, value]) => ({
            price,
            sizeRaw: value.sizeRaw,
            orders: value.orders,
          }))
          .sort((left, right) =>
            side === "BID"
              ? Number(right.price) - Number(left.price)
              : Number(left.price) - Number(right.price),
          )
          .slice(0, depth);
      };

      const bids = aggregateByPrice(rawBids, "BID").map((level) => ({
        price: level.price,
        size: (Number(level.sizeRaw) / divisor).toFixed(2),
        orders: level.orders,
      }));
      const asks = aggregateByPrice(rawAsks, "ASK").map((level) => ({
        price: level.price,
        size: (Number(level.sizeRaw) / divisor).toFixed(2),
        orders: level.orders,
      }));

      ok(res, {
        marketId: req.params.id as string,
        outcomeIndex,
        depth,
        bids,
        asks,
        spread:
          bids.length > 0 && asks.length > 0
            ? (Number(asks[0].price) - Number(bids[0].price)).toFixed(6)
            : null,
        timestamp: new Date().toISOString(),
      });
    }),
  );
}
