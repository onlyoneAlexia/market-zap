import { RpcProvider, hash } from "starknet";
import type { EventFilter } from "starknet";
import type { Database } from "../db/postgres.js";

const DEFAULT_RPC_URL = "https://api.zan.top/public/starknet-sepolia/rpc/v0_8";
const DEFAULT_POLL_INTERVAL = 5_000;
const DEFAULT_BATCH_BLOCKS = 50;
const DEFAULT_CHUNK_SIZE = 200;
const RATE_LIMIT_BACKOFF_BASE_MS = 10_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 120_000;
const RATE_LIMIT_LOG_INTERVAL_MS = 15_000;

function normalizeHex(input: string): string {
  const stripped = input.replace(/^0x/i, "").replace(/^0+/, "");
  return (stripped.length > 0 ? `0x${stripped}` : "0x0").toLowerCase();
}

function decodeU256(low: string | undefined, high: string | undefined): bigint {
  const lowPart = low ? BigInt(low) : 0n;
  const highPart = high ? BigInt(high) : 0n;
  return (highPart << 128n) + lowPart;
}

interface RawChainEvent {
  fromAddress: string;
  keys: string[];
  data: string[];
  blockNumber: number;
  txHash: string;
}

// ---------------------------------------------------------------------------
// Event types (mirroring on-chain events from StarkZap contracts)
// ---------------------------------------------------------------------------

export interface MarketCreatedEvent {
  type: "MarketCreated";
  marketId: string;
  title: string;
  description: string;
  outcomeCount: number;
  outcomeLabels: string[];
  collateralToken: string;
  resolutionSource: string;
  resolutionTime: number | null;
  blockNumber: number;
  txHash: string;
}

export interface TradeSettledEvent {
  type: "TradeSettled";
  marketId: string;
  outcomeIndex: number;
  buyer: string;
  seller: string;
  price: string;
  amount: string;
  buyerNonce: string;
  sellerNonce: string;
  blockNumber: number;
  txHash: string;
}

export interface PositionSplitEvent {
  type: "PositionSplit";
  user: string;
  marketId: string;
  amount: string;
  blockNumber: number;
  txHash: string;
}

export interface PositionMergedEvent {
  type: "PositionMerged";
  user: string;
  marketId: string;
  amount: string;
  blockNumber: number;
  txHash: string;
}

export interface PositionRedeemedEvent {
  type: "PositionRedeemed";
  user: string;
  marketId: string;
  outcomeIndex: number;
  amount: string;
  payout: string;
  blockNumber: number;
  txHash: string;
}

export interface PayoutReportedEvent {
  type: "PayoutReported";
  marketId: string;
  winningOutcome: number;
  blockNumber: number;
  txHash: string;
}

export type StarkZapEvent =
  | MarketCreatedEvent
  | TradeSettledEvent
  | PositionSplitEvent
  | PositionMergedEvent
  | PositionRedeemedEvent
  | PayoutReportedEvent;

// ---------------------------------------------------------------------------
// Indexer state
// ---------------------------------------------------------------------------

export interface IndexerState {
  /** Last block number that was fully processed. */
  lastProcessedBlock: number;
  /** Whether the indexer is currently running. */
  running: boolean;
}

// ---------------------------------------------------------------------------
// ApibaraIndexer
// ---------------------------------------------------------------------------

export interface ApibaraIndexerOptions {
  /** Contract addresses to watch. */
  exchangeAddress: string;
  conditionalTokensAddress: string;
  marketFactoryAddress: string;
  resolverAddress?: string;
  /** Starting block number (default: 0). */
  startBlock?: number;
  /** Polling interval in ms (default: 5000). */
  pollInterval?: number;
  /** Max block range per cycle (default: 50). */
  batchBlocks?: number;
  /** RPC event chunk size per request (default: 200). */
  chunkSize?: number;
  /** Starknet RPC endpoint. */
  rpcUrl?: string;
}

