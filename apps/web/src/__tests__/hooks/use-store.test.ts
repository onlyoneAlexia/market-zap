import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/hooks/use-store";
import { IDLE_WALLET_CONNECTION_STATUS } from "@/features/wallet/wallet-connection-status";

describe("useAppStore (Zustand)", () => {
  beforeEach(() => {
    // Reset store to initial state
    useAppStore.setState({
      wallet: { address: null, isConnecting: false, chainId: null, provider: null },
      walletConnectionStatus: IDLE_WALLET_CONNECTION_STATUS,
      selectedMarketId: null,
      theme: "dark",
      wsConnected: false,
      connectModalOpen: false,
      orderPreviewOpen: false,
      orderSignatures: {},
    });
  });

  // ---------------------------------------------------------------------------
  // Wallet state
  // ---------------------------------------------------------------------------

  describe("wallet", () => {
    it("starts with no wallet connected", () => {
      const state = useAppStore.getState();
      expect(state.wallet.address).toBeNull();
      expect(state.wallet.isConnecting).toBe(false);
      expect(state.wallet.chainId).toBeNull();
    });

    it("setWallet updates partial wallet state", () => {
      useAppStore.getState().setWallet({ address: "0x1234" });

      const state = useAppStore.getState();
      expect(state.wallet.address).toBe("0x1234");
      expect(state.wallet.isConnecting).toBe(false); // preserved
    });

    it("setWallet can update isConnecting", () => {
      useAppStore.getState().setWallet({ isConnecting: true });
      expect(useAppStore.getState().wallet.isConnecting).toBe(true);
    });

    it("setWallet can update chainId", () => {
      useAppStore.getState().setWallet({ chainId: "SN_SEPOLIA" });
      expect(useAppStore.getState().wallet.chainId).toBe("SN_SEPOLIA");
    });

    it("disconnectWallet resets all wallet fields", () => {
      useAppStore.getState().setWallet({
        address: "0x1234",
        isConnecting: false,
        chainId: "SN_SEPOLIA",
      });

      useAppStore.getState().disconnectWallet();

      const state = useAppStore.getState();
      expect(state.wallet.address).toBeNull();
      expect(state.wallet.isConnecting).toBe(false);
      expect(state.wallet.chainId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Selected market
  // ---------------------------------------------------------------------------

  describe("selectedMarket", () => {
    it("starts with null", () => {
      expect(useAppStore.getState().selectedMarketId).toBeNull();
    });

    it("setSelectedMarket updates ID", () => {
      useAppStore.getState().setSelectedMarket("market-1");
      expect(useAppStore.getState().selectedMarketId).toBe("market-1");
    });

    it("setSelectedMarket can clear with null", () => {
      useAppStore.getState().setSelectedMarket("market-1");
      useAppStore.getState().setSelectedMarket(null);
      expect(useAppStore.getState().selectedMarketId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------------

  describe("theme", () => {
    it("defaults to dark", () => {
      expect(useAppStore.getState().theme).toBe("dark");
    });

    it("setTheme changes theme", () => {
      useAppStore.getState().setTheme("light");
      expect(useAppStore.getState().theme).toBe("light");
    });

    it("supports system theme", () => {
      useAppStore.getState().setTheme("system");
      expect(useAppStore.getState().theme).toBe("system");
    });
  });

  // ---------------------------------------------------------------------------
  // WebSocket connection
  // ---------------------------------------------------------------------------

  describe("wsConnected", () => {
    it("starts disconnected", () => {
      expect(useAppStore.getState().wsConnected).toBe(false);
    });

    it("setWsConnected toggles connection state", () => {
      useAppStore.getState().setWsConnected(true);
      expect(useAppStore.getState().wsConnected).toBe(true);

      useAppStore.getState().setWsConnected(false);
      expect(useAppStore.getState().wsConnected).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Modals
  // ---------------------------------------------------------------------------

  describe("modals", () => {
    it("connectModal starts closed", () => {
      expect(useAppStore.getState().connectModalOpen).toBe(false);
    });

    it("setConnectModalOpen opens/closes modal", () => {
      useAppStore.getState().setConnectModalOpen(true);
      expect(useAppStore.getState().connectModalOpen).toBe(true);

      useAppStore.getState().setConnectModalOpen(false);
      expect(useAppStore.getState().connectModalOpen).toBe(false);
    });

    it("orderPreview starts closed", () => {
      expect(useAppStore.getState().orderPreviewOpen).toBe(false);
    });

    it("setOrderPreviewOpen opens/closes preview", () => {
      useAppStore.getState().setOrderPreviewOpen(true);
      expect(useAppStore.getState().orderPreviewOpen).toBe(true);

      useAppStore.getState().setOrderPreviewOpen(false);
      expect(useAppStore.getState().orderPreviewOpen).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Integration
  // ---------------------------------------------------------------------------

  describe("state isolation", () => {
    it("wallet changes don't affect other state", () => {
      useAppStore.getState().setSelectedMarket("m1");
      useAppStore.getState().setTheme("light");

      useAppStore.getState().setWallet({ address: "0x1234" });

      expect(useAppStore.getState().selectedMarketId).toBe("m1");
      expect(useAppStore.getState().theme).toBe("light");
    });
  });
});
