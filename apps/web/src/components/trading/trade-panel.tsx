"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Info, Spinner } from "@phosphor-icons/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useWallet } from "@/features/wallet/use-wallet";
import { useSubmitOrder } from "@/hooks/use-order";
import { useBalance } from "@/hooks/use-balance";
import { useQuote } from "@/hooks/use-quote";
import { usePortfolio } from "@/hooks/use-portfolio";
import { useToast } from "@/hooks/use-toast";
import { useInvalidateAndPoll } from "@/hooks/use-wallet-balance";
import { generateNonce, getTokenByAddress, computeTokenId, scalePrice } from "@market-zap/shared";
import type { SubmitOrderResponse } from "@market-zap/shared";
import { getMaxBuySharesRaw, getRequiredBuyCollateralRaw } from "@/lib/trade-balance";
import { useIsOperator } from "@/hooks/use-operator";

interface TradePanelProps {
  marketId: string;
  outcomes: string[];
  prices: number[];
  collateralToken: string;
  conditionId?: string;
  onChainMarketId?: string;
  /** Unix timestamp in seconds after which trading should close. */
  resolutionTime?: number;
  /** Whether the market has been resolved (trading should be disabled). */
  resolved?: boolean;
  /** Whether the market has been voided (trading should be disabled). */
  voided?: boolean;
  /** Index of the winning outcome (if resolved). */
  resolvedOutcomeIndex?: number | null;
}

const MAX_AMOUNT_BUTTONS = [
  { label: "25%", pct: 0.25 },
  { label: "50%", pct: 0.5 },
  { label: "75%", pct: 0.75 },
  { label: "Max", pct: 1 },
] as const;

function isUserRejected(message: string): boolean {
  return message.includes("User abort") || message.includes("rejected");
}

function getTradingClosedToastCopy(marketHasEnded: boolean) {
  return marketHasEnded
    ? {
        title: "Market ended",
        description: "This market reached its resolution time and can no longer be traded.",
      }
    : {
        title: "Trading unavailable",
        description: "Trading is closed for this market.",
      };
}

function getOrderErrorDescription(error: unknown): string {
  let description = "Something went wrong. Please try again.";

  if (error instanceof Error) {
    description = error.message;
    const body = (error as { body?: { error?: string } }).body;
    if (body?.error) {
      description = typeof body.error === "string" ? body.error : JSON.stringify(body.error);
    }
  }

  const lower = description.toLowerCase();
  if (lower.includes("insufficient") || lower.includes("not enough")) {
    return "Insufficient deposited balance. Deposit more funds or reduce your order size.";
  }
  if (lower.includes("self-trade")) {
    return "The operator account cannot trade on its own markets. Connect a different wallet.";
  }
  if (lower.includes("nonce") && lower.includes("used")) {
    return "This order was already processed. Please submit a new order.";
  }
  if (lower.includes("expired")) {
    return "Order expired before it could be matched. Try again with a new order.";
  }
  if (lower.includes("no liquidity") || lower.includes("no fill")) {
    return "No liquidity available. Try a smaller amount or place a limit order instead.";
  }

  return description;
}

