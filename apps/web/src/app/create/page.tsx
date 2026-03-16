"use client";

import { useState, useRef, useCallback, useId, type FormEvent } from "react";
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
import { CONTRACT_ADDRESSES, COLLATERAL_TOKENS, shortenAddress, type CollateralTokenInfo } from "@market-zap/shared";
import { PrivacyOverlay, useScanlineEffect } from "@/components/ui/dark-forest-overlay";

const CATEGORIES = ["crypto", "politics", "sports", "culture", "science"] as const;

const OUTCOME_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
const OUTCOME_COLORS = [
  { border: "border-yes/20", text: "text-yes" },
  { border: "border-no/20", text: "text-no" },
  { border: "border-amber-400/20", text: "text-amber-400" },
  { border: "border-blue-400/20", text: "text-blue-400" },
  { border: "border-purple-400/20", text: "text-purple-400" },
  { border: "border-pink-400/20", text: "text-pink-400" },
  { border: "border-teal-400/20", text: "text-teal-400" },
  { border: "border-orange-400/20", text: "text-orange-400" },
] as const;
const MIN_QUESTION_LENGTH = 10;
const MIN_RESOLUTION_LEAD_MS = 300_000;
const WALLET_TIMEOUT_MS = 120_000;
const MANUAL_MARKET_SEEDING_ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_MANUAL_MARKET_SEEDING === "true" ||
  process.env.NODE_ENV !== "production";

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function hasInvalidThumbnailUrl(url: string): boolean {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    return !["http:", "https:"].includes(parsed.protocol);
  } catch {
    return true;
  }
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
  const [thumbnailUrl, setThumbnailUrl] = useState("");
  const [thumbnailPreviewFailed, setThumbnailPreviewFailed] = useState(false);
  const [outcomesTouched, setOutcomesTouched] = useState(false);
  const fireScanline = useScanlineEffect();
  const transitioningRef = useRef(false);
  const questionInputId = useId();
  const questionErrorId = useId();
  const thumbnailInputId = useId();
  const thumbnailErrorId = useId();
  const expiryDateButtonId = useId();
  const expiryTimeInputId = useId();
  const resolutionCriteriaInputId = useId();
  const typeSummaryId = useId();
  const validationErrorsId = useId();
  const formErrorId = useId();

  const handleTypeSwitch = useCallback(
    (type: "public" | "private") => {
      if ((type === marketType) || transitioningRef.current) return;
      transitioningRef.current = true;
      setMarketType(type);
      fireScanline(type === "private" ? "dark" : "clean");
      setTimeout(() => { transitioningRef.current = false; }, 1200);
    },
    [marketType, fireScanline],
  );

  const tokenInfo = COLLATERAL_TOKENS[selectedToken] as CollateralTokenInfo;
  const bondTokenInfo = COLLATERAL_TOKENS.USDC as CollateralTokenInfo;
  const bondDivisor = 10 ** bondTokenInfo.decimals;
  const bondAmount = BigInt(bondTokenInfo.bondAmount);
  const bondDisplay = (Number(bondAmount) / bondDivisor).toString();
  const thresholdDisplay = (Number(bondTokenInfo.volumeThreshold) / bondDivisor).toString();

  const usdcAddress = CONTRACT_ADDRESSES.sepolia.USDC;
  const {
    data: walletBalanceRaw,
    isLoading: balanceLoading,
    error: balanceError,
    refetch: refetchBalance,
  } = useWalletUSDCBalance(usdcAddress);
  const walletBalance = walletBalanceRaw != null ? BigInt(walletBalanceRaw) : undefined;
  const balanceLoaded = walletBalance !== undefined;
  const hasEnoughBalance = !balanceLoaded || walletBalance >= bondAmount;
  const balanceDisplay = balanceLoaded ? (Number(walletBalance) / bondDivisor).toFixed(2) : null;
  const normalizedQuestion = question.trim();
  const normalizedCriteria = resolutionCriteria.trim();
  const normalizedOutcomes = outcomes.map((outcome) => outcome.trim());
  const thumbnailError = hasInvalidThumbnailUrl(thumbnailUrl) || thumbnailPreviewFailed;
  const nowMs = Date.now();
  const resolutionTimeMs = resolutionDate ? Date.parse(resolutionDate) : null;
  const hasResolutionTime = resolutionTimeMs !== null && Number.isFinite(resolutionTimeMs);

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
    setOutcomesTouched(true);
    setOutcomes((current) => current.map((outcome, outcomeIndex) => (outcomeIndex === index ? value : outcome)));
  };

  const addOutcome = () => {
    setOutcomes((current) => (current.length < OUTCOME_LABELS.length ? [...current, ""] : current));
  };

  const removeOutcome = (index: number) => {
    setOutcomes((current) => (current.length > 2 ? current.filter((_, outcomeIndex) => outcomeIndex !== index) : current));
  };

  const questionTooShort = question.length > 0 && normalizedQuestion.length < MIN_QUESTION_LENGTH;
  const emptyOutcomes = normalizedOutcomes.some((outcome) => outcome.length === 0);
  const duplicateOutcomes =
    !emptyOutcomes && new Set(normalizedOutcomes.map((outcome) => outcome.toLowerCase())).size < normalizedOutcomes.length;
  const resolutionInPast = hasResolutionTime && resolutionTimeMs <= nowMs;
  const resolutionTooSoon = hasResolutionTime && !resolutionInPast && resolutionTimeMs - nowMs < MIN_RESOLUTION_LEAD_MS;
  const isValid =
    normalizedQuestion.length >= MIN_QUESTION_LENGTH &&
    category &&
    !emptyOutcomes &&
    !duplicateOutcomes &&
    hasResolutionTime &&
    !resolutionInPast &&
    !resolutionTooSoon &&
    !thumbnailError;
  const validationErrors = [
    questionTooShort ? "Question must be at least 10 characters" : null,
    !category ? "Select a category" : null,
    !resolutionDate ? "Set an expiry date" : !hasResolutionTime ? "Set a valid expiry date" : null,
  ].filter((message): message is string => Boolean(message));
  const showValidationErrors = !isValid && (question || category || resolutionDate);
  const submitDisabled = !isValid || isSubmitting || (isConnected && balanceLoading) || (isConnected && balanceLoaded && !hasEnoughBalance);
  const submitLabel = !isConnected
    ? "Connect Wallet"
    : balanceLoading
      ? "Checking balance..."
      : balanceLoaded && !hasEnoughBalance
        ? "Insufficient USDC"
        : isSubmitting
          ? submitStep || "Executing..."
          : `Create Market [${bondDisplay} USDC Bond]`;
  const typeSummary = marketType === "private"
    ? "Dark markets stay hidden from browse and search. After creation, you will land on the market page with a direct tester link."
    : "Public markets appear in browse and search right away, so testers can discover them from the Markets page.";
  const submitDescribedBy = [
    showValidationErrors ? validationErrorsId : null,
    error ? formErrorId : null,
  ].filter((value): value is string => Boolean(value)).join(" ") || undefined;

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void handleSubmit();
  };

  const handleSubmit = async () => {
    if (!isConnected) {
      openConnectModal();
      return;
    }
    setIsSubmitting(true);
    setError(null);

    try {
      const parsedResolutionTimeMs = resolutionTimeMs;
      if (parsedResolutionTimeMs === null || !Number.isFinite(parsedResolutionTimeMs)) {
        throw new Error("Set a valid expiry date");
      }

      setSubmitStep("Refreshing balance...");
      const latestBalanceResult = await refetchBalance();
      const latestBalance = latestBalanceResult.data != null
        ? BigInt(latestBalanceResult.data)
        : walletBalance;
      if (latestBalance !== undefined && latestBalance < bondAmount) {
        const have = (Number(latestBalance) / bondDivisor).toFixed(2);
        throw new Error(`Insufficient USDC balance: you have ${have} but need ${bondDisplay}`);
      }

      setSubmitStep("Sign in wallet...");
      const client = await ensureConnected();
      const collateralAddress = tokenInfo.addresses.sepolia;
      const resolutionTimestamp = Math.floor(parsedResolutionTimeMs / 1000);

      const createPromise = client.approveAndCreateMarket(usdcAddress, bondAmount, {
        question: normalizedQuestion,
        category,
        outcomes: normalizedOutcomes,
        collateralToken: collateralAddress,
        resolutionTime: resolutionTimestamp,
        marketType,
      });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Wallet interaction timed out. Please try again.")), WALLET_TIMEOUT_MS),
      );
      const createResult = await Promise.race([createPromise, timeoutPromise]);

      if (!createResult.success) {
        throw new Error(createResult.error ?? "Market creation failed");
      }

      const createdMarketId = createResult.marketId?.toString();
      const shareQuery = marketType === "private" ? "&share=1" : "";

      if (MANUAL_MARKET_SEEDING_ENABLED) {
        setSubmitStep("Preparing market...");
        const seedPayload = {
          createTxHash: createResult.txHash,
          ...(createResult.marketId !== undefined
            ? {
                marketId: createResult.marketId.toString(),
                onChainMarketId: createResult.marketId.toString(),
              }
            : {}),
          ...(createResult.conditionId ? { conditionId: createResult.conditionId } : {}),
          title: normalizedQuestion,
          description: normalizedCriteria,
          category,
          outcomeCount: normalizedOutcomes.length,
          outcomeLabels: normalizedOutcomes,
          collateralToken: collateralAddress,
          resolutionSource: normalizedCriteria,
          resolutionTime: new Date(parsedResolutionTimeMs).toISOString(),
          marketType,
          ...(thumbnailUrl && !thumbnailError ? { thumbnailUrl } : {}),
        };
        const seedResp = await fetch("/api/seed-market", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(seedPayload),
        });
        if (!seedResp.ok) {
          const body = await seedResp.text().catch(() => "");
          throw new Error(`Failed to seed market in engine (${seedResp.status}): ${body}`);
        }
      } else {
        setSubmitStep("Waiting for indexer...");
      }

      await queryClient.invalidateQueries({ queryKey: queryKeys.markets.all });
      const targetPath = createdMarketId
        ? `/markets/${createdMarketId}?created=1${shareQuery}${MANUAL_MARKET_SEEDING_ENABLED ? "" : "&indexing=1"}`
        : "/markets";
      toast({
        title: marketType === "private" ? "Private market created" : "Market created",
        description: MANUAL_MARKET_SEEDING_ENABLED
          ? "Your market has been submitted and is awaiting admin approval before it appears in the marketplace."
          : "On-chain create succeeded. The market page will refresh automatically once the indexer catches up.",
        variant: "success",
      });
      router.push(targetPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create market");
    } finally {
      setIsSubmitting(false);
      setSubmitStep("");
    }
  };

  const isDark = marketType === "private";

  // Theme helpers — cold blue-gray when dark, normal otherwise
  const t = {
    panel: isDark
      ? "bg-[rgba(10,15,25,0.88)] border-[rgba(70,90,115,0.2)] shadow-[0_0_60px_rgba(30,45,65,0.08)]"
      : "bg-card/50 border-border",
    headerBorder: isDark ? "border-[rgba(70,90,115,0.15)]" : "border-border",
    accent: isDark ? "text-slate-400" : "text-primary",
    accentMuted: isDark ? "text-slate-400/40" : "text-muted-foreground",
    badge: isDark ? "text-slate-400" : "text-cyan",
    inputBg: isDark ? "bg-[rgba(5,10,18,0.5)] border-[rgba(70,90,115,0.15)]" : "bg-background border-border",
    inputText: isDark ? "text-slate-400/80 placeholder:text-slate-500/30" : "text-cyan placeholder:text-muted-foreground",
    label: isDark ? "text-slate-400/50" : "text-muted-foreground",
    pillActive: isDark
      ? "bg-[rgba(70,90,115,0.15)] text-slate-400 border-slate-400/30"
      : "bg-primary/15 text-primary border-primary/30",
    pillInactive: isDark
      ? "text-slate-500/50 border-[rgba(70,90,115,0.15)] hover:text-slate-400 hover:border-slate-400/30"
      : "text-muted-foreground border-border hover:text-cyan hover:border-cyan/30",
    link: isDark ? "text-slate-400/70 hover:text-slate-400/50" : "text-cyan hover:text-cyan/80",
    collateralBadge: isDark
      ? "border-slate-400/20 bg-slate-400/5 text-slate-400"
      : "border-primary/20 bg-primary/5 text-primary",
    bondBox: isDark ? "bg-[rgba(5,10,18,0.5)] border-[rgba(70,90,115,0.2)]" : "bg-background border-primary/20",
    bondLabel: isDark ? "text-slate-400" : "text-primary",
    tokenActive: isDark
      ? "border-slate-400/30 bg-slate-400/10 text-slate-400"
      : "border-primary/30 bg-primary/10 text-primary",
    tokenInactive: isDark
      ? "border-[rgba(70,90,115,0.15)] text-slate-500/50 hover:text-slate-400 hover:border-slate-400/20"
      : "border-border text-muted-foreground hover:text-foreground hover:border-primary/20",
    mintLink: isDark ? "text-slate-400/70 hover:text-slate-400/50" : "text-cyan hover:text-cyan/80",
    removeBtnBorder: isDark ? "border-[rgba(70,90,115,0.15)]" : "border-border",
    submitBtn: isDark
      ? "bg-slate-400/10 border-slate-400/30 text-slate-400 hover:bg-slate-400/15"
      : "",
  };

  // Outcome colors shift to muted slate tones in dark-forest mode
  const DARK_OUTCOME_COLORS = [
    { border: "border-slate-400/15", text: "text-slate-400" },
    { border: "border-slate-500/15", text: "text-slate-500" },
    { border: "border-slate-400/15", text: "text-slate-400" },
    { border: "border-slate-500/15", text: "text-slate-500" },
    { border: "border-slate-400/15", text: "text-slate-400" },
    { border: "border-slate-500/15", text: "text-slate-500" },
    { border: "border-slate-400/15", text: "text-slate-400" },
    { border: "border-slate-500/15", text: "text-slate-500" },
  ] as const;

  return (
    <PageTransition>
      <div className="container mx-auto max-w-2xl px-2 py-4 sm:px-4 relative">
        {/* Terminal panel */}
        <div className={`relative border rounded backdrop-blur-xl terminal-glow transition-all duration-1000 ${t.panel}`}>
          {/* Privacy overlay — clipped to card bounds */}
          <div className="absolute inset-0 overflow-hidden rounded pointer-events-none z-0">
            <PrivacyOverlay active={isDark} />
          </div>
          {/* Header bar */}
          <div className={`relative z-[1] flex items-center justify-between px-3 py-2 border-b transition-colors duration-1000 ${t.headerBorder}`}>
            <div className="flex items-center gap-2 font-mono text-xs">
              <span className={`font-bold transition-colors duration-1000 ${t.accent}`}>Create</span>
              <span className={`transition-colors duration-1000 ${t.accentMuted}`}>New Market</span>
            </div>
            <span className={`text-[10px] font-mono transition-colors duration-1000 ${t.badge}`}>Bond: {bondDisplay} USDC</span>
          </div>

          <form className="relative z-[1] p-4 space-y-4" onSubmit={handleFormSubmit}>
            <div className={`rounded border px-3 py-2 text-[10px] font-mono leading-relaxed transition-all duration-1000 ${t.bondBox}`}>
              <span className={`font-bold tracking-wider ${t.bondLabel}`}>Sepolia beta.</span>{" "}
              <span className={`${t.accentMuted}`}>
                Use test funds only. Public markets require admin approval before appearing in the marketplace. Dark markets are active immediately and shared by direct link.
              </span>
            </div>

            {/* Question */}
            <div>
              <label
                htmlFor={questionInputId}
                className={`block text-[10px] font-mono font-bold tracking-wider mb-1 transition-colors duration-1000 ${t.label}`}
              >
                Question
              </label>
              <div
                className={`flex items-center border rounded px-3 py-2.5 transition-all duration-1000 ${questionTooShort ? "border-no/50" : ""} ${t.inputBg}`}
              >
                <span className={`font-mono text-sm mr-2 font-bold transition-colors duration-1000 ${t.accent}`}>&gt;</span>
                <input
                  id={questionInputId}
                  type="text"
                  placeholder="Enter market question..."
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  aria-invalid={questionTooShort}
                  aria-describedby={questionTooShort ? questionErrorId : undefined}
                  className={`bg-transparent text-sm font-mono w-full focus:outline-none transition-colors duration-1000 ${t.inputText}`}
                />
              </div>
              {questionTooShort && (
                <p id={questionErrorId} className="text-[10px] font-mono text-no mt-1">
                  Min {MIN_QUESTION_LENGTH} characters ({normalizedQuestion.length}/{MIN_QUESTION_LENGTH})
                </p>
              )}
            </div>

            {/* Thumbnail URL */}
            <div>
              <label
                htmlFor={thumbnailInputId}
                className={`block text-[10px] font-mono font-bold tracking-wider mb-1 transition-colors duration-1000 ${t.label}`}
              >
                Thumbnail URL (optional)
              </label>
              <div
                className={`flex items-center border rounded px-3 py-2.5 transition-all duration-1000 ${thumbnailError ? "border-no/50" : ""} ${t.inputBg}`}
              >
                <span className={`font-mono text-sm mr-2 font-bold transition-colors duration-1000 ${t.accent}`}>&gt;</span>
                <input
                  id={thumbnailInputId}
                  type="url"
                  placeholder="https://example.com/image.png"
                  value={thumbnailUrl}
                  onChange={(e) => {
                    setThumbnailUrl(e.target.value);
                    setThumbnailPreviewFailed(false);
                  }}
                  aria-invalid={thumbnailError}
                  aria-describedby={thumbnailError ? thumbnailErrorId : undefined}
                  className={`bg-transparent text-sm font-mono w-full focus:outline-none transition-colors duration-1000 ${t.inputText}`}
                />
              </div>
              {thumbnailError && (
                <p id={thumbnailErrorId} className="text-[10px] font-mono text-no mt-1">
                  Must be a valid http(s) URL
                </p>
              )}
              {thumbnailUrl && !thumbnailError && (
                <div className={`mt-2 rounded border overflow-hidden transition-all duration-1000 ${t.inputBg}`}>
                  <img
                    src={thumbnailUrl}
                    alt="Preview"
                    className="h-24 w-full object-cover"
                    onError={() => setThumbnailPreviewFailed(true)}
                  />
                </div>
              )}
            </div>

            {/* Category */}
            <fieldset>
              <legend className={`block text-[10px] font-mono font-bold tracking-wider mb-1 transition-colors duration-1000 ${t.label}`}>Category</legend>
              <div className="flex flex-wrap gap-1">
                {CATEGORIES.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setCategory(cat)}
                    aria-pressed={category === cat}
                    className={`px-3 py-1.5 text-[11px] font-mono font-bold rounded border transition-all duration-500 tracking-wider ${
                      category === cat ? t.pillActive : t.pillInactive
                    }`}
                  >
                    {capitalize(cat)}
                  </button>
                ))}
              </div>
            </fieldset>

            {/* Outcomes */}
            <fieldset>
              <legend className={`block text-[10px] font-mono font-bold tracking-wider mb-1 transition-colors duration-1000 ${t.label}`}>
                Outcomes ({outcomes.length}/{OUTCOME_LABELS.length})
              </legend>
              <div className="space-y-2">
                {outcomes.map((outcome, i) => {
                  const color = isDark
                    ? (DARK_OUTCOME_COLORS[i] ?? DARK_OUTCOME_COLORS[0])
                    : (OUTCOME_COLORS[i] ?? OUTCOME_COLORS[0]);
                  return (
                    <div key={i} className="flex items-center gap-2">
                      <div className={`flex-1 flex items-center border rounded px-3 py-2 transition-all duration-1000 ${color.border} ${isDark ? "bg-[rgba(5,10,18,0.5)]" : "bg-background"}`}>
                        <span className={`font-mono text-xs mr-2 font-bold transition-colors duration-1000 ${color.text}`}>{OUTCOME_LABELS[i]}:</span>
                        <input
                          value={outcome}
                          onChange={(e) => updateOutcome(i, e.target.value)}
                          placeholder={i === 0 ? "Yes" : i === 1 ? "No" : `Outcome ${OUTCOME_LABELS[i]}`}
                          aria-label={`Outcome ${OUTCOME_LABELS[i]}`}
                          className={`bg-transparent text-sm font-mono w-full focus:outline-none transition-colors duration-1000 ${color.text}`}
                        />
                      </div>
                      {outcomes.length > 2 && (
                        <button
                          type="button"
                          onClick={() => removeOutcome(i)}
                          className={`text-muted-foreground hover:text-no transition-colors text-xs font-mono px-1.5 py-1 rounded border hover:border-no/30 ${t.removeBtnBorder}`}
                        >
                          x
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              {outcomes.length < OUTCOME_LABELS.length && (
                <button
                  type="button"
                  onClick={addOutcome}
                  className={`mt-2 text-[10px] font-mono tracking-wider transition-colors duration-1000 ${t.link}`}
                >
                  + Add outcome
                </button>
              )}
              {outcomesTouched && emptyOutcomes && <p className="text-[10px] font-mono text-no mt-1">All outcomes required</p>}
              {duplicateOutcomes && <p className="text-[10px] font-mono text-no mt-1">Outcomes must be unique</p>}
            </fieldset>

            {/* Expiry + Type */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <fieldset>
                <legend className={`block text-[10px] font-mono font-bold tracking-wider mb-1 transition-colors duration-1000 ${t.label}`}>Expiry</legend>
                <ResolutionDatePicker
                  value={resolutionDate}
                  onChange={setResolutionDate}
                  hasError={resolutionInPast || !!resolutionTooSoon}
                  dateButtonId={expiryDateButtonId}
                  timeInputId={expiryTimeInputId}
                  privacyMode={isDark}
                />
                {resolutionInPast && <p className="text-[10px] font-mono text-no mt-1">Must be in the future</p>}
                {resolutionTooSoon && <p className="text-[10px] font-mono text-no mt-1">Min 5 minutes from now</p>}
              </fieldset>
              <fieldset>
                <legend className={`block text-[10px] font-mono font-bold tracking-wider mb-1 transition-colors duration-1000 ${t.label}`}>Type</legend>
                <div className="grid grid-cols-2 gap-1">
                  <button
                    type="button"
                    onClick={() => handleTypeSwitch("public")}
                    aria-pressed={marketType === "public"}
                    aria-describedby={typeSummaryId}
                    className={`group relative py-2.5 text-[11px] font-mono font-bold rounded border transition-all duration-500 tracking-wider ${
                      marketType === "public"
                        ? isDark ? "bg-slate-400/10 text-slate-400 border-slate-400/25" : "bg-cyan/15 text-cyan border-cyan/30"
                        : isDark ? "text-slate-500/50 border-[rgba(70,90,115,0.15)] hover:text-slate-400" : "text-muted-foreground border-border hover:text-foreground"
                    }`}
                  >
                    Public
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2.5 px-3 py-2 rounded-lg border border-border bg-popover/95 backdrop-blur-xl text-[9px] leading-relaxed whitespace-nowrap pointer-events-none opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-200 z-50">
                      <div className="flex items-center gap-2 py-0.5"><span className={`w-1 h-1 rounded-full shrink-0 ${isDark ? "bg-slate-400" : "bg-cyan"}`} />Visible on marketplace &amp; search</div>
                      <div className="flex items-center gap-2 py-0.5"><span className={`w-1 h-1 rounded-full shrink-0 ${isDark ? "bg-slate-400" : "bg-cyan"}`} />Open order book for all traders</div>
                      <div className="flex items-center gap-2 py-0.5"><span className={`w-1 h-1 rounded-full shrink-0 ${isDark ? "bg-slate-400" : "bg-cyan"}`} />Eligible for volume rewards</div>
                      <div className="absolute top-full left-1/2 -translate-x-1/2 border-[5px] border-transparent border-t-popover/95" />
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleTypeSwitch("private")}
                    aria-pressed={marketType === "private"}
                    aria-describedby={typeSummaryId}
                    className={`group relative py-2.5 text-[11px] font-mono font-bold rounded border transition-all duration-500 tracking-wider ${
                      marketType === "private"
                        ? isDark ? "bg-[rgba(120,90,60,0.12)] text-[#d4a055] border-[rgba(212,160,85,0.3)] shadow-[0_0_15px_rgba(120,90,60,0.08)]" : "bg-amber/15 text-amber border-amber/30"
                        : isDark ? "text-slate-500/50 border-[rgba(70,90,115,0.15)] hover:text-slate-400" : "text-muted-foreground border-border hover:text-foreground"
                    }`}
                  >
                    Dark
                    <div className="absolute bottom-full right-0 mb-2.5 px-3 py-2 rounded-lg border border-border bg-popover/95 backdrop-blur-xl text-[9px] leading-relaxed whitespace-nowrap pointer-events-none opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-200 z-50">
                      <div className="flex items-center gap-2 py-0.5"><span className={`w-1 h-1 rounded-full shrink-0 ${isDark ? "bg-[#d4a055]" : "bg-amber"}`} />Hidden from browse &amp; search</div>
                      <div className="flex items-center gap-2 py-0.5"><span className={`w-1 h-1 rounded-full shrink-0 ${isDark ? "bg-[#d4a055]" : "bg-amber"}`} />Accessible via direct link only</div>
                      <div className="flex items-center gap-2 py-0.5"><span className={`w-1 h-1 rounded-full shrink-0 ${isDark ? "bg-[#d4a055]" : "bg-amber"}`} />Private order book for participants</div>
                      <div className="absolute top-full right-4 border-[5px] border-transparent border-t-popover/95" />
                    </div>
                  </button>
                </div>
                <p
                  id={typeSummaryId}
                  className={`mt-2 text-[10px] font-mono leading-relaxed transition-colors duration-1000 ${t.accentMuted}`}
                >
                  {typeSummary}
                </p>
              </fieldset>
            </div>

            {/* Resolution criteria */}
            <div>
              <label
                htmlFor={resolutionCriteriaInputId}
                className={`block text-[10px] font-mono font-bold tracking-wider mb-1 transition-colors duration-1000 ${t.label}`}
              >
                Resolution criteria (optional)
              </label>
              <div className={`flex items-start border rounded px-3 py-2 transition-all duration-1000 ${t.inputBg}`}>
                <span className={`font-mono text-sm mr-2 font-bold mt-0.5 transition-colors duration-1000 ${t.accent}`}>&gt;</span>
                <textarea
                  id={resolutionCriteriaInputId}
                  placeholder="Describe how this market will be resolved..."
                  value={resolutionCriteria}
                  onChange={(e) => setResolutionCriteria(e.target.value)}
                  className={`bg-transparent text-xs font-mono w-full min-h-[60px] focus:outline-none resize-none transition-colors duration-1000 ${t.inputText}`}
                />
              </div>
            </div>

            {/* Collateral token */}
            <div>
              <label className={`block text-[10px] font-mono font-bold tracking-wider mb-1 transition-colors duration-1000 ${t.label}`}>Collateral</label>
              <div className="flex items-center gap-2">
                <span className={`rounded border px-3 py-1.5 text-xs font-mono font-bold tracking-wider transition-all duration-1000 ${t.collateralBadge}`}>
                  {tokenInfo.symbol}
                </span>
                <button
                  type="button"
                  onClick={() => setShowTokenSelector(!showTokenSelector)}
                  className={`text-[10px] font-mono tracking-wider transition-colors duration-1000 ${t.link}`}
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
                      className={`rounded border px-3 py-1.5 text-[11px] font-mono font-bold tracking-wider transition-all duration-500 ${
                        selectedToken === key ? t.tokenActive : t.tokenInactive
                      }`}
                    >
                      {(info as CollateralTokenInfo).symbol}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Bond info */}
            <div className={`border rounded p-3 font-mono text-xs space-y-1 transition-all duration-1000 ${t.bondBox}`}>
              <div className="flex justify-between">
                <span className={`transition-colors duration-1000 ${t.bondLabel}`}>Bond required:</span>
                <span className="text-foreground font-bold">{bondDisplay} USDC</span>
              </div>
              <div className="flex justify-between">
                <span className={`transition-colors duration-1000 ${t.accentMuted}`}>Refund threshold:</span>
                <span className={`transition-colors duration-1000 ${t.accentMuted}`}>${thresholdDisplay} volume</span>
              </div>
              {isConnected && (
                <div className="flex justify-between items-center">
                  <span className={`transition-colors duration-1000 ${t.accentMuted}`}>Wallet balance:</span>
                  <div className="flex items-center gap-2">
                    <span className={`font-bold ${balanceError ? "text-muted-foreground" : balanceLoaded && !hasEnoughBalance ? "text-no" : "text-yes"}`}>
                      {balanceLoading ? "..." : balanceError ? "—" : balanceDisplay ?? "—"} USDC
                    </span>
                    {balanceLoaded && !hasEnoughBalance && (
                      <button
                        type="button"
                        onClick={handleMintUSDC}
                        disabled={isMinting}
                        className={`text-[10px] transition-colors duration-1000 ${t.mintLink}`}
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
            {showValidationErrors && (
              <div
                id={validationErrorsId}
                role="alert"
                aria-live="polite"
                className="space-y-0.5 text-[10px] font-mono text-no tracking-wider"
              >
                {validationErrors.map((validationError) => (
                  <p key={validationError}>{validationError}</p>
                ))}
              </div>
            )}

            {error && (
              <p id={formErrorId} role="alert" className="text-[10px] font-mono text-no">
                {error}
              </p>
            )}

            {/* Submit */}
            <Button
              type="submit"
              disabled={submitDisabled}
              aria-describedby={submitDescribedBy}
              size="lg"
              className={`w-full font-mono tracking-wider text-sm transition-all duration-1000 ${t.submitBtn}`}
            >
              {isSubmitting ? <Spinner className="mr-2 h-4 w-4 animate-spin" weight="bold" /> : null}
              {submitLabel}
            </Button>
          </form>
        </div>
      </div>
    </PageTransition>
  );
}
