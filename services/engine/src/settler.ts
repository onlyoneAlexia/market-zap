import { Account, Contract, RpcProvider, CallData, constants, type InvokeFunctionResponse, type Call } from "starknet";
import {
  CLOBRouterABI,
  ConditionalTokensABI,
  ERC20ABI,
  computeTradeCommitment,
  getContractAddress,
} from "@market-zap/shared";
import type { OrderHashParams } from "@market-zap/shared";
import type { Trade } from "./matcher.js";
import {
  settleAmmTradeAtomic,
  type SettleAmmTradeAtomicParams,
} from "./settler-amm.js";
import {
  registerDarkMarket as registerDarkMarketBatch,
  settleDarkTradesAtomic as settleDarkTradesAtomicBatch,
  settleTradesAtomic as settleTradesAtomicBatch,
} from "./settler-batch.js";
import { settleOrRollback as settleOrRollbackWithRelease } from "./settler-rollback.js";
import {
  buildCairoOrder,
  getExecutionStatus,
  getFinalityStatus,
  getRevertReason,
  parseSignature,
  scalePrice,
  signSeedOrder as signSeedOrderWithKey,
} from "./settler-helpers.js";

async function withRetry<T>(
  fn: () => Promise<T>,
  { retries = 3, baseDelayMs = 2000, label = "operation" } = {},
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit =
        msg.includes("cu limit") ||
        msg.includes("rate limit") ||
        msg.includes("too fast") ||
        msg.includes("429");
      if (isRateLimit && attempt < retries) {
        const delay = baseDelayMs * 2 ** attempt;
        console.warn(
          `[settler] ${label} rate-limited (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms...`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

export interface SettlementResult {
  tradeId: string;
  txHash: string;
  success: boolean;
  error?: string;
  /** Whether an auto-split was performed during this settlement. */
  didSplit?: boolean;
}

export interface SettlerOptions {
  rpcUrl?: string;
  adminPrivateKey: string;
  adminAddress: string;
  exchangeAddress: string;
  conditionalTokensAddress?: string;
}

export class Settler {
  private readonly provider: RpcProvider;
  private readonly account: Account;
  private readonly exchange: Contract;
  private readonly exchangeAddress: string;
  private readonly adminPrivateKey: string;
  private readonly adminAddress: string;
  private readonly conditionalTokensAddress: string;

  constructor(options: SettlerOptions) {
    const rpcUrl =
      options.rpcUrl ??
      process.env.STARKNET_RPC_URL ??
      "https://rpc.starknet-testnet.lava.build";

    this.provider = new RpcProvider({ nodeUrl: rpcUrl });
    this.account = new Account({
      provider: this.provider,
      address: options.adminAddress,
      signer: options.adminPrivateKey,
    });
    // Use the real deployed Sierra ABI — starknet.js 7.x handles struct
    // serialization and u256 encoding automatically.
    this.exchangeAddress = options.exchangeAddress;
    this.adminPrivateKey = options.adminPrivateKey;
    this.adminAddress = options.adminAddress;
    this.conditionalTokensAddress = options.conditionalTokensAddress ?? "";
    this.exchange = new Contract({
      abi: CLOBRouterABI as unknown as Contract["abi"],
      address: options.exchangeAddress,
      providerOrAccount: this.account,
    });
  }

  /** The admin account address used for seed liquidity and settlement. */
  get adminAddr(): string {
    return this.adminAddress;
  }

  /** The exchange contract address (for order hash computation). */
  get exchangeAddr(): string {
    return this.exchangeAddress;
  }

  /** The RPC provider for on-chain calls (e.g. signature verification). */
  get rpcProvider(): RpcProvider {
    return this.provider;
  }

  /**
   * Settle a single trade on-chain by invoking `CLOBExchange.settle_trade`.
   *
   * With starknet.js 7.x and the real Sierra ABI, Order structs are
   * serialized automatically from plain objects with named fields.
   */
  async settleTrade(
    trade: Trade,
    tokenId: string = "0",
    onChainMarketId: string = trade.marketId,
  ): Promise<SettlementResult> {
    try {
      console.log(
        `[settler] settling trade ${trade.id} (market=${trade.marketId}, ` +
          `buyer=${trade.buyer}, seller=${trade.seller}, amount=${trade.fillAmount})`,
      );

      const makerOrder = buildCairoOrder(trade.makerOrder, onChainMarketId, tokenId);
      const takerOrder = buildCairoOrder(trade.takerOrder, onChainMarketId, tokenId);
      const makerSig = parseSignature(trade.makerOrder.signature);
      const takerSig = parseSignature(trade.takerOrder.signature);

      const response: InvokeFunctionResponse = await this.exchange.invoke(
        "settle_trade",
        [
          makerOrder,
          takerOrder,
          BigInt(trade.fillAmount),
          makerSig,
          takerSig,
        ],
      );

      console.log(
        `[settler] trade ${trade.id} submitted, tx=${response.transaction_hash}`,
      );

      const receipt = await this.provider.waitForTransaction(response.transaction_hash);

      // Check for REVERTED status — waitForTransaction doesn't throw on revert.
      if (getExecutionStatus(receipt) === "REVERTED") {
        const reason = getRevertReason(receipt) ?? "unknown";
        console.error(`[settler] trade ${trade.id} REVERTED: ${reason}`);
        return {
          tradeId: trade.id,
          txHash: response.transaction_hash,
          success: false,
          error: `TX reverted: ${reason}`,
        };
      }

      if (getFinalityStatus(receipt) === "REJECTED") {
        return {
          tradeId: trade.id,
          txHash: response.transaction_hash,
          success: false,
          error: "TX rejected by network",
        };
      }

      console.log(`[settler] trade ${trade.id} confirmed`);

      return {
        tradeId: trade.id,
        txHash: response.transaction_hash,
        success: true,
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      console.error(`[settler] failed to settle trade ${trade.id}:`, message);
      return {
        tradeId: trade.id,
        txHash: "",
        success: false,
        error: message,
      };
    }
  }

  /**
   * Settle a trade atomically: reserve buyer's balance + settle_trade in
   * a single Starknet multicall transaction. This ensures either both
   * succeed or both fail — no partial state.
   *
   * For BUY orders: buyer needs collateral reserved (cost = fillAmount * price / 1e18)
   * For the seller: their outcome tokens are transferred during settle_trade
   * (no separate reserve needed — the contract handles ERC-1155 transfer).
   */
  async settleTradeAtomic(
    trade: Trade,
    collateralToken: string,
    tokenId: string,
    onChainMarketId: string,
    reserveExpiry: number,
  ): Promise<SettlementResult> {
    try {
      console.log(
        `[settler] atomic settle: trade ${trade.id} (market=${trade.marketId}, ` +
          `buyer=${trade.buyer}, seller=${trade.seller}, amount=${trade.fillAmount})`,
      );

      const makerOrder = buildCairoOrder(trade.makerOrder, onChainMarketId, tokenId);
      const takerOrder = buildCairoOrder(trade.takerOrder, onChainMarketId, tokenId);
      const makerSig = parseSignature(trade.makerOrder.signature);
      const takerSig = parseSignature(trade.takerOrder.signature);

      // Compute how much collateral the buyer needs reserved.
      // cost = fillAmount * executionPrice / 1e18
      // Fee handling:
      // - When the maker is BUY, the maker (buyer) pays `cost` from reserved.
      //   The taker fee is taken from the seller's proceeds; the buyer does
      //   NOT need to reserve the fee.
      // - When the maker is SELL, the taker (buyer) pays `cost + taker_fee`
      //   from reserved.
      const fillAmount = BigInt(trade.fillAmount);
      const executionPrice = scalePrice(trade.price);
      const cost = (fillAmount * executionPrice) / BigInt(1e18);
      const takerFee = (cost * 100n) / 10000n; // 1% = 100 bps
      const reserveAmount = trade.makerOrder.isBuy ? cost : cost + takerFee;

      // Build multicall: [reserve_balance, settle_trade]
      // reserve_balance ABI: (user, token, amount, nonce, expiry, market_id)
      const reserveNonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
      const calls: Call[] = [
        this.exchange.populate("reserve_balance", [
          trade.buyer,
          collateralToken,
          reserveAmount,
          reserveNonce,
          reserveExpiry,
          BigInt(onChainMarketId),
        ]),
        this.exchange.populate("settle_trade", [
          makerOrder,
          takerOrder,
          fillAmount,
          makerSig,
          takerSig,
        ]),
      ];

      const response = await withRetry(
        () => this.account.execute(calls),
        { label: `settle ${trade.id}` },
      );

      console.log(
        `[settler] atomic tx submitted: ${response.transaction_hash}`,
      );

      const receipt = await withRetry(
        () => this.provider.waitForTransaction(response.transaction_hash),
        { label: `confirm ${trade.id}` },
      );

      // Check for REVERTED status — waitForTransaction doesn't throw on revert.
      if (getExecutionStatus(receipt) === "REVERTED") {
        const reason = getRevertReason(receipt) ?? "unknown";
        console.error(`[settler] atomic trade ${trade.id} REVERTED: ${reason}`);
        return {
          tradeId: trade.id,
          txHash: response.transaction_hash,
          success: false,
          error: `TX reverted: ${reason}`,
        };
      }

      if (getFinalityStatus(receipt) === "REJECTED") {
        return {
          tradeId: trade.id,
          txHash: response.transaction_hash,
          success: false,
          error: "TX rejected by network",
        };
      }

      console.log(`[settler] atomic trade ${trade.id} confirmed`);

      return {
        tradeId: trade.id,
        txHash: response.transaction_hash,
        success: true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[settler] atomic settle failed for trade ${trade.id}:`,
        message,
      );
      return {
        tradeId: trade.id,
        txHash: "",
        success: false,
        error: message,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Dark Trade Settlement (minimal calldata)
  // -----------------------------------------------------------------------

  /**
   * Settle a dark market trade on-chain via `CLOBExchange.settle_dark_trade`.
   * Uses reduced calldata — no full Order structs or signatures.
   */
  async settleDarkTrade(params: {
    trade: Trade;
    collateralToken: string;
    tokenId: string;
    onChainMarketId: string;
    reserveExpiry: number;
    tradeCommitment: string;
  }): Promise<SettlementResult> {
    const { trade, collateralToken, tokenId, onChainMarketId, reserveExpiry, tradeCommitment } = params;
    try {
      console.log(
        `[settler] dark settle: trade ${trade.id} (market=${trade.marketId}, amount=${trade.fillAmount})`,
      );

      const fillAmount = BigInt(trade.fillAmount);
      const executionPrice = scalePrice(trade.price);
      const cost = (fillAmount * executionPrice) / BigInt(1e18);
      const takerFee = (cost * 100n) / 10000n;
      const reserveAmount = trade.makerOrder.isBuy ? cost : cost + takerFee;

      const reserveNonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
      const calls: Call[] = [
        // Reserve buyer collateral
        this.exchange.populate("reserve_balance", [
          trade.buyer,
          collateralToken,
          reserveAmount,
          reserveNonce,
          reserveExpiry,
          BigInt(onChainMarketId),
        ]),
        // Dark settlement — minimal calldata
        this.exchange.populate("settle_dark_trade", [
          BigInt(onChainMarketId),
          BigInt(tokenId),
          fillAmount,
          executionPrice,
          trade.makerOrder.isBuy ? trade.makerOrder.trader : trade.takerOrder.trader,
          trade.makerOrder.isBuy ? trade.takerOrder.trader : trade.makerOrder.trader,
          trade.makerOrder.isBuy,
          tradeCommitment,
        ]),
      ];

      const response = await withRetry(
        () => this.account.execute(calls),
        { label: `dark-settle ${trade.id}` },
      );

      console.log(`[settler] dark tx submitted: ${response.transaction_hash}`);

      const receipt = await withRetry(
        () => this.provider.waitForTransaction(response.transaction_hash),
        { label: `dark-confirm ${trade.id}` },
      );

      if (getExecutionStatus(receipt) === "REVERTED") {
        const reason = getRevertReason(receipt) ?? "unknown";
        console.error(`[settler] dark trade ${trade.id} REVERTED: ${reason}`);
        return {
          tradeId: trade.id,
          txHash: response.transaction_hash,
          success: false,
          error: `TX reverted: ${reason}`,
        };
      }

      if (getFinalityStatus(receipt) === "REJECTED") {
        return {
          tradeId: trade.id,
          txHash: response.transaction_hash,
          success: false,
          error: "TX rejected by network",
        };
      }

      console.log(`[settler] dark trade ${trade.id} confirmed`);
      return {
        tradeId: trade.id,
        txHash: response.transaction_hash,
        success: true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[settler] dark settle failed for trade ${trade.id}:`, message);
      return {
        tradeId: trade.id,
        txHash: "",
        success: false,
        error: message,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Register Dark Market On-Chain
  // -----------------------------------------------------------------------

  /**
   * Call CLOBExchange.register_dark_market(market_id) so that
   * settle_dark_trade() accepts the market.
   */
  async registerDarkMarket(onChainMarketId: string): Promise<SettlementResult> {
    return registerDarkMarketBatch(
      {
        account: this.account,
        exchange: this.exchange,
        provider: this.provider,
        withRetry,
      },
      onChainMarketId,
    );
  }

  // -----------------------------------------------------------------------
  // AMM Atomic Settlement (with auto-split)
  // -----------------------------------------------------------------------

  /**
   * Settle an AMM trade atomically, auto-splitting collateral into outcome
   * tokens if the admin's inventory is insufficient.
   *
   * Multicall order (reserve first to fail fast):
   *   1. reserve_balance (buyer collateral)
   *   2. exchange.withdraw (admin USDC from exchange → wallet, if needed)
   *   3. erc20.approve (vault, splitAmount)
   *   4. conditionalTokens.split_position (mint outcome tokens)
   *   5. settle_trade
   */
  async settleAmmTradeAtomic(
    params: SettleAmmTradeAtomicParams,
  ): Promise<SettlementResult> {
    return settleAmmTradeAtomic(
      {
        account: this.account,
        adminAddress: this.adminAddress,
        conditionalTokensAddress: this.conditionalTokensAddress,
        exchange: this.exchange,
        provider: this.provider,
        withRetry,
      },
      params,
    );
  }

  /**
   * Settle a batch of trades atomically in a single Starknet multicall:
   *   - Reserve required collateral per buyer (grouped)
   *   - Execute `settle_trade` for each fill
   *
   * All trades must be for the same collateral token / tokenId / onChainMarketId.
   */
  async settleTradesAtomic(
    trades: Trade[],
    collateralToken: string,
    tokenId: string,
    onChainMarketId: string,
    reserveExpiry: number,
  ): Promise<{ success: boolean; txHash: string; error?: string }> {
    return settleTradesAtomicBatch(
      {
        account: this.account,
        exchange: this.exchange,
        provider: this.provider,
        withRetry,
      },
      trades,
      collateralToken,
      tokenId,
      onChainMarketId,
      reserveExpiry,
    );
  }

  async settleDarkTradesAtomic(
    trades: Array<{ trade: Trade; tradeCommitment: string }>,
    collateralToken: string,
    tokenId: string,
    onChainMarketId: string,
    reserveExpiry: number,
  ): Promise<{ success: boolean; txHash: string; error?: string }> {
    return settleDarkTradesAtomicBatch(
      {
        account: this.account,
        exchange: this.exchange,
        provider: this.provider,
        withRetry,
      },
      trades,
      collateralToken,
      tokenId,
      onChainMarketId,
      reserveExpiry,
    );
  }

  // -----------------------------------------------------------------------
  // Balance reservation
  // -----------------------------------------------------------------------

  /**
   * Reserve a user's deposited balance before matching so that concurrent
   * orders cannot double-spend.
   */
  async reserveBalance(
    user: string,
    token: string,
    amount: string,
    expiry: number,
    marketId: string,
  ): Promise<{ success: boolean; txHash: string; error?: string }> {
    try {
      console.log(
        `[settler] reserving ${amount} of ${token} for ${user} (expiry=${expiry}, market=${marketId})`,
      );

      const reserveNonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
      const response: InvokeFunctionResponse = await this.exchange.invoke(
        "reserve_balance",
        [user, token, BigInt(amount), reserveNonce, expiry, BigInt(marketId)],
      );

      const receipt = await this.provider.waitForTransaction(response.transaction_hash);

      if (getExecutionStatus(receipt) === "REVERTED") {
        const reason = getRevertReason(receipt) ?? "unknown";
        console.error(`[settler] reserve_balance REVERTED: ${reason}`);
        return { success: false, txHash: response.transaction_hash, error: `TX reverted: ${reason}` };
      }

      if (getFinalityStatus(receipt) === "REJECTED") {
        return { success: false, txHash: response.transaction_hash, error: "TX rejected by network" };
      }

      console.log(
        `[settler] reservation confirmed for ${user}, tx=${response.transaction_hash}`,
      );

      return { success: true, txHash: response.transaction_hash };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[settler] failed to reserve balance for ${user}:`,
        message,
      );
      return { success: false, txHash: "", error: message };
    }
  }

  /**
   * Release reserved balance back to available.
   *
   * Cairo signature: release_balance(user, token, nonce, amount)
   */
  async releaseBalance(
    user: string,
    token: string,
    amount: string,
    nonce?: bigint,
  ): Promise<{ success: boolean; txHash: string; error?: string }> {
    try {
      console.log(
        `[settler] releasing ${amount} of ${token} for ${user}`,
      );

      const releaseNonce = nonce ?? BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
      const response: InvokeFunctionResponse = await this.exchange.invoke(
        "release_balance",
        [user, token, releaseNonce, BigInt(amount)],
      );

      const receipt = await this.provider.waitForTransaction(response.transaction_hash);

      if (getExecutionStatus(receipt) === "REVERTED") {
        const reason = getRevertReason(receipt) ?? "unknown";
        console.error(`[settler] release_balance REVERTED: ${reason}`);
        return { success: false, txHash: response.transaction_hash, error: `TX reverted: ${reason}` };
      }

      if (getFinalityStatus(receipt) === "REJECTED") {
        return { success: false, txHash: response.transaction_hash, error: "TX rejected by network" };
      }

      console.log(
        `[settler] balance released for ${user}`,
      );

      return { success: true, txHash: response.transaction_hash };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[settler] failed to release balance for ${user}:`,
        message,
      );
      return { success: false, txHash: "", error: message };
    }
  }

  // -----------------------------------------------------------------------
  // Combined settle-or-rollback
  // -----------------------------------------------------------------------

  /**
   * Attempt to settle a trade. On failure, release both buyer's and seller's
   * reserved balances so funds are not locked.
   */
  async settleOrRollback(
    trade: Trade,
    collateralToken: string,
    buyerReservedAmount: string,
    sellerReservedAmount: string,
    tokenId?: string,
    onChainMarketId?: string,
  ): Promise<SettlementResult> {
    return settleOrRollbackWithRelease(
      trade,
      collateralToken,
      buyerReservedAmount,
      sellerReservedAmount,
      () => this.settleTrade(trade, tokenId, onChainMarketId),
      (user, token, amount) => this.releaseBalance(user, token, amount),
    );
  }

  // -----------------------------------------------------------------------
  // Seed Liquidity — on-chain setup
  // -----------------------------------------------------------------------

  /**
   * Set up on-chain liquidity for a new market in one atomic multicall:
   *   1. Approve ConditionalTokens to spend USDC (for split_position)
   *   2. Call split_position → mints outcome tokens for admin
   *   3. Approve CLOBExchange to transfer ERC-1155 tokens (for settle_trade)
   *   4. Approve CLOBExchange to spend USDC (for deposit)
   *   5. Deposit USDC into exchange (for BID orders)
   *
   * After this, the admin holds outcome tokens AND has deposited collateral,
   * enabling both ASK and BID seed orders to settle on-chain.
   */
  async setupSeedLiquidity(params: {
    conditionId: string;
    collateralToken: string;
    splitAmount: bigint;
    depositAmount: bigint;
  }): Promise<{ success: boolean; txHash: string; error?: string }> {
    if (!this.conditionalTokensAddress) {
      return { success: false, txHash: "", error: "ConditionalTokens address not configured" };
    }

    try {
      const totalNeeded = params.splitAmount + params.depositAmount;
      console.log(
        `[settler] setting up seed liquidity: split=${params.splitAmount}, deposit=${params.depositAmount}, total=${totalNeeded} (${Number(totalNeeded) / 1e6} USDC)`,
      );

      const ct = new Contract({
        abi: ConditionalTokensABI as unknown as Contract["abi"],
        address: this.conditionalTokensAddress,
        providerOrAccount: this.account,
      });
      const erc20 = new Contract({
        abi: ERC20ABI as unknown as Contract["abi"],
        address: params.collateralToken,
        providerOrAccount: this.account,
      });

      // The vault calls erc20.transfer_from(admin, vault, amount) during
      // split_position — so the admin must approve the VAULT, not CT.
      const vaultAddress = getContractAddress("CollateralVault", "sepolia");

      // u256::MAX — avoids re-approving on subsequent seeds for the same spender.
      const U128_MAX = (2n ** 128n - 1n).toString();

      const calls: Call[] = [
        // 1. Approve vault to spend USDC (max approval — idempotent across seeds)
        erc20.populate("approve", [vaultAddress, { low: U128_MAX, high: U128_MAX }]),
        // 2. Split position: USDC → outcome tokens for admin
        ct.populate("split_position", [
          params.collateralToken,
          params.conditionId,
          params.splitAmount,
        ]),
        // 3. Approve exchange to transfer ERC-1155 outcome tokens (for settle_trade)
        ct.populate("set_approval_for_all", [this.exchangeAddress, true]),
        // 4. Approve exchange to spend USDC for deposit (max approval — idempotent)
        erc20.populate("approve", [this.exchangeAddress, { low: U128_MAX, high: U128_MAX }]),
        // 5. Deposit USDC for BID orders
        this.exchange.populate("deposit", [
          params.collateralToken,
          params.depositAmount,
        ]),
      ];

      const response = await withRetry(
        () => this.account.execute(calls),
        { label: "seed liquidity" },
      );

      console.log(
        `[settler] seed liquidity tx submitted: ${response.transaction_hash}`,
      );

      await withRetry(
        () => this.provider.waitForTransaction(response.transaction_hash),
        { label: "seed liquidity confirm" },
      );

      console.log(`[settler] seed liquidity confirmed`);

      return { success: true, txHash: response.transaction_hash };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Surface actionable diagnostics for common on-chain failures
      let diagnostic = message;
      if (message.includes("insufficient balance")) {
        const totalNeeded = params.splitAmount + params.depositAmount;
        diagnostic = `Admin account has insufficient USDC balance. Seeding requires ${Number(totalNeeded) / 1e6} USDC (${Number(params.splitAmount) / 1e6} for split + ${Number(params.depositAmount) / 1e6} for deposit). Fund admin address ${this.adminAddress} with USDC on Starknet Sepolia.`;
      } else if (message.includes("condition not found")) {
        diagnostic = `Condition ${params.conditionId} not found on ConditionalTokens (${this.conditionalTokensAddress}). The market may not have been created on-chain yet.`;
      }
      console.error(`[settler] seed liquidity setup failed:`, diagnostic);
      return { success: false, txHash: "", error: diagnostic };
    }
  }

  // -----------------------------------------------------------------------
  // Market Resolution
  // -----------------------------------------------------------------------

  /**
   * Resolve a market on-chain in two phases:
   *   1. Set dispute period to 1s + propose the winning outcome
   *   2. Wait for dispute period, then finalize resolution
   *
   * The AdminResolver calls ConditionalTokens.report_payouts() which marks
   * the condition as resolved and enables redeem_position() for token holders.
   */
  /**
   * Phase 1: Propose an outcome on-chain. Returns immediately after the
   * proposal tx is confirmed (~seconds). The caller must wait for the
   * dispute period (≥3600 s) and then call `finalizeResolution()`.
   */
  async proposeResolution(
    onChainMarketId: string,
    conditionId: string,
    winningOutcome: number,
  ): Promise<{ success: boolean; txHash: string; error?: string }> {
    try {
      console.log(
        `[settler] proposing resolution: onChainMarketId=${onChainMarketId}, conditionId=${conditionId}, winningOutcome=${winningOutcome}`,
      );

      const resolverAddress = getContractAddress("Resolver", "sepolia");
      const { ResolverABI } = await import("@market-zap/shared");
      const resolver = new Contract({
        abi: ResolverABI as unknown as Contract["abi"],
        address: resolverAddress,
        providerOrAccount: this.account,
      });

      const proposeCalls: Call[] = [
        resolver.populate("set_dispute_period", [3600]),
        resolver.populate("propose_outcome", [onChainMarketId, conditionId, winningOutcome]),
      ];

      const proposeResponse = await withRetry(
        () => this.account.execute(proposeCalls),
        { label: `propose ${conditionId}` },
      );

      console.log(
        `[settler] proposal tx submitted: ${proposeResponse.transaction_hash}`,
      );

      const proposeReceipt = await withRetry(
        () => this.provider.waitForTransaction(proposeResponse.transaction_hash),
        { label: `confirm proposal ${conditionId}` },
      );

      if (getExecutionStatus(proposeReceipt) === "REVERTED") {
        const reason = getRevertReason(proposeReceipt) ?? "unknown";
        console.error(`[settler] proposal REVERTED: ${reason}`);
        return { success: false, txHash: proposeResponse.transaction_hash, error: `Proposal reverted: ${reason}` };
      }

      console.log(`[settler] proposal confirmed: ${conditionId}`);
      return { success: true, txHash: proposeResponse.transaction_hash };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[settler] proposal failed:`, message);
      return { success: false, txHash: "", error: message };
    }
  }

  /**
   * Phase 2: Finalize a previously proposed resolution. Must be called
   * after the dispute period (≥3600 s) has elapsed.
   */
  async finalizeResolution(
    onChainMarketId: string,
    conditionId: string,
  ): Promise<{ success: boolean; txHash: string; error?: string }> {
    try {
      console.log(
        `[settler] finalizing resolution: onChainMarketId=${onChainMarketId}, conditionId=${conditionId}`,
      );

      const resolverAddress = getContractAddress("Resolver", "sepolia");
      const { ResolverABI } = await import("@market-zap/shared");
      const resolver = new Contract({
        abi: ResolverABI as unknown as Contract["abi"],
        address: resolverAddress,
        providerOrAccount: this.account,
      });

      const finalizeResponse = await withRetry(
        () => this.account.execute([
          resolver.populate("finalize_resolution", [onChainMarketId, conditionId]),
        ]),
        { label: `finalize ${conditionId}` },
      );

      console.log(
        `[settler] finalize tx submitted: ${finalizeResponse.transaction_hash}`,
      );

      const finalizeReceipt = await withRetry(
        () => this.provider.waitForTransaction(finalizeResponse.transaction_hash),
        { label: `confirm finalize ${conditionId}` },
      );

      if (getExecutionStatus(finalizeReceipt) === "REVERTED") {
        const reason = getRevertReason(finalizeReceipt) ?? "unknown";
        console.error(`[settler] finalize REVERTED: ${reason}`);
        return { success: false, txHash: finalizeResponse.transaction_hash, error: `Finalize reverted: ${reason}` };
      }

      console.log(`[settler] market resolved: ${conditionId}`);
      return { success: true, txHash: finalizeResponse.transaction_hash };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[settler] finalize failed:`, message);
      return { success: false, txHash: "", error: message };
    }
  }

  /**
   * Read the on-chain proposal for a condition_id from the AdminResolver.
   * Returns null if no proposal exists (status == None).
   */
  async getOnChainProposal(
    conditionId: string,
  ): Promise<{ proposedOutcome: number; proposedAt: number; disputePeriod: number; status: number } | null> {
    try {
      const resolverAddress = getContractAddress("Resolver", "sepolia");
      const { ResolverABI } = await import("@market-zap/shared");
      const resolver = new Contract({
        abi: ResolverABI as unknown as Contract["abi"],
        address: resolverAddress,
        providerOrAccount: this.provider,
      });
      const result = await resolver.call("get_proposal", [conditionId]) as {
        proposed_outcome: bigint | number;
        proposed_at: bigint | number;
        dispute_period: bigint | number;
        status: { variant: Record<string, unknown> } | bigint | number;
      };

      // Status is an enum: 0=None, 1=Proposed, 2=Finalized
      let statusNum = 0;
      if (typeof result.status === "object" && result.status !== null && "variant" in result.status) {
        const variant = result.status.variant;
        if ("Proposed" in variant) statusNum = 1;
        else if ("Finalized" in variant) statusNum = 2;
      } else {
        statusNum = Number(result.status);
      }

      if (statusNum === 0) return null;

      return {
        proposedOutcome: Number(result.proposed_outcome),
        proposedAt: Number(result.proposed_at),
        disputePeriod: Number(result.dispute_period),
        status: statusNum,
      };
    } catch (err) {
      console.warn(`[settler] getOnChainProposal failed:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Order Signing — for admin seed orders
  // -----------------------------------------------------------------------

  /**
   * Sign an order with the admin's Stark private key.
   * Returns the signature in "r,s" format matching the engine's expected format.
   */
  signSeedOrder(order: OrderHashParams): string {
    return signSeedOrderWithKey(
      order,
      this.exchangeAddress,
      this.adminPrivateKey,
    );
  }
}
