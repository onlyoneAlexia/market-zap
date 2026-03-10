const PRICE_SCALE = 10n ** 18n;
const TAKER_FEE_BPS = 100n;
const BPS_DENOMINATOR = 10_000n;

type BuyOrderType = "market" | "limit";

function scalePrice(price: string | number): bigint {
  const value = typeof price === "number" ? price.toFixed(18) : price;
  if (/^\d+$/.test(value)) {
    return BigInt(value);
  }

  const [intPart, fracPart = ""] = value.split(".");
  const padded = fracPart.padEnd(18, "0").slice(0, 18);
  return BigInt(intPart + padded);
}

function getBuyReservationPrice(
  orderType: BuyOrderType,
  effectivePrice: number,
): bigint {
  if (orderType === "market") {
    // Market buys are signed and prechecked against the 100% price bound.
    return PRICE_SCALE;
  }

  return scalePrice(effectivePrice.toString());
}

export function getRequiredBuyCollateralRaw(params: {
  amountRaw: bigint;
  orderType: BuyOrderType;
  effectivePrice: number;
}): bigint {
  const { amountRaw, orderType, effectivePrice } = params;
  if (amountRaw <= 0n) {
    return 0n;
  }

  const reservationPrice = getBuyReservationPrice(orderType, effectivePrice);
  const costRaw = (amountRaw * reservationPrice) / PRICE_SCALE;
  const takerFeeRaw = (costRaw * TAKER_FEE_BPS) / BPS_DENOMINATOR;
  return costRaw + takerFeeRaw;
}

export function getMaxBuySharesRaw(params: {
  availableRaw: bigint;
  orderType: BuyOrderType;
  effectivePrice: number;
}): bigint {
  const { availableRaw, orderType, effectivePrice } = params;
  if (availableRaw <= 0n) {
    return 0n;
  }

  const reservationPrice = getBuyReservationPrice(orderType, effectivePrice);
  let low = 0n;
  let high = (availableRaw * PRICE_SCALE) / (reservationPrice > 0n ? reservationPrice : 1n);

  if (high < availableRaw) {
    high = availableRaw;
  }

  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    const requiredRaw = getRequiredBuyCollateralRaw({
      amountRaw: mid,
      orderType,
      effectivePrice,
    });
    if (requiredRaw <= availableRaw) {
      low = mid;
    } else {
      high = mid - 1n;
    }
  }

  return low;
}
