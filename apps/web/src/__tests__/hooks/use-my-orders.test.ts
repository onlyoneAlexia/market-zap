import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.fn();
const useWalletMock = vi.fn();
const visibleRefetchIntervalMock = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: unknown) => useQueryMock(options),
}));

vi.mock("@/features/wallet/use-wallet", () => ({
  useWallet: () => useWalletMock(),
}));

vi.mock("@/lib/polling", () => ({
  visibleRefetchInterval: (intervalMs: number) =>
    visibleRefetchIntervalMock(intervalMs),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getOpenOrders: vi.fn(),
  },
}));

import { useMyOrders } from "@/hooks/use-my-orders";

describe("useMyOrders", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useWalletMock.mockReset();
    visibleRefetchIntervalMock.mockReset();

    useWalletMock.mockReturnValue({
      address: "0xabc",
      isConnected: true,
    });

    useQueryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    });
  });

  it("uses visibility-aware polling for open orders", () => {
    useMyOrders("market-1");

    expect(useQueryMock).toHaveBeenCalledTimes(1);

    const options = useQueryMock.mock.calls[0][0] as {
      refetchInterval: () => number | false;
    };

    visibleRefetchIntervalMock.mockReturnValue(15_000);
    expect(options.refetchInterval()).toBe(15_000);
    expect(visibleRefetchIntervalMock).toHaveBeenCalledWith(15_000);
  });
});
