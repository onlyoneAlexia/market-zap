import pino from "pino";

/**
 * Structured JSON logger for the engine.
 * Uses pino for high-performance JSON logging with correlation IDs.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: "market-zap-engine" },
});

export type Logger = typeof logger;
