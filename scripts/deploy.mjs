#!/usr/bin/env node
/**
 * Unified MarketZap deployment script.
 *
 * Usage:
 *   node scripts/deploy.mjs                  # Full deploy (all 6 contracts)
 *   node scripts/deploy.mjs --only Exchange  # Redeploy CLOBExchange only
 *   node scripts/deploy.mjs --only USDC      # Redeploy MockERC20 + liquidity setup
 *   node scripts/deploy.mjs --verify         # Verify all contracts are wired correctly
 *
 * Supports: --network sepolia (default) | mainnet
 *           --delay <ms>  (between txs, default 3000)
 */
import { RpcProvider, Account, CallData, Contract, hash } from "starknet";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadPrivateKey, loadAdminAddress } from "./lib/keystore.mjs";
import {
  writeDeployedAddresses,
  readExistingAddresses,
} from "./addresses/write-addresses.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function flag(name) {
  return args.includes(`--${name}`);
}
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const NETWORK = opt("network", "sepolia");
const DELAY = Number(opt("delay", "3000"));
const ONLY = opt("only", null); // null = full deploy
const VERIFY = flag("verify");

const RPC_URLS = {
  sepolia: "https://api.zan.top/public/starknet-sepolia/rpc/v0_8",
  mainnet: "https://api.zan.top/public/starknet-mainnet/rpc/v0_8",
};