/**
 * Starknet event indexer (polling-based fallback for Apibara).
 *
 * Uses Starknet RPC `getEvents` to continuously ingest core protocol events:
 * - Resolver ResolutionFinalized -> market status updates
 * - ConditionalTokens PositionRedeemed -> redemption records
 * - ConditionalTokens PositionSplit/PositionMerged -> observability logs
 */
export class ApibaraIndexer {
  private readonly db: Database;
  private readonly options: ApibaraIndexerOptions;
  private readonly provider: RpcProvider;
  private readonly selectors: {
    positionSplit: string;
    positionMerged: string;
    positionRedeemed: string;
    resolutionFinalized: string;
  };
  private state: IndexerState;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private rateLimitStreak = 0;
  private suppressPollingUntil = 0;
  private lastRateLimitLogAt = 0;

  constructor(db: Database, options: ApibaraIndexerOptions) {
    this.db = db;
    this.options = options;
    this.provider = new RpcProvider({
      nodeUrl: options.rpcUrl ?? process.env.STARKNET_RPC_URL ?? DEFAULT_RPC_URL,
    });
    this.selectors = {
      positionSplit: hash.getSelectorFromName("PositionSplit").toLowerCase(),
      positionMerged: hash.getSelectorFromName("PositionMerged").toLowerCase(),
      positionRedeemed: hash.getSelectorFromName("PositionRedeemed").toLowerCase(),
      resolutionFinalized: hash.getSelectorFromName("ResolutionFinalized").toLowerCase(),
    };
    this.state = {
      lastProcessedBlock: options.startBlock ?? 0,
      running: false,
    };
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Start the indexer. */
  async start(): Promise<void> {
    if (this.state.running) {
      console.warn("[indexer] already running");
      return;
    }

    this.state.running = true;

    console.log(
      `[indexer] starting from block ${this.state.lastProcessedBlock}`,
    );
    console.log(
      `[indexer] watching contracts:` +
        `\n  exchange=${this.options.exchangeAddress}` +
        `\n  conditionalTokens=${this.options.conditionalTokensAddress}` +
        `\n  marketFactory=${this.options.marketFactoryAddress}` +
        `\n  resolver=${this.options.resolverAddress ?? "(disabled)"}`,
    );

    await this.pollOnce();

    const interval = this.options.pollInterval ?? DEFAULT_POLL_INTERVAL;
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, interval);

    console.log("[indexer] polling loop started");
  }

  /** Stop the indexer gracefully. */
  async stop(): Promise<void> {
    this.state.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    console.log("[indexer] stopped");
  }

  /** Current indexer state (useful for health checks). */
  getState(): Readonly<IndexerState> {
    return { ...this.state };
  }

  // -----------------------------------------------------------------------
  // Polling
  // -----------------------------------------------------------------------

  private async pollOnce(): Promise<void> {
    if (!this.state.running || this.polling) return;
    const now = Date.now();
    if (now < this.suppressPollingUntil) return;
    this.polling = true;

    try {
      const latestRaw = await this.provider.getBlockNumber();
      const latestBlock = Number(latestRaw);
      if (!Number.isFinite(latestBlock)) {
        throw new Error(`invalid latest block from RPC: ${String(latestRaw)}`);
      }
      if (latestBlock <= this.state.lastProcessedBlock) return;

      const batchBlocks = Math.max(
        1,
        this.options.batchBlocks ?? DEFAULT_BATCH_BLOCKS,
      );
      const fromBlock = this.state.lastProcessedBlock + 1;
      const toBlock = Math.min(fromBlock + batchBlocks - 1, latestBlock);

      const rawEvents = await this.fetchRawEventsForRange(fromBlock, toBlock);
      const decodedEvents = await this.decodeEvents(rawEvents);
      if (decodedEvents.length > 0) {
        await this.processEvents(decodedEvents);
      }

      this.state.lastProcessedBlock = toBlock;
      this.rateLimitStreak = 0;
      this.suppressPollingUntil = 0;
    } catch (err) {
      const message = compactErrorMessage(err);
      if (isRateLimitedError(message)) {
        this.rateLimitStreak += 1;
        const backoffMs = Math.min(
          RATE_LIMIT_BACKOFF_MAX_MS,
          RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (this.rateLimitStreak - 1),
        );
        this.suppressPollingUntil = Date.now() + backoffMs;

        const shouldLog =
          Date.now() - this.lastRateLimitLogAt >= RATE_LIMIT_LOG_INTERVAL_MS;
        if (shouldLog) {
          this.lastRateLimitLogAt = Date.now();
          console.warn(
            `[indexer] RPC rate-limited; backing off ${Math.ceil(backoffMs / 1000)}s ` +
              `(lastProcessedBlock=${this.state.lastProcessedBlock})`,
          );
        }
      } else {
        this.rateLimitStreak = 0;
        this.suppressPollingUntil = 0;
        console.error("[indexer] polling failed:", message);
      }
    } finally {
      this.polling = false;
    }
  }

