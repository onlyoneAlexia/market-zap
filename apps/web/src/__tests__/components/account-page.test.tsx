import React from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AccountPage from "@/app/account/page";

const useSearchParamsMock = vi.fn();
const useClaimableRewardsMock = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => useSearchParamsMock(),
}));

vi.mock("framer-motion", () => ({
  motion: {
    div: ({
      children,
      layoutId: _layoutId,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

vi.mock("@/components/ui/page-transition", () => ({
  PageTransition: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

vi.mock("@/components/ui/stagger-children", () => ({
  StaggerChildren: ({ children, className }: React.PropsWithChildren<{ className?: string }>) => (
    <div className={className}>{children}</div>
  ),
  StaggerItem: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

vi.mock("@/components/portfolio/positions-table", () => ({
  PositionsTable: () => <div>Positions</div>,
}));

vi.mock("@/components/portfolio/pnl-card", () => ({
  PnlCard: ({ label, value }: { label: string; value: string }) => (
    <div>
      {label}: {value}
    </div>
  ),
}));

vi.mock("@/components/portfolio/trade-history", () => ({
  TradeHistory: () => <div>History</div>,
}));

vi.mock("@/components/account/funds-tab", () => ({
  FundsTab: () => <div>Funds</div>,
}));

vi.mock("@/components/trading/my-orders", () => ({
  MyOrders: () => <div>Orders</div>,
}));

vi.mock("@/hooks/use-portfolio", () => ({
  usePortfolio: () => ({
    data: {
      totalValue: "10.00",
      totalPnl: "2.00",
      winRate: 60,
      positions: [],
    },
    isLoading: false,
  }),
  useClaimableRewards: () => useClaimableRewardsMock(),
  useClaimReward: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/features/wallet/use-wallet", () => ({
  useWallet: () => ({
    isConnected: true,
    address: "0xabc",
    openConnectModal: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({
    toast: vi.fn(),
  }),
}));

vi.mock("@market-zap/shared", () => ({
  shortenAddress: (value: string) => value,
}));

describe("AccountPage reward fetching", () => {
  beforeEach(() => {
    useClaimableRewardsMock.mockReset();
  });

  it("does not fetch claimable rewards when the rewards tab is not active", () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams("tab=positions"));

    render(<AccountPage />);

    expect(useClaimableRewardsMock).not.toHaveBeenCalled();
  });

  it("fetches claimable rewards when the rewards tab is active", () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams("tab=rewards"));
    useClaimableRewardsMock.mockReturnValue([]);

    render(<AccountPage />);

    expect(useClaimableRewardsMock).toHaveBeenCalledTimes(1);
  });
});
