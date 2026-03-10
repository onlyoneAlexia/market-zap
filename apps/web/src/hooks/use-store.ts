import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
  IDLE_WALLET_CONNECTION_STATUS,
  type WalletConnectionStatus,
} from "@/features/wallet/wallet-connection-status";

const memoryStorage = (() => {
  const store = new Map<string, string>();
  return {
    getItem: (name: string) => store.get(name) ?? null,
    setItem: (name: string, value: string) => {
      store.set(name, value);
    },
    removeItem: (name: string) => {
      store.delete(name);
    },
  };
})();

interface WalletState {
  address: string | null;
  isConnecting: boolean;
  chainId: string | null;
  provider: "argentX" | "braavos" | "cartridge" | null;
}

interface AppState {
  /* Wallet */
  wallet: WalletState;
  setWallet: (wallet: Partial<WalletState>) => void;
  disconnectWallet: () => void;
  walletConnectionStatus: WalletConnectionStatus;
  setWalletConnectionStatus: (
    status: Partial<WalletConnectionStatus>,
  ) => void;
  resetWalletConnectionStatus: () => void;

  /* Selected market context */
  selectedMarketId: string | null;
  setSelectedMarket: (id: string | null) => void;

  /* UI preferences */
  theme: "light" | "dark" | "system";
  setTheme: (theme: "light" | "dark" | "system") => void;

  /* WebSocket connection */
  wsConnected: boolean;
  setWsConnected: (connected: boolean) => void;

  /* WebSocket channel subscriptions (managed by components) */
  wsChannels: Set<string>;
  subscribeChannels: (channels: string[]) => void;
  unsubscribeChannels: (channels: string[]) => void;

  /* Order signatures — maps nonce → signature for cancel auth */
  orderSignatures: Record<string, string>;
  saveOrderSignature: (nonce: string, signature: string) => void;
  removeOrderSignature: (nonce: string) => void;

  /* Modals */
  connectModalOpen: boolean;
  setConnectModalOpen: (open: boolean) => void;
  orderPreviewOpen: boolean;
  setOrderPreviewOpen: (open: boolean) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      /* Wallet */
      wallet: {
        address: null,
        isConnecting: false,
        chainId: null,
        provider: null,
      },
      setWallet: (partial) =>
        set((state) => ({
          wallet: { ...state.wallet, ...partial },
        })),
      disconnectWallet: () =>
        set({
          wallet: {
            address: null,
            isConnecting: false,
            chainId: null,
            provider: null,
          },
          walletConnectionStatus: IDLE_WALLET_CONNECTION_STATUS,
          orderSignatures: {},
        }),
      walletConnectionStatus: IDLE_WALLET_CONNECTION_STATUS,
      setWalletConnectionStatus: (partial) =>
        set((state) => ({
          walletConnectionStatus: {
            ...state.walletConnectionStatus,
            ...partial,
          },
        })),
      resetWalletConnectionStatus: () =>
        set({ walletConnectionStatus: IDLE_WALLET_CONNECTION_STATUS }),

      /* Selected market */
      selectedMarketId: null,
      setSelectedMarket: (id) => set({ selectedMarketId: id }),

      /* Theme */
      theme: "dark",
      setTheme: (theme) => set({ theme }),

      /* WS */
      wsConnected: false,
      setWsConnected: (connected) => set({ wsConnected: connected }),

      /* WS Channels */
      wsChannels: new Set<string>(),
      subscribeChannels: (channels) =>
        set((state) => {
          const next = new Set(state.wsChannels);
          channels.forEach((ch) => next.add(ch));
          return { wsChannels: next };
        }),
      unsubscribeChannels: (channels) =>
        set((state) => {
          const next = new Set(state.wsChannels);
          channels.forEach((ch) => next.delete(ch));
          return { wsChannels: next };
        }),

      /* Order signatures */
      orderSignatures: {},
      saveOrderSignature: (nonce, signature) =>
        set((state) => ({
          orderSignatures: { ...state.orderSignatures, [nonce]: signature },
        })),
      removeOrderSignature: (nonce) =>
        set((state) => {
          const next = { ...state.orderSignatures };
          delete next[nonce];
          return { orderSignatures: next };
        }),

      /* Modals */
      connectModalOpen: false,
      setConnectModalOpen: (open) => set({ connectModalOpen: open }),
      orderPreviewOpen: false,
      setOrderPreviewOpen: (open) => set({ orderPreviewOpen: open }),
    }),
    {
      name: "marketzap-store",
      storage: createJSONStorage(() => {
        if (typeof window === "undefined") {
          throw new Error("persist storage unavailable (SSR)");
        }
        const ls = window.localStorage;
        if (ls && typeof ls.setItem === "function") return ls;
        return memoryStorage;
      }),
      // Persist wallet identity, theme, and order signatures
      partialize: (state) => ({
        wallet: {
          address: state.wallet.address,
          chainId: state.wallet.chainId,
          provider: state.wallet.provider,
          isConnecting: false,
        },
        theme: state.theme,
        orderSignatures: state.orderSignatures,
      }),
    },
  ),
);
