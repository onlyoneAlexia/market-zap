"use client";

import type { WalletConnectionPhase } from "./wallet-connection-status";
import type { WalletProvider } from "./wallet-provider";

const ENGINE_TELEMETRY_URL = (
  process.env.NEXT_PUBLIC_ENGINE_URL || "http://localhost:3001/api"
).replace(/\/+$/, "");

export type WalletTelemetryEventName =
  | "modal_opened"
  | "provider_selected"
  | "connect_started"
  | "connect_succeeded"
  | "connect_failed"
  | "connect_retry"
  | "session_authorization_started"
  | "session_authorization_succeeded"
  | "session_authorization_failed";

export interface WalletTelemetryEvent {
  event: WalletTelemetryEventName;
  provider?: WalletProvider;
  phase?: WalletConnectionPhase;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  isSlow?: boolean;
  path?: string;
  source?: "web";
  emittedAt?: string;
  deviceClass?: "mobile" | "desktop";
}

function getDeviceClass(): "mobile" | "desktop" {
  if (typeof navigator === "undefined") {
    return "desktop";
  }

  return /android|iphone|ipad|mobile/i.test(navigator.userAgent)
    ? "mobile"
    : "desktop";
}

function truncate(value: string | undefined, maxLength = 180): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

export function toWalletTelemetryError(
  error: unknown,
): Pick<WalletTelemetryEvent, "errorCode" | "errorMessage"> {
  if (!(error instanceof Error)) {
    return {
      errorCode: "unknown",
      errorMessage: truncate(String(error)),
    };
  }

  const message = error.message.toLowerCase();
  if (message.includes("failed to initialize")) {
    return {
      errorCode: "controller_init_failed",
      errorMessage: truncate(error.message),
    };
  }
  if (message.includes("not detected")) {
    return {
      errorCode: "wallet_not_detected",
      errorMessage: truncate(error.message),
    };
  }
  if (message.includes("rejected")) {
    return {
      errorCode: "user_rejected",
      errorMessage: truncate(error.message),
    };
  }

  return {
    errorCode: "wallet_error",
    errorMessage: truncate(error.message),
  };
}

export function emitWalletTelemetry(
  event: WalletTelemetryEvent,
): void {
  if (typeof window === "undefined") {
    return;
  }

  const payload: WalletTelemetryEvent = {
    source: "web",
    path: window.location.pathname,
    emittedAt: new Date().toISOString(),
    deviceClass: getDeviceClass(),
    ...event,
    errorMessage: truncate(event.errorMessage),
  };

  void fetch(`${ENGINE_TELEMETRY_URL}/telemetry/wallet`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {});
}
