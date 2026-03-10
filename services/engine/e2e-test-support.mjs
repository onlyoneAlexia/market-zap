import fs from "fs";
import {
  Account,
  RpcProvider,
  constants,
  ec,
  hash as starknetHash,
  typedData,
} from "starknet";
import { loadAdminAddress, loadPrivateKey } from "../../scripts/lib/keystore.mjs";

function createLocalOrderUtils() {
  const mask128 = (1n << 128n) - 1n;
  const splitU256 = (value) => ({
    low: (value & mask128).toString(),
    high: (value >> 128n).toString(),
  });

  const buildOrderTypedData = (
    order,
    chainId = constants.StarknetChainId.SN_SEPOLIA,
  ) => ({
    types: {
      StarknetDomain: [
        { name: "name", type: "shortstring" },
        { name: "version", type: "shortstring" },
        { name: "chainId", type: "shortstring" },
        { name: "revision", type: "shortstring" },
      ],
      Order: [
        { name: "trader", type: "ContractAddress" },
        { name: "market_id", type: "u128" },
        { name: "token_id", type: "u256" },
        { name: "is_buy", type: "bool" },
        { name: "price", type: "u256" },
        { name: "amount", type: "u256" },
        { name: "nonce", type: "u256" },
        { name: "expiry", type: "u128" },
      ],
      u256: [
        { name: "low", type: "u128" },
        { name: "high", type: "u128" },
      ],
    },
    primaryType: "Order",
    domain: {
      name: "MarketZap",
      version: "1",
      chainId,
      revision: "1",
    },
    message: {
      trader: order.trader,
      market_id: BigInt(order.marketId).toString(),
      token_id: splitU256(BigInt(order.tokenId)),
      is_buy: order.isBuy,
      price: splitU256(BigInt(order.price)),
      amount: splitU256(BigInt(order.amount)),
      nonce: splitU256(BigInt(order.nonce)),
      expiry: BigInt(order.expiry).toString(),
    },
  });

  const computeOrderHash = (
    order,
    _exchangeAddress,
    chainId = constants.StarknetChainId.SN_SEPOLIA,
  ) => typedData.getMessageHash(buildOrderTypedData(order, chainId), order.trader);

  const computeTokenId = (conditionId, outcomeIndex) =>
    BigInt(starknetHash.computePoseidonHashOnElements([conditionId, outcomeIndex]));

  const signOrderHash = (orderHash, privateKey) => {
    const sig = ec.starkCurve.sign(orderHash, privateKey);
    return {
      r: `0x${sig.r.toString(16)}`,
      s: `0x${sig.s.toString(16)}`,
    };
  };

  const formatSignature = (sig) => `${sig.r},${sig.s}`;
  const scalePrice = (price) => {
    const value = typeof price === "number" ? price.toFixed(18) : price;
    if (/^\d+$/.test(value)) return BigInt(value);
    const [intPart, fracPart = ""] = value.split(".");
    return BigInt(intPart + fracPart.padEnd(18, "0").slice(0, 18));
  };

  const computeQuestionHash = (question) => {
    const bytes = new TextEncoder().encode(question);
    const bytesPerWord = 31;
    const fullWords = Math.floor(bytes.length / bytesPerWord);
    const pendingLen = bytes.length % bytesPerWord;
    const elements = [fullWords];

    for (let index = 0; index < fullWords; index++) {
      let value = 0n;
      for (const byte of bytes.slice(index * bytesPerWord, (index + 1) * bytesPerWord)) {
        value = (value << 8n) | BigInt(byte);
      }
      elements.push(value);
    }

    let pendingValue = 0n;
    for (const byte of bytes.slice(fullWords * bytesPerWord)) {
      pendingValue = (pendingValue << 8n) | BigInt(byte);
    }
    elements.push(pendingValue);
    elements.push(pendingLen);

    return starknetHash.computePoseidonHashOnElements(elements);
  };

  return {
    computeTokenId,
    computeOrderHash,
    scalePrice,
    signOrderHash,
    formatSignature,
    computeQuestionHash,
  };
}

async function loadSharedOrderUtils() {
  try {
    return await import("@market-zap/shared");
  } catch {
    return createLocalOrderUtils();
  }
}

export const {
  computeTokenId,
  computeOrderHash,
  scalePrice,
  signOrderHash,
  formatSignature,
  computeQuestionHash,
} = await loadSharedOrderUtils();

export const ENGINE_URL = "http://localhost:3001";
export const RPC = "https://api.zan.top/public/starknet-sepolia/rpc/v0_8";
export const ADMIN_ADDR = loadAdminAddress();
export const ADMIN_PK = loadPrivateKey();

const addresses = JSON.parse(
  fs.readFileSync("../../packages/shared/src/addresses/sepolia.json", "utf-8"),
);

export const EXCHANGE = addresses.CLOBExchange;
export const CONDITIONAL_TOKENS = addresses.ConditionalTokens;
export const MARKET_FACTORY = addresses.MarketFactory;
export const USDC = addresses.USDC;
export const DEV_USER_ADDR = process.env.E2E_USER_ADDR ?? ADMIN_ADDR;
export const DEV_USER_PK = process.env.E2E_USER_PK ?? ADMIN_PK;
export const provider = new RpcProvider({ nodeUrl: RPC });
export const admin = new Account(provider, ADMIN_ADDR, ADMIN_PK);
export const devUser = new Account(provider, DEV_USER_ADDR, DEV_USER_PK);

export async function apiPost(path, body) {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`${path} failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

export async function apiGet(path) {
  const res = await fetch(`${ENGINE_URL}${path}`);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`${path} failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

export const testState = {
  failed: 0,
  passed: 0,
};

let nonceCounter = BigInt(Date.now()) * 100000n;

export function nextNonce() {
  nonceCounter += 1n;
  return nonceCounter.toString();
}

export function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    testState.failed += 1;
    return false;
  }
  console.log(`  PASS: ${message}`);
  testState.passed += 1;
  return true;
}

export function signOrder(params, privateKey) {
  const orderHash = computeOrderHash(
    params,
    EXCHANGE,
    constants.StarknetChainId.SN_SEPOLIA,
  );
  return formatSignature(signOrderHash(orderHash, privateKey));
}
