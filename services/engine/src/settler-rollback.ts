import type { Trade } from "./matcher.js";
import type { SettlementResult } from "./settler.js";

export async function settleOrRollback(
  trade: Trade,
  collateralToken: string,
  buyerReservedAmount: string,
  sellerReservedAmount: string,
  settleTrade: () => Promise<SettlementResult>,
  releaseBalance: (
    user: string,
    token: string,
    amount: string,
  ) => Promise<{ success: boolean; txHash: string; error?: string }>,
): Promise<SettlementResult> {
  const result = await settleTrade();

  if (!result.success) {
    console.warn(`[settler] rolling back reservations for failed trade ${trade.id}`);

    const releases = await Promise.allSettled([
      releaseBalance(trade.buyer, collateralToken, buyerReservedAmount),
      releaseBalance(trade.seller, collateralToken, sellerReservedAmount),
    ]);

    for (const [index, release] of releases.entries()) {
      const user = index === 0 ? trade.buyer : trade.seller;
      if (release.status === "rejected") {
        console.error(
          `[settler] CRITICAL: releaseBalance threw for ${user} on trade ${trade.id}:`,
          release.reason,
        );
      } else if (!release.value.success) {
        console.error(
          `[settler] CRITICAL: releaseBalance failed for ${user} on trade ${trade.id}: ${release.value.error}`,
        );
      }
    }
  }

  return result;
}
