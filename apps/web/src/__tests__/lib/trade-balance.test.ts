import { describe, expect, it } from "vitest";
import {
  getMaxBuySharesRaw,
  getRequiredBuyCollateralRaw,
} from "@/lib/trade-balance";

describe("trade-balance", () => {
  it("uses the worst-case 100% price bound for market buys", () => {
    const requiredRaw = getRequiredBuyCollateralRaw({
      amountRaw: 17_970_000n,
      orderType: "market",
      effectivePrice: 0.5,
    });

    expect(requiredRaw).toBe(18_149_700n);
  });

  it("caps market-buy shares by deposited balance plus taker fee reserve", () => {
    const maxSharesRaw = getMaxBuySharesRaw({
      availableRaw: 17_980_000n,
      orderType: "market",
      effectivePrice: 0.5,
    });

    expect(maxSharesRaw).toBe(17_801_981n);
  });

  it("includes the fee reserve for limit buys too", () => {
    const maxSharesRaw = getMaxBuySharesRaw({
      availableRaw: 10_000_000n,
      orderType: "limit",
      effectivePrice: 0.5,
    });

    expect(maxSharesRaw).toBe(19_801_983n);
  });
});
