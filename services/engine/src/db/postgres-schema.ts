import type { Pool } from "pg";

export async function createTables(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS markets (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        market_id       TEXT UNIQUE NOT NULL,
        on_chain_market_id TEXT,
        title           TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        category        TEXT NOT NULL DEFAULT 'general',
        outcome_count   INTEGER NOT NULL,
        outcome_labels  TEXT[] NOT NULL,
        collateral_token TEXT NOT NULL,
        resolution_source TEXT NOT NULL DEFAULT '',
        resolution_time TIMESTAMPTZ,
        status          TEXT NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE', 'PAUSED', 'PROPOSED', 'RESOLVED', 'VOIDED')),
        winning_outcome INTEGER,
        total_volume    NUMERIC(78, 0) NOT NULL DEFAULT 0,
        liquidity       NUMERIC(78, 0) NOT NULL DEFAULT 0,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      ALTER TABLE markets ADD COLUMN IF NOT EXISTS on_chain_market_id TEXT;
    `);
    await client.query(`
      ALTER TABLE markets ADD COLUMN IF NOT EXISTS condition_id TEXT;
    `);
    await client.query(`
      ALTER TABLE markets ADD COLUMN IF NOT EXISTS market_type TEXT NOT NULL DEFAULT 'public' CHECK (market_type IN ('public', 'private'));
    `);
    await client.query(`
      ALTER TABLE markets ADD COLUMN IF NOT EXISTS thumbnail_url TEXT DEFAULT NULL;
    `);

    // Migrate status CHECK to include 'PROPOSED' for 2-phase resolution
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE markets DROP CONSTRAINT IF EXISTS markets_status_check;
        ALTER TABLE markets ADD CONSTRAINT markets_status_check
          CHECK (status IN ('ACTIVE', 'PAUSED', 'PROPOSED', 'RESOLVED', 'VOIDED'));
      EXCEPTION WHEN undefined_table THEN NULL;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        market_id       TEXT NOT NULL REFERENCES markets(market_id),
        outcome_index   INTEGER NOT NULL,
        buyer           TEXT NOT NULL,
        seller          TEXT NOT NULL,
        price           NUMERIC(78, 18) NOT NULL,
        amount          NUMERIC(78, 0) NOT NULL,
        side            TEXT NOT NULL CHECK (side IN ('BID', 'ASK')),
        buyer_nonce     TEXT NOT NULL,
        seller_nonce    TEXT NOT NULL,
        tx_hash         TEXT,
        settled         BOOLEAN NOT NULL DEFAULT FALSE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS fee NUMERIC(78, 0) NOT NULL DEFAULT 0;
    `);
    await client.query(`
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS settlement_status TEXT NOT NULL DEFAULT 'pending';
    `);
    await client.query(`
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS settlement_error TEXT DEFAULT NULL;
    `);
    await client.query(`
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS trade_commitment TEXT;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_trades_market
        ON trades (market_id, created_at DESC);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_trades_buyer
        ON trades (buyer, created_at DESC);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_trades_seller
        ON trades (seller, created_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        market_id       TEXT NOT NULL REFERENCES markets(market_id),
        outcome_index   INTEGER NOT NULL,
        user_address    TEXT NOT NULL,
        side            TEXT NOT NULL CHECK (side IN ('BID', 'ASK')),
        order_type      TEXT NOT NULL CHECK (order_type IN ('LIMIT', 'MARKET')),
        price           NUMERIC(78, 18) NOT NULL,
        amount          NUMERIC(78, 0) NOT NULL,
        filled_amount   NUMERIC(78, 0) NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'OPEN'
                        CHECK (status IN ('OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED')),
        nonce           TEXT UNIQUE NOT NULL,
        signature       TEXT NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS expiry INTEGER NOT NULL DEFAULT 0;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_market_status
        ON orders (market_id, status, created_at);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_user
        ON orders (user_address, status);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS order_reservations (
        nonce           TEXT PRIMARY KEY,
        user_address    TEXT NOT NULL,
        collateral_token TEXT NOT NULL,
        reserved_amount NUMERIC(78, 0) NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_order_reservations_user
        ON order_reservations (user_address);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS outcome_order_reservations (
        nonce           TEXT PRIMARY KEY,
        user_address    TEXT NOT NULL,
        market_id       TEXT NOT NULL REFERENCES markets(market_id),
        outcome_index   INTEGER NOT NULL,
        token_id        TEXT NOT NULL,
        reserved_amount NUMERIC(78, 0) NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_outcome_reservations_user_market_outcome
        ON outcome_order_reservations (user_address, market_id, outcome_index);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS redemptions (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_address    TEXT NOT NULL,
        market_id       TEXT NOT NULL REFERENCES markets(market_id),
        outcome_index   INTEGER NOT NULL,
        amount          NUMERIC(78, 0) NOT NULL,
        payout          NUMERIC(78, 0) NOT NULL,
        tx_hash         TEXT NOT NULL,
        block_number    BIGINT NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_redemptions_user_market
        ON redemptions (user_address, market_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_book_lookup
        ON orders (market_id, outcome_index, side, price, created_at)
        WHERE status IN ('OPEN', 'PARTIALLY_FILLED');
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_open_only
        ON orders (user_address, market_id)
        WHERE status IN ('OPEN', 'PARTIALLY_FILLED');
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_trades_created_at_brin
        ON trades USING brin (created_at);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_trades_unsettled
        ON trades (settled, created_at)
        WHERE settled = FALSE;
    `);

    await client.query(`DROP MATERIALIZED VIEW IF EXISTS leaderboard`);
    await client.query(`
      CREATE MATERIALIZED VIEW leaderboard AS
      SELECT
        u.user_address,
        COUNT(*)::INTEGER                      AS total_trades,
        COALESCE(SUM(u.volume), 0)             AS total_volume,
        COALESCE(SUM(u.pnl), 0)                AS realized_pnl,
        CASE
          WHEN COUNT(*) = 0 THEN 0
          ELSE (SUM(CASE WHEN u.pnl > 0 THEN 1 ELSE 0 END)::FLOAT / COUNT(*))
        END                                    AS win_rate
      FROM (
        SELECT '0x' || LOWER(LTRIM(REPLACE(t.buyer,  '0x', ''), '0')) AS user_address,
               t.price * t.amount AS volume, t.price * t.amount AS pnl
        FROM trades t JOIN markets m ON m.market_id = t.market_id
        WHERE t.settled = TRUE AND COALESCE(m.market_type, 'public') = 'public'
        UNION ALL
        SELECT '0x' || LOWER(LTRIM(REPLACE(t.seller, '0x', ''), '0')) AS user_address,
               t.price * t.amount AS volume, -(t.price * t.amount) AS pnl
        FROM trades t JOIN markets m ON m.market_id = t.market_id
        WHERE t.settled = TRUE AND COALESCE(m.market_type, 'public') = 'public'
      ) u
      GROUP BY u.user_address
      ORDER BY realized_pnl DESC;
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_leaderboard_user
        ON leaderboard (user_address);
    `);

    await client.query("COMMIT");
    console.log("[postgres] tables created / verified");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