  private async fetchRawEventsForRange(
    fromBlock: number,
    toBlock: number,
  ): Promise<RawChainEvent[]> {
    const allEvents: RawChainEvent[] = [];

    const sources: Array<Promise<RawChainEvent[]>> = [
      this.fetchAddressEvents(
        this.options.conditionalTokensAddress,
        [
          this.selectors.positionSplit,
          this.selectors.positionMerged,
          this.selectors.positionRedeemed,
        ],
        fromBlock,
        toBlock,
      ),
    ];

    if (this.options.resolverAddress) {
      sources.push(
        this.fetchAddressEvents(
          this.options.resolverAddress,
          [this.selectors.resolutionFinalized],
          fromBlock,
          toBlock,
        ),
      );
    }

    const batches = await Promise.all(sources);
    for (const batch of batches) {
      allEvents.push(...batch);
    }

    allEvents.sort((a, b) => a.blockNumber - b.blockNumber);
    return allEvents;
  }

  private async fetchAddressEvents(
    address: string,
    selectors: string[],
    fromBlock: number,
    toBlock: number,
  ): Promise<RawChainEvent[]> {
    const collected: RawChainEvent[] = [];
    let continuationToken: string | undefined;

    do {
      const filter = {
        address,
        from_block: { block_number: fromBlock },
        to_block: { block_number: toBlock },
        keys: [selectors],
        chunk_size: this.options.chunkSize ?? DEFAULT_CHUNK_SIZE,
        continuation_token: continuationToken,
      } as unknown as EventFilter;

      const chunk = await this.provider.getEvents(filter);
      const rawChunkEvents = Array.isArray(
        (chunk as { events?: unknown[] }).events,
      )
        ? ((chunk as { events?: unknown[] }).events ?? [])
        : [];

      for (const entry of rawChunkEvents) {
        const parsed = this.parseRawChainEvent(entry);
        if (parsed) collected.push(parsed);
      }

      const nextToken = (chunk as { continuation_token?: string | null })
        .continuation_token;
      continuationToken = nextToken ?? undefined;
    } while (continuationToken);

    return collected;
  }

  private parseRawChainEvent(entry: unknown): RawChainEvent | null {
    if (typeof entry !== "object" || entry === null) return null;
    const obj = entry as Record<string, unknown>;

    if (
      !Array.isArray(obj.keys) ||
      !Array.isArray(obj.data) ||
      typeof obj.from_address !== "string" ||
      typeof obj.transaction_hash !== "string"
    ) {
      return null;
    }

    const blockRaw = obj.block_number;
    const blockNumber =
      typeof blockRaw === "number"
        ? blockRaw
        : typeof blockRaw === "string"
          ? Number(blockRaw)
          : Number.NaN;
    if (!Number.isFinite(blockNumber)) return null;

    return {
      fromAddress: normalizeHex(obj.from_address),
      keys: obj.keys.map((k) => String(k)),
      data: obj.data.map((d) => String(d)),
      blockNumber,
      txHash: obj.transaction_hash,
    };
  }

