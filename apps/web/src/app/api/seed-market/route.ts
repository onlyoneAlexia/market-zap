import { NextRequest, NextResponse } from "next/server";
import type { TransactionExecutionStatus, TransactionFinalityStatus } from "starknet";
import { RpcProvider, hash, Contract } from "starknet";
import {
  CONTRACT_ADDRESSES,
  MarketFactoryABI,
  ConditionalTokensABI,
} from "@market-zap/shared";

const STARKNET_RPC_URLS: string[] = (() => {
  const env = process.env.STARKNET_RPC_URL;
  const defaults = [
    "https://starknet-sepolia.g.alchemy.com/starknet/version/rpc/v0_8/demo",
    "https://starknet-sepolia.drpc.org",
    "https://rpc.starknet-testnet.lava.build",
    "https://api.zan.top/public/starknet-sepolia/rpc/v0_8",
  ];
  if (env) return [env, ...defaults.filter((u) => u !== env)];
  return defaults;
})();

const FACTORY_ADDRESS = CONTRACT_ADDRESSES.sepolia.MarketFactory;
const CT_ADDRESS = CONTRACT_ADDRESSES.sepolia.ConditionalTokens;
const TRUSTED_RESOLVER = CONTRACT_ADDRESSES.sepolia.Resolver;
const MARKET_CREATED_SELECTOR = hash.getSelectorFromName("MarketCreated");
const CONDITION_PREPARED_SELECTOR = hash.getSelectorFromName("ConditionPrepared");

/**
 * Normalize a Starknet address/felt to 0x-prefixed, 66-char lowercase hex.
 * Handles both padded ("0x06b7...") and unpadded ("0x6b7...") inputs,
 * as well as raw BigInt / numeric values from contract calls.
 */
function normHex(value: string | bigint): string {
  const n = BigInt(value);
  return "0x" + n.toString(16).padStart(64, "0");
}

const FACTORY_HEX = normHex(FACTORY_ADDRESS);
const CT_HEX = normHex(CT_ADDRESS);
const TRUSTED_RESOLVER_HEX = normHex(TRUSTED_RESOLVER);
const MARKET_CREATED_SELECTOR_HEX = normHex(MARKET_CREATED_SELECTOR);
const CONDITION_PREPARED_SELECTOR_HEX = normHex(CONDITION_PREPARED_SELECTOR);
type StarknetEvent = {
  from_address?: string;
  keys?: string[];
  data?: string[];
};

type SeedMarketReceipt = {
  execution_status?: string;
  revert_reason?: string;
  events?: StarknetEvent[];
};

type FactoryMarketView = {
  condition_id: string | bigint;
  collateral_token: string | bigint;
  outcome_count: string | number | bigint;
  resolution_time: string | number | bigint;
};

type ConditionView = {
  oracle?: string | bigint;
};

const RECEIPT_SUCCESS_STATES: Array<
  TransactionFinalityStatus | TransactionExecutionStatus
> = ["ACCEPTED_ON_L2", "ACCEPTED_ON_L1"];

console.log("[seed-market] resolved addresses:", {
  factory: FACTORY_HEX,
  conditionalTokens: CT_HEX,
  trustedResolver: TRUSTED_RESOLVER_HEX,
});

