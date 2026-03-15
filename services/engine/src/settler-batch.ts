import type { Account, Contract, RpcProvider, Call } from "starknet";
import type { Trade } from "./matcher.js";
import type { SettlementResult } from "./settler.js";
import {
  buildCairoOrder,
  getExecutionStatus,
  getFinalityStatus,
  getRevertReason,
  parseSignature,
  scalePrice,
} from "./settler-helpers.js";

export interface BatchSettlementContext {
  account: Account;
  exchange: Contract;
  provider: RpcProvider;
  withRetry<T>(
    fn: () => Promise<T>,
    options?: { retries?: number; baseDelayMs?: number; label?: string },
  ): Promise<T>;
}

export interface BatchSettlementResult {
  success: boolean;
  txHash: string;
  error?: string;
}

export async function registerDarkMarket(
  context: BatchSettlementContext,
  onChainMarketId: string,
): Promise<SettlementResult> {
  try {
    const response = await context.withRetry(
      () =>
        context.account.execute(
          context.exchange.populate("register_dark_market", [BigInt(onChainMarketId)]),
        ),
      { label: `register_dark ${onChainMarketId}` },
    );
    const receipt = await context.provider.waitForTransaction(response.transaction_hash);
    if (getExecutionStatus(receipt) === "REVERTED") {
      const reason = getRevertReason(receipt) ?? "unknown";
      console.error(`[settler] register_dark_market REVERTED: ${reason}`);
      return {
        tradeId: "",
        txHash: response.transaction_hash,
        success: false,
        error: `TX reverted: ${reason}`,
      };
    }
    if (getFinalityStatus(receipt) === "REJECTED") {
      return {
        tradeId: "",
        txHash: response.transaction_hash,
        success: false,
        error: "TX rejected by network",
      };
    }
    return { tradeId: "", txHash: response.transaction_hash, success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { tradeId: "", txHash: "", success: false, error: message };
  }
}

export async function settleTradesAtomic(
  context: BatchSettlementContext,
  trades: Trade[],
  collateralToken: string,
  tokenId: string,
  onChainMarketId: string,
  reserveExpiry: number,
): Promise<BatchSettlementResult> {
  if (trades.length === 0) {
    return { success: true, txHash: "" };
  }

  try {
    const reserveByBuyer = new Map<string, bigint>();

    for (const trade of trades) {
      const fillAmount = BigInt(trade.fillAmount);
      const executionPrice = scalePrice(trade.price);
      const cost = (fillAmount * executionPrice) / BigInt(1e18);
      const takerFee = (cost * 100n) / 10000n;
      const reserveAmount = trade.makerOrder.isBuy ? cost : cost + takerFee;
      reserveByBuyer.set(
        trade.buyer,
        (reserveByBuyer.get(trade.buyer) ?? 0n) + reserveAmount,
      );
    }

    const calls: Call[] = [];

    let reserveIndex = 0;
    for (const [buyer, amount] of reserveByBuyer) {
      if (amount === 0n) continue;
      const reserveNonce = BigInt(Date.now()) * 1000n + BigInt(reserveIndex++);
      calls.push(
        context.exchange.populate("reserve_balance", [
          buyer,
          collateralToken,
          amount,
          reserveNonce,
          reserveExpiry,
          BigInt(onChainMarketId),
        ]),
      );
    }

    for (const trade of trades) {
      const makerOrder = buildCairoOrder(trade.makerOrder, onChainMarketId, tokenId);
      const takerOrder = buildCairoOrder(trade.takerOrder, onChainMarketId, tokenId);
      const makerSig = parseSignature(trade.makerOrder.signature);
      const takerSig = parseSignature(trade.takerOrder.signature);

      calls.push(
        context.exchange.populate("settle_trade", [
          makerOrder,
          takerOrder,
          BigInt(trade.fillAmount),
          makerSig,
          takerSig,
        ]),
      );
    }

    const response = await context.withRetry(() => context.account.execute(calls), {
      label: `batch settle (${trades.length} trades)`,
    });

    const receipt = await context.withRetry(
      () => context.provider.waitForTransaction(response.transaction_hash),
      { label: "batch confirm" },
    );

    if (getExecutionStatus(receipt) === "REVERTED") {
      const reason = getRevertReason(receipt) ?? "unknown";
      return {
        success: false,
        txHash: response.transaction_hash,
        error: `TX reverted: ${reason}`,
      };
    }

    if (getFinalityStatus(receipt) === "REJECTED") {
      return {
        success: false,
        txHash: response.transaction_hash,
        error: "TX rejected by network",
      };
    }

    return { success: true, txHash: response.transaction_hash };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, txHash: "", error: message };
  }
}

export async function settleDarkTradesAtomic(
  context: BatchSettlementContext,
  trades: Array<{ trade: Trade; tradeCommitment: string }>,
  collateralToken: string,
  tokenId: string,
  onChainMarketId: string,
  reserveExpiry: number,
): Promise<BatchSettlementResult> {
  if (trades.length === 0) {
    return { success: true, txHash: "" };
  }

  try {
    const reserveByBuyer = new Map<string, bigint>();

    for (const { trade } of trades) {
      const fillAmount = BigInt(trade.fillAmount);
      const executionPrice = scalePrice(trade.price);
      const cost = (fillAmount * executionPrice) / BigInt(1e18);
      const takerFee = (cost * 100n) / 10000n;
      const reserveAmount = trade.makerOrder.isBuy ? cost : cost + takerFee;
      reserveByBuyer.set(
        trade.buyer,
        (reserveByBuyer.get(trade.buyer) ?? 0n) + reserveAmount,
      );
    }

    const calls: Call[] = [];

    let reserveIndex = 0;
    for (const [buyer, amount] of reserveByBuyer) {
      if (amount === 0n) continue;
      const reserveNonce = BigInt(Date.now()) * 1000n + BigInt(reserveIndex++);
      calls.push(
        context.exchange.populate("reserve_balance", [
          buyer,
          collateralToken,
          amount,
          reserveNonce,
          reserveExpiry,
          BigInt(onChainMarketId),
        ]),
      );
    }

    for (const { trade, tradeCommitment } of trades) {
      const fillAmount = BigInt(trade.fillAmount);
      const executionPrice = scalePrice(trade.price);
      const buyer = trade.makerOrder.isBuy
        ? trade.makerOrder.trader
        : trade.takerOrder.trader;
      const seller = trade.makerOrder.isBuy
        ? trade.takerOrder.trader
        : trade.makerOrder.trader;

      calls.push(
        context.exchange.populate("settle_dark_trade", [
          BigInt(onChainMarketId),
          BigInt(tokenId),
          fillAmount,
          executionPrice,
          buyer,
          seller,
          trade.makerOrder.isBuy,
          tradeCommitment,
        ]),
      );
    }

    const response = await context.withRetry(() => context.account.execute(calls), {
      label: `dark batch settle (${trades.length} trades)`,
    });

    const receipt = await context.withRetry(
      () => context.provider.waitForTransaction(response.transaction_hash),
      { label: "dark batch confirm" },
    );

    if (getExecutionStatus(receipt) === "REVERTED") {
      const reason = getRevertReason(receipt) ?? "unknown";
      return {
        success: false,
        txHash: response.transaction_hash,
        error: `TX reverted: ${reason}`,
      };
    }

    if (getFinalityStatus(receipt) === "REJECTED") {
      return {
        success: false,
        txHash: response.transaction_hash,
        error: "TX rejected by network",
      };
    }

    return { success: true, txHash: response.transaction_hash };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, txHash: "", error: message };
  }
}
