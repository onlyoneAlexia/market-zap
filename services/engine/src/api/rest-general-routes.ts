import { type Request, type Response, type Router } from "express";
import { logger } from "../logger.js";
import {
  registry,
  walletTelemetryDuration,
  walletTelemetryEvents,
} from "../metrics.js";
import { asyncHandler, ok, WalletTelemetrySchema } from "./rest-shared.js";
import type { RestRouteContext } from "./rest-types.js";

export function registerGeneralRoutes(
  router: Router,
  _context: RestRouteContext,
): void {
  router.get("/metrics", async (req: Request, res: Response) => {
    const apiKey = process.env.ENGINE_API_KEY;
    if (apiKey) {
      const auth = req.headers.authorization;
      if (!auth || auth !== `Bearer ${apiKey}`) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
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
}
