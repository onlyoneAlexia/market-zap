import { describe, it, expect } from "vitest";
import {
  TAKER_FEE_BPS,
  MAKER_FEE_BPS,
  CREATION_BOND_AMOUNT,
  VOLUME_REFUND_THRESHOLD,
  DISPUTE_PERIOD,
  VOID_TIMEOUT,
  MAX_OUTCOMES,
  PRICE_DECIMALS,
  COLLATERAL_DECIMALS,
  CATEGORY_LABELS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../constants";
import { COLLATERAL_TOKEN_ADDRESSES, CONTRACT_ADDRESSES } from "../contracts";

describe("Fee constants", () => {
  it("taker fee is 100 bps (1%)", () => {
    expect(TAKER_FEE_BPS).toBe(100);
  });

  it("maker fee is 0 bps", () => {
    expect(MAKER_FEE_BPS).toBe(0);
  });
});

describe("Bond constants", () => {
  it("creation bond is 20 USDC (6 decimals)", () => {
    expect(CREATION_BOND_AMOUNT).toBe("20000000");
    expect(Number(CREATION_BOND_AMOUNT)).toBe(20 * 1e6);
  });

  it("volume refund threshold is 100 USDC (6 decimals)", () => {
    expect(VOLUME_REFUND_THRESHOLD).toBe("100000000");
    expect(Number(VOLUME_REFUND_THRESHOLD)).toBe(100 * 1e6);
  });
});

describe("Time constants", () => {
  it("dispute period is 24 hours in seconds", () => {
    expect(DISPUTE_PERIOD).toBe(86_400);
  });

  it("void timeout is 14 days in seconds", () => {
    expect(VOID_TIMEOUT).toBe(1_209_600);
    expect(VOID_TIMEOUT).toBe(14 * 24 * 60 * 60);
  });
});

describe("Market constraints", () => {
  it("max outcomes is 8", () => {
    expect(MAX_OUTCOMES).toBe(8);
  });
});

describe("Decimal precision", () => {
  it("price uses 18 decimals", () => {
    expect(PRICE_DECIMALS).toBe(18);
  });

  it("collateral uses 6 decimals (USDC)", () => {
    expect(COLLATERAL_DECIMALS).toBe(6);
  });
});

describe("Network-specific addresses", () => {
  it("has sepolia and mainnet entries", () => {
    expect(COLLATERAL_TOKEN_ADDRESSES).toHaveProperty("sepolia");
    expect(COLLATERAL_TOKEN_ADDRESSES).toHaveProperty("mainnet");
  });

  it("addresses are 0x-prefixed", () => {
    expect(COLLATERAL_TOKEN_ADDRESSES.sepolia.startsWith("0x")).toBe(true);
    expect(COLLATERAL_TOKEN_ADDRESSES.mainnet.startsWith("0x")).toBe(true);
  });

  it("COLLATERAL_TOKEN_ADDRESSES derives from CONTRACT_ADDRESSES (single source of truth)", () => {
    expect(COLLATERAL_TOKEN_ADDRESSES.sepolia).toBe(CONTRACT_ADDRESSES.sepolia.USDC);
    expect(COLLATERAL_TOKEN_ADDRESSES.mainnet).toBe(CONTRACT_ADDRESSES.mainnet.USDC);
  });
});

describe("Category labels", () => {
  it("has all expected categories", () => {
    expect(CATEGORY_LABELS).toEqual({
      crypto: "Crypto",
      politics: "Politics",
      sports: "Sports",
      culture: "Culture",
      science: "Science",
    });
  });
});

describe("Pagination defaults", () => {
  it("default page size is 20", () => {
    expect(DEFAULT_PAGE_SIZE).toBe(20);
  });

  it("max page size is 100", () => {
    expect(MAX_PAGE_SIZE).toBe(100);
  });
});
