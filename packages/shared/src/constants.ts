// ---------------------------------------------------------------------------
// Fee & Protocol Constants
// ---------------------------------------------------------------------------

/** Taker fee in basis points (1% = 100 bps). */
export const TAKER_FEE_BPS = 100;

/** Maker fee in basis points (0%). */
export const MAKER_FEE_BPS = 0;

/** Bond amount required to create a market (20 USDC, 6 decimals). */
export const CREATION_BOND_AMOUNT = "20000000";

/** Volume threshold (in collateral) above which the creator bond is refunded (100 USDC, 6 decimals). */
export const VOLUME_REFUND_THRESHOLD = "100000000";

/** Dispute period duration in seconds (24 hours). */
export const DISPUTE_PERIOD = 86_400;

/** Time after resolution deadline before a market can be voided (14 days in seconds). */
export const VOID_TIMEOUT = 1_209_600;

/** Maximum number of outcomes a single market can have. */
export const MAX_OUTCOMES = 8;

/** Number of decimals used in fixed-point price representation. */
export const PRICE_DECIMALS = 18;

/** Number of decimals for USDC collateral. */
export const COLLATERAL_DECIMALS = 6;

// ---------------------------------------------------------------------------
// Supported Networks
// ---------------------------------------------------------------------------

export type SupportedNetwork = "sepolia" | "mainnet";

// ---------------------------------------------------------------------------
// Collateral Token types (registry lives in contracts.ts to share addresses)
// ---------------------------------------------------------------------------

export interface CollateralTokenInfo {
  symbol: string;
  name: string;
  decimals: number;
  /** Bond amount in raw token units required to create a market. */
  bondAmount: string;
  /** Volume threshold in raw token units for bond refund. */
  volumeThreshold: string;
  addresses: Record<SupportedNetwork, string>;
}

// ---------------------------------------------------------------------------
// Category Labels
// ---------------------------------------------------------------------------

export const CATEGORY_LABELS: Record<string, string> = {
  crypto: "Crypto",
  politics: "Politics",
  sports: "Sports",
  culture: "Culture",
  science: "Science",
} as const;

// ---------------------------------------------------------------------------
// AMM (LMSR) Configuration
// ---------------------------------------------------------------------------

/**
 * Default liquidity parameter for new AMM pools (human-readable units).
 * b = maximum loss the market maker can take per market.
 * For binary markets, max loss = b * ln(2) ≈ 0.693 * b.
 * With b=100 and USDC collateral: max AMM loss ≈ 69 USDC per market.
 */
export const DEFAULT_AMM_LIQUIDITY_B = 100;

/** Minimum price the AMM will quote. Below this the AMM refuses the trade. */
export const AMM_MIN_PRICE = 0.001;

/** Maximum price the AMM will quote. Above this the AMM refuses the trade. */
export const AMM_MAX_PRICE = 0.999;

// ---------------------------------------------------------------------------
// API Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
