import fs from "node:fs";
import path from "node:path";
import { RpcProvider } from "starknet";

const RPC_URL =
  process.env.STARKNET_RPC_URL ??
  "https://api.zan.top/public/starknet-sepolia/rpc/v0_8";

const ERC20_TRANSFER_SELECTOR =
  "0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9";
const ERC1155_TRANSFER_SINGLE_SELECTOR =
  "0x182d859c0807ba9db63baf8b9d9fdbfeb885d820be6e206b9dab626d995c433";

function normalizeHex(value) {
  const stripped = String(value).replace(/^0x/i, "").replace(/^0+/, "");
  return (stripped.length > 0 ? `0x${stripped}` : "0x0").toLowerCase();
}

function u256(low, high) {
  return (BigInt(high) << 128n) + BigInt(low);
}

function shortAddress(addr) {
  if (addr === "0x0") return addr;
  return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
}

function loadKnownAddresses() {
  const known = new Map();

  // Common Starknet STRK token on Sepolia.
  known.set(
    normalizeHex(
      "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
    ),
    "STRK",
  );

  const deployedPath = path.join(process.cwd(), "packages/shared/src/addresses/sepolia.json");
  if (!fs.existsSync(deployedPath)) return known;

  try {
    const parsed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
    for (const [name, addr] of Object.entries(parsed)) {
      if (typeof addr === "string" && addr.startsWith("0x")) {
        known.set(normalizeHex(addr), name);
      }
    }
  } catch {
    // Best-effort loading only.
  }

  return known;
}

function labelAddress(addr, known) {
  const n = normalizeHex(addr);
  return known.get(n) ?? shortAddress(n);
}

function printErc20(event, known) {
  const keys = event.keys ?? [];
  const data = event.data ?? [];

  let from = "unknown";
  let to = "unknown";
  let amount = 0n;

  // OZ Cairo ERC20 puts from/to in keys and amount in data [low, high].
  if (keys.length >= 3 && data.length >= 2) {
    from = labelAddress(keys[1], known);
    to = labelAddress(keys[2], known);
    amount = u256(data[0], data[1]);
  } else if (data.length >= 4) {
    from = labelAddress(data[0], known);
    to = labelAddress(data[1], known);
    amount = u256(data[2], data[3]);
  }

  console.log(`  ERC20 Transfer: ${from} -> ${to}, amount=${amount}`);
}

function printErc1155(event, known) {
  const keys = event.keys ?? [];
  const data = event.data ?? [];
  if (keys.length < 4 || data.length < 4) {
    console.log("  ERC1155 TransferSingle: malformed event payload");
    return;
  }

  const operator = labelAddress(keys[1], known);
  const from = labelAddress(keys[2], known);
  const to = labelAddress(keys[3], known);
  const tokenId = u256(data[0], data[1]);
  const amount = u256(data[2], data[3]);

  console.log(
    `  ERC1155 TransferSingle: ${from} -> ${to}, amount=${amount}, tokenId=${tokenId}, operator=${operator}`,
  );
}

async function main() {
  const txHash = process.argv[2];
  if (!txHash) {
    console.error("Usage: node scripts/tx/inspect-transaction.mjs <tx_hash>");
    process.exit(1);
  }

  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  const known = loadKnownAddresses();

  const [tx, receipt] = await Promise.all([
    provider.getTransaction(txHash),
    provider.getTransactionReceipt(txHash),
  ]);

  console.log(`RPC: ${RPC_URL}`);
  console.log(`TX: ${txHash}`);
  console.log(`Type: ${tx.type}`);
  console.log(`Sender: ${tx.sender_address}`);
  console.log(
    `Status: ${receipt.execution_status} / ${receipt.finality_status}`,
  );
  console.log(`Events: ${receipt.events.length}`);
  console.log();

  receipt.events.forEach((event, idx) => {
    const from = normalizeHex(event.from_address);
    const selector = event.keys?.[0] ?? "0x0";
    const fromLabel = labelAddress(from, known);
    console.log(
      `#${idx + 1} from=${fromLabel} (${from}) selector=${selector}`,
    );

    if (selector === ERC20_TRANSFER_SELECTOR) {
      printErc20(event, known);
    } else if (selector === ERC1155_TRANSFER_SINGLE_SELECTOR) {
      printErc1155(event, known);
    } else {
      console.log(
        `  keys=${event.keys?.length ?? 0}, data=${event.data?.length ?? 0}`,
      );
    }
  });

  console.log();
  console.log(
    "Note: trade settlement in CLOBExchange moves collateral in internal balances (reserve/balance mappings).",
  );
  console.log(
    "It does not emit an ERC20 Transfer unless users are depositing/withdrawing/redeeming via token/vault flows.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
