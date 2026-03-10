// ---------------------------------------------------------------------------
// LMSR (Logarithmic Market Scoring Rule) — Pure Math
//
// Stateless functions for computing prices, costs, and quotes.  The AMM state
// (quantities, liquidity parameter b) is managed externally by amm-state.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Persistent state for one AMM pool (one per market). */
export interface LmsrState {
  /** Market identifier (matches market_id in DB / Redis). */
  marketId: string;
  /**
   * Liquidity parameter b — controls depth and max loss.
   * Higher b = more liquidity, less price impact per trade.
   * Denominated in human-readable collateral units (e.g., 100 = 100 USDC).
   * Max loss the market maker can take = b * ln(outcomeCount).
   */
  b: number;
  /** Outstanding quantity of shares per outcome.  Length = outcomeCount. */
  quantities: number[];
  /** Whether this pool is accepting trades. */
  active: boolean;
}

export interface AmmQuote {
  /** Effective average execution price for this fill. */
  avgPrice: number;
  /** Total cost in collateral (positive = user pays, negative = user receives). */
  cost: number;
  /** Marginal price of the outcome AFTER the trade executes. */
  priceAfter: number;
  /** Slippage relative to the current spot price. */
  slippage: number;
  /** Whether the AMM can fill this amount without exceeding its limits. */
  canFill: boolean;
}

// ---------------------------------------------------------------------------
// Price boundaries — trades that push price beyond these are rejected.
// ---------------------------------------------------------------------------

const MIN_PRICE = 0.001;
const MAX_PRICE = 0.999;

// ---------------------------------------------------------------------------
// Core LMSR Math
// ---------------------------------------------------------------------------

/**
 * Cost function: C(q) = b × ln(Σ e^(q_i / b))
 *
 * Uses the **log-sum-exp trick** for numerical stability:
 *   ln(Σ e^x_i) = max(x) + ln(Σ e^(x_i − max(x)))
 */
export function costFunction(quantities: number[], b: number): number {
  const scaled = quantities.map((q) => q / b);
  const maxQ = Math.max(...scaled);
  const sumExp = scaled.reduce((sum, q) => sum + Math.exp(q - maxQ), 0);
  return b * (maxQ + Math.log(sumExp));
}

/**
 * Spot price of a single outcome:
 *   p_i = e^(q_i / b) / Σ e^(q_j / b)
 *
 * Prices always sum to 1.0 (complementary constraint).
 */
export function getPrice(
  quantities: number[],
  b: number,
  outcomeIndex: number,
): number {
  const scaled = quantities.map((q) => q / b);
  const maxQ = Math.max(...scaled);
  const exps = scaled.map((q) => Math.exp(q - maxQ));
  const sumExp = exps.reduce((a, v) => a + v, 0);
  return exps[outcomeIndex] / sumExp;
}

/**
 * All outcome prices at once.
 */
export function getAllPrices(quantities: number[], b: number): number[] {
  const scaled = quantities.map((q) => q / b);
  const maxQ = Math.max(...scaled);
  const exps = scaled.map((q) => Math.exp(q - maxQ));
  const sumExp = exps.reduce((a, v) => a + v, 0);
  return exps.map((e) => e / sumExp);
}

/**
 * Cost to trade `amount` shares of a single outcome.
 *
 *   cost = C(q + Δ·e_i) − C(q)
 *
 * Positive amount = buy (cost > 0).
 * Negative amount = sell (cost < 0, i.e. user receives collateral).
 */
export function getCostForTrade(
  quantities: number[],
  b: number,
  outcomeIndex: number,
  amount: number,
): number {
  const before = costFunction(quantities, b);
  const newQ = [...quantities];
  newQ[outcomeIndex] += amount;
  const after = costFunction(newQ, b);
  return after - before;
}

/**
 * Full quote for a potential trade against the AMM.
 *
 * @param state   Current pool state
 * @param outcomeIndex  Which outcome to trade
 * @param amount  Positive = buy, negative = sell
 */
export function quoteAmm(
  state: LmsrState,
  outcomeIndex: number,
  amount: number,
): AmmQuote {
  if (outcomeIndex < 0 || outcomeIndex >= state.quantities.length) {
    return { avgPrice: 0, cost: 0, priceAfter: 0, slippage: 0, canFill: false };
  }
  if (amount === 0) {
    const spot = getPrice(state.quantities, state.b, outcomeIndex);
    return { avgPrice: spot, cost: 0, priceAfter: spot, slippage: 0, canFill: true };
  }

  const spotBefore = getPrice(state.quantities, state.b, outcomeIndex);
  const cost = getCostForTrade(state.quantities, state.b, outcomeIndex, amount);
  const avgPrice = Math.abs(cost / amount);

  const newQ = [...state.quantities];
  newQ[outcomeIndex] += amount;
  const priceAfter = getPrice(newQ, state.b, outcomeIndex);

  const slippage =
    spotBefore > 0 ? Math.abs(avgPrice - spotBefore) / spotBefore : 0;

  // Reject if the trade would push any outcome price outside bounds.
  const allPricesAfter = getAllPrices(newQ, state.b);
  const canFill = allPricesAfter.every(
    (p) => p >= MIN_PRICE && p <= MAX_PRICE,
  );

  return { avgPrice, cost, priceAfter, slippage, canFill };
}

/**
 * Find the maximum amount that can be filled without pushing any price
 * outside [MIN_PRICE, MAX_PRICE] bounds.
 *
 * Uses binary search between 0 and the requested amount.
 * Returns 0 if no fill is possible (e.g., price already at boundary).
 *
 * @param state           Current pool state
 * @param outcomeIndex    Which outcome to trade
 * @param requestedAmount Positive = buy, negative = sell
 * @param tolerance       Convergence tolerance (default 0.01 share units)
 */
export function maxFillableAmount(
  state: LmsrState,
  outcomeIndex: number,
  requestedAmount: number,
  tolerance: number = 0.01,
): number {
  if (requestedAmount === 0) return 0;

  // Check if the full amount can fill — fast path
  const fullQuote = quoteAmm(state, outcomeIndex, requestedAmount);
  if (fullQuote.canFill) return requestedAmount;

  // Check if even a tiny amount can fill
  const direction = requestedAmount > 0 ? 1 : -1;
  const tinyAmount = direction * tolerance;
  const tinyQuote = quoteAmm(state, outcomeIndex, tinyAmount);
  if (!tinyQuote.canFill) return 0;

  // Binary search for the max fillable amount
  let lo = Math.abs(tolerance);
  let hi = Math.abs(requestedAmount);

  while (hi - lo > tolerance) {
    const mid = (lo + hi) / 2;
    const midQuote = quoteAmm(state, outcomeIndex, direction * mid);
    if (midQuote.canFill) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return direction * lo;
}

/**
 * Execute a trade — returns the new quantities and cost.
 * This is a **pure function**; the caller must persist the updated state.
 */
export function executeAmm(
  state: LmsrState,
  outcomeIndex: number,
  amount: number,
): { newQuantities: number[]; cost: number } {
  const cost = getCostForTrade(
    state.quantities,
    state.b,
    outcomeIndex,
    amount,
  );
  const newQuantities = [...state.quantities];
  newQuantities[outcomeIndex] += amount;
  return { newQuantities, cost };
}
