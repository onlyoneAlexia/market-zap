import { type Request, type Response, type Router } from "express";
import { z } from "zod";
import { computeTokenId, getTokenByAddress } from "@market-zap/shared";
import { getAllPrices } from "../amm.js";
import {
  asyncHandler,
  formatMarket,
  formatTrade,
  ok,
  PaginationSchema,
} from "./rest-shared.js";
import type { RestRouteContext } from "./rest-types.js";

export function registerPortfolioRoutes(
  router: Router,
  context: RestRouteContext,
): void {
  router.get(
    "/api/portfolio/:address",
    asyncHandler(async (req: Request, res: Response) => {
      const address = req.params.address as string;
      if (!(await context.requireDarkAuth(req, res, address))) return;

      const rawPositions = await context.deps.db.getPortfolio(address);
      const marketIds = rawPositions.map((row) => row.market_id);
      const [marketsMap, ammStatesMap] = await Promise.all([
        context.deps.db.getMarketsByIds(marketIds),
        context.deps.ammState.mgetStates(marketIds),
      ]);

      const onChainBalances = await Promise.all(
        rawPositions.map(async (row) => {
          const market = marketsMap.get(row.market_id) ?? null;
          if (!context.conditionalTokensAddress || !market?.condition_id) return 0n;
          try {
            const tokenId = computeTokenId(
              market.condition_id,
              row.outcome_index,
            );
            return await context.deps.balanceChecker.checkErc1155Balance(
              context.conditionalTokensAddress,
              address,
              tokenId,
            );
          } catch {
            return BigInt(Math.round(parseFloat(row.net_amount) || 0));
          }
        }),
      );

      const positions = rawPositions
        .map((row, index) => {
          const market = marketsMap.get(row.market_id) ?? null;
          const decimals =
            getTokenByAddress(market?.collateral_token ?? "", "sepolia")?.decimals ?? 6;

          let livePrice = parseFloat(row.avg_price) || 0;
          const ammState = ammStatesMap.get(row.market_id);
          if (ammState?.active) {
            const ammPrices = getAllPrices(ammState.quantities, ammState.b);
            livePrice = ammPrices[row.outcome_index] ?? livePrice;
          }

          const humanQuantity = Number(onChainBalances[index]) / 10 ** decimals;
          return {
            marketId: market?.id ?? row.market_id,
            outcomeIndex: row.outcome_index,
            quantity: humanQuantity.toFixed(2),
            avgPrice: row.avg_price,
            currentPrice: livePrice.toFixed(4),
            unrealizedPnl: "0",
            market: market
              ? formatMarket(market)
              : { id: row.market_id, question: row.title },
          };
        })
        .filter((position) => parseFloat(position.quantity) !== 0);

      const totalValue = positions
        .reduce(
          (sum, position) =>
            sum +
            Math.abs(parseFloat(position.quantity)) *
              parseFloat(position.currentPrice),
          0,
        )
        .toFixed(2);
      const totalPnl = positions
        .reduce((sum, position) => sum + parseFloat(position.unrealizedPnl), 0)
        .toFixed(2);

      ok(res, {
        totalValue,
        totalPnl,
        winRate: 0,
        positionsCount: positions.length,
        positions,
      });
    }),
  );

  router.get(
    "/api/portfolio/:address/trades",
    asyncHandler(async (req: Request, res: Response) => {
      const address = req.params.address as string;
      if (!(await context.requireDarkAuth(req, res, address))) return;

      const parsed = PaginationSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }

      const { limit, offset } = parsed.data;
      const trades = (
        await context.deps.db.getTradesByUser(address, limit, offset)
      ).map(formatTrade);

      ok(res, {
        trades,
        total: trades.length,
        page: Math.floor(offset / limit) + 1,
        pageSize: limit,
        hasMore: trades.length === limit,
      });
    }),
  );

  router.get(
    "/api/portfolio/:address/rewards",
    asyncHandler(async (req: Request, res: Response) => {
      const address = req.params.address as string;
      if (!(await context.requireDarkAuth(req, res, address))) return;

      const rewards = await context.deps.db.getClaimableRewards(address);
      const decimals =
        (rewards.length > 0
          ? getTokenByAddress(rewards[0].market.collateral_token, "sepolia")?.decimals
          : undefined) ?? 6;

      ok(
        res,
        rewards.map((reward) => ({
          marketId: reward.market.id,
          outcomeIndex: reward.outcome_index,
          amount: (parseFloat(reward.amount) / 10 ** decimals).toFixed(2),
          market: formatMarket(reward.market),
        })),
      );
    }),
  );

}
