"use client";

import { Wallet, SignOut, Copy, ArrowSquareOut } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/features/wallet/use-wallet";

const CHAIN_LABELS: Record<string, string> = {
  SN_SEPOLIA: "Sepolia",
  SN_MAINNET: "Mainnet",
};

export function WalletButton() {
  const { address, isConnected, isConnecting, chainId, connect, disconnect } =
    useWallet();

  if (isConnected && address) {
    const networkLabel = CHAIN_LABELS[chainId ?? ""] ?? chainId ?? "Unknown";

    return (
      <div className="hidden items-center rounded-lg border bg-card/30 backdrop-blur-sm sm:flex">
        <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono tracking-wider">
          <div className="h-1.5 w-1.5 rounded-full bg-yes" />
          {address.slice(0, 6)}...{address.slice(-4)}
          <span className="text-muted-foreground">{networkLabel}</span>
        </div>
        <button
          onClick={disconnect}
          className="flex items-center justify-center border-l border-border/60 px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          aria-label="Disconnect wallet"
        >
          <SignOut className="h-3.5 w-3.5" weight="bold" />
        </button>
      </div>
    );
  }

  return (
    <Button
      onClick={connect}
      disabled={isConnecting}
      size="sm"
      className="gap-1.5 font-mono tracking-wider"
    >
      <Wallet className="h-4 w-4" weight="duotone" />
      {isConnecting ? "Connecting..." : "Connect"}
    </Button>
  );
}
