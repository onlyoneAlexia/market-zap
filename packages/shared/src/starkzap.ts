import { StarkSDK, StarkSigner, Contract } from "starkzap";
import type { WalletInterface } from "starkzap";
import type { Call, Signature, Account } from "starknet";
import { hash, RpcProvider, byteArray } from "starknet";
import { getContractAddress, CLOBRouterABI, ERC20ABI, MarketFactoryABI, ResolverABI, ConditionalTokensABI } from "./contracts";
import type { SupportedNetwork } from "./constants";
import { computeOrderHash, signOrderHash, formatSignature, buildOrderTypedData } from "./order-hash";
import type { OrderHashParams } from "./order-hash";
import {
  getMarketZapCartridgeConnectOptions,
  type CartridgeConnectOptions,
} from "./starkzap-config";
import {
  cleanupCartridgeControllerDom,
  extractMarketCreatedEvent,
  normalizeAddress,
  type ConnectOptions,
  type CreateMarketResult,
  type FeeMode,
  type TransactionResult,
  type WalletConnectionKind,
  type WalletState,
} from "./starkzap-internals";
export {
  cleanupCartridgeControllerDom,
  type ConnectOptions,
  type CreateMarketResult,
  type FeeMode,
  type TransactionResult,
  type WalletConnectionKind,
  type WalletState,
} from "./starkzap-internals";

const MAINNET_CHAIN_ID = "0x534e5f4d41494e";
const SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";

export class MarketZapWallet {
  private sdk: StarkSDK;
  private wallet: WalletInterface | null = null;
  private privateKey: string | null = null;
  private network: SupportedNetwork;
  private feeMode: FeeMode;
  private connectionKind: WalletConnectionKind = "none";

  constructor(
    network: SupportedNetwork = "sepolia",
    options?: {
      rpcUrl?: string;
      feeMode?: FeeMode;
    },
  ) {
    this.network = network;
    this.feeMode = options?.feeMode ?? "sponsored";

    const sdkConfig: Record<string, unknown> = { network };
    if (options?.rpcUrl) {
      sdkConfig.rpcUrl = options.rpcUrl;
    }
    this.sdk = new StarkSDK(sdkConfig as any);
  }

  /**
   * Connect with a private key (dev wallet / engine admin).
   * Stores the private key for sync order signing.
   *
   * @param address - The expected on-chain address. Validated against the SDK-derived address.
   * @param privateKey - The Stark private key.
   * @param accountClass - Optional custom account class config (class hash + calldata builder).
   *   Required if the account was deployed with a non-default OZ class hash.
   */
  async connectWithPrivateKey(
    address: string,
    privateKey: string,
    accountClass?: { classHash: string; buildConstructorCalldata: (pk: string) => string[] },
  ): Promise<WalletState> {
    this.privateKey = privateKey;
    this.connectionKind = "dev";
    this.wallet = await this.sdk.connectWallet({
      account: {
        signer: new StarkSigner(privateKey),
        ...(accountClass ? { accountClass } : {}),
      },
      feeMode: this.feeMode,
    });
    // Validate: SDK-derived address must match the expected address
    // Use normalizeAddress to handle padding differences (0x00abc vs 0xabc)
    const derivedAddress = normalizeAddress(this.wallet.address.toString());
    const expectedAddress = normalizeAddress(address);
    if (derivedAddress !== expectedAddress) {
      // Address mismatch — likely a class hash mismatch between the SDK preset
      // and the actual deployed account. Disconnect and report.
      await this.wallet.disconnect();
      this.wallet = null;
      this.privateKey = null;
      this.connectionKind = "none";
      throw new Error(
        `Address mismatch: SDK derived ${derivedAddress} but expected ${expectedAddress}. ` +
        `The account may have been deployed with a different class hash. ` +
        `Pass the correct accountClass config.`
      );
    }
    return this.getState();
  }

