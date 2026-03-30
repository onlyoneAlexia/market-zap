/**
 * Create markets on-chain + seed into the engine.
 * Bond token = OLD USDC (stored in factory at construction)
 * Market collateral = NEW USDC (with 6 decimals)
 */
import { RpcProvider, Account, CallData, Contract } from "starknet";
import fs from "fs";
import { loadPrivateKey, loadAdminAddress } from "../lib/keystore.mjs";

const RPC_URL = "https://api.zan.top/public/starknet-sepolia/rpc/v0_8";
const PRIVATE_KEY = loadPrivateKey();
const ADMIN_ADDRESS = loadAdminAddress();
const ENGINE_URL = "http://localhost:3001";

// Read addresses from single source of truth
const _addrs = JSON.parse(fs.readFileSync("packages/shared/src/addresses/sepolia.json", "utf-8"));
const USDC = _addrs.USDC;
const MARKET_FACTORY = _addrs.MarketFactory;
const RESOLVER = _addrs.AdminResolver;

const provider = new RpcProvider({ nodeUrl: RPC_URL });
const account = new Account(provider, ADMIN_ADDRESS, PRIVATE_KEY);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const factoryAbi = JSON.parse(fs.readFileSync("packages/shared/src/abis/MarketFactory.json", "utf-8"));
const factory = new Contract(factoryAbi, MARKET_FACTORY, account);

const markets = [
  {
    id: "eth-5k-apr2026",
    question: "Will ETH hit $5,000 by April 2026?",
    outcomes: ["Yes", "No"],
    category: "crypto",
    resolution_hours: 720,
  },
  {
    id: "btc-150k-q2-2026",
    question: "Will BTC reach $150,000 in Q2 2026?",
    outcomes: ["Yes", "No"],
    category: "crypto",
    resolution_hours: 2160,
  },
  {
    id: "fed-rate-cut-apr2026",
    question: "Will the US Fed cut rates in April 2026?",
    outcomes: ["Yes", "No"],
    category: "economics",
    resolution_hours: 720,
  },
];

function strToFelt(s) {
  let hex = "0x";
  for (let i = 0; i < s.length; i++) {
    hex += s.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return hex;
}

async function main() {
  console.log("=== Seeding Markets ===\n");

  // Mint & approve already done via starkli. Just verify balance.
  console.log("USDC mint + approve already done. Proceeding...\n");

  for (const m of markets) {
    console.log(`--- ${m.id} ---`);
    try {
      const resTime = Math.floor(Date.now() / 1000) + m.resolution_hours * 3600;
      const outcomesFelts = m.outcomes.map(strToFelt);
      const categoryFelt = strToFelt(m.category);

      // Create market on-chain (collateral = NEW USDC)
      console.log(`Creating on-chain: "${m.question}"`);
      const createTx = await account.execute([
        factory.populate("create_market", [
          m.question,
          outcomesFelts,
          categoryFelt,
          USDC,
          resTime,
          RESOLVER,
        ]),
      ]);
      console.log(`  Create tx: ${createTx.transaction_hash}`);
      const receipt = await provider.waitForTransaction(createTx.transaction_hash);

      if (receipt.execution_status === "REVERTED") {
        console.error(`  REVERTED: ${receipt.revert_reason}`);
        continue;
      }

      // Extract market_id from MarketCreated event
      let onChainMarketId = null;
      if (receipt.events) {
        for (const evt of receipt.events) {
          if (evt.keys.length > 1) {
            const possibleId = parseInt(evt.keys[1], 16);
            if (possibleId > 0 && possibleId < 1000) {
              onChainMarketId = possibleId.toString();
              break;
            }
          }
        }
      }
      console.log(`  On-chain market ID: ${onChainMarketId}`);

      await sleep(5000);

      // Seed into engine
      console.log(`  Seeding into engine...`);
      const resp = await fetch(`${ENGINE_URL}/api/admin/seed-market`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Match the indexer identity to avoid split rows for one market.
          marketId: onChainMarketId,
          onChainMarketId,
          title: m.question,
          outcomeLabels: m.outcomes,
          category: m.category,
          collateralToken: USDC,
          resolutionTime: new Date(resTime * 1000).toISOString(),
          outcomeCount: m.outcomes.length,
        }),
      });
      const body = await resp.json();
      if (!resp.ok) {
        console.error(`  Seed failed:`, JSON.stringify(body).slice(0, 300));
      } else {
        console.log(`  Seeded! AMM initialized.`);
      }
    } catch (err) {
      console.error(`  Error:`, err.message?.slice(0, 500));
      if (err.baseError) console.error(`  Details:`, JSON.stringify(err.baseError).slice(0, 500));
    }
    await sleep(8000);
  }

  console.log("\n=== Done! ===");
}

main().catch(err => { console.error(err); process.exit(1); });