const RPC_URL = RPC_URLS[NETWORK];
if (!RPC_URL) {
  console.error(`Unknown network: ${NETWORK}. Use "sepolia" or "mainnet".`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Contract artifact mapping
// ---------------------------------------------------------------------------
const ARTIFACTS = {
  MockERC20: "market_zap_MockERC20",
  CollateralVault: "market_zap_CollateralVault",
  ConditionalTokens: "market_zap_ConditionalTokens",
  MarketFactory: "market_zap_MarketFactory",
  CLOBExchange: "market_zap_CLOBExchange",
  AdminResolver: "market_zap_AdminResolver",
};

// ---------------------------------------------------------------------------
// Provider + account
// ---------------------------------------------------------------------------
const PRIVATE_KEY = loadPrivateKey();
const ADMIN_ADDRESS = loadAdminAddress();
const provider = new RpcProvider({ nodeUrl: RPC_URL });
const account = new Account({ provider, address: ADMIN_ADDRESS, signer: PRIVATE_KEY });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Declare helper — handles CASM hash mismatch + already-declared
// ---------------------------------------------------------------------------
function extractClassAlreadyDeclaredHash(msg) {
  const patterns = [
    /class_hash\s*(?:=|:)\s*(0x[0-9a-fA-F]+)/i,
    /ClassAlreadyDeclared.*?(0x[0-9a-fA-F]{50,})/i,
    /already declared.*?(0x[0-9a-fA-F]{50,})/i,
  ];
  for (const p of patterns) {
    const m = msg.match(p);
    if (m) return m[1];
  }
  const hexes = msg.match(/0x[0-9a-fA-F]{10,}/g) || [];
  return hexes.sort((a, b) => b.length - a.length)[0] || null;
}

async function declare(name) {
  const file = ARTIFACTS[name];
  const sierraPath = path.join(PROJECT_ROOT, `contracts/target/dev/${file}.contract_class.json`);
  const casmPath = path.join(PROJECT_ROOT, `contracts/target/dev/${file}.compiled_contract_class.json`);

  if (!fs.existsSync(sierraPath)) {
    throw new Error(
      `Artifact not found: ${sierraPath}\nRun "cd contracts && scarb build" first.`,
    );
  }

  const sierra = JSON.parse(fs.readFileSync(sierraPath, "utf-8"));
  const casm = JSON.parse(fs.readFileSync(casmPath, "utf-8"));
  const classHash = hash.computeContractClassHash(sierra);

  console.log(`  Declaring ${name} (${classHash.slice(0, 18)}...)...`);

  // Already on-chain?
  try {
    await provider.getClass(classHash);
    console.log(`    Already on-chain, skipping`);
    return classHash;
  } catch {
    // Not declared yet
  }

  // Attempt 1: local CASM
  try {
    const resp = await account.declare({ contract: sierra, casm });
    console.log(`    OK tx=${resp.transaction_hash.slice(0, 18)}...`);
    await provider.waitForTransaction(resp.transaction_hash);
    return resp.class_hash;
  } catch (err) {
    const msg = err.message || "";

    if (msg.includes("CLASS_ALREADY_DECLARED") || msg.includes("AlreadyDeclared")) {
      const h = extractClassAlreadyDeclaredHash(msg) || classHash;
      console.log(`    Already declared: ${h.slice(0, 18)}...`);
      return h;
    }

    // CASM hash mismatch — extract correct hash and retry
    const mActual = msg.match(/Actual:\s*(0x[0-9a-fA-F]+)/);
    const mExpected = msg.match(/Expected:\s*(0x[0-9a-fA-F]+)/);
    const correctHash = mActual?.[1] || mExpected?.[1];
    if (!correctHash) throw new Error(`${name}: unexpected declare error: ${msg.slice(-500)}`);

    console.log(`    CASM mismatch, retrying with sequencer hash...`);
    await sleep(8000);

    try {
      const resp2 = await account.declare({
        contract: sierra,
        casm,
        compiledClassHash: correctHash,
      });
      console.log(`    OK tx=${resp2.transaction_hash.slice(0, 18)}...`);
      await provider.waitForTransaction(resp2.transaction_hash);
      return resp2.class_hash;
    } catch (err2) {
      const msg2 = err2.message || "";
      if (msg2.includes("CLASS_ALREADY_DECLARED") || msg2.includes("AlreadyDeclared")) {
        const h = extractClassAlreadyDeclaredHash(msg2) || classHash;
        console.log(`    Already declared on retry: ${h.slice(0, 18)}...`);
        return h;
      }
      throw new Error(`${name}: retry failed: ${msg2.slice(0, 400)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Deploy helper
// ---------------------------------------------------------------------------
async function deploy(name, classHash, constructorArgs) {
  console.log(`  Deploying ${name}...`);
  const resp = await account.deployContract({
    classHash,
    constructorCalldata: CallData.compile(constructorArgs),
  });
  console.log(`    Address: ${resp.contract_address}`);
  console.log(`    TX: ${resp.transaction_hash.slice(0, 18)}...`);
  await provider.waitForTransaction(resp.transaction_hash);
  return resp.contract_address;
}

// ---------------------------------------------------------------------------
// Invoke helper
// ---------------------------------------------------------------------------
async function invoke(addr, fn, invokeArgs, label) {
  console.log(`  ${label}...`);
  const resp = await account.execute({
    contractAddress: addr,
    entrypoint: fn,
    calldata: CallData.compile(invokeArgs),
  });
  await provider.waitForTransaction(resp.transaction_hash);
  console.log(`    Done (${resp.transaction_hash.slice(0, 18)}...)`);
}

// ---------------------------------------------------------------------------
// Verify — read on-chain state to confirm wiring
// ---------------------------------------------------------------------------
async function verify(addresses) {
  console.log("\n--- Verifying contract wiring ---\n");
  let ok = true;

  const check = (label, actual, expected) => {
    const norm = (a) => "0x" + a.replace(/^0x0*/, "").toLowerCase();
    if (norm(actual) === norm(expected)) {
      console.log(`  [PASS] ${label}`);
    } else {
      console.log(`  [FAIL] ${label}`);
      console.log(`         expected: ${expected}`);
      console.log(`         actual:   ${actual}`);
      ok = false;
    }
  };

  // Read ABIs
  const abiDir = path.join(PROJECT_ROOT, "packages/shared/src/abis");
  const loadAbi = (name) => JSON.parse(fs.readFileSync(path.join(abiDir, `${name}.json`), "utf-8"));

  // 1. Factory -> Exchange
  try {
    const factory = new Contract(loadAbi("MarketFactory"), addresses.MarketFactory, provider);
    const exchangeOnChain = await factory.get_clob_exchange();
    check("Factory -> Exchange", String(exchangeOnChain), addresses.CLOBExchange);
  } catch (e) {
    console.log(`  [FAIL] Factory -> Exchange: ${e.message?.slice(0, 100)}`);
    ok = false;
  }

  // 2. Factory -> ConditionalTokens
  try {
    const factory = new Contract(loadAbi("MarketFactory"), addresses.MarketFactory, provider);
    const ctOnChain = await factory.get_conditional_tokens();
    check("Factory -> ConditionalTokens", String(ctOnChain), addresses.ConditionalTokens);
  } catch (e) {
    console.log(`  [FAIL] Factory -> CT: ${e.message?.slice(0, 100)}`);
    ok = false;
  }

  // 3. Exchange -> Factory
  try {
    const exchange = new Contract(loadAbi("CLOBExchange"), addresses.CLOBExchange, provider);
    const factoryOnChain = await exchange.get_market_factory();
    check("Exchange -> Factory", String(factoryOnChain), addresses.MarketFactory);
  } catch (e) {
    console.log(`  [FAIL] Exchange -> Factory: ${e.message?.slice(0, 100)}`);
    ok = false;
  }

  // 4. Vault -> ConditionalTokens
  try {
    const vault = new Contract(loadAbi("CollateralVault"), addresses.CollateralVault, provider);
    const ctOnChain = await vault.get_conditional_tokens();
    check("Vault -> ConditionalTokens", String(ctOnChain), addresses.ConditionalTokens);
  } catch (e) {
    console.log(`  [FAIL] Vault -> CT: ${e.message?.slice(0, 100)}`);
    ok = false;
  }

  // 5. Check USDC is a supported token in vault
  try {
    const vault = new Contract(loadAbi("CollateralVault"), addresses.CollateralVault, provider);
    const supported = await vault.is_supported_token(addresses.USDC);
    if (supported) {
      console.log(`  [PASS] Vault supports USDC`);
    } else {
      console.log(`  [FAIL] Vault does NOT support USDC`);
      ok = false;
    }
  } catch (e) {
    console.log(`  [WARN] Could not check vault USDC support: ${e.message?.slice(0, 100)}`);
  }

  console.log(ok ? "\n  All checks passed!" : "\n  Some checks FAILED.");
  return ok;
}

// ---------------------------------------------------------------------------
// Full deploy
// ---------------------------------------------------------------------------
async function fullDeploy() {
  console.log("=== MarketZap Full Deployment ===\n");
  console.log(`Network: ${NETWORK}`);
  console.log(`Admin:   ${ADMIN_ADDRESS}`);
  console.log(`RPC:     ${RPC_URL}\n`);

  // Phase 1: Declare all classes
  console.log("Phase 1: Declaring contracts\n");
  const ch = {};
  for (const name of Object.keys(ARTIFACTS)) {
    ch[name] = await declare(name);
    await sleep(DELAY);
  }

  console.log("\n  All classes declared:");
  for (const [n, h] of Object.entries(ch)) console.log(`    ${n}: ${h.slice(0, 18)}...`);

  // Phase 2: Deploy in dependency order
  console.log("\nPhase 2: Deploying contracts\n");

  const usdc = await deploy("MockERC20", ch.MockERC20, []);
  await sleep(DELAY);

  const vault = await deploy("CollateralVault", ch.CollateralVault, [ADMIN_ADDRESS, "0x1"]);
  await sleep(DELAY);

  const ct = await deploy("ConditionalTokens", ch.ConditionalTokens, [
    ADMIN_ADDRESS,
    vault,
    "https://marketzap.xyz/tokens/{id}",
  ]);
  await sleep(DELAY);

  // Phase 3: Wire vault
  console.log("\nPhase 3: Wiring contracts\n");

  await invoke(vault, "set_conditional_tokens", [ct], "Vault -> ConditionalTokens");
  await sleep(DELAY);

  await invoke(vault, "add_supported_token", [usdc], "Vault -> USDC (whitelist)");
  await sleep(DELAY);

  const factory = await deploy("MarketFactory", ch.MarketFactory, [
    ADMIN_ADDRESS,
    ct,
    "0x0", // exchange placeholder (one-time setter)
    usdc,
  ]);
  await sleep(DELAY);

  const exchange = await deploy("CLOBExchange", ch.CLOBExchange, [
    ADMIN_ADDRESS,
    factory,
    ct,
    ADMIN_ADDRESS, // fee_recipient
    ADMIN_ADDRESS, // operator
  ]);
  await sleep(DELAY);

  await invoke(factory, "set_clob_exchange", [exchange], "Factory -> Exchange");
  await sleep(DELAY);

  const resolver = await deploy("AdminResolver", ch.AdminResolver, [ADMIN_ADDRESS, ct, factory]);

  // Phase 4: Write addresses
  const addresses = {
    USDC: usdc,
    CollateralVault: vault,
    ConditionalTokens: ct,
    MarketFactory: factory,
    CLOBExchange: exchange,
    AdminResolver: resolver,
  };

  console.log("\nPhase 4: Saving addresses\n");
  writeDeployedAddresses(NETWORK, addresses);

  // Phase 5: Verify
  console.log("");
  await verify(addresses);

  console.log("\n========================================");
  console.log("  DEPLOYMENT COMPLETE");
  console.log("========================================\n");
}

// ---------------------------------------------------------------------------
// Targeted: redeploy CLOBExchange only
// ---------------------------------------------------------------------------
async function redeployExchange() {
  console.log("=== Redeploy CLOBExchange ===\n");

  const existing = readExistingAddresses(NETWORK);
  if (!existing.MarketFactory || !existing.ConditionalTokens) {
    throw new Error("Cannot redeploy Exchange without existing Factory + CT addresses.");
  }

  console.log(`Using existing Factory:  ${existing.MarketFactory}`);
  console.log(`Using existing CT:       ${existing.ConditionalTokens}\n`);

  const classHash = await declare("CLOBExchange");
  await sleep(DELAY);

  const exchange = await deploy("CLOBExchange", classHash, [
    ADMIN_ADDRESS,
    existing.MarketFactory,
    existing.ConditionalTokens,
    ADMIN_ADDRESS,
    ADMIN_ADDRESS,
  ]);
  await sleep(DELAY);

  // Try to wire factory (may fail if one-time setter already used)
  try {
    await invoke(existing.MarketFactory, "set_clob_exchange", [exchange], "Factory -> Exchange");
  } catch (e) {
    console.log(`  set_clob_exchange failed (likely already set): ${e.message?.slice(0, 200)}`);
    console.log(`  NOTE: Factory must be redeployed if exchange address needs updating.`);
  }

  const addresses = { ...existing, CLOBExchange: exchange };
  writeDeployedAddresses(NETWORK, addresses);
  await verify(addresses);

  console.log("\nDone. Restart engine to pick up changes.");
}

// ---------------------------------------------------------------------------
// Targeted: redeploy MockERC20 (USDC) + liquidity setup
// ---------------------------------------------------------------------------
async function redeployUSDC() {
  console.log("=== Redeploy MockERC20 (USDC) ===\n");

  const existing = readExistingAddresses(NETWORK);
  if (!existing.CollateralVault || !existing.CLOBExchange) {
    throw new Error("Cannot redeploy USDC without existing Vault + Exchange addresses.");
  }

  const classHash = await declare("MockERC20");
  await sleep(DELAY);

  const usdc = await deploy("MockERC20", classHash, []);
  await sleep(DELAY);

  // Wire: add to vault
  await invoke(existing.CollateralVault, "add_supported_token", [usdc], "Vault -> USDC (whitelist)");
  await sleep(DELAY);

  // Mint 10,000 USDC to admin
  await invoke(usdc, "mint", [ADMIN_ADDRESS, { low: "10000000000", high: "0" }], "Mint 10,000 USDC");
  await sleep(DELAY);

  // Approve vault + exchange in one multicall
  console.log("  Approving vault + exchange...");
  const approveResp = await account.execute([
    {
      contractAddress: usdc,
      entrypoint: "approve",
      calldata: CallData.compile({ spender: existing.CollateralVault, amount: { low: "999999999999", high: "0" } }),
    },
    {
      contractAddress: usdc,
      entrypoint: "approve",
      calldata: CallData.compile({ spender: existing.CLOBExchange, amount: { low: "999999999999", high: "0" } }),
    },
  ]);
  await provider.waitForTransaction(approveResp.transaction_hash);
  console.log(`    Done (${approveResp.transaction_hash.slice(0, 18)}...)`);
  await sleep(DELAY);

  // Deposit 5,000 USDC into exchange
  await invoke(
    existing.CLOBExchange,
    "deposit",
    [usdc, { low: "5000000000", high: "0" }],
    "Deposit 5,000 USDC into exchange",
  );

  const addresses = { ...existing, USDC: usdc };
  writeDeployedAddresses(NETWORK, addresses);

  console.log("\nDone. Restart engine to pick up changes.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (VERIFY && !ONLY) {
    const addresses = readExistingAddresses(NETWORK);
    const ok = await verify(addresses);
    process.exit(ok ? 0 : 1);
  }

  if (!ONLY) {
    await fullDeploy();
  } else {
    const target = ONLY.toLowerCase();
    if (target === "exchange" || target === "clobexchange") {
      await redeployExchange();
    } else if (target === "usdc" || target === "mockerc20") {
      await redeployUSDC();
    } else {
      console.error(`Unknown --only target: "${ONLY}"`);
      console.error(`Valid targets: Exchange, USDC`);
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error("\nFATAL:", e.message?.slice(0, 500) || e);
  process.exit(1);
});
