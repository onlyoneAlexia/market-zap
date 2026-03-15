"use client";

import React from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartBar, PlusSquare, Trophy, User, ShieldCheck } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { useAppStore } from "@/hooks/use-store";
import { useIsOperator } from "@/hooks/use-operator";
import { PwaInstallButton } from "@/components/layout/pwa-install-button";

const WalletButton = dynamic(
  () =>
    import("@/components/wallet/wallet-button").then((mod) => ({
      default: mod.WalletButton,
    })),
  {
    ssr: false,
    loading: () => (
      <Button disabled size="sm" className="gap-1.5 font-mono tracking-wider">
        Connect
      </Button>
    ),
  },
);

const baseNavItems = [
  { href: "/markets", label: "Markets", icon: ChartBar },
  { href: "/create", label: "Create", icon: PlusSquare },
  { href: "/leaderboard", label: "Rank", icon: Trophy },
  { href: "/account", label: "Account", icon: User },
];

export function Navbar() {
  const pathname = usePathname();

  const walletAddress = useAppStore((s) => s.wallet.address);
  const isAdmin = useIsOperator(walletAddress ?? undefined);

  const navItems = isAdmin ? [...baseNavItems, { href: "/resolve", label: "Resolve", icon: ShieldCheck }] : baseNavItems;

  return (
    <header className="sticky top-0 z-50 w-full glass border-b border-border/60">
      {/* Terminal status bar */}
      <div className="hidden border-b border-border/40 bg-card/30 px-4 py-1 text-[10px] font-mono text-muted-foreground sm:flex sm:items-center sm:justify-end">
        <div className="flex items-center gap-2">
          <PwaInstallButton />
          <ThemeToggle />
        </div>
      </div>

      {/* Mobile row: logo + wallet */}
      <div className="flex items-center justify-between px-4 py-2 md:hidden">
        <Link href="/" prefetch={true} className="flex items-center gap-0">
          <svg width="32" height="28" viewBox="0 0 32 28" fill="none" className="shrink-0 -mr-0.5">
            <polyline
              points="2,18 7,18 10,8 13,22 16,4 19,18 24,18"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              className="text-primary"
            />
            <circle cx="16" cy="4" r="2" fill="currentColor" className="text-primary" opacity="0.4" />
          </svg>
          <span className="font-heading text-base font-bold tracking-wider">
            arket<span className="text-primary">zap</span>
          </span>
        </Link>

        <div className="flex items-center gap-1.5">
          <PwaInstallButton />
          <ThemeToggle />
          <WalletButton />
        </div>
      </div>

      {/* Mobile nav row */}
      <nav className="flex gap-0.5 overflow-x-auto px-4 pb-2 md:hidden">
        {navItems.map((item) => {
          const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
          return (
            <Button key={item.href} asChild variant="ghost" size="sm" className="shrink-0">
              <Link
                href={item.href}
                prefetch
                className={cn(
                  "relative gap-1.5 rounded px-3 text-muted-foreground font-mono text-xs tracking-wider",
                  isActive && "bg-primary/10 text-primary border border-primary/20",
                )}
              >
                <item.icon className="h-3.5 w-3.5" weight={isActive ? "fill" : "regular"} />
                <span>{item.label}</span>
              </Link>
            </Button>
          );
        })}
      </nav>

      {/* Desktop: Logo left | Nav absolute-centered | Wallet right */}
      <div className="relative hidden h-12 items-center px-4 md:flex">
        <Link href="/" prefetch={true} className="relative z-10 flex items-center gap-0">
          <svg width="32" height="28" viewBox="0 0 32 28" fill="none" className="shrink-0 -mr-0.5">
            <polyline
              points="2,18 7,18 10,8 13,22 16,4 19,18 24,18"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              className="text-primary"
            />
            <circle cx="16" cy="4" r="2" fill="currentColor" className="text-primary" opacity="0.4" />
          </svg>
          <span className="font-heading text-lg font-bold tracking-wider">
            arket<span className="text-primary">zap</span>
          </span>
        </Link>

        <nav className="absolute inset-x-0 flex items-center justify-center pointer-events-none">
          <div className="pointer-events-auto inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-card/50 px-1 py-0.5">
            {navItems.map((item) => {
              const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  prefetch
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-muted-foreground font-mono text-xs tracking-wider transition-colors hover:text-foreground hover:bg-accent/50",
                    isActive && "bg-primary/10 text-primary border border-primary/20",
                  )}
                >
                  <item.icon className="h-3.5 w-3.5" weight={isActive ? "fill" : "regular"} />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </nav>

        <div className="relative z-10 ml-auto flex items-center">
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
