/**
 * Keystore utilities — thin wrapper around `starkli signer keystore`.
 *
 * No custom crypto — delegates to starkli for encrypt/decrypt.
 *
 * Usage from other scripts:
 *   import { loadPrivateKey, loadAdminAddress } from "../lib/keystore.mjs";
 *   const pk = await loadPrivateKey();
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

/** Default keystore location (project root) */
export const DEFAULT_KEYSTORE_PATH = path.join(PROJECT_ROOT, "admin.keystore.json");

/**
 * Decrypt a starkli keystore file and return the private key.
 *
 * @param {string} keystorePath - Path to the keystore JSON file
 * @param {string} password - Keystore password
 * @returns {string} Hex private key with 0x prefix
 */
export function decryptKeystore(keystorePath, password) {
  const out = execFileSync("starkli", [
    "signer", "keystore", "inspect-private",
    keystorePath,
    "--password", password,
    "--raw",
  ], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const key = out.trim();
  if (!key.startsWith("0x")) {
    throw new Error("starkli returned unexpected output — expected hex private key");
  }
  return key;
}

/**
 * Load the admin private key from an encrypted keystore.
 *
 * Resolution order:
 *   1. ADMIN_PRIVATE_KEY env var (legacy fallback, warns)
 *   2. STARKNET_PRIVATE_KEY env var (legacy fallback, warns)
 *   3. KEYSTORE_PATH (or default admin.keystore.json) + KEYSTORE_PASSWORD env var
 *
 * @returns {string} Hex private key with 0x prefix
 */
export function loadPrivateKey() {
  // Legacy fallback: raw private key in env (warn)
  if (process.env.ADMIN_PRIVATE_KEY) {
    process.stderr.write(
      "WARNING: ADMIN_PRIVATE_KEY is set as plaintext in env. Migrate to a keystore:\n" +
      "  node scripts/keystore.mjs create\n\n",
    );
    return process.env.ADMIN_PRIVATE_KEY;
  }
  if (process.env.STARKNET_PRIVATE_KEY) {
    process.stderr.write(
      "WARNING: STARKNET_PRIVATE_KEY is set as plaintext in env. Migrate to a keystore:\n" +
      "  node scripts/keystore.mjs create\n\n",
    );
    return process.env.STARKNET_PRIVATE_KEY;
  }

  const rawKeystorePath = process.env.ADMIN_KEYSTORE_PATH || process.env.KEYSTORE_PATH || null;
  let keystorePath = rawKeystorePath
    ? path.resolve(rawKeystorePath)
    : DEFAULT_KEYSTORE_PATH;
  // Relative paths in .env may reference project root; check there too
  if (!fs.existsSync(keystorePath) && rawKeystorePath) {
    const fromRoot = path.resolve(PROJECT_ROOT, path.basename(rawKeystorePath));
    if (fs.existsSync(fromRoot)) keystorePath = fromRoot;
  }

  if (!fs.existsSync(keystorePath)) {
    throw new Error(
      `Keystore not found at ${keystorePath}\n` +
      `Create one with: node scripts/keystore.mjs create\n` +
      `Or set ADMIN_KEYSTORE_PATH / KEYSTORE_PATH to point to your keystore file.`,
    );
  }

  const password = process.env.ADMIN_KEYSTORE_PASSWORD || process.env.KEYSTORE_PASSWORD;
  if (!password) {
    throw new Error(
      "KEYSTORE_PASSWORD not set.\n" +
      "Set it in your environment or use: ADMIN_KEYSTORE_PASSWORD=<pw> node <script>",
    );
  }

  return decryptKeystore(keystorePath, password);
}

/**
 * Load the admin address. Checks env vars then keystore metadata.
 *
 * @returns {string}
 */
export function loadAdminAddress() {
  if (process.env.ADMIN_ADDRESS) return process.env.ADMIN_ADDRESS;
  if (process.env.STARKNET_ACCOUNT_ADDRESS) return process.env.STARKNET_ACCOUNT_ADDRESS;

  // Try to read the public key from the keystore via starkli inspect
  const keystorePath = process.env.KEYSTORE_PATH || DEFAULT_KEYSTORE_PATH;
  if (fs.existsSync(keystorePath)) {
    try {
      const out = execFileSync("starkli", [
        "signer", "keystore", "inspect",
        keystorePath,
      ], { encoding: "utf8", timeout: 5_000, stdio: ["pipe", "pipe", "pipe"] });
      // starkli inspect outputs the public key, not the address.
      // Address must come from env.
    } catch {
      // ignore
    }
  }

  throw new Error(
    "ADMIN_ADDRESS (or STARKNET_ACCOUNT_ADDRESS) not set in environment.",
  );
}
