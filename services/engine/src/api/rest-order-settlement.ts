import { constants } from "starknet";
import {
  computeOrderHash,
  computeTokenId,
  computeTradeCommitment,
  scalePrice as scalePriceShared,
} from "@market-zap/shared";
import { logger } from "../logger.js";
import { tradesFailed, tradesSettled } from "../metrics.js";
import type { MatchResult, Trade } from "../matcher.js";
import {
  computeBidReservation,
  sanitizeSettlementError,
  scalePriceStr,
} from "./rest-shared.js";
import type { BroadcastQuoteParams, RestDeps } from "./rest-types.js";

interface ScheduleOrderSettlementParams {
  data: {
    amount: string;
    marketId: string;
    nonce: string;
    orderType: "LIMIT" | "MARKET";
    outcomeIndex: number;
    price: string;
    side: "BID" | "ASK";
    signature: string;
    user: string;
    expiry: number;
  };
  conditionalTokensAddress: string;
  deps: RestDeps;
  requestId: string;
  dbMarketId: string;
  conditionId: string;
  tokenId: string;
  onChainMarketId: string;
  reserveExpiry: number;
  market: {
    collateral_token: string;
    outcome_count: number;
  };
  marketIsDark: boolean;
  matchResult: MatchResult;
  tradeDbRows: Array<{ dbId: string; trade: Trade }>;
  broadcastQuote(params: BroadcastQuoteParams): Promise<void>;
}

