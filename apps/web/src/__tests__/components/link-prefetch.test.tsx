import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Navbar } from "@/components/layout/navbar";
import { MarketCard } from "@/components/market/market-card";

const prefetchSpy = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({
    prefetch: prefetchSpy,
  }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    prefetch,
    children,
    ...props
  }: React.PropsWithChildren<{
    href: string;
    prefetch?: boolean;
  }>) => (
    <a
      href={href}
      data-prefetch={prefetch === undefined ? "default" : String(prefetch)}
      {...props}
    >
      {children}
    </a>
  ),
}));

vi.mock("framer-motion", () => ({
  motion: {
    div: ({
      children,
      whileHover: _whileHover,
      transition: _transition,
      layoutId: _layoutId,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      variants: _variants,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

vi.mock("@/hooks/use-store", () => ({
  useAppStore: (selector: (state: { wsConnected: boolean; wallet: { address: string | null } }) => unknown) =>
    selector({
      wsConnected: false,
      wallet: { address: null },
    }),
}));

vi.mock("@/components/wallet/wallet-button", () => ({
  WalletButton: () => <button type="button">Connect</button>,
}));

vi.mock("@/components/ui/theme-toggle", () => ({
  ThemeToggle: () => <button type="button">Theme</button>,
}));

vi.mock("@/hooks/use-operator", () => ({
  useIsOperator: () => false,
}));

describe("link prefetch behavior", () => {
  it("uses framework prefetch for navbar links", () => {
    render(<Navbar />);

    screen.getAllByRole("link", { name: /^Markets$/i }).forEach((link) => {
      expect(link.getAttribute("data-prefetch")).toBe("true");
    });

    screen.getAllByRole("link", { name: /^Account$/i }).forEach((link) => {
      expect(link.getAttribute("data-prefetch")).toBe("true");
    });
  });

  it("keeps eager prefetch disabled for market cards", () => {
    render(
      <MarketCard
        id="market-1"
        question="Will Starknet fees stay low this week?"
        category="crypto"
        outcomes={["Yes", "No"]}
        prices={[0.54, 0.46]}
        volume="$10.0K"
        endsAt={Math.floor(Date.now() / 1000) + 3600}
        traders={120}
      />,
    );

    expect(
      screen
        .getByRole("link", {
          name: /Will Starknet fees stay low this week\?/i,
        })
        .getAttribute("data-prefetch"),
    ).toBe("false");
  });

  it("warms market detail routes on hover intent", () => {
    render(
      <MarketCard
        id="market-1"
        question="Will Starknet fees stay low this week?"
        category="crypto"
        outcomes={["Yes", "No"]}
        prices={[0.54, 0.46]}
        volume="$10.0K"
        endsAt={Math.floor(Date.now() / 1000) + 3600}
        traders={120}
      />,
    );

    fireEvent.mouseEnter(
      screen.getByRole("link", {
        name: /Will Starknet fees stay low this week\?/i,
      }),
    );

    expect(prefetchSpy).toHaveBeenCalledWith("/markets/market-1");
  });
});
