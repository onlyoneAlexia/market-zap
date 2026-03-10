import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@market-zap/shared", () => ({
  cleanupCartridgeControllerDom: vi.fn(() => {
    if (typeof document === "undefined") return;
    document.querySelectorAll("#controller").forEach((el) => el.remove());
    document.querySelectorAll('[id^="controller-"]').forEach((el) => el.remove());
    document.querySelectorAll("#controller-viewport").forEach((el) => el.remove());
    document.body.style.overflow = "auto";
  }),
  getMarketZapCartridgeConnectOptions: vi.fn(
    (_network: string, overrides?: Record<string, unknown>) => ({
      policies: [{ target: "0xexchange", method: "deposit" }],
      ...overrides,
    }),
  ),
}));

import {
  connectCartridgeDeduped,
  resetCartridgeClient,
} from "@/features/wallet/wallet-client";

function seedStaleControllerDom(): void {
  const viewport = document.createElement("meta");
  viewport.id = "controller-viewport";
  document.head.appendChild(viewport);

  const container = document.createElement("div");
  container.id = "controller";

  const iframe = document.createElement("iframe");
  iframe.id = "controller-keychain";
  container.appendChild(iframe);

  document.body.appendChild(container);
  document.body.style.overflow = "hidden";
}

describe("use-wallet-reconnect", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    document.body.style.overflow = "";
    resetCartridgeClient();
  });

  afterEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    document.body.style.overflow = "";
    resetCartridgeClient();
  });

  it("cleans stale Cartridge controller DOM before starting a new connection", async () => {
    seedStaleControllerDom();

    const client = {
      connectCartridge: vi.fn(async (options?: Record<string, unknown>) => {
        expect(document.getElementById("controller")).toBeNull();
        expect(document.getElementById("controller-viewport")).toBeNull();
        expect(document.body.style.overflow).toBe("auto");
        expect(options).toEqual(
          expect.objectContaining({
            policies: [
              expect.objectContaining({ method: "deposit" }),
            ],
          }),
        );
        expect(options).not.toHaveProperty("mode");
        expect(options).not.toHaveProperty("session");
        return { connected: true, address: "0x123" };
      }),
    } as any;

    await expect(connectCartridgeDeduped(client)).resolves.toEqual({
      connected: true,
      address: "0x123",
    });
    expect(client.connectCartridge).toHaveBeenCalledTimes(1);
  });
});
