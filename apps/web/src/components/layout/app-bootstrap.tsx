"use client";

import { useGlobalWebSocket } from "@/hooks/use-ws";
import { useWalletAuth } from "@/features/wallet/use-wallet-auth";
import { useWalletAutoReconnect } from "@/features/wallet/use-wallet-auto-reconnect";

export function AppBootstrap() {
  useGlobalWebSocket();
  useWalletAutoReconnect();
  useWalletAuth();
  return null;
}
