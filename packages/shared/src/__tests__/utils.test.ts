import { describe, it, expect } from "vitest";
import {
  toFixedPoint,
  fromFixedPoint,
  formatPrice,
  formatUsd,
  shortenAddress,
  calculatePnl,
  generateNonce,
} from "../utils";
import { PRICE_DECIMALS, COLLATERAL_DECIMALS } from "../constants";

// ---------------------------------------------------------------------------
// toFixedPoint
// ---------------------------------------------------------------------------

describe("toFixedPoint", () => {
  it("converts integer string with default 18 decimals", () => {
    expect(toFixedPoint("1")).toBe(10n ** 18n);
  });

  it("converts decimal string with default 18 decimals", () => {
    expect(toFixedPoint("1.5")).toBe(1_500_000_000_000_000_000n);
  });

  it("converts number input", () => {
    expect(toFixedPoint(2)).toBe(2_000_000_000_000_000_000n);
  });

  it("converts with custom decimals (6)", () => {
    expect(toFixedPoint("20", 6)).toBe(20_000_000n);
  });

  it("handles zero", () => {
    expect(toFixedPoint("0")).toBe(0n);
    expect(toFixedPoint("0.0")).toBe(0n);
  });

  it("handles small fractions", () => {
    expect(toFixedPoint("0.000000000000000001")).toBe(1n);
  });

  it("throws on too many decimal places", () => {
    expect(() => toFixedPoint("0.1234567", 6)).toThrow(RangeError);
    expect(() => toFixedPoint("0.1234567", 6)).toThrow("exceeds maximum precision");
  });

  it("handles fraction shorter than decimals", () => {
    expect(toFixedPoint("1.1", 6)).toBe(1_100_000n);
  });

  it("converts large values", () => {
    expect(toFixedPoint("1000000")).toBe(1_000_000n * 10n ** 18n);
  });

  it("handles input with no whole part", () => {
    expect(toFixedPoint(".5")).toBe(500_000_000_000_000_000n);
  });
});

// ---------------------------------------------------------------------------
// fromFixedPoint
// ---------------------------------------------------------------------------

describe("fromFixedPoint", () => {
  it("converts 18-decimal fixed-point back to string", () => {
    expect(fromFixedPoint(1_500_000_000_000_000_000n)).toBe("1.5");
  });

  it("converts with custom decimals (6)", () => {
    expect(fromFixedPoint(20_000_000n, 6)).toBe("20.0");
  });

  it("handles zero", () => {
    expect(fromFixedPoint(0n)).toBe("0.0");
  });

  it("handles negative values", () => {
    const result = fromFixedPoint(-1_500_000_000_000_000_000n);
    expect(result).toBe("-1.5");
  });

  it("trims trailing zeros but keeps at least one decimal", () => {
    expect(fromFixedPoint(10n ** 18n)).toBe("1.0");
  });

  it("preserves precision for fractional values", () => {
    expect(fromFixedPoint(1n)).toBe("0.000000000000000001");
  });

  it("round-trips with toFixedPoint", () => {
    const original = "123.456";
    const fp = toFixedPoint(original);
    const back = fromFixedPoint(fp);
    expect(back).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// formatPrice
// ---------------------------------------------------------------------------

describe("formatPrice", () => {
  it("formats probability as percentage", () => {
    const price = toFixedPoint("0.65");
    expect(formatPrice(price)).toBe("65.0%");
  });

  it("formats 0 as 0.0%", () => {
    expect(formatPrice(0n)).toBe("0.0%");
  });

  it("formats 1 as 100.0%", () => {
    expect(formatPrice(toFixedPoint("1"))).toBe("100.0%");
  });

  it("accepts string input", () => {
    const price = toFixedPoint("0.5").toString();
    expect(formatPrice(price)).toBe("50.0%");
  });

  it("returns raw decimal for values > 1", () => {
    const price = toFixedPoint("2.5");
    expect(formatPrice(price)).toBe("2.5");
  });
});

// ---------------------------------------------------------------------------
// formatUsd
// ---------------------------------------------------------------------------

describe("formatUsd", () => {
  it("formats amount as USD currency", () => {
    const amount = toFixedPoint("1234.56", COLLATERAL_DECIMALS);
    expect(formatUsd(amount)).toBe("$1,234.56");
  });

  it("formats zero", () => {
    expect(formatUsd(0n)).toBe("$0.00");
  });

  it("accepts string input", () => {
    const amount = toFixedPoint("100", COLLATERAL_DECIMALS).toString();
    expect(formatUsd(amount)).toBe("$100.00");
  });

  it("formats small amounts", () => {
    const amount = toFixedPoint("0.01", COLLATERAL_DECIMALS);
    expect(formatUsd(amount)).toBe("$0.01");
  });
});

// ---------------------------------------------------------------------------
// shortenAddress
// ---------------------------------------------------------------------------

describe("shortenAddress", () => {
  it("shortens a standard address", () => {
    const addr = "0x1234567890abcdef1234567890abcdef12345678";
    expect(shortenAddress(addr)).toBe("0x1234...5678");
  });

  it("uses custom char count", () => {
    const addr = "0x1234567890abcdef1234567890abcdef12345678";
    expect(shortenAddress(addr, 6)).toBe("0x123456...345678");
  });

  it("returns short address unchanged", () => {
    const addr = "0x123456";
    expect(shortenAddress(addr)).toBe(addr);
  });

  it("throws for invalid prefix", () => {
    expect(() => shortenAddress("1234567890abcdef")).toThrow("expected \"0x\" prefix");
  });
});

// ---------------------------------------------------------------------------
// calculatePnl
// ---------------------------------------------------------------------------

describe("calculatePnl", () => {
  const oneEth = (10n ** 18n).toString();

  it("calculates positive PnL", () => {
    const avg = toFixedPoint("0.5").toString();
    const current = toFixedPoint("0.7").toString();
    const qty = oneEth;

    const result = calculatePnl(avg, current, qty);
    // (0.7 - 0.5) * 1 = 0.2
    expect(BigInt(result.absolute)).toBe(toFixedPoint("0.2"));
    expect(result.percentage).toBe("40.00");
  });

  it("calculates negative PnL", () => {
    const avg = toFixedPoint("0.7").toString();
    const current = toFixedPoint("0.5").toString();
    const qty = oneEth;

    const result = calculatePnl(avg, current, qty);
    expect(BigInt(result.absolute)).toBeLessThan(0n);
    expect(result.percentage).toBe("-28.57");
  });

  it("returns zero PnL when prices match", () => {
    const price = toFixedPoint("0.5").toString();
    const result = calculatePnl(price, price, oneEth);
    expect(BigInt(result.absolute)).toBe(0n);
    expect(Number(result.percentage)).toBe(0);
  });

  it("handles zero avg price gracefully", () => {
    const result = calculatePnl("0", toFixedPoint("0.5").toString(), oneEth);
    expect(Number(result.percentage)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// generateNonce
// ---------------------------------------------------------------------------

describe("generateNonce", () => {
  it("returns a bigint", () => {
    expect(typeof generateNonce()).toBe("bigint");
  });

  it("returns different values on successive calls", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
  });

  it("generates a positive value", () => {
    expect(generateNonce()).toBeGreaterThanOrEqual(0n);
  });
});
