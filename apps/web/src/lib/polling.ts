"use client";

/**
 * Return an active polling interval only while the tab is visible and online.
 * Hidden tabs return `false` to pause interval polling.
 */
export function visibleRefetchInterval(intervalMs: number): number | false {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") {
    return false;
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return false;
  }
  return intervalMs;
}

