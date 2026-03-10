/**
 * Re-seed markets: create fresh on-chain markets with correct collateral, wipe engine, re-seed.
 *
 * Steps:
 * 1. Mint OLD USDC for bond payments (factory requires OLD USDC as bond_token)
 * 2. Create 3 new on-chain markets with NEW USDC (6 decimals) as collateral
 * 3. Extract condition_id from MarketCreated events
 * 4. Wipe engine DB + Redis
 * 5. Re-seed markets into engine with correct condition_id
 * 6. Engine sets up on-chain liquidity (split_position + deposit) automatically
 */
import { RpcProvider, Account, Contract } from "starknet";
import fs from "fs";
import { loadPrivateKey, loadAdminAddress } from "../lib/keystore.mjs";

const RPC_URL = "https://api.zan.top/public/starknet-sepolia/rpc/v0_8";
const PRIVATE_KEY = loadPrivateKey();
const ADMIN_ADDRESS = loadAdminAddress();
const ENGINE_URL = "http://localhost:3001";

// Read addresses from single source of truth
const _addrs = JSON.parse(fs.readFileSync("packages/shared/src/addresses/sepolia.json", "utf-8"));
const OLD_USDC = _addrs.USDC;
const NEW_USDC = _addrs.USDC;
const MARKET_FACTORY = _addrs.MarketFactory;
const RESOLVER = _addrs.AdminResolver;

const provider = new RpcProvider({ nodeUrl: RPC_URL });
const account = new Account(provider, ADMIN_ADDRESS, PRIVATE_KEY);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const factoryAbi = JSON.parse(fs.readFileSync("packages/shared/src/abis/MarketFactory.json", "utf-8"));
const factory = new Contract(factoryAbi, MARKET_FACTORY, account);
const erc20Abi = JSON.parse(fs.readFileSync("packages/shared/src/abis/MockERC20.json", "utf-8"));

