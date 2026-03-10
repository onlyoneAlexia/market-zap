/**
 * In-memory mock of RedisClient for unit testing the order book and matcher
 * without a running Redis instance.
 */

import type { RedisClient } from "../db/redis.js";

interface SortedSetEntry {
  member: string;
  score: number;
}

export class MockRedisClient {
  private sortedSets = new Map<string, SortedSetEntry[]>();
  private kvStore = new Map<string, { value: string; expiresAt?: number }>();
  private sets = new Map<string, Set<string>>();

  // -- Sorted set helpers (order book) -------------------------------------

  async zadd(key: string, score: number, member: string): Promise<number> {
    let entries = this.sortedSets.get(key);
    if (!entries) {
      entries = [];
      this.sortedSets.set(key, entries);
    }
    // Remove existing member if present
    const idx = entries.findIndex((e) => e.member === member);
    if (idx !== -1) {
      entries.splice(idx, 1);
    }
    entries.push({ member, score });
    entries.sort((a, b) => a.score - b.score);
    return idx === -1 ? 1 : 0;
  }

  async zrem(key: string, member: string): Promise<number> {
    const entries = this.sortedSets.get(key);
    if (!entries) return 0;
    const idx = entries.findIndex((e) => e.member === member);
    if (idx === -1) return 0;
    entries.splice(idx, 1);
    return 1;
  }

  async zrangeWithScores(
    key: string,
    start: number,
    stop: number,
  ): Promise<Array<{ member: string; score: number }>> {
    const entries = this.sortedSets.get(key) ?? [];
    const end = stop < 0 ? entries.length : stop + 1;
    return entries.slice(start, end);
  }

  async zrevrangeWithScores(
    key: string,
    start: number,
    stop: number,
  ): Promise<Array<{ member: string; score: number }>> {
    const entries = [...(this.sortedSets.get(key) ?? [])].reverse();
    const end = stop < 0 ? entries.length : stop + 1;
    return entries.slice(start, end);
  }

  async zcard(key: string): Promise<number> {
    return (this.sortedSets.get(key) ?? []).length;
  }

  // -- KV helpers ----------------------------------------------------------

  async get(key: string): Promise<string | null> {
    const entry = this.kvStore.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.kvStore.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, _ex?: string, ttl?: number): Promise<void> {
    this.kvStore.set(key, {
      value,
      expiresAt: ttl ? Date.now() + ttl * 1000 : undefined,
    });
  }

  async del(key: string): Promise<number> {
    return this.kvStore.delete(key) ? 1 : 0;
  }

  // -- Balance cache (matching RedisClient interface) ----------------------

  async cacheBalance(user: string, token: string, balance: string, ttl = 5): Promise<void> {
    await this.set(`bal:${user}:${token}`, balance, "EX", ttl);
  }

  async getCachedBalance(user: string, token: string): Promise<string | null> {
    return this.get(`bal:${user}:${token}`);
  }

  async cacheReserved(user: string, token: string, reserved: string, ttl = 5): Promise<void> {
    await this.set(`reserved:${user}:${token}`, reserved, "EX", ttl);
  }

  async getCachedReserved(user: string, token: string): Promise<string | null> {
    return this.get(`reserved:${user}:${token}`);
  }

  // -- Session helpers (no-op for tests) -----------------------------------

  async addSession(_id: string, _channels: string[]): Promise<void> {}
  async removeSession(_id: string): Promise<void> {}
  async getSessionChannels(_id: string): Promise<string[]> { return []; }
  async addChannelToSession(_id: string, _ch: string): Promise<void> {}
  async removeChannelFromSession(_id: string, _ch: string): Promise<void> {}

  // -- Lifecycle -----------------------------------------------------------

  async disconnect(): Promise<void> {}
  async ping(): Promise<string> { return "PONG"; }
  get connected(): boolean { return true; }
  get raw(): unknown { return null; }

  // -- Test helpers --------------------------------------------------------

  clear(): void {
    this.sortedSets.clear();
    this.kvStore.clear();
    this.sets.clear();
  }
}

/**
 * Create a MockRedisClient typed as RedisClient for use with OrderBook/Matcher.
 */
export function createMockRedis(): RedisClient {
  return new MockRedisClient() as unknown as RedisClient;
}
