/**
 * Keystore utility for the engine — decrypts a starkli keystore at startup.
 *
 * Delegates to `starkli signer keystore inspect-private` so we don't
 * reimplement crypto. The decrypted key lives only in process memory.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { logger } from "./logger.js";

export interface KeystoreConfig {
  /** Path to starkli keystore JSON file */
  keystorePath: string;
  /** Password to decrypt the keystore */
  password: string;
}

/**
 * Decrypt a starkli keystore and return the private key.
 *
 * @throws if starkli is not installed, password is wrong, or file is missing
 */
export function decryptKeystore(config: KeystoreConfig): string {
  if (!fs.existsSync(config.keystorePath)) {
    throw new Error(`Keystore file not found: ${config.keystorePath}`);
  }

  const out = execFileSync("starkli", [
    "signer", "keystore", "inspect-private",
    config.keystorePath,
    "--password", config.password,
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
 * Load the admin private key from env.
 *
 * Resolution order:
 *   1. ADMIN_PRIVATE_KEY (legacy plaintext — warns)
 *   2. ADMIN_KEYSTORE_PATH + ADMIN_KEYSTORE_PASSWORD (recommended)
 *   3. KEYSTORE_PATH + KEYSTORE_PASSWORD (fallback aliases)
 */
export function loadAdminPrivateKey(): string {
  // Legacy: raw key in env
  if (process.env.ADMIN_PRIVATE_KEY) {
    logger.warn(
      "ADMIN_PRIVATE_KEY is set as plaintext in env. " +
      "Migrate to a keystore: node scripts/keystore.mjs create",
    );
    return process.env.ADMIN_PRIVATE_KEY;
  }

  // Keystore path + password
  const keystorePath =
    process.env.ADMIN_KEYSTORE_PATH ||
    process.env.KEYSTORE_PATH;

  const password =
    process.env.ADMIN_KEYSTORE_PASSWORD ||
    process.env.KEYSTORE_PASSWORD;

  if (keystorePath && password) {
    logger.info({ keystorePath }, "decrypting admin keystore...");
    const key = decryptKeystore({ keystorePath, password });
    logger.info("admin keystore decrypted successfully");
    return key;
  }

  if (keystorePath && !password) {
    throw new Error(
      "ADMIN_KEYSTORE_PATH is set but ADMIN_KEYSTORE_PASSWORD is missing. " +
      "Set the password in your environment.",
    );
  }

  throw new Error(
    "No admin private key configured. Set one of:\n" +
    "  - ADMIN_KEYSTORE_PATH + ADMIN_KEYSTORE_PASSWORD (recommended)\n" +
    "  - ADMIN_PRIVATE_KEY (legacy, not recommended)\n" +
    "Create a keystore with: node scripts/keystore.mjs create",
  );
}
