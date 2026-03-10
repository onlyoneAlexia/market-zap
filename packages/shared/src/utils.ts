import { PRICE_DECIMALS, COLLATERAL_DECIMALS } from "./constants";

// ---------------------------------------------------------------------------
// Fixed-point helpers
// ---------------------------------------------------------------------------

const TEN = 10n;

/**
 * Convert a human-readable decimal string or number to a fixed-point bigint.
 *
 * @example
 * toFixedPoint("1.5")       // 1_500_000_000_000_000_000n  (18 decimals)
 * toFixedPoint("20", 6)     // 20_000_000n                 (6 decimals)
 */
export function toFixedPoint(
  value: string | number,
  decimals: number = PRICE_DECIMALS,
): bigint {
  const str = typeof value === "number" ? value.toString() : value;
  const [whole = "0", fraction = ""] = str.split(".");

  if (fraction.length > decimals) {
    throw new RangeError(
      `Value "${str}" exceeds maximum precision of ${decimals} decimals`,
    );
  }

  const paddedFraction = fraction.padEnd(decimals, "0");
  return BigInt(whole) * TEN ** BigInt(decimals) + BigInt(paddedFraction);
}

/**
 * Convert a fixed-point bigint back to a human-readable decimal string.
 *
 * @example
 * fromFixedPoint(1_500_000_000_000_000_000n)  // "1.5"
 * fromFixedPoint(20_000_000n, 6)              // "20.0"
 */
export function fromFixedPoint(
  value: bigint,
  decimals: number = PRICE_DECIMALS,
): string {
  const isNegative = value < 0n;
  const abs = isNegative ? -value : value;
  const divisor = TEN ** BigInt(decimals);
  const whole = abs / divisor;
  const remainder = abs % divisor;

  const fractionStr = remainder.toString().padStart(decimals, "0");
  // Trim trailing zeros but keep at least one decimal place
  const trimmed = fractionStr.replace(/0+$/, "") || "0";
  const result = `${whole}.${trimmed}`;

  return isNegative ? `-${result}` : result;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a probability / price value for display.
 * Accepts either a bigint (18-decimal fixed point) or a numeric string.
 *
 * @returns A percentage string like "65.3%" or a decimal like "0.653".
 */
export function formatPrice(
  price: bigint | string,
  decimals: number = PRICE_DECIMALS,
): string {
  const value = typeof price === "string" ? BigInt(price) : price;
  const numeric = fromFixedPoint(value, decimals);
  const asNumber = Number(numeric);

  // Display as percentage when price is between 0 and 1 (probability)
  if (asNumber >= 0 && asNumber <= 1) {
    return `${(asNumber * 100).toFixed(1)}%`;
  }

  return numeric;
}

/**
 * Format a USD amount for display.
 * Accepts either a bigint or a numeric string in the collateral token's decimals.
 *
 * @returns A string like "$1,234.56".
 */
export function formatUsd(
  amount: bigint | string,
  decimals: number = COLLATERAL_DECIMALS,
): string {
  const value = typeof amount === "string" ? BigInt(amount) : amount;
  const numeric = Number(fromFixedPoint(value, decimals));

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
}

// ---------------------------------------------------------------------------
// Address helpers
// ---------------------------------------------------------------------------

/**
 * Shorten an Ethereum address for display.
 *
 * @example
 * shortenAddress("0x1234567890abcdef1234567890abcdef12345678")
 * // "0x1234...5678"
 */
export function shortenAddress(address: string, chars: number = 4): string {
  if (!address.startsWith("0x")) {
    throw new Error(`Invalid address: expected "0x" prefix, got "${address}"`);
  }
  if (address.length < chars * 2 + 2) {
    return address;
  }
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

// ---------------------------------------------------------------------------
// PnL calculation
// ---------------------------------------------------------------------------

export interface PnlResult {
  /** Absolute PnL in the same unit as the prices (18-decimal fixed point string). */
  absolute: string;
  /** PnL as a percentage (e.g. "12.5" means +12.5%). */
  percentage: string;
}

/**
 * Calculate profit-and-loss for a position.
 *
 * All inputs are 18-decimal fixed point strings.
 */
export function calculatePnl(
  avgPrice: string,
  currentPrice: string,
  quantity: string,
): PnlResult {
  const avg = BigInt(avgPrice);
  const cur = BigInt(currentPrice);
  const qty = BigInt(quantity);

  const priceDiff = cur - avg;
  const absolutePnl = (priceDiff * qty) / TEN ** BigInt(PRICE_DECIMALS);

  // Percentage = ((current - avg) / avg) * 100
  let percentageBps: bigint;
  if (avg === 0n) {
    percentageBps = 0n;
  } else {
    // Multiply by 10000 first for basis-point precision, then convert to percent
    percentageBps = (priceDiff * 10000n) / avg;
  }

  const percentageNum = Number(percentageBps) / 100;

  return {
    absolute: absolutePnl.toString(),
    percentage: percentageNum.toFixed(2),
  };
}

// ---------------------------------------------------------------------------
// Nonce generation
// ---------------------------------------------------------------------------

/**
 * Generate a random nonce suitable for order signing.
 * Returns a bigint derived from 32 random bytes.
 */
export function generateNonce(): bigint {
  // Works in both Node.js and browser environments
  const bytes = new Uint8Array(32);

  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Fallback: not cryptographically secure, but functional in test envs
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte);
  }

  return result;
}