  /**
   * Connect via Cartridge Controller (social login — Google, passkeys, Discord).
   * Opens the Cartridge auth popup. No browser extension needed.
   */
  async connectCartridge(options?: CartridgeConnectOptions): Promise<WalletState> {
    cleanupCartridgeControllerDom();
    this.privateKey = null;
    const cartridgeWallet = await this.sdk.connectCartridge({
      ...getMarketZapCartridgeConnectOptions(this.network, options),
      // Cartridge Controller handles session-backed execution itself. Avoid
      // StarkZap's generic sponsored/SNIP-9 path for this wallet type.
      feeMode: "user_pays",
    });
    this.wallet = cartridgeWallet;
    this.connectionKind = "cartridge";
    return this.getState();
  }

  /**
   * Connect with an externally-provided WalletInterface.
   * Chain validation is the caller's responsibility — StarkZap SDK wallets
   * (from connectWallet/connectCartridge) already validate the chain internally.
   */
  connectWithWallet(
    wallet: WalletInterface,
    connectionKind: Exclude<WalletConnectionKind, "none"> = "external",
  ): WalletState {
    this.privateKey = null;
    this.wallet = wallet;
    this.connectionKind = connectionKind;
    return this.getState();
  }

  /**
   * Connect with an external starknet.js Account (from browser wallet extensions).
   * Wraps the Account in a lightweight WalletInterface adapter so that
   * Argent X / Braavos users can use all MarketZapWallet features.
   *
   * @param expectedChainId - Optional chain ID to validate against the account's chain.
   *   Pass the hex chain ID (e.g. "0x534e5f5345504f4c4941" for Sepolia).
   */
  async connectWithExternalAccount(account: Account, expectedChainId?: string): Promise<WalletState> {
    // Chain validation: ensure the browser wallet is on the expected network
    if (expectedChainId) {
      let detectedChainId: string | undefined;
      try {
        const provider = account as unknown as RpcProvider;
        detectedChainId = await provider.getChainId();
      } catch {
        // Wallet doesn't support getChainId — hard fail rather than connecting on wrong chain
        throw new Error(
          "Unable to verify wallet network. Please ensure your wallet is connected to Sepolia."
        );
      }
      if (detectedChainId !== expectedChainId) {
        throw new Error(
          `Wrong network: wallet is on ${detectedChainId}, expected ${expectedChainId}. ` +
          `Please switch your wallet to Sepolia.`
        );
      }
    }

    this.privateKey = null;
    const rpcProvider = this.sdk.getProvider();
    // Create a lightweight WalletInterface adapter around the raw Account
    this.wallet = {
      address: account.address,
      getAccount: () => account,
      // Keep signing/submission on the browser wallet, but route reads and
      // receipt polling through StarkZap's configured RPC provider.
      getProvider: () => rpcProvider as any,
      execute: async (calls: Call[]) => {
        const result = await account.execute(calls as any);
        // Braavos / ArgentX may return { hash }, { transactionHash }, or { transaction_hash }
        const txHash =
          (result as any).hash ??
          (result as any).transactionHash ??
          (result as any).transaction_hash ??
          (typeof result === "string" ? result : "");
        if (!txHash) throw new Error("No transaction hash returned from wallet");
        return {
          transactionHash: txHash,
          wait: async () => {
            const receipt = await rpcProvider.waitForTransaction(txHash);
            // finality_status = "REJECTED" means the tx was dropped before block inclusion
            const finalityStatus =
              (receipt as any).finality_status ?? (receipt as any).finalityStatus;
            if (finalityStatus === "REJECTED") {
              throw new Error("Transaction was rejected by the network before block inclusion");
            }
            const execStatus =
              (receipt as any).execution_status ?? (receipt as any).executionStatus;
            if (execStatus === "REVERTED") {
              const revertReason =
                (receipt as any).revert_reason ??
                (receipt as any).revertReason ??
                "Transaction reverted on-chain";
              throw new Error(revertReason);
            }
            // If execStatus is present and not SUCCEEDED, surface it.
            // If absent (some RPC versions omit it for pending txs), treat as success.
            if (execStatus && execStatus !== "SUCCEEDED") {
              throw new Error(`Unexpected transaction status: ${execStatus}`);
            }
          },
        } as any;
      },
      signMessage: async (typedData: any) => {
        return account.signMessage(typedData) as any;
      },
      preflight: async () => ({ ok: true }),
      ensureReady: async () => {},
      disconnect: async () => {},
    } as unknown as WalletInterface;
    this.connectionKind = "external";
    return this.getState();
  }

