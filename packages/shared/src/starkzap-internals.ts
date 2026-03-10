import { hash } from "starknet";
import type { SupportedNetwork } from "./constants";

export function normalizeAddress(addr: string): string {
  const lower = addr.toLowerCase();
  if (!lower.startsWith("0x")) return lower;
  return "0x" + lower.slice(2).replace(/^0+/, "");
}

export function normalizeHexValue(value: string | bigint): string {
  return "0x" + BigInt(value).toString(16).padStart(64, "0");
}

export function extractMarketCreatedEvent(
  receipt: unknown,
  factoryAddress: string,
): { marketId?: number; conditionId?: string } {
  const normalizedFactoryAddress = normalizeHexValue(factoryAddress);
  const normalizedSelector = normalizeHexValue(
    hash.getSelectorFromName("MarketCreated"),
  );
  const events = (receipt as {
    events?: Array<{ from_address?: string; keys?: string[]; data?: string[] }>;
  }).events;

  if (!Array.isArray(events)) {
    return {};
  }

  for (const event of events) {
    if (!event.keys || event.keys.length < 2 || !event.from_address) {
      continue;
    }

    const fromFactory =
      normalizeHexValue(event.from_address) === normalizedFactoryAddress;
    const isMarketCreated =
      normalizeHexValue(event.keys[0]) === normalizedSelector;

    if (fromFactory && isMarketCreated) {
      return {
        marketId: Number(BigInt(event.keys[1])),
        conditionId: event.data?.[0],
      };
    }
  }

  return {};
}

export function cleanupCartridgeControllerDom(): void {
  if (typeof document === "undefined") {
    return;
  }

  document.querySelectorAll("#controller").forEach((element) => {
    element.remove();
  });

  document
    .querySelectorAll<HTMLElement>('iframe[id^="controller-"]')
    .forEach((iframe) => {
      const container = iframe.closest("#controller");
      if (container) {
        container.remove();
        return;
      }
      iframe.remove();
    });

  document.getElementById("controller-viewport")?.remove();
  if (document.body) {
    document.body.style.overflow = "auto";
  }
}

export interface WalletState {
  connected: boolean;
  address: string | null;
  network: SupportedNetwork;
  connecting: boolean;
  gasless: boolean;
  connectionKind: WalletConnectionKind;
  supportsPreflight: boolean;
}

export interface ConnectOptions {
  method?: "argent" | "braavos" | "cartridge" | "dev";
  network?: SupportedNetwork;
}

export interface TransactionResult {
  txHash: string;
  success: boolean;
  error?: string;
}

export interface CreateMarketResult extends TransactionResult {
  marketId?: number;
  conditionId?: string;
}

export type FeeMode = "sponsored" | "user_pays";
export type WalletConnectionKind = "none" | "dev" | "cartridge" | "external";
