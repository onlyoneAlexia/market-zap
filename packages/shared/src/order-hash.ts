/**
 * Order hash computation matching the on-chain CLOBExchange.hash_order.
 *
 * Uses SNIP-12 revision 1 (Poseidon-based) typed data hashing:
 *   message_hash = Poseidon("StarkNet Message", domain_hash, account, struct_hash)
 *
 * This matches the format that browser wallets (Braavos, ArgentX) use when
 * signing typed data via account.signMessage().
 */

import { hash, typedData, constants, ec } from "starknet";
import type { BigNumberish, TypedData } from "starknet";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Mask for low 128 bits of a u256. */
const MASK_128 = (1n << 128n) - 1n;

// ---------------------------------------------------------------------------
// SNIP-12 TypedData Types
// ---------------------------------------------------------------------------

/** SNIP-12 type definitions for the Order struct. */
const ORDER_TYPED_DATA_TYPES: TypedData["types"] = {
  StarknetDomain: [
    { name: "name", type: "shortstring" },
    { name: "version", type: "shortstring" },
    { name: "chainId", type: "shortstring" },
    { name: "revision", type: "shortstring" },
  ],
  Order: [
    { name: "trader", type: "ContractAddress" },
    { name: "market_id", type: "u128" },
    { name: "token_id", type: "u256" },
    { name: "is_buy", type: "bool" },
    { name: "price", type: "u256" },
    { name: "amount", type: "u256" },
    { name: "nonce", type: "u256" },
    { name: "expiry", type: "u128" },
  ],
  u256: [
    { name: "low", type: "u128" },
    { name: "high", type: "u128" },
  ],
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrderHashParams {
  trader: string;
  marketId: bigint | number | string;
  tokenId: bigint;
  isBuy: boolean;
  price: bigint;
  amount: bigint;
  nonce: bigint;
  expiry: bigint | number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split a u256 value into (low, high) 128-bit limbs matching Cairo's
 *   low  = value & 0xffffffffffffffffffffffffffffffff
 *   high = value / 0x100000000000000000000000000000000
 */
function splitU256(value: bigint): { low: string; high: string } {
  return {
    low: (value & MASK_128).toString(),
    high: (value >> 128n).toString(),
  };
}

// ---------------------------------------------------------------------------
// SNIP-12 TypedData Builder
// ---------------------------------------------------------------------------

/**
 * Build a SNIP-12 TypedData object for an Order.
 *
 * This is the format expected by browser wallets for typed data signing:
 *   const sig = await account.signMessage(typedData)
 *
 * @param order - Order parameters
 * @param chainId - Starknet chain ID (defaults to SN_SEPOLIA)
 * @returns A TypedData object ready for wallet signing
 */
export function buildOrderTypedData(
  order: OrderHashParams,
  chainId: string = constants.StarknetChainId.SN_SEPOLIA,
): TypedData {
  return {
    types: ORDER_TYPED_DATA_TYPES,
    primaryType: "Order",
    domain: {
      name: "MarketZap",
      version: "1",
      chainId,
      revision: "1",
    },
    message: {
      trader: order.trader,
      market_id: BigInt(order.marketId).toString(),
      token_id: splitU256(order.tokenId),
      is_buy: order.isBuy,
      price: splitU256(order.price),
      amount: splitU256(order.amount),
      nonce: splitU256(order.nonce),
      expiry: BigInt(order.expiry).toString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Order Hash
// ---------------------------------------------------------------------------

/**
 * Compute the SNIP-12 message hash of an order matching CLOBExchange.hash_order.
 *
 * Uses starknet.js typedData.getMessageHash() which produces:
 *   Poseidon("StarkNet Message", domain_hash, account, struct_hash)
 *
 * @param order - Order parameters
 * @param exchangeAddress - CLOBExchange contract address (unused, kept for API compat)
 * @param chainId - Starknet chain ID (defaults to SN_SEPOLIA)
 * @returns The order hash as a hex string
 */
export function computeOrderHash(
  order: OrderHashParams,
  exchangeAddress: string,
  chainId: string = constants.StarknetChainId.SN_SEPOLIA,
): string {
  const td = buildOrderTypedData(order, chainId);
  return typedData.getMessageHash(td, order.trader);
}

/**
 * Sign an order hash with a Stark private key.
 * Returns {r, s} as hex strings suitable for the engine API.
 */
export function signOrderHash(
  orderHash: string,
  privateKey: string,
): { r: string; s: string } {
  const sig = ec.starkCurve.sign(
    orderHash,
    privateKey,
  );
  return {
    r: `0x${sig.r.toString(16)}`,
    s: `0x${sig.s.toString(16)}`,
  };
}

/**
 * Format signature for the engine API: "r,s" format.
 */
export function formatSignature(sig: { r: string; s: string }): string {
  return `${sig.r},${sig.s}`;
}

// ---------------------------------------------------------------------------
// Token ID & Condition ID
// ---------------------------------------------------------------------------

/**
 * Compute the token_id for a (condition_id, outcome_index) pair.
 * Matches ConditionalTokens.compute_token_id:
 *   token_id = Poseidon(condition_id, outcome_index) as u256
 */
export function computeTokenId(
  conditionId: string | BigNumberish,
  outcomeIndex: number,
): bigint {
  const hashHex = hash.computePoseidonHashOnElements([
    conditionId,
    outcomeIndex,
  ]);
  return BigInt(hashHex);
}

/**
 * Compute condition_id matching ConditionalTokens.prepare_condition:
 *   condition_id = Poseidon(caller, question_id, outcome_count)
 *
 * Note: `caller` is the MarketFactory contract address
 * (since it calls prepare_condition).
 */
export function computeConditionId(
  marketFactoryAddress: string,
  questionHash: string,
  outcomeCount: number,
): string {
  return hash.computePoseidonHashOnElements([
    marketFactoryAddress,
    questionHash,
    outcomeCount,
  ]);
}

/**
 * Compute the question hash matching MarketFactory's serialization.
 *
 * Cairo ByteArray Serde format:
 *   [num_full_31byte_words, word0, word1, ..., pending_word, pending_byte_count]
 *
 * Then: question_hash = Poseidon(serialized_elements...)
 */
export function computeQuestionHash(question: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(question);

  const BYTES_PER_WORD = 31;
  const numFullWords = Math.floor(bytes.length / BYTES_PER_WORD);
  const pendingLen = bytes.length % BYTES_PER_WORD;

  const elements: BigNumberish[] = [numFullWords];

  // Full 31-byte words (big-endian packed into felt252)
  for (let i = 0; i < numFullWords; i++) {
    const start = i * BYTES_PER_WORD;
    const chunk = bytes.slice(start, start + BYTES_PER_WORD);
    let value = 0n;
    for (const byte of chunk) {
      value = (value << 8n) | BigInt(byte);
    }
    elements.push(value);
  }

  // Pending word (remaining bytes, big-endian)
  const pendingStart = numFullWords * BYTES_PER_WORD;
  const pendingBytes = bytes.slice(pendingStart);
  let pendingValue = 0n;
  for (const byte of pendingBytes) {
    pendingValue = (pendingValue << 8n) | BigInt(byte);
  }
  elements.push(pendingValue);
  elements.push(pendingLen);

  return hash.computePoseidonHashOnElements(elements);
}

/**
 * Compute the trade commitment hash for dark market settlement audit trail.
 *
 * Matches the engine's computation:
 *   trade_commitment = Poseidon('MZ_DARK_TRADE', maker_order_hash, taker_order_hash, fill_amount)
 */
export function computeTradeCommitment(
  makerOrderHash: string,
  takerOrderHash: string,
  fillAmount: bigint,
): string {
  // Encode "MZ_DARK_TRADE" as a felt252 shortstring (same as Cairo shortstring)
  const domainSeparator = "0x" + Array.from(new TextEncoder().encode("MZ_DARK_TRADE"))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  return hash.computePoseidonHashOnElements([
    domainSeparator,
    makerOrderHash,
    takerOrderHash,
    fillAmount.toString(),
  ]);
}

/**
 * Scale a decimal price string (e.g., "0.51") to 18-decimal fixed-point BigInt.
 * Uses pure string manipulation — no floating-point intermediary — so the
 * result is deterministic regardless of Number precision limits.
 *
 * Cairo contract: `cost = fill_amount * execution_price / 10^18`
 */
export function scalePrice(price: string | number): bigint {
  const s = typeof price === "number" ? price.toFixed(18) : price;
  // Already a plain integer string — no scaling needed.
  if (/^\d+$/.test(s)) {
    return BigInt(s);
  }
  // Decimal string — scale to 18-decimal fixed point.
  const [intPart, fracPart = ""] = s.split(".");
  const padded = fracPart.padEnd(18, "0").slice(0, 18);
  return BigInt(intPart + padded);
}