  /** Disconnect the current wallet. */
  async disconnect(): Promise<void> {
    if (this.wallet) {
      await this.wallet.disconnect();
    }
    this.wallet = null;
    this.privateKey = null;
    this.connectionKind = "none";
  }

  /** Get the current connection state. */
  getState(): WalletState {
    // Browser wallet adapters (Argent X/Braavos) can't provide gasless UX.
    // Cartridge is still gasless from the user's perspective even though we
    // route execution through its controller-backed `execute()` path.
    const isExternalAdapter = this.connectionKind === "external";
    const isGaslessUserExperience =
      this.connectionKind === "cartridge" ||
      (this.feeMode === "sponsored" && !isExternalAdapter);

    return {
      connected: this.wallet !== null,
      address: this.wallet?.address?.toString() ?? null,
      network: this.network,
      connecting: false,
      gasless: isGaslessUserExperience,
      connectionKind: this.connectionKind,
      supportsPreflight: this.connectionKind === "cartridge",
    };
  }

  /** Whether this client has a connected wallet. */
  hasWallet(): boolean {
    return this.wallet !== null;
  }

  /** Get the underlying WalletInterface (for advanced ops). */
  getWallet(): WalletInterface | null {
    return this.wallet;
  }

  /** Get the SDK instance. */
  getSDK(): StarkSDK {
    return this.sdk;
  }

  /** Ensure the wallet account is deployed on-chain. */
  async ensureReady(): Promise<void> {
    if (!this.wallet) throw new Error("Wallet not connected");
    if (this.connectionKind === "cartridge") {
      await this.wallet.ensureReady({
        deploy: "if_needed",
      });
      return;
    }

    await this.wallet.ensureReady({
      deploy: "if_needed",
      feeMode: this.feeMode,
    });
  }

  private async preflightCalls(
    calls: Call[],
    feeMode: FeeMode,
  ): Promise<void> {
    if (!this.wallet || this.connectionKind !== "cartridge") {
      return;
    }

    const result = await this.wallet.preflight({
      calls,
      feeMode,
    });

    if (!result.ok) {
      throw new Error(result.reason);
    }
  }

  private async exec(
    calls: Call[],
    overrideFeeMode?: FeeMode,
  ): Promise<{ txHash: string }> {
    if (!this.wallet) throw new Error("Wallet not connected");
    // Cartridge controller accounts expose the sponsored UX through their own
    // `execute()` implementation. Using StarkZap's generic sponsored branch
    // falls back to a SNIP-9 paymaster path that these accounts reject.
    const effectiveFeeMode = this.connectionKind === "cartridge"
      ? "user_pays"
      : (overrideFeeMode ?? this.feeMode);
    await this.preflightCalls(calls, effectiveFeeMode);
    const tx = await this.wallet.execute(calls, {
      feeMode: effectiveFeeMode,
    });
    await tx.wait();
    // StarkZap SDK Tx object exposes `hash`, starknet.js raw returns `transaction_hash`
    const txHash = (tx as any).hash ?? (tx as any).transactionHash ?? (tx as any).transaction_hash ?? "";
    if (!txHash) {
      throw new Error("Transaction submitted but no transaction hash was returned");
    }

    // Verify on-chain execution status — Starknet can finalize REVERTED txs
    // which tx.wait() may not catch (e.g. Cartridge session-key txs).
    try {
      const provider = this.sdk.getProvider();
      const receipt = await provider.getTransactionReceipt(txHash);
      const execStatus = (receipt as any)?.execution_status ?? (receipt as any)?.executionStatus;
      if (execStatus === "REVERTED") {
        const reason = (receipt as any)?.revert_reason ?? (receipt as any)?.revertReason ?? "unknown reason";
        throw new Error(`Transaction reverted on-chain: ${reason}`);
      }
    } catch (verifyErr) {
      // Re-throw our own REVERTED error; swallow RPC fetch failures (non-critical)
      if (verifyErr instanceof Error && verifyErr.message.includes("reverted on-chain")) {
        throw verifyErr;
      }
    }

    return { txHash };
  }

  private get chainId(): string {
    return this.network === "mainnet" ? MAINNET_CHAIN_ID : SEPOLIA_CHAIN_ID;
  }

