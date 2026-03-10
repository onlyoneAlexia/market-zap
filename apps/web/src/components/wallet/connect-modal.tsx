"use client";

import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Lightning, ShieldCheck, WarningCircle, Globe, Spinner } from "@phosphor-icons/react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/hooks/use-store";
import { useWallet, type WalletProvider } from "@/features/wallet/use-wallet";
import { emitWalletTelemetry } from "@/features/wallet/wallet-telemetry";
import { warmCartridgeClient } from "@/features/wallet/wallet-client";

const providers: {
  id: WalletProvider;
  label: string;
  icon: React.ElementType;
  description: string;
}[] = [
  {
    id: "argentX",
    label: "Argent X",
    icon: ShieldCheck,
    description: "Connect with Argent X browser extension",
  },
  {
    id: "braavos",
    label: "Braavos",
    icon: Lightning,
    description: "Connect with Braavos browser extension",
  },
  {
    id: "cartridge",
    label: "Social Login",
    icon: Globe,
    description: "Google, passkeys, or Discord via Cartridge",
  },
];

export function ConnectModal() {
  const open = useAppStore((s) => s.connectModalOpen);
  const setOpen = useAppStore((s) => s.setConnectModalOpen);
  const resetWalletConnectionStatus = useAppStore(
    (s) => s.resetWalletConnectionStatus,
  );
  const {
    connectBrowserWallet,
    connectCartridge,
    isConnecting,
    walletConnectionStatus,
  } = useWallet();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    warmCartridgeClient();
  }, [open]);

  const activeProvider = providers.find(
    (provider) => provider.id === walletConnectionStatus.provider,
  );
  const StatusIcon =
    walletConnectionStatus.phase === "error" ? WarningCircle : Spinner;

  const handleConnect = async (providerId: WalletProvider) => {
    setError(null);
    emitWalletTelemetry({
      event: "provider_selected",
      provider: providerId,
      phase: "preparing",
    });
    try {
      if (providerId === "cartridge") {
        await connectCartridge();
      } else {
        await connectBrowserWallet(providerId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setError(null);
      resetWalletConnectionStatus();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[calc(100vw-1rem)] rounded border bg-card/30 backdrop-blur-sm p-4 sm:max-w-md sm:p-6">
        <DialogHeader className="items-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded border bg-gradient-to-br from-blue-600/20 to-cyan-400/20 border-cyan/20 animate-float">
            <Lightning className="h-6 w-6 text-cyan" weight="duotone" />
          </div>
          <DialogTitle>Connect to MarketZap</DialogTitle>
          <DialogDescription>
            Choose a wallet to connect to Starknet Sepolia testnet.
          </DialogDescription>
        </DialogHeader>

        <motion.div
          className="mt-2 flex flex-col gap-2"
          initial="hidden"
          animate="visible"
          variants={{
            hidden: {},
            visible: { transition: { staggerChildren: 0.08 } },
          }}
        >
          {providers.map((provider) => (
            <motion.div
              key={provider.id}
              variants={{
                hidden: { opacity: 0, y: 8 },
                visible: { opacity: 1, y: 0 },
              }}
            >
              <Button
                variant="outline"
                className="h-auto w-full justify-start gap-3 rounded border px-4 py-3 font-mono tracking-wider"
                onClick={() => handleConnect(provider.id)}
                disabled={isConnecting}
              >
                <provider.icon className="h-5 w-5 shrink-0 text-muted-foreground" weight="duotone" />
                <div className="text-left">
                  <div className="text-[10px] font-mono font-bold tracking-wider">{provider.label}</div>
                  <div className="text-[11px] font-mono text-muted-foreground tracking-normal">
                    {provider.description}
                  </div>
                </div>
              </Button>
            </motion.div>
          ))}
        </motion.div>

        {walletConnectionStatus.message && (
          <div className="mt-3 rounded border border-cyan/20 bg-card/30 backdrop-blur-sm p-3 text-sm">
            <div className="flex items-start gap-2">
              <StatusIcon
                className={[
                  "mt-0.5 h-4 w-4 shrink-0 text-primary",
                  walletConnectionStatus.phase === "error" ? "" : "animate-spin",
                ].join(" ")}
              />
              <div className="space-y-1">
                {activeProvider && (
                  <p className="text-xs font-medium tracking-[0.18em] text-muted-foreground">
                    {activeProvider.label}
                  </p>
                )}
                <p className="font-medium text-foreground">
                  {walletConnectionStatus.message}
                </p>
                {walletConnectionStatus.isSlow && (
                  <p className="text-xs text-muted-foreground">
                    This can happen on the first Cartridge load while the third-party controller warms up.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="mt-2 flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-xs text-destructive">
            <WarningCircle className="mt-0.5 h-4 w-4 shrink-0" weight="fill" />
            {error}
          </div>
        )}

        <p className="mt-4 text-center text-[11px] font-mono text-muted-foreground">
          By connecting, you agree to our Terms of Service. Powered by Starknet.
        </p>
      </DialogContent>
    </Dialog>
  );
}
