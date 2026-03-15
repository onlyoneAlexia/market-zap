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
  outcomeCount: number,
  interval: "5m" | "15m" | "1h" | "6h" | "1d" = "1h",
  limit = 168,
): Promise<Array<{ timestamp: Date; prices: string[]; volume: string }>> {
  const normalizedOutcomeCount = Math.max(2, outcomeCount);
  const intervalMap: Record<string, string> = {
    "5m": "5 minutes",
    "15m": "15 minutes",
    "1h": "1 hour",
    "6h": "6 hours",
    "1d": "1 day",
  };
  const pgInterval = intervalMap[interval];

  // Intervals that don't align with date_trunc use epoch-based floor.
  const epochBuckets: Record<string, number> = {
    "5m": 300,
    "15m": 900,
    "6h": 21600,
  };
  const bucketExpr = epochBuckets[interval]
    ? `to_timestamp(floor(extract(epoch from created_at) / ${epochBuckets[interval]}) * ${epochBuckets[interval]})`
    : `date_trunc('${interval === "1d" ? "day" : "hour"}', created_at)`;

  if (normalizedOutcomeCount === 2) {
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

    return result.rows.map((row) => {
      const p0 = Number.parseFloat(row.avg_price);
      const p1 = Number.isFinite(p0) ? 1 - p0 : 0;
      return {
        timestamp: row.bucket,
        prices: [row.avg_price, p1.toString()],
        volume: row.volume,
      };
    });
  }

  const result = await pool.query<{
    bucket: Date;
    outcome_index: number;
    avg_price: string;
    total_volume: string;
  }>(
    `WITH bucketed AS (
       SELECT
         ${bucketExpr} AS bucket,
         outcome_index,
         price::NUMERIC AS price,
         amount::NUMERIC AS amount
       FROM trades
       WHERE market_id = $1
         AND created_at > NOW() - ($2::INTERVAL * $3)
     ),
     per_outcome AS (
       SELECT
         bucket,
         outcome_index,
         AVG(price)::TEXT AS avg_price,
         SUM(amount)::NUMERIC AS outcome_volume
       FROM bucketed
       GROUP BY bucket, outcome_index
     ),
     ranked AS (
       SELECT
         bucket,
         outcome_index,
         avg_price,
         SUM(outcome_volume) OVER (PARTITION BY bucket)::TEXT AS total_volume,
         DENSE_RANK() OVER (ORDER BY bucket DESC) AS bucket_rank
       FROM per_outcome
     )
     SELECT
       bucket,
       outcome_index,
       avg_price,
       total_volume
     FROM ranked
     WHERE bucket_rank <= $3
     ORDER BY bucket DESC, outcome_index ASC`,
    [marketId, pgInterval, limit],
  );

  const buckets = new Map<
    number,
    { timestamp: Date; prices: Array<string | null>; volume: string }
  >();
  for (const row of result.rows) {
    const tsKey = row.bucket.getTime();
    const existing = buckets.get(tsKey);
    const point =
      existing ??
      {
        timestamp: row.bucket,
        prices: new Array(normalizedOutcomeCount).fill(null),
        volume: row.total_volume ?? "0",
      };

    if (!existing) buckets.set(tsKey, point);

    if (row.outcome_index < 0 || row.outcome_index >= normalizedOutcomeCount) continue;
    point.prices[row.outcome_index] = row.avg_price;
  }

  const defaultPrice = (1 / normalizedOutcomeCount).toFixed(6);
  const lastKnown = new Array<string>(normalizedOutcomeCount).fill(defaultPrice);

  const sortedAsc = Array.from(buckets.values()).sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  );
  for (const point of sortedAsc) {
    for (let index = 0; index < normalizedOutcomeCount; index++) {
      const price = point.prices[index];
      if (price == null) {
        point.prices[index] = lastKnown[index];
        continue;
      }
      lastKnown[index] = price;
    }
  }

  return sortedAsc
    .slice()
    .reverse()
    .map((point) => ({
      timestamp: point.timestamp,
      prices: point.prices as string[],
      volume: point.volume,
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
