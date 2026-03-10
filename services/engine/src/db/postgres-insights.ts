import type { Pool } from "pg";
import { NORM_ADDR, normalizeHexFragment } from "./postgres-helpers.js";
import type { MarketRow } from "./postgres-types.js";

export async function userHasDarkTrades(
  pool: Pool,
  address: string,
): Promise<boolean> {
  const tradeResult = await pool.query(
    `SELECT 1 FROM trades t
     JOIN markets m ON m.market_id = t.market_id
     WHERE (t.buyer = $1 OR t.seller = $1) AND m.market_type = 'private'
     LIMIT 1`,
    [address],
  );
  if (tradeResult.rows.length > 0) return true;

  const orderResult = await pool.query(
    `SELECT 1 FROM orders o
     JOIN markets m ON m.market_id = o.market_id
     WHERE o.user_address = $1 AND m.market_type = 'private'
       AND o.status IN ('OPEN', 'PARTIALLY_FILLED')
     LIMIT 1`,
    [address],
  );
  return orderResult.rows.length > 0;
}

export async function getMarketStats(
  pool: Pool,
  marketId: string,
): Promise<{
  volume24h: string;
  totalVolume: string;
  tradeCount: number;
  liquidity: string;
}> {
  const statsResult = await pool.query<{
    volume_24h: string;
    trade_count: string;
  }>(
    `SELECT
       COALESCE(SUM(price::NUMERIC * amount::NUMERIC), 0)::TEXT AS volume_24h,
       COUNT(*)::TEXT AS trade_count
     FROM trades
     WHERE market_id = $1
       AND created_at > NOW() - INTERVAL '24 hours'`,
    [marketId],
  );

  const marketResult = await pool.query<{
    total_volume: string;
    liquidity: string;
  }>(
    `SELECT total_volume::TEXT, liquidity::TEXT FROM markets WHERE market_id = $1`,
    [marketId],
  );

  const stats = statsResult.rows[0];
  const market = marketResult.rows[0];

  return {
    volume24h: stats?.volume_24h ?? "0",
    totalVolume: market?.total_volume ?? "0",
    tradeCount: Number(stats?.trade_count ?? 0),
    liquidity: market?.liquidity ?? "0",
  };
}

export async function getPriceHistory(
  pool: Pool,
  marketId: string,
  _outcomeIndex: number,
  interval: "1h" | "6h" | "1d" = "1h",
  limit = 168,
): Promise<Array<{ timestamp: Date; price: string; volume: string }>> {
  const intervalMap = { "1h": "1 hour", "6h": "6 hours", "1d": "1 day" };
  const truncMap = { "1h": "hour", "6h": "hour", "1d": "day" };
  const pgInterval = intervalMap[interval];
  const truncUnit = truncMap[interval];

  // For 6h interval, we floor to the nearest 6-hour block using epoch math.
  // For 1h/1d, plain date_trunc suffices.
  const bucketExpr =
    interval === "6h"
      ? `to_timestamp(floor(extract(epoch from created_at) / 21600) * 21600)`
      : `date_trunc('${truncUnit}', created_at)`;

  const result = await pool.query<{
    bucket: Date;
    avg_price: string;
    volume: string;
  }>(
    `SELECT
       ${bucketExpr} AS bucket,
       AVG(
         CASE WHEN outcome_index = 0 THEN price::NUMERIC
              ELSE 1 - price::NUMERIC
         END
       )::TEXT AS avg_price,
       SUM(amount::NUMERIC)::TEXT AS volume
     FROM trades
     WHERE market_id = $1
       AND created_at > NOW() - ($2::INTERVAL * $3)
     GROUP BY bucket
     ORDER BY bucket DESC
     LIMIT $3`,
    [marketId, pgInterval, limit],
  );

  return result.rows.map((row) => ({
    timestamp: row.bucket,
    price: row.avg_price,
    volume: row.volume,
  }));
}

export async function insertRedemption(
  pool: Pool,
  redemption: {
    userAddress: string;
    marketId: string;
    outcomeIndex: number;
    amount: string;
    payout: string;
    txHash: string;
    blockNumber: number;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO redemptions (user_address, market_id, outcome_index, amount, payout, tx_hash, block_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [
      redemption.userAddress,
      redemption.marketId,
      redemption.outcomeIndex,
      redemption.amount,
      redemption.payout,
      redemption.txHash,
      redemption.blockNumber,
    ],
  );
}

export async function hasRedeemed(
  pool: Pool,
  userAddress: string,
  marketId: string,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM redemptions WHERE user_address = $1 AND market_id = $2 LIMIT 1`,
    [userAddress, marketId],
  );
  return result.rows.length > 0;
}

export async function getClaimableRewards(
  pool: Pool,
  userAddress: string,
  getMarketById: (marketId: string) => Promise<MarketRow | null>,
): Promise<
  Array<{
    market_id: string;
    outcome_index: number;
    amount: string;
    market: MarketRow;
  }>
> {
  const result = await pool.query<{
    market_id: string;
    outcome_index: number;
    net_amount: string;
  }>(
    `SELECT t.market_id, t.outcome_index,
       SUM(CASE
         WHEN ${NORM_ADDR("t.buyer")} = $1 THEN t.amount::NUMERIC
         WHEN ${NORM_ADDR("t.seller")} = $1 THEN -t.amount::NUMERIC
         ELSE 0
       END)::TEXT AS net_amount
     FROM trades t
     JOIN markets m ON m.market_id = t.market_id
     WHERE (${NORM_ADDR("t.buyer")} = $1 OR ${NORM_ADDR("t.seller")} = $1)
       AND t.settled = true
       AND m.status = 'RESOLVED'
       AND m.winning_outcome IS NOT NULL
       AND t.outcome_index = m.winning_outcome
       AND NOT EXISTS (
         SELECT 1 FROM redemptions r
         WHERE ${NORM_ADDR("r.user_address")} = $1
           AND r.market_id = t.market_id
       )
     GROUP BY t.market_id, t.outcome_index
     HAVING SUM(CASE
       WHEN ${NORM_ADDR("t.buyer")} = $1 THEN t.amount::NUMERIC
       WHEN ${NORM_ADDR("t.seller")} = $1 THEN -t.amount::NUMERIC
       ELSE 0
     END) > 0`,
    [normalizeHexFragment(userAddress)],
  );

  const rewards = [];
  for (const row of result.rows) {
    const market = await getMarketById(row.market_id);
    if (market) {
      rewards.push({
        market_id: row.market_id,
        outcome_index: row.outcome_index,
        amount: row.net_amount,
        market,
      });
    }
  }
  return rewards;
}

export async function disconnect(pool: Pool): Promise<void> {
  await pool.end();
  console.log("[postgres] pool closed");
}

export async function healthCheck(pool: Pool): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
