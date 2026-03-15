import { MarketZapAPI } from "@market-zap/shared";

const RAW_ENGINE_URL =
  process.env.NEXT_PUBLIC_ENGINE_URL || "/engine-api";

/**
 * Resolve a possibly-relative URL against the current page origin.
 * On the server (SSR), relative paths resolve to localhost.
 */
function resolveUrl(raw: string, protocol: "http" | "ws" = "http"): string {
  if (/^https?:\/\//.test(raw) || /^wss?:\/\//.test(raw)) {
    return raw;
  }
  if (typeof window !== "undefined") {
    return `${window.location.origin}${raw}`;
  }
  // SSR fallback
  return `${protocol}://localhost:3000${raw}`;
}

export const ENGINE_URL = resolveUrl(RAW_ENGINE_URL);

/** Singleton API client instance for the CLOB engine. */
export const api = new MarketZapAPI(ENGINE_URL);

const RAW_ENGINE_WS_URL =
  process.env.NEXT_PUBLIC_ENGINE_WS_URL || "/engine-ws";

/**
 * Resolve the WebSocket URL. Relative paths like "/engine-ws" become
 * "wss://host/engine-ws" (or ws:// for plain http).
 */
export function getEngineWsUrl(): string {
  if (/^wss?:\/\//.test(RAW_ENGINE_WS_URL)) {
    return RAW_ENGINE_WS_URL;
  }
  if (typeof window !== "undefined") {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}${RAW_ENGINE_WS_URL}`;
  }
  return `ws://localhost:3000${RAW_ENGINE_WS_URL}`;
}

export const ENGINE_WS_URL = getEngineWsUrl();
