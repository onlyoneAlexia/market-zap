"use client";

import {
  cleanupCartridgeControllerDom,
  getMarketZapCartridgeConnectOptions,
  type CartridgeConnectOptions,
} from "@market-zap/shared";
import { useAppStore } from "@/hooks/use-store";
import {
  ENGINE_RPC_PROXY,
  SN_SEPOLIA_CHAIN_ID,
  STARKNET_SEPOLIA_LABEL,
  normalizeWalletAddress,
} from "./constants";
import {
  getWalletDisplayName,
  getWalletObject,
  isExtensionProvider,
  type ExtensionWalletProvider,
  type WalletProvider,
} from "./wallet-provider";

type MarketZapWalletType = import("@market-zap/shared").MarketZapWallet;
type StoredWalletState = ReturnType<typeof useAppStore.getState>["wallet"];
type SetWallet = ReturnType<typeof useAppStore.getState>["setWallet"];
type DisconnectWallet = ReturnType<typeof useAppStore.getState>["disconnectWallet"];

type CartridgeConnectResult = {
  connected: boolean;
  address?: string | null;
};

interface CartridgeConnectCallbacks {
  onRetry?: () => void;
}

let starkzapClient: MarketZapWalletType | null = null;
let starkzapClientPromise: Promise<MarketZapWalletType> | null = null;
let cartridgeClient: MarketZapWalletType | null = null;
let cartridgeClientPromise: Promise<MarketZapWalletType> | null = null;
let cartridgeConnectPromise: Promise<CartridgeConnectResult> | null = null;

function setConnectedWallet(
  setWallet: SetWallet,
  provider: WalletProvider,
  address: string,
): void {
  setWallet({
    address,
    isConnecting: false,
    chainId: STARKNET_SEPOLIA_LABEL,
    provider,
  });
}


function isCartridgeInitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("failed to initialize")
  );
}

function getWebCartridgeConnectOptions(): CartridgeConnectOptions {
  return getMarketZapCartridgeConnectOptions("sepolia", {
    preset: process.env.NEXT_PUBLIC_CARTRIDGE_PRESET?.trim() || undefined,
    url:
      process.env.NEXT_PUBLIC_CARTRIDGE_CONTROLLER_URL?.trim() || undefined,
  });
}

export async function getClient(): Promise<MarketZapWalletType> {
  if (starkzapClient) {
    return starkzapClient;
  }

  if (starkzapClientPromise) {
    return starkzapClientPromise;
  }

  starkzapClientPromise = import("@market-zap/shared")
    .then(({ MarketZapWallet }) => {
      const client = new MarketZapWallet("sepolia", {
        rpcUrl: ENGINE_RPC_PROXY,
        feeMode: "sponsored",
      });
      starkzapClient = client;
      return client;
    })
    .catch((error) => {
      starkzapClientPromise = null;
      throw error;
    });

  return starkzapClientPromise;
}

export async function getCartridgeClient(): Promise<MarketZapWalletType> {
  if (cartridgeClient) {
    return cartridgeClient;
  }

  if (cartridgeClientPromise) {
    return cartridgeClientPromise;
  }

  cartridgeClientPromise = import("@market-zap/shared")
    .then(({ MarketZapWallet }) => {
      const client = new MarketZapWallet("sepolia", {
        feeMode: "user_pays",
      });
      cartridgeClient = client;
      return client;
    })
    .catch((error) => {
      cartridgeClientPromise = null;
      throw error;
    });

  return cartridgeClientPromise;
}

export function warmCartridgeClient(): void {
  void getCartridgeClient().catch(() => {});
}

export function getClientSync(): MarketZapWalletType | null {
  if (starkzapClient?.hasWallet()) {
    return starkzapClient;
  }

  if (cartridgeClient?.hasWallet()) {
    return cartridgeClient;
  }

  // No client has an active wallet — return null so callers don't
  // accidentally call methods on an unconnected instance.
  return null;
}

export function resetCartridgeClient(): void {
  cleanupCartridgeControllerDom();
  cartridgeClient = null;
  cartridgeClientPromise = null;
  cartridgeConnectPromise = null;
}

