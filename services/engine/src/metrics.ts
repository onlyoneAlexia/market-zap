import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";

/**
 * Prometheus metrics for observability.
 * Exposed at GET /metrics.
 */
export const registry = new Registry();

collectDefaultMetrics({ register: registry });

// -- Order lifecycle --
export const ordersSubmitted = new Counter({
  name: "engine_orders_submitted_total",
  help: "Total orders submitted",
  labelNames: ["side", "orderType"] as const,
  registers: [registry],
});

export const ordersFilled = new Counter({
  name: "engine_orders_filled_total",
  help: "Total orders fully or partially filled",
  labelNames: ["source"] as const, // "clob" | "amm"
  registers: [registry],
});

export const ordersCancelled = new Counter({
  name: "engine_orders_cancelled_total",
  help: "Total orders cancelled",
  registers: [registry],
});

// -- Trade settlement --
export const tradesSettled = new Counter({
  name: "engine_trades_settled_total",
  help: "Total trades settled on-chain",
  registers: [registry],
});

export const tradesFailed = new Counter({
  name: "engine_trades_failed_total",
  help: "Total trades that failed settlement",
  registers: [registry],
});

export const settlementDuration = new Histogram({
  name: "engine_settlement_duration_seconds",
  help: "Time to settle trades on-chain",
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

// -- HTTP --
export const httpRequestDuration = new Histogram({
  name: "engine_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

// -- WebSocket --
export const wsConnections = new Gauge({
  name: "engine_ws_connections",
  help: "Current active WebSocket connections",
  registers: [registry],
});

export const wsSubscriptions = new Gauge({
  name: "engine_ws_subscriptions",
  help: "Current active WebSocket channel subscriptions",
  registers: [registry],
});

// -- Orderbook --
export const orderbookDepth = new Gauge({
  name: "engine_orderbook_depth",
  help: "Number of orders on one side of the book",
  labelNames: ["marketId", "outcomeIndex", "side"] as const,
  registers: [registry],
});

export const walletTelemetryEvents = new Counter({
  name: "engine_wallet_telemetry_events_total",
  help: "Total wallet telemetry events received from web clients",
  labelNames: ["event", "provider"] as const,
  registers: [registry],
});

export const walletTelemetryDuration = new Histogram({
  name: "engine_wallet_telemetry_duration_seconds",
  help: "Observed wallet flow durations reported by web clients",
  labelNames: ["event", "provider"] as const,
  buckets: [0.25, 0.5, 1, 2, 5, 10, 20, 30, 60],
  registers: [registry],
});
