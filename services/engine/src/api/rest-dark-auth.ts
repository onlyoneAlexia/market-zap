import { type Request, type Response } from "express";
import { RpcProvider, typedData as snTypedData } from "starknet";
import type { Database } from "../db/postgres.js";
import { normalizeHex, verifyOrderSignature } from "./rest-shared.js";

const AUTH_TYPED_DATA_TYPES = {
  StarknetDomain: [
    { name: "name", type: "shortstring" },
    { name: "version", type: "shortstring" },
    { name: "chainId", type: "shortstring" },
    { name: "revision", type: "shortstring" },
  ],
  MZAuth: [
    { name: "address", type: "ContractAddress" },
    { name: "timestamp", type: "u128" },
  ],
};

const AUTH_DOMAIN = {
  name: "MarketZap",
  version: "1",
  chainId: process.env.STARKNET_CHAIN_ID ?? "0x534e5f5345504f4c4941",
  revision: "1",
};

const darkAuthCache = new Map<string, number>();
const DARK_AUTH_CACHE_TTL_MS = 4 * 60 * 1000;
const DARK_AUTH_MAX_AGE_S = 300;

function cleanDarkAuthCache(): void {
  const now = Date.now();
  for (const [key, expiry] of darkAuthCache) {
    if (now > expiry) darkAuthCache.delete(key);
  }
}

async function verifyDarkAuth(
  provider: RpcProvider,
  authHeader: string | undefined,
): Promise<string | null> {
  if (!authHeader) return null;

  const parts = authHeader.split(":");
  if (parts.length < 3) return null;

  const address = parts[0]!;
  const timestampStr = parts[1]!;
  const signature = parts.slice(2).join(":");
  const timestamp = parseInt(timestampStr, 10);
  if (Number.isNaN(timestamp)) return null;

  const now = Math.floor(Date.now() / 1000);
  if (timestamp > now + 30 || now - timestamp > DARK_AUTH_MAX_AGE_S) return null;

  const cacheKey = `${address}:${timestampStr}`;
  const cached = darkAuthCache.get(cacheKey);
  if (cached && Date.now() < cached) return address;

  const authTypedData = {
    types: AUTH_TYPED_DATA_TYPES,
    primaryType: "MZAuth" as const,
    domain: AUTH_DOMAIN,
    message: {
      address,
      timestamp: timestampStr,
    },
  };
  const authHash = snTypedData.getMessageHash(authTypedData, address);
  const valid = await verifyOrderSignature(provider, address, authHash, signature);
  if (!valid) return null;

  darkAuthCache.set(cacheKey, Date.now() + DARK_AUTH_CACHE_TTL_MS);
  if (darkAuthCache.size > 1000) cleanDarkAuthCache();
  return address;
}

async function userHasDarkPositions(
  db: Database,
  address: string,
): Promise<boolean> {
  try {
    return await db.userHasDarkTrades(address);
  } catch {
    return false;
  }
}

export function createDarkAuthGuard(db: Database) {
  const provider = new RpcProvider({
    nodeUrl:
      process.env.STARKNET_RPC_URL ??
      "https://api.zan.top/public/starknet-sepolia/rpc/v0_8",
  });

  return async function requireDarkAuth(
    req: Request,
    res: Response,
    requestedAddress: string,
  ): Promise<boolean> {
    const authHeader = req.headers["x-mz-auth"] as string | undefined;
    if (authHeader) {
      const authedAddress = await verifyDarkAuth(provider, authHeader);
      if (
        authedAddress &&
        normalizeHex(authedAddress) === normalizeHex(requestedAddress)
      ) {
        res.locals.darkAuthVerified = true;
      }
    }

    await userHasDarkPositions(db, requestedAddress);
    return true;
  };
}
