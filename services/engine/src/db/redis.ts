import Redis from "ioredis";

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

/** Sorted-set key for one side of the order book. */
export function getBookKey(
  marketId: string,
  outcomeIndex: number,
  side: "BID" | "ASK",
): string {
  return `book:${marketId}:${outcomeIndex}:${side}`;
}

/** Short-lived balance cache key. */
export function getBalanceCacheKey(user: string, token: string): string {
  return `bal:${user}:${token}`;
}

/** Short-lived reserved-balance cache key. */
export function getReservedCacheKey(user: string, token: string): string {
  return `reserved:${user}:${token}`;
}

/** WebSocket session key (maps connection id -> subscribed channels). */
export function getSessionKey(connectionId: string): string {
  return `ws:session:${connectionId}`;
}

// ---------------------------------------------------------------------------
// RedisClient wrapper
// ---------------------------------------------------------------------------

export interface RedisClientOptions {
  url?: string;
  maxRetriesPerRequest?: number;
}

export class RedisClient {
  private client: Redis;
  private isConnected = false;

  constructor(options: RedisClientOptions = {}) {
    const url = options.url ?? process.env.REDIS_URL ?? "redis://localhost:6379";

    this.client = new Redis(url, {
      maxRetriesPerRequest: options.maxRetriesPerRequest ?? 3,
      retryStrategy(times: number) {
        const delay = Math.min(times * 200, 5_000);
        console.log(
          `[redis] reconnecting in ${delay}ms (attempt ${times})`,
        );
        return delay;
      },
      reconnectOnError(err: Error) {
        const targetErrors = ["READONLY", "ECONNRESET"];
        return targetErrors.some((e) => err.message.includes(e));
      },
    });

    this.client.on("connect", () => {
      this.isConnected = true;
      console.log("[redis] connected");
    });

    this.client.on("error", (err) => {
      console.error("[redis] error:", err.message);
    });

    this.client.on("close", () => {
      this.isConnected = false;
      console.log("[redis] connection closed");
    });
  }

  /** Expose the raw ioredis instance for advanced usage. */
  get raw(): Redis {
    return this.client;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  // -- Sorted set helpers (order book) -------------------------------------

  async zadd(key: string, score: number, member: string): Promise<number> {
    return this.client.zadd(key, score, member);
  }

  async zrem(key: string, member: string): Promise<number> {
    return this.client.zrem(key, member);
  }

  /** Return members with scores ordered by ascending score. */
  async zrangeWithScores(
    key: string,
    start: number,
    stop: number,
  ): Promise<Array<{ member: string; score: number }>> {
    const raw = await this.client.zrange(key, start, stop, "WITHSCORES");
    return pairScores(raw);
  }

  /** Return members with scores ordered by descending score. */
  async zrevrangeWithScores(
    key: string,
    start: number,
    stop: number,
  ): Promise<Array<{ member: string; score: number }>> {
    const raw = await this.client.zrevrange(key, start, stop, "WITHSCORES");
    return pairScores(raw);
  }

  async zcard(key: string): Promise<number> {
    return this.client.zcard(key);
  }

  // -- Balance cache helpers -----------------------------------------------

  /** Cache a balance with a TTL (in seconds). */
  async cacheBalance(
    user: string,
    token: string,
    balance: string,
    ttlSeconds = 5,
  ): Promise<void> {
    const key = getBalanceCacheKey(user, token);
    await this.client.set(key, balance, "EX", ttlSeconds);
  }

  async getCachedBalance(
    user: string,
    token: string,
  ): Promise<string | null> {
    return this.client.get(getBalanceCacheKey(user, token));
  }

  /** Cache a reserved amount with a TTL. */
  async cacheReserved(
    user: string,
    token: string,
    reserved: string,
    ttlSeconds = 5,
  ): Promise<void> {
    const key = getReservedCacheKey(user, token);
    await this.client.set(key, reserved, "EX", ttlSeconds);
  }

  async getCachedReserved(
    user: string,
    token: string,
  ): Promise<string | null> {
    return this.client.get(getReservedCacheKey(user, token));
  }

  // -- Session helpers -----------------------------------------------------

  async addSession(connectionId: string, channels: string[]): Promise<void> {
    const key = getSessionKey(connectionId);
    if (channels.length > 0) {
      await this.client.sadd(key, ...channels);
    }
    await this.client.expire(key, 86_400); // 24 h TTL
  }

  async removeSession(connectionId: string): Promise<void> {
    await this.client.del(getSessionKey(connectionId));
  }

  async getSessionChannels(connectionId: string): Promise<string[]> {
    return this.client.smembers(getSessionKey(connectionId));
  }

  async addChannelToSession(
    connectionId: string,
    channel: string,
  ): Promise<void> {
    await this.client.sadd(getSessionKey(connectionId), channel);
  }

  async removeChannelFromSession(
    connectionId: string,
    channel: string,
  ): Promise<void> {
    await this.client.srem(getSessionKey(connectionId), channel);
  }

  // -- Generic helpers -----------------------------------------------------

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(
    key: string,
    value: string,
    ttlSeconds?: number,
  ): Promise<void> {
    if (ttlSeconds !== undefined) {
      await this.client.set(key, value, "EX", ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<number> {
    return this.client.del(key);
  }

  // -- Distributed lock helpers -------------------------------------------

  /**
   * Acquire a Redis-backed distributed lock using SET NX EX with a unique token.
   * Returns the lock token if acquired, null otherwise.
   */
  async acquireLock(key: string, ttlSeconds: number = 30): Promise<string | null> {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const result = await this.client.set(key, token, "EX", ttlSeconds, "NX");
    return result === "OK" ? token : null;
  }

  /**
   * Release a lock only if we still own it (compare-and-del via Lua script).
   * Safe against releasing another holder's lock after TTL expiry.
   */
  async releaseLock(key: string, token: string): Promise<boolean> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const result = await this.client.eval(script, 1, key, token);
    return result === 1;
  }

  /**
   * Acquire a lock with retries. Waits `retryIntervalMs` between attempts.
   * Returns the lock token if eventually acquired within `maxWaitMs`, null otherwise.
   */
  async acquireLockWithRetry(
    key: string,
    ttlSeconds: number = 30,
    maxWaitMs: number = 10_000,
    retryIntervalMs: number = 100,
  ): Promise<string | null> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const token = await this.acquireLock(key, ttlSeconds);
      if (token) return token;
      await new Promise((r) => setTimeout(r, retryIntervalMs));
    }
    return null;
  }

  // -- Lifecycle -----------------------------------------------------------

  async disconnect(): Promise<void> {
    await this.client.quit();
    this.isConnected = false;
    console.log("[redis] disconnected");
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function pairScores(
  raw: string[],
): Array<{ member: string; score: number }> {
  const results: Array<{ member: string; score: number }> = [];
  for (let i = 0; i < raw.length; i += 2) {
    results.push({ member: raw[i], score: Number(raw[i + 1]) });
  }
  return results;
}
