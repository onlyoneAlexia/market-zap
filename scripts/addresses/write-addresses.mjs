/**
 * Shared helper for deploy scripts to write contract addresses to the
 * single source of truth: packages/shared/src/addresses/<network>.json
 *
 * Also writes the legacy deployed-addresses.json for backwards compat.
 *
 * Usage:
 *   import { writeDeployedAddresses } from "../addresses/write-addresses.mjs";
 *   writeDeployedAddresses("sepolia", { USDC: "0x...", CLOBExchange: "0x...", ... });
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

/** Normalize Starknet address: lowercase, remove leading zeros after 0x */
function normalizeAddress(addr) {
  if (!addr || !addr.startsWith("0x")) return addr;
  return "0x" + addr.slice(2).replace(/^0+/, "").toLowerCase();
}

/**
 * Canonical key order for the per-network JSON files.
 * Keys match ContractName in packages/shared/src/contracts.ts.
 */
const CANONICAL_KEYS = [
  "MarketFactory",
  "ConditionalTokens",
  "CLOBExchange",
  "AdminResolver",
  "USDC",
  "CollateralVault",
];

/**
 * Write deployed addresses to:
 *  1. packages/shared/src/addresses/<network>.json  (source of truth)
 *  2. deployed-addresses.json  (legacy, for backwards compat)
 *
 * @param {string} network - "sepolia" or "mainnet"
 * @param {Record<string, string>} addrs - Contract addresses keyed by canonical name
 */
export function writeDeployedAddresses(network, addrs) {
  // Build canonical object with normalized addresses
  const canonical = {};
  for (const key of CANONICAL_KEYS) {
    if (addrs[key]) {
      canonical[key] = normalizeAddress(addrs[key]);
    } else {
      // Preserve existing value from the JSON file if not provided
      const existing = readExistingAddresses(network);
      canonical[key] = existing[key] || "0x0000000000000000000000000000000000000000";
    }
  }

  // Write to shared package (source of truth)
  const sharedPath = path.join(
    PROJECT_ROOT,
    "packages/shared/src/addresses",
    `${network}.json`
  );
  fs.writeFileSync(sharedPath, JSON.stringify(canonical, null, 2) + "\n");
  console.log(`\nAddresses written to ${path.relative(PROJECT_ROOT, sharedPath)}`);

  // Write legacy deployed-addresses.json (flat format for compat)
  const legacyPath = path.join(PROJECT_ROOT, "deployed-addresses.json");
  fs.writeFileSync(legacyPath, JSON.stringify(canonical, null, 2) + "\n");
  console.log(`Legacy copy written to deployed-addresses.json`);

  // Print summary
  console.log("\n--- Deployed Addresses ---");
  for (const [k, v] of Object.entries(canonical)) {
    console.log(`  ${k}: ${v}`);
  }
}

/**
 * Read existing addresses for a network (merge-safe).
 */
export function readExistingAddresses(network) {
  const filePath = path.join(
    PROJECT_ROOT,
    "packages/shared/src/addresses",
    `${network}.json`
  );
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Read addresses for a network — for use by utility scripts.
 */
export function getDeployedAddresses(network = "sepolia") {
  return readExistingAddresses(network);
}
