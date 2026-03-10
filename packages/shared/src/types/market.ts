import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const MarketCategory = {
  Crypto: "crypto",
  Politics: "politics",
  Sports: "sports",
  Culture: "culture",
  Science: "science",
} as const;

export type MarketCategory =
  (typeof MarketCategory)[keyof typeof MarketCategory];

export const MarketCategorySchema = z.enum([
  "crypto",
  "politics",
  "sports",
  "culture",
  "science",
]);

export const MarketType = {
  Public: "public",
  Private: "private",
} as const;

export type MarketType = (typeof MarketType)[keyof typeof MarketType];

export const MarketTypeSchema = z.enum(["public", "private"]);

export const MarketStatus = {
  Active: "active",
  Paused: "paused",
  Resolved: "resolved",
  Voided: "voided",
} as const;

export type MarketStatus = (typeof MarketStatus)[keyof typeof MarketStatus];

export const MarketStatusSchema = z.enum([
  "active",
  "paused",
  "resolved",
  "voided",
]);

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export interface Outcome {
  /** Index of this outcome within the market (0-based). */
  index: number;
  /** Human-readable label, e.g. "Yes" / "No". */
  label: string;
  /** Current probability expressed as a fixed-point string (18 decimals). */
  price: string;
  /** AMM-derived price (enriched on detail endpoint). */
  ammPrice?: string;
  /** Best bid price on the CLOB (enriched on detail endpoint). */
  bestBid?: string | null;
  /** Best ask price on the CLOB (enriched on detail endpoint). */
  bestAsk?: string | null;
  /** Bid-ask spread (enriched on detail endpoint). */
  spread?: string | null;
}

export const OutcomeSchema = z.object({
  index: z.number().int().nonnegative(),
  label: z.string().min(1),
  price: z.string(),
  ammPrice: z.string().optional(),
  bestBid: z.string().nullable().optional(),
  bestAsk: z.string().nullable().optional(),
  spread: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

export interface Market {
  /** Unique market identifier (typically a bytes32 hex string). */
  id: string;
  /** Numeric on-chain market ID, when the engine has linked the market on Starknet. */
  onChainMarketId?: string | null;
  /** Address of the market creator. */
  creator: string;
  /** The prediction question. */
  question: string;
  /** Human-readable description / context for the question. */
  description: string;
  /** Market category tag. */
  category: MarketCategory;
  /** Possible outcomes the market can resolve to. */
  outcomes: Outcome[];
  /** Address of the collateral ERC-20 token (e.g. USDC). */
  collateralToken: string;
  /** Condition ID used by the conditional-token framework. */
  conditionId: string;
  /** ISO-8601 timestamp of market creation. */
  createdAt: string;
  /** Unix timestamp (seconds) after which the market can be resolved. */
  resolutionTime: number;
  /** Current market status. */
  status: MarketStatus;
  /** Whether the market has been resolved. */
  resolved: boolean;
  /** Index of the winning outcome once resolved, or null. */
  resolvedOutcomeIndex: number | null;
  /** Whether the market was voided (everyone can redeem at cost). */
  voided: boolean;
  /** Cumulative trading volume in collateral units (string for precision). */
  totalVolume: string;
  /** Whether the creator's bond has been refunded. */
  bondRefunded: boolean;
  /** Market type: public (visible orderbook) or private (dark). */
  marketType: MarketType;
  /** Number of unique traders (enriched by the engine). */
  traders?: number;
}

export const MarketSchema = z.object({
  id: z.string(),
  onChainMarketId: z.string().nullable().optional(),
  creator: z.string(),
  question: z.string().min(1),
  description: z.string(),
  category: MarketCategorySchema,
  outcomes: z.array(OutcomeSchema).min(2),
  collateralToken: z.string(),
  conditionId: z.string(),
  createdAt: z.string().datetime(),
  resolutionTime: z.number().int().positive(),
  status: MarketStatusSchema,
  resolved: z.boolean(),
  resolvedOutcomeIndex: z.number().int().nonnegative().nullable(),
  voided: z.boolean(),
  totalVolume: z.string(),
  bondRefunded: z.boolean(),
  marketType: MarketTypeSchema.default("public"),
  traders: z.number().int().nonnegative().optional(),
});

// ---------------------------------------------------------------------------
// Market Stats
// ---------------------------------------------------------------------------

export interface PricePoint {
  timestamp: number;
  prices: string[];
  /** Aggregated trade volume for this bucket (collateral units). */
  volume?: string;
}

export const PricePointSchema = z.object({
  timestamp: z.number(),
  prices: z.array(z.string()),
  volume: z.string().optional(),
});

export interface MarketStats {
  /** 24-hour trading volume in collateral units. */
  volume24h: string;
  /** Number of trades in the last 24 hours. */
  trades24h: number;
  /** Current total liquidity in collateral units. */
  liquidity: string;
  /** Historical price snapshots. */
  priceHistory: PricePoint[];
}

export const MarketStatsSchema = z.object({
  volume24h: z.string(),
  trades24h: z.number().int().nonnegative(),
  liquidity: z.string(),
  priceHistory: z.array(PricePointSchema),
});

// ---------------------------------------------------------------------------
// Market With Stats
// ---------------------------------------------------------------------------

export type MarketWithStats = Market & MarketStats;

export const MarketWithStatsSchema = MarketSchema.merge(MarketStatsSchema);

// ---------------------------------------------------------------------------
// Create Market Input
// ---------------------------------------------------------------------------

export interface CreateMarketInput {
  question: string;
  description: string;
  category: MarketCategory;
  outcomes: string[];
  collateralToken: string;
  resolutionTime: number;
  marketType?: MarketType;
}

export const CreateMarketInputSchema = z.object({
  question: z.string().min(10, "Question must be at least 10 characters"),
  description: z.string().min(1),
  category: MarketCategorySchema,
  outcomes: z
    .array(z.string().min(1))
    .min(2, "At least 2 outcomes required")
    .max(8, "Maximum 8 outcomes allowed"),
  collateralToken: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid ERC-20 address"),
  resolutionTime: z
    .number()
    .int()
    .positive()
    .refine(
      (t) => t > Math.floor(Date.now() / 1000),
      "Resolution time must be in the future",
    ),
  marketType: MarketTypeSchema.optional().default("public"),
});