export const TradePanel = React.memo(function TradePanel({
  marketId,
  outcomes,
  prices,
  collateralToken,
  conditionId,
  onChainMarketId,
  resolutionTime,
  resolved,
  voided,
  resolvedOutcomeIndex,
}: TradePanelProps) {
  const [selectedOutcome, setSelectedOutcome] = useState(0);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [amount, setAmount] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [signing, setSigning] = useState(false);
  const [depositing, setDepositing] = useState(false);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const { isConnected, address, openConnectModal, ensureConnected } = useWallet();
  const isOperator = useIsOperator(address ?? undefined);
  const submitOrder = useSubmitOrder();
  const invalidateAndPoll = useInvalidateAndPoll();
  const { toast } = useToast();

  const tokenInfo = useMemo(() => getTokenByAddress(collateralToken, "sepolia"), [collateralToken]);
  const tokenSymbol = tokenInfo?.symbol ?? "USDC";
  const decimals = tokenInfo?.decimals ?? 6;

  // Engine-computed balances:
  // - `available` is on-chain exchange balance minus pending (unsettled) costs.
  // - `walletBalance` is informational wallet ERC-20 balance.
  const { data: balanceData } = useBalance(collateralToken);
  const exchangeAvailableRaw = balanceData?.available !== undefined ? BigInt(balanceData.available) : undefined;
  const walletBalanceRaw = balanceData?.walletBalance !== undefined ? BigInt(balanceData.walletBalance) : undefined;

  // Use on-chain decimals for wallet balance (may differ from engine's internal decimals)
  const walletDec = balanceData?.walletDecimals ?? decimals;
  const exchangeDec = balanceData?.exchangeDecimals ?? decimals;

  const availableBalance = exchangeAvailableRaw !== undefined ? (Number(exchangeAvailableRaw) / 10 ** exchangeDec).toFixed(2) : null;
  const walletBalance = walletBalanceRaw !== undefined ? (Number(walletBalanceRaw) / 10 ** walletDec).toFixed(2) : null;
  const needsDeposit =
    exchangeAvailableRaw !== undefined && walletBalanceRaw !== undefined && exchangeAvailableRaw === 0n && walletBalanceRaw > 0n;
  const canDepositMore =
    !needsDeposit &&
    exchangeAvailableRaw !== undefined &&
    walletBalanceRaw !== undefined &&
    exchangeAvailableRaw > 0n &&
    walletBalanceRaw > 0n;

  const currentPrice = prices[selectedOutcome] ?? 0.5;
  const effectivePrice = orderType === "limit" && limitPrice ? parseFloat(limitPrice) / 100 : currentPrice;
  const parsedAmount = Number.parseFloat(amount);
  const hasValidAmount = Number.isFinite(parsedAmount) && parsedAmount > 0;

  useEffect(() => {
    if (!resolutionTime || resolved || voided) {
      return;
    }

    const interval = window.setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000));
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [resolutionTime, resolved, voided]);

  const marketHasEnded = !!resolutionTime && resolutionTime > 0 && resolutionTime <= nowSeconds;
  const tradingClosed = !!resolved || !!voided || marketHasEnded;
  const tradingClosedToastCopy = getTradingClosedToastCopy(marketHasEnded);

  // Fetch user positions to cap sell orders by shares held
  const { data: portfolio } = usePortfolio();
  const positionQuantity = useMemo(() => {
    if (!portfolio?.positions) return null;
    const pos = portfolio.positions.find((p) => p.marketId === marketId && p.outcomeIndex === selectedOutcome);
    if (!pos) return null;
    // quantity is already human-readable (engine divides by token decimals)
    const qty = parseFloat(pos.quantity);
    return qty > 0 ? qty : null;
  }, [portfolio, marketId, selectedOutcome]);

  const amountRaw = useMemo(() => {
    if (!hasValidAmount) {
      return null;
    }

    return BigInt(Math.round(parsedAmount * 10 ** decimals));
  }, [decimals, hasValidAmount, parsedAmount]);

  const buyCapRaw = useMemo(() => {
    if (exchangeAvailableRaw === undefined || effectivePrice <= 0) {
      return null;
    }

    return getMaxBuySharesRaw({
      availableRaw: exchangeAvailableRaw,
      orderType,
      effectivePrice,
    });
  }, [exchangeAvailableRaw, orderType, effectivePrice]);

  const buyCap = buyCapRaw !== null ? Number(buyCapRaw) / 10 ** decimals : null;
  const effectiveCap = side === "sell" ? positionQuantity : buyCap;

  const requiredCollateralRaw = useMemo(() => {
    if (side !== "buy" || amountRaw === null) {
      return null;
    }

    return getRequiredBuyCollateralRaw({
      amountRaw,
      orderType,
      effectivePrice,
    });
  }, [side, amountRaw, orderType, effectivePrice]);

  const requiredCollateral = requiredCollateralRaw !== null ? (Number(requiredCollateralRaw) / 10 ** exchangeDec).toFixed(2) : null;

  const requestedAmount = hasValidAmount ? parsedAmount : undefined;
  const { data: quoteForAmount, isFetching: quoteLoading } = useQuote(
    marketId,
    selectedOutcome,
    side === "buy" ? "BUY" : "SELL",
    requestedAmount,
  );
  const exceedsCap = effectiveCap !== null && hasValidAmount && parsedAmount > effectiveCap;
  const displayCap = effectiveCap !== null ? Math.floor(effectiveCap * 100) / 100 : null;
  const submitDisabled =
    signing ||
    depositing ||
    submitOrder.isPending ||
    (side === "buy" && needsDeposit) ||
    (isConnected && !hasValidAmount) ||
    (isConnected && exceedsCap);
  const submitLabel = !isConnected ? "Connect Wallet" : `${side === "buy" ? "Buy" : "Sell"} ${outcomes[selectedOutcome] ?? "Yes"}`;

  const { cost, potentialReturn, potentialReturnPositive, takerFee, total } = useMemo(() => {
    const amt = amount ? parseFloat(amount) : 0;
    if (!amt)
      return {
        cost: "0",
        takerFee: "0",
        total: "0",
        potentialReturn: "0",
        potentialReturnPositive: true,
      };
    const costRaw = amt * effectivePrice;
    // Limit orders that cross the spread are also taker for the matched portion,
    // but we can't know that from the frontend alone. Show "up to 1%" for limits.
    const feeRaw = orderType === "limit" ? 0 : costRaw * 0.01; // 0% maker, up to 1% taker
    if (side === "sell") {
      // Sell: user receives (subtotal - fee) USDC
      const proceeds = costRaw - feeRaw;
      return {
        cost: costRaw.toFixed(2),
        takerFee: feeRaw.toFixed(2),
        total: proceeds.toFixed(2),
        potentialReturn: proceeds.toFixed(2),
        potentialReturnPositive: proceeds >= 0,
      };
    }
    const totalRaw = costRaw + feeRaw;
    const profit = amt - totalRaw;
    return {
      cost: costRaw.toFixed(2),
      takerFee: feeRaw.toFixed(2),
      total: totalRaw.toFixed(2),
      potentialReturn: profit.toFixed(2),
      potentialReturnPositive: profit >= 0,
    };
  }, [amount, effectivePrice, orderType, side]);

  const handleDeposit = async () => {
    if (!isConnected || !address) {
      openConnectModal();
      return;
    }
    if (tradingClosed) {
      toast({ ...tradingClosedToastCopy, variant: "destructive" });
      return;
    }
    setDepositing(true);
    try {
      const c = await ensureConnected();
      // Deposit the wallet balance (or at least enough for the trade)
      const depositAmount = walletBalanceRaw ?? 0n;
      if (depositAmount <= 0n) {
        toast({
          title: "No wallet balance",
          description: `You need ${tokenSymbol} in your wallet first. On testnet, use the faucet to get test ${tokenSymbol}.`,
          variant: "destructive",
        });
        return;
      }
      const depositResult = await c.approveAndDeposit(collateralToken, depositAmount);
      if (!depositResult.success) throw new Error(depositResult.error ?? "Deposit failed");
      await invalidateAndPoll();
      toast({
        title: "Deposit successful",
        description: `Deposited ${(Number(depositAmount) / 10 ** decimals).toFixed(2)} ${tokenSymbol} into the exchange.`,
        variant: "success",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isUserRejected(msg)) {
        toast({
          title: "Deposit failed",
          description: msg,
          variant: "destructive",
        });
      }
    } finally {
      setDepositing(false);
    }
  };

  const handleSubmit = async () => {
    if (!isConnected || !address) {
      openConnectModal();
      return;
    }
    if (tradingClosed) {
      toast({ ...tradingClosedToastCopy, variant: "destructive" });
      return;
    }

    // Ensure the StarkZap client singleton has a live Account reference.
    // After a page refresh, the Zustand store may have the address from
    // localStorage but the client singleton lost its Account object.
    let connectedClient;
    try {
      connectedClient = await ensureConnected();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast({
        title: "Wallet not connected",
        description: msg,
        variant: "destructive",
      });
      return;
    }

    // For sell orders, ensure the exchange is approved to transfer the user's
    // ERC-1155 outcome tokens.  On-chain settle_trade calls safe_transfer_from
    // which requires operator approval.  This is a one-time tx per user.
    if (side === "sell") {
      try {
        const approvalResult = await connectedClient.ensureExchangeApprovedForSell();
        if (!approvalResult.success) {
          toast({
            title: "Approval failed",
            description: "Could not approve the exchange to transfer your shares. Please try again.",
            variant: "destructive",
          });
          return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!isUserRejected(msg)) {
          toast({
            title: "Approval failed",
            description: msg,
            variant: "destructive",
          });
        }
        return;
      }
    }

    // Compute real token_id and sign the order
    const nonce = generateNonce();
    // Market orders: short expiry (2min) since they execute immediately.
    // Limit orders: 24h to rest on the book.
    const expiry = Math.floor(Date.now() / 1000) + (orderType === "market" ? 120 : 86400);
    const amountScaled = amountRaw?.toString();
    if (!amountScaled) {
      toast({
        title: "Invalid amount",
        description: "Enter a valid share amount before submitting the order.",
        variant: "destructive",
      });
      return;
    }

    let signature = "";
    if (conditionId) {
      try {
        const tokenId = computeTokenId(conditionId, selectedOutcome);
        // For market orders, sign with the extreme price the engine uses on-chain:
        //   BUY → 1e18 (100%), SELL → 1 (≈0%)
        // This ensures the signed hash matches the on-chain Order struct.
        // For limit orders, use the STRING representation to avoid floating-point
        // artifacts from toFixed(18) diverging from the submitted price string.
        const priceStr = effectivePrice.toString();
        const signingPrice =
          orderType === "market"
            ? side === "buy"
              ? BigInt("1000000000000000000") // BUY → 100%
              : BigInt("1") // SELL → ~0%
            : scalePrice(priceStr);
        const orderParams = {
          trader: address,
          marketId: BigInt(onChainMarketId || "0"),
          tokenId,
          isBuy: side === "buy",
          price: signingPrice,
          amount: BigInt(amountScaled),
          nonce: BigInt(nonce),
          expiry: BigInt(expiry),
        };
        setSigning(true);
        signature = await connectedClient.signOrderAsync(orderParams);
      } catch (err) {
        setSigning(false);
        // User rejected or wallet error — don't silently submit unsigned
        const msg = err instanceof Error ? err.message : String(err);
        toast({
          title: "Signing cancelled",
          description: isUserRejected(msg) ? "You rejected the signature request in your wallet." : `Wallet signing failed: ${msg}`,
          variant: "destructive",
        });
        return;
      } finally {
        setSigning(false);
      }
    }
    if (!signature) {
      toast({
        title: "Cannot submit order",
        description: "Market is missing condition data. Please try again later.",
        variant: "destructive",
      });
      return;
    }

    submitOrder.mutate(
      {
        marketId,
        outcomeIndex: selectedOutcome,
        side,
        type: orderType,
        price: effectivePrice.toString(),
        amount: amountScaled,
        maker: address,
        nonce: nonce.toString(),
        expiry,
        signature,
        timeInForce: orderType === "market" ? "IOC" : "GTC",
      },
      {
        onSuccess: (data: SubmitOrderResponse) => {
          const { order, trades } = data;

          if (trades.length === 0 && !order.restingOnBook) {
            // Market order with no liquidity — AMM exhausted or no pool
            toast({
              title: "No liquidity available",
              description: "Your market order could not be filled. The AMM pool may be exhausted. Try a smaller amount or a limit order.",
              variant: "destructive",
              duration: 7000,
            });
          } else if (trades.length === 0 && order.restingOnBook) {
            // Pure limit order placed, no immediate matches
            toast({
              title: "Limit order placed",
              description: `Your order for ${amount} shares at ${(effectivePrice * 100).toFixed(1)}% is on the book.`,
            });
          } else if (trades.length > 0) {
            const totalFilled = trades.reduce((sum, t) => sum + parseFloat(t.fillAmount), 0);
            const avgPrice = trades.reduce((sum, t) => sum + parseFloat(t.price) * parseFloat(t.fillAmount), 0) / totalFilled;

            const ammFills = trades.filter((t) => t.source === "amm").length;
            const sourceLabel = ammFills > 0 ? " via AMM" : "";

            // Convert from token decimals for display
            const filledDisplay = (totalFilled / 10 ** decimals).toFixed(2);

            if (order.restingOnBook) {
              const remainDisplay = (parseFloat(order.remainingAmount) / 10 ** decimals).toFixed(2);
              toast({
                title: "Order matched — settling on-chain",
                description: `${filledDisplay} shares at ${(avgPrice * 100).toFixed(1)}%${sourceLabel}. Remaining ${remainDisplay} on the book. Settlement takes 10-30s.`,
              });
            } else {
              toast({
                title: "Order matched — settling on-chain",
                description: `${filledDisplay} shares at ${(avgPrice * 100).toFixed(1)}%${sourceLabel}. Settlement takes 10-30s.`,
              });
            }

            setAmount("");
            setLimitPrice("");
          }
        },
        onError: (error: unknown) => {
          toast({
            title: "Order failed",
            description: getOrderErrorDescription(error),
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <Card className="overflow-hidden border-0 shadow-none lg:border lg:shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">Trade</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Resolved / voided market — block trading */}
        {tradingClosed && (
          <div className="rounded border border-border bg-card/30 p-4 text-center">
            <div className="text-sm font-mono font-semibold tracking-wider">
              {voided ? "Market Voided" : resolved ? "Market Resolved" : "Market Ended"}
            </div>
            {resolved && resolvedOutcomeIndex != null && outcomes[resolvedOutcomeIndex] && (
              <div className="mt-1 text-xs text-muted-foreground">
                Winning outcome: <span className="font-semibold text-foreground">{outcomes[resolvedOutcomeIndex]}</span>
              </div>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              {voided
                ? "This market was voided. All positions can be redeemed at cost."
                : resolved
                  ? "Trading is closed. If you hold winning shares, claim your payout from your portfolio."
                  : "This market has reached its resolution time. Trading is closed until it is resolved or voided."}
            </p>
          </div>
        )}

        {/* Operator wallet guard — cannot trade with the admin account */}
        {!tradingClosed && isOperator && (
          <div className="rounded border border-amber/30 bg-amber/5 p-6 text-center">
            <div className="text-sm font-mono font-semibold tracking-wider text-amber">Operator Account</div>
            <p className="mt-2 text-xs text-muted-foreground">
              The operator wallet cannot place trades. Connect a different wallet to buy or sell positions on this market.
            </p>
          </div>
        )}

        {/* Active market — trading controls */}
        {!tradingClosed && !isOperator && (
          <>
            {/* Buy / Sell toggle */}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setSide("buy")}
                className={cn(
                  "rounded border px-3 py-2 text-xs font-semibold font-mono tracking-wider transition-all",
                  side === "buy" ? "border-yes bg-yes/10 text-yes" : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted",
                )}
              >
                Buy
              </button>
              <button
                onClick={() => setSide("sell")}
                className={cn(
                  "rounded border px-3 py-2 text-xs font-semibold font-mono tracking-wider transition-all",
                  side === "sell" ? "border-no bg-no/10 text-no" : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted",
                )}
              >
                Sell
              </button>
            </div>

            {/* Outcome toggle */}
            <div
              className={cn(
                "grid gap-2",
                outcomes.length <= 2 ? "grid-cols-2" : outcomes.length === 3 ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-3",
              )}
            >
              {outcomes.map((outcome, i) => (
                <button
                  key={i}
                  onClick={() => setSelectedOutcome(i)}
                  className={cn(
                    "relative flex flex-col items-center rounded border px-3 py-2.5 transition-all",
                    selectedOutcome === i
                      ? i === 0
                        ? "border-yes bg-yes/5"
                        : "border-no bg-no/5"
                      : "border-transparent bg-muted/50 hover:bg-muted",
                  )}
                >
                  <span className="text-xs font-medium tracking-wide text-muted-foreground truncate max-w-full">{outcome}</span>
                  <span className={cn("font-mono text-lg font-bold", i === 0 ? "text-yes" : "text-no")}>
                    {((prices[i] ?? 0.5) * 100).toFixed(1)}%
                  </span>
                </button>
              ))}
            </div>

            {/* Order type tabs */}
            <Tabs value={orderType} onValueChange={(v) => setOrderType(v as "market" | "limit")}>
              <TabsList className="w-full">
                <TabsTrigger value="market" className="flex-1">
                  Market
                </TabsTrigger>
                <TabsTrigger value="limit" className="flex-1">
                  Limit
                </TabsTrigger>
              </TabsList>

              <TabsContent value="limit" className="mt-3">
                <div className="space-y-1">
                  <label className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">Limit price (%)</label>
                  <Input
                    type="number"
                    placeholder={`${(currentPrice * 100).toFixed(1)}`}
                    value={limitPrice}
                    onChange={(e) => setLimitPrice(e.target.value)}
                    className="font-mono"
                    min={1}
                    max={99}
                    step={0.1}
                  />
                </div>
              </TabsContent>
            </Tabs>

            {/* Amount */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground">Shares</label>
                <div className="flex flex-col items-end gap-0.5 text-right">
                  {isConnected && side === "buy" && availableBalance !== null && (
                    <span className="text-xs text-muted-foreground">
                      Deposited:{" "}
                      <span className="font-mono">
                        {availableBalance} {tokenSymbol}
                      </span>
                      {needsDeposit && <span className="ml-1 text-amber">(Wallet: {walletBalance})</span>}
                    </span>
                  )}
                  {isConnected && side === "sell" && (
                    <span className="text-xs text-muted-foreground">
                      Position: <span className="font-mono">{positionQuantity != null ? positionQuantity.toFixed(2) : "0"} shares</span>
                    </span>
                  )}
                </div>
              </div>
              {isConnected && effectiveCap !== null && effectiveCap > 0 && (
                <div className="flex flex-wrap gap-1">
                  {MAX_AMOUNT_BUTTONS.map(({ label, pct }) => {
                    const shares = Math.floor(effectiveCap * pct * 100) / 100;
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() => shares > 0 && setAmount(shares.toString())}
                        className="rounded border border-muted px-2 py-0.5 text-xs font-mono text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}
              <Input
                type="number"
                placeholder="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={cn("font-mono text-base sm:text-lg", exceedsCap && "border-destructive")}
                min={1}
              />
              {exceedsCap && displayCap !== null && (
                <div className="space-y-1.5">
                  <p className="text-xs text-destructive">
                    Exceeds deposited balance. Max ~{displayCap} shares.
                    {side === "buy" && orderType === "market"
                      ? " Market buys temporarily reserve up to 100% per share plus the 1% taker fee."
                      : side === "buy"
                        ? ` Exchange collateral also keeps a 1% fee buffer at ${(effectivePrice * 100).toFixed(1)}%.`
                        : ""}
                  </p>
                  {side === "buy" && canDepositMore && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 w-full border-amber/50 text-xs text-amber hover:bg-amber/10"
                      onClick={handleDeposit}
                      disabled={depositing}
                    >
                      {depositing ? (
                        <>
                          <Spinner className="mr-1.5 h-4 w-4 animate-spin" weight="bold" />
                          Depositing...
                        </>
                      ) : (
                        `Deposit ${walletBalance} ${tokenSymbol} from wallet`
                      )}
                    </Button>
                  )}
                </div>
              )}
              {side === "buy" && orderType === "market" && requiredCollateral !== null && (
                <p className="text-xs text-muted-foreground">
                  Required deposited collateral for this market buy:{" "}
                  <span className="font-mono text-foreground">
                    {requiredCollateral} {tokenSymbol}
                  </span>
                  . Actual execution usually settles lower, and unused collateral stays deposited.
                </p>
              )}
              {needsDeposit && (
                <div className="mt-1.5 rounded-md border border-amber/30 bg-amber/5 p-2">
                  <p className="text-xs text-amber">
                    You have {walletBalance} {tokenSymbol} in your wallet but haven&apos;t deposited into the exchange yet.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1.5 h-7 w-full border-amber/50 text-xs text-amber hover:bg-amber/10"
                    onClick={handleDeposit}
                    disabled={depositing}
                  >
                    {depositing ? (
                      <>
                        <Spinner className="mr-1.5 h-4 w-4 animate-spin" weight="bold" />
                        Depositing...
                      </>
                    ) : (
                      `Deposit ${walletBalance} ${tokenSymbol}`
                    )}
                  </Button>
                </div>
              )}
            </div>

            <Separator />

            {/* Order summary */}
            {hasValidAmount && (
              <div className="space-y-2 text-sm">
                {quoteForAmount?.quote && (
                  <div className="rounded-md border bg-muted/30 p-2">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[10px] font-mono tracking-wider text-muted-foreground">Execution estimate</span>
                      <span className={cn("text-xs font-medium", quoteForAmount.quote.canFill ? "text-yes" : "text-amber")}>
                        {quoteLoading ? "Updating..." : quoteForAmount.quote.canFill ? "Fully Fillable" : "Partial Fill Risk"}
                      </span>
                    </div>
                    <div className="grid gap-2 text-xs sm:grid-cols-2">
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger className="text-left text-muted-foreground">
                            CLOB: <span className="font-mono text-foreground">{quoteForAmount.quote.clobFill}</span>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="max-w-[220px]">
                            <p>Shares filled by limit orders from other traders. Often 0 in low-activity markets.</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger className="text-left text-muted-foreground">
                            AMM: <span className="font-mono text-foreground">{quoteForAmount.quote.ammFill}</span>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="max-w-[220px]">
                            <p>Shares filled by the automated market maker. Price adjusts with quantity (slippage).</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <div className="text-muted-foreground">
                        Est. Avg Price:{" "}
                        <span className="font-mono text-foreground">{(Number(quoteForAmount.quote.avgPrice) * 100).toFixed(2)}%</span>
                      </div>
                      <div className="text-muted-foreground">
                        Slippage:{" "}
                        <span className="font-mono text-foreground">{(Number(quoteForAmount.quote.slippage) * 100).toFixed(2)}%</span>
                      </div>
                    </div>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Avg. Price</span>
                  <span className="font-mono">{(effectivePrice * 100).toFixed(1)}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="font-mono">
                    {cost} {tokenSymbol}
                  </span>
                </div>
                <div className="flex justify-between">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger className="flex items-center gap-1 text-muted-foreground">
                        Fee ({orderType === "limit" ? "0%" : "1%"})
                        <Info className="h-3.5 w-3.5" weight="duotone" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>1% taker fee for market orders. 0% maker fee for resting limit orders. Crossing limits may incur taker fee.</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <span className="font-mono">
                    {takerFee} {tokenSymbol}
                  </span>
                </div>
                <Separator />
                <div className="flex justify-between font-semibold">
                  <span>{side === "sell" ? "You receive" : "Total"}</span>
                  <span className="font-mono">
                    {total} {tokenSymbol}
                  </span>
                </div>
                <div className="flex justify-between font-medium">
                  <span>{side === "sell" ? "Profit vs. $1 hold" : "Potential return"}</span>
                  <span className={cn("font-mono", potentialReturnPositive ? "text-yes" : "text-no")}>
                    {side === "sell"
                      ? `${Number(total) - parseFloat(amount || "0") >= 0 ? "+" : ""}${(Number(total) - parseFloat(amount || "0")).toFixed(2)}`
                      : `${potentialReturnPositive ? "+" : ""}${potentialReturn}`}{" "}
                    {tokenSymbol}
                  </span>
                </div>
              </div>
            )}

            {/* Submit */}
            <Button
              onClick={handleSubmit}
              disabled={submitDisabled}
              variant={side === "buy" ? (selectedOutcome === 0 ? "yes" : "no") : "destructive"}
              size="lg"
              className="w-full text-base font-mono tracking-wider"
            >
              {signing ? (
                <>
                  <Spinner className="mr-2 h-5 w-5 animate-spin" weight="bold" />
                  Sign in wallet...
                </>
              ) : submitOrder.isPending ? (
                <Spinner className="h-5 w-5 animate-spin" weight="bold" />
              ) : (
                submitLabel
              )}
            </Button>

            {submitOrder.isError && <p className="text-xs text-destructive">{submitOrder.error?.message ?? "Order failed"}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
});
