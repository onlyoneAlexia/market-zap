import { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { Contract, type RpcProvider } from "starknet";
import type { Database } from "../db/postgres.js";

const ISRC6_ABI = [
  {
    name: "is_valid_signature",
    type: "function",
    inputs: [
      { name: "hash", type: "core::felt252" },
      { name: "signature", type: "core::array::Array::<core::felt252>" },
    ],
    outputs: [{ type: "core::felt252" }],
    state_mutability: "view",
  },
] as const;

const SNIP6_VALID = BigInt("0x56414c4944");

export async function verifyOrderSignature(
  provider: RpcProvider,
  traderAddress: string,
  orderHash: string,
  signatureStr: string,
): Promise<boolean> {
  const parts = signatureStr.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  if (parts.length === 2 && (parts[0] === "0" || parts[0] === "0x0")) return false;

  try {
    const account = new Contract({
      abi: ISRC6_ABI as unknown as Contract["abi"],
      address: traderAddress,
      providerOrAccount: provider,
    });
    const result = await account.call("is_valid_signature", [orderHash, parts]);
    const felt = typeof result === "bigint" ? result : BigInt(String(result));
    return felt === SNIP6_VALID;
  } catch (error) {
    console.warn(
      `[rest] signature verification RPC failed for ${traderAddress}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

export function sanitizeSettlementError(raw: string): string {
  const lower = raw.toLowerCase();

  if (lower.includes("erc1155") && lower.includes("insufficient")) {
    return "On-chain outcome-token inventory is insufficient for this fill. The order book has been restored.";
  }
  if (lower.includes("balance") || lower.includes("insufficient") || lower.includes("underflow")) {
    return "Insufficient on-chain balance to complete this trade. The order book has been restored.";
  }
  if (lower.includes("invalid_sig") || lower.includes("signature")) {
    return "On-chain signature verification failed. Please try signing the order again.";
  }
  if (lower.includes("nonce") || lower.includes("already_used") || lower.includes("already used")) {
    return "This order nonce has already been used on-chain. Please place a new order.";
  }
  if (lower.includes("expired") || lower.includes("expiry")) {
    return "The order expired before settlement could complete. Please place a new order.";
  }
  if (lower.includes("estimatefee") || lower.includes("estimate_fee") || lower.includes("starknet_estimatefee")) {
    return "On-chain transaction simulation failed — likely insufficient liquidity or balance. Your order has been rolled back.";
  }
  if (raw.startsWith("TX reverted:")) {
    const reason = raw.slice("TX reverted:".length).trim();
    return reason.length < 100
      ? `Settlement reverted: ${reason}`
      : "On-chain settlement reverted. Your order has been rolled back.";
  }
  if (lower.includes("rpc") || lower.includes("request") || raw.length > 200) {
    return "On-chain settlement failed. Your balance has been released and the order book restored.";
  }

  return raw;
}

export async function isDarkMarket(
  db: Database,
  marketId: string,
): Promise<boolean> {
  try {
    const market = await db.getMarketById(marketId);
    return market?.market_type === "private";
  } catch {
    return false;
  }
}

export function normalizeHex(input: string): string {
  const stripped = input.replace(/^0x/i, "").replace(/^0+/, "");
  return (stripped.length > 0 ? `0x${stripped}` : "0x0").toLowerCase();
}

export function decodeU256(low: string, high: string): bigint {
  return (BigInt(high) << 128n) + BigInt(low);
}

export function shortAddress(address: string): string {
  return address === "0x0" ? address : `${address.slice(0, 10)}...${address.slice(-6)}`;
}

export function mapPriceHistoryPoint(point: {
  timestamp: Date | string;
  prices: string[];
  volume?: string | null;
}) {
  return {
    timestamp: Math.floor(new Date(point.timestamp).getTime() / 1000),
    prices: point.prices,
    volume: point.volume ?? undefined,
  };
}

export const SubmitOrderSchema = z.object({
  marketId: z.string().min(1),
  outcomeIndex: z.number().int().min(0),
  side: z.enum(["BID", "ASK"]),
  orderType: z.enum(["LIMIT", "MARKET"]),
  price: z.string().regex(/^\d+(\.\d+)?$/, "Price must be a decimal string"),
  amount: z.string().regex(/^\d+$/, "Amount must be an integer string"),
  user: z.string().min(1),
  nonce: z.string().min(1).regex(/^\d+$/, "Nonce must be a numeric string"),
  expiry: z.number().int().min(0).default(0),
  signature: z.string().min(1),
});

export const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const MarketListSchema = PaginationSchema.extend({
  category: z.string().optional(),
  status: z.string().optional(),
  marketType: z.enum(["public", "private"]).optional(),
  sortBy: z.enum(["volume", "createdAt", "resolutionTime"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  search: z.string().max(200).optional(),
});

export const PriceHistorySchema = z.object({
  interval: z.enum(["5m", "15m", "1h", "6h", "1d"]).default("1h"),
  limit: z.coerce.number().int().min(1).max(1000).default(168),
});

export const WalletTelemetrySchema = z.object({
  event: z.enum([
    "modal_opened",
    "provider_selected",
    "connect_started",
    "connect_succeeded",
    "connect_failed",
    "connect_retry",
    "session_authorization_started",
    "session_authorization_succeeded",
    "session_authorization_failed",
  ]),
  provider: z.enum(["argentX", "braavos", "cartridge"]).optional(),
  phase: z
    .enum([
      "idle",
      "preparing",
      "opening_wallet",
      "waiting_for_approval",
      "authorizing_session",
      "retrying",
      "connected",
      "error",
    ])
    .optional(),
  durationMs: z.number().finite().min(0).max(300_000).optional(),
  errorCode: z.string().max(64).optional(),
  errorMessage: z.string().max(200).optional(),
  isSlow: z.boolean().optional(),
  path: z.string().max(120).optional(),
  source: z.literal("web").optional(),
  emittedAt: z.string().max(64).optional(),
  deviceClass: z.enum(["mobile", "desktop"]).optional(),
});

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

export function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ success: true, data });
}

export function formatTrade(row: any) {
  const collateralDecimals = 6;
  const divisor = 10 ** collateralDecimals;
  const rawAmount = parseFloat(row.amount ?? "0");
  const rawFee = parseFloat(row.fee ?? "0");

  return {
    id: row.id,
    marketId: row.market_id,
    maker: row.seller ?? "",
    taker: row.buyer ?? "",
    outcomeIndex: row.outcome_index ?? 0,
    price: row.price ?? "0",
    amount: (rawAmount / divisor).toFixed(2),
    fee: (rawFee / divisor).toFixed(2),
    txHash: row.tx_hash ?? null,
    settled: Boolean(row.settled ?? false),
    settlementStatus: row.settlement_status ?? "pending",
    settlementError: row.settlement_error ?? null,
    timestamp: row.created_at
      ? new Date(row.created_at).toISOString()
      : new Date().toISOString(),
  };
}

export function formatMarket(row: any) {
  const labels: string[] = row.outcome_labels ?? [];
  const count: number = row.outcome_count ?? labels.length ?? 2;
  const outcomes = Array.from({ length: count }, (_, index) => ({
    index,
    label: labels[index] ?? `Outcome ${index}`,
    price: (1 / count).toFixed(4),
  }));

  return {
    id: row.id ?? row.market_id,
    creator: row.creator ?? "0x0",
    question: row.title ?? row.question ?? "",
    description: row.description ?? "",
    category: row.category ?? "crypto",
    outcomes,
    collateralToken: row.collateral_token ?? "",
    conditionId: row.condition_id ?? "",
    onChainMarketId: row.on_chain_market_id ?? null,
    createdAt: row.created_at ?? new Date().toISOString(),
    resolutionTime: row.resolution_time
      ? Math.floor(new Date(row.resolution_time).getTime() / 1000)
      : 0,
    status: (row.status ?? "active").toLowerCase(),
    resolved: row.status === "RESOLVED",
    resolvedOutcomeIndex: row.winning_outcome ?? null,
    voided: row.status === "VOIDED",
    totalVolume: row.total_volume ?? "0",
    bondRefunded: false,
    marketType: row.market_type ?? "public",
    thumbnailUrl: row.thumbnail_url ?? null,
  };
}

export function paginated<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
) {
  return {
    items,
    total,
    page,
    pageSize,
    hasMore: page * pageSize + items.length < total,
  };
}

export function scalePriceStr(price: string): bigint {
  if (/^\d+$/.test(price)) {
    return BigInt(price);
  }
  const [intPart, fracPart = ""] = price.split(".");
  const padded = fracPart.padEnd(18, "0").slice(0, 18);
  return BigInt(intPart + padded);
}

export function computeBidReservation(
  remainingAmount: bigint,
  price: string,
): bigint {
  const cost = (remainingAmount * scalePriceStr(price)) / BigInt(1e18);
  const fee = (cost * 100n) / 10000n;
  return cost + fee;
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authResult = authorizeAdminRequest(req);
  if (!authResult.ok) {
    res.status(authResult.status).json({ error: authResult.error });
    return;
  }

  next();
}

export function authorizeAdminRequest(
  req: Request,
): { ok: true } | { ok: false; status: number; error: string } {
  const apiKey = process.env.ENGINE_API_KEY?.trim();
  if (apiKey) {
    const header = req.headers.authorization;
    if (header === `Bearer ${apiKey}`) {
      return { ok: true };
    }

    return { ok: false, status: 401, error: "Unauthorized" };
  }

  if (process.env.NODE_ENV !== "production") {
    return { ok: true };
  }

  return {
    ok: false,
    status: 503,
    error: "Admin API authentication is not configured",
  };
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: err.flatten() });
    return;
  }

  const message = err instanceof Error ? err.message : "Internal server error";
  console.error("[rest] unhandled error:", err);
  res.status(500).json({ error: message });
}