/** Verify a create-market transaction on-chain before proxying it to the engine. */
export async function POST(req: NextRequest) {
  const ENGINE_INTERNAL = process.env.ENGINE_INTERNAL_URL || "http://localhost:3001";
  const ENGINE_URL = `${ENGINE_INTERNAL}/api`;
  const API_KEY = process.env.ENGINE_API_KEY;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const createTxHash = body.createTxHash;
  if (!createTxHash || typeof createTxHash !== "string") {
    return NextResponse.json(
      { error: "Missing required field: createTxHash" },
      { status: 400 },
    );
  }

  let onChainMarketId: string | null = null;

  try {
    let provider: RpcProvider | null = null;
    let receipt: SeedMarketReceipt | null = null;
    let lastRpcError: string | null = null;
    let usedRpcUrl: string | null = null;

    for (const rpcUrl of STARKNET_RPC_URLS) {
      try {
        provider = new RpcProvider({ nodeUrl: rpcUrl });
        receipt = await provider.waitForTransaction(createTxHash, {
          retryInterval: 3000,
          successStates: RECEIPT_SUCCESS_STATES,
        }) as SeedMarketReceipt;
        usedRpcUrl = rpcUrl;
        console.log(`[seed-market] Receipt fetched via ${new URL(rpcUrl).hostname}`);
        break;
      } catch (e) {
        lastRpcError = e instanceof Error ? e.message : String(e);
        console.warn(`[seed-market] RPC ${new URL(rpcUrl).hostname} failed: ${lastRpcError}`);
        provider = null;
        receipt = null;
      }
    }

    if (!provider || !receipt) {
      return NextResponse.json(
        { error: `All RPC endpoints failed waiting for tx. Last error: ${lastRpcError}` },
        { status: 502 },
      );
    }

    const execStatus = receipt.execution_status;
    if (execStatus === "REVERTED") {
      const reason = receipt.revert_reason ?? "unknown reason";
      return NextResponse.json(
        { error: `Market creation tx was reverted on-chain: ${reason}` },
        { status: 400 },
      );
    }

    const events = receipt.events ?? [];

    console.log(`[seed-market] Tx ${createTxHash} has ${events.length} events, exec=${execStatus}`);

    for (const event of events) {
      const eventKeys = event.keys ?? [];
      const fromOurFactory =
        normHex(event.from_address ?? "0x0") === FACTORY_HEX;
      const isMarketCreated =
        eventKeys.length >= 2 &&
        normHex(eventKeys[0]) === MARKET_CREATED_SELECTOR_HEX;

      if (fromOurFactory && isMarketCreated) {
        onChainMarketId = BigInt(eventKeys[1]).toString();
        break;
      }
    }

    if (onChainMarketId === null) {
      const eventSummary = events.map((e, i) => ({
        idx: i,
        from: e.from_address,
        selector: e.keys?.[0],
        keysLen: e.keys?.length,
        dataLen: e.data?.length,
      }));
      console.error("[seed-market] No MarketCreated event found. Events:", JSON.stringify(eventSummary));
      return NextResponse.json(
        {
          error: "No MarketCreated event found in transaction from our factory",
          eventCount: events.length,
        },
        { status: 403 },
      );
    }

    const factory = new Contract({
      abi: MarketFactoryABI as Contract["abi"],
      address: FACTORY_ADDRESS,
      providerOrAccount: provider,
    });
    const market = await factory.call("get_market", [onChainMarketId]) as FactoryMarketView;

    const verifiedConditionId = normHex(market.condition_id);
    const verifiedCollateralToken = normHex(market.collateral_token);
    const verifiedOutcomeCount = Number(market.outcome_count);
    const verifiedMarketId = onChainMarketId;
    const verifiedResolutionTime = Number(market.resolution_time);

    let oracleHex: string | null = null;
    let oracleSource = "none";
    for (const event of events) {
      const eventKeys = event.keys ?? [];
      const fromCT = normHex(event.from_address ?? "0x0") === CT_HEX;
      const isConditionPrepared =
        eventKeys.length >= 2 &&
        normHex(eventKeys[0]) === CONDITION_PREPARED_SELECTOR_HEX;

      if (fromCT && isConditionPrepared) {
        if (event.data?.[0]) {
          oracleHex = normHex(event.data[0]);
          oracleSource = "event";
        }
        break;
      }
    }

    if (!oracleHex) {
      try {
        const ct = new Contract({
          abi: ConditionalTokensABI as Contract["abi"],
          address: CT_ADDRESS,
          providerOrAccount: provider,
        });
        const condition = await ct.call("get_condition", [verifiedConditionId]) as ConditionView;
        const rawOracle = condition.oracle;
        if (rawOracle !== undefined) {
          oracleHex = normHex(rawOracle);
          oracleSource = "get_condition";
        }
      } catch (e) {
        console.error("[seed-market] get_condition fallback failed:", e instanceof Error ? e.message : e);
      }
    }

    if (!oracleHex) {
      const ctEvents = events.filter((e) => {
        try { return normHex(e.from_address ?? "0x0") === CT_HEX; } catch { return false; }
      });
      console.error("[seed-market] Oracle not found. CT events:", JSON.stringify(ctEvents));
      return NextResponse.json(
        {
          error: "Could not determine the oracle for this market — ConditionPrepared event not found in tx",
          conditionId: verifiedConditionId,
          totalEvents: events.length,
          ctEvents: ctEvents.length,
        },
        { status: 403 },
      );
    }

    if (oracleHex !== TRUSTED_RESOLVER_HEX) {
      console.error("[seed-market] Oracle mismatch!", {
        found: oracleHex,
        expected: TRUSTED_RESOLVER_HEX,
        source: oracleSource,
        marketId: onChainMarketId,
        conditionId: verifiedConditionId,
        txHash: createTxHash,
      });

      let retryOracle: string | null = null;
      for (const rpcUrl of STARKNET_RPC_URLS) {
        if (rpcUrl === usedRpcUrl) continue;
        try {
          const retryProvider = new RpcProvider({ nodeUrl: rpcUrl });
          const retryReceipt = await retryProvider.getTransactionReceipt(createTxHash) as SeedMarketReceipt;
          const retryEvents = retryReceipt.events ?? [];
          for (const event of retryEvents) {
            const eventKeys = event.keys ?? [];
            const fromCT = normHex(event.from_address ?? "0x0") === CT_HEX;
            const isCP =
              eventKeys.length >= 2 &&
              normHex(eventKeys[0]) === CONDITION_PREPARED_SELECTOR_HEX;
            if (fromCT && isCP && event.data?.[0]) {
              retryOracle = normHex(event.data[0]);
              break;
            }
          }
          if (retryOracle) {
            console.log(`[seed-market] Retry via ${new URL(rpcUrl).hostname} found oracle: ${retryOracle}`);
            break;
          }
        } catch {}
      }

      if (retryOracle && retryOracle === TRUSTED_RESOLVER_HEX) {
        console.log("[seed-market] Retry succeeded — first RPC returned stale data. Proceeding.");
        oracleHex = retryOracle;
      } else {
        return NextResponse.json(
          {
            error: "Market uses an untrusted oracle — seeding is restricted to AdminResolver markets",
            diagnostic: {
              foundOracle: oracleHex,
              expectedOracle: TRUSTED_RESOLVER_HEX,
              retryOracle,
              source: oracleSource,
              txHash: createTxHash,
              marketId: onChainMarketId,
            },
          },
          { status: 403 },
        );
      }
    }

    const { createTxHash: _stripped, ...clientBody } = body;
    const engineBody = {
      ...clientBody,
      marketId: verifiedMarketId,
      onChainMarketId: verifiedMarketId,
      conditionId: verifiedConditionId,
      collateralToken: verifiedCollateralToken,
      outcomeCount: verifiedOutcomeCount,
      ...(verifiedResolutionTime > 0
        ? { resolutionTime: new Date(verifiedResolutionTime * 1000).toISOString() }
        : {}),
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (API_KEY) {
      headers["Authorization"] = `Bearer ${API_KEY}`;
    }

    const resp = await fetch(`${ENGINE_URL}/admin/seed-market`, {
      method: "POST",
      headers,
      body: JSON.stringify(engineBody),
    });

    const data = await resp.json().catch(() => ({}));
    return NextResponse.json(data, { status: resp.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[seed-market] Verification failed:", message, err instanceof Error ? err.stack : "");
    return NextResponse.json(
      { error: `Could not verify market creation tx on-chain: ${message}` },
      { status: 400 },
    );
  }
}
