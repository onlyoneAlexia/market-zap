"use client";

import { useEffect, useRef } from "react";
import { useAppStore } from "@/hooks/use-store";
import { getWalletObject, isExtensionProvider } from "./wallet-provider";
import { restoreWalletConnection } from "./wallet-client";

export function useWalletAutoReconnect() {
  const wallet = useAppStore((state) => state.wallet);
  const setWallet = useAppStore((state) => state.setWallet);
  const disconnectWallet = useAppStore((state) => state.disconnectWallet);
  const hasReconnected = useRef(false);
  const accountChangeCleanup = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (hasReconnected.current) {
      return;
    }

    hasReconnected.current = true;

    if (!wallet.address || !wallet.provider) {
      if (wallet.address && !wallet.provider) {
        disconnectWallet();
      }
      return;
    }

    void restoreWalletConnection(wallet, setWallet, disconnectWallet).catch(
      () => {
        disconnectWallet();
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (accountChangeCleanup.current) {
      accountChangeCleanup.current();
      accountChangeCleanup.current = null;
    }

    const { provider } = wallet;
    if (!provider || !isExtensionProvider(provider)) {
      return;
    }

    const walletObject = getWalletObject(provider);
    if (!walletObject?.on) {
      return;
    }

    const handleAccountsChanged = async () => {
      try {
        const currentWallet = useAppStore.getState().wallet;
        await restoreWalletConnection(
          currentWallet,
          setWallet,
          disconnectWallet,
        );
      } catch {
        disconnectWallet();
      }
    };

    walletObject.on("accountsChanged", handleAccountsChanged);
    accountChangeCleanup.current = () => {
      walletObject.off?.("accountsChanged", handleAccountsChanged);
    };

    return () => {
      if (accountChangeCleanup.current) {
        accountChangeCleanup.current();
        accountChangeCleanup.current = null;
      }
    };
  }, [disconnectWallet, setWallet, wallet.provider]);
}
