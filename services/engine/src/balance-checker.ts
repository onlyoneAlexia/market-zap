import { Contract, RpcProvider } from "starknet";
import { CLOBRouterABI } from "@market-zap/shared";
import { RedisClient } from "./db/redis.js";

// ---------------------------------------------------------------------------
// Cache TTL
// ---------------------------------------------------------------------------

/** Default time-to-live for cached balances (seconds). */
const BALANCE_CACHE_TTL = 5;
/** UI-oriented cached full balance snapshot TTL (seconds). */
const BALANCE_SNAPSHOT_CACHE_TTL = 30;
/** Extended TTL for stale-on-error fallback (10 minutes). */
const STALE_CACHE_TTL = 600;

export interface BalanceSnapshot {
  balance: string;
  reserved: string;
  available: string;
  walletBalance: string;
  walletDecimals: number;
  exchangeDecimals: number;
}

// ---------------------------------------------------------------------------
// BalanceChecker
// ---------------------------------------------------------------------------

export interface BalanceCheckerOptions {
  rpcUrl?: string;
  exchangeAddress: string;
  cacheTtl?: number;
}

export class BalanceChecker {
  private readonly provider: RpcProvider;
  private readonly exchange: Contract;
  private readonly redis: RedisClient;
  private readonly cacheTtl: number;