export async function connectCartridgeDeduped(
  client: MarketZapWalletType,
  callbacks?: CartridgeConnectCallbacks,
): Promise<CartridgeConnectResult> {
  if (cartridgeConnectPromise) {
    return cartridgeConnectPromise;
  }

  cleanupCartridgeControllerDom();
  cartridgeConnectPromise = client
    .connectCartridge(getWebCartridgeConnectOptions())
    .finally(() => {
      cartridgeConnectPromise = null;
    });

  return cartridgeConnectPromise;
}

export async function disconnectAllClients(): Promise<void> {
  const promises: Promise<void>[] = [];

  if (starkzapClient?.hasWallet()) {
    promises.push(starkzapClient.disconnect().catch(() => {}));
  }

  if (cartridgeClient?.hasWallet()) {
    promises.push(cartridgeClient.disconnect().catch(() => {}));
  }

  await Promise.all(promises);
  cleanupCartridgeControllerDom();

  // Null out module-level singletons so getClientSync() never returns a
  // disconnected instance after logout. They are lazily re-created on next connect.
  starkzapClient = null;
  starkzapClientPromise = null;
  cartridgeClient = null;
  cartridgeClientPromise = null;
  cartridgeConnectPromise = null;
}

export async function connectExtensionWallet(
  provider: ExtensionWalletProvider,
  client: MarketZapWalletType,
  setWallet: SetWallet,
): Promise<MarketZapWalletType> {
  const walletObject = getWalletObject(provider);

  if (!walletObject) {
    throw new Error(`${getWalletDisplayName(provider)} extension not detected`);
  }

  await walletObject.enable();
  if (!walletObject.account || !walletObject.selectedAddress) {
    throw new Error("Wallet connection was rejected or failed");
  }

  await client.connectWithExternalAccount(
    walletObject.account,
    SN_SEPOLIA_CHAIN_ID,
  );
  setConnectedWallet(setWallet, provider, walletObject.selectedAddress);
  return client;
}

export async function connectCartridgeWalletClient(
  setWallet: SetWallet,
  callbacks?: CartridgeConnectCallbacks,
): Promise<MarketZapWalletType> {
  const attempt = async (): Promise<MarketZapWalletType> => {
    const client = await getCartridgeClient();
    const state = await connectCartridgeDeduped(client, callbacks);

    if (!state.connected || !state.address) {
      throw new Error("Cartridge connection was rejected or failed");
    }

    await client.ensureReady();
    setConnectedWallet(setWallet, "cartridge", state.address);
    return client;
  };

  try {
    return await attempt();
  } catch (error) {
    if (!isCartridgeInitError(error)) {
      throw error;
    }

    console.warn("[wallet] Cartridge Controller slow to load, retrying...");
    callbacks?.onRetry?.();
    resetCartridgeClient();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return attempt();
  }
}

export async function restoreWalletConnection(
  wallet: StoredWalletState,
  setWallet: SetWallet,
  disconnectWallet: DisconnectWallet,
): Promise<MarketZapWalletType | null> {
  const { address, provider } = wallet;

  if (!provider) {
    if (address) {
      disconnectWallet();
    }
    return null;
  }

  try {
    if (provider === "cartridge") {
      const client = await getCartridgeClient();
      if (client.hasWallet()) {
        const sessionAddress = client.getState().address;
        if (sessionAddress) {
          setConnectedWallet(setWallet, "cartridge", sessionAddress);
        }
        return client;
      }

      return connectCartridgeWalletClient(setWallet);
    }

    const client = await getClient();

    if (isExtensionProvider(provider)) {
      const walletObject = getWalletObject(provider);
      if (!walletObject) {
        disconnectWallet();
        return null;
      }

      if (
        client.hasWallet() &&
        walletObject.selectedAddress &&
        normalizeWalletAddress(client.getState().address ?? "") ===
          normalizeWalletAddress(walletObject.selectedAddress)
      ) {
        setConnectedWallet(setWallet, provider, walletObject.selectedAddress);
        return client;
      }

      if (client.hasWallet()) {
        await client.disconnect().catch(() => {});
      }

      return connectExtensionWallet(provider, client, setWallet);
    }

    if (client.hasWallet()) {
      return client;
    }

    disconnectWallet();
    return null;
  } catch (error) {
    disconnectWallet();
    throw error;
  }
}

export function isWalletExtensionAvailable(provider: WalletProvider): boolean {
  if (!isExtensionProvider(provider)) {
    return false;
  }

  return Boolean(getWalletObject(provider));
}