  // -----------------------------------------------------------------------
  // Decoding
  // -----------------------------------------------------------------------

  private async decodeEvents(rawEvents: RawChainEvent[]): Promise<StarkZapEvent[]> {
    const decoded: StarkZapEvent[] = [];

    for (const raw of rawEvents) {
      const selector = raw.keys[0]?.toLowerCase() ?? "";

      if (selector === this.selectors.resolutionFinalized) {
        const evt = await this.decodeResolutionFinalized(raw);
        if (evt) decoded.push(evt);
        continue;
      }

      if (selector === this.selectors.positionRedeemed) {
        const evt = await this.decodePositionRedeemed(raw);
        if (evt) decoded.push(evt);
        continue;
      }

      if (selector === this.selectors.positionSplit) {
        const evt = await this.decodePositionSplit(raw);
        if (evt) decoded.push(evt);
        continue;
      }

      if (selector === this.selectors.positionMerged) {
        const evt = await this.decodePositionMerged(raw);
        if (evt) decoded.push(evt);
      }
    }

    return decoded;
  }

  private async decodeResolutionFinalized(
    raw: RawChainEvent,
  ): Promise<PayoutReportedEvent | null> {
    if (raw.keys.length < 2 || raw.data.length < 1) return null;

    const conditionId = normalizeHex(raw.keys[1]);
    const winningOutcome = Number(BigInt(raw.data[0]));
    if (!Number.isFinite(winningOutcome) || winningOutcome < 0) return null;

    const market = await this.db.getMarketByConditionId(conditionId);
    if (!market) return null;

    return {
      type: "PayoutReported",
      marketId: market.market_id,
      winningOutcome,
      blockNumber: raw.blockNumber,
      txHash: raw.txHash,
    };
  }

  private async decodePositionRedeemed(
    raw: RawChainEvent,
  ): Promise<PositionRedeemedEvent | null> {
    if (raw.keys.length < 3 || raw.data.length < 2) return null;

    const conditionId = normalizeHex(raw.keys[1]);
    const user = normalizeHex(raw.keys[2]);
    const payout = decodeU256(raw.data[0], raw.data[1]).toString();

    const market = await this.db.getMarketByConditionId(conditionId);
    if (!market) return null;

    return {
      type: "PositionRedeemed",
      user,
      marketId: market.market_id,
      outcomeIndex: market.winning_outcome ?? 0,
      amount: "0",
      payout,
      blockNumber: raw.blockNumber,
      txHash: raw.txHash,
    };
  }

  private async decodePositionSplit(
    raw: RawChainEvent,
  ): Promise<PositionSplitEvent | null> {
    if (raw.keys.length < 3 || raw.data.length < 3) return null;

    const conditionId = normalizeHex(raw.keys[1]);
    const user = normalizeHex(raw.keys[2]);
    const amount = decodeU256(raw.data[1], raw.data[2]).toString();

    const market = await this.db.getMarketByConditionId(conditionId);
    if (!market) return null;

    return {
      type: "PositionSplit",
      user,
      marketId: market.market_id,
      amount,
      blockNumber: raw.blockNumber,
      txHash: raw.txHash,
    };
  }

  private async decodePositionMerged(
    raw: RawChainEvent,
  ): Promise<PositionMergedEvent | null> {
    if (raw.keys.length < 3 || raw.data.length < 3) return null;

    const conditionId = normalizeHex(raw.keys[1]);
    const user = normalizeHex(raw.keys[2]);
    const amount = decodeU256(raw.data[1], raw.data[2]).toString();

    const market = await this.db.getMarketByConditionId(conditionId);
    if (!market) return null;

    return {
      type: "PositionMerged",
      user,
      marketId: market.market_id,
      amount,
      blockNumber: raw.blockNumber,
      txHash: raw.txHash,
    };
  }

  // -----------------------------------------------------------------------
  // Event processing pipeline
  // -----------------------------------------------------------------------

