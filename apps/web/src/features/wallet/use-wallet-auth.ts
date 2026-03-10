"use client";

import { useEffect, useRef } from "react";
import { useAppStore } from "@/hooks/use-store";
import { api } from "@/lib/api";
import {
  SN_SEPOLIA_CHAIN_ID,
  normalizeWalletAddress,
} from "./constants";
import { getClientSync } from "./wallet-client";

export function useWalletAuth() {
  const address = useAppStore((state) => state.wallet.address);
  const authCacheRef = useRef<{ value: string; expiry: number } | null>(null);
  const signingPromiseRef = useRef<Promise<string | null> | null>(null);

  useEffect(() => {
    if (!address) {
      api.setAuthProvider(null);
      authCacheRef.current = null;
      signingPromiseRef.current = null;
      return;
    }

    const currentAddress = address;

    api.setAuthProvider(async (mode: "ifAvailable" | "interactive") => {
      const cached = authCacheRef.current;
      if (cached && Date.now() < cached.expiry) {
        return cached.value;
      }

      if (mode === "ifAvailable") {
        return null;
      }

      if (signingPromiseRef.current) {
        return signingPromiseRef.current;
      }

      const doSign = async (): Promise<string | null> => {
        try {
          const client = getClientSync();
          if (!client?.hasWallet()) {
            return null;
          }

          const walletInterface = client.getWallet();
          if (!walletInterface) {
            return null;
          }

          const walletAddress = walletInterface.address;
          if (
            walletAddress &&
            normalizeWalletAddress(walletAddress) !==
              normalizeWalletAddress(currentAddress)
          ) {
            return null;
          }

          const timestamp = Math.floor(Date.now() / 1000);
          const authTypedData = {
            types: {
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
            },
            primaryType: "MZAuth" as const,
            domain: {
              name: "MarketZap",
              version: "1",
              chainId: SN_SEPOLIA_CHAIN_ID,
              revision: "1",
            },
            message: {
              address: currentAddress,
              timestamp: timestamp.toString(),
            },
          };

          const signature = await walletInterface.signMessage(authTypedData);
          // starknet.js Signature is ArraySignatureType (string[]) or
          // WeierstrassSignatureType ({ r: bigint; s: bigint }).
          // Braavos returns an array; ArgentX may return an object.
          let signatureParts: (string | bigint)[];
          if (Array.isArray(signature)) {
            signatureParts = signature as (string | bigint)[];
          } else if (signature && typeof signature === "object") {
            const sigObj = signature as { r?: bigint; s?: bigint };
            if (sigObj.r === undefined || sigObj.s === undefined) {
              throw new Error("Wallet returned an incomplete signature (missing r or s)");
            }
            signatureParts = [sigObj.r, sigObj.s];
          } else {
            throw new Error("Wallet returned an unrecognized signature format");
          }
          const serializedSignature = signatureParts
            .map((value) => {
              if (typeof value === "bigint") {
                return `0x${value.toString(16)}`;
              }

              return String(value);
            })
            .join(",");

          const authValue = `${currentAddress}:${timestamp}:${serializedSignature}`;
          authCacheRef.current = {
            value: authValue,
            expiry: Date.now() + 4 * 60 * 1000,
          };

          return authValue;
        } catch (error) {
          console.warn(
            "[wallet-auth] dark market auth signing failed:",
            error instanceof Error ? error.message : error,
          );
          return null;
        }
      };

      signingPromiseRef.current = doSign().finally(() => {
        signingPromiseRef.current = null;
      });

      return signingPromiseRef.current;
    });

    return () => {
      api.setAuthProvider(null);
      authCacheRef.current = null;
    };
  }, [address]);
}
