import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/hooks/use-store";
import { useWallet } from "@/features/wallet/use-wallet";

const warmCartridgeClientMock = vi.fn();
const getClientMock = vi.fn();

vi.mock("@/features/wallet/wallet-client", () => ({
  connectCartridgeWalletClient: vi.fn(),
  connectExtensionWallet: vi.fn(),
  disconnectAllClients: vi.fn(),
  getCartridgeClient: vi.fn(),
  getClient: () => getClientMock(),
  restoreWalletConnection: vi.fn(),
  warmCartridgeClient: () => warmCartridgeClientMock(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    setAuthProvider: vi.fn(),
  },
}));

vi.mock("@/features/wallet/wallet-telemetry", () => ({
  emitWalletTelemetry: vi.fn(),
  toWalletTelemetryError: vi.fn(() => ({
    errorCode: "wallet_error",
    errorMessage: "Connection failed",
  })),
}));

describe("useWallet connect modal warmup", () => {
  beforeEach(() => {
    warmCartridgeClientMock.mockReset();
    getClientMock.mockReset();
    useAppStore.setState({
      wallet: {
        address: null,
        isConnecting: false,
        chainId: null,
        provider: null,
      },
      walletConnectionStatus: {
        provider: null,
        phase: "idle",
        message: null,
        isSlow: false,
      },
      connectModalOpen: false,
    });
  });

  it("warms the Cartridge client when opening the connect modal", () => {
    const { result } = renderHook(() => useWallet());

    act(() => {
      result.current.connect();
    });

    expect(warmCartridgeClientMock).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().connectModalOpen).toBe(true);
  });

  it("warms the Cartridge client for direct modal opens too", () => {
    const { result } = renderHook(() => useWallet());

    act(() => {
      result.current.openConnectModal();
    });

    expect(warmCartridgeClientMock).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().connectModalOpen).toBe(true);
  });
});