export function scheduleOrderSettlement({
  data,
  deps,
  requestId,
  dbMarketId,
  conditionalTokensAddress,
  conditionId,
  tokenId,
  onChainMarketId,
  reserveExpiry,
  market,
  marketIsDark,
  matchResult,
  tradeDbRows,
  broadcastQuote,
}: ScheduleOrderSettlementParams): void {
  let tradesMarkedFailed = false;
  let rollbackHandled = false;

  const handleSettlementFailure = async (rawError: string): Promise<void> => {
    const failure = rawError || "Settlement failed";
    const friendlyError = sanitizeSettlementError(failure);

    if (!tradesMarkedFailed) {
      tradesFailed.inc(tradeDbRows.length);
      for (const { dbId, trade } of tradeDbRows) {
        await deps.db.markTradeFailed(dbId, failure);
        logger.warn(
          {
            requestId,
            tradeId: dbId,
            error: friendlyError,
            buyer: trade.buyer,
            seller: trade.seller,
          },
          "trade settlement failed",
        );
        deps.ws.broadcast(`trades:${data.marketId}`, marketIsDark
          ? { type: "trade_failed", tradeId: dbId, error: friendlyError }
          : {
              type: "trade_failed",
              tradeId: dbId,
              error: friendlyError,
              buyer: trade.buyer,
              seller: trade.seller,
            });
      }
      tradesMarkedFailed = true;
    }

    if (rollbackHandled) return;
    rollbackHandled = true;

    const rollbackVolume = tradeDbRows.reduce((sum, row) => {
      const fillAmountBig = BigInt(row.trade.fillAmount);
      const priceBig = scalePriceStr(row.trade.price);
      return sum + (fillAmountBig * priceBig) / BigInt(1e18);
    }, 0n);
    if (rollbackVolume > 0n) {
      await deps.db.updateMarketVolume(dbMarketId, `-${rollbackVolume.toString()}`);
    }

    await deps.db.updateOrderStatus(data.nonce, "CANCELLED", "0");

    // Notify the frontend that this order was rolled back so it can
    // remove it from the "open orders" list immediately.
    deps.ws.broadcast(`trades:${data.marketId}`, {
      type: "order_cancelled",
      nonce: data.nonce,
      reason: "settlement_failed",
    });

    try {
      await deps.matcher.withLock(dbMarketId, data.outcomeIndex, async () => {
        if (matchResult.restedOrder) {
          await deps.orderBook.removeOrder(matchResult.restedOrder);
          if (data.side === "BID") {
            await deps.db.deleteOrderReservation(data.nonce);
          } else {
            await deps.db.deleteOutcomeOrderReservation(data.nonce);
          }
        }

        for (const consumed of matchResult.consumedOrders) {
          if (consumed.newRemaining !== null) {
            await deps.orderBook.removeOrder({
              ...consumed.original,
              remainingAmount: consumed.newRemaining,
            });
          }
          await deps.orderBook.addOrder(consumed.original);

          const originalRemaining = BigInt(consumed.original.remainingAmount);
          const originalFilled =
            BigInt(consumed.original.amount) - originalRemaining;
          const originalStatus: "OPEN" | "PARTIALLY_FILLED" | "FILLED" =
            originalRemaining === 0n
              ? "FILLED"
              : originalFilled > 0n
                ? "PARTIALLY_FILLED"
                : "OPEN";

          await deps.db.updateOrderStatus(
            consumed.original.nonce,
            originalStatus,
            originalFilled.toString(),
          );

          if (consumed.original.side === "BID") {
            await deps.db.deleteOrderReservation(consumed.original.nonce);
            if (originalRemaining > 0n) {
              await deps.db.insertOrderReservation(
                consumed.original.nonce,
                consumed.original.user,
                market.collateral_token,
                computeBidReservation(originalRemaining, consumed.original.price).toString(),
              );
            }
          } else {
            await deps.db.deleteOutcomeOrderReservation(consumed.original.nonce);
            if (originalRemaining > 0n) {
              await deps.db.insertOutcomeOrderReservation(
                consumed.original.nonce,
                consumed.original.user,
                consumed.original.marketId,
                consumed.original.outcomeIndex,
                tokenId,
                originalRemaining.toString(),
              );
            }
          }
        }

        if (matchResult.preMatchAmmState) {
          await deps.ammState.saveState(
            matchResult.preMatchAmmState as Parameters<typeof deps.ammState.saveState>[0],
          );
        }
      });
    } catch (error) {
      logger.error(
        { err: error, nonce: data.nonce },
        "rollback lock failed — order already cancelled",
      );
    }

    for (let index = 0; index < market.outcome_count; index++) {
      await broadcastQuote({
        channelMarketId: data.marketId,
        bookMarketId: dbMarketId,
        outcomeIndex: index,
        isDark: marketIsDark,
      });
    }
  };

  void (async () => {
    if (tradeDbRows.length === 0) return;

    const ammRows = tradeDbRows.filter((row) => row.trade.needsAutoSplit !== undefined);
    const clobRows = tradeDbRows.filter((row) => row.trade.needsAutoSplit === undefined);

    const markSettled = async (
      rows: typeof tradeDbRows,
      txHash: string,
    ) => {
      await Promise.all(rows.map(({ dbId }) => deps.db.markTradeSettled(dbId, txHash)));
      tradesSettled.inc(rows.length);
      for (const { dbId, trade } of rows) {
        logger.info(
          {
            requestId,
            tradeId: dbId,
            txHash,
            buyer: trade.buyer,
            seller: trade.seller,
            price: trade.price,
            fillAmount: trade.fillAmount,
          },
          "trade settled on-chain",
        );
        deps.ws.broadcast(`trades:${data.marketId}`, marketIsDark
          ? { type: "trade_settled", tradeId: dbId }
          : {
              type: "trade_settled",
              tradeId: dbId,
              txHash,
              buyer: trade.buyer,
              seller: trade.seller,
            });
      }
    };

    try {
      if (clobRows.length > 0) {
        if (marketIsDark) {
          const tradeTokenId = computeTokenId(conditionId, data.outcomeIndex);
          const darkTrades = clobRows.map(({ trade }) => {
            const makerHash = computeOrderHash(
              {
                trader: trade.makerOrder.trader,
                marketId: BigInt(onChainMarketId),
                tokenId: tradeTokenId,
                nonce: BigInt(trade.makerOrder.nonce),
                isBuy: trade.makerOrder.isBuy,
                price: scalePriceShared(trade.makerOrder.price),
                amount: BigInt(trade.makerOrder.amount),
                expiry: BigInt(trade.makerOrder.expiry),
              },
              deps.settler.exchangeAddr,
              constants.StarknetChainId.SN_SEPOLIA,
            );
            const takerHash = computeOrderHash(
              {
                trader: trade.takerOrder.trader,
                marketId: BigInt(onChainMarketId),
                tokenId: tradeTokenId,
                nonce: BigInt(trade.takerOrder.nonce),
                isBuy: trade.takerOrder.isBuy,
                price: scalePriceShared(trade.takerOrder.price),
                amount: BigInt(trade.takerOrder.amount),
                expiry: BigInt(trade.takerOrder.expiry),
              },
              deps.settler.exchangeAddr,
              constants.StarknetChainId.SN_SEPOLIA,
            );
            const tradeCommitment = computeTradeCommitment(
              makerHash,
              takerHash,
              BigInt(trade.fillAmount),
            );
            return { trade, tradeCommitment };
          });

          const result = await deps.settler.settleDarkTradesAtomic(
            darkTrades,
            market.collateral_token,
            tokenId,
            onChainMarketId,
            reserveExpiry,
          );
          if (!result.success) {
            await handleSettlementFailure(result.error ?? "Dark settlement failed");
            return;
          }
          await markSettled(clobRows, result.txHash);
        } else {
          const result = await deps.settler.settleTradesAtomic(
            clobRows.map((row) => row.trade),
            market.collateral_token,
            tokenId,
            onChainMarketId,
            reserveExpiry,
          );
          if (!result.success) {
            await handleSettlementFailure(result.error ?? "Settlement failed");
            return;
          }
          await markSettled(clobRows, result.txHash);
        }
      }

      let ammRolledBackFill = 0n;
      const rollbackAmmTrade = async (failedTrade: typeof ammRows[0]) => {
        const fillBig = BigInt(failedTrade.trade.fillAmount);
        const priceBig = scalePriceStr(failedTrade.trade.price);
        const volume = (fillBig * priceBig) / BigInt(1e18);
        if (volume > 0n) {
          await deps.db.updateMarketVolume(dbMarketId, `-${volume.toString()}`);
        }
        if (matchResult.postClobAmmState) {
          await deps.matcher.withLock(dbMarketId, data.outcomeIndex, async () => {
            await deps.ammState.saveState(
              matchResult.postClobAmmState as Parameters<typeof deps.ammState.saveState>[0],
            );
          });
        }
        ammRolledBackFill += fillBig;
      };

      for (const { dbId, trade } of ammRows) {
        const lockKey = `amm-split:${conditionId}`;
        let lockToken: string | null = null;
        try {
          if (deps.redis) {
            lockToken = await deps.redis.acquireLockWithRetry(lockKey, 60, 15_000, 100);
            if (!lockToken) {
              await deps.db.markTradeFailed(dbId, "AMM settlement lock timeout");
              tradesFailed.inc();
              await rollbackAmmTrade({ dbId, trade });
              deps.ws.broadcast(`trades:${data.marketId}`, marketIsDark
                ? { type: "trade_failed", tradeId: dbId, error: "AMM settlement lock timeout" }
                : {
                    type: "trade_failed",
                    tradeId: dbId,
                    error: "AMM settlement lock timeout",
                    buyer: trade.buyer,
                    seller: trade.seller,
                  });
              continue;
            }
          }

          const adminAddr = deps.settler.adminAddr;
          const [adminOutcomeBalance, adminWalletBalance, adminExchangeBalance] =
            await Promise.all([
              deps.balanceChecker.checkErc1155Balance(
                conditionalTokensAddress,
                adminAddr,
                tokenId,
              ).catch(() => 0n),
              deps.balanceChecker.checkWalletBalance(adminAddr, market.collateral_token),
              deps.balanceChecker.checkBalance(adminAddr, market.collateral_token).catch(() => 0n),
            ]);

          const result = await deps.settler.settleAmmTradeAtomic({
            trade,
            collateralToken: market.collateral_token,
            tokenId,
            onChainMarketId,
            reserveExpiry,
            conditionId,
            adminOutcomeBalance,
            adminWalletBalance,
            adminExchangeBalance,
          });

          if (!result.success) {
            await deps.db.markTradeFailed(dbId, result.error ?? "AMM settlement failed");
            tradesFailed.inc();
            await rollbackAmmTrade({ dbId, trade });
            deps.ws.broadcast(`trades:${data.marketId}`, marketIsDark
              ? { type: "trade_failed", tradeId: dbId, error: result.error ?? "AMM settlement failed" }
              : {
                  type: "trade_failed",
                  tradeId: dbId,
                  error: result.error ?? "AMM settlement failed",
                  buyer: trade.buyer,
                  seller: trade.seller,
                });
            continue;
          }

          await markSettled([{ dbId, trade }], result.txHash);
          await Promise.all([
            deps.balanceChecker.invalidateCache(adminAddr, market.collateral_token),
            deps.redis?.del(`erc1155_bal:${conditionalTokensAddress}:${adminAddr}:${tokenId}`),
          ]);
        } finally {
          if (lockToken && deps.redis) {
            await deps.redis.releaseLock(lockKey, lockToken);
          }
        }
      }

      if (ammRolledBackFill > 0n) {
        const originalFilled = BigInt(data.amount) - matchResult.remainingAmount;
        const correctedFilled = originalFilled - ammRolledBackFill;
        const correctedRemaining = matchResult.remainingAmount + ammRolledBackFill;
        const correctedStatus =
          data.orderType === "MARKET"
            ? correctedFilled > 0n
              ? "PARTIALLY_FILLED"
              : "CANCELLED"
            : correctedFilled <= 0n
              ? "OPEN"
              : correctedFilled < BigInt(data.amount)
                ? "PARTIALLY_FILLED"
                : "FILLED";
        try {
          await deps.db.updateOrderStatus(
            data.nonce,
            correctedStatus as "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED",
            (correctedFilled > 0n ? correctedFilled : 0n).toString(),
          );
          if (correctedStatus === "CANCELLED") {
            deps.ws.broadcast(`trades:${data.marketId}`, {
              type: "order_cancelled",
              nonce: data.nonce,
              reason: "settlement_failed",
            });
            await deps.db.deleteOrderReservation(data.nonce);
            await deps.db.deleteOutcomeOrderReservation(data.nonce);
          }
          if (data.orderType === "LIMIT" && correctedRemaining > 0n) {
            const existing = await deps.orderBook.findOrderByNonce(
              dbMarketId,
              data.outcomeIndex,
              data.nonce,
            );
            if (existing) await deps.orderBook.removeOrder(existing);
            await deps.orderBook.addOrder({
              user: data.user,
              marketId: dbMarketId,
              outcomeIndex: data.outcomeIndex,
              side: data.side,
              orderType: "LIMIT",
              price: data.price,
              amount: data.amount,
              remainingAmount: correctedRemaining.toString(),
              nonce: data.nonce,
              expiry: data.expiry,
              signature: data.signature,
              createdAt: new Date().toISOString(),
            });
            if (data.side === "BID") {
              await deps.db.deleteOrderReservation(data.nonce);
              await deps.db.insertOrderReservation(
                data.nonce,
                data.user,
                market.collateral_token,
                computeBidReservation(correctedRemaining, data.price).toString(),
              );
            } else {
              await deps.db.deleteOutcomeOrderReservation(data.nonce);
              await deps.db.insertOutcomeOrderReservation(
                data.nonce,
                data.user,
                dbMarketId,
                data.outcomeIndex,
                tokenId,
                correctedRemaining.toString(),
              );
            }
          }
        } catch (error) {
          console.error(
            "[rest] failed to correct taker order after AMM rollback:",
            error instanceof Error ? error.message : error,
          );
        }
      }
    } catch (error) {
      try {
        await handleSettlementFailure(error instanceof Error ? error.message : String(error));
      } catch (rollbackError) {
        console.error(
          "[rest] rollback failed after unexpected settlement error:",
          rollbackError instanceof Error ? rollbackError.message : rollbackError,
        );
      }
    }
  })();
}
