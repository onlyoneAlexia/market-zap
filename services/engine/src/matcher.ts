import { OrderBook, type OrderEntry } from "./orderbook.js";
import { AmmStateManager } from "./amm-state.js";
import { quoteAmm, executeAmm, maxFillableAmount } from "./amm.js";

// ---------------------------------------------------------------------------
// Per-market mutex to prevent concurrent matching on the same book.
// ---------------------------------------------------------------------------

const marketLocks = new Map<string, Promise<void>>();

export function marketOutcomeLockKey(
  marketId: string,
  outcomeIndex: number,
): string {
  return `${marketId}:${outcomeIndex}`;
}

export function withMarketLock<T>(
  marketKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = marketLocks.get(marketKey) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn after previous resolves (or rejects)
  // Store the chain (void) so the next caller waits for us.
  marketLocks.set(marketKey, next.then(() => {}, () => {}));
  return next;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-order info carried through to settlement. */
export interface TradeOrderInfo {
  trader: string;
  price: string;
  amount: string;
  nonce: string;
  expiry: number;
  signature: string;
  isBuy: boolean;
}

export interface Trade {
  /** UUID assigned by the engine (not on-chain yet). */
  id: string;
  marketId: string;
  outcomeIndex: number;
  buyer: string;
  seller: string;
  /** Execution price. */
  price: string;
  /** Fill amount for this match. */
  fillAmount: string;
  buyerNonce: string;
  sellerNonce: string;
  /** Timestamp of the match. */
  matchedAt: string;
  /** Maker (resting) order info for on-chain settlement. */
  makerOrder: TradeOrderInfo;
  /** Taker (incoming) order info for on-chain settlement. */
  takerOrder: TradeOrderInfo;
  /** Whether this AMM trade needs auto-split (admin lacks outcome tokens). */
  needsAutoSplit?: boolean;
}

/** An order that was consumed (fully or partially) from the book during matching. */
export interface ConsumedOrder {
  /** The order in its original state before matching consumed it. */
  original: OrderEntry;
  /** The new remaining amount string after matching, or null if fully consumed. */
  newRemaining: string | null;
}

export interface MatchResult {
  /** Trades produced by the match. */
  trades: Trade[];
  /** Remaining unfilled amount of the incoming order (0 if fully filled). */
  remainingAmount: bigint;
  /** Whether the incoming order was added to the book as a resting order. */
  restingOnBook: boolean;
  /** Orders consumed from the book during matching — for rollback on settlement failure. */
  consumedOrders: ConsumedOrder[];
  /** AMM state snapshot before matching — for rollback on settlement failure. */
  preMatchAmmState: unknown | null;
  /** AMM state snapshot after CLOB fills but before AMM fill — for AMM-only rollback. */
  postClobAmmState: unknown | null;
  /** The resting order entry placed on the book, if any — for rollback. */
  restedOrder: OrderEntry | null;
}

// ---------------------------------------------------------------------------
// AMM Configuration (optional — AMM is an enhancement, not required)
// ---------------------------------------------------------------------------

/** Parameters for signing an admin order (matches OrderHashParams in shared). */
export interface AmmSignParams {
  trader: string;
  marketId: bigint;
  tokenId: bigint;
  isBuy: boolean;
  price: bigint;
  amount: bigint;
  nonce: bigint;
  expiry: bigint;
}

/** Market info needed to build the on-chain admin order for AMM fills. */
export interface AmmMarketInfo {
  onChainMarketId: string;
  conditionId: string;
  collateralDecimals: number;
  collateralToken?: string;
}

export interface AmmConfig {
  ammState: AmmStateManager;
  adminAddress: string;
  /** Sign an order with the admin's Stark private key. */
  signAdminOrder: (params: AmmSignParams) => string;
  /** Resolve on-chain IDs for a given engine market ID. */
  getMarketInfo: (marketId: string) => Promise<AmmMarketInfo | null>;
  /** Compute token ID from condition ID + outcome index. */
  computeTokenId: (conditionId: string, outcomeIndex: number) => bigint;
  /** Scale a decimal price string to 18-decimal fixed-point bigint. */
  scalePrice: (price: string | number) => bigint;
  /** Check admin's deposited exchange collateral balance (for AMM buys). */
  checkAdminCollateralBalance?: (token: string) => Promise<bigint>;
  /** Check admin's ERC-1155 outcome token balance (for AMM sells). */
  checkAdminOutcomeBalance?: (tokenId: string) => Promise<bigint>;
}

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

export class Matcher {
  constructor(
    private readonly book: OrderBook,
    private readonly ammConfig?: AmmConfig,
  ) {}

  /**
   * Match an incoming order against the resting order book.
   *
   * **Partial fills (per nonce):**
   * The on-chain exchange tracks filled amounts per (trader, nonce), allowing
   * an order to be filled multiple times until `filled == amount`.
   *
   * Engine invariants:
   * - `OrderEntry.amount` is the original signed amount (on-chain Order.amount).
   * - `OrderEntry.remainingAmount` is the off-chain remaining amount used for
   *   matching and book display.
   *
   * **Hybrid CLOB + AMM:**
   * CLOB always takes priority (better prices via real limit orders). If there
   * is remaining unfilled amount and an AMM pool exists, the matcher attempts
   * to fill the remainder against the AMM (admin as counterparty).
   */
  async match(incoming: OrderEntry): Promise<MatchResult> {
    // Serialize matching per (market, outcome) to prevent concurrent matches
    // from double-spending the same resting order.
    const lockKey = marketOutcomeLockKey(incoming.marketId, incoming.outcomeIndex);
    return withMarketLock(lockKey, () => this._matchInner(incoming));
  }

  /**
   * Run an arbitrary operation under the same per-(market,outcome) lock used
   * by matching so cancel/match paths cannot interleave on the same book.
   */
  async withLock<T>(
    marketId: string,
    outcomeIndex: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    return withMarketLock(marketOutcomeLockKey(marketId, outcomeIndex), fn);
  }

  private async _matchInner(incoming: OrderEntry): Promise<MatchResult> {
    const trades: Trade[] = [];
    const consumedOrders: ConsumedOrder[] = [];
    let remaining = BigInt(incoming.remainingAmount);
    const oppositeSide: "BID" | "ASK" =
      incoming.side === "BID" ? "ASK" : "BID";
    const PRICE_SCALE = 1_000_000_000_000_000_000n;
    const adminAddressLower = this.ammConfig?.adminAddress.toLowerCase() ?? null;
    let adminOutcomeConsumedByClob = 0n;
    let adminCollateralConsumedByClob = 0n;

    // Snapshot AMM state BEFORE any fills (CLOB or AMM) so we can rollback
    // both CLOB-synced quantities and AMM quantities on settlement failure.
    let preMatchAmmState: unknown | null = null;
    if (this.ammConfig) {
      const ammSt = await this.ammConfig.ammState.loadState(incoming.marketId);
      if (ammSt) {
        preMatchAmmState = { ...ammSt, quantities: [...ammSt.quantities] };
      }
    }

    // Walk the book top-of-book repeatedly until we either fill the incoming
    // order or it is no longer marketable.
    while (remaining > 0n) {
      // Fetch the best resting order on the opposite side.
      const best =
        oppositeSide === "ASK"
          ? await this.book.getBestAsk(incoming.marketId, incoming.outcomeIndex)
          : await this.book.getBestBid(incoming.marketId, incoming.outcomeIndex);

      if (!best) break;

      // B6b: Skip expired resting orders during matching.
      const nowSec = Math.floor(Date.now() / 1000);
      if (best.expiry > 0 && best.expiry <= nowSec) {
        await this.book.removeOrder(best);
        continue;
      }

      if (!isPriceMarketable(incoming, best)) break;

      // Skip self-trades — same user on both sides.
      if (incoming.user.toLowerCase() === best.user.toLowerCase()) {
        break;
      }

      const restingRemaining = BigInt(best.remainingAmount);
      if (restingRemaining <= 0n) {
        // Defensive: should never happen, but keep the book clean.
        await this.book.removeOrder(best);
        continue;
      }

      const fillAmount =
        remaining < restingRemaining ? remaining : restingRemaining;

      // Determine buyer / seller.
      const buyer = incoming.side === "BID" ? incoming.user : best.user;
      const seller = incoming.side === "ASK" ? incoming.user : best.user;
      const buyerNonce =
        incoming.side === "BID" ? incoming.nonce : best.nonce;
      const sellerNonce =
        incoming.side === "ASK" ? incoming.nonce : best.nonce;

      // Execution price is always the resting order's price (price improvement
      // for the taker / incoming order).
      const executionPrice = best.price;
      if (
        this.ammConfig &&
        adminAddressLower &&
        best.user.toLowerCase() === adminAddressLower
      ) {
        if (incoming.side === "BID") {
          // Incoming buy matched admin ASK; this consumes admin outcome-token inventory.
          adminOutcomeConsumedByClob += fillAmount;
        } else {
          // Incoming sell matched admin BID; this consumes admin collateral budget.
          const executionCost =
            (fillAmount * this.ammConfig.scalePrice(executionPrice)) / PRICE_SCALE;
          adminCollateralConsumedByClob += executionCost;
        }
      }

      // The resting order is the maker; the incoming order is the taker.
      // IMPORTANT: `amount` is the original signed amount, not the remaining.
      const makerOrder: TradeOrderInfo = {
        trader: best.user,
        price: best.price,
        amount: best.amount,
        nonce: best.nonce,
        expiry: best.expiry,
        signature: best.signature,
        isBuy: best.side === "BID",
      };
      const takerOrder: TradeOrderInfo = {
        trader: incoming.user,
        price: incoming.price,
        amount: incoming.amount,
        nonce: incoming.nonce,
        expiry: incoming.expiry,
        signature: incoming.signature,
        isBuy: incoming.side === "BID",
      };

      // Snapshot the original order BEFORE mutating the book (for rollback).
      const originalBest = { ...best };

      // Update the resting order remaining amount.
      const newRestingRemaining = restingRemaining - fillAmount;
      if (newRestingRemaining === 0n) {
        const removed = await this.book.removeOrder(best);
        if (!removed) {
          // A concurrent cancel on another engine replica can remove this
          // level first; skip this candidate and refresh top-of-book.
          continue;
        }
        consumedOrders.push({ original: originalBest, newRemaining: null });
      } else {
        // Replace with updated remainingAmount (price + signature remain intact).
        const removed = await this.book.removeOrder(best);
        if (!removed) {
          continue;
        }
        await this.book.addOrder({
          ...best,
          remainingAmount: newRestingRemaining.toString(),
        });
        consumedOrders.push({
          original: originalBest,
          newRemaining: newRestingRemaining.toString(),
        });
      }

      trades.push({
        id: generateTradeId(),
        marketId: incoming.marketId,
        outcomeIndex: incoming.outcomeIndex,
        buyer,
        seller,
        price: executionPrice,
        fillAmount: fillAmount.toString(),
        buyerNonce,
        sellerNonce,
        matchedAt: new Date().toISOString(),
        makerOrder,
        takerOrder,
      });

      remaining -= fillAmount;
    }

    // -----------------------------------------------------------------------
    // Sync AMM state with CLOB fills — so the LMSR price reflects all trades,
    // not just AMM-filled trades.  We sum up all CLOB-filled quantity and
    // adjust the AMM quantities accordingly (buy → increase q_i, sell → decrease).
    // -----------------------------------------------------------------------
    if (trades.length > 0 && this.ammConfig) {
      const ammSt = await this.ammConfig.ammState.loadState(incoming.marketId);
      if (ammSt && ammSt.active) {
        const { collateralDecimals } = (await this.ammConfig.getMarketInfo(incoming.marketId)) ?? { collateralDecimals: 6 };
        let totalClobFillHuman = 0;
        for (const t of trades) {
          totalClobFillHuman += Number(t.fillAmount) / 10 ** collateralDecimals;
        }
        if (totalClobFillHuman > 0) {
          const direction = incoming.side === "BID" ? 1 : -1;
          const newQ = [...ammSt.quantities];
          newQ[incoming.outcomeIndex] += direction * totalClobFillHuman;
          await this.ammConfig.ammState.saveState({ ...ammSt, quantities: newQ });
        }
      }
    }

    // Snapshot AMM state AFTER CLOB fills (for AMM-only rollback).
    let postClobAmmState: unknown | null = null;
    if (this.ammConfig) {
      const ammSt = await this.ammConfig.ammState.loadState(incoming.marketId);
      if (ammSt) {
        postClobAmmState = { ...ammSt, quantities: [...ammSt.quantities] };
      }
    }

    // -----------------------------------------------------------------------
    // AMM fallback — try the LMSR AMM for any remaining amount.
    // -----------------------------------------------------------------------
    if (remaining > 0n && this.ammConfig) {
      const ammTrade = await this._tryAmmFill(incoming, remaining, {
        adminOutcomeConsumedByClob,
        adminCollateralConsumedByClob,
      });
      if (ammTrade) {
        trades.push(ammTrade);
        remaining -= BigInt(ammTrade.fillAmount);
      }
    }

    // If no fills happened at all, clear the AMM snapshot (nothing to rollback).
    if (trades.length === 0) {
      preMatchAmmState = null;
    }

    // If no match was found (neither CLOB nor AMM) and LIMIT → rest on book.
    let restingOnBook = false;
    let restedOrder: OrderEntry | null = null;
    if (remaining > 0n && incoming.orderType === "LIMIT") {
      restedOrder = {
        ...incoming,
        remainingAmount: remaining.toString(),
      };
      await this.book.addOrder(restedOrder);
      restingOnBook = true;
    }

    return {
      trades,
      remainingAmount: remaining,
      restingOnBook,
      consumedOrders,
      preMatchAmmState,
      postClobAmmState,
      restedOrder,
    };
  }

  // -------------------------------------------------------------------------
  // AMM Fill
  // -------------------------------------------------------------------------

  private async _tryAmmFill(
    incoming: OrderEntry,
    amount: bigint,
    clobAdminConsumption: {
      adminOutcomeConsumedByClob: bigint;
      adminCollateralConsumedByClob: bigint;
    },
  ): Promise<Trade | null> {
    if (!this.ammConfig) return null;

    const {
      ammState,
      adminAddress,
      signAdminOrder,
      getMarketInfo,
      computeTokenId,
      scalePrice,
      checkAdminCollateralBalance,
      checkAdminOutcomeBalance,
    } = this.ammConfig;

    // AMM counterparty is the admin — reject if incoming user IS the admin.
    if (incoming.user.toLowerCase() === adminAddress.toLowerCase()) {
      return null;
    }

    // Load pool state.
    const state = await ammState.loadState(incoming.marketId);
    if (!state || !state.active) return null;

    // Resolve on-chain market IDs for signing.
    const marketInfo = await getMarketInfo(incoming.marketId);
    if (!marketInfo) return null;

    const { collateralDecimals } = marketInfo;

    const tokenId = computeTokenId(
      marketInfo.conditionId,
      incoming.outcomeIndex,
    );

    // Check admin outcome-token inventory. If insufficient, the trade will
    // proceed with needsAutoSplit=true — settlement will auto-split collateral
    // into outcome tokens atomically.
    let maxMatchAmount = amount;
    let needsAutoSplit = false;
    if (incoming.side === "BID" && checkAdminOutcomeBalance) {
      try {
        const adminOutcomeBalance = await checkAdminOutcomeBalance(tokenId.toString());
        const consumedByClob = clobAdminConsumption.adminOutcomeConsumedByClob;
        const adminOutcomeAvailable = adminOutcomeBalance > consumedByClob
          ? adminOutcomeBalance - consumedByClob
          : 0n;
        if (adminOutcomeAvailable < maxMatchAmount) {
          needsAutoSplit = true;
          // Don't cap — auto-split will mint the missing tokens during settlement.
        }
      } catch (err) {
        // Can't verify inventory — proceed with auto-split flag so settlement
        // handles it (will check balances again and split if needed).
        console.warn(
          "[matcher] could not verify admin outcome-token inventory, proceeding with auto-split",
          err instanceof Error ? err.message : err,
        );
        needsAutoSplit = true;
      }
    }

    // Convert from token units (e.g. 5000000 = 5 USDC) to human-readable
    // for LMSR math (which operates in "share units").
    const amountHuman = Number(maxMatchAmount) / 10 ** collateralDecimals;
    if (amountHuman <= 0 || !Number.isFinite(amountHuman)) return null;

    // AMM direction:
    //   incoming BID (buy)  → AMM sells → quantities increase
    //   incoming ASK (sell) → AMM buys  → quantities decrease
    const ammAmount = incoming.side === "BID" ? amountHuman : -amountHuman;

    // Get quote — try full amount first, fall back to partial-to-boundary.
    let actualAmmAmount = ammAmount;
    let actualFillAmount = maxMatchAmount;
    let quote = quoteAmm(state, incoming.outcomeIndex, ammAmount);

    if (!quote.canFill) {
      // Binary search for the max fillable amount within price bounds.
      const maxFillable = maxFillableAmount(
        state,
        incoming.outcomeIndex,
        ammAmount,
        0.01,
      );
      if (maxFillable === 0) return null;

      actualAmmAmount = maxFillable;
      const absHuman = Math.abs(maxFillable);
      actualFillAmount = BigInt(Math.round(absHuman * 10 ** collateralDecimals));
      if (actualFillAmount <= 0n) return null;

      quote = quoteAmm(state, incoming.outcomeIndex, actualAmmAmount);
      if (!quote.canFill) return null;
    }

    // For LIMIT orders, ensure the AMM's average price respects the limit.
    if (incoming.orderType === "LIMIT") {
      const limitPrice = Number(incoming.price);
      if (incoming.side === "BID" && quote.avgPrice > limitPrice) {
        return null; // AMM too expensive
      }
      if (incoming.side === "ASK" && quote.avgPrice < limitPrice) {
        return null; // AMM price too low
      }
    }

    // Pre-check: if admin is buying (user selling), verify admin has enough
    // deposited collateral for reserve_balance in settle_trade.
    if (incoming.side === "ASK" && checkAdminCollateralBalance) {
      try {
        const adminBalance = await checkAdminCollateralBalance(
          marketInfo.collateralToken ?? "",
        );
        const consumedByClob = clobAdminConsumption.adminCollateralConsumedByClob;
        if (adminBalance <= consumedByClob) {
          console.warn(
            `[matcher] AMM skipped: admin collateral fully consumed by CLOB fills (${consumedByClob})`,
          );
          return null;
        }
        const adminAvailable = adminBalance - consumedByClob;
        const executionCost =
          (actualFillAmount * scalePrice(quote.avgPrice.toFixed(18))) /
          BigInt(1e18);
        if (adminAvailable < executionCost) {
          console.warn(
            `[matcher] AMM skipped: admin available ${adminAvailable} < cost ${executionCost}`,
          );
          return null;
        }
      } catch (err) {
        // RPC error — proceed anyway (same as BUY-side auto-split fallback).
        // Settlement will perform its own on-chain balance checks; if the
        // admin truly lacks collateral, the tx will revert and be rolled back.
        console.warn(
          "[matcher] could not verify admin collateral balance, proceeding anyway",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Execute (pure — doesn't persist yet).
    const { newQuantities, cost: _cost } = executeAmm(
      state,
      incoming.outcomeIndex,
      actualAmmAmount,
    );

    // Persist updated AMM state.
    await ammState.saveState({ ...state, quantities: newQuantities });

    // Build admin counterparty order.
    const adminIsBuy = incoming.side === "ASK"; // admin buys when user sells
    const executionPrice = quote.avgPrice.toFixed(18);
    const adminNonce = generateAmmNonce();
    const adminExpiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour

    const signParams = {
      trader: adminAddress,
      marketId: BigInt(marketInfo.onChainMarketId),
      tokenId,
      isBuy: adminIsBuy,
      price: scalePrice(executionPrice),
      amount: actualFillAmount,
      nonce: BigInt(adminNonce),
      expiry: BigInt(adminExpiry),
    };
    const adminSig = signAdminOrder(signParams);

    // Construct Trade.
    const buyer = incoming.side === "BID" ? incoming.user : adminAddress;
    const seller = incoming.side === "ASK" ? incoming.user : adminAddress;

    const makerOrder: TradeOrderInfo = {
      trader: adminAddress,
      price: executionPrice,
      amount: actualFillAmount.toString(),
      nonce: adminNonce,
      expiry: adminExpiry,
      signature: adminSig,
      isBuy: adminIsBuy,
    };

    const takerOrder: TradeOrderInfo = {
      trader: incoming.user,
      price: incoming.price,
      amount: incoming.amount,
      nonce: incoming.nonce,
      expiry: incoming.expiry,
      signature: incoming.signature,
      isBuy: incoming.side === "BID",
    };

    return {
      id: generateTradeId(),
      marketId: incoming.marketId,
      outcomeIndex: incoming.outcomeIndex,
      buyer,
      seller,
      price: executionPrice,
      fillAmount: actualFillAmount.toString(),
      buyerNonce: incoming.side === "BID" ? incoming.nonce : adminNonce,
      sellerNonce: incoming.side === "ASK" ? incoming.nonce : adminNonce,
      matchedAt: new Date().toISOString(),
      makerOrder,
      takerOrder,
      needsAutoSplit,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether the incoming order's limit price is compatible with the
 * resting order's price.
 *
 * - An incoming BID is marketable against a resting ASK when bid >= ask.
 * - An incoming ASK is marketable against a resting BID when ask <= bid.
 * - Market orders are always marketable.
 */
function isPriceMarketable(
  incoming: OrderEntry,
  resting: OrderEntry,
): boolean {
  if (incoming.orderType === "MARKET") return true;

  const incomingPrice = Number(incoming.price);
  const restingPrice = Number(resting.price);

  if (incoming.side === "BID") {
    // Buyer willing to pay at least the ask price.
    return incomingPrice >= restingPrice;
  }
  // Seller willing to accept at most the bid price.
  return incomingPrice <= restingPrice;
}

let tradeCounter = 0;

function generateTradeId(): string {
  tradeCounter += 1;
  const ts = Date.now().toString(36);
  const seq = tradeCounter.toString(36).padStart(6, "0");
  const rand = Math.random().toString(36).slice(2, 8);
  return `trade_${ts}_${seq}_${rand}`;
}

/**
 * Generate a collision-resistant AMM nonce.
 * Combines high-resolution timestamp with a random component so that
 * nonces are unique even across engine restarts or concurrent replicas.
 * The on-chain contract tracks filled amounts per (trader, nonce), so
 * collisions would corrupt accounting.
 */
function generateAmmNonce(): string {
  const ts = BigInt(Date.now()) * 1000000n;
  const rand = BigInt(Math.floor(Math.random() * 999999));
  return (ts + rand).toString();
}
