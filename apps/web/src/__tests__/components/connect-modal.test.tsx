import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectModal } from "@/components/wallet/connect-modal";
import { useAppStore } from "@/hooks/use-store";

vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock("@/features/wallet/use-wallet", () => ({
  useWallet: () => ({
    connectBrowserWallet: vi.fn(),
    connectCartridge: vi.fn(),
    isConnecting: true,
    walletConnectionStatus: useAppStore.getState().walletConnectionStatus,
  }),
}));

vi.mock("@/features/wallet/wallet-client", () => ({
  warmCartridgeClient: vi.fn(),
}));

describe("ConnectModal progress UI", () => {
  beforeEach(() => {
    useAppStore.setState({
      connectModalOpen: true,
      walletConnectionStatus: {
        provider: "cartridge",
        phase: "opening_wallet",
        message: "Opening Cartridge controller",
        isSlow: false,
      },
    });
  });

  it("renders the active wallet progress message", () => {
    render(<ConnectModal />);

    expect(screen.getByText("Opening Cartridge controller")).toBeTruthy();
    expect(screen.getAllByText("Social Login").length).toBeGreaterThan(0);
  });

  it("shows a slow-path hint when the wallet flow is taking longer than expected", () => {
    useAppStore.setState({
      walletConnectionStatus: {
        provider: "cartridge",
        phase: "retrying",
        message: "Retrying Cartridge controller load",
        isSlow: true,
      },
    });

    render(<ConnectModal />);

    expect(
      screen.getByText(/This can happen on the first Cartridge load/i),
    ).toBeTruthy();
  });
});
