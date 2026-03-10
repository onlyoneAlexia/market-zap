#!/usr/bin/env node
/**
 * Keystore management CLI — wraps `starkli signer keystore`.
 *
 * Commands:
 *   create   — Create an encrypted keystore from an existing private key
 *   inspect  — Show the public key of a keystore
 *   decrypt  — Decrypt and print the private key (for piping into other tools)
 *
 * Examples:
 *   node scripts/keystore.mjs create                          # interactive
 *   node scripts/keystore.mjs create --out keys/admin.json    # custom path
 *   KEYSTORE_PASSWORD=secret node scripts/keystore.mjs decrypt # non-interactive
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_KEYSTORE_PATH = path.join(PROJECT_ROOT, "admin.keystore.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(msg) {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function parseArgs(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" && args[i + 1]) {
      flags.out = args[++i];
    } else if (args[i] === "--keystore" && args[i + 1]) {
      flags.keystore = args[++i];
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdCreate(flags) {
  const outPath = flags.out || DEFAULT_KEYSTORE_PATH;

  if (fs.existsSync(outPath)) {
    const overwrite = await prompt(`Keystore already exists at ${outPath}. Overwrite? [y/N] `);
    if (overwrite.toLowerCase() !== "y") {
      die("Aborted.");
    }
  }

  // starkli signer keystore from-key prompts for key + password interactively
  console.error(`Creating keystore at: ${outPath}`);
  console.error("starkli will prompt for your private key and a password.\n");

  try {
    execFileSync("starkli", [
      "signer", "keystore", "from-key", outPath,
    ], {
      stdio: "inherit",
      timeout: 120_000,
    });
  } catch (err) {
    die(`starkli failed: ${err.message}`);
  }

  // Set file permissions to owner-only
  try {
    fs.chmodSync(outPath, 0o600);
  } catch {
    // Windows or restricted fs — skip
  }

  console.error(`\nKeystore created: ${outPath}`);
  console.error("Make sure this file is in .gitignore (*.keystore.json).");
  console.error("\nSet these env vars for scripts/engine:");
  console.error(`  KEYSTORE_PATH=${outPath}`);
  console.error("  KEYSTORE_PASSWORD=<your-password>");
  console.error("  ADMIN_ADDRESS=<your-starknet-account-address>");
}

function cmdInspect(flags) {
  const keystorePath = flags.keystore || process.env.KEYSTORE_PATH || DEFAULT_KEYSTORE_PATH;

  if (!fs.existsSync(keystorePath)) {
    die(`Keystore not found: ${keystorePath}`);
  }

  try {
    execFileSync("starkli", [
      "signer", "keystore", "inspect", keystorePath,
    ], { stdio: "inherit", timeout: 10_000 });
  } catch (err) {
    die(`starkli failed: ${err.message}`);
  }
}

function cmdDecrypt(flags) {
  const keystorePath = flags.keystore || process.env.KEYSTORE_PATH || DEFAULT_KEYSTORE_PATH;

  if (!fs.existsSync(keystorePath)) {
    die(`Keystore not found: ${keystorePath}`);
  }

  const password = process.env.KEYSTORE_PASSWORD;
  const args = [
    "signer", "keystore", "inspect-private",
    keystorePath,
    "--raw",
  ];
  if (password) {
    args.push("--password", password);
  }

  try {
    const out = execFileSync("starkli", args, {
      encoding: "utf8",
      timeout: 10_000,
      // If no password in env, let starkli prompt interactively
      stdio: password ? ["pipe", "pipe", "pipe"] : "inherit",
    });
    if (password) {
      // Print just the key to stdout (for piping)
      process.stdout.write(out.trim() + "\n");
    }
  } catch (err) {
    die(`Decryption failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const flags = parseArgs(rest);

switch (command) {
  case "create":
    await cmdCreate(flags);
    break;
  case "inspect":
    cmdInspect(flags);
    break;
  case "decrypt":
    cmdDecrypt(flags);
    break;
  default:
    console.error("Usage: node scripts/keystore.mjs <create|inspect|decrypt> [--out path] [--keystore path]");
    console.error("");
    console.error("Commands:");
    console.error("  create   Create encrypted keystore from a private key (interactive)");
    console.error("  inspect  Show the public key of a keystore");
    console.error("  decrypt  Decrypt and print the private key");
    console.error("");
    console.error("Environment:");
    console.error("  KEYSTORE_PATH      Path to keystore (default: admin.keystore.json)");
    console.error("  KEYSTORE_PASSWORD  Password for non-interactive decrypt");
    process.exit(command ? 1 : 0);
}
