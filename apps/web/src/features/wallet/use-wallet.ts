"use client";

import { useCallback } from "react";
import { useAppStore } from "@/hooks/use-store";
import { api } from "@/lib/api";
import type { WalletConnectionPhase } from "./wallet-connection-status";
import {
  connectCartridgeWalletClient,
  connectExtensionWallet,
  disconnectAllClients,
  getCartridgeClient,
  getClient,
  restoreWalletConnection,
  warmCartridgeClient,
} from "./wallet-client";
import {
  getWalletDisplayName,
  type ExtensionWalletProvider,
  type WalletProvider,
} from "./wallet-provider";
import {
  emitWalletTelemetry,
  toWalletTelemetryError,
} from "./wallet-telemetry";

export function useWallet() {
  const wallet = useAppStore((state) => state.wallet);
  const setWallet = useAppStore((state) => state.setWallet);
  const disconnectWallet = useAppStore((state) => state.disconnectWallet);
  const walletConnectionStatus = useAppStore(
    (state) => state.walletConnectionStatus,
  );
  const setWalletConnectionStatus = useAppStore(
    (state) => state.setWalletConnectionStatus,
  );
  const resetWalletConnectionStatus = useAppStore(
    (state) => state.resetWalletConnectionStatus,
  );
  const setConnectModalOpen = useAppStore(
    (state) => state.setConnectModalOpen,
  );

  const publishConnectionStatus = useCallback(
    (
      provider: WalletProvider,
      phase: WalletConnectionPhase,
      message: string,
      isSlow = false,
    ) => {
      setWalletConnectionStatus({
        provider,
        phase,
        message,
        isSlow,
      });
    },
    [setWalletConnectionStatus],
  );

  const completeConnection = useCallback(
    (provider: WalletProvider, startedAt: number) => {
      emitWalletTelemetry({
        event: "connect_succeeded",
        provider,
        phase: "connected",
        durationMs: Date.now() - startedAt,
      });
      publishConnectionStatus(provider, "connected", "Wallet connected");
      setConnectModalOpen(false);
      resetWalletConnectionStatus();
    },
    [publishConnectionStatus, resetWalletConnectionStatus, setConnectModalOpen],
  );

  const failConnection = useCallback(
    (provider: WalletProvider, startedAt: number, error: unknown) => {
      const telemetryError = toWalletTelemetryError(error);
      emitWalletTelemetry({
        event: "connect_failed",
        provider,
        phase: "error",
        durationMs: Date.now() - startedAt,
        ...telemetryError,
      });
      publishConnectionStatus(
        provider,
        "error",
        telemetryError.errorMessage ?? "Connection failed",
      );
    },
    [publishConnectionStatus],
  );

  const connectBrowserWallet = useCallback(
    async (provider: ExtensionWalletProvider) => {
      const startedAt = Date.now();
      emitWalletTelemetry({
        event: "connect_started",
        provider,
        phase: "waiting_for_approval",
      });
      setWallet({ isConnecting: true });
      publishConnectionStatus(
        provider,
        "waiting_for_approval",
        `Approve the connection in ${getWalletDisplayName(provider)}`,
      );

      try {
        await disconnectAllClients();
        const client = await getClient();
        await connectExtensionWallet(provider, client, setWallet);
        completeConnection(provider, startedAt);
      } catch (error) {
        console.error("[wallet] browser connect failed:", error);
        setWallet({ isConnecting: false });
        failConnection(provider, startedAt, error);
        throw error;
      }
    },
    [completeConnection, failConnection, publishConnectionStatus, setWallet],
  );

  const connectCartridge = useCallback(async () => {
    const startedAt = Date.now();
    const slowLoadTimer =
      typeof window === "undefined"
        ? null
        : window.setTimeout(() => {
            publishConnectionStatus(
              "cartridge",
              "waiting_for_approval",
              "Still waiting for Cartridge. The first load can take a little longer.",
              true,
            );
          }, 6000);

    emitWalletTelemetry({
      event: "connect_started",
      provider: "cartridge",
      phase: "preparing",
    });
    setWallet({ isConnecting: true });
    publishConnectionStatus(
      "cartridge",
      "preparing",
      "Preparing Social Login",
    );

    try {
      await disconnectAllClients();
      publishConnectionStatus(
        "cartridge",
        "opening_wallet",
        "Opening Cartridge controller",
      );
      await connectCartridgeWalletClient(setWallet, {
        onRetry: () => {
          emitWalletTelemetry({
            event: "connect_retry",
            provider: "cartridge",
            phase: "retrying",
            isSlow: true,
          });
          publishConnectionStatus(
            "cartridge",
            "retrying",
            "Retrying Cartridge controller load",
            true,
          );
        },
      });
      completeConnection("cartridge", startedAt);
    } catch (error) {
      console.error("[wallet] cartridge connect failed:", error);
      setWallet({ isConnecting: false });
      failConnection("cartridge", startedAt, error);

      if (
        error instanceof Error &&
        error.message.includes("failed to initialize")
      ) {
        throw new Error(
          "Cartridge Controller could not load. Check your internet connection, ensure popups/iframes are not blocked, and try again.",
        );
      }

      throw error;
    } finally {
      if (slowLoadTimer !== null) {
        window.clearTimeout(slowLoadTimer);
      }
    }
  }, [
    completeConnection,
    failConnection,
    publishConnectionStatus,
    setWallet,
  ]);

  const connect = useCallback(() => {
    warmCartridgeClient();
    emitWalletTelemetry({
      event: "modal_opened",
      phase: "idle",
    });
    resetWalletConnectionStatus();
    setConnectModalOpen(true);
  }, [resetWalletConnectionStatus, setConnectModalOpen]);

  const disconnect = useCallback(async () => {
    await disconnectAllClients();
    api.setAuthProvider(null);
    resetWalletConnectionStatus();
    disconnectWallet();
  }, [disconnectWallet, resetWalletConnectionStatus]);

  const openConnectModal = useCallback(() => {
    warmCartridgeClient();
    emitWalletTelemetry({
      event: "modal_opened",
      phase: "idle",
    });
    resetWalletConnectionStatus();
    setConnectModalOpen(true);
  }, [resetWalletConnectionStatus, setConnectModalOpen]);

  const ensureConnected = useCallback(async () => {
    const { provider } = wallet;
    if (!provider) {
      disconnectWallet();
      throw new Error("Wallet not connected");
    }

    const activeClient =
      provider === "cartridge"
        ? await getCartridgeClient()
        : await getClient();

    if (activeClient.hasWallet()) {
      return activeClient;
    }

    const restoredClient = await restoreWalletConnection(
      wallet,
      setWallet,
      disconnectWallet,
    );

    if (!restoredClient) {
      throw new Error("Wallet not connected");
    }

    return restoredClient;
  }, [disconnectWallet, setWallet, wallet]);

  return {
    address: wallet.address,
    isConnecting: wallet.isConnecting,
    isConnected: Boolean(wallet.address),
    chainId: wallet.chainId,
    walletConnectionStatus,
    ensureConnected,
    connect,
    connectBrowserWallet,
    connectCartridge,
    disconnect,
    openConnectModal,
  };
}

export type { WalletProvider };
