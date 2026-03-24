import { type Request, type Response, type Router } from "express";
import { z } from "zod";
import { asyncHandler, formatMarket, ok, requireAuth } from "./rest-shared.js";
import type { RestRouteContext } from "./rest-types.js";

const STARKNET_RPC_URLS: string[] = (() => {
  const env = process.env.STARKNET_RPC_URL;
  const defaults = [
    "https://rpc.starknet-testnet.lava.build",
    "https://starknet-sepolia.g.alchemy.com/starknet/version/rpc/v0_8/demo",
    "https://starknet-sepolia.drpc.org",
    "https://api.zan.top/public/starknet-sepolia/rpc/v0_8",
  ];
  return env ? [env, ...defaults.filter((url) => url !== env)] : defaults;
})();

function manualMarketSeedingEnabled(): boolean {
  return (
    process.env.ENABLE_MANUAL_MARKET_SEEDING === "true" ||
    process.env.NODE_ENV !== "production"
  );
}

export function registerAdminRoutes(
  router: Router,
  context: RestRouteContext,
): void {
  // Phase 1: Propose outcome — returns immediately after on-chain proposal
  router.post(
    "/api/admin/propose-resolution",
    asyncHandler(async (req: Request, res: Response) => {
      const ProposeSchema = z.object({
        marketId: z.string().min(1),
        winningOutcome: z.number().int().min(0),
      });

      const parsed = ProposeSchema.safeParse(req.body);
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

      const result = await context.deps.settler.proposeResolution(
        market.on_chain_market_id,
        market.condition_id,
        winningOutcome,
      );
      if (!result.success) {
        // Recovery: if on-chain proposal already exists (e.g. previous attempt
        // succeeded on-chain but DB update was missed), sync DB and return success.
        const isAlreadyProposed =
          result.error?.includes("already proposed") ||
          result.error?.includes("ALREADY_PROPOSED");
        if (isAlreadyProposed) {
          const onChain = await context.deps.settler.getOnChainProposal(
            market.condition_id,
          );
          if (onChain && onChain.status >= 1) {
            console.log(
              `[admin] recovering: on-chain proposal exists for ${market.condition_id}, syncing DB`,
            );
            await context.deps.db.updateMarketStatus(
              market.market_id,
              onChain.status === 2 ? "RESOLVED" : "PROPOSED",
              onChain.proposedOutcome,
            );
            const disputePeriod = onChain.disputePeriod || 3600;
            const finalizeAfterMs =
              (onChain.proposedAt + disputePeriod) * 1000;
            ok(res, {
              market: formatMarket({
                ...market,
                status: onChain.status === 2 ? "RESOLVED" : "PROPOSED",
                winning_outcome: onChain.proposedOutcome,
              }),
              proposalTxHash: "(recovered from on-chain state)",
              disputePeriodSeconds: disputePeriod,
              finalizeAfter: new Date(finalizeAfterMs).toISOString(),
            });
            return;
          }
        }
        res.status(500).json({ error: result.error });
        return;
      }

      await context.deps.db.updateMarketStatus(
        market.market_id,
        "PROPOSED",
        winningOutcome,
      );

      ok(res, {
        market: formatMarket({
          ...market,
          status: "PROPOSED",
          winning_outcome: winningOutcome,
        }),
        proposalTxHash: result.txHash,
        disputePeriodSeconds: 3600,
        finalizeAfter: new Date(Date.now() + 3600 * 1000).toISOString(),
      });
    }),
  );

  // Phase 2: Finalize resolution — call after dispute period has elapsed
  router.post(
    "/api/admin/finalize-resolution",
    asyncHandler(async (req: Request, res: Response) => {
      const FinalizeSchema = z.object({
        marketId: z.string().min(1),
      });

      const parsed = FinalizeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }

      const { marketId } = parsed.data;
      const market = await context.deps.db.getMarketById(marketId);
      if (!market) {
        res.status(404).json({ error: "Market not found" });
        return;
      }
      if (market.status === "RESOLVED") {
        res.status(400).json({ error: "Market already resolved" });
        return;
      }
      if (market.status !== "PROPOSED") {
        res.status(400).json({ error: "Market resolution not yet proposed. Call /api/admin/propose-resolution first." });
        return;
      }
      if (!market.condition_id || !market.on_chain_market_id) {
        res.status(400).json({ error: "Market missing condition_id or on_chain_market_id" });
        return;
      }

      const result = await context.deps.settler.finalizeResolution(
        market.on_chain_market_id,
        market.condition_id,
      );
      if (!result.success) {
        // Recovery: if already finalized on-chain, sync DB
        const isAlreadyFinalized =
          result.error?.includes("already finalized") ||
          result.error?.includes("ALREADY_FINALIZED") ||
          result.error?.includes("no active proposal");
        if (isAlreadyFinalized) {
          const onChain = await context.deps.settler.getOnChainProposal(
            market.condition_id,
          );
          if (onChain && onChain.status === 2) {
            console.log(
              `[admin] recovering: on-chain resolution already finalized for ${market.condition_id}, syncing DB`,
            );
            await context.deps.db.updateMarketStatus(
              market.market_id,
              "RESOLVED",
              onChain.proposedOutcome,
            );
            // Continue to the success path below
          } else {
            res.status(500).json({ error: result.error });
            return;
          }
        } else {
          res.status(500).json({ error: result.error });
          return;
        }
      }

      await context.deps.db.updateMarketStatus(
        market.market_id,
        "RESOLVED",
        market.winning_outcome ?? 0,
      );
      context.deps.ws.broadcast(`market:${market.market_id}`, {
        type: "market_resolved",
        marketId: market.market_id,
        winningOutcome: market.winning_outcome ?? 0,
        txHash: result.txHash,
      });

      ok(res, {
        market: formatMarket({
          ...market,
          status: "RESOLVED",
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
      if (!manualMarketSeedingEnabled()) {
        res.status(403).json({ error: "Manual market seeding is disabled" });
        return;
      }

      const SeedMarketSchema = z.object({
        marketId: z.string().min(1),
        onChainMarketId: z.string().optional(),
        conditionId: z.string().optional(),
        title: z.string().min(1).max(500),
        description: z.string().max(5000).default(""),
        category: z.string().max(100).default("general"),
        outcomeCount: z.number().int().min(2).max(8),
        outcomeLabels: z.array(z.string().max(100)).min(2).max(8),
        collateralToken: z.string().min(1),
        resolutionSource: z.string().max(500).default(""),
        resolutionTime: z.string().optional(),
        ammB: z.number().min(10).max(10000).optional(),
        marketType: z.enum(["public", "private"]).optional().default("public"),
        thumbnailUrl: z.string().url().optional(),
        initialStatus: z.enum(["PENDING_APPROVAL", "ACTIVE"]).optional().default("ACTIVE"),
      }).refine(
        (d) => d.outcomeLabels.length === d.outcomeCount,
        { message: "outcomeLabels length must match outcomeCount" },
      );

      const parsed = SeedMarketSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }

      const data = parsed.data;

      // Prevent duplicate markets with the same question
      const existing = await context.deps.db.findMarketByTitle(data.title);
      if (existing && existing.market_id !== data.marketId) {
        res.status(409).json({
          error: "A market with this question already exists",
          existingMarketId: existing.market_id,
        });
        return;
      }

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
        thumbnailUrl: data.thumbnailUrl,
        initialStatus: data.initialStatus,
      });

      const marketId = market.market_id;
      const seedLockKey = `seed-lock:${marketId}`;

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
          // AMM pool is virtual LMSR liquidity — always initialize it so
          // early traders see prices and can place bets immediately.
          // On-chain backing (split + deposit) is only needed at settlement
          // time and is handled lazily by the settler.
          await context.deps.ammState.initPool(
            marketId,
            data.ammB ?? 500,
            data.outcomeCount,
          );
          console.log(`[seed-market] AMM pool initialized for ${marketId} (b=${data.ammB ?? 500}, outcomes=${data.outcomeCount})`);
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

      ok(res, { market, ammReady: true }, 201);
    }),
  );

  // Approve a pending market — transitions PENDING_APPROVAL → ACTIVE
  router.post(
    "/api/admin/approve-market",
    asyncHandler(async (req: Request, res: Response) => {
      const ApproveSchema = z.object({
        marketId: z.string().min(1),
      });

      const parsed = ApproveSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }

      const market = await context.deps.db.getMarketById(parsed.data.marketId);
      if (!market) {
        res.status(404).json({ error: "Market not found" });
        return;
      }
      if (market.status !== "PENDING_APPROVAL") {
        res.status(400).json({ error: `Market is already ${market.status}` });
        return;
      }

      await context.deps.db.updateMarketStatus(market.market_id, "ACTIVE");
      ok(res, { market: formatMarket({ ...market, status: "ACTIVE" }) });
    }),
  );

  // Reject a pending market — transitions PENDING_APPROVAL → VOIDED
  router.post(
    "/api/admin/reject-market",
    asyncHandler(async (req: Request, res: Response) => {
      const RejectSchema = z.object({
        marketId: z.string().min(1),
      });

      const parsed = RejectSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }

      const market = await context.deps.db.getMarketById(parsed.data.marketId);
      if (!market) {
        res.status(404).json({ error: "Market not found" });
        return;
      }
      if (market.status !== "PENDING_APPROVAL") {
        res.status(400).json({ error: `Market is already ${market.status}` });
        return;
      }

      await context.deps.db.updateMarketStatus(market.market_id, "VOIDED");
      ok(res, { market: formatMarket({ ...market, status: "VOIDED" }) });
    }),
  );

  // List pending markets awaiting approval
  router.get(
    "/api/admin/pending-markets",
    asyncHandler(async (_req: Request, res: Response) => {
      const markets = await context.deps.db.getMarkets(100, 0, undefined, "PENDING_APPROVAL");
      ok(res, markets.map(formatMarket));
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
            // Starknet-specific codes that mean the request itself is invalid
            // (not an endpoint issue). Excludes -32601 because many providers
            // return it for valid methods they don't support at a given version.
            const definitiveCodes = new Set([
              20, 24, 25, 27, 28, 29, 31, 40, 41, 51,
              -32600, -32602, -32700,
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
