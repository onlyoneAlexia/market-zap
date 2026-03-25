import type { PaginatedResponse, Trade, TradeHistory } from "@market-zap/shared";

export interface TradeSettlementPatch {
  settled: boolean;
  settlementStatus: NonNullable<Trade["settlementStatus"]>;
  settlementError?: string | null;
  txHash?: string | null;
}

function patchTrade(trade: Trade, tradeId: string, patch: TradeSettlementPatch): Trade {
  if (trade.id !== tradeId) return trade;

  return {
    ...trade,
    settled: patch.settled,
    settlementStatus: patch.settlementStatus,
    settlementError:
      patch.settlementStatus === "settled"
        ? null
        : patch.settlementError ?? trade.settlementError ?? null,
    txHash: patch.txHash ?? trade.txHash,
  };
}

export function patchPaginatedTrades(
  cache: PaginatedResponse<Trade> | undefined,
  tradeId: string,
  patch: TradeSettlementPatch,
): PaginatedResponse<Trade> | undefined {
  if (!cache) return cache;

  return {
    ...cache,
    items: cache.items.map((trade) => patchTrade(trade, tradeId, patch)),
  };
}

export function patchTradeHistory(
  cache: TradeHistory | undefined,
  tradeId: string,
  patch: TradeSettlementPatch,
): TradeHistory | undefined {
  if (!cache) return cache;

  return {
    ...cache,
    trades: cache.trades.map((trade) => patchTrade(trade, tradeId, patch)),
  };
}
