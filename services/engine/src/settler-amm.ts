import { Contract, type Account, type Call, type RpcProvider } from "starknet";
import { ConditionalTokensABI, ERC20ABI, getContractAddress } from "@market-zap/shared";
import type { Trade } from "./matcher.js";
import type { SettlementResult } from "./settler.js";
import {
  buildCairoOrder,
  getExecutionStatus,
  getRevertReason,
  parseSignature,
  scalePrice,
} from "./settler-helpers.js";

export interface SettleAmmTradeAtomicParams {
  trade: Trade;
  collateralToken: string;
  tokenId: string;
  onChainMarketId: string;
  reserveExpiry: number;
  conditionId: string;
  adminOutcomeBalance: bigint;
  adminWalletBalance: bigint;
  adminExchangeBalance: bigint;
}

export interface SettleAmmTradeContext {
  account: Account;
  adminAddress: string;
  conditionalTokensAddress: string;
  exchange: Contract;
  provider: RpcProvider;
  withRetry<T>(
    fn: () => Promise<T>,
    options?: { retries?: number; baseDelayMs?: number; label?: string },
  ): Promise<T>;
}

export async function settleAmmTradeAtomic(
  context: SettleAmmTradeContext,
  params: SettleAmmTradeAtomicParams,
): Promise<SettlementResult> {
  const {
    trade,
    collateralToken,
    tokenId,
    onChainMarketId,
    reserveExpiry,
    conditionId,
    adminOutcomeBalance,
    adminWalletBalance,
    adminExchangeBalance,
  } = params;

  try {
    const fillAmount = BigInt(trade.fillAmount);
    if (fillAmount <= 0n) {
      return {
        tradeId: trade.id,
        txHash: "",
        success: false,
        error: "fillAmount must be > 0",
      };
    }

    const executionPrice = scalePrice(trade.price);
    const cost = (fillAmount * executionPrice) / BigInt(1e18);
    const takerFee = (cost * 100n) / 10000n;
    const reserveAmount = trade.makerOrder.isBuy ? cost : cost + takerFee;

    if (reserveAmount <= 0n) {
      return {
        tradeId: trade.id,
        txHash: "",
        success: false,
        error: "reserveAmount must be > 0 (price too low for amount)",
      };
    }

    const adminIsSeller = trade.seller === context.adminAddress;
    const needsSplit = adminIsSeller && adminOutcomeBalance < fillAmount;
    let splitAmount = 0n;

    if (needsSplit) {
      splitAmount = (fillAmount - adminOutcomeBalance) * 2n;

      const totalUsdcAvailable = adminWalletBalance + adminExchangeBalance;
      if (totalUsdcAvailable < splitAmount) {
        splitAmount = fillAmount - adminOutcomeBalance;
        if (totalUsdcAvailable < splitAmount) {
          return {
            tradeId: trade.id,
            txHash: "",
            success: false,
            error: `Insufficient admin solvency: need ${splitAmount} USDC for split, have ${totalUsdcAvailable} total`,
          };
        }
      }

      console.log(
        `[settler] auto-split: need ${fillAmount} tokens, have ${adminOutcomeBalance}, splitting ${splitAmount}`,
      );
    }

    const makerOrder = buildCairoOrder(trade.makerOrder, onChainMarketId, tokenId);
    const takerOrder = buildCairoOrder(trade.takerOrder, onChainMarketId, tokenId);
    const [makerSigR, makerSigS] = parseSignature(trade.makerOrder.signature);
    const [takerSigR, takerSigS] = parseSignature(trade.takerOrder.signature);

    const reserveNonce =
      BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
    const calls: Call[] = [];

    calls.push(
      context.exchange.populate("reserve_balance", [
        trade.buyer,
        collateralToken,
        reserveAmount,
        reserveNonce,
        reserveExpiry,
      ]),
    );

    if (needsSplit && splitAmount > 0n) {
      const conditionalTokens = new Contract({
        abi: ConditionalTokensABI as unknown as Contract["abi"],
        address: context.conditionalTokensAddress,
        providerOrAccount: context.account,
      });
      const erc20 = new Contract({
        abi: ERC20ABI as unknown as Contract["abi"],
        address: collateralToken,
        providerOrAccount: context.account,
      });
      const vaultAddress = getContractAddress("CollateralVault", "sepolia");

      if (adminWalletBalance < splitAmount) {
        const withdrawAmount = splitAmount - adminWalletBalance;
        calls.push(
          context.exchange.populate("withdraw", [collateralToken, withdrawAmount]),
        );
      }

      calls.push(erc20.populate("approve", [vaultAddress, splitAmount]));
      calls.push(
        conditionalTokens.populate("split_position", [
          collateralToken,
          conditionId,
          splitAmount,
        ]),
      );
    }

    calls.push(
      context.exchange.populate("settle_trade", [
        makerOrder,
        takerOrder,
        fillAmount,
        makerSigR,
        makerSigS,
        takerSigR,
        takerSigS,
      ]),
    );

    console.log(
      `[settler] AMM atomic settle: trade ${trade.id}, calls=${calls.length}` +
        (needsSplit ? `, auto-split=${splitAmount}` : ""),
    );

    const response = await context.withRetry(() => context.account.execute(calls), {
      label: `amm-settle ${trade.id}`,
    });

    console.log(`[settler] AMM atomic tx submitted: ${response.transaction_hash}`);

    const receipt = await context.withRetry(
      () => context.provider.waitForTransaction(response.transaction_hash),
      { label: `amm-confirm ${trade.id}` },
    );

    if (getExecutionStatus(receipt) === "REVERTED") {
      const reason = getRevertReason(receipt) ?? "unknown";
      console.error(`[settler] AMM atomic trade ${trade.id} REVERTED: ${reason}`);
      return {
        tradeId: trade.id,
        txHash: response.transaction_hash,
        success: false,
        error: `TX reverted: ${reason}`,
      };
    }

    console.log(
      `[settler] AMM atomic trade ${trade.id} confirmed` +
        (needsSplit ? ` (auto-split ${splitAmount} tokens)` : ""),
    );

    return {
      tradeId: trade.id,
      txHash: response.transaction_hash,
      success: true,
      didSplit: needsSplit,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[settler] AMM atomic settle failed for trade ${trade.id}:`, message);
    return {
      tradeId: trade.id,
      txHash: "",
      success: false,
      error: message,
    };
  }
}
