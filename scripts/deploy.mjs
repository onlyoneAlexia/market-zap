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
import { execFileSync } from "node:child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { loadPrivateKey, loadAdminAddress } from "./lib/keystore.mjs";
import { writeDeployedAddresses, readExistingAddresses } from "./addresses/write-addresses.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// Load engine .env first (has ADMIN_ADDRESS), then root .env (has keystore config).
// dotenv won't overwrite already-set keys, so engine values take precedence.
dotenv.config({ path: path.resolve(__dirname, "../services/engine/.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const args = process.argv.slice(2);
function flag(name) {
  return args.includes(`--${name}`);
}
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const errorMessage = (error, max = Infinity) =>
  (error instanceof Error ? error.message : String(error)).slice(0, max);
const isAlreadyDeclaredError = (message) =>
  message.includes("CLASS_ALREADY_DECLARED") || message.includes("AlreadyDeclared");

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

const ARTIFACTS = {
  MockERC20: "market_zap_MockERC20",
  CollateralVault: "market_zap_CollateralVault",
  ConditionalTokens: "market_zap_ConditionalTokens",
  MarketFactory: "market_zap_MarketFactory",
  CLOBExchange: "market_zap_CLOBExchange",
  AdminResolver: "market_zap_AdminResolver",
};

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
    const msg = errorMessage(err);

    if (isAlreadyDeclaredError(msg)) {
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
      const msg2 = errorMessage(err2);
      if (isAlreadyDeclaredError(msg2)) {
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
    const norm = (a) => {
      const s = String(a);
      // Handle BigInt decimal returned by starknet.js
      if (/^\d+$/.test(s)) return "0x" + BigInt(s).toString(16);
      return "0x" + s.replace(/^0x0*/, "").toLowerCase();
    };
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

  // Helper: create Contract with starknet.js v9 object syntax
  const makeContract = (name, address) =>
    new Contract({ abi: loadAbi(name), address, providerOrAccount: provider });

  // 1. Vault: USDC is a supported token
  try {
    const vault = makeContract("CollateralVault", addresses.CollateralVault);
    const supported = await vault.is_supported(addresses.USDC);
    if (supported) {
      console.log(`  [PASS] Vault supports USDC`);
    } else {
      console.log(`  [FAIL] Vault does NOT support USDC`);
      ok = false;
    }
  } catch (e) {
    console.log(`  [FAIL] Vault USDC check: ${errorMessage(e, 100)}`);
    ok = false;
  }

  // 2. Vault: owner is admin
  try {
    const vault = makeContract("CollateralVault", addresses.CollateralVault);
    const ownerOnChain = await vault.owner();
    check("Vault owner", String(ownerOnChain), ADMIN_ADDRESS);
  } catch (e) {
    console.log(`  [FAIL] Vault owner: ${errorMessage(e, 100)}`);
    ok = false;
  }

  // 3. Exchange: owner is admin
  try {
    const exchange = makeContract("CLOBExchange", addresses.CLOBExchange);
    const ownerOnChain = await exchange.owner();
    check("Exchange owner", String(ownerOnChain), ADMIN_ADDRESS);
  } catch (e) {
    console.log(`  [FAIL] Exchange owner: ${errorMessage(e, 100)}`);
    ok = false;
  }

  // 4. Exchange: not paused
  try {
    const exchange = makeContract("CLOBExchange", addresses.CLOBExchange);
    const paused = await exchange.is_paused();
    if (!paused) {
      console.log(`  [PASS] Exchange is not paused`);
    } else {
      console.log(`  [FAIL] Exchange is paused`);
      ok = false;
    }
  } catch (e) {
    console.log(`  [WARN] Exchange pause check: ${errorMessage(e, 100)}`);
  }

  // 5. Resolver: admin is correct
  try {
    const resolver = makeContract("AdminResolver", addresses.AdminResolver);
    const adminOnChain = await resolver.get_admin();
    check("Resolver admin", String(adminOnChain), ADMIN_ADDRESS);
  } catch (e) {
    console.log(`  [FAIL] Resolver admin: ${errorMessage(e, 100)}`);
    ok = false;
  }

  // 6. Resolver: default dispute period is 86400 (24h)
  try {
    const resolver = makeContract("AdminResolver", addresses.AdminResolver);
    const period = await resolver.get_dispute_period();
    if (Number(period) === 86400) {
      console.log(`  [PASS] Resolver dispute period = 86400`);
    } else {
      console.log(`  [FAIL] Resolver dispute period = ${period} (expected 86400)`);
      ok = false;
    }
  } catch (e) {
    console.log(`  [FAIL] Resolver dispute period: ${errorMessage(e, 100)}`);
    ok = false;
  }

  // 7. Verify all contract class hashes are deployed (non-zero code)
  for (const [name, addr] of Object.entries(addresses)) {
    try {
      const classHash = await provider.getClassHashAt(addr);
      if (classHash && classHash !== "0x0") {
        console.log(`  [PASS] ${name} deployed (class=${classHash.slice(0, 18)}...)`);
      } else {
        console.log(`  [FAIL] ${name} has no code at ${addr}`);
        ok = false;
      }
    } catch (e) {
      console.log(`  [FAIL] ${name} not found: ${errorMessage(e, 80)}`);
      ok = false;
    }
  }

  console.log(ok ? "\n  All checks passed!" : "\n  Some checks FAILED.");
  return ok;
}

// ---------------------------------------------------------------------------
// Voyager source verification via sncast
// ---------------------------------------------------------------------------
const CONTRACT_NAMES_FOR_ADDRESSES = {
  USDC: "MockERC20",
  CollateralVault: "CollateralVault",
  ConditionalTokens: "ConditionalTokens",
  MarketFactory: "MarketFactory",
  CLOBExchange: "CLOBExchange",
  AdminResolver: "AdminResolver",
};

async function verifyOnVoyager(addresses) {
  const contractsDir = path.join(PROJECT_ROOT, "contracts");

  for (const [key, contractName] of Object.entries(CONTRACT_NAMES_FOR_ADDRESSES)) {
    const addr = addresses[key];
    if (!addr) continue;

    console.log(`  Verifying ${contractName} (${key})...`);
    try {
      const out = execFileSync("sncast", [
        "verify",
        "--contract-address", addr,
        "--contract-name", contractName,
        "--verifier", "voyager",
        "--network", NETWORK,
        "--confirm-verification",
      ], {
        cwd: contractsDir,
        encoding: "utf8",
        timeout: 120_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (out.includes("already verified")) {
        console.log(`    Already verified`);
      } else {
        console.log(`    Submitted`);
      }
    } catch (e) {
      const msg = e.stderr || e.stdout || e.message || "";
      if (msg.includes("already verified")) {
        console.log(`    Already verified`);
      } else {
        console.log(`    Error: ${msg.slice(0, 150)}`);
      }
    }
    await sleep(2000); // Rate limit
  }

  console.log("\n  Voyager verification jobs submitted. Check status on voyager.online.");
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

  // Phase 5: Verify on-chain wiring
  console.log("");
  await verify(addresses);

  // Phase 6: Verify source code on Voyager
  console.log("\nPhase 6: Voyager source verification\n");
  await verifyOnVoyager(addresses);

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
    console.log(`  set_clob_exchange failed (likely already set): ${errorMessage(e, 200)}`);
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
  console.error("\nFATAL:", errorMessage(e, 500));
  process.exit(1);
});