// Use unique questions to avoid "CT: condition already exists" errors.
// Append a timestamp-based suffix to ensure unique condition_ids.
const SUFFIX = `-v${Date.now()}`;
const markets = [
  {
    engineId: "eth-5k-mar2026",
    question: `Will ETH exceed $5,000 before end of March 2026${SUFFIX}?`,
    outcomeLabels: ["Yes", "No"],
    category: "crypto",
    resolutionHours: 72,
  },
  {
    engineId: "btc-150k-q1",
    question: `Will BTC surpass $150K in Q1 2026${SUFFIX}?`,
    outcomeLabels: ["Yes", "No"],
    category: "crypto",
    resolutionHours: 120,
  },
  {
    engineId: "fed-rate-cut",
    question: `Will the Fed announce a rate cut in March 2026${SUFFIX}?`,
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

async function mintOldUsdcForBonds() {
  console.log("Step 1: Minting OLD USDC for bond payments...");
  const oldUsdc = new Contract(erc20Abi, OLD_USDC, account);

  // Check current balance
  const bal = await oldUsdc.call("balance_of", [ADMIN_ADDRESS]);
  const balNum = BigInt(bal);
  console.log(`  Current OLD USDC balance: ${balNum.toString()}`);

  // Need 20 * 1e18 per market (OLD USDC has 18 decimals)
  // 3 markets * 20 = 60 OLD USDC
  const needed = 60n * 10n ** 18n;
  if (balNum >= needed) {
    console.log(`  Already have enough OLD USDC, skipping mint.`);
    return;
  }

  const mintAmount = needed - balNum + 10n * 10n ** 18n; // mint extra buffer
  console.log(`  Minting ${mintAmount.toString()} OLD USDC...`);

  const tx = await account.execute([
    oldUsdc.populate("mint", [ADMIN_ADDRESS, { low: mintAmount.toString(), high: "0" }]),
  ]);
  await provider.waitForTransaction(tx.transaction_hash);
  console.log(`  Minted! tx: ${tx.transaction_hash}\n`);
}

async function approveOldUsdcForFactory() {
  console.log("Step 2: Approving OLD USDC for factory bond...");
  const oldUsdc = new Contract(erc20Abi, OLD_USDC, account);

  const approveAmount = 100n * 10n ** 18n; // 100 OLD USDC (18 decimals)
  const tx = await account.execute([
    oldUsdc.populate("approve", [MARKET_FACTORY, { low: approveAmount.toString(), high: "0" }]),
  ]);
  await provider.waitForTransaction(tx.transaction_hash);
  console.log(`  Approved! tx: ${tx.transaction_hash}\n`);
}

async function createOnChainMarket(m) {
  console.log(`  Creating on-chain: "${m.question}"`);

  const resTime = Math.floor(Date.now() / 1000) + m.resolutionHours * 3600;
  const outcomesFelts = m.outcomeLabels.map(strToFelt);
  const categoryFelt = strToFelt(m.category);

  const createTx = await account.execute([
    factory.populate("create_market", [
      m.question,
      outcomesFelts,
      categoryFelt,
      NEW_USDC,   // Correct collateral: NEW USDC (6 decimals)
      resTime,
      RESOLVER,
    ]),
  ]);
  console.log(`    Tx: ${createTx.transaction_hash}`);
  const receipt = await provider.waitForTransaction(createTx.transaction_hash);

  if (receipt.execution_status === "REVERTED") {
    const reason = receipt.revert_reason ?? "unknown";
    console.error(`    REVERTED: ${reason}`);
    return null;
  }

  // Extract market_id and condition_id from MarketCreated event.
  // Event structure:
  //   keys[0] = event selector
  //   keys[1] = market_id (u64, indexed)
  //   keys[2] = creator (ContractAddress, indexed)
  //   data[0] = condition_id (felt252)
  //   data[1+] = question (ByteArray), category, resolution_time
  let onChainMarketId = null;
  let conditionId = null;

  if (receipt.events) {
    for (const evt of receipt.events) {
      // MarketCreated has at least 3 keys and data with condition_id
      if (evt.keys.length >= 3 && evt.data && evt.data.length > 0) {
        const possibleId = parseInt(evt.keys[1], 16);
        if (possibleId > 0 && possibleId < 10000) {
          onChainMarketId = possibleId.toString();
          conditionId = evt.data[0]; // condition_id is first data field
          break;
        }
      }
    }
  }

  if (!onChainMarketId || !conditionId) {
    console.error(`    Could not extract market_id or condition_id from events!`);
    // Fallback: read from factory contract
    console.log(`    Attempting to read from factory...`);
    const factoryRead = new Contract(factoryAbi, MARKET_FACTORY, provider);
    // Try to find the latest market
    for (let id = 20; id >= 1; id--) {
      try {
        const mkt = await factoryRead.call("get_market", [id]);
        const collat = "0x" + BigInt(mkt.collateral_token).toString(16);
        if (collat === NEW_USDC) {
          onChainMarketId = Number(mkt.market_id).toString();
          conditionId = "0x" + BigInt(mkt.condition_id).toString(16);
          console.log(`    Found: market_id=${onChainMarketId}, condition_id=${conditionId}`);
          break;
        }
      } catch { continue; }
    }
  }

  console.log(`    Market ID: ${onChainMarketId}, Condition ID: ${conditionId}`);

  return {
    onChainMarketId,
    conditionId,
    resolutionTime: resTime,
    outcomeCount: m.outcomeLabels.length,
    collateralToken: NEW_USDC,
  };
}

async function wipeEngineData() {
  console.log("\nStep 4: Wiping Engine Data...");
  const { execSync } = await import("child_process");

  try {
    execSync(`docker exec market-zap-postgres psql -U postgres -d market_zap -c "TRUNCATE trades CASCADE;"`, { stdio: "pipe" });
    console.log("  Truncated trades table");
  } catch { console.warn("  trades table issue, skipping..."); }

  try {
    execSync(`docker exec market-zap-postgres psql -U postgres -d market_zap -c "DELETE FROM markets;"`, { stdio: "pipe" });
    console.log("  Deleted all markets");
  } catch { console.warn("  markets table issue, skipping..."); }

  try {
    execSync(`docker exec market-zap-redis redis-cli FLUSHALL`, { stdio: "pipe" });
    console.log("  Flushed Redis completely");
  } catch { console.warn("  Redis flush issue, skipping..."); }

  try {
    execSync(`docker exec market-zap-postgres psql -U postgres -d market_zap -c "REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_mv;"`, { stdio: "pipe" });
    console.log("  Refreshed leaderboard materialized view");
  } catch { console.warn("  Leaderboard view refresh skipped"); }

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

  const seedTxHash = result.data?.seedTxHash;
  if (seedTxHash) {
    console.log(`    On-chain liquidity tx: ${seedTxHash}`);
  } else {
    console.warn(`    WARNING: No on-chain liquidity setup (seedTxHash is null)`);
    console.warn(`    This means settlement will fail until liquidity is set up.`);
  }
  console.log(`    Seeded successfully!`);
  return true;
}

async function main() {
  console.log("=== MarketZap Full Re-Seed ===\n");

  // Step 1: Mint OLD USDC for bond payments
  await mintOldUsdcForBonds();
  await sleep(3000);

  // Step 2: Approve OLD USDC for factory
  await approveOldUsdcForFactory();
  await sleep(3000);

  // Step 3: Create on-chain markets with NEW USDC collateral
  console.log("Step 3: Creating on-chain markets with NEW USDC collateral...\n");
  const onChainData = [];
  for (const m of markets) {
    const data = await createOnChainMarket(m);
    if (!data) {
      console.error(`  Failed to create ${m.engineId}!`);
      process.exit(1);
    }
    onChainData.push({ engine: m, onChain: data });
    await sleep(25000); // Wait between on-chain txs (avoid RPC rate limits)
  }

  // Step 4: Wipe engine data
  await wipeEngineData();

  // Step 5: Check engine health
  try {
    const health = await fetch(`${ENGINE_URL}/api/health`);
    const h = await health.json();
    console.log(`Engine health: ${h.status}\n`);
  } catch {
    console.error("Engine not running on port 3001!");
    process.exit(1);
  }

  // Step 6: Seed each market into the engine
  console.log("Step 5: Seeding markets into engine...\n");
  for (const { engine, onChain } of onChainData) {
    const success = await seedMarketToEngine(engine, onChain);
    if (!success) {
      console.error(`  Failed to seed ${engine.engineId}, continuing...`);
    }
    // Wait for on-chain liquidity setup (15s for multicall + confirmation)
    await sleep(20000);
  }

  // Step 7: Verify
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

  // Check DB directly
  console.log("\nDB verification:");
  const { execSync } = await import("child_process");
  try {
    const dbOutput = execSync(
      `docker exec market-zap-postgres psql -U postgres -d market_zap -c "SELECT market_id, on_chain_market_id, condition_id, collateral_token, status FROM markets;"`,
      { encoding: "utf-8" }
    );
    console.log(dbOutput);
  } catch {}

  // Check Redis AMM state
  console.log("Redis AMM state:");
  try {
    const keys = execSync(`docker exec market-zap-redis redis-cli KEYS "amm:*"`, { encoding: "utf-8" });
    console.log(keys);
    for (const key of keys.trim().split("\n").filter(Boolean)) {
      const val = execSync(`docker exec market-zap-redis redis-cli GET "${key}"`, { encoding: "utf-8" });
      console.log(`  ${key}: ${val.trim()}`);
    }
  } catch {}

  console.log("\n=== Done! ===");
}

main().catch(err => { console.error(err); process.exit(1); });
