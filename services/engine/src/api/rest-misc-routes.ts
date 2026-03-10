import { type Request, type Response, type Router } from "express";
import { asyncHandler, decodeU256, normalizeHex, ok, paginated, PaginationSchema, shortAddress } from "./rest-shared.js";
import type { RestRouteContext } from "./rest-types.js";
import { getTokenByAddress } from "@market-zap/shared";
import { DARK_TRADE_SETTLED_SELECTOR, ERC1155_TRANSFER_SINGLE_SELECTOR, ERC20_TRANSFER_SELECTOR } from "./rest-selectors.js";

let lastLeaderboardRefresh = 0;
const LEADERBOARD_REFRESH_INTERVAL = 60_000;

export function registerMiscRoutes(
  router: Router,
  context: RestRouteContext,
): void {
  router.get(
    "/api/leaderboard",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = PaginationSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }

      const now = Date.now();
      if (now - lastLeaderboardRefresh > LEADERBOARD_REFRESH_INTERVAL) {
        lastLeaderboardRefresh = now;
        context.deps.db.refreshLeaderboard().catch((error) =>
          console.warn("[rest] leaderboard refresh failed:", error),
        );
      }

      const { limit, offset } = parsed.data;
      const leaderboard = await context.deps.db.getLeaderboard(limit, offset);
      const divisor = 10 ** 6;
      const entries = leaderboard.map((row, index) => ({
        rank: offset + index + 1,
        address: row.user_address,
        totalPnl: (parseFloat(row.realized_pnl) / divisor).toFixed(2),
        totalVolume: (parseFloat(row.total_volume) / divisor).toFixed(2),
        tradesCount: row.total_trades,
        winRate: Math.round(row.win_rate * 100),
      }));

      ok(res, paginated(entries, entries.length, Math.floor(offset / limit), limit));
    }),
  );

  router.get(
    "/api/balance/:address/:token",
    asyncHandler(async (req: Request, res: Response) => {
      const address = req.params.address as string;
      const token = req.params.token as string;

      if (!address.startsWith("0x") || !token.startsWith("0x")) {
        res.status(400).json({ error: "Invalid address format" });
        return;
      }
      if (!(await context.requireDarkAuth(req, res, address))) return;

      const cachedSnapshot =
        await context.deps.balanceChecker.getCachedBalanceSnapshot(address, token);
      if (cachedSnapshot) {
        ok(res, { address, token, ...cachedSnapshot });
        return;
      }

      const [balRes, resRes, walRes, pendingRes, decRes] = await Promise.allSettled([
        context.deps.balanceChecker.checkBalance(address, token),
        context.deps.balanceChecker.checkReserved(address, token),
        context.deps.balanceChecker.checkWalletBalance(address, token),
        context.deps.db.getUnsettledBuyCosts(address),
        context.deps.balanceChecker.checkDecimals(token),
      ]);

      const balance = balRes.status === "fulfilled" ? balRes.value : 0n;
      const reserved = resRes.status === "fulfilled" ? resRes.value : 0n;
      const walletBalance = walRes.status === "fulfilled" ? walRes.value : 0n;
      const pendingCosts = pendingRes.status === "fulfilled" ? pendingRes.value : 0n;
      const walletDecimals = decRes.status === "fulfilled" ? decRes.value : 18;
      const tokenInfo = getTokenByAddress(token, "sepolia");
      const available = balance > pendingCosts ? balance - pendingCosts : 0n;

      const snapshot = {
        balance: (balance + reserved).toString(),
        reserved: reserved.toString(),
        available: available.toString(),
        walletBalance: walletBalance.toString(),
        walletDecimals,
        exchangeDecimals: tokenInfo?.decimals ?? 6,
      };

      await context.deps.balanceChecker.cacheBalanceSnapshot(address, token, snapshot);
      ok(res, { address, token, ...snapshot });
    }),
  );

  router.get(
    "/api/tx/:hash/events",
    asyncHandler(async (req: Request, res: Response) => {
      const txHash = req.params.hash as string;
      if (!txHash || !txHash.startsWith("0x")) {
        res.status(400).json({ error: "Invalid transaction hash" });
        return;
      }

      const knownLabels = new Map<string, string>();
      knownLabels.set(normalizeHex(context.deps.settler.exchangeAddr), "CLOBExchange");
      if (context.conditionalTokensAddress) {
        knownLabels.set(
          normalizeHex(context.conditionalTokensAddress),
          "ConditionalTokens",
        );
      }
      if (process.env.COLLATERAL_VAULT_ADDRESS) {
        knownLabels.set(
          normalizeHex(process.env.COLLATERAL_VAULT_ADDRESS),
          "CollateralVault",
        );
      }
      if (context.factoryAddress) {
        knownLabels.set(normalizeHex(context.factoryAddress), "MarketFactory");
      }
      if (process.env.ADMIN_RESOLVER_ADDRESS) {
        knownLabels.set(
          normalizeHex(process.env.ADMIN_RESOLVER_ADDRESS),
          "AdminResolver",
        );
      }

      try {
        const receiptRaw = await context.deps.settler.rpcProvider.getTransactionReceipt(txHash);
        const receipt = receiptRaw as {
          execution_status?: string;
          finality_status?: string;
          events?: Array<{ from_address?: string; keys?: string[]; data?: string[] }>;
        };
        const events = Array.isArray(receipt.events) ? receipt.events : [];
        const isDarkTx = events.some((event) => {
          const selector = (Array.isArray(event.keys) ? event.keys[0] ?? "" : "").toLowerCase();
          return selector === DARK_TRADE_SETTLED_SELECTOR;
        });

        const decodedEvents = events.map((event, index) => {
          const keys = Array.isArray(event.keys) ? event.keys : [];
          const data = Array.isArray(event.data) ? event.data : [];
          const selector = (keys[0] ?? "0x0").toLowerCase();
          const fromAddress = normalizeHex(String(event.from_address ?? "0x0"));
          const fromLabel = knownLabels.get(fromAddress) ?? shortAddress(fromAddress);

          if (selector === ERC1155_TRANSFER_SINGLE_SELECTOR && keys.length >= 4 && data.length >= 4) {
            const operatorAddress = normalizeHex(keys[1]);
            const from = isDarkTx ? "redacted" : normalizeHex(keys[2]);
            const to = isDarkTx ? "redacted" : normalizeHex(keys[3]);
            const tokenId = decodeU256(data[0], data[1]).toString();
            const amount = decodeU256(data[2], data[3]).toString();

            return {
              index: index + 1,
              fromAddress,
              fromLabel,
              selector,
              kind: "erc1155_transfer_single" as const,
              summary: isDarkTx
                ? `ERC1155 ${amount} (dark trade — addresses redacted)`
                : `ERC1155 ${amount} from ${knownLabels.get(from) ?? shortAddress(from)} to ${knownLabels.get(to) ?? shortAddress(to)}`,
              operator: isDarkTx
                ? "redacted"
                : (knownLabels.get(operatorAddress) ?? shortAddress(operatorAddress)),
              from,
              to,
              tokenId,
              amount,
              raw: isDarkTx ? undefined : { keys, data },
            };
          }

          if (selector === ERC20_TRANSFER_SELECTOR) {
            let from = "0x0";
            let to = "0x0";
            let amount = "0";
            if (keys.length >= 3 && data.length >= 2) {
              from = isDarkTx ? "redacted" : normalizeHex(keys[1]);
              to = isDarkTx ? "redacted" : normalizeHex(keys[2]);
              amount = decodeU256(data[0], data[1]).toString();
            } else if (data.length >= 4) {
              from = isDarkTx ? "redacted" : normalizeHex(data[0]);
              to = isDarkTx ? "redacted" : normalizeHex(data[1]);
              amount = decodeU256(data[2], data[3]).toString();
            }

            return {
              index: index + 1,
              fromAddress,
              fromLabel,
              selector,
              kind: "erc20_transfer" as const,
              summary: isDarkTx
                ? `ERC20 ${amount} (dark trade — addresses redacted)`
                : `ERC20 ${amount} from ${knownLabels.get(from) ?? shortAddress(from)} to ${knownLabels.get(to) ?? shortAddress(to)}`,
              from,
              to,
              amount,
              raw: isDarkTx ? undefined : { keys, data },
            };
          }

          return {
            index: index + 1,
            fromAddress,
            fromLabel,
            selector,
            kind: "contract_event" as const,
            summary: `${fromLabel} emitted contract event`,
            raw: { keys, data },
          };
        });

        ok(res, {
          txHash,
          executionStatus: receipt.execution_status ?? "UNKNOWN",
          finalityStatus: receipt.finality_status ?? "UNKNOWN",
          eventCount: decodedEvents.length,
          events: decodedEvents,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.toLowerCase().includes("not found")) {
          res.status(404).json({ error: "Transaction not found" });
          return;
        }
        res.status(502).json({ error: `Failed to fetch transaction receipt: ${message}` });
      }
    }),
  );
}
