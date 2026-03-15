import pg from "pg";
import { NORM_ADDR, normalizeHexFragment } from "./postgres-helpers.js";
import { createTables as createSchemaTables } from "./postgres-schema.js";
import {
  disconnect as disconnectPool,
  getClaimableRewards as getClaimableRewardsQuery,
  getMarketStats as getMarketStatsQuery,
  getPriceHistory as getPriceHistoryQuery,
  hasRedeemed as hasRedeemedQuery,
  healthCheck as healthCheckPool,
  insertRedemption as insertRedemptionQuery,
  userHasDarkTrades as userHasDarkTradesQuery,
} from "./postgres-insights.js";
import type {
  DatabaseOptions,
  LeaderboardRow,
  MarketRow,
  OrderRow,
  PortfolioRow,
  TradeRow,
} from "./postgres-types.js";
export type {
  DatabaseOptions,
  LeaderboardRow,
  MarketRow,
  OrderRow,
  PortfolioRow,
  TradeRow,
} from "./postgres-types.js";

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Database class
// ---------------------------------------------------------------------------

export class Database {
  private pool: InstanceType<typeof Pool>;

  constructor(options: DatabaseOptions = {}) {
    const connectionString =
      options.connectionString ??
      process.env.DATABASE_URL ??
      "postgresql://localhost:5432/market_zap";

    this.pool = new Pool({
      connectionString,
      max: options.maxConnections ?? 50,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    this.pool.on("error", (err: Error) => {
      console.error("[postgres] unexpected pool error:", err.message);
    });
  }

  // -----------------------------------------------------------------------
  // Schema
  // -----------------------------------------------------------------------

  async createTables(): Promise<void> {
    await createSchemaTables(this.pool);
  }

  // -----------------------------------------------------------------------
  // Trades
  // -----------------------------------------------------------------------

  async insertTrade(trade: {
    marketId: string;
    outcomeIndex: number;
    buyer: string;
    seller: string;
    price: string;
    amount: string;
    fee?: string;
    side: "BID" | "ASK";
    buyerNonce: string;
    sellerNonce: string;
    txHash?: string;
    settled?: boolean;
    tradeCommitment?: string;
  }): Promise<TradeRow> {
    const result = await this.pool.query<TradeRow>(
      `INSERT INTO trades
         (market_id, outcome_index, buyer, seller, price, amount, fee, side,
          buyer_nonce, seller_nonce, tx_hash, settled, trade_commitment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        trade.marketId,
        trade.outcomeIndex,
        trade.buyer,
        trade.seller,
        trade.price,
        trade.amount,
        trade.fee ?? "0",
        trade.side,
        trade.buyerNonce,
        trade.sellerNonce,
        trade.txHash ?? null,
        trade.settled ?? false,
        trade.tradeCommitment ?? null,
      ],
    );
    return result.rows[0];
  }

  async getTradesByMarket(
    marketId: string,
    limit = 50,
    offset = 0,
  ): Promise<TradeRow[]> {
    const result = await this.pool.query<TradeRow>(
      `SELECT * FROM trades
       WHERE market_id = $1
         AND settlement_status != 'failed'
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [marketId, limit, offset],
    );
    return result.rows;
  }

  async getTraderCount(marketId: string, excludeAddress?: string): Promise<number> {
    const excludeAddr = normalizeHexFragment(excludeAddress ?? "");
    // Normalize: compare without leading zeros (Starknet addresses may differ in prefix)
    const result = await this.pool.query<{ traders: string }>(
      `SELECT COUNT(DISTINCT normalized_addr)::text AS traders
       FROM (
         SELECT LOWER(TRIM(LEADING '0' FROM REPLACE(buyer, '0x', ''))) AS normalized_addr
         FROM trades
         WHERE market_id = $1
           AND settlement_status != 'failed'
         UNION
         SELECT LOWER(TRIM(LEADING '0' FROM REPLACE(seller, '0x', ''))) AS normalized_addr
         FROM trades
         WHERE market_id = $1
           AND settlement_status != 'failed'
       ) t
       WHERE normalized_addr != ''
         AND normalized_addr != '0'
         AND normalized_addr != $2`,
      [marketId, excludeAddr],
    );
    return parseInt(result.rows[0]?.traders ?? "0", 10);
  }

  /**
   * Batch variant of getTraderCount to avoid N+1 queries in market lists.
   */
  async getTraderCountsByMarket(
    marketIds: string[],
    excludeAddress?: string,
  ): Promise<Record<string, number>> {
    if (marketIds.length === 0) return {};

    const excludeAddr = normalizeHexFragment(excludeAddress ?? "");
    const result = await this.pool.query<{ market_id: string; traders: string }>(
      `WITH mids AS (
         SELECT UNNEST($1::TEXT[]) AS market_id
       ),
       participants AS (
         SELECT
           t.market_id,
           LOWER(TRIM(LEADING '0' FROM REPLACE(t.buyer, '0x', ''))) AS normalized_addr
         FROM trades t
         JOIN mids m ON m.market_id = t.market_id
         WHERE t.settlement_status != 'failed'
         UNION
         SELECT
           t.market_id,
           LOWER(TRIM(LEADING '0' FROM REPLACE(t.seller, '0x', ''))) AS normalized_addr
         FROM trades t
         JOIN mids m ON m.market_id = t.market_id
         WHERE t.settlement_status != 'failed'
       )
       SELECT
         market_id,
         COUNT(DISTINCT normalized_addr)::TEXT AS traders
       FROM participants
       WHERE normalized_addr != ''
         AND normalized_addr != '0'
         AND normalized_addr != $2
       GROUP BY market_id`,
      [marketIds, excludeAddr],
    );

    const counts: Record<string, number> = Object.create(null);
    for (const id of marketIds) {
      counts[id] = 0;
    }
    for (const row of result.rows) {
      counts[row.market_id] = parseInt(row.traders, 10);
    }
    return counts;
  }

  async markTradeSettled(tradeId: string, txHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE trades SET settled = TRUE, tx_hash = $2, settlement_status = 'settled' WHERE id = $1`,
      [tradeId, txHash],
    );
  }

  async markTradeFailed(tradeId: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE trades SET settlement_status = 'failed', settlement_error = $2 WHERE id = $1`,
      [tradeId, error],
    );
  }

  /**
   * Get trades stuck in 'pending' settlement status — for retry on engine startup.
   */
  async getPendingTrades(): Promise<TradeRow[]> {
    const result = await this.pool.query<TradeRow>(
      `SELECT * FROM trades
       WHERE settlement_status = 'pending' AND settled = FALSE
       ORDER BY created_at ASC`,
    );
    return result.rows;
  }

  async getTradesByUser(
    userAddress: string,
    limit = 50,
    offset = 0,
  ): Promise<TradeRow[]> {
    const norm = normalizeHexFragment(userAddress);
    const result = await this.pool.query<TradeRow>(
      `SELECT * FROM trades
       WHERE (${NORM_ADDR('buyer')} = $1 OR ${NORM_ADDR('seller')} = $1)
         AND settlement_status != 'failed'
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [norm, limit, offset],
    );
    return result.rows;
  }

  // -----------------------------------------------------------------------
  // Order Reservations
  // -----------------------------------------------------------------------

  async insertOrderReservation(
    nonce: string,
    userAddress: string,
    collateralToken: string,
    reservedAmount: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO order_reservations (nonce, user_address, collateral_token, reserved_amount)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (nonce) DO NOTHING`,
      [nonce, userAddress, collateralToken, reservedAmount],
    );
  }

  async deleteOrderReservation(nonce: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM order_reservations WHERE nonce = $1`,
      [nonce],
    );
  }

  async getOpenOrderReservations(userAddress: string): Promise<bigint> {
    const norm = normalizeHexFragment(userAddress);
    const result = await this.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(reserved_amount), 0)::TEXT AS total
       FROM order_reservations WHERE ${NORM_ADDR('user_address')} = $1`,
      [norm],
    );
    return BigInt(result.rows[0]?.total ?? "0");
  }

