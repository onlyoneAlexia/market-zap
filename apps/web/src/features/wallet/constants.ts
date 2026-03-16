"use client";

/**
 * Direct Starknet RPC URL for on-chain reads (balances, allowances, contract calls).
 * Uses NEXT_PUBLIC_STARKNET_RPC_URL from env if set, otherwise falls back to
 * a hardcoded public Zan endpoint. No engine proxy dependency.
 */
export const STARKNET_RPC_URL =
  process.env.NEXT_PUBLIC_STARKNET_RPC_URL ||
  "https://api.zan.top/public/starknet-sepolia/rpc/v0_8";

export const SN_SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";
export const STARKNET_SEPOLIA_LABEL = "SN_SEPOLIA";

export function normalizeWalletAddress(address: string): string {
  const lower = address.toLowerCase();
  if (!lower.startsWith("0x")) {
    return lower;
  }

  return `0x${lower.slice(2).replace(/^0+/, "")}`;
}
