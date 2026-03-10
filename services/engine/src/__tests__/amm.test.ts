import { describe, it, expect } from "vitest";
import {
  costFunction,
  getPrice,
  getAllPrices,
  getCostForTrade,
  quoteAmm,
  executeAmm,
  type LmsrState,
} from "../amm.js";

// ---------------------------------------------------------------------------
// costFunction
// ---------------------------------------------------------------------------

describe("costFunction", () => {
  it("returns b * ln(n) for all-zero quantities", () => {
    // C([0,0], b) = b * ln(e^0 + e^0) = b * ln(2)
    expect(costFunction([0, 0], 100)).toBeCloseTo(100 * Math.LN2, 10);
  });

  it("returns b * ln(3) for 3 outcomes at zero", () => {
    expect(costFunction([0, 0, 0], 100)).toBeCloseTo(100 * Math.log(3), 10);
  });

  it("increases when any quantity increases", () => {
    const c1 = costFunction([0, 0], 100);
    const c2 = costFunction([10, 0], 100);
    expect(c2).toBeGreaterThan(c1);
  });

  it("is symmetric for equal quantities", () => {
    const c1 = costFunction([10, 10], 100);
    const c2 = costFunction([10, 10], 100);
    expect(c1).toBe(c2);
  });

  it("handles large quantities without overflow (log-sum-exp trick)", () => {
    // Without the trick, e^(10000/100) = e^100 would overflow
    const c = costFunction([10000, 0], 100);
    expect(Number.isFinite(c)).toBe(true);
    expect(c).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// getPrice / getAllPrices
// ---------------------------------------------------------------------------

describe("getPrice", () => {
  it("returns 0.5 for binary market with equal quantities", () => {
    expect(getPrice([0, 0], 100, 0)).toBeCloseTo(0.5, 10);
    expect(getPrice([0, 0], 100, 1)).toBeCloseTo(0.5, 10);
  });

  it("returns 1/3 for ternary market with equal quantities", () => {
    const p = getPrice([0, 0, 0], 100, 0);
    expect(p).toBeCloseTo(1 / 3, 10);
  });

  it("higher quantity = higher price", () => {
    expect(getPrice([50, 10], 100, 0)).toBeGreaterThan(
      getPrice([50, 10], 100, 1),
    );
  });

  it("prices from getAllPrices sum to 1.0 (binary)", () => {
    const prices = getAllPrices([30, 10], 100);
    expect(prices.reduce((a, b) => a + b, 0)).toBeCloseTo(1.0, 10);
  });

  it("prices from getAllPrices sum to 1.0 (ternary)", () => {
    const prices = getAllPrices([20, 50, 10], 100);
    expect(prices.reduce((a, b) => a + b, 0)).toBeCloseTo(1.0, 10);
  });

  it("prices from getAllPrices sum to 1.0 with large quantities", () => {
    const prices = getAllPrices([5000, 1000], 100);
    expect(prices.reduce((a, b) => a + b, 0)).toBeCloseTo(1.0, 10);
  });
});

// ---------------------------------------------------------------------------
// getCostForTrade
// ---------------------------------------------------------------------------

describe("getCostForTrade", () => {
  it("buying is positive cost", () => {
    expect(getCostForTrade([0, 0], 100, 0, 10)).toBeGreaterThan(0);
  });

  it("selling is negative cost (user receives)", () => {
    expect(getCostForTrade([10, 0], 100, 0, -10)).toBeLessThan(0);
  });

  it("buying 1 share at 50/50 costs ~0.5", () => {
    const cost = getCostForTrade([0, 0], 100, 0, 1);
    expect(cost).toBeGreaterThan(0.49);
    expect(cost).toBeLessThan(0.51);
  });

  it("higher b = less price impact for the same trade size", () => {
    const avgLowB = getCostForTrade([0, 0], 10, 0, 10) / 10;
    const avgHighB = getCostForTrade([0, 0], 1000, 0, 10) / 10;
    // Higher b → avg price stays closer to 0.5
    expect(Math.abs(avgHighB - 0.5)).toBeLessThan(Math.abs(avgLowB - 0.5));
  });

  it("cost scales roughly linearly for small trades", () => {
    const cost1 = getCostForTrade([0, 0], 1000, 0, 1);
    const cost2 = getCostForTrade([0, 0], 1000, 0, 2);
    // For very small trades relative to b, cost2 ≈ 2 × cost1
    expect(cost2 / cost1).toBeCloseTo(2, 1);
  });

  it("round-trip buy then sell returns close to original cost", () => {
    // Buy 10 shares, then sell 10 shares
    const buyCost = getCostForTrade([0, 0], 100, 0, 10);
    const sellRevenue = getCostForTrade([10, 0], 100, 0, -10);
    // Net should be close to zero (exact for LMSR — it's path-independent)
    expect(buyCost + sellRevenue).toBeCloseTo(0, 10);
  });
});

// ---------------------------------------------------------------------------
// quoteAmm
// ---------------------------------------------------------------------------

describe("quoteAmm", () => {
  const state: LmsrState = {
    marketId: "m1",
    b: 100,
    quantities: [0, 0],
    active: true,
  };

  it("returns canFill=true for a reasonable buy", () => {
    const q = quoteAmm(state, 0, 10);
    expect(q.canFill).toBe(true);
    expect(q.cost).toBeGreaterThan(0);
    expect(q.avgPrice).toBeCloseTo(0.5, 1);
  });

  it("returns canFill=true for a reasonable sell", () => {
    const sellState: LmsrState = { ...state, quantities: [50, 0] };
    const q = quoteAmm(sellState, 0, -10);
    expect(q.canFill).toBe(true);
    expect(q.cost).toBeLessThan(0); // user receives collateral
  });

  it("returns canFill=false for extreme trade that exhausts pool", () => {
    const q = quoteAmm(state, 0, 100000);
    expect(q.canFill).toBe(false);
  });

  it("returns zero-cost quote for amount=0", () => {
    const q = quoteAmm(state, 0, 0);
    expect(q.cost).toBe(0);
    expect(q.canFill).toBe(true);
    expect(q.avgPrice).toBeCloseTo(0.5, 10);
  });

  it("returns canFill=false for invalid outcomeIndex", () => {
    const q = quoteAmm(state, 5, 10);
    expect(q.canFill).toBe(false);
  });

  it("reports non-zero slippage for large trades", () => {
    const q = quoteAmm(state, 0, 50);
    expect(q.slippage).toBeGreaterThan(0);
  });

  it("reports priceAfter > spotBefore for buys", () => {
    const spotBefore = getPrice(state.quantities, state.b, 0);
    const q = quoteAmm(state, 0, 20);
    expect(q.priceAfter).toBeGreaterThan(spotBefore);
  });
});

// ---------------------------------------------------------------------------
// executeAmm
// ---------------------------------------------------------------------------

describe("executeAmm", () => {
  it("returns updated quantities and positive cost for buy", () => {
    const state: LmsrState = {
      marketId: "m1",
      b: 100,
      quantities: [0, 0],
      active: true,
    };
    const { newQuantities, cost } = executeAmm(state, 0, 10);
    expect(newQuantities).toEqual([10, 0]);
    expect(cost).toBeGreaterThan(0);
  });

  it("returns negative cost for sell", () => {
    const state: LmsrState = {
      marketId: "m1",
      b: 100,
      quantities: [20, 0],
      active: true,
    };
    const { newQuantities, cost } = executeAmm(state, 0, -10);
    expect(newQuantities).toEqual([10, 0]);
    expect(cost).toBeLessThan(0);
  });

  it("does not mutate the original state", () => {
    const state: LmsrState = {
      marketId: "m1",
      b: 100,
      quantities: [0, 0],
      active: true,
    };
    executeAmm(state, 0, 10);
    expect(state.quantities).toEqual([0, 0]);
  });

  it("works for multi-outcome markets", () => {
    const state: LmsrState = {
      marketId: "m1",
      b: 100,
      quantities: [0, 0, 0],
      active: true,
    };
    const { newQuantities } = executeAmm(state, 1, 5);
    expect(newQuantities).toEqual([0, 5, 0]);
  });
});
