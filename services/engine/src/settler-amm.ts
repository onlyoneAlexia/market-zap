import { Contract, type Account, type Call, type RpcProvider, constants } from "starknet";
import { ConditionalTokensABI, ERC20ABI, getContractAddress, computeOrderHash } from "@market-zap/shared";
import type { Trade } from "./matcher.js";
import type { SettlementResult } from "./settler.js";
import {
  buildCairoOrder,
  getFinalityStatus,
  getExecutionStatus,
  getRevertReason,
  parseSignature,
  scalePrice,
} from "./settler-helpers.js";
import { executeCallsWithAdaptiveL2Gas } from "./settler-execution.js";

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
    const makerSig = parseSignature(trade.makerOrder.signature);
    const takerSig = parseSignature(trade.takerOrder.signature);

    // Diagnostic: log exact params for debugging INVALID_SIG
    console.log(`[settler-diag] trade=${trade.id}`);
    console.log(`[settler-diag] taker trader=${takerOrder.trader}`);
    console.log(`[settler-diag] taker market_id=${takerOrder.market_id}`);
    console.log(`[settler-diag] taker token_id=${takerOrder.token_id}`);
    console.log(`[settler-diag] taker is_buy=${takerOrder.is_buy}`);
    console.log(`[settler-diag] taker price=${takerOrder.price} (raw="${trade.takerOrder.price}")`);
    console.log(`[settler-diag] taker amount=${takerOrder.amount} (raw="${trade.takerOrder.amount}")`);
    console.log(`[settler-diag] taker nonce=${takerOrder.nonce} (raw="${trade.takerOrder.nonce}")`);
    console.log(`[settler-diag] taker expiry=${takerOrder.expiry} (raw="${trade.takerOrder.expiry}")`);
    console.log(`[settler-diag] taker sig=${trade.takerOrder.signature}`);
    console.log(`[settler-diag] maker trader=${makerOrder.trader}`);
    console.log(`[settler-diag] maker price=${makerOrder.price} (raw="${trade.makerOrder.price}")`);
    console.log(`[settler-diag] maker sig=${trade.makerOrder.signature}`);
    console.log(`[settler-diag] fillAmount=${fillAmount}`);
    // Recompute taker hash to compare with on-chain
    try {
      const takerHash = computeOrderHash(
        {
          trader: trade.takerOrder.trader,
          marketId: BigInt(onChainMarketId),
          tokenId: BigInt(tokenId),
          isBuy: trade.takerOrder.isBuy,
          price: scalePrice(trade.takerOrder.price),
          amount: BigInt(trade.takerOrder.amount),
          nonce: BigInt(trade.takerOrder.nonce),
          expiry: BigInt(trade.takerOrder.expiry),
        },
        context.exchange.address,
        constants.StarknetChainId.SN_SEPOLIA,
      );
      console.log(`[settler-diag] taker computed hash=${takerHash}`);
    } catch (e: unknown) {
      console.log(`[settler-diag] hash computation error: ${e instanceof Error ? e.message : e}`);
    }

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
        BigInt(onChainMarketId),
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
      // Ensure the exchange can transfer admin's freshly minted outcome tokens
      // during settle_trade → safe_transfer_from. This is idempotent (no-op if
      // already approved) and required when setupSeedLiquidity was never called.
      calls.push(
        conditionalTokens.populate("set_approval_for_all", [
          context.exchange.address,
          true,
        ]),
      );
    }

    calls.push(
      context.exchange.populate("settle_trade", [
        makerOrder,
        takerOrder,
        fillAmount,
        makerSig,
        takerSig,
      ]),
    );

    console.log(
      `[settler] AMM atomic settle: trade ${trade.id}, calls=${calls.length}` +
        (needsSplit ? `, auto-split=${splitAmount}` : ""),
    );

    const { response, receipt } = await executeCallsWithAdaptiveL2Gas(
      context,
      calls,
      `amm-settle ${trade.id}`,
    );

    console.log(`[settler] AMM atomic tx submitted: ${response.transaction_hash}`);

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

    if (getFinalityStatus(receipt) === "REJECTED") {
      return {
        tradeId: trade.id,
        txHash: response.transaction_hash,
        success: false,
        error: "TX rejected by network",
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
