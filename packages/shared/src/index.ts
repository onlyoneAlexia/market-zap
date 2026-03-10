// ---------------------------------------------------------------------------
// @market-zap/shared — barrel export
// ---------------------------------------------------------------------------

// Types (re-export everything from the types barrel)
export * from "./types/index";

// Utility functions
export {
  toFixedPoint,
  fromFixedPoint,
  formatPrice,
  formatUsd,
  shortenAddress,
  calculatePnl,
  generateNonce,
} from "./utils";

export type { PnlResult } from "./utils";

// Contract ABIs, addresses, and collateral token registry
export {
  CONTRACT_ADDRESSES,
  getContractAddress,
  COLLATERAL_TOKEN_ADDRESSES,
  COLLATERAL_TOKENS,
  getTokenByAddress,
  MarketFactoryABI,
  ConditionalTokensABI,
  CLOBRouterABI,
  ResolverABI,
  ERC20ABI,
  CollateralVaultABI,
} from "./contracts";

export type { ContractName } from "./contracts";

// REST API client
export {
  MarketZapAPI,
  MarketZapApiError,
} from "./api-client";

export type {
  ApiResponse,
  PaginatedResponse,
  LeaderboardEntry,
  MarketPriceResponse,
  OpenOrderEntry,
  SubmitOrderResponse,
  BalanceResponse,
  GetMarketsParams,
  GetTradesParams,
  GetLeaderboardParams,
  QuoteResponse,
  GetQuoteParams,
  OrderBookLevel,
  OrderBookResponse,
  GetOrderBookParams,
  TxTraceEvent,
  TxTraceResponse,
  DarkAuthProvider,
  AuthPolicy,
} from "./api-client";

// StarkZap SDK wrapper (MarketZapWallet + backward-compat StarkZapClient alias)
export { MarketZapWallet, StarkZapClient, cleanupCartridgeControllerDom } from "./starkzap";
export {
  getMarketZapCartridgeConnectOptions,
  getMarketZapCartridgePolicies,
} from "./starkzap-config";
export type {
  WalletState,
  WalletConnectionKind,
  ConnectOptions,
  TransactionResult,
  CreateMarketResult,
  FeeMode,
} from "./starkzap";
export type {
  CartridgeConnectOptions,
  CartridgeSessionPolicy,
} from "./starkzap-config";

// Order hash computation & signing
export {
  computeOrderHash,
  buildOrderTypedData,
  signOrderHash,
  formatSignature,
  computeTokenId,
  computeConditionId,
  computeQuestionHash,
  computeTradeCommitment,
  scalePrice,
} from "./order-hash";
export type { OrderHashParams } from "./order-hash";

// Constants
export {
  TAKER_FEE_BPS,
  MAKER_FEE_BPS,
  CREATION_BOND_AMOUNT,
  VOLUME_REFUND_THRESHOLD,
  DISPUTE_PERIOD,
  VOID_TIMEOUT,
  MAX_OUTCOMES,
  PRICE_DECIMALS,
  COLLATERAL_DECIMALS,
  CATEGORY_LABELS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./constants";

export type { SupportedNetwork, CollateralTokenInfo } from "./constants";
