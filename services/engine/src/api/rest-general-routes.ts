import { type Request, type Response, type Router } from "express";
import { logger } from "../logger.js";
import {
  registry,
  walletTelemetryDuration,
  walletTelemetryEvents,
} from "../metrics.js";
import {
  asyncHandler,
  authorizeAdminRequest,
  ok,
  WalletTelemetrySchema,
} from "./rest-shared.js";
import type { RestRouteContext } from "./rest-types.js";

export function registerGeneralRoutes(
  router: Router,
  context: RestRouteContext,
): void {
  router.get("/metrics", async (req: Request, res: Response) => {
    const authResult = authorizeAdminRequest(req);
    if (!authResult.ok) {
      res.status(authResult.status).json({ error: authResult.error });
      return;
    }

    try {
      const metrics = await registry.metrics();
      res.set("Content-Type", registry.contentType);
      res.end(metrics);
    } catch {
      res.status(500).end();
    }
  });

  router.post(
    "/api/telemetry/wallet",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = WalletTelemetrySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }

      const telemetry = parsed.data;
      const provider = telemetry.provider ?? "unknown";
      walletTelemetryEvents.inc({ event: telemetry.event, provider });

      if (telemetry.durationMs !== undefined) {
        walletTelemetryDuration.observe(
          { event: telemetry.event, provider },
          telemetry.durationMs / 1000,
        );
      }

      logger.info(
        {
          walletTelemetry: telemetry,
          requestId: req.headers["x-request-id"],
        },
        "wallet telemetry received",
      );

      ok(res, { accepted: true });
    }),
  );

  router.get("/api/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  router.get(
    "/api/ready",
    asyncHandler(async (_req: Request, res: Response) => {
      const databaseReady = context.health?.checkDatabase
        ? await context.health.checkDatabase().catch(() => false)
        : null;
      const redisReady = context.health?.checkRedis
        ? await context.health.checkRedis().catch(() => false)
        : null;
      const indexerState = context.health?.getIndexerState?.() ?? null;

      const checks = {
        database: databaseReady === null ? "unknown" : databaseReady ? "ok" : "error",
        redis: redisReady === null ? "unknown" : redisReady ? "ok" : "error",
        indexer:
          indexerState === null
            ? "unknown"
            : indexerState.running
              ? "ok"
              : "error",
      } as const;

      const isReady =
        (databaseReady ?? true) &&
        (redisReady ?? true) &&
        (indexerState?.running ?? true);

      res.status(isReady ? 200 : 503).json({
        status: isReady ? "ready" : "degraded",
        timestamp: new Date().toISOString(),
        checks,
        indexer:
          indexerState === null
            ? null
            : {
                running: indexerState.running,
                lastProcessedBlock: indexerState.lastProcessedBlock,
              },
      });
    }),
  );

  // Public config — exposes non-sensitive protocol addresses for the frontend.
  router.get("/api/config", (_req: Request, res: Response) => {
    ok(res, {
      operatorAddress: context.deps.settler.adminAddr,
      resolutionDisputePeriodSeconds:
        context.deps.settler.resolutionDisputePeriodSeconds,
    });
  });
}
