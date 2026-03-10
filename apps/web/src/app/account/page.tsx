"use client";

import React, { Suspense, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Wallet, TrendUp, Trophy, ArrowUpRight } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { PageTransition } from "@/components/ui/page-transition";
import { StaggerChildren, StaggerItem } from "@/components/ui/stagger-children";
import {
  AnimatedTabs,
  AnimatedTabsList,
  AnimatedTabsTrigger,
  AnimatedTabsContent,
} from "@/components/ui/animated-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { ClaimableRewardsCard } from "@/components/account/claimable-rewards-card";
import { PositionsTable } from "@/components/portfolio/positions-table";
import { PnlCard } from "@/components/portfolio/pnl-card";
import { TradeHistory } from "@/components/portfolio/trade-history";
import { FundsTab } from "@/components/account/funds-tab";
import { MyOrders } from "@/components/trading/my-orders";
import { useWallet } from "@/features/wallet/use-wallet";
import { usePortfolio } from "@/hooks/use-portfolio";
import {
  getInitialAccountTab,
  replaceAccountTabInCurrentUrl,
  type AccountTab,
} from "@/lib/account-tabs";
import { shortenAddress } from "@market-zap/shared";

export default function AccountPage() {
  return (
    <Suspense>
      <AccountContent />
    </Suspense>
  );
}

function AccountContent() {
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<AccountTab>(() =>
    getInitialAccountTab(new URLSearchParams(searchParams.toString())),
  );

  const { isConnected, address, openConnectModal } = useWallet();
  const { data: portfolio, isLoading } = usePortfolio();

  const handleTabChange = useCallback(
    (value: string) => {
      const tab = value as AccountTab;
      setActiveTab(tab);
      replaceAccountTabInCurrentUrl(tab);
    },
    [],
  );

  // -----------------------------------------------------------------------
  // Not connected
  // -----------------------------------------------------------------------
  if (!isConnected) {
    return (
      <div className="container mx-auto flex max-w-screen-xl flex-col items-center justify-center px-4 py-20">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded border border-primary/20 bg-primary/5">
          <Wallet className="h-6 w-6 text-primary" weight="duotone" />
        </div>
        <h2 className="mb-2 text-lg font-bold font-mono tracking-wider">Connect Wallet</h2>
        <p className="mb-6 text-[11px] font-mono text-muted-foreground tracking-wider">
          View positions, manage funds, claim rewards
        </p>
        <Button onClick={openConnectModal} size="lg" className="font-mono tracking-wider">
          Connect Wallet
        </Button>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Loading
  // -----------------------------------------------------------------------
  if (isLoading) {
    return (
      <div className="container mx-auto max-w-screen-xl px-4 py-6">
        <div className="mb-6">
          <h1 className="font-heading text-xl font-bold tracking-wider">Account</h1>
          <p className="text-[10px] font-mono text-muted-foreground mt-0.5 tracking-wider">
            {shortenAddress(address ?? "")} &middot; Sepolia
          </p>
        </div>
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="rounded-lg border p-5">
              <Skeleton className="mb-3 h-4 w-24" />
              <Skeleton className="h-7 w-20" />
            </div>
          ))}
        </div>
        <div className="rounded-lg border">
          <div className="border-b p-4">
            <Skeleton className="h-8 w-64" />
          </div>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-4 border-b px-4 py-3 last:border-0">
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Connected
  // -----------------------------------------------------------------------
  return (
    <PageTransition>
      <div className="container mx-auto max-w-screen-xl px-4 py-6">
        {/* Header */}
        <div className="mb-6">
          <h1 className="font-heading text-xl font-bold tracking-wider">Account</h1>
          <p className="text-[10px] font-mono text-muted-foreground mt-0.5 tracking-wider">
            {shortenAddress(address ?? "")} &middot; Sepolia
          </p>
        </div>

        {/* Portfolio summary cards */}
        <StaggerChildren className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StaggerItem>
            <PnlCard
              label="Total Value"
              value={portfolio ? `$${portfolio.totalValue}` : "$0"}
              icon={Wallet}
            />
          </StaggerItem>
          <StaggerItem>
            <PnlCard
              label="Total P&L"
              value={portfolio ? `$${portfolio.totalPnl}` : "$0"}
              change={portfolio?.winRate ?? 0}
              icon={TrendUp}
            />
          </StaggerItem>
          <StaggerItem>
            <PnlCard
              label="Win Rate"
              value={portfolio ? `${portfolio.winRate}%` : "0%"}
              icon={Trophy}
            />
          </StaggerItem>
          <StaggerItem>
            <PnlCard
              label="Open Positions"
              value={String(portfolio?.positions?.length ?? 0)}
              icon={ArrowUpRight}
            />
          </StaggerItem>
        </StaggerChildren>

        {/* Main tabs */}
        <AnimatedTabs value={activeTab} onValueChange={handleTabChange}>
          <div className="-mx-1 overflow-x-auto px-1 pb-1">
            <AnimatedTabsList className="min-w-max">
              <AnimatedTabsTrigger
                value="positions"
                isActive={activeTab === "positions"}
                layoutGroup="account-tabs"
              >
                Positions
              </AnimatedTabsTrigger>
              <AnimatedTabsTrigger
                value="orders"
                isActive={activeTab === "orders"}
                layoutGroup="account-tabs"
              >
                Orders
              </AnimatedTabsTrigger>
              <AnimatedTabsTrigger
                value="history"
                isActive={activeTab === "history"}
                layoutGroup="account-tabs"
              >
                History
              </AnimatedTabsTrigger>
              <AnimatedTabsTrigger
                value="rewards"
                isActive={activeTab === "rewards"}
                layoutGroup="account-tabs"
              >
                Rewards
              </AnimatedTabsTrigger>
              <AnimatedTabsTrigger
                value="funds"
                isActive={activeTab === "funds"}
                layoutGroup="account-tabs"
              >
                Funds
              </AnimatedTabsTrigger>
            </AnimatedTabsList>
          </div>

          {/* Positions */}
          <AnimatedTabsContent value="positions" contentKey="account-positions">
            <PositionsTable positions={portfolio?.positions} />
          </AnimatedTabsContent>

          {/* Open Orders */}
          <AnimatedTabsContent value="orders" contentKey="account-orders">
            <MyOrders />
          </AnimatedTabsContent>

          {/* Trade History */}
          <AnimatedTabsContent value="history" contentKey="account-history">
            <TradeHistory />
          </AnimatedTabsContent>

          {/* Claimable Rewards */}
          <AnimatedTabsContent value="rewards" contentKey="account-rewards">
            <ClaimableRewardsCard />
          </AnimatedTabsContent>

          {/* Funds */}
          <AnimatedTabsContent value="funds" contentKey="account-funds">
            <FundsTab />
          </AnimatedTabsContent>
        </AnimatedTabs>
      </div>
    </PageTransition>
  );
}
