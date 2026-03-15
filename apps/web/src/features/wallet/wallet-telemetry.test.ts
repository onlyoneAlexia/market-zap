import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitWalletTelemetry,
  toWalletTelemetryError,
} from "./wallet-telemetry";

describe("wallet telemetry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("posts wallet telemetry to the engine endpoint", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { accepted: true } }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    emitWalletTelemetry({
      event: "connect_started",
      provider: "cartridge",
      phase: "preparing",
    });

    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/engine-api/telemetry/wallet"),
      expect.objectContaining({
        method: "POST",
        keepalive: true,
      }),
    );
  });

  it("maps initialization failures to stable telemetry error codes", () => {
    const result = toWalletTelemetryError(
      new Error("Cartridge Controller failed to initialize"),
    );

    expect(result).toEqual({
      errorCode: "controller_init_failed",
      errorMessage: "Cartridge Controller failed to initialize",
    });
  });
});
