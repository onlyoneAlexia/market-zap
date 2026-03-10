import { StarkSDK, StarkSigner, Contract } from "starkzap";
import type { WalletInterface } from "starkzap";
import type { Call, Signature, Account } from "starknet";
import { hash, RpcProvider } from "starknet";
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
    // Create a lightweight WalletInterface adapter around the raw Account
    this.wallet = {
      address: account.address,
      getAccount: () => account,
      getProvider: () => account as any,
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
            const receipt = await account.waitForTransaction(txHash);
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
    return { txHash };
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
    try {
      const call: Call = {
        contractAddress: tokenAddress,
        entrypoint: "approve",
        calldata: [spenderAddress, amount.toString(), "0"],
      };
      const { txHash } = await this.exec([call]);
      return { txHash, success: true };
    } catch (err) {
      return { txHash: "", success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Testnet faucet: mint USDC + approve exchange + deposit — all gasless in one multicall.
   */
  async mintAndDeposit(amount: bigint): Promise<TransactionResult> {
    if (!this.wallet) throw new Error("Wallet not connected");
    try {
      const address = this.wallet.address.toString();
      const usdcAddress = getContractAddress("USDC", this.network);
      const exchangeAddress = getContractAddress("CLOBRouter", this.network);

      const mintCall: Call = {
        contractAddress: usdcAddress,
        entrypoint: "mint",
        calldata: [address, amount.toString(), "0"],
      };
      // After mint the new tokens aren't on-chain yet, so allowance check would
      // undercount — always include approve here (mint + approve + deposit = 3 calls).
      const approveCall: Call = {
        contractAddress: usdcAddress,
        entrypoint: "approve",
        calldata: [exchangeAddress, MarketZapWallet.MAX_APPROVAL_LOW, MarketZapWallet.MAX_APPROVAL_HIGH],
      };
      const depositCall: Call = {
        contractAddress: exchangeAddress,
        entrypoint: "deposit",
        calldata: [usdcAddress, amount.toString(), "0"],
      };

      const { txHash } = await this.exec([mintCall, approveCall, depositCall]);
      return { txHash, success: true };
    } catch (err) {
      return { txHash: "", success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Mint test USDC (Sepolia only). */
  async mintTestUSDC(amount: bigint): Promise<TransactionResult> {
    if (!this.wallet) throw new Error("Wallet not connected");
    try {
      const address = this.wallet.address.toString();
      const usdcAddress = getContractAddress("USDC", this.network);
      const call: Call = {
        contractAddress: usdcAddress,
        entrypoint: "mint",
        calldata: [address, amount.toString(), "0"],
      };
      const { txHash } = await this.exec([call]);
      return { txHash, success: true };
    } catch (err) {
      return { txHash: "", success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Approve + Deposit in a single gasless multicall. Skips the approve if allowance is already sufficient. */
  async approveAndDeposit(
    tokenAddress: string,
    amount: bigint,
  ): Promise<TransactionResult> {
    if (!this.wallet) throw new Error("Wallet not connected");
    try {
      const address = this.wallet.address.toString();
      const exchangeAddress = getContractAddress("CLOBRouter", this.network);
      const approveCalls = await this.buildApproveIfNeeded(tokenAddress, address, exchangeAddress, amount);
      const depositCall: Call = {
        contractAddress: exchangeAddress,
        entrypoint: "deposit",
        calldata: [tokenAddress, amount.toString(), "0"],
      };
      const { txHash } = await this.exec([...approveCalls, depositCall]);
      return { txHash, success: true };
    } catch (err) {
      return { txHash: "", success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Deposit collateral into the exchange. */
  async deposit(tokenAddress: string, amount: bigint): Promise<TransactionResult> {
    try {
      const exchangeAddress = getContractAddress("CLOBRouter", this.network);
      const call: Call = {
        contractAddress: exchangeAddress,
        entrypoint: "deposit",
        calldata: [tokenAddress, amount.toString(), "0"],
      };
      const { txHash } = await this.exec([call]);
      return { txHash, success: true };
    } catch (err) {
      return { txHash: "", success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Withdraw collateral from the exchange. */
  async withdraw(tokenAddress: string, amount: bigint): Promise<TransactionResult> {
    try {
      const exchangeAddress = getContractAddress("CLOBRouter", this.network);
      const call: Call = {
        contractAddress: exchangeAddress,
        entrypoint: "withdraw",
        calldata: [tokenAddress, amount.toString(), "0"],
      };
      const { txHash } = await this.exec([call]);
      return { txHash, success: true };
    } catch (err) {
      return { txHash: "", success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Split position: deposit collateral and receive outcome tokens. */
  async splitPosition(
    collateralToken: string,
    conditionId: string,
    amount: bigint,
  ): Promise<TransactionResult> {
    try {
      const ctAddress = getContractAddress("ConditionalTokens", this.network);
      const call: Call = {
        contractAddress: ctAddress,
        entrypoint: "split_position",
        calldata: [collateralToken, conditionId, amount.toString(), "0"],
      };
      const { txHash } = await this.exec([call]);
      return { txHash, success: true };
    } catch (err) {
      return { txHash: "", success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Set approval for all ERC-1155 outcome tokens. */
  async setApprovalForAll(operator: string, approved: boolean): Promise<TransactionResult> {
    try {
      const ctAddress = getContractAddress("ConditionalTokens", this.network);
      const call: Call = {
        contractAddress: ctAddress,
        entrypoint: "set_approval_for_all",
        calldata: [operator, approved ? "1" : "0"],
      };
      const { txHash } = await this.exec([call]);
      return { txHash, success: true };
    } catch (err) {
      return { txHash: "", success: false, error: err instanceof Error ? err.message : String(err) };
    }
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
      const categoryHash = hash.getSelectorFromName(params.category);
      const outcomeFelts = params.outcomes.map((o) => hash.getSelectorFromName(o));

      const account = this.wallet.getAccount();
      const factory = new Contract({ abi: MarketFactoryABI as any, address: factoryAddress, providerOrAccount: account });
      const marketTypeU8 = params.marketType === "private" ? 1 : 0;
      const createCall = factory.populate("create_market", [
        params.question, outcomeFelts, categoryHash,
        params.collateralToken, params.resolutionTime, resolverAddress, marketTypeU8,
      ]);

      const { txHash } = await this.exec([createCall]);

      const provider = this.wallet.getProvider();
      const receipt = await provider.waitForTransaction(txHash);
      const { marketId, conditionId } = extractMarketCreatedEvent(
        receipt,
        factoryAddress,
      );
      return { txHash, success: true, marketId, conditionId };
    } catch (err) {
      return { txHash: "", success: false, error: err instanceof Error ? err.message : String(err) };
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
      const categoryHash = hash.getSelectorFromName(params.category);
      const outcomeFelts = params.outcomes.map((o) => hash.getSelectorFromName(o));

      const address = this.wallet.address.toString();
      const account = this.wallet.getAccount();
      const factory = new Contract({ abi: MarketFactoryABI as any, address: factoryAddress, providerOrAccount: account });

      // Only emit approve if the factory's current allowance is below the bond amount.
      // On re-use (same address, same factory), this skips the approve entirely.
      const approveCalls = await this.buildApproveIfNeeded(bondTokenAddress, address, factoryAddress, bondAmount);
      const marketTypeU8 = params.marketType === "private" ? 1 : 0;
      const createCall = factory.populate("create_market", [
        params.question, outcomeFelts, categoryHash,
        params.collateralToken, params.resolutionTime, resolverAddress, marketTypeU8,
      ]);

      const { txHash } = await this.exec([...approveCalls, createCall]);

      const provider = this.wallet.getProvider();
      const receipt = await provider.waitForTransaction(txHash);
      const { marketId, conditionId } = extractMarketCreatedEvent(
        receipt,
        factoryAddress,
      );
      return { txHash, success: true, marketId, conditionId };
    } catch (err) {
      return { txHash: "", success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async proposeOutcome(marketId: string, outcomeIndex: number): Promise<TransactionResult> {
    try {
      const resolverAddress = getContractAddress("Resolver", this.network);
      const call: Call = {
        contractAddress: resolverAddress,
        entrypoint: "propose_outcome",
        calldata: [marketId, outcomeIndex.toString()],
      };
      const { txHash } = await this.exec([call], "user_pays");
      return { txHash, success: true };
    } catch (err) {
      return { txHash: "", success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async finalizeResolution(marketId: string): Promise<TransactionResult> {
    try {
      const resolverAddress = getContractAddress("Resolver", this.network);
      const call: Call = {
        contractAddress: resolverAddress,
        entrypoint: "finalize_resolution",
        calldata: [marketId],
      };
      const { txHash } = await this.exec([call], "user_pays");
      return { txHash, success: true };
    } catch (err) {
      return { txHash: "", success: false, error: err instanceof Error ? err.message : String(err) };
    }
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
      const raw = err instanceof Error ? err.message : String(err);
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
    const chainId = this.network === "mainnet" ? "0x534e5f4d41494e" : "0x534e5f5345504f4c4941";
    const orderHash = computeOrderHash(order, exchangeAddress, chainId);
    const sig = signOrderHash(orderHash, this.privateKey);
    return formatSignature(sig);
  }

  async signOrderAsync(order: OrderHashParams): Promise<string> {
    if (this.privateKey) return this.signOrder(order);
    if (!this.wallet) throw new Error("No wallet connected for order signing");

    const chainId = this.network === "mainnet" ? "0x534e5f4d41494e" : "0x534e5f5345504f4c4941";
    const td = buildOrderTypedData(order, chainId);
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
    const chainId = this.network === "mainnet" ? "0x534e5f4d41494e" : "0x534e5f5345504f4c4941";
    return computeOrderHash(order, exchangeAddress, chainId);
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
