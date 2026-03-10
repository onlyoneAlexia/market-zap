// ---------------------------------------------------------------------------
// AMM State Persistence — Redis-backed storage for LMSR pool state
// ---------------------------------------------------------------------------

import type { RedisClient } from "./db/redis.js";
import type { LmsrState } from "./amm.js";

// ---------------------------------------------------------------------------
// Redis Key
// ---------------------------------------------------------------------------

function getAmmKey(marketId: string): string {
  return `amm:${marketId}`;
}

// ---------------------------------------------------------------------------
// AmmStateManager
// ---------------------------------------------------------------------------

export class AmmStateManager {
  constructor(private readonly redis: RedisClient) {}

  /**
   * Initialize a new AMM pool for a market.
   *
   * @param marketId      Engine market identifier
   * @param b             Liquidity parameter (human-readable collateral units)
   * @param outcomeCount  Number of outcomes (2 for binary)
   */
  async initPool(
    marketId: string,
    b: number,
    outcomeCount: number,
  ): Promise<LmsrState> {
    const state: LmsrState = {
      marketId,
      b,
      quantities: new Array(outcomeCount).fill(0),
      active: true,
    };
    await this.saveState(state);
    return state;
  }

  /**
   * Batch-load AMM states for multiple markets in a single Redis MGET.
   * Returns a Map from marketId → LmsrState | null.
   */
  async mgetStates(marketIds: string[]): Promise<Map<string, LmsrState | null>> {
    const result = new Map<string, LmsrState | null>();
    if (!marketIds.length) return result;
    const keys = marketIds.map((id) => getAmmKey(id));
    const values = await this.redis.raw.mget(...keys);
    for (let i = 0; i < marketIds.length; i++) {
      const raw = values[i];
      if (!raw) {
        result.set(marketIds[i], null);
        continue;
      }
      try {
        const d = JSON.parse(raw) as {
          marketId: string;
          b: number;
          quantities: number[];
          active?: boolean;
        };
        result.set(marketIds[i], {
          marketId: d.marketId,
          b: d.b,
          quantities: d.quantities,
          active: d.active ?? true,
        });
      } catch {
        result.set(marketIds[i], null);
      }
    }
    return result;
  }

  /**
   * Load AMM state from Redis.  Returns null if no pool exists.
   */
  async loadState(marketId: string): Promise<LmsrState | null> {
    const raw = await this.redis.get(getAmmKey(marketId));
    if (!raw) return null;
    try {
      const d = JSON.parse(raw) as {
        marketId: string;
        b: number;
        quantities: number[];
        active?: boolean;
      };
      return {
        marketId: d.marketId,
        b: d.b,
        quantities: d.quantities,
        active: d.active ?? true,
      };
    } catch {
      console.error(
        `[amm-state] failed to parse AMM state for market ${marketId}`,
      );
      return null;
    }
  }

  /**
   * Persist AMM state to Redis (atomic single-key write).
   */
  async saveState(state: LmsrState): Promise<void> {
    await this.redis.set(
      getAmmKey(state.marketId),
      JSON.stringify({
        marketId: state.marketId,
        b: state.b,
        quantities: state.quantities,
        active: state.active,
      }),
    );
  }

  /**
   * Atomically load → mutate → save.
   *
   * Safe without Redis WATCH because the per-market lock in the Matcher
   * already serializes all matching for a given (market, outcome).
   *
   * Returns null if pool doesn't exist or is inactive.
   */
  async updateState(
    marketId: string,
    mutate: (state: LmsrState) => LmsrState | null,
  ): Promise<LmsrState | null> {
    const current = await this.loadState(marketId);
    if (!current || !current.active) return null;
    const updated = mutate(current);
    if (!updated) return null;
    await this.saveState(updated);
    return updated;
  }

  /**
   * Deactivate a pool (e.g., when market resolves).
   */
  async deactivatePool(marketId: string): Promise<void> {
    const state = await this.loadState(marketId);
    if (state) {
      state.active = false;
      await this.saveState(state);
    }
  }

  /**
   * Check whether a market has an active AMM pool.
   */
  async hasActivePool(marketId: string): Promise<boolean> {
    const state = await this.loadState(marketId);
    return state !== null && state.active;
  }

  /**
   * Delete pool state entirely.
   */
  async deletePool(marketId: string): Promise<void> {
    await this.redis.del(getAmmKey(marketId));
  }
}
