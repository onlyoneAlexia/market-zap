import { beforeEach, describe, expect, it, vi } from "vitest";

const connectCartridgeMock = vi.fn();
const ensureReadyMock = vi.fn();
const getWalletObjectMock = vi.fn();

vi.mock("@market-zap/shared", () => {
  class MockMarketZapWallet {
    connectCartridge = connectCartridgeMock;
    ensureReady = ensureReadyMock;
    hasWallet = vi.fn(() => true);
    getState = vi.fn(() => ({
      address: "0x123",
      connected: true,
    }));
    disconnect = vi.fn();
  }

  return {
    cleanupCartridgeControllerDom: vi.fn(),
    getMarketZapCartridgeConnectOptions: vi.fn(
      (_network: string, overrides?: Record<string, unknown>) => ({
        policies: [{ target: "0xexchange", method: "deposit" }],
        ...overrides,
      }),
    ),
    MarketZapWallet: MockMarketZapWallet,
  };
});

vi.mock("@/features/wallet/wallet-provider", () => ({
  getWalletDisplayName: vi.fn((provider: string) =>
    provider === "braavos" ? "Braavos" : "Argent X",
  ),
  getWalletObject: (...args: unknown[]) => getWalletObjectMock(...args),
  isExtensionProvider: vi.fn(
    (provider: string) => provider === "braavos" || provider === "argentX",
  ),
}));

import {
  connectExtensionWallet,
  connectCartridgeWalletClient,
  resetCartridgeClient,
} from "@/features/wallet/wallet-client";

describe("wallet-client Cartridge connect", () => {
  beforeEach(() => {
    connectCartridgeMock.mockReset();
    ensureReadyMock.mockReset();
    getWalletObjectMock.mockReset();
    resetCartridgeClient();
  });

  it("ensures the Cartridge account is ready before returning the client", async () => {
    const calls: string[] = [];
    connectCartridgeMock.mockImplementation(async () => {
      calls.push("connect");
      return { connected: true, address: "0x123" };
    });
    ensureReadyMock.mockImplementation(async () => {
      calls.push("ensureReady");
    });

    const setWallet = vi.fn(() => {
      calls.push("setWallet");
    });

    await connectCartridgeWalletClient(setWallet);

    expect(ensureReadyMock).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["connect", "ensureReady", "setWallet"]);
  });

  it("reuses an injected extension session without calling enable again", async () => {
    const connectWithExternalAccount = vi.fn().mockResolvedValue(undefined);
    const setWallet = vi.fn();
    const enable = vi.fn();
    const account = { address: "0x123", getChainId: vi.fn() };

    getWalletObjectMock.mockReturnValue({
      account,
      selectedAddress: "0x123",
      enable,
    });

    const client = {
      connectWithExternalAccount,
    } as any;

    const result = await connectExtensionWallet("braavos", client, setWallet);

    expect(result).toBe(client);
    expect(enable).not.toHaveBeenCalled();
    expect(connectWithExternalAccount).toHaveBeenCalledWith(
      account,
      "0x534e5f5345504f4c4941",
    );
    expect(setWallet).toHaveBeenCalledWith({
      address: "0x123",
      isConnecting: false,
      chainId: "SN_SEPOLIA",
      provider: "braavos",
    });
  });

  it("falls back to enable when the extension session is not yet injected", async () => {
    const connectWithExternalAccount = vi.fn().mockResolvedValue(undefined);
    const setWallet = vi.fn();
    const account = { address: "0x456", getChainId: vi.fn() };
    const walletObject: any = {
      account: undefined,
      selectedAddress: "",
      enable: vi.fn(async () => {
        walletObject.account = account;
        walletObject.selectedAddress = "0x456";
        return ["0x456"];
      }),
    };

    getWalletObjectMock.mockReturnValue(walletObject);

    const client = {
      connectWithExternalAccount,
    } as any;

    await connectExtensionWallet("braavos", client, setWallet);

    expect(walletObject.enable).toHaveBeenCalledTimes(1);
    expect(connectWithExternalAccount).toHaveBeenCalledWith(
      account,
      "0x534e5f5345504f4c4941",
    );
  });
});
