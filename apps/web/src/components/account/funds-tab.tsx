"use client";

import { useState } from "react";
import {
  Spinner,
  DownloadSimple,
  UploadSimple,
  ArrowsClockwise,
} from "@phosphor-icons/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AnimatedTabs,
  AnimatedTabsList,
  AnimatedTabsTrigger,
  AnimatedTabsContent,
} from "@/components/ui/animated-tabs";
import { useWallet } from "@/features/wallet/use-wallet";
import {
  useWalletUSDCBalance,
  useExchangeBalance,
  useExchangeReserved,
  useInvalidateBalances,
  useInvalidateAndPoll,
} from "@/hooks/use-wallet-balance";
import { useToast } from "@/hooks/use-toast";
import { COLLATERAL_TOKENS, shortenAddress } from "@market-zap/shared";
import type { CollateralTokenInfo } from "@market-zap/shared";

const SUPPORTED_TOKENS = Object.values(COLLATERAL_TOKENS);
const DEFAULT_TOKEN = SUPPORTED_TOKENS[0]; // USDC

function formatToken(raw: bigint | undefined, decimals: number): string {
  if (raw === undefined) return "...";
  return (Number(raw) / 10 ** decimals).toFixed(2);
}

function parseToken(input: string, decimals: number): bigint {
  const num = parseFloat(input);
  if (isNaN(num) || num <= 0) return 0n;
  return BigInt(Math.round(num * 10 ** decimals));
}

function TokenBalanceCard({
  tokenInfo,
  walletBalance,
  exchangeBalance,
  reservedBalance,
  isLoading,
  isError,
}: {
  tokenInfo: CollateralTokenInfo;
  walletBalance: bigint | undefined;
  exchangeBalance: bigint | undefined;
  reservedBalance: bigint | undefined;
  isLoading: boolean;
  isError?: boolean;
}) {
  const d = tokenInfo.decimals;
  const display = (val: bigint | undefined) =>
    isLoading ? "..." : isError ? "Error" : formatToken(val, d);
  return (
    <div className="grid gap-4 text-center sm:grid-cols-3">
      <div>
        <p className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">Wallet {tokenInfo.symbol} balance</p>
        <p className={`font-mono text-lg font-semibold ${isError ? "text-destructive" : ""}`}>
          {display(walletBalance)}
        </p>
      </div>
      <div>
        <p className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">Exchange available</p>
        <p className={`font-mono text-lg font-semibold ${isError ? "text-destructive" : "text-yes"}`}>
          {display(exchangeBalance)}
        </p>
      </div>
      <div>
        <p className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">Exchange reserved</p>
        <p className={`font-mono text-lg font-semibold ${isError ? "text-destructive" : "text-muted-foreground"}`}>
          {display(reservedBalance)}
        </p>
      </div>
    </div>
  );
}

const PERCENT_BUTTONS = [
  { label: "25%", pct: 0.25 },
  { label: "50%", pct: 0.5 },
  { label: "75%", pct: 0.75 },
  { label: "Max", pct: 1 },
] as const;

