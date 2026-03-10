"use client";

import { useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-client";
import { useAppStore } from "./use-store";
import { useToast } from "./use-toast";
import { getEngineWsUrl } from "@/lib/api";
import type { PaginatedResponse, Trade } from "@market-zap/shared";

/**
 * Global WebSocket connection manager with exponential backoff reconnection.
 *
 * Mounted once at the app level (Providers). Never drops — reconnects
 * automatically with jittered exponential backoff (1s → 30s cap).
 *
 * Components subscribe/unsubscribe to channels via the store's
 * wsSubscriptions set. This hook watches that set and sends
 * subscribe/unsubscribe messages as channels are added/removed.
 */

const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 25_000; // send pong before server's 30s timeout

interface QuoteData {
  bestBid: string | null;
  bestAsk: string | null;
  spread: string;
  lastPrice: string | null;
  lastTradeTime: number;
}

interface TradeData {
  type: "trade";
  trade: Trade & { settled?: boolean };
}

interface TradeSettledData {
  type: "trade_settled";
  tradeId: string;
  txHash: string;
  buyer?: string;
  seller?: string;
}

interface TradeFailedData {
  type: "trade_failed";
  tradeId: string;
  error: string;
  buyer?: string;
  seller?: string;
}

/** Defence-in-depth: if a raw RPC error somehow reaches the frontend, truncate it. */
function friendlySettlementError(raw: string): string {
  if (raw.length <= 150) return raw;
  if (raw.toLowerCase().includes("erc1155") && raw.toLowerCase().includes("insufficient")) {
    return "Counterparty outcome-token inventory is insufficient on-chain. Your order was rolled back.";
  }
  if (raw.toLowerCase().includes("estimatefee") || raw.toLowerCase().includes("estimate_fee")) {
    return "On-chain transaction simulation failed. Your order has been rolled back.";
  }
  if (raw.toLowerCase().includes("balance") || raw.toLowerCase().includes("insufficient")) {
    return "Insufficient on-chain balance to complete this trade.";
  }
  return "On-chain settlement failed. Your balance has been released.";
}

export function useGlobalWebSocket() {
  const queryClient = useQueryClient();
  const setWsConnected = useAppStore((s) => s.setWsConnected);
  const channels = useAppStore((s) => s.wsChannels);
  const walletAddress = useAppStore((s) => s.wallet.address);
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const walletRef = useRef(walletAddress);
  walletRef.current = walletAddress;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const backoffMs = useRef(MIN_RECONNECT_MS);
  const mountedRef = useRef(true);
  const subscribedRef = useRef<Set<string>>(new Set());
  const channelsRef = useRef(channels);
  channelsRef.current = channels;

  // Buffer for price updates — flushed at rAF rate
  const bufferRef = useRef<Map<string, QuoteData>>(new Map());
  const rafRef = useRef<number | null>(null);

  const flushBuffer = useCallback(() => {
    const buffer = bufferRef.current;
    if (buffer.size > 0) {
      buffer.forEach((data, key) => {
        const [, mId, outcome] = key.split(":");
        queryClient.setQueryData(queryKeys.quote(mId, Number(outcome)), data);
      });
      buffer.clear();
    }
    rafRef.current = null;
  }, [queryClient]);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(flushBuffer);
  }, [flushBuffer]);

  const normalizeAddress = useCallback((address: string): string => {
    return "0x" + address.replace(/^0x0*/i, "").toLowerCase();
  }, []);

  const isWalletParticipant = useCallback(
    (buyer?: string, seller?: string): boolean => {
      const current = walletRef.current;
      if (!current) return false;
      const normalizedCurrent = normalizeAddress(current);
      return [buyer, seller]
        .filter((addr): addr is string => Boolean(addr))
        .some((addr) => normalizeAddress(addr) === normalizedCurrent);
    },
    [normalizeAddress],
  );

  const clearTimers = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (heartbeatTimer.current) {
      clearInterval(heartbeatTimer.current);
      heartbeatTimer.current = null;
    }
  }, []);

  const syncSubscriptions = useCallback((ws: WebSocket) => {
    const desired = channelsRef.current;
    const current = subscribedRef.current;

    // Subscribe to new channels
    const toSubscribe = [...desired].filter((ch) => !current.has(ch));
    if (toSubscribe.length > 0 && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "subscribe", channels: toSubscribe }));
      toSubscribe.forEach((ch) => current.add(ch));
    }

    // Unsubscribe from removed channels
    const toUnsubscribe = [...current].filter((ch) => !desired.has(ch));
    if (toUnsubscribe.length > 0 && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "unsubscribe", channels: toUnsubscribe }));
      toUnsubscribe.forEach((ch) => current.delete(ch));
    }
  }, []);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    clearTimers();

    const ws = new WebSocket(getEngineWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      backoffMs.current = MIN_RECONNECT_MS;
      subscribedRef.current.clear();

      // Re-subscribe to all desired channels
      syncSubscriptions(ws);

      // Heartbeat: respond to server pings and send keepalive
      heartbeatTimer.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      }, HEARTBEAT_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        // Server ping → respond immediately
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }

        if (msg.channel?.startsWith("price:")) {
          bufferRef.current.set(msg.channel, msg.data);
          scheduleFlush();
        } else if (msg.channel?.startsWith("trades:")) {
          const marketId = msg.channel.split(":")[1];
          const data = msg.data as TradeData | TradeSettledData | unknown;

          if (
            typeof data === "object" &&
            data !== null &&
            "type" in data &&
            (data as { type: unknown }).type === "trade"
          ) {
            const trade = (data as TradeData).trade;
            queryClient.setQueryData(
              queryKeys.markets.trades(marketId),
              (old: PaginatedResponse<Trade> | undefined) => {
                const prev = old ?? {
                  items: [],
                  total: 0,
                  page: 0,
                  pageSize: 50,
                  hasMore: false,
                };
                const nextItems = [
                  trade,
                  ...prev.items.filter((t) => t.id !== trade.id),
                ].slice(0, 200);
                return {
                  ...prev,
                  items: nextItems,
                  total: Math.max(prev.total, nextItems.length),
                };
              },
            );
          } else if (
            typeof data === "object" &&
            data !== null &&
            "type" in data &&
            (data as { type: unknown }).type === "trade_settled"
          ) {
            const { tradeId, txHash, buyer, seller } = data as TradeSettledData;
            queryClient.setQueryData(
              queryKeys.markets.trades(marketId),
              (old: PaginatedResponse<Trade> | undefined) => {
                if (!old) return old;
                const items = old.items.map((t) =>
                  t.id === tradeId ? { ...t, txHash, settled: true } : t,
                );
                return { ...old, items };
              },
            );

            if (isWalletParticipant(buyer, seller)) {
              // Only refresh wallet-specific data for the participant.
              queryClient.invalidateQueries({ queryKey: ["balance"] });
              queryClient.invalidateQueries({ queryKey: ["portfolio"] });

              toastRef.current({
                title: "Trade settled on-chain",
                description: `Transaction confirmed: ${txHash.slice(0, 10)}...`,
                variant: "success",
              });
            }
          } else if (
            typeof data === "object" &&
            data !== null &&
            "type" in data &&
            (data as { type: unknown }).type === "trade_failed"
          ) {
            const { tradeId, error, buyer, seller } = data as TradeFailedData;
            // Update the trade in cache to show "failed" instead of "settling..."
            queryClient.setQueryData(
              queryKeys.markets.trades(marketId),
              (old: PaginatedResponse<Trade> | undefined) => {
                if (!old) return old;
                const items = old.items.map((t) =>
                  t.id === tradeId
                    ? { ...t, settlementStatus: "failed", settlementError: error }
                    : t,
                );
                return { ...old, items };
              },
            );
            // Settlement failed — refresh market-level data for all viewers.
            queryClient.invalidateQueries({ queryKey: queryKeys.markets.detail(marketId) });
            queryClient.invalidateQueries({ queryKey: ["liquidity"] });

            if (isWalletParticipant(buyer, seller)) {
              // Only participants need balance/portfolio refresh + destructive toast.
              queryClient.invalidateQueries({ queryKey: ["balance"] });
              queryClient.invalidateQueries({ queryKey: ["portfolio"] });
              toastRef.current({
                title: "Settlement failed",
                description: friendlySettlementError(
                  error || "On-chain settlement failed. Your balance has been released.",
                ),
                variant: "destructive",
                duration: 10000,
              });
            }
          }
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      setWsConnected(false);
      subscribedRef.current.clear();
      clearTimers();
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after onerror, which handles reconnection
    };
  }, [
    setWsConnected,
    queryClient,
    clearTimers,
    syncSubscriptions,
    scheduleFlush,
    isWalletParticipant,
  ]);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;
    const jitter = Math.random() * 0.3 * backoffMs.current;
    const delay = backoffMs.current + jitter;
    reconnectTimer.current = setTimeout(() => {
      backoffMs.current = Math.min(backoffMs.current * 2, MAX_RECONNECT_MS);
      connect();
    }, delay);
  }, [connect]);

  // Initial connection + rAF loop
  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      clearTimers();
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on intentional close
        wsRef.current.close();
        wsRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect, clearTimers]);

  // Sync subscriptions when channels set changes
  useEffect(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      syncSubscriptions(wsRef.current);
    }
  }, [channels, syncSubscriptions]);
}
