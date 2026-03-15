"use client";

function resolveEngineRpcProxy(): string {
  const raw = process.env.NEXT_PUBLIC_ENGINE_URL || "/engine-api";
  const suffix = "/starknet-rpc";
  if (/^https?:\/\//.test(raw)) {
    return raw + suffix;
  }
  if (typeof window !== "undefined") {
    return `${window.location.origin}${raw}${suffix}`;
  }
  return `http://localhost:3000${raw}${suffix}`;
}

export const ENGINE_RPC_PROXY = resolveEngineRpcProxy();

export const SN_SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";
export const STARKNET_SEPOLIA_LABEL = "SN_SEPOLIA";

export function normalizeWalletAddress(address: string): string {
  const lower = address.toLowerCase();
  if (!lower.startsWith("0x")) {
    return lower;
  }

  return `0x${lower.slice(2).replace(/^0+/, "")}`;
}
