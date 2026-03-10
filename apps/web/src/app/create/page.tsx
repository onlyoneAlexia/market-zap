"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner, Coins } from "@phosphor-icons/react";
import { ResolutionDatePicker } from "@/components/market/resolution-date-picker";
import { PageTransition } from "@/components/ui/page-transition";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@/features/wallet/use-wallet";
import { useWalletUSDCBalance, useInvalidateAndPoll } from "@/hooks/use-wallet-balance";
import { useToast } from "@/hooks/use-toast";
import { queryKeys } from "@/lib/query-client";
import {
  CONTRACT_ADDRESSES,
  COLLATERAL_TOKENS,
  shortenAddress,
  type CollateralTokenInfo,
} from "@market-zap/shared";

const CATEGORIES = ["crypto", "politics", "sports", "culture", "science"] as const;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function CreateMarketPage() {
  const { isConnected, openConnectModal, ensureConnected } = useWallet();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const invalidateAndPoll = useInvalidateAndPoll();
  const [question, setQuestion] = useState("");
  const [category, setCategory] = useState("");
  const [outcomes, setOutcomes] = useState(["Yes", "No"]);
  const [resolutionDate, setResolutionDate] = useState("");
  const [resolutionCriteria, setResolutionCriteria] = useState("");
  const [selectedToken, setSelectedToken] = useState<string>("USDC");
  const [showTokenSelector, setShowTokenSelector] = useState(false);
  const [marketType, setMarketType] = useState<"public" | "private">("public");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStep, setSubmitStep] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isMinting, setIsMinting] = useState(false);

  const tokenInfo = COLLATERAL_TOKENS[selectedToken] as CollateralTokenInfo;
  const bondTokenInfo = COLLATERAL_TOKENS.USDC as CollateralTokenInfo;
  const bondDivisor = 10 ** bondTokenInfo.decimals;
  const bondAmount = BigInt(bondTokenInfo.bondAmount);
  const bondDisplay = (Number(bondAmount) / bondDivisor).toString();
  const thresholdDisplay = (Number(bondTokenInfo.volumeThreshold) / bondDivisor).toString();

  const usdcAddress = CONTRACT_ADDRESSES.sepolia.USDC;
  const { data: walletBalanceRaw, isLoading: balanceLoading, error: balanceError, refetch: refetchBalance } = useWalletUSDCBalance(usdcAddress);
  const walletBalance = walletBalanceRaw != null ? BigInt(walletBalanceRaw) : undefined;
  const balanceLoaded = walletBalance !== undefined;
  const hasEnoughBalance = !balanceLoaded || walletBalance >= bondAmount;
  const balanceDisplay = balanceLoaded
    ? (Number(walletBalance) / bondDivisor).toFixed(2)
    : null;

  const handleMintUSDC = async () => {
    setIsMinting(true);
    try {
      const c = await ensureConnected();
      const mintAmount = bondAmount * 2n;
      const result = await c.mintTestUSDC(mintAmount);
      if (!result.success) throw new Error(result.error ?? "Mint failed");
      toast({
        title: `Minted ${Number(mintAmount) / bondDivisor} USDC`,
        description: `Test USDC sent to your wallet. Tx: ${shortenAddress(result.txHash)}`,
        variant: "success",
      });
      await invalidateAndPoll();
      await refetchBalance();
    } catch (err) {
      toast({
        title: "Mint failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setIsMinting(false);
    }
  };

  const updateOutcome = (index: number, value: string) => {
    const updated = [...outcomes];
    updated[index] = value;
    setOutcomes(updated);
  };

  const questionTooShort = question.length > 0 && question.length < 10;
  const emptyOutcomes = outcomes.some((o) => o.length === 0);
  const duplicateOutcomes = !emptyOutcomes && new Set(outcomes.map((o) => o.trim().toLowerCase())).size < outcomes.length;
  const resolutionInPast = resolutionDate ? new Date(resolutionDate).getTime() <= Date.now() : false;
  const resolutionTooSoon = resolutionDate && !resolutionInPast
    ? new Date(resolutionDate).getTime() - Date.now() < 300_000
    : false;
  const isValid =
    question.length >= 10 &&
    category &&
    !emptyOutcomes &&
    !duplicateOutcomes &&
    resolutionDate &&
    !resolutionInPast &&
    !resolutionTooSoon;

  const handleSubmit = async () => {
    if (!isConnected) {
      openConnectModal();
      return;
    }
    setIsSubmitting(true);
    setError(null);

    try {
      setSubmitStep("Sign in wallet...");
      const client = await ensureConnected();
      const collateralAddress = tokenInfo.addresses.sepolia;
      const resolutionTimestamp = Math.floor(new Date(resolutionDate).getTime() / 1000);

      const createPromise = client.approveAndCreateMarket(
        usdcAddress,
        bondAmount,
        {
          question,
          category,
          outcomes,
          collateralToken: collateralAddress,
          resolutionTime: resolutionTimestamp,
          marketType,
        },
      );
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Wallet interaction timed out. Please try again.")), 120_000),
      );
      const createResult = await Promise.race([createPromise, timeoutPromise]);

      if (!createResult.success) {
        throw new Error(createResult.error ?? "Market creation failed");
      }

      setSubmitStep("Verifying and seeding market...");
      const seedResp = await fetch("/api/seed-market", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          createTxHash: createResult.txHash,
          ...(createResult.marketId !== undefined
            ? {
                marketId: createResult.marketId.toString(),
                onChainMarketId: createResult.marketId.toString(),
              }
            : {}),
          ...(createResult.conditionId
            ? { conditionId: createResult.conditionId }
            : {}),
          title: question,
          description: resolutionCriteria || "",
          category,
          outcomeCount: outcomes.length,
          outcomeLabels: outcomes,
          collateralToken: collateralAddress,
          resolutionSource: resolutionCriteria || "",
          resolutionTime: new Date(resolutionDate).toISOString(),
          marketType,
        }),
      });
      if (!seedResp.ok) {
        const body = await seedResp.text().catch(() => "");
        throw new Error(`Failed to seed market in engine (${seedResp.status}): ${body}`);
      }

      const seedData = await seedResp.json().catch(() => ({}));
      if (seedData?.data?.ammReady === false) {
        setError(
          "Market created, but initial liquidity setup failed. " +
          "The market will appear on the markets page once an admin provides liquidity. " +
          "This is usually a transient issue — try creating the market again if it persists."
        );
        await queryClient.invalidateQueries({ queryKey: queryKeys.markets.all });
        return;
      }

      await queryClient.invalidateQueries({ queryKey: queryKeys.markets.all });
      router.push("/markets");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create market");
    } finally {
      setIsSubmitting(false);
      setSubmitStep("");
    }
  };

  return (
    <PageTransition>
    <div className="container mx-auto max-w-2xl px-2 py-4 sm:px-4">
      {/* Terminal panel */}
      <div className="bg-card/50 border border-border rounded overflow-hidden backdrop-blur-xl terminal-glow">
        {/* Header bar */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <div className="flex items-center gap-2 font-mono text-xs">
            <span className="text-primary font-bold">Create</span>
            <span className="text-muted-foreground">New Market</span>
          </div>
          <span className="text-[10px] font-mono text-cyan">Bond: {bondDisplay} USDC</span>
        </div>

        <div className="p-4 space-y-4">
          {/* Question — terminal input with > prefix */}
          <div>
            <label className="block text-[10px] font-mono font-bold text-muted-foreground tracking-wider mb-1">Question</label>
            <div className={`flex items-center bg-background border rounded px-3 py-2.5 ${questionTooShort ? "border-no/50" : "border-border"}`}>
              <span className="text-primary font-mono text-sm mr-2 font-bold">&gt;</span>
              <input
                type="text"
                placeholder="Enter market question..."
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                className="bg-transparent text-sm font-mono w-full focus:outline-none text-cyan placeholder:text-muted-foreground"
              />
            </div>
            {questionTooShort && (
              <p className="text-[10px] font-mono text-no mt-1">Min 10 characters ({question.length}/10)</p>
            )}
          </div>

          {/* Category — terminal pills */}
          <div>
            <label className="block text-[10px] font-mono font-bold text-muted-foreground tracking-wider mb-1">Category</label>
            <div className="flex gap-1">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setCategory(cat)}
                  className={`px-3 py-1.5 text-[11px] font-mono font-bold rounded border transition-colors tracking-wider ${
                    category === cat
                      ? "bg-primary/15 text-primary border-primary/30"
                      : "text-muted-foreground border-border hover:text-cyan hover:border-cyan/30"
                  }`}
                >
                  {capitalize(cat)}
                </button>
              ))}
            </div>
          </div>

          {/* Outcomes — 2-col grid with A:/B: prefixes */}
          <div>
            <label className="block text-[10px] font-mono font-bold text-muted-foreground tracking-wider mb-1">Outcomes</label>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex items-center bg-background border border-yes/20 rounded px-3 py-2">
                <span className="text-yes font-mono text-xs mr-2 font-bold">A:</span>
                <input
                  value={outcomes[0]}
                  onChange={(e) => updateOutcome(0, e.target.value)}
                  className="bg-transparent text-sm font-mono w-full focus:outline-none text-yes"
                />
              </div>
              <div className="flex items-center bg-background border border-no/20 rounded px-3 py-2">
                <span className="text-no font-mono text-xs mr-2 font-bold">B:</span>
                <input
                  value={outcomes[1]}
                  onChange={(e) => updateOutcome(1, e.target.value)}
                  className="bg-transparent text-sm font-mono w-full focus:outline-none text-no"
                />
              </div>
            </div>
            {emptyOutcomes && (
              <p className="text-[10px] font-mono text-no mt-1">All outcomes required</p>
            )}
            {duplicateOutcomes && (
              <p className="text-[10px] font-mono text-no mt-1">Outcomes must be unique</p>
            )}
          </div>

          {/* Expiry + Type — same row */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] font-mono font-bold text-muted-foreground tracking-wider mb-1">Expiry</label>
              <ResolutionDatePicker
                value={resolutionDate}
                onChange={setResolutionDate}
                hasError={resolutionInPast || !!resolutionTooSoon}
              />
              {resolutionInPast && (
                <p className="text-[10px] font-mono text-no mt-1">Must be in the future</p>
              )}
              {resolutionTooSoon && (
                <p className="text-[10px] font-mono text-no mt-1">Min 5 minutes from now</p>
              )}
            </div>
            <div>
              <label className="block text-[10px] font-mono font-bold text-muted-foreground tracking-wider mb-1">Type</label>
              <div className="grid grid-cols-2 gap-1">
                <button
                  type="button"
                  onClick={() => setMarketType("public")}
                  className={`py-2.5 text-[11px] font-mono font-bold rounded border transition-colors tracking-wider ${
                    marketType === "public"
                      ? "bg-cyan/15 text-cyan border-cyan/30"
                      : "text-muted-foreground border-border hover:text-foreground"
                  }`}
                >
                  Public
                </button>
                <button
                  type="button"
                  onClick={() => setMarketType("private")}
                  className={`py-2.5 text-[11px] font-mono font-bold rounded border transition-colors tracking-wider ${
                    marketType === "private"
                      ? "bg-amber/15 text-amber border-amber/30"
                      : "text-muted-foreground border-border hover:text-foreground"
                  }`}
                >
                  Dark
                </button>
              </div>
            </div>
          </div>

          {/* Resolution criteria — optional */}
          <div>
            <label className="block text-[10px] font-mono font-bold text-muted-foreground tracking-wider mb-1">
              Resolution criteria (optional)
            </label>
            <div className="flex items-start bg-background border border-border rounded px-3 py-2">
              <span className="text-primary font-mono text-sm mr-2 font-bold mt-0.5">&gt;</span>
              <textarea
                placeholder="Describe how this market will be resolved..."
                value={resolutionCriteria}
                onChange={(e) => setResolutionCriteria(e.target.value)}
                className="bg-transparent text-xs font-mono w-full min-h-[60px] focus:outline-none text-cyan placeholder:text-muted-foreground resize-none"
              />
            </div>
          </div>

          {/* Collateral token */}
          <div>
            <label className="block text-[10px] font-mono font-bold text-muted-foreground tracking-wider mb-1">Collateral</label>
            <div className="flex items-center gap-2">
              <span className="rounded border border-primary/20 bg-primary/5 px-3 py-1.5 text-xs font-mono font-bold tracking-wider text-primary">
                {tokenInfo.symbol}
              </span>
              <button
                type="button"
                onClick={() => setShowTokenSelector(!showTokenSelector)}
                className="text-[10px] font-mono tracking-wider text-cyan hover:text-cyan/80 transition-colors"
              >
                {showTokenSelector ? "[ Hide ]" : "[ Change ]"}
              </button>
            </div>
            {showTokenSelector && (
              <div className="flex gap-1 mt-1">
                {Object.entries(COLLATERAL_TOKENS).map(([key, info]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setSelectedToken(key);
                      setShowTokenSelector(false);
                    }}
                    className={`rounded border px-3 py-1.5 text-[11px] font-mono font-bold tracking-wider transition-colors ${
                      selectedToken === key
                        ? "border-primary/30 bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground hover:border-primary/20"
                    }`}
                  >
                    {(info as CollateralTokenInfo).symbol}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Bond info — terminal key-value pairs */}
          <div className="bg-background border border-primary/20 rounded p-3 font-mono text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-primary">Bond required:</span>
              <span className="text-foreground font-bold">{bondDisplay} USDC</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Refund threshold:</span>
              <span className="text-muted-foreground">${thresholdDisplay} volume</span>
            </div>
            {isConnected && (
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Wallet balance:</span>
                <div className="flex items-center gap-2">
                  <span className={`font-bold ${balanceLoaded && !hasEnoughBalance ? "text-no" : "text-yes"}`}>
                    {balanceLoading ? "..." : balanceError ? "Error" : balanceDisplay ?? "—"} USDC
                  </span>
                  {balanceLoaded && !hasEnoughBalance && (
                    <button
                      onClick={handleMintUSDC}
                      disabled={isMinting}
                      className="text-[10px] text-cyan hover:text-cyan/80 transition-colors"
                    >
                      {isMinting ? (
                        <Spinner className="h-3 w-3 animate-spin" weight="bold" />
                      ) : (
                        <span className="flex items-center gap-1">
                          <Coins className="h-3 w-3" weight="duotone" />
                          Mint
                        </span>
                      )}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Validation errors */}
          {!isValid && (question || category || resolutionDate) && (
            <div className="space-y-0.5 text-[10px] font-mono text-no tracking-wider">
              {question.length > 0 && question.length < 10 && <p>Question must be at least 10 characters</p>}
              {!category && <p>Select a category</p>}
              {!resolutionDate && <p>Set an expiry date</p>}
            </div>
          )}

          {error && (
            <p className="text-[10px] font-mono text-no">{error}</p>
          )}

          {/* Submit — terminal execute */}
          <Button
            onClick={handleSubmit}
            disabled={!isValid || isSubmitting || (isConnected && balanceLoaded && !hasEnoughBalance)}
            size="lg"
            className="w-full font-mono tracking-wider text-sm"
          >
            {isSubmitting ? (
              <Spinner className="mr-2 h-4 w-4 animate-spin" weight="bold" />
            ) : null}
            {!isConnected
              ? "Connect Wallet"
              : balanceLoaded && !hasEnoughBalance
                ? "Insufficient USDC"
                : isSubmitting
                  ? (submitStep || "Executing...")
                  : `Create Market [${bondDisplay} USDC Bond]`}
          </Button>
        </div>
      </div>
    </div>
    </PageTransition>
  );
}