  async insertOutcomeOrderReservation(
    nonce: string,
    userAddress: string,
    marketId: string,
    outcomeIndex: number,
    tokenId: string,
    reservedAmount: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO outcome_order_reservations
        (nonce, user_address, market_id, outcome_index, token_id, reserved_amount)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (nonce) DO NOTHING`,
      [nonce, userAddress, marketId, outcomeIndex, tokenId, reservedAmount],
    );
  }

  async deleteOutcomeOrderReservation(nonce: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM outcome_order_reservations WHERE nonce = $1`,
      [nonce],
    );
  }

  async getOpenOutcomeOrderReservations(
    userAddress: string,
    marketId: string,
    outcomeIndex: number,
  ): Promise<bigint> {
    const norm = normalizeHexFragment(userAddress);
    const result = await this.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(reserved_amount), 0)::TEXT AS total
       FROM outcome_order_reservations
       WHERE ${NORM_ADDR('user_address')} = $1 AND market_id = $2 AND outcome_index = $3`,
      [norm, marketId, outcomeIndex],
    );
    return BigInt(result.rows[0]?.total ?? "0");
  }

  /**
   * Get total amount of unsettled sell-side fills for a specific user + market outcome.
   * This tracks ERC-1155 inventory already consumed by matches pending on-chain settlement.
   */
  async getUnsettledSellAmount(
    userAddress: string,
    marketId: string,
    outcomeIndex: number,
  ): Promise<bigint> {
    const norm = normalizeHexFragment(userAddress);
    const result = await this.pool.query<{ total_amount: string }>(
      `SELECT COALESCE(SUM(amount::NUMERIC), 0)::TEXT AS total_amount
       FROM trades
       WHERE ${NORM_ADDR('seller')} = $1
         AND market_id = $2
         AND outcome_index = $3
         AND settled = FALSE
         AND settlement_status != 'failed'`,
      [norm, marketId, outcomeIndex],
    );
    return BigInt(result.rows[0]?.total_amount ?? "0");
  }

  /**
   * Get total cost of unsettled BID trades for a user.
   * Returns the sum of collateral debits that will be applied on-chain for
   * unsettled trades where the user is the buyer.
   *
   * Fee semantics (matches CLOBExchange):
   * - If the buyer is the taker (trade.side = 'BID'), the buyer pays cost + 1% fee.
   * - If the buyer is the maker (trade.side = 'ASK'), the buyer pays cost only
   *   (fee is taken from the seller's proceeds).
   */
  async getUnsettledBuyCosts(userAddress: string): Promise<bigint> {
    const norm = normalizeHexFragment(userAddress);
    const result = await this.pool.query<{ total_cost: string }>(
      `SELECT COALESCE(SUM(
        (
          amount::NUMERIC *
          price::NUMERIC *
          (CASE WHEN side = 'BID' THEN 1.01 ELSE 1.0 END)
        )::NUMERIC(78,0)
      ), 0)::TEXT AS total_cost
       FROM trades
       WHERE ${NORM_ADDR('buyer')} = $1 AND settled = FALSE AND settlement_status != 'failed'`,
      [norm],
    );
    return BigInt(result.rows[0]?.total_cost ?? "0");
  }

  // -----------------------------------------------------------------------
  // Markets
  // -----------------------------------------------------------------------

  async getMarkets(
    limit = 50,
    offset = 0,
    category?: string,
    status?: string,
    options?: {
      marketType?: "public" | "private";
      sortBy?: "volume" | "createdAt" | "resolutionTime";
      sortOrder?: "asc" | "desc";
      search?: string;
    },
  ): Promise<MarketRow[]> {
    let query = `SELECT * FROM markets WHERE condition_id IS NOT NULL AND condition_id != '' AND on_chain_market_id IS NOT NULL`;
    const params: unknown[] = [];
    let idx = 1;

    if (category) {
      query += ` AND category = $${idx++}`;
      params.push(category);
    }
    if (status) {
      query += ` AND status = $${idx++}`;
      params.push(status);
    }
    if (options?.marketType) {
      query += ` AND market_type = $${idx++}`;
      params.push(options.marketType);
    }
    if (options?.search) {
      query += ` AND title ILIKE $${idx++}`;
      params.push(`%${options.search}%`);
    }

    const sortColumnMap: Record<string, string> = {
      volume: "total_volume",
      createdAt: "created_at",
      resolutionTime: "resolution_time",
    };
    const sortCol = sortColumnMap[options?.sortBy ?? ""] ?? "created_at";
    const sortDir = options?.sortOrder === "asc" ? "ASC" : "DESC";
    query += ` ORDER BY ${sortCol} ${sortDir} LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await this.pool.query<MarketRow>(query, params);
    return result.rows;
  }

  async getMarketById(marketId: string): Promise<MarketRow | null> {
    const result = await this.pool.query<MarketRow>(
      `SELECT * FROM markets WHERE id::text = $1 OR market_id = $1`,
      [marketId],
    );
    return result.rows[0] ?? null;
  }

  async getMarketsByIds(ids: string[]): Promise<Map<string, MarketRow>> {
    const map = new Map<string, MarketRow>();
    if (!ids.length) return map;
    const result = await this.pool.query<MarketRow>(
      `SELECT * FROM markets WHERE market_id = ANY($1)`,
      [ids],
    );
    for (const row of result.rows) map.set(row.market_id, row);
    return map;
  }

  async getMarketByOnChainMarketId(onChainMarketId: string): Promise<MarketRow | null> {
    const result = await this.pool.query<MarketRow>(
      `SELECT * FROM markets WHERE on_chain_market_id = $1`,
      [onChainMarketId],
    );
    return result.rows[0] ?? null;
  }

  async getMarketByConditionId(conditionId: string): Promise<MarketRow | null> {
    const normalized = normalizeHexFragment(conditionId);
    const result = await this.pool.query<MarketRow>(
      `SELECT *
       FROM markets
       WHERE condition_id IS NOT NULL
         AND lower(
           coalesce(
             nullif(ltrim(replace(condition_id, '0x', ''), '0'), ''),
             '0'
           )
         ) = $1
       LIMIT 1`,
      [normalized],
    );
    return result.rows[0] ?? null;
  }

  async upsertMarket(market: {
    marketId: string;
    onChainMarketId?: string;
    conditionId?: string;
    title: string;
    description?: string;
    category?: string;
    outcomeCount: number;
    outcomeLabels: string[];
    collateralToken: string;
    resolutionSource?: string;
    resolutionTime?: Date;
    marketType?: 'public' | 'private';
    thumbnailUrl?: string;
  }): Promise<MarketRow> {
    const result = await this.pool.query<MarketRow>(
      `INSERT INTO markets
         (market_id, on_chain_market_id, condition_id, title, description, category, outcome_count,
          outcome_labels, collateral_token, resolution_source, resolution_time, market_type, thumbnail_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (market_id) DO UPDATE SET
         on_chain_market_id = COALESCE(EXCLUDED.on_chain_market_id, markets.on_chain_market_id),
         condition_id = COALESCE(EXCLUDED.condition_id, markets.condition_id),
         resolution_time = COALESCE(EXCLUDED.resolution_time, markets.resolution_time),
         market_type = COALESCE(EXCLUDED.market_type, markets.market_type),
         thumbnail_url = COALESCE(EXCLUDED.thumbnail_url, markets.thumbnail_url),
         updated_at = NOW()
       RETURNING *`,
      [
        market.marketId,
        market.onChainMarketId ?? null,
        market.conditionId ?? null,
        market.title,
        market.description ?? "",
        market.category ?? "general",
        market.outcomeCount,
        market.outcomeLabels,
        market.collateralToken,
        market.resolutionSource ?? "",
        market.resolutionTime ?? null,
        market.marketType ?? 'public',
        market.thumbnailUrl ?? null,
      ],
    );
    return result.rows[0];
  }

  async updateMarketVolume(
    marketId: string,
    volumeDelta: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE markets
       SET total_volume = total_volume + $2::NUMERIC, updated_at = NOW()
       WHERE market_id = $1`,
      [marketId, volumeDelta],
    );
  }

  async updateMarketStatus(
    marketId: string,
    status: MarketRow["status"],
    winningOutcome?: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE markets
       SET status = $2, winning_outcome = $3, updated_at = NOW()
       WHERE market_id = $1`,
      [marketId, status, winningOutcome ?? null],
    );
  }

  // -----------------------------------------------------------------------
  // Orders
  // -----------------------------------------------------------------------

  async upsertOrder(order: {
    marketId: string;
    outcomeIndex: number;
    userAddress: string;
    side: "BID" | "ASK";
    orderType: "LIMIT" | "MARKET";
    price: string;
    amount: string;
    filledAmount?: string;
    status?: OrderRow["status"];
    nonce: string;
    signature: string;
    expiry?: number;
  }): Promise<OrderRow> {
    const result = await this.pool.query<OrderRow>(
      `INSERT INTO orders
         (market_id, outcome_index, user_address, side, order_type,
          price, amount, filled_amount, status, nonce, signature, expiry)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (nonce) DO UPDATE SET
         filled_amount = EXCLUDED.filled_amount,
         status = EXCLUDED.status,
         updated_at = NOW()
       RETURNING *`,
      [
        order.marketId,
        order.outcomeIndex,
        order.userAddress,
        order.side,
        order.orderType,
        order.price,
        order.amount,
        order.filledAmount ?? "0",
        order.status ?? "OPEN",
        order.nonce,
        order.signature,
        order.expiry ?? 0,
      ],
    );
    return result.rows[0];
  }

  async updateOrderStatus(
    nonce: string,
    status: OrderRow["status"],
    filledAmount?: string,
  ): Promise<void> {
    if (filledAmount !== undefined) {
      await this.pool.query(
        `UPDATE orders
         SET status = $2, filled_amount = $3, updated_at = NOW()
         WHERE nonce = $1`,
        [nonce, status, filledAmount],
      );
    } else {
      await this.pool.query(
        `UPDATE orders SET status = $2, updated_at = NOW() WHERE nonce = $1`,
        [nonce, status],
      );
    }
  }

  /**
   * Look up a single order by its nonce.
   */
  async getOrderByNonce(nonce: string): Promise<OrderRow | null> {
    const result = await this.pool.query<OrderRow>(
      `SELECT * FROM orders WHERE nonce = $1 LIMIT 1`,
      [nonce],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Get open/partially-filled orders for a user, optionally filtered by market.
   * Used by the "My Orders" UI endpoint.
   */
  async getOpenOrders(
    userAddress: string,
    limit: number,
    offset: number,
    marketId?: string,
  ): Promise<OrderRow[]> {
    const params: unknown[] = [userAddress, limit, offset];
    // Exclude orders where every associated trade has failed settlement.
    // Such orders are effectively dead — the rollback will mark them
    // CANCELLED shortly, but this query ensures they never appear in the
    // meantime (race window between match and async rollback).
    let query = `SELECT o.* FROM orders o
      WHERE o.user_address = $1 AND o.status IN ('OPEN', 'PARTIALLY_FILLED')
        AND NOT (o.order_type = 'MARKET' AND o.status = 'PARTIALLY_FILLED')
        AND NOT EXISTS (
          SELECT 1 FROM trades t
          WHERE (t.buyer_nonce = o.nonce OR t.seller_nonce = o.nonce)
          HAVING COUNT(*) > 0
             AND COUNT(*) = COUNT(*) FILTER (WHERE t.settlement_status = 'failed')
        )`;
    if (marketId) {
      params.push(marketId);
      query += ` AND o.market_id = $${params.length}`;
    }
    query += ` ORDER BY o.created_at DESC LIMIT $2 OFFSET $3`;
    const result = await this.pool.query<OrderRow>(query, params);
    return result.rows;
  }

  /**
   * Get ALL open/partially-filled LIMIT orders for orderbook rebuild on startup.
   * Returns all open orders across all markets — no pagination.
   */
  async getOpenOrdersForRebuild(): Promise<OrderRow[]> {
    const result = await this.pool.query<OrderRow>(
      `SELECT * FROM orders
       WHERE status IN ('OPEN', 'PARTIALLY_FILLED')
         AND order_type = 'LIMIT'
       ORDER BY created_at ASC`,
    );
    return result.rows;
  }

  // -----------------------------------------------------------------------
  // Portfolio
  // -----------------------------------------------------------------------

  async getPortfolio(address: string): Promise<PortfolioRow[]> {
    const normAddr = normalizeHexFragment(address);
    const result = await this.pool.query<PortfolioRow>(
      `WITH user_trades AS (
        SELECT
          t.market_id,
          t.outcome_index,
          CASE
            WHEN ${NORM_ADDR('t.buyer')} = $1 THEN t.amount::NUMERIC
            ELSE -t.amount::NUMERIC
          END AS signed_amount,
          CASE
            WHEN ${NORM_ADDR('t.buyer')} = $1 THEN t.price::NUMERIC
            ELSE -t.price::NUMERIC
          END AS signed_price_contribution
        FROM trades t
        WHERE (${NORM_ADDR('t.buyer')} = $1 OR ${NORM_ADDR('t.seller')} = $1)
          AND t.settlement_status != 'failed'
      )
      SELECT
        ut.market_id,
        m.title,
        ut.outcome_index,
        m.outcome_labels[ut.outcome_index + 1] AS outcome_label,
        SUM(ut.signed_amount)::TEXT AS net_amount,
        CASE
          WHEN SUM(CASE WHEN ut.signed_amount > 0 THEN ut.signed_amount ELSE 0 END) = 0
          THEN '0'
          ELSE (
            SUM(CASE WHEN ut.signed_amount > 0 THEN ut.signed_price_contribution * ut.signed_amount ELSE 0 END) /
            NULLIF(SUM(CASE WHEN ut.signed_amount > 0 THEN ut.signed_amount ELSE 0 END), 0)
          )::TEXT
        END AS avg_price,
        '0' AS realized_pnl,
        '0' AS unrealized_pnl
      FROM user_trades ut
      JOIN markets m ON m.market_id = ut.market_id
      GROUP BY ut.market_id, m.title, ut.outcome_index, m.outcome_labels
      HAVING SUM(ut.signed_amount) <> 0
      ORDER BY ut.market_id, ut.outcome_index`,
      [normAddr],
    );
    return result.rows;
  }

  // -----------------------------------------------------------------------
  // Leaderboard
  // -----------------------------------------------------------------------

  async refreshLeaderboard(): Promise<void> {
    await this.pool.query(
      `REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard`,
    );
  }

  async getLeaderboard(limit = 50, offset = 0): Promise<LeaderboardRow[]> {
    const result = await this.pool.query<LeaderboardRow>(
      `SELECT * FROM leaderboard ORDER BY realized_pnl DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return result.rows;
  }

  // -----------------------------------------------------------------------
  // Dark market helpers
  // -----------------------------------------------------------------------

  /** Check if a user has any trades OR open orders in dark/private markets. */
  async userHasDarkTrades(address: string): Promise<boolean> {
    return userHasDarkTradesQuery(this.pool, address);
  }

  // -----------------------------------------------------------------------
  // Market stats (volume, price history)
  // -----------------------------------------------------------------------

  async getMarketStats(marketId: string): Promise<{
    volume24h: string;
    totalVolume: string;
    tradeCount: number;
    liquidity: string;
  }> {
    return getMarketStatsQuery(this.pool, marketId);
  }

  async getPriceHistory(
    marketId: string,
    outcomeCount: number,
    interval: "5m" | "15m" | "1h" | "6h" | "1d" = "1h",
    limit = 168,
  ): Promise<Array<{ timestamp: Date; prices: string[]; volume: string }>> {
    return getPriceHistoryQuery(this.pool, marketId, outcomeCount, interval, limit);
  }

  // -----------------------------------------------------------------------
  // Redemptions
  // -----------------------------------------------------------------------

  /**
   * Record an on-chain position redemption so it's excluded from claimable
   * rewards on subsequent queries.
   */
  async insertRedemption(redemption: {
    userAddress: string;
    marketId: string;
    outcomeIndex: number;
    amount: string;
    payout: string;
    txHash: string;
    blockNumber: number;
  }): Promise<void> {
    await insertRedemptionQuery(this.pool, redemption);
  }

  /**
   * Check if a user has already redeemed a specific market position.
   */
  async hasRedeemed(userAddress: string, marketId: string): Promise<boolean> {
    return hasRedeemedQuery(this.pool, userAddress, marketId);
  }

  // -----------------------------------------------------------------------
  // Claimable Rewards
  // -----------------------------------------------------------------------

  /**
   * Get claimable rewards for a user: resolved markets where the user holds
   * winning outcome tokens (net buy amount for the winning outcome > 0)
   * AND the user has not already redeemed the position.
   */
  async getClaimableRewards(userAddress: string): Promise<
    Array<{
      market_id: string;
      outcome_index: number;
      amount: string;
      market: MarketRow;
    }>
  > {
    return getClaimableRewardsQuery(
      this.pool,
      userAddress,
      (marketId) => this.getMarketById(marketId),
    );
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async disconnect(): Promise<void> {
    await disconnectPool(this.pool);
  }

  async healthCheck(): Promise<boolean> {
    return healthCheckPool(this.pool);
  }
}