  private errorMessage(error: unknown): string {
    // starknet.js v9 nests the actual contract revert reason inside
    // error.baseError.data.revert_error  (RpcError from simulation / fee estimation)
    // or error.cause (waitForTransaction).  Extract the human-readable part.
    const extractRevertReason = (err: unknown): string | null => {
      if (!err || typeof err !== "object") return null;
      const obj = err as Record<string, unknown>;

      // RpcError path: baseError.data.revert_error (nested)
      const baseError = obj.baseError as Record<string, unknown> | undefined;
      if (baseError?.data && typeof baseError.data === "object") {
        const data = baseError.data as Record<string, unknown>;
        let revert = data.revert_error as Record<string, unknown> | string | undefined;
        // Walk nested .error until we reach a string or a leaf with 'error' as string
        while (revert && typeof revert === "object") {
          const inner = (revert as Record<string, unknown>).error;
          if (typeof inner === "string") {
            // "0xhex ('Human readable')" → extract quoted part
            const match = inner.match(/'([^']+)'/);
            return match ? match[1] : inner;
          }
          revert = inner as Record<string, unknown> | string | undefined;
        }
        if (typeof revert === "string") {
          const match = revert.match(/'([^']+)'/);
          return match ? match[1] : revert;
        }
      }

      // Error.cause path (waitForTransaction "Transaction failed")
      const cause = obj.cause;
      if (cause) return extractRevertReason(cause);

