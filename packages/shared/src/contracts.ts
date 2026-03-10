import type { SupportedNetwork, CollateralTokenInfo } from "./constants";

// ---------------------------------------------------------------------------
// Per-network address JSON files — SINGLE SOURCE OF TRUTH
// Deploy scripts write to these files; nothing else should hardcode addresses.
// ---------------------------------------------------------------------------

import sepoliaAddrs from "./addresses/sepolia.json" with { type: "json" };
import mainnetAddrs from "./addresses/mainnet.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Contract Names (consumer-facing — aliases map to canonical JSON keys)
// ---------------------------------------------------------------------------

export type ContractName =
  | "MarketFactory"
  | "ConditionalTokens"
  | "CLOBRouter"
  | "CLOBExchange"
  | "Resolver"
  | "AdminResolver"
  | "USDC"
  | "CollateralVault";

function buildAddresses(addrs: typeof sepoliaAddrs): Record<ContractName, string> {
  return {
    MarketFactory: addrs.MarketFactory,
    ConditionalTokens: addrs.ConditionalTokens,
    CLOBRouter: addrs.CLOBExchange,
    CLOBExchange: addrs.CLOBExchange,
    Resolver: addrs.AdminResolver,
    AdminResolver: addrs.AdminResolver,
    USDC: addrs.USDC,
    CollateralVault: addrs.CollateralVault,
  };
}

// ---------------------------------------------------------------------------
// Deployed Addresses — derived from JSON, never hardcoded
// ---------------------------------------------------------------------------

export const CONTRACT_ADDRESSES: Record<
  SupportedNetwork,
  Record<ContractName, string>
> = {
  sepolia: buildAddresses(sepoliaAddrs),
  mainnet: buildAddresses(mainnetAddrs),
};

// ---------------------------------------------------------------------------
// Type-safe accessor
// ---------------------------------------------------------------------------

/**
 * Retrieve a deployed contract address for a given contract and network.
 *
 * @throws {Error} if the contract has not been deployed (zero address).
 *
 * @example
 * const addr = getContractAddress("MarketFactory", "sepolia");
 */
export function getContractAddress(
  contract: ContractName,
  network: SupportedNetwork,
): string {
  const address = CONTRACT_ADDRESSES[network][contract];

  if (address === "0x0000000000000000000000000000000000000000") {
    throw new Error(
      `Contract "${contract}" has not been deployed on "${network}" yet.`,
    );
  }

  return address;
}

// ---------------------------------------------------------------------------
// Collateral Token Registry (derives USDC from CONTRACT_ADDRESSES above)
// ---------------------------------------------------------------------------

/** @deprecated Use COLLATERAL_TOKENS instead. */
export const COLLATERAL_TOKEN_ADDRESSES: Record<SupportedNetwork, string> = {
  sepolia: CONTRACT_ADDRESSES.sepolia.USDC,
  mainnet: CONTRACT_ADDRESSES.mainnet.USDC,
} as const;

export const COLLATERAL_TOKENS: Record<string, CollateralTokenInfo> = {
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    bondAmount: "20000000",            // 20 USDC
    volumeThreshold: "100000000",      // 100 USDC
    addresses: {
      sepolia: CONTRACT_ADDRESSES.sepolia.USDC,
      mainnet: CONTRACT_ADDRESSES.mainnet.USDC,
    },
  },
  ETH: {
    symbol: "ETH",
    name: "Ethereum",
    decimals: 18,
    bondAmount: "10000000000000000",   // 0.01 ETH
    volumeThreshold: "50000000000000000", // 0.05 ETH
    addresses: {
      sepolia: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
      mainnet: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
    },
  },
  STRK: {
    symbol: "STRK",
    name: "Starknet Token",
    decimals: 18,
    bondAmount: "50000000000000000000", // 50 STRK
    volumeThreshold: "250000000000000000000", // 250 STRK
    addresses: {
      sepolia: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
      mainnet: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
    },
  },
};

/** Reverse lookup: token address → CollateralTokenInfo. */
export function getTokenByAddress(
  address: string,
  network: SupportedNetwork,
): CollateralTokenInfo | undefined {
  const normalized = address.toLowerCase();
  return Object.values(COLLATERAL_TOKENS).find(
    (t) => t.addresses[network].toLowerCase() === normalized,
  );
}

// ---------------------------------------------------------------------------
// Contract ABIs (generated from Scarb build output)
// ---------------------------------------------------------------------------

import MarketFactoryAbiJson from "./abis/MarketFactory.json" with { type: "json" };
import ConditionalTokensAbiJson from "./abis/ConditionalTokens.json" with { type: "json" };
import CLOBExchangeAbiJson from "./abis/CLOBExchange.json" with { type: "json" };
import AdminResolverAbiJson from "./abis/AdminResolver.json" with { type: "json" };
import MockERC20AbiJson from "./abis/MockERC20.json" with { type: "json" };
import CollateralVaultAbiJson from "./abis/CollateralVault.json" with { type: "json" };

export const MarketFactoryABI = MarketFactoryAbiJson;

export const ConditionalTokensABI = ConditionalTokensAbiJson;

export const CLOBRouterABI = CLOBExchangeAbiJson;

export const ResolverABI = AdminResolverAbiJson;

export const ERC20ABI = MockERC20AbiJson;

export const CollateralVaultABI = CollateralVaultAbiJson;
