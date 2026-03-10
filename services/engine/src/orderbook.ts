import { RedisClient, getBookKey } from "./db/redis.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrderEntry {
  /** Unique nonce that also acts as the on-chain order ID. */
  nonce: string;
  marketId: string;
  outcomeIndex: number;
  side: "BID" | "ASK";
  /** Decimal price in [0, 1] represented as a string for precision. */
  price: string;
  /** Original signed order amount (on-chain Order.amount) as a uint256 string. */
  amount: string;
  /** Remaining (unfilled) amount as a uint256 string. */
  remainingAmount: string;
  /** Address of the order creator. */
  user: string;
  /** ISO-8601 timestamp of when the order was placed. */
  createdAt: string;
  /** Stark signature over the order payload. */
  signature: string;
  /** LIMIT or MARKET */
  orderType: "LIMIT" | "MARKET";
  /** Unix timestamp (seconds) after which the order expires. Must be > current block timestamp. */
  expiry: number;
}

// ---------------------------------------------------------------------------
// OrderBook
// ---------------------------------------------------------------------------

export class OrderBook {
  constructor(private readonly redis: RedisClient) {}

  // -----------------------------------------------------------------------
  // Write operations
  // -----------------------------------------------------------------------

  /**
   * Add an order to the book.
   *
   * BID scores are stored as **-price** so that `ZRANGEBYSCORE` returns
   * the best (highest) bid first.  ASK scores are stored as **+price**
   * so the best (lowest) ask is returned first.
   */
  async addOrder(order: OrderEntry): Promise<void> {
    const key = getBookKey(order.marketId, order.outcomeIndex, order.side);
    const score =
      order.side === "BID"
        ? -Number(order.price)
        : Number(order.price);
    const member = serializeOrder(order);
    await this.redis.zadd(key, score, member);
  }

  /**
   * Remove an order from the book by its serialized form.
   * Returns true if the order was found and removed.
   */
  async removeOrder(order: OrderEntry): Promise<boolean> {
    const key = getBookKey(order.marketId, order.outcomeIndex, order.side);
    const member = serializeOrder(order);
    const removed = await this.redis.zrem(key, member);
    return removed > 0;
  }

  /**
   * Remove an order by nonce.  This is more expensive because we must scan
   * both sides of the book for the given market + outcome.
   */
  async removeOrderByNonce(
    marketId: string,
    outcomeIndex: number,
    nonce: string,
  ): Promise<OrderEntry | null> {
    for (const side of ["BID", "ASK"] as const) {
      const orders = await this.getAllOrders(marketId, outcomeIndex, side);
      const target = orders.find((o) => o.nonce === nonce);
      if (target) {
        await this.removeOrder(target);
        return target;
      }
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // Read operations
  // -----------------------------------------------------------------------

  /** Best (highest) bid for a given market outcome. */
  async getBestBid(
    marketId: string,
    outcomeIndex: number,
  ): Promise<OrderEntry | null> {
    // Scores are negative prices; the lowest score = highest price.
    const entries = await this.redis.zrangeWithScores(
      getBookKey(marketId, outcomeIndex, "BID"),
      0,
      0,
    );
    if (entries.length === 0) return null;
    return deserializeOrder(entries[0].member);
  }

  /** Best (lowest) ask for a given market outcome. */
  async getBestAsk(
    marketId: string,
    outcomeIndex: number,
  ): Promise<OrderEntry | null> {
    const entries = await this.redis.zrangeWithScores(
      getBookKey(marketId, outcomeIndex, "ASK"),
      0,
      0,
    );
    if (entries.length === 0) return null;
    return deserializeOrder(entries[0].member);
  }

  /** Spread = bestAsk.price - bestBid.price.  Returns null if either side is empty. */
  async getSpread(
    marketId: string,
    outcomeIndex: number,
  ): Promise<number | null> {
    const [bid, ask] = await Promise.all([
      this.getBestBid(marketId, outcomeIndex),
      this.getBestAsk(marketId, outcomeIndex),
    ]);
    if (!bid || !ask) return null;
    return Number(ask.price) - Number(bid.price);
  }

  /**
   * Find a single order by nonce without removing it.
   * Scans both sides of the book for the given market + outcome.
   */
  async findOrderByNonce(
    marketId: string,
    outcomeIndex: number,
    nonce: string,
  ): Promise<OrderEntry | null> {
    for (const side of ["BID", "ASK"] as const) {
      const orders = await this.getAllOrders(marketId, outcomeIndex, side);
      const target = orders.find((o) => o.nonce === nonce);
      if (target) return target;
    }
    return null;
  }

  /** Find all orders placed by a given nonce (generally 0 or 1). */
  async getOrdersByNonce(
    marketId: string,
    outcomeIndex: number,
    nonce: string,
  ): Promise<OrderEntry[]> {
    const results: OrderEntry[] = [];
    for (const side of ["BID", "ASK"] as const) {
      const orders = await this.getAllOrders(marketId, outcomeIndex, side);
      results.push(...orders.filter((o) => o.nonce === nonce));
    }
    return results;
  }

  /**
   * Retrieve all orders on one side of the book, ordered by price priority.
   * Useful for recovery, snapshots, and depth display.
   */
  async getAllOrders(
    marketId: string,
    outcomeIndex: number,
    side: "BID" | "ASK",
  ): Promise<OrderEntry[]> {
    const key = getBookKey(marketId, outcomeIndex, side);
    const entries = await this.redis.zrangeWithScores(key, 0, -1);
    return entries.map((e) => deserializeOrder(e.member));
  }

  /**
   * Return top N orders from the book (price-priority ordered).
   * For BIDs: returns highest prices first.
   * For ASKs: returns lowest prices first.
   */
  async getTopOrders(
    marketId: string,
    outcomeIndex: number,
    side: "BID" | "ASK",
    count: number,
  ): Promise<OrderEntry[]> {
    const key = getBookKey(marketId, outcomeIndex, side);
    const entries = await this.redis.zrangeWithScores(key, 0, count - 1);
    return entries.map((e) => deserializeOrder(e.member));
  }

  /** Number of resting orders on one side. */
  async depth(
    marketId: string,
    outcomeIndex: number,
    side: "BID" | "ASK",
  ): Promise<number> {
    return this.redis.zcard(getBookKey(marketId, outcomeIndex, side));
  }
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function serializeOrder(order: OrderEntry): string {
  return JSON.stringify({
    n: order.nonce,
    m: order.marketId,
    o: order.outcomeIndex,
    s: order.side,
    p: order.price,
    a: order.amount,
    r: order.remainingAmount,
    u: order.user,
    t: order.createdAt,
    sig: order.signature,
    ot: order.orderType,
    ex: order.expiry,
  });
}

function deserializeOrder(raw: string): OrderEntry {
  const d = JSON.parse(raw) as {
    n: string;
    m: string;
    o: number;
    s: "BID" | "ASK";
    p: string;
    a: string;
    r?: string;
    u: string;
    t: string;
    sig: string;
    ot: "LIMIT" | "MARKET";
    ex?: number;
  };
  return {
    nonce: d.n,
    marketId: d.m,
    outcomeIndex: d.o,
    side: d.s,
    price: d.p,
    amount: d.a,
    remainingAmount: d.r ?? d.a,
    user: d.u,
    createdAt: d.t,
    signature: d.sig,
    orderType: d.ot,
    expiry: d.ex ?? 0,
  };
}
