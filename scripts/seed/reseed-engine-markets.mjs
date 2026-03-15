/** Re-seed on-chain markets, wipe the engine, and seed the fresh markets back in. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../services/engine/.env") });
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { RpcProvider, Account, Contract } from "starknet";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadPrivateKey, loadAdminAddress } from "../lib/keystore.mjs";

const RPC_URL = "https://api.zan.top/public/starknet-sepolia/rpc/v0_8";
const ENGINE_URL = "http://localhost:3001";
const SHORT_DELAY_MS = 3_000;
const MARKET_CREATION_DELAY_MS = 25_000;
const ENGINE_SEED_DELAY_MS = 20_000;
const FACTORY_LOOKBACK_LIMIT = 20;
const QUESTION_SUFFIX = `-v${Date.now()}`;

const PRIVATE_KEY = loadPrivateKey();
const ADMIN_ADDRESS = loadAdminAddress();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const addresses = JSON.parse(
  readFileSync("packages/shared/src/addresses/sepolia.json", "utf-8"),
);
const BOND_TOKEN = addresses.USDC;
const COLLATERAL_TOKEN = addresses.USDC;
const MARKET_FACTORY = addresses.MarketFactory;
const RESOLVER = addresses.AdminResolver;

const provider = new RpcProvider({ nodeUrl: RPC_URL });
const account = new Account({ provider, address: ADMIN_ADDRESS, signer: PRIVATE_KEY });

const factoryAbi = JSON.parse(
  readFileSync("packages/shared/src/abis/MarketFactory.json", "utf-8"),
);
const factory = new Contract({ abi: factoryAbi, address: MARKET_FACTORY, providerOrAccount: account });
const factoryReader = new Contract({ abi: factoryAbi, address: MARKET_FACTORY, providerOrAccount: provider });
const erc20Abi = JSON.parse(
  readFileSync("packages/shared/src/abis/MockERC20.json", "utf-8"),
);
const bondToken = new Contract({ abi: erc20Abi, address: BOND_TOKEN, providerOrAccount: account });

const seedMarkets = [
  {
    engineId: "eth-5k-mar2026",
    question: `Will ETH exceed $5,000 before end of March 2026${QUESTION_SUFFIX}?`,
    outcomeLabels: ["Yes", "No"],
    category: "crypto",
    resolutionHours: 72,
  },
  {
    engineId: "btc-150k-q1",
    question: `Will BTC surpass $150K in Q1 2026${QUESTION_SUFFIX}?`,
    outcomeLabels: ["Yes", "No"],
    category: "crypto",
    resolutionHours: 120,
  },
  {
    engineId: "fed-rate-cut",
    question: `Will the Fed announce a rate cut in March 2026${QUESTION_SUFFIX}?`,
    outcomeLabels: ["Yes", "No"],
    category: "economics",
    resolutionHours: 168,
  },
];

function strToFelt(s) {
  let hex = "0x";
  for (let i = 0; i < s.length; i++) {
    hex += s.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return hex;
}

async function mintBondTokenForBonds() {
  console.log("Step 1: Minting OLD USDC for bond payments...");
  const balance = await bondToken.call("balance_of", [ADMIN_ADDRESS]);
  const balanceAmount = BigInt(balance);
  console.log(`  Current OLD USDC balance: ${balanceAmount.toString()}`);

  const needed = 60n * 10n ** 18n;
  if (balanceAmount >= needed) {
    console.log(`  Already have enough OLD USDC, skipping mint.`);
    return;
  }

  const mintAmount = needed - balanceAmount + 10n * 10n ** 18n;
  console.log(`  Minting ${mintAmount.toString()} OLD USDC...`);

  const tx = await account.execute([
    bondToken.populate("mint", [
      ADMIN_ADDRESS,
      { low: mintAmount.toString(), high: "0" },
    ]),
  ]);
  await provider.waitForTransaction(tx.transaction_hash);
  console.log(`  Minted! tx: ${tx.transaction_hash}\n`);
}

async function approveBondTokenForFactory() {
  console.log("Step 2: Approving OLD USDC for factory bond...");
  const approveAmount = 100n * 10n ** 18n;
  const tx = await account.execute([
    bondToken.populate("approve", [
      MARKET_FACTORY,
      { low: approveAmount.toString(), high: "0" },
    ]),
  ]);
  await provider.waitForTransaction(tx.transaction_hash);
  console.log(`  Approved! tx: ${tx.transaction_hash}\n`);
}

async function createOnChainMarket(market) {
  console.log(`  Creating on-chain: "${market.question}"`);

  const resTime = Math.floor(Date.now() / 1000) + market.resolutionHours * 3600;
  const outcomesFelts = market.outcomeLabels.map(strToFelt);
  const categoryFelt = strToFelt(market.category);

  const createTx = await account.execute([
    factory.populate("create_market", [
      market.question,
      outcomesFelts,
      categoryFelt,
      COLLATERAL_TOKEN,
      resTime,
      RESOLVER,
      0, // market_type: 0 = binary
    ]),
  ]);
  console.log(`    Tx: ${createTx.transaction_hash}`);
  const receipt = await provider.waitForTransaction(createTx.transaction_hash);

  if (receipt.execution_status === "REVERTED") {
    const reason = receipt.revert_reason ?? "unknown";
    console.error(`    REVERTED: ${reason}`);
    return null;
  }

  let onChainMarketId = null;
  let conditionId = null;

  for (const event of receipt.events ?? []) {
    if (event.keys.length < 3 || !event.data?.length) {
      continue;
    }

    const possibleId = Number.parseInt(event.keys[1], 16);
    if (!Number.isFinite(possibleId) || possibleId <= 0 || possibleId >= 10_000) {
      continue;
    }

    onChainMarketId = possibleId.toString();
    conditionId = event.data[0];
    break;
  }

  if (!onChainMarketId || !conditionId) {
    console.error(`    Could not extract market_id or condition_id from events!`);
    console.log(`    Attempting to read from factory...`);

    for (let marketId = FACTORY_LOOKBACK_LIMIT; marketId >= 1; marketId -= 1) {
      try {
        const latestMarket = await factoryReader.call("get_market", [marketId]);
        const collateralToken = `0x${BigInt(latestMarket.collateral_token).toString(16)}`;
        if (collateralToken !== COLLATERAL_TOKEN) {
          continue;
        }

        onChainMarketId = Number(latestMarket.market_id).toString();
        conditionId = `0x${BigInt(latestMarket.condition_id).toString(16)}`;
        console.log(
          `    Found: market_id=${onChainMarketId}, condition_id=${conditionId}`,
        );
        break;
      } catch {}
    }
  }

  console.log(
    `    Market ID: ${onChainMarketId ?? null}, Condition ID: ${conditionId ?? null}`,
  );

  return {
    onChainMarketId,
    conditionId,
    resolutionTime: resTime,
    outcomeCount: market.outcomeLabels.length,
    collateralToken: COLLATERAL_TOKEN,
  };
}

function findContainer(nameHint, portFallback) {
  // Try exact name first
  try {
    const out = execSync(`docker ps --format '{{.Names}}' --filter name=${nameHint}`, { encoding: "utf-8" }).trim();
    if (out) return out.split("\n")[0];
  } catch {}
  // Fallback: find by published port
  if (portFallback) {
    try {
      const out = execSync(`docker ps --filter publish=${portFallback} --format '{{.Names}}'`, { encoding: "utf-8" }).trim();
      if (out) return out.split("\n")[0];
    } catch {}
  }
  return nameHint; // last resort — use the hint as-is
}

const PG_CONTAINER = findContainer("market-zap-postgres", 5432);
const REDIS_CONTAINER = findContainer("market-zap-redis", 6379);

console.log(`Using Postgres container: ${PG_CONTAINER}`);
console.log(`Using Redis container: ${REDIS_CONTAINER}\n`);

const ENGINE_CLEANUP_STEPS = [
  {
    command:
      `docker exec ${PG_CONTAINER} psql -U postgres -d market_zap -c "TRUNCATE trades CASCADE;"`,
    successMessage: "Truncated trades table",
    warningMessage: "trades table issue, skipping...",
  },
  {
    command:
      `docker exec ${PG_CONTAINER} psql -U postgres -d market_zap -c "DELETE FROM markets;"`,
    successMessage: "Deleted all markets",
    warningMessage: "markets table issue, skipping...",
  },
  {
    command: `docker exec ${REDIS_CONTAINER} redis-cli FLUSHALL`,
    successMessage: "Flushed Redis completely",
    warningMessage: "Redis flush issue, skipping...",
  },
  {
    command:
      `docker exec ${PG_CONTAINER} psql -U postgres -d market_zap -c "REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_mv;"`,
    successMessage: "Refreshed leaderboard materialized view",
    warningMessage: "Leaderboard view refresh skipped",
  },
];

async function wipeEngineData() {
  console.log("\nStep 4: Wiping Engine Data...");

  for (const step of ENGINE_CLEANUP_STEPS) {
    try {
      execSync(step.command, { stdio: "pipe" });
      console.log(`  ${step.successMessage}`);
    } catch {
      console.warn(`  ${step.warningMessage}`);
    }
  }

  console.log("  Done!\n");
}

async function seedMarketToEngine(engineMarket, onChainData) {
  const body = {
    marketId: engineMarket.engineId,
    onChainMarketId: onChainData.onChainMarketId,
    conditionId: onChainData.conditionId,
    title: engineMarket.question,
    description: "",
    category: engineMarket.category,
    outcomeCount: onChainData.outcomeCount,
    outcomeLabels: engineMarket.outcomeLabels,
    collateralToken: onChainData.collateralToken,
    resolutionTime: new Date(onChainData.resolutionTime * 1000).toISOString(),
  };

  console.log(`  Seeding "${engineMarket.engineId}"...`);
  console.log(`    onChainMarketId: ${onChainData.onChainMarketId}`);
  console.log(`    conditionId: ${onChainData.conditionId}`);
  console.log(`    collateral: ${onChainData.collateralToken}`);

  const resp = await fetch(`${ENGINE_URL}/api/admin/seed-market`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const result = await resp.json();
  if (!resp.ok) {
    console.error(`    FAILED:`, JSON.stringify(result).slice(0, 500));
    return false;
  }

  console.log(`    Seeded successfully! AMM pool initialized.`);
  return true;
}

async function main() {
  console.log("=== MarketZap Full Re-Seed ===\n");

  await mintBondTokenForBonds();
  await sleep(SHORT_DELAY_MS);

  await approveBondTokenForFactory();
  await sleep(SHORT_DELAY_MS);

  console.log("Step 3: Creating on-chain markets with NEW USDC collateral...\n");
  const onChainData = [];
  for (const market of seedMarkets) {
    const data = await createOnChainMarket(market);
    if (!data) {
      console.error(`  Failed to create ${market.engineId}!`);
      process.exit(1);
    }
    onChainData.push({ engine: market, onChain: data });
    await sleep(MARKET_CREATION_DELAY_MS);
  }

  await wipeEngineData();

  try {
    const health = await fetch(`${ENGINE_URL}/api/health`);
    const h = await health.json();
    console.log(`Engine health: ${h.status}\n`);
  } catch {
    console.error("Engine not running on port 3001!");
    process.exit(1);
  }

  console.log("Step 5: Seeding markets into engine...\n");
  for (const { engine, onChain } of onChainData) {
    const success = await seedMarketToEngine(engine, onChain);
    if (!success) {
      console.error(`  Failed to seed ${engine.engineId}, continuing...`);
    }
    await sleep(ENGINE_SEED_DELAY_MS);
  }

  console.log("\n=== Verification ===\n");
  try {
    const resp = await fetch(`${ENGINE_URL}/api/markets`);
    const data = await resp.json();
    const items = data.data?.items || [];
    console.log(`Markets in engine: ${items.length}`);
    for (const m of items) {
      console.log(`  ${m.marketId || m.id}: "${m.title}" — conditionId=${m.conditionId || "MISSING!"}`);
      if (m.outcomes) {
        for (const o of m.outcomes) {
          console.log(`    ${o.label}: price=${o.price}`);
        }
      }
    }
  } catch (err) {
    console.error("Verification failed:", err.message);
  }

  console.log("\nDB verification:");
  try {
    const dbOutput = execSync(
      `docker exec ${PG_CONTAINER} psql -U postgres -d market_zap -c "SELECT market_id, on_chain_market_id, condition_id, collateral_token, status FROM markets;"`,
      { encoding: "utf-8" }
    );
    console.log(dbOutput);
  } catch {}

  console.log("Redis AMM state:");
  try {
    const keys = execSync(`docker exec ${REDIS_CONTAINER} redis-cli KEYS "amm:*"`, { encoding: "utf-8" });
    console.log(keys);
    for (const key of keys.trim().split("\n").filter(Boolean)) {
      const val = execSync(`docker exec ${REDIS_CONTAINER} redis-cli GET "${key}"`, { encoding: "utf-8" });
      console.log(`  ${key}: ${val.trim()}`);
    }
  } catch {}

  console.log("\n=== Done! ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
