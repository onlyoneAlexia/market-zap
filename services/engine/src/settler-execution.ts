import type {
  Account,
  Call,
  InvokeFunctionResponse,
  ResourceBoundsBN,
  RpcProvider,
} from "starknet";
import {
  getExecutionStatus,
  getRevertReason,
} from "./settler-helpers.js";

interface ExecuteCallsContext {
  account: Account;
  provider: RpcProvider;
  withRetry<T>(
    fn: () => Promise<T>,
    options?: { retries?: number; baseDelayMs?: number; label?: string },
  ): Promise<T>;
}

interface ExecuteCallsResult {
  response: InvokeFunctionResponse;
  receipt: unknown;
}

const INSUFFICIENT_L2_GAS_PATTERN = /insufficient max l2.?gas/i;
const BOOSTED_L2_GAS_MULTIPLIER = 2n;

function isInsufficientL2GasError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return INSUFFICIENT_L2_GAS_PATTERN.test(message);
}

function boostL2GasResourceBounds(
  resourceBounds: ResourceBoundsBN,
): ResourceBoundsBN {
  return {
    l1_gas: { ...resourceBounds.l1_gas },
    l1_data_gas: { ...resourceBounds.l1_data_gas },
    l2_gas: {
      ...resourceBounds.l2_gas,
      max_amount:
        resourceBounds.l2_gas.max_amount * BOOSTED_L2_GAS_MULTIPLIER,
    },
  };
}

async function waitForReceipt(
  context: ExecuteCallsContext,
  transactionHash: string,
  label: string,
): Promise<unknown> {
  return context.withRetry(
    () => context.provider.waitForTransaction(transactionHash),
    { label: `${label} confirm` },
  );
}

async function executeWithBounds(
  context: ExecuteCallsContext,
  calls: Call[],
  label: string,
  resourceBounds: ResourceBoundsBN,
): Promise<ExecuteCallsResult> {
  const response = await context.withRetry(
    () => context.account.execute(calls, { resourceBounds }),
    { label },
  );
  const receipt = await waitForReceipt(context, response.transaction_hash, label);
  return { response, receipt };
}

export async function executeCallsWithAdaptiveL2Gas(
  context: ExecuteCallsContext,
  calls: Call[],
  label: string,
): Promise<ExecuteCallsResult> {
  const estimate = await context.withRetry(
    () => context.account.estimateInvokeFee(calls, { skipValidate: false }),
    { label: `${label} estimate` },
  );

  try {
    const initial = await executeWithBounds(
      context,
      calls,
      label,
      estimate.resourceBounds,
    );
    const revertReason =
      getExecutionStatus(initial.receipt) === "REVERTED"
        ? getRevertReason(initial.receipt) ?? "unknown"
        : undefined;

    if (!revertReason || !isInsufficientL2GasError(revertReason)) {
      return initial;
    }

    console.warn(
      `[settler] ${label} hit L2 gas cap after submission, retrying with boosted bounds`,
    );
  } catch (error) {
    if (!isInsufficientL2GasError(error)) {
      throw error;
    }

    console.warn(
      `[settler] ${label} hit L2 gas cap before submission, retrying with boosted bounds`,
    );
  }

  return executeWithBounds(
    context,
    calls,
    `${label} retry`,
    boostL2GasResourceBounds(estimate.resourceBounds),
  );
}