  constructor(redis: RedisClient, options: BalanceCheckerOptions) {
    const rpcUrl =
      options.rpcUrl ??
      process.env.STARKNET_RPC_URL ??
      "https://rpc.starknet-testnet.lava.build";

    this.provider = new RpcProvider({ nodeUrl: rpcUrl });
    // Use the real deployed Sierra ABI — starknet.js 7.x returns bigint
    // directly for u256 view function results.
    this.exchange = new Contract({
      abi: CLOBRouterABI as unknown as Contract["abi"],
      address: options.exchangeAddress,
      providerOrAccount: this.provider,
    });
    this.redis = redis;
    this.cacheTtl = options.cacheTtl ?? BALANCE_CACHE_TTL;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Query the on-chain deposited balance for a user + token pair.
   * Results are cached in Redis for `cacheTtl` seconds.
   */
  async checkBalance(
    user: string,
    token: string,
    options: { allowStaleOnError?: boolean } = {},
  ): Promise<bigint> {
    const allowStaleOnError = options.allowStaleOnError ?? true;
    // Try cache first.
    const cached = await this.redis.getCachedBalance(user, token);
    if (cached !== null) {
      return BigInt(cached);
    }

    try {
      const result = await this.exchange.call("get_balance", [user, token]);
      const balance = toBigInt(result);
      // Write both short-lived cache and long-lived stale fallback
      await Promise.all([
        this.redis.cacheBalance(user, token, balance.toString(), this.cacheTtl),
        this.redis.set(`stale_bal:${user}:${token}`, balance.toString(), STALE_CACHE_TTL),
      ]);
      return balance;
    } catch (err) {
      if (allowStaleOnError) {
        // RPC down — try stale cache before giving up
        const stale = await this.redis.get(`stale_bal:${user}:${token}`);
        if (stale !== null) {
          console.warn(`[balance-checker] RPC down, serving stale balance for ${user}`);
          return BigInt(stale);
        }
      }
      console.error(
        `[balance-checker] failed to fetch balance for ${user}:`,
        err instanceof Error ? err.message : err,
      );
      throw new Error(`Failed to fetch on-chain balance for ${user}`);
    }
  }

  /**
   * Query the on-chain reserved amount for a user + token pair.
   * Results are cached in Redis for `cacheTtl` seconds.
   */
  async checkReserved(
    user: string,
    token: string,
    options: { allowStaleOnError?: boolean } = {},
  ): Promise<bigint> {
    const allowStaleOnError = options.allowStaleOnError ?? true;
    const cached = await this.redis.getCachedReserved(user, token);
    if (cached !== null) {
      return BigInt(cached);
    }

    try {
      const result = await this.exchange.call("get_reserved", [user, token]);
      const reserved = toBigInt(result);
      await Promise.all([
        this.redis.cacheReserved(user, token, reserved.toString(), this.cacheTtl),
        this.redis.set(`stale_res:${user}:${token}`, reserved.toString(), STALE_CACHE_TTL),
      ]);
      return reserved;
    } catch (err) {
      if (allowStaleOnError) {
        const stale = await this.redis.get(`stale_res:${user}:${token}`);
        if (stale !== null) {
          console.warn(`[balance-checker] RPC down, serving stale reserved for ${user}`);
          return BigInt(stale);
        }
      }
      console.error(
        `[balance-checker] failed to fetch reserved for ${user}:`,
        err instanceof Error ? err.message : err,
      );
      throw new Error(`Failed to fetch on-chain reserved balance for ${user}`);
    }
  }

  /**
   * Compute the available (un-reserved) balance.
   *
   * The on-chain `get_balance()` already returns available (non-reserved) balance.
   * When reserve_balance is called, amounts move FROM balances TO reserved.
   * So `get_balance()` = available, `get_reserved()` = reserved.
   * Total deposited = available + reserved.
   */
  async availableBalance(user: string, token: string): Promise<bigint> {
    // get_balance already returns the available (non-reserved) amount.
    return this.checkBalance(user, token);
  }

  /**
   * Validate that a user has enough available balance to cover a given amount.
   * Returns `true` if `availableBalance >= requiredAmount`.
   */
  async hasSufficientBalance(
    user: string,
    token: string,
    requiredAmount: bigint,
    options: { allowStaleOnError?: boolean } = {},
  ): Promise<boolean> {
    const available = await this.checkBalance(user, token, options);
    return available >= requiredAmount;
  }

  /**
   * Query the on-chain ERC-20 decimals for a token.
   */
  async checkDecimals(token: string): Promise<number> {
    const cacheKey = `token_decimals:${token}`;
    const cached = await this.redis.get(cacheKey);
    if (cached !== null) {
      return parseInt(cached, 10);
    }

    try {
      const erc20 = new Contract({
        abi: [
          {
            name: "decimals",
            type: "function",
            inputs: [],
            outputs: [{ type: "core::integer::u8" }],
            state_mutability: "view",
          },
        ] as unknown as Contract["abi"],
        address: token,
        providerOrAccount: this.provider,
      });
      const result = await erc20.call("decimals", []);
      const decimals = Number(result);
      // Cache for a long time — decimals don't change
      await this.redis.set(cacheKey, decimals.toString(), 86400);
      return decimals;
    } catch (err) {
      console.error(
        `[balance-checker] failed to fetch decimals for ${token}:`,
        err instanceof Error ? err.message : err,
      );
      return 18; // Safe default — most tokens use 18
    }
  }

  /**
   * Query the ERC-20 wallet balance for a user + token pair (not exchange-deposited).
   * This checks the raw token balance in the user's wallet via `balanceOf`.
   */
  async checkWalletBalance(user: string, token: string): Promise<bigint> {
    const cacheKey = `wallet_bal:${user}:${token}`;
    const cached = await this.redis.get(cacheKey);
    if (cached !== null) {
      return BigInt(cached);
    }

    try {
      const erc20 = new Contract({
        abi: [
          {
            name: "balance_of",
            type: "function",
            inputs: [{ name: "account", type: "core::starknet::contract_address::ContractAddress" }],
            outputs: [{ type: "core::integer::u256" }],
            state_mutability: "view",
          },
        ] as unknown as Contract["abi"],
        address: token,
        providerOrAccount: this.provider,
      });
      const result = await erc20.call("balance_of", [user]);
      const balance = toBigInt(result);
      await this.redis.set(cacheKey, balance.toString(), this.cacheTtl);
      return balance;
    } catch (err) {
      console.error(
        `[balance-checker] failed to fetch wallet balance for ${user}:`,
        err instanceof Error ? err.message : err,
      );
      return 0n; // Graceful fallback — wallet balance is informational
    }
  }

  /**
   * Query an ERC-1155 balance for a user + tokenId pair.
   */
  async checkErc1155Balance(
    contractAddress: string,
    user: string,
    tokenId: string | bigint,
  ): Promise<bigint> {
    const tokenIdBig = typeof tokenId === "bigint" ? tokenId : BigInt(tokenId);
    const cacheKey = `erc1155_bal:${contractAddress}:${user}:${tokenIdBig.toString()}`;
    const cached = await this.redis.get(cacheKey);
    if (cached !== null) {
      return BigInt(cached);
    }

    try {
      const erc1155 = new Contract({
        abi: [
          {
            name: "balance_of",
            type: "function",
            inputs: [
              { name: "account", type: "core::starknet::contract_address::ContractAddress" },
              { name: "token_id", type: "core::integer::u256" },
            ],
            outputs: [{ type: "core::integer::u256" }],
            state_mutability: "view",
          },
        ] as unknown as Contract["abi"],
        address: contractAddress,
        providerOrAccount: this.provider,
      });
      const result = await erc1155.call("balance_of", [user, tokenIdBig]);
      const balance = toBigInt(result);
      await this.redis.set(cacheKey, balance.toString(), this.cacheTtl);
      return balance;
    } catch (err) {
      console.error(
        `[balance-checker] failed to fetch ERC1155 balance for ${user}:`,
        err instanceof Error ? err.message : err,
      );
      throw new Error(`Failed to fetch ERC1155 balance for ${user}`);
    }
  }

  async getCachedBalanceSnapshot(
    user: string,
    token: string,
  ): Promise<BalanceSnapshot | null> {
    const cached = await this.redis.get(getBalanceSnapshotCacheKey(user, token));
    if (cached === null) {
      return null;
    }

    try {
      const parsed = JSON.parse(cached) as Partial<BalanceSnapshot>;
      if (
        typeof parsed.balance === "string" &&
        typeof parsed.reserved === "string" &&
        typeof parsed.available === "string" &&
        typeof parsed.walletBalance === "string" &&
        typeof parsed.walletDecimals === "number" &&
        typeof parsed.exchangeDecimals === "number"
      ) {
        return parsed as BalanceSnapshot;
      }
    } catch {
      // Fall through to key deletion below.
    }

    await this.redis.del(getBalanceSnapshotCacheKey(user, token));
    return null;
  }

  async cacheBalanceSnapshot(
    user: string,
    token: string,
    snapshot: BalanceSnapshot,
    ttlSeconds = BALANCE_SNAPSHOT_CACHE_TTL,
  ): Promise<void> {
    await this.redis.set(
      getBalanceSnapshotCacheKey(user, token),
      JSON.stringify(snapshot),
      ttlSeconds,
    );
  }

  /**
   * Invalidate cached balances for a user + token so the next query
   * hits the chain.
   */
  async invalidateCache(user: string, token: string): Promise<void> {
    await Promise.all([
      this.redis.del(`bal:${user}:${token}`),
      this.redis.del(`reserved:${user}:${token}`),
      this.redis.del(`wallet_bal:${user}:${token}`),
      this.redis.del(`stale_bal:${user}:${token}`),
      this.redis.del(`stale_res:${user}:${token}`),
      this.redis.del(getBalanceSnapshotCacheKey(user, token)),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a starknet.js contract call result to a BigInt.
 *
 * starknet.js 7.x with a proper Sierra ABI typically returns:
 *   - `bigint` directly for u256 return types
 *   - `{ low: bigint, high: bigint }` in some cases
 *   - `{ balance: bigint }` or `{ balance: { low, high } }` (named outputs)
 *
 * We handle all cases for robustness.
 */
function toBigInt(result: unknown): bigint {
  if (typeof result === "bigint") return result;
  if (typeof result === "string") return BigInt(result);
  if (typeof result === "number") return BigInt(result);

  const obj = result as Record<string, unknown>;

  // Named wrapper (e.g. { balance: bigint })
  if (obj.balance !== undefined) {
    return toBigInt(obj.balance);
  }

  // Uint256 struct { low, high }
  if (obj.low !== undefined && obj.high !== undefined) {
    const low = BigInt(obj.low as string | number | bigint);
    const high = BigInt(obj.high as string | number | bigint);
    return low + (high << 128n);
  }

  // Fallback: try BigInt conversion
  throw new Error(
    `Cannot convert contract result to BigInt: ${JSON.stringify(result)}`,
  );
}

function getBalanceSnapshotCacheKey(user: string, token: string): string {
  return `balance_snapshot:${user}:${token}`;
}