function PercentShortcuts({
  maxRaw,
  decimals,
  onSelect,
}: {
  maxRaw: bigint | undefined;
  decimals: number;
  onSelect: (value: string) => void;
}) {
  if (maxRaw === undefined || maxRaw <= 0n) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {PERCENT_BUTTONS.map(({ label, pct }) => {
        const raw = pct === 1 ? maxRaw : (maxRaw * BigInt(Math.round(pct * 100))) / 100n;
        const human = Number(raw) / 10 ** decimals;
        return (
          <button
            key={label}
            type="button"
            onClick={() => onSelect(human > 0 ? human.toString() : "")}
            className="rounded border border-muted px-2 py-0.5 text-[10px] font-mono tracking-wider text-muted-foreground transition-colors hover:border-primary hover:text-primary"
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function FundsTab() {
  const { ensureConnected } = useWallet();
  const { toast } = useToast();
  const invalidateBalances = useInvalidateBalances();
  const invalidateAndPoll = useInvalidateAndPoll();

  const [activeToken, setActiveToken] = useState(DEFAULT_TOKEN.symbol);
  const selectedToken = SUPPORTED_TOKENS.find((t) => t.symbol === activeToken) ?? DEFAULT_TOKEN;
  const tokenAddress = selectedToken.addresses.sepolia;
  const decimals = selectedToken.decimals;

  const { data: walletBalanceRaw, isLoading: walletLoading, isError: walletError } = useWalletUSDCBalance(tokenAddress);
  const { data: exchangeBalanceRaw, isLoading: exchangeLoading, isError: exchangeError } = useExchangeBalance(tokenAddress);
  const { data: reservedBalanceRaw, isLoading: reservedLoading, isError: reservedError } = useExchangeReserved(tokenAddress);
  const walletBalance = walletBalanceRaw != null ? BigInt(walletBalanceRaw) : undefined;
  const exchangeBalance = exchangeBalanceRaw != null ? BigInt(exchangeBalanceRaw) : undefined;
  const reservedBalance = reservedBalanceRaw != null ? BigInt(reservedBalanceRaw) : undefined;
  const balanceLoading = walletLoading || exchangeLoading || reservedLoading;
  const balanceError = walletError || exchangeError || reservedError;

  const [faucetLoading, setFaucetLoading] = useState(false);
  const [depositAmount, setDepositAmount] = useState("");
  const [depositLoading, setDepositLoading] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawLoading, setWithdrawLoading] = useState(false);

  // Instant validation
  const depositParsed = parseToken(depositAmount, decimals);
  const depositExceedsWallet = depositAmount && walletBalance !== undefined && depositParsed > walletBalance;
  const withdrawParsed = parseToken(withdrawAmount, decimals);
  const withdrawExceedsAvailable = withdrawAmount && exchangeBalance !== undefined && withdrawParsed > exchangeBalance;

  const handleFaucet = async () => {
    setFaucetLoading(true);
    try {
      const c = await ensureConnected();
      // Mint + approve + deposit in one multicall (gasless if wallet supports it)
      const result = await c.mintAndDeposit(parseToken("100", decimals));
      if (!result.success) throw new Error(result.error ?? "Faucet failed");
      const gasNote = c.getState().gasless ? " (gasless)" : "";
      toast({ title: `Got 100 ${selectedToken.symbol}`, description: `Minted & deposited${gasNote}. Tx: ${shortenAddress(result.txHash)}`, variant: "success" });
      await invalidateAndPoll();
    } catch (err) {
      toast({ title: "Faucet failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setFaucetLoading(false);
    }
  };

  const handleDeposit = async () => {
    const amount = parseToken(depositAmount, decimals);
    if (amount <= 0n) return;
    setDepositLoading(true);
    try {
      const c = await ensureConnected();
      const result = await c.approveAndDeposit(tokenAddress, amount);
      if (!result.success) throw new Error(result.error ?? "Deposit failed");
      toast({ title: `Deposited ${depositAmount} ${selectedToken.symbol}`, description: `Tx: ${shortenAddress(result.txHash)}`, variant: "success" });
      setDepositAmount("");
      await invalidateAndPoll();
    } catch (err) {
      toast({ title: "Deposit failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setDepositLoading(false);
    }
  };

  const handleWithdraw = async () => {
    const amount = parseToken(withdrawAmount, decimals);
    if (amount <= 0n) return;
    setWithdrawLoading(true);
    try {
      const c = await ensureConnected();
      const result = await c.withdraw(tokenAddress, amount);
      if (!result.success) throw new Error(result.error ?? "Withdraw failed");
      toast({ title: `Withdrew ${withdrawAmount} ${selectedToken.symbol}`, description: `Tx: ${shortenAddress(result.txHash)}`, variant: "success" });
      setWithdrawAmount("");
      await invalidateAndPoll();
    } catch (err) {
      toast({ title: "Withdraw failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setWithdrawLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Token selector */}
      <AnimatedTabs
        value={activeToken}
        onValueChange={(value) => {
          setActiveToken(value);
          setDepositAmount("");
          setWithdrawAmount("");
        }}
      >
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <AnimatedTabsList className="mb-4 min-w-max">
            {SUPPORTED_TOKENS.map((t) => (
              <AnimatedTabsTrigger
                key={t.symbol}
                value={t.symbol}
                isActive={activeToken === t.symbol}
                layoutGroup="funds-token"
              >
                {t.symbol}
              </AnimatedTabsTrigger>
            ))}
          </AnimatedTabsList>
        </div>

        {SUPPORTED_TOKENS.map((t) => (
          <AnimatedTabsContent key={t.symbol} value={t.symbol} contentKey={`funds-${t.symbol}`}>
            {/* Balances overview */}
            <Card className="mb-6">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">{t.name} Balances</CardTitle>
                <Button variant="ghost" size="icon" onClick={invalidateBalances} className="h-8 w-8">
                  <ArrowsClockwise className="h-4 w-4" weight="bold" />
                </Button>
              </CardHeader>
              <CardContent>
                <TokenBalanceCard
                  tokenInfo={t}
                  walletBalance={walletBalance}
                  exchangeBalance={exchangeBalance}
                  reservedBalance={reservedBalance}
                  isLoading={balanceLoading}
                  isError={balanceError}
                />
                <p className="mt-3 text-[11px] font-mono text-muted-foreground/70">
                  Wallet = tokens in your browser wallet. Exchange = deposited for trading. Use the faucet or deposit to move funds.
                </p>
              </CardContent>
            </Card>

            <div className="space-y-4">
              {/* Faucet — only for USDC */}
              {t.symbol === "USDC" && (
                <Card>
                  <CardContent className="flex items-center justify-between p-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">Testnet faucet</h3>
                        <span className="inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-mono font-bold tracking-wider text-amber">
                          Testnet only
                        </span>
                      </div>
                      <p className="text-[11px] font-mono text-muted-foreground">Get 100 USDC deposited to your exchange balance</p>
                    </div>
                    <Button onClick={handleFaucet} disabled={faucetLoading} variant="outline">
                      {faucetLoading ? <Spinner className="mr-2 h-4 w-4 animate-spin" weight="bold" /> : null}
                      Get USDC
                    </Button>
                  </CardContent>
                </Card>
              )}

              {/* Deposit */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-[10px] font-mono font-bold tracking-wider text-muted-foreground">
                    <DownloadSimple className="h-4 w-4" weight="bold" />
                    Deposit {t.symbol}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-[11px] font-mono text-muted-foreground">
                      Deposit from wallet into the exchange.
                    </p>
                    <PercentShortcuts maxRaw={walletBalance} decimals={decimals} onSelect={setDepositAmount} />
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      type="number"
                      placeholder={`Amount (${t.symbol})`}
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      className={`font-mono ${depositExceedsWallet ? "border-destructive" : ""}`}
                      min={0}
                    />
                    <Button onClick={handleDeposit} disabled={depositLoading || !depositAmount || parseFloat(depositAmount) <= 0 || !!depositExceedsWallet} className="sm:min-w-[120px]">
                      {depositLoading ? <Spinner className="mr-2 h-4 w-4 animate-spin" weight="bold" /> : null}
                      Deposit
                    </Button>
                  </div>
                  {depositExceedsWallet && (
                    <p className="text-xs text-destructive">
                      Exceeds wallet balance ({formatToken(walletBalance, decimals)} {t.symbol}).
                    </p>
                  )}
                </CardContent>
              </Card>

              {/* Withdraw */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-[10px] font-mono font-bold tracking-wider text-muted-foreground">
                    <UploadSimple className="h-4 w-4" weight="bold" />
                    Withdraw {t.symbol}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-[11px] font-mono text-muted-foreground">
                      Withdraw from exchange to wallet.
                    </p>
                    <PercentShortcuts maxRaw={exchangeBalance} decimals={decimals} onSelect={setWithdrawAmount} />
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      type="number"
                      placeholder={`Amount (${t.symbol})`}
                      value={withdrawAmount}
                      onChange={(e) => setWithdrawAmount(e.target.value)}
                      className={`font-mono ${withdrawExceedsAvailable ? "border-destructive" : ""}`}
                      min={0}
                    />
                    <Button onClick={handleWithdraw} disabled={withdrawLoading || !withdrawAmount || parseFloat(withdrawAmount) <= 0 || !!withdrawExceedsAvailable} variant="outline" className="sm:min-w-[120px]">
                      {withdrawLoading ? <Spinner className="mr-2 h-4 w-4 animate-spin" weight="bold" /> : null}
                      Withdraw
                    </Button>
                  </div>
                  {withdrawExceedsAvailable && (
                    <p className="text-xs text-destructive">
                      Exceeds available balance ({formatToken(exchangeBalance, decimals)} {t.symbol}).
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>
          </AnimatedTabsContent>
        ))}
      </AnimatedTabs>
    </div>
  );
}
