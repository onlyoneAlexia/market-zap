import { type Request, type Response, type Router } from "express";
import { z } from "zod";
import { ordersCancelled } from "../metrics.js";
import {
  asyncHandler,
  isDarkMarket,
  ok,
  PaginationSchema,
} from "./rest-shared.js";
import type { RestRouteContext } from "./rest-types.js";

export function registerOrderRoutes(
  router: Router,
  context: RestRouteContext,
): void {
  const CancelOrderSchema = z.object({
    user: z.string().min(1, "user query parameter is required"),
    signature: z.string().min(1, "signature query parameter is required"),
  });

  router.delete(
    "/api/orders/:nonce",
    asyncHandler(async (req: Request, res: Response) => {
      const nonce = req.params.nonce as string;
      const parsed = CancelOrderSchema.safeParse(req.query);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: "Missing required query parameters: user, signature" });
        return;
      }

      const callerAddress = parsed.data.user;
      const callerSignature = parsed.data.signature;
      const orderRow = await context.deps.db.getOrderByNonce(nonce);
      if (!orderRow) {
        res.status(404).json({ error: "Order not found" });
        return;
      }
      if (orderRow.user_address.toLowerCase() !== callerAddress.toLowerCase()) {
        res.status(403).json({ error: "Not your order" });
        return;
      }
      if (orderRow.signature !== callerSignature) {
        res.status(403).json({ error: "Invalid signature" });
        return;
      }

      const marketId = orderRow.market_id;
      const outcomeIndex = orderRow.outcome_index;
      const cancelResult = await context.deps.matcher.withLock(
        marketId,
        outcomeIndex,
        async () => {
          const freshOrder = await context.deps.db.getOrderByNonce(nonce);
          if (freshOrder && ["FILLED", "CANCELLED"].includes(freshOrder.status)) {
            return { kind: "already_terminal" as const, status: freshOrder.status };
          }

          const target = await context.deps.orderBook.findOrderByNonce(
            marketId,
            outcomeIndex,
            nonce,
          );
          if (!target) {
            await context.deps.db.updateOrderStatus(nonce, "CANCELLED");
            await context.deps.db.deleteOrderReservation(nonce);
            await context.deps.db.deleteOutcomeOrderReservation(nonce);
            ordersCancelled.inc();
            return { kind: "ok" as const };
          }

          await context.deps.orderBook.removeOrder(target);
          await context.deps.db.updateOrderStatus(nonce, "CANCELLED");
          await context.deps.db.deleteOrderReservation(nonce);
          await context.deps.db.deleteOutcomeOrderReservation(nonce);
          ordersCancelled.inc();
          return { kind: "ok" as const };
        },
      );

      if (cancelResult.kind === "already_terminal") {
        res
          .status(400)
          .json({ error: `Order already ${cancelResult.status.toLowerCase()}` });
        return;
      }

      const marketIsDark = await isDarkMarket(context.deps.db, marketId);
      await context.broadcastQuote({
        channelMarketId: marketId,
        bookMarketId: marketId,
        outcomeIndex,
        lastPrice: null,
        lastTradeTime: 0,
        isDark: marketIsDark,
      });

      res.json({ cancelled: true, nonce });
    }),
  );

  const OpenOrdersSchema = PaginationSchema.extend({
    user: z.string().min(1),
    marketId: z.string().optional(),
  });

  router.get(
    "/api/orders",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = OpenOrdersSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }

      const { user, limit, offset, marketId } = parsed.data;
      if (!(await context.requireDarkAuth(req, res, user))) return;

      let resolvedMarketId: string | undefined;
      if (marketId) {
        const market = await context.deps.db.getMarketById(marketId);
        resolvedMarketId = market?.market_id ?? marketId;
      }

      const orders = await context.deps.db.getOpenOrders(
        user,
        limit + 1,
        offset,
        resolvedMarketId,
      );
      const hasMore = orders.length > limit;
      const sliced = hasMore ? orders.slice(0, limit) : orders;
      const page = Math.floor(offset / limit);

      ok(res, {
        items: sliced.map((row) => ({
          nonce: row.nonce,
          marketId: row.market_id,
          outcomeIndex: row.outcome_index,
          side: row.side,
          orderType: row.order_type,
          price: row.price,
          amount: row.amount,
          filledAmount: row.filled_amount,
          status: row.status,
          expiry: row.expiry ?? 0,
          createdAt: new Date(row.created_at).toISOString(),
        })),
        total: offset + sliced.length + (hasMore ? 1 : 0),
        page,
        pageSize: limit,
        hasMore,
      });
    }),
  );
}
