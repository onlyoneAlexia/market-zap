import { type Request, type Response, type Router } from "express";
import { z } from "zod";
import { asyncHandler, formatMarket, ok, requireAuth } from "./rest-shared.js";
import type { RestRouteContext } from "./rest-types.js";

const STARKNET_RPC_URLS: string[] = (() => {
  const env = process.env.STARKNET_RPC_URL;
  const defaults = [
    "https://starknet-sepolia.g.alchemy.com/starknet/version/rpc/v0_8/demo",
    "https://starknet-sepolia.drpc.org",
    "https://rpc.starknet-testnet.lava.build",
    "https://api.zan.top/public/starknet-sepolia/rpc/v0_8",
  ];
  return env ? [env, ...defaults.filter((url) => url !== env)] : defaults;
})();

export function registerAdminRoutes(
  router: Router,
  context: RestRouteContext,
): void {
  router.post(
    "/api/admin/resolve-market",
    requireAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const ResolveSchema = z.object({
        marketId: z.string().min(1),
        winningOutcome: z.number().int().min(0),
      });

      const parsed = ResolveSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }

      const { marketId, winningOutcome } = parsed.data;
      const market = await context.deps.db.getMarketById(marketId);
      if (!market) {
        res.status(404).json({ error: "Market not found" });
        return;
      }
      if (market.status === "RESOLVED") {
        res.status(400).json({ error: "Market already resolved" });
        return;
      }
      if (!market.condition_id) {
        res.status(400).json({ error: "Market has no condition_id" });
        return;
      }

      const resolutionMs = market.resolution_time
        ? new Date(market.resolution_time).getTime()
        : Number.NaN;
      if (!Number.isNaN(resolutionMs) && Date.now() < resolutionMs) {
        res.status(400).json({
          error: `Market cannot be resolved yet. Resolution time is ${new Date(resolutionMs).toISOString()}.`,
        });
        return;
      }
      if (!market.on_chain_market_id) {
        res.status(400).json({ error: "Market has no on_chain_market_id" });
        return;
      }

      const result = await context.deps.settler.resolveMarket(
        market.on_chain_market_id,
        market.condition_id,
        winningOutcome,
      );
      if (!result.success) {
        res.status(500).json({ error: result.error });
        return;
      }

      await context.deps.db.updateMarketStatus(
        market.market_id,
        "RESOLVED",
        winningOutcome,
      );
      context.deps.ws.broadcast(`market:${market.id}`, {
        type: "market_resolved",
        marketId: market.id,
        winningOutcome,
        txHash: result.txHash,
      });

      ok(res, {
        market: formatMarket({
          ...market,
          status: "RESOLVED",
          winning_outcome: winningOutcome,
        }),
        txHash: result.txHash,
      });
    }),
  );

  router.post(
    "/api/admin/seed-market",
    context.createMarketLimiter,
    requireAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const SeedMarketSchema = z.object({
        marketId: z.string().min(1),
        onChainMarketId: z.string().optional(),
        conditionId: z.string().optional(),
        title: z.string().min(1),
        description: z.string().default(""),
        category: z.string().default("general"),
        outcomeCount: z.number().int().min(2).max(8),
        outcomeLabels: z.array(z.string()).min(2),
        collateralToken: z.string().min(1),
        resolutionSource: z.string().default(""),
        resolutionTime: z.string().optional(),
        ammB: z.number().min(10).max(10000).optional(),
        marketType: z.enum(["public", "private"]).optional().default("public"),
      });

      const parsed = SeedMarketSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }

      const data = parsed.data;
      const market = await context.deps.db.upsertMarket({
        marketId: data.marketId,
        onChainMarketId: data.onChainMarketId,
        conditionId: data.conditionId,
        title: data.title,
        description: data.description,
        category: data.category,
        outcomeCount: data.outcomeCount,
        outcomeLabels: data.outcomeLabels,
        collateralToken: data.collateralToken,
        resolutionSource: data.resolutionSource,
        resolutionTime: data.resolutionTime ? new Date(data.resolutionTime) : undefined,
        marketType: data.marketType,
      });

      const marketId = market.market_id;
      const seedLockKey = `seed-lock:${marketId}`;
      let seedTxHash: string | null = null;

      let lockToken: string | null = null;
      if (context.deps.redis) {
        lockToken = await context.deps.redis.acquireLockWithRetry(
          seedLockKey,
          300,
          3,
          1000,
        );
        if (!lockToken) {
          res.status(409).json({ error: "Market seeding already in progress" });
          return;
        }
      }

      try {
        const existingState = (await context.deps.ammState.mgetStates([marketId])).get(marketId);
        if (!existingState) {
          const inventory = 500_000_000n;
          let liquidityConfirmed = false;

          if (data.conditionId) {
            const setupResult = await context.deps.settler.setupSeedLiquidity({
              conditionId: data.conditionId,
              collateralToken: data.collateralToken,
              splitAmount: inventory,
              depositAmount: inventory,
            });

            if (setupResult.success) {
              seedTxHash = setupResult.txHash;
              liquidityConfirmed = true;
              console.log(`[seed-market] on-chain liquidity setup confirmed: ${seedTxHash}`);
            } else {
              console.warn(
                `[seed-market] on-chain liquidity setup failed: ${setupResult.error}`,
              );
            }
          }

          if (liquidityConfirmed) {
            await context.deps.ammState.initPool(
              marketId,
              data.ammB ?? 500,
              data.outcomeCount,
            );
          } else {
            console.warn(
              `[seed-market] Skipping AMM pool init — no confirmed on-chain backing`,
            );
          }
        }
      } finally {
        if (context.deps.redis && lockToken) {
          await context.deps.redis.releaseLock(seedLockKey, lockToken);
        }
      }

      if (data.marketType === "private" && market.on_chain_market_id) {
        try {
          const registration = await context.deps.settler.registerDarkMarket(
            market.on_chain_market_id,
          );
          if (!registration.success) {
            console.warn(
              `[seed-market] register_dark_market failed: ${registration.error}`,
            );
          }
        } catch (error) {
          console.warn(
            `[seed-market] register_dark_market error:`,
            error instanceof Error ? error.message : error,
          );
        }
      }

      ok(res, { market, seedTxHash, ammReady: seedTxHash !== null }, 201);
    }),
  );

  router.post(
    "/api/starknet-rpc",
    asyncHandler(async (req: Request, res: Response) => {
      const payload = JSON.stringify(req.body);
      let lastError: string | null = null;

      for (const rpcUrl of STARKNET_RPC_URLS) {
        try {
          const upstream = await fetch(rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
            signal: AbortSignal.timeout(10_000),
          });

          if (upstream.status === 429 || upstream.status >= 500) {
            lastError = `HTTP ${upstream.status} from ${new URL(rpcUrl).hostname}`;
            continue;
          }

          const data = await upstream.json();
          if (data.error) {
            const code = typeof data.error.code === "number" ? data.error.code : null;
            const message: string = data.error.message ?? "";
            const definitiveCodes = new Set([
              20, 24, 25, 27, 28, 29, 31, 40, 41, 51,
              -32600, -32601, -32602, -32700,
            ]);

            if (code !== null && definitiveCodes.has(code)) {
              res.status(upstream.status).json(data);
              return;
            }

            const messageLower = message.toLowerCase();
            const isRateLimited =
              messageLower.includes("rate limit") ||
              messageLower.includes("too many") ||
              messageLower.includes("cu limit") ||
              messageLower.includes("temporarily") ||
              messageLower.includes("please retry");

            if (isRateLimited || code === null || !definitiveCodes.has(code)) {
              lastError = `[${new URL(rpcUrl).hostname}] code=${code}: ${message}`;
              continue;
            }
          }

          res.status(upstream.status).json(data);
          return;
        } catch (error) {
          lastError = `[fetch error] ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      res.status(502).json({ error: `All RPC endpoints failed. Last: ${lastError}` });
    }),
  );
}