  /**
   * Process a batch of decoded events.  This is the main entry point that
   * the Apibara streaming callback will invoke.
   */
  async processEvents(events: StarkZapEvent[]): Promise<void> {
    for (const event of events) {
      try {
        await this.handleEvent(event);
      } catch (err) {
        console.error(
          `[indexer] failed to process ${event.type} at block ${event.blockNumber}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Individual event handlers
  // -----------------------------------------------------------------------

  private async handleEvent(event: StarkZapEvent): Promise<void> {
    switch (event.type) {
      case "MarketCreated":
        await this.onMarketCreated(event);
        break;
      case "TradeSettled":
        await this.onTradeSettled(event);
        break;
      case "PositionSplit":
        await this.onPositionSplit(event);
        break;
      case "PositionMerged":
        await this.onPositionMerged(event);
        break;
      case "PositionRedeemed":
        await this.onPositionRedeemed(event);
        break;
      case "PayoutReported":
        await this.onPayoutReported(event);
        break;
      default: {
        const _exhaustive: never = event;
        console.warn(
          `[indexer] unknown event type: ${(_exhaustive as StarkZapEvent).type}`,
        );
      }
    }
  }

  private async onMarketCreated(event: MarketCreatedEvent): Promise<void> {
    console.log(
      `[indexer] MarketCreated: ${event.marketId} "${event.title}" (block ${event.blockNumber})`,
    );

    await this.db.upsertMarket({
      marketId: event.marketId,
      title: event.title,
      description: event.description,
      outcomeCount: event.outcomeCount,
      outcomeLabels: event.outcomeLabels,
      collateralToken: event.collateralToken,
      resolutionSource: event.resolutionSource,
      resolutionTime: event.resolutionTime
        ? new Date(event.resolutionTime * 1000)
        : undefined,
    });
  }

  private async onTradeSettled(event: TradeSettledEvent): Promise<void> {
    console.log(
      `[indexer] TradeSettled: market=${event.marketId} outcome=${event.outcomeIndex} ` +
        `buyer=${event.buyer} seller=${event.seller} (block ${event.blockNumber})`,
    );
  }

  private async onPositionSplit(event: PositionSplitEvent): Promise<void> {
    console.log(
      `[indexer] PositionSplit: user=${event.user} market=${event.marketId} ` +
        `amount=${event.amount} (block ${event.blockNumber})`,
    );
  }

  private async onPositionMerged(event: PositionMergedEvent): Promise<void> {
    console.log(
      `[indexer] PositionMerged: user=${event.user} market=${event.marketId} ` +
        `amount=${event.amount} (block ${event.blockNumber})`,
    );
  }

  private async onPositionRedeemed(
    event: PositionRedeemedEvent,
  ): Promise<void> {
    console.log(
      `[indexer] PositionRedeemed: user=${event.user} market=${event.marketId} ` +
        `outcome=${event.outcomeIndex} payout=${event.payout} (block ${event.blockNumber})`,
    );

    await this.db.insertRedemption({
      userAddress: event.user,
      marketId: event.marketId,
      outcomeIndex: event.outcomeIndex,
      amount: event.amount,
      payout: event.payout,
      txHash: event.txHash,
      blockNumber: event.blockNumber,
    });
  }

  private async onPayoutReported(event: PayoutReportedEvent): Promise<void> {
    console.log(
      `[indexer] PayoutReported: market=${event.marketId} ` +
        `winningOutcome=${event.winningOutcome} (block ${event.blockNumber})`,
    );

    await this.db.updateMarketStatus(
      event.marketId,
      "RESOLVED",
      event.winningOutcome,
    );
  }
}

function compactErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 320) return oneLine;
  return `${oneLine.slice(0, 317)}...`;
}

function isRateLimitedError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("cu limit exceeded") ||
    normalized.includes("rate limit") ||
    normalized.includes("request too fast") ||
    normalized.includes("-32011") ||
    normalized.includes("429")
  );
}
