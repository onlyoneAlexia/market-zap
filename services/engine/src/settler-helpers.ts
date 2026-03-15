import { computeOrderHash, signOrderHash, formatSignature } from "@market-zap/shared";
import type { OrderHashParams } from "@market-zap/shared";
import { constants } from "starknet";
import type { TradeOrderInfo } from "./matcher.js";

export function buildCairoOrder(
  info: TradeOrderInfo,
  onChainMarketId: string,
  tokenId: string,
) {
  return {
    trader: info.trader,
    market_id: BigInt(onChainMarketId),
    token_id: BigInt(tokenId),
    is_buy: info.isBuy,
    price: scalePrice(info.price),
    amount: BigInt(info.amount),
    nonce: BigInt(info.nonce),
    expiry: BigInt(info.expiry),
  };
}

export function scalePrice(price: string): bigint {
  if (/^\d+$/.test(price)) return BigInt(price);
  const [whole, frac = ""] = price.split(".");
  const padded = frac.padEnd(18, "0").slice(0, 18);
  return BigInt(`${whole}${padded}`);
}

export function signSeedOrder(
  order: OrderHashParams,
  exchangeAddress: string,
  adminPrivateKey: string,
): string {
  const orderHash = computeOrderHash(
    order,
    exchangeAddress,
    constants.StarknetChainId.SN_SEPOLIA,
  );
  const signature = signOrderHash(orderHash, adminPrivateKey);
  return formatSignature(signature);
}

/**
 * Parse a comma-separated signature string into individual felt252 parts.
 * Supports all account types: OZ [r,s], Braavos [type,r,s],
 * Cartridge session keys [session-typed-data, ...many fields].
 * The on-chain settle_trade now accepts Span<felt252> so we pass all parts.
 */
export function parseSignature(signature: string): string[] {
  if (!signature || signature === "0x0,0x0") return ["0", "0"];
  const parts = signature.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return ["0", "0"];
  return parts;
}

export function getExecutionStatus(receipt: unknown): string | undefined {
  if (!receipt || typeof receipt !== "object") return undefined;
  return Reflect.get(receipt, "execution_status") as string | undefined;
}

export function getFinalityStatus(receipt: unknown): string | undefined {
  if (!receipt || typeof receipt !== "object") return undefined;
  return Reflect.get(receipt, "finality_status") as string | undefined;
}

export function getRevertReason(receipt: unknown): string | undefined {
  if (!receipt || typeof receipt !== "object") return undefined;
  return Reflect.get(receipt, "revert_reason") as string | undefined;
}
