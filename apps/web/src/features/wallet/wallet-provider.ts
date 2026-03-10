"use client";

import type { Account } from "starknet";

export type WalletProvider = "argentX" | "braavos" | "cartridge";
export type ExtensionWalletProvider = Extract<
  WalletProvider,
  "argentX" | "braavos"
>;

export interface StarknetWalletObject {
  id?: string;
  name?: string;
  icon?: string;
  version?: string;
  account: Account;
  selectedAddress: string;
  enable: (options?: { starknetVersion?: string }) => Promise<string[]>;
  isConnected?: boolean;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  off?: (event: string, handler: (...args: unknown[]) => void) => void;
}

const WALLET_DISPLAY_NAMES: Record<WalletProvider, string> = {
  argentX: "Argent X",
  braavos: "Braavos",
  cartridge: "Social Login",
};

const WALLET_WINDOW_KEYS: Record<ExtensionWalletProvider, string> = {
  argentX: "starknet_argentX",
  braavos: "starknet_braavos",
};

export function getWalletDisplayName(provider: WalletProvider): string {
  return WALLET_DISPLAY_NAMES[provider];
}

export function isExtensionProvider(
  provider: WalletProvider,
): provider is ExtensionWalletProvider {
  return provider === "argentX" || provider === "braavos";
}

export function getWalletWindowKey(
  provider: ExtensionWalletProvider,
): string {
  return WALLET_WINDOW_KEYS[provider];
}

function isWalletCandidate(value: unknown): value is StarknetWalletObject {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<StarknetWalletObject>;
  return typeof candidate.enable === "function";
}

function matchesProvider(
  provider: ExtensionWalletProvider,
  value: unknown,
): value is StarknetWalletObject {
  if (!isWalletCandidate(value)) {
    return false;
  }

  const candidate = value as unknown as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id.toLowerCase() : "";
  const name =
    typeof candidate.name === "string" ? candidate.name.toLowerCase() : "";
  const walletKey =
    typeof candidate.walletKey === "string"
      ? candidate.walletKey.toLowerCase()
      : "";
  const label = `${id} ${name} ${walletKey}`;

  if (provider === "braavos") {
    return label.includes("braavos");
  }

  return label.includes("argent");
}

function getEnumeratedWalletObject(
  provider: ExtensionWalletProvider,
  globalObject: Record<string, unknown>,
): StarknetWalletObject | undefined {
  const seen = new Set<unknown>();

  const tryCandidate = (candidate: unknown): StarknetWalletObject | undefined => {
    if (!candidate || seen.has(candidate)) {
      return undefined;
    }

    seen.add(candidate);
    if (matchesProvider(provider, candidate)) {
      return candidate;
    }

    return undefined;
  };

  const namedCandidate = tryCandidate(globalObject.starknet);
  if (namedCandidate) {
    return namedCandidate;
  }

  for (const value of Object.values(globalObject)) {
    const candidate = tryCandidate(value);
    if (candidate) {
      return candidate;
    }
  }

  const genericStarknet = globalObject.starknet;
  if (provider === "braavos" && isWalletCandidate(genericStarknet)) {
    return genericStarknet;
  }

  return undefined;
}

export function getWalletObject(
  provider: ExtensionWalletProvider,
): StarknetWalletObject | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  const globalObject = window as unknown as Record<string, unknown>;
  const directCandidate = globalObject[
    getWalletWindowKey(provider)
  ];

  if (isWalletCandidate(directCandidate)) {
    return directCandidate;
  }

  return getEnumeratedWalletObject(provider, globalObject);
}
