import { describe, it, expect } from "vitest";
import { getContractAddress, CONTRACT_ADDRESSES } from "../contracts";

describe("getContractAddress", () => {
  it("returns sepolia MarketFactory address", () => {
    const addr = getContractAddress("MarketFactory", "sepolia");
    expect(addr).toBe(CONTRACT_ADDRESSES.sepolia.MarketFactory);
    expect(addr.startsWith("0x")).toBe(true);
  });

  it("returns sepolia CLOBRouter address", () => {
    const addr = getContractAddress("CLOBRouter", "sepolia");
    expect(addr).toBe(CONTRACT_ADDRESSES.sepolia.CLOBRouter);
  });

  it("returns sepolia Resolver address", () => {
    const addr = getContractAddress("Resolver", "sepolia");
    expect(addr).toBe(CONTRACT_ADDRESSES.sepolia.Resolver);
  });

  it("returns sepolia ConditionalTokens address", () => {
    const addr = getContractAddress("ConditionalTokens", "sepolia");
    expect(addr).toBe(CONTRACT_ADDRESSES.sepolia.ConditionalTokens);
  });

  it("returns sepolia USDC address", () => {
    const addr = getContractAddress("USDC", "sepolia");
    expect(addr).toBe(CONTRACT_ADDRESSES.sepolia.USDC);
  });

  it("throws for undeployed mainnet contracts (zero address)", () => {
    expect(() => getContractAddress("MarketFactory", "mainnet")).toThrow(
      'Contract "MarketFactory" has not been deployed on "mainnet" yet.',
    );
  });

  it("does not throw for deployed mainnet USDC", () => {
    // Mainnet USDC has a real address
    const addr = getContractAddress("USDC", "mainnet");
    expect(addr).toBe(CONTRACT_ADDRESSES.mainnet.USDC);
  });
});

describe("CONTRACT_ADDRESSES", () => {
  it("has all expected networks", () => {
    expect(Object.keys(CONTRACT_ADDRESSES)).toEqual(
      expect.arrayContaining(["sepolia", "mainnet"]),
    );
  });

  it("has all expected contract names per network", () => {
    const expectedNames = ["MarketFactory", "ConditionalTokens", "CLOBRouter", "Resolver", "USDC"];
    for (const network of ["sepolia", "mainnet"] as const) {
      for (const name of expectedNames) {
        expect(CONTRACT_ADDRESSES[network]).toHaveProperty(name);
      }
    }
  });

  it("all sepolia addresses are non-zero", () => {
    for (const addr of Object.values(CONTRACT_ADDRESSES.sepolia)) {
      expect(addr).not.toBe("0x0000000000000000000000000000000000000000");
    }
  });
});
