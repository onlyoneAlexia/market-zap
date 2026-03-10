import { z } from "zod";
import type { Market } from "./market";
import type { Trade } from "./order";
import { MarketSchema } from "./market";
import { TradeSchema } from "./order";

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

export interface Position {
  /** Market this position is in. */
  marketId: string;
  /** Index of the outcome held. */
  outcomeIndex: number;
  /** Number of outcome tokens held (18-decimal fixed point string). */
  quantity: string;
  /** Volume-weighted average entry price (18-decimal fixed point string). */
  avgPrice: string;
  /** Current market price (18-decimal fixed point string). */
  currentPrice: string;
  /** Unrealised profit / loss (18-decimal fixed point string, may be negative). */
  unrealizedPnl: string;
  /** Snapshot of the market this position belongs to. */
  market: Market;
}

export const PositionSchema = z.object({
  marketId: z.string(),
  outcomeIndex: z.number().int().nonnegative(),
  quantity: z.string(),
  avgPrice: z.string(),
  currentPrice: z.string(),
  unrealizedPnl: z.string(),
  market: MarketSchema,
});

// ---------------------------------------------------------------------------
// Portfolio Summary
// ---------------------------------------------------------------------------

export interface PortfolioSummary {
  /** Total portfolio value in collateral units (18-decimal fixed point string). */
  totalValue: string;
  /** Total realised + unrealised PnL (18-decimal fixed point string). */
  totalPnl: string;
  /** Win rate as a decimal between 0 and 1 (e.g. 0.65 = 65%). */
  winRate: number;
  /** Number of open positions. */
  positionsCount: number;
  /** All open positions. */
  positions: Position[];
}

export const PortfolioSummarySchema = z.object({
  totalValue: z.string(),
  totalPnl: z.string(),
  winRate: z.number().min(0).max(1),
  positionsCount: z.number().int().nonnegative(),
  positions: z.array(PositionSchema),
});

// ---------------------------------------------------------------------------
// Trade History (paginated)
// ---------------------------------------------------------------------------

export interface TradeHistory {
  trades: Trade[];
  /** Total number of trades across all pages. */
  total: number;
  /** Current page (1-based). */
  page: number;
  /** Number of items per page. */
  pageSize: number;
  /** Whether more pages exist. */
  hasMore: boolean;
}

export const TradeHistorySchema = z.object({
  trades: z.array(TradeSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  hasMore: z.boolean(),
});

// ---------------------------------------------------------------------------
// Claimable Reward
// ---------------------------------------------------------------------------

export interface ClaimableReward {
  /** Market the reward originates from. */
  marketId: string;
  /** Winning outcome index. */
  outcomeIndex: number;
  /** Claimable amount in collateral units (18-decimal fixed point string). */
  amount: string;
  /** Snapshot of the resolved market. */
  market: Market;
}

export const ClaimableRewardSchema = z.object({
  marketId: z.string(),
  outcomeIndex: z.number().int().nonnegative(),
  amount: z.string(),
  market: MarketSchema,
});
