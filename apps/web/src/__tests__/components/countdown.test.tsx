import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Countdown } from "@/components/market/countdown";

describe("Countdown", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shares a single ticker across multiple instances", () => {
    vi.useFakeTimers();
    const intervalSpy = vi.spyOn(globalThis, "setInterval");

    const now = Math.floor(Date.now() / 1000);
    render(
      <>
        <Countdown endsAt={now + 3600} />
        <Countdown endsAt={now + 7200} />
      </>,
    );

    expect(intervalSpy).toHaveBeenCalledTimes(1);
  });
});