      return null;
    };

    const revertReason = extractRevertReason(error);
    if (revertReason) return revertReason;

    // Fallback: try to extract a quoted reason from the message string
    if (error instanceof Error) {
      const match = error.message.match(/'([A-Z][A-Za-z0-9: _<>=]+)'/);
      if (match) return match[1];
      // Truncate overly verbose RPC debug messages
      if (error.message.length > 200) {
        return error.message.slice(0, 200) + "...";
      }
      return error.message;
    }
    return String(error);
  }

  private failedTransaction(error: unknown) {
    return { txHash: "", success: false as const, error: this.errorMessage(error) };
  }

  private async submitCalls(
    calls: Call[],
    feeMode?: FeeMode,
  ): Promise<TransactionResult> {
    try {
      const { txHash } = await this.exec(calls, feeMode);
      return { txHash, success: true };
    } catch (error) {
      return this.failedTransaction(error);
    }
  }

  // u256::MAX split into (low, high) each u128::MAX — effectively infinite allowance.
  private static readonly MAX_APPROVAL_LOW = (2n ** 128n - 1n).toString();
  private static readonly MAX_APPROVAL_HIGH = (2n ** 128n - 1n).toString();

  /**
   * Returns an approve Call only if the current allowance is below `requiredAmount`.
   * When an approval IS needed, approves u256::MAX so subsequent calls skip it entirely.
   * Falls back to issuing a max-approval if the allowance check RPC call fails.
   */
  private async buildApproveIfNeeded(
    tokenAddress: string,
    ownerAddress: string,
    spenderAddress: string,
    requiredAmount: bigint,
  ): Promise<Call[]> {
    try {
      const provider = this.wallet!.getProvider();
      const token = new Contract({ abi: ERC20ABI as any, address: tokenAddress, providerOrAccount: provider });
      const raw = await token.call("allowance", [ownerAddress, spenderAddress]);
      // starknet.js v9 returns u256 as { low: bigint, high: bigint }
      let currentAllowance: bigint;
      if (typeof raw === "bigint") {
        currentAllowance = raw;
      } else if (raw && typeof raw === "object") {
        const low = BigInt((raw as any).low ?? 0n);
        const high = BigInt((raw as any).high ?? 0n);
        currentAllowance = (high << 128n) + low;
      } else {
        currentAllowance = 0n;
      }
      if (currentAllowance >= requiredAmount) {
        return []; // Allowance sufficient — no approve tx needed
      }
    } catch {
      // RPC allowance check failed — include the approval to be safe
    }
    return [{
      contractAddress: tokenAddress,
      entrypoint: "approve",
      calldata: [spenderAddress, MarketZapWallet.MAX_APPROVAL_LOW, MarketZapWallet.MAX_APPROVAL_HIGH],
    }];
  }

  /** Approve a spender to transfer tokens. */
  async approve(
    tokenAddress: string,
    spenderAddress: string,
    amount: bigint,
  ): Promise<TransactionResult> {
    return this.submitCalls([{
      contractAddress: tokenAddress,
      entrypoint: "approve",
      calldata: [spenderAddress, amount.toString(), "0"],
    }]);
  }

  /**
   * Testnet faucet: mint USDC + approve exchange + deposit — all gasless in one multicall.
   */
  async mintAndDeposit(amount: bigint): Promise<TransactionResult> {
    if (!this.wallet) throw new Error("Wallet not connected");
    const address = this.wallet.address.toString();
    const usdcAddress = getContractAddress("USDC", this.network);
    const exchangeAddress = getContractAddress("CLOBRouter", this.network);

    return this.submitCalls([
      {
        contractAddress: usdcAddress,
        entrypoint: "mint",
        calldata: [address, amount.toString(), "0"],
      },
      {
        contractAddress: usdcAddress,
        entrypoint: "approve",
        calldata: [exchangeAddress, MarketZapWallet.MAX_APPROVAL_LOW, MarketZapWallet.MAX_APPROVAL_HIGH],
      },
      {
        contractAddress: exchangeAddress,
        entrypoint: "deposit",
        calldata: [usdcAddress, amount.toString(), "0"],
      },
    ]);
  }

  /** Mint test USDC (Sepolia only). */
  async mintTestUSDC(amount: bigint): Promise<TransactionResult> {
    if (!this.wallet) throw new Error("Wallet not connected");
    const address = this.wallet.address.toString();
    const usdcAddress = getContractAddress("USDC", this.network);
    return this.submitCalls([{
      contractAddress: usdcAddress,
      entrypoint: "mint",
      calldata: [address, amount.toString(), "0"],
    }]);
  }

  /** Approve + Deposit in a single gasless multicall. Skips the approve if allowance is already sufficient. */
  async approveAndDeposit(
    tokenAddress: string,
    amount: bigint,
  ): Promise<TransactionResult> {
    if (!this.wallet) throw new Error("Wallet not connected");
    const address = this.wallet.address.toString();
    const exchangeAddress = getContractAddress("CLOBRouter", this.network);
    const approveCalls = await this.buildApproveIfNeeded(tokenAddress, address, exchangeAddress, amount);
    return this.submitCalls([
      ...approveCalls,
      {
        contractAddress: exchangeAddress,
        entrypoint: "deposit",
        calldata: [tokenAddress, amount.toString(), "0"],
      },
    ]);
  }

  /** Deposit collateral into the exchange. */
  async deposit(tokenAddress: string, amount: bigint): Promise<TransactionResult> {
    return this.submitCalls([{
      contractAddress: getContractAddress("CLOBRouter", this.network),
      entrypoint: "deposit",
      calldata: [tokenAddress, amount.toString(), "0"],
    }]);
  }

  /** Withdraw collateral from the exchange. */
  async withdraw(tokenAddress: string, amount: bigint): Promise<TransactionResult> {
    return this.submitCalls([{
      contractAddress: getContractAddress("CLOBRouter", this.network),
      entrypoint: "withdraw",
      calldata: [tokenAddress, amount.toString(), "0"],
    }]);
  }

  /** Split position: deposit collateral and receive outcome tokens. */
  async splitPosition(
    collateralToken: string,
    conditionId: string,
    amount: bigint,
  ): Promise<TransactionResult> {
    return this.submitCalls([{
      contractAddress: getContractAddress("ConditionalTokens", this.network),
      entrypoint: "split_position",
      calldata: [collateralToken, conditionId, amount.toString(), "0"],
    }]);
  }

  /** Check if an operator is approved for all ERC-1155 outcome tokens. */
  async isApprovedForAll(owner: string, operator: string): Promise<boolean> {
    if (!this.wallet) throw new Error("Wallet not connected");
    const provider = this.wallet.getProvider();
    const ct = new Contract({
      abi: ConditionalTokensABI as any,
      address: getContractAddress("ConditionalTokens", this.network),
      providerOrAccount: provider,
    });
    try {
      const result = await ct.call("is_approved_for_all", [owner, operator]);
      // OZ ERC-1155 returns a bool (0n/1n or true/false depending on ABI decoding)
      if (typeof result === "boolean") return result;
      if (typeof result === "bigint") return result !== 0n;
      return !!result;
    } catch {
      return false; // Assume not approved if RPC fails
    }
  }

  /**
   * Ensure the exchange is approved to transfer the user's ERC-1155 outcome
   * tokens.  Required before selling shares — the on-chain `settle_trade`
   * calls `safe_transfer_from(seller, buyer, …)` which needs operator approval.
   *
   * Returns immediately (no tx) if already approved.
   */
  async ensureExchangeApprovedForSell(): Promise<TransactionResult> {
    if (!this.wallet) throw new Error("Wallet not connected");
    const owner = this.wallet.address.toString();
    const exchange = getContractAddress("CLOBRouter", this.network);
    const approved = await this.isApprovedForAll(owner, exchange);
    if (approved) {
      return { txHash: "", success: true };
    }
    return this.setApprovalForAll(exchange, true);
  }

  /** Set approval for all ERC-1155 outcome tokens. */
  async setApprovalForAll(operator: string, approved: boolean): Promise<TransactionResult> {
    return this.submitCalls([{
      contractAddress: getContractAddress("ConditionalTokens", this.network),
      entrypoint: "set_approval_for_all",
      calldata: [operator, approved ? "1" : "0"],
    }]);
  }

  private buildCreateMarketCall(
    factoryAddress: string,
    resolverAddress: string,
    params: {
      question: string;
      category: string;
      outcomes: string[];
      collateralToken: string;
      resolutionTime: number;
      marketType?: "public" | "private";
    },
  ): Call {
    const categoryHash = hash.getSelectorFromName(params.category);
    const outcomeFelts = params.outcomes.map((outcome) => hash.getSelectorFromName(outcome));
    const marketTypeU8 = params.marketType === "private" ? 1 : 0;
    const createArgs = [
      params.question,
      outcomeFelts,
      categoryHash,
      params.collateralToken,
      params.resolutionTime,
      resolverAddress,
      marketTypeU8,
    ];

    // Browser wallets (Braavos/ArgentX) may recompile calldata inside execute().
    // To avoid double-compilation of complex types (ByteArray, Span), we
    // pre-compile into a flat string[] that wallets pass through as-is.
    if (this.connectionKind === "external") {
      const ba = byteArray.byteArrayFromString(params.question);
      const compiledCalldata: string[] = [
        // ByteArray: [data.length, ...data, pending_word, pending_word_len]
        ba.data.length.toString(),
        ...ba.data.map((d) => d.toString()),
        ba.pending_word.toString(),
        ba.pending_word_len.toString(),
        // Span<felt252>: [length, ...elements]
        outcomeFelts.length.toString(),
        ...outcomeFelts,
        // Remaining scalar params
        categoryHash,
        params.collateralToken,
        params.resolutionTime.toString(),
        resolverAddress,
        marketTypeU8.toString(),
      ];
      return {
        contractAddress: factoryAddress,
        entrypoint: "create_market",
        calldata: compiledCalldata,
      };
    }

    const account = this.wallet!.getAccount();
    const factory = new Contract({
      abi: MarketFactoryABI as any,
      address: factoryAddress,
      providerOrAccount: account,
    });

    return factory.populate("create_market", createArgs);
  }

  /** Create a prediction market via MarketFactory. */
  async createMarket(params: {
    question: string;
    category: string;
    outcomes: string[];
    collateralToken: string;
    resolutionTime: number;
    marketType?: "public" | "private";
  }): Promise<CreateMarketResult> {
    if (!this.wallet) throw new Error("Wallet not connected");
    try {
      const factoryAddress = getContractAddress("MarketFactory", this.network);
      const resolverAddress = getContractAddress("Resolver", this.network);
      const createCall = this.buildCreateMarketCall(
        factoryAddress,
        resolverAddress,
        params,
      );

      const { txHash } = await this.exec([createCall]);

      const provider = this.wallet.getProvider();
      const receipt = await provider.waitForTransaction(txHash);
      const { marketId, conditionId } = extractMarketCreatedEvent(
        receipt,
        factoryAddress,
      );
      return { txHash, success: true, marketId, conditionId };
    } catch (err) {
      return this.failedTransaction(err);
    }
  }

  /** Approve bond + Create market in a single gasless multicall. */
  async approveAndCreateMarket(
    bondTokenAddress: string,
    bondAmount: bigint,
    params: {
      question: string;
      category: string;
      outcomes: string[];
      collateralToken: string;
      resolutionTime: number;
      marketType?: "public" | "private";
    },
  ): Promise<CreateMarketResult> {
    if (!this.wallet) throw new Error("Wallet not connected");
    try {
      const factoryAddress = getContractAddress("MarketFactory", this.network);
      const resolverAddress = getContractAddress("Resolver", this.network);

      const address = this.wallet.address.toString();

      // Pre-flight: verify the user has enough bond tokens before hitting the wallet.
      // This gives a clear error instead of a cryptic "Execute failed" from the sequencer.
      try {
        const provider = this.wallet.getProvider();
        const token = new Contract({ abi: ERC20ABI as any, address: bondTokenAddress, providerOrAccount: provider });
        const raw = await token.call("balance_of", [address]);
        let balance: bigint;
        if (typeof raw === "bigint") {
          balance = raw;
        } else if (raw && typeof raw === "object") {
          const low = BigInt((raw as any).low ?? 0n);
          const high = BigInt((raw as any).high ?? 0n);
          balance = (high << 128n) + low;
        } else {
          balance = BigInt(String(raw));
        }
        if (balance < bondAmount) {
          const decimals = 6; // USDC
          const have = (Number(balance) / 10 ** decimals).toFixed(2);
          const need = (Number(bondAmount) / 10 ** decimals).toFixed(2);
          return {
            txHash: "", success: false,
            error: `Insufficient USDC balance: you have ${have} but need ${need} for the bond`,
          };
        }
      } catch {
        // RPC balance check failed — proceed and let the chain decide
      }

      // Only emit approve if the factory's current allowance is below the bond amount.
      // On re-use (same address, same factory), this skips the approve entirely.
      const approveCalls = await this.buildApproveIfNeeded(bondTokenAddress, address, factoryAddress, bondAmount);
      const createCall = this.buildCreateMarketCall(
        factoryAddress,
        resolverAddress,
        params,
      );

      const { txHash } = await this.exec([...approveCalls, createCall]);

      const provider = this.wallet.getProvider();
      const receipt = await provider.waitForTransaction(txHash);
      const { marketId, conditionId } = extractMarketCreatedEvent(
        receipt,
        factoryAddress,
      );
      return { txHash, success: true, marketId, conditionId };
    } catch (err) {
      return this.failedTransaction(err);
    }
  }

  async proposeOutcome(marketId: string, conditionId: string, outcomeIndex: number): Promise<TransactionResult> {
    return this.submitCalls([{
      contractAddress: getContractAddress("Resolver", this.network),
      entrypoint: "propose_outcome",
      calldata: [marketId, conditionId, outcomeIndex.toString()],
    }], "user_pays");
  }

  async finalizeResolution(marketId: string, conditionId: string): Promise<TransactionResult> {
    return this.submitCalls([{
      contractAddress: getContractAddress("Resolver", this.network),
      entrypoint: "finalize_resolution",
      calldata: [marketId, conditionId],
    }], "user_pays");
  }

  async redeemPosition(
    collateralToken: string,
    conditionId: string,
  ): Promise<TransactionResult> {
    try {
      const ctAddress = getContractAddress("ConditionalTokens", this.network);
      const call: Call = {
        contractAddress: ctAddress,
        entrypoint: "redeem_position",
        calldata: [collateralToken, conditionId],
      };
      const { txHash } = await this.exec([call]);
      return { txHash, success: true };
    } catch (err) {
      const raw = this.errorMessage(err);
      const ctMatch = raw.match(/CT:\s*([^'"\n]+)/);
      const errorMsg = ctMatch
        ? `Contract error: ${ctMatch[1].trim()}`
        : raw.length > 200 ? raw.slice(0, 200) + "..." : raw;
      return { txHash: "", success: false, error: errorMsg };
    }
  }

  canSignOrders(): boolean {
    return this.privateKey !== null || this.wallet !== null;
  }

  signOrder(order: OrderHashParams): string {
    if (!this.privateKey) throw new Error("Order signing requires a private key connection");
    const exchangeAddress = getContractAddress("CLOBRouter", this.network);
    const orderHash = computeOrderHash(order, exchangeAddress, this.chainId);
    const sig = signOrderHash(orderHash, this.privateKey);
    return formatSignature(sig);
  }

  async signOrderAsync(order: OrderHashParams): Promise<string> {
    if (this.privateKey) return this.signOrder(order);
    if (!this.wallet) throw new Error("No wallet connected for order signing");

    const td = buildOrderTypedData(order, this.chainId);
    const sig: Signature = await this.wallet.signMessage(td);

    if (Array.isArray(sig)) {
      if (sig.length < 2) throw new Error("Invalid signature: expected at least [r, s]");
      // Normalize each element: may be bigint, number, or hex string
      return sig.map((v) => {
        const n = typeof v === "string" && v.startsWith("0x") ? BigInt(v) : BigInt(v);
        return `0x${n.toString(16)}`;
      }).join(",");
    } else {
      // Object format: { r: bigint, s: bigint } (starknet.js WeierstrassSignature)
      const sigObj = sig as { r: bigint; s: bigint };
      if (sigObj.r == null || sigObj.s == null) {
        throw new Error("Invalid signature object: missing r or s");
      }
      const r = `0x${BigInt(sigObj.r).toString(16)}`;
      const s = `0x${BigInt(sigObj.s).toString(16)}`;
      return `${r},${s}`;
    }
  }

  getOrderHash(order: OrderHashParams): string {
    const exchangeAddress = getContractAddress("CLOBRouter", this.network);
    return computeOrderHash(order, exchangeAddress, this.chainId);
  }

  async getTokenBalance(tokenAddress: string, userAddress: string): Promise<bigint> {
    const provider = this.sdk.getProvider();
    const result = await provider.callContract({
      contractAddress: tokenAddress,
      entrypoint: "balance_of",
      calldata: [userAddress],
    });
    // ERC-20 balance_of returns u256 as [low, high]
    const low = BigInt(result[0] ?? "0");
    const high = BigInt(result[1] ?? "0");
    return low + (high << 128n);
  }

  async getExchangeBalance(user: string, token: string): Promise<bigint> {
    const exchangeAddress = getContractAddress("CLOBRouter", this.network);
    const provider = this.sdk.getProvider();
    const result = await provider.callContract({
      contractAddress: exchangeAddress,
      entrypoint: "get_balance",
      calldata: [user, token],
    });
    // get_balance returns u256 as [low, high]
    const low = BigInt(result[0] ?? "0");
    const high = BigInt(result[1] ?? "0");
    return low + (high << 128n);
  }

  async getExchangeReserved(user: string, token: string): Promise<bigint> {
    const exchangeAddress = getContractAddress("CLOBRouter", this.network);
    const provider = this.sdk.getProvider();
    const result = await provider.callContract({
      contractAddress: exchangeAddress,
      entrypoint: "get_reserved",
      calldata: [user, token],
    });
    // get_reserved returns u256 as [low, high]
    const low = BigInt(result[0] ?? "0");
    const high = BigInt(result[1] ?? "0");
    return low + (high << 128n);
  }

  async getOutcomeTokenBalance(user: string, tokenId: bigint): Promise<bigint> {
    const ctAddress = getContractAddress("ConditionalTokens", this.network);
    const provider = this.sdk.getProvider();
    // Token ID is a u256 — must be split into low (128-bit) and high (128-bit) limbs
    const MASK_128 = (1n << 128n) - 1n;
    const low = tokenId & MASK_128;
    const high = tokenId >> 128n;
    const result = await provider.callContract({
      contractAddress: ctAddress,
      entrypoint: "balance_of",
      calldata: [user, low.toString(), high.toString()],
    });
    // balance_of returns a u256 as two felts: [low, high]
    const balLow = BigInt(result[0] ?? "0");
    const balHigh = BigInt(result[1] ?? "0");
    return balLow + (balHigh << 128n);
  }

  getProvider() {
    return this.sdk.getProvider();
  }

  getVaultAddress(): string {
    return getContractAddress("CollateralVault", this.network);
  }
}

// Backward-compat alias so existing imports don't break
export { MarketZapWallet as StarkZapClient };
