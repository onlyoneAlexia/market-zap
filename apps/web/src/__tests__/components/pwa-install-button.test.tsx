import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PwaInstallButton } from "@/components/layout/pwa-install-button";

const installMock = vi.fn();
const usePwaInstallMock = vi.fn();

vi.mock("@/components/layout/pwa-provider", () => ({
  usePwaInstall: () => usePwaInstallMock(),
}));

describe("PwaInstallButton", () => {
  it("does not render when install is unavailable", () => {
    usePwaInstallMock.mockReturnValue({
      isInstallAvailable: false,
      isInstalled: false,
      install: installMock,
    });

    const { container } = render(<PwaInstallButton />);

    expect(container.firstChild).toBeNull();
  });

  it("renders and triggers install when available", () => {
    usePwaInstallMock.mockReturnValue({
      isInstallAvailable: true,
      isInstalled: false,
      install: installMock,
    });

    render(<PwaInstallButton />);
    fireEvent.click(screen.getByRole("button", { name: /install app/i }));

    expect(installMock).toHaveBeenCalledTimes(1);
  });
});
