import { beforeEach, describe, expect, it, vi } from "vitest";

const connectCartridgeMock = vi.fn();
const ensureReadyMock = vi.fn();

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

import {
  connectCartridgeWalletClient,
  resetCartridgeClient,
} from "@/features/wallet/wallet-client";

describe("wallet-client Cartridge connect", () => {
  beforeEach(() => {
    connectCartridgeMock.mockReset();
    ensureReadyMock.mockReset();
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
});
