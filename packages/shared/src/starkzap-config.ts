import type { PaymasterTimeBounds } from "starknet";
import type { ExplorerConfig } from "starkzap";
import { getContractAddress } from "./contracts";
import type { SupportedNetwork } from "./constants";

export interface CartridgeSessionPolicy {
  target: string;
  method: string;
}

export interface CartridgeConnectOptions {
  explorer?: ExplorerConfig;
  timeBounds?: PaymasterTimeBounds;
  url?: string;
  policies?: CartridgeSessionPolicy[];
  preset?: string;
}

export function getMarketZapCartridgePolicies(
  network: SupportedNetwork,
): CartridgeSessionPolicy[] {
  const usdcAddress = getContractAddress("USDC", network);
  const exchangeAddress = getContractAddress("CLOBRouter", network);
  const conditionalTokensAddress = getContractAddress("ConditionalTokens", network);
  const marketFactoryAddress = getContractAddress("MarketFactory", network);
  const resolverAddress = getContractAddress("Resolver", network);

  return [
    { target: usdcAddress, method: "mint" },
    { target: usdcAddress, method: "approve" },
    { target: exchangeAddress, method: "deposit" },
    { target: exchangeAddress, method: "withdraw" },
    { target: conditionalTokensAddress, method: "split_position" },
    { target: conditionalTokensAddress, method: "set_approval_for_all" },
    { target: conditionalTokensAddress, method: "redeem_position" },
    { target: marketFactoryAddress, method: "create_market" },
    { target: resolverAddress, method: "propose_outcome" },
    { target: resolverAddress, method: "finalize_resolution" },
  ];
}

export function getMarketZapCartridgeConnectOptions(
  network: SupportedNetwork,
  overrides?: CartridgeConnectOptions,
): CartridgeConnectOptions {
  return {
    policies: overrides?.policies ?? getMarketZapCartridgePolicies(network),
    ...(overrides?.preset ? { preset: overrides.preset } : {}),
    ...(overrides?.url ? { url: overrides.url } : {}),
    ...(overrides?.explorer ? { explorer: overrides.explorer } : {}),
    ...(overrides?.timeBounds ? { timeBounds: overrides.timeBounds } : {}),
  };
}
