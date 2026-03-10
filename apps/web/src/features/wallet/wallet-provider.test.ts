import { beforeEach, describe, expect, it } from "vitest";
import {
  getWalletDisplayName,
  getWalletObject,
  getWalletWindowKey,
  isExtensionProvider,
} from "@/features/wallet/wallet-provider";

describe("wallet-provider helpers", () => {
  beforeEach(() => {
    Object.assign(window as object, {
      starknet: undefined,
      starknet_argentX: undefined,
      starknet_braavos: undefined,
      someOtherInjectedWallet: undefined,
    });
  });

  it("maps provider ids to stable display names", () => {
    expect(getWalletDisplayName("argentX")).toBe("Argent X");
    expect(getWalletDisplayName("braavos")).toBe("Braavos");
    expect(getWalletDisplayName("cartridge")).toBe("Social Login");
  });

  it("returns extension window keys only for extension providers", () => {
    expect(isExtensionProvider("argentX")).toBe(true);
    expect(isExtensionProvider("braavos")).toBe(true);
    expect(isExtensionProvider("cartridge")).toBe(false);
    expect(getWalletWindowKey("braavos")).toBe("starknet_braavos");
  });

  it("finds Braavos from the generic starknet object when the direct key is missing", () => {
    const braavosWallet = {
      id: "braavos",
      name: "Braavos",
      enable: async () => ["0x123"],
      account: {} as never,
      selectedAddress: "0x123",
    };

    Object.assign(window as object, {
      starknet_braavos: undefined,
      starknet: braavosWallet,
    });

    expect(getWalletObject("braavos")).toBe(braavosWallet);
  });

  it("falls back to scanning injected wallet objects by name", () => {
    const argentWallet = {
      id: "argentx",
      name: "Argent X",
      enable: async () => ["0xabc"],
      account: {} as never,
      selectedAddress: "0xabc",
    };

    Object.assign(window as object, {
      starknet_argentX: undefined,
      someOtherInjectedWallet: argentWallet,
    });

    expect(getWalletObject("argentX")).toBe(argentWallet);
  });
});
