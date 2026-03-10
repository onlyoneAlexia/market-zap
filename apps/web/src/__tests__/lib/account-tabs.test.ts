import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  getInitialAccountTab,
  replaceAccountTabInCurrentUrl,
} from "@/lib/account-tabs";

describe("account tab URL helpers", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/account");
  });

  it("reads a valid initial account tab from search params", () => {
    const params = new URLSearchParams("tab=funds");

    expect(getInitialAccountTab(params)).toBe("funds");
  });

  it("falls back to positions for an invalid tab", () => {
    const params = new URLSearchParams("tab=invalid");

    expect(getInitialAccountTab(params)).toBe("positions");
  });

  it("replaces only the tab query param in the current URL", () => {
    window.history.replaceState(
      null,
      "",
      "/account?filter=open&tab=history",
    );

    const replaceStateSpy = vi.spyOn(window.history, "replaceState");

    replaceAccountTabInCurrentUrl("funds");

    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/account");
    expect(window.location.search).toBe("?filter=open&tab=funds");
  });
});
