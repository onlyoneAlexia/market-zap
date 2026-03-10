import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const OrderSide = {
  Buy: "buy",
  Sell: "sell",
} as const;

export type OrderSide = (typeof OrderSide)[keyof typeof OrderSide];

export const OrderSideSchema = z.enum(["buy", "sell"]);

export const OrderType = {
  Market: "market",
  Limit: "limit",
} as const;

export type OrderType = (typeof OrderType)[keyof typeof OrderType];

export const OrderTypeSchema = z.enum(["market", "limit"]);

export const TimeInForce = {
  /** Good 'Til Cancelled -- order stays on the book until explicitly cancelled. */
  GTC: "GTC",
  /** Immediate Or Cancel -- fill what you can, cancel the rest. */
  IOC: "IOC",
  /** Fill Or Kill -- fill the entire order or cancel it entirely. */
  FOK: "FOK",
} as const;

export type TimeInForce = (typeof TimeInForce)[keyof typeof TimeInForce];

export const TimeInForceSchema = z.enum(["GTC", "IOC", "FOK"]);

export const OrderStatus = {
  Open: "open",
  Partial: "partial",
  Filled: "filled",
  Cancelled: "cancelled",
  Expired: "expired",
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const OrderStatusSchema = z.enum([
  "open",
  "partial",
  "filled",
  "cancelled",
  "expired",
]);

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

export interface Order {
  /** Unique order identifier. */
  id: string;
  /** Market this order belongs to. */
  marketId: string;
  /** Buy or sell. */
  side: OrderSide;
  /** Market or limit order. */
  type: OrderType;
  /** Index of the outcome being traded. */
  outcomeIndex: number;
  /** Limit price as a string for arbitrary precision (18-decimal fixed point). */
  price: string;
  /** Order amount in outcome tokens (18-decimal fixed point string). */
  amount: string;
  /** Amount already filled (18-decimal fixed point string). */
  filledAmount: string;
  /** Address of the order maker. */
  maker: string;
  /** Unique nonce to prevent replay (stringified bigint). */
  nonce: string;
  /** Unix timestamp (seconds) after which the order expires. Must be > current block timestamp. */
  expiry: number;
  /** Poseidon-hash signature verified via ISRC6 account abstraction (r,s format). */
  signature: string;
  /** Time-in-force policy. */
  timeInForce: TimeInForce;
  /** Current status of the order. */
  status: OrderStatus;
  /** ISO-8601 timestamp of order creation. */
  createdAt: string;
  /** ISO-8601 timestamp of last update. */
  updatedAt: string;
}

export const OrderSchema = z.object({
  id: z.string(),
  marketId: z.string(),
  side: OrderSideSchema,
  type: OrderTypeSchema,
  outcomeIndex: z.number().int().nonnegative(),
  price: z.string(),
  amount: z.string(),
  filledAmount: z.string(),
  maker: z.string(),
  nonce: z.string(),
  expiry: z.number().int().nonnegative(),
  signature: z.string(),
  timeInForce: TimeInForceSchema,
  status: OrderStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// ---------------------------------------------------------------------------
// Submit Order Input
// ---------------------------------------------------------------------------

export interface SubmitOrderInput {
  marketId: string;
  side: OrderSide;
  type: OrderType;
  outcomeIndex: number;
  price: string;
  amount: string;
  maker: string;
  nonce: string;
  expiry: number;
  signature: string;
  timeInForce: TimeInForce;
}

export const SubmitOrderInputSchema = z.object({
  marketId: z.string().min(1),
  side: OrderSideSchema,
  type: OrderTypeSchema,
  outcomeIndex: z.number().int().nonnegative(),
  price: z.string().regex(/^\d+(\.\d+)?$/, "Price must be a numeric or decimal string"),
  amount: z.string().regex(/^\d+$/, "Amount must be a numeric string"),
  maker: z.string().regex(/^0x[a-fA-F0-9]{1,64}$/, "Invalid maker address"),
  nonce: z.string(),
  expiry: z.number().int().nonnegative(),
  signature: z
    .string()
    .regex(
      /^(0xdev|0x0,0x0|0,0|0x[a-fA-F0-9]+(\\s*,\\s*0x[a-fA-F0-9]+)?)$/,
      "Invalid signature format (expected r,s or 0xdev)",
    ),
  timeInForce: TimeInForceSchema,
});

// ---------------------------------------------------------------------------
// Trade
// ---------------------------------------------------------------------------

export interface Trade {
  /** Unique trade identifier. */
  id: string;
  /** Market the trade occurred in. */
  marketId: string;
  /** Address of the maker. */
  maker: string;
  /** Address of the taker. */
  taker: string;
  /** Index of the outcome traded. */
  outcomeIndex: number;
  /** Execution price (18-decimal fixed point string). */
  price: string;
  /** Quantity traded (18-decimal fixed point string). */
  amount: string;
  /** Fee charged (18-decimal fixed point string). */
  fee: string;
  /** On-chain transaction hash, or null if off-chain settlement. */
  txHash: string | null;
  /** Whether on-chain settlement has been confirmed. */
  settled: boolean;
  /** Settlement lifecycle status: "pending" | "settled" | "failed". */
  settlementStatus?: "pending" | "settled" | "failed";
  /** Error message if settlement failed, null otherwise. */
  settlementError?: string | null;
  /** ISO-8601 timestamp of the trade. */
  timestamp: string;
}

export const TradeSchema = z.object({
  id: z.string(),
  marketId: z.string(),
  maker: z.string(),
  taker: z.string(),
  outcomeIndex: z.number().int().nonnegative(),
  price: z.string(),
  amount: z.string(),
  fee: z.string(),
  txHash: z.string().nullable(),
  settled: z.boolean().optional().default(false),
  timestamp: z.string().datetime(),
});
