import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { errorHandler } from "../api/rest.js";
import { createRestTestHarness } from "./rest-test-utils.js";

let harness: ReturnType<typeof createRestTestHarness>;

beforeAll(() => {
  harness = createRestTestHarness();
});

beforeEach(() => {
  harness.reset();
});

describe("GET /api/balance/:address/:token", () => {
  it("returns a cached balance snapshot without re-running expensive reads", async () => {
    const snapshot = {
      balance: "100",
      reserved: "25",
      available: "75",
      walletBalance: "9",
      walletDecimals: 6,
      exchangeDecimals: 6,
    };
    (harness.deps.balanceChecker.getCachedBalanceSnapshot as any).mockResolvedValue(snapshot);

    const res = await harness.req("GET", "/api/balance/0xuser/0xtoken");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ address: "0xuser", token: "0xtoken", ...snapshot });
    expect(harness.deps.balanceChecker.checkBalance).not.toHaveBeenCalled();
  });
});

describe("GET /api/health", () => {
  it("responds with ok status and timestamp", async () => {
    const res = await harness.req("GET", "/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.timestamp).toBeDefined();
  });
});

describe("GET /api/ready", () => {
  it("returns ready when dependencies are healthy", async () => {
    const res = await harness.req("GET", "/api/ready");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.checks.database).toBe("ok");
  });

  it("returns degraded when the database health check fails", async () => {
    (harness.deps.db.healthCheck as any).mockResolvedValue(false);

    const res = await harness.req("GET", "/api/ready");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.checks.database).toBe("error");
  });
});

describe("POST /api/telemetry/wallet", () => {
  it("accepts valid wallet funnel telemetry", async () => {
    const res = await harness.req("POST", "/api/telemetry/wallet", {
      event: "connect_started",
      provider: "cartridge",
      phase: "opening_wallet",
      durationMs: 1250,
      source: "web",
      path: "/",
      deviceClass: "desktop",
      emittedAt: "2026-03-08T12:00:00.000Z",
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ accepted: true });
  });

  it("rejects invalid wallet funnel telemetry payloads", async () => {
    const res = await harness.req("POST", "/api/telemetry/wallet", {
      event: "not_real",
      provider: "cartridge",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/tx/:hash/events", () => {
  it("decodes ERC20 and ERC1155 transfer events", async () => {
    (harness.deps.settler.rpcProvider as any).getTransactionReceipt = vi.fn().mockResolvedValue({
      execution_status: "SUCCEEDED",
      finality_status: "ACCEPTED_ON_L2",
      events: [
        {
          from_address: "0x3ed2",
          keys: [
            "0x182d859c0807ba9db63baf8b9d9fdbfeb885d820be6e206b9dab626d995c433",
            "0x01",
            "0x02",
            "0x03",
          ],
          data: ["0x01", "0x00", "0x64", "0x00"],
        },
        {
          from_address: "0x3241",
          keys: [
            "0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9",
            "0x0a",
            "0x0b",
          ],
          data: ["0x10", "0x00"],
        },
      ],
    });

    const res = await harness.req("GET", "/api/tx/0xabc/events");
    expect(res.status).toBe(200);
    expect(res.body.data.eventCount).toBe(2);
    expect(res.body.data.events[0].kind).toBe("erc1155_transfer_single");
    expect(res.body.data.events[1].kind).toBe("erc20_transfer");
  });

  it("rejects invalid transaction hash", async () => {
    const res = await harness.req("GET", "/api/tx/not-a-hash/events");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/markets", () => {
  it("returns empty list when no markets", async () => {
    const res = await harness.req("GET", "/api/markets");
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  it("returns formatted market list", async () => {
    (harness.deps.db.getMarkets as any).mockResolvedValue([
      {
        market_id: "0xm1",
        id: "0xm1",
        title: "Will BTC hit 100k?",
        category: "crypto",
        outcome_count: 2,
        outcome_labels: ["Yes", "No"],
        collateral_token: "0xusdc",
        status: "ACTIVE",
        total_volume: "5000",
        created_at: "2025-01-01T00:00:00Z",
        thumbnail_url: "https://example.com/btc.png",
      },
    ]);

    const res = await harness.req("GET", "/api/markets");
    expect(res.status).toBe(200);
    expect(res.body.data.items[0].question).toBe("Will BTC hit 100k?");
    expect(res.body.data.items[0].outcomes).toHaveLength(2);
    expect(res.body.data.items[0].thumbnailUrl).toBe("https://example.com/btc.png");
  });

  it("returns null thumbnailUrl when not set", async () => {
    (harness.deps.db.getMarkets as any).mockResolvedValue([
      {
        market_id: "0xm2",
        id: "0xm2",
        title: "Will ETH flip BTC?",
        category: "crypto",
        outcome_count: 2,
        outcome_labels: ["Yes", "No"],
        collateral_token: "0xusdc",
        status: "ACTIVE",
        total_volume: "0",
        created_at: "2025-01-01T00:00:00Z",
      },
    ]);

    const res = await harness.req("GET", "/api/markets");
    expect(res.status).toBe(200);
    expect(res.body.data.items[0].thumbnailUrl).toBeNull();
  });
});

describe("GET /api/markets/:id", () => {
  it("returns 404 for unknown market", async () => {
    const res = await harness.req("GET", "/api/markets/unknown");
    expect(res.status).toBe(404);
  });

  it("returns market detail with stats", async () => {
    (harness.deps.db.getMarketById as any).mockResolvedValue({
      market_id: "0xm1",
      id: "0xm1",
      title: "Test market?",
      category: "crypto",
      outcome_count: 2,
      outcome_labels: ["Yes", "No"],
      collateral_token: "0xusdc",
      status: "ACTIVE",
      total_volume: "1000",
    });

    const res = await harness.req("GET", "/api/markets/0xm1");
    expect(res.status).toBe(200);
    expect(res.body.data.question).toBe("Test market?");
    expect(res.body.data.outcomes).toHaveLength(2);
  });
});

describe("GET /api/portfolio/:address", () => {
  it("returns portfolio for address", async () => {
    (harness.deps.db.getPortfolio as any).mockResolvedValue([
      {
        market_id: "m1",
        title: "Test market",
        outcome_index: 0,
        outcome_label: "Yes",
        net_amount: "5000000",
        avg_price: "0.50",
        realized_pnl: "0",
        unrealized_pnl: "0",
      },
    ]);
    (harness.deps.db.getMarketsByIds as any).mockResolvedValue(new Map([[
      "m1",
      {
        market_id: "m1",
        id: "m1",
        title: "Test market",
        category: "crypto",
        outcome_count: 2,
        outcome_labels: ["Yes", "No"],
        collateral_token: "0xusdc",
        condition_id: "0xcond1",
        on_chain_market_id: "1",
        resolution_time: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: new Date().toISOString(),
        total_volume: "0",
        liquidity: "0",
      },
    ]]));

    const res = await harness.req("GET", "/api/portfolio/0xuser");
    expect(res.status).toBe(200);
    expect(res.body.data.positions).toHaveLength(1);
    expect(res.body.data.positionsCount).toBe(1);
  });
});

describe("GET /api/leaderboard", () => {
  it("returns empty leaderboard", async () => {
    const res = await harness.req("GET", "/api/leaderboard");
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });
});

describe("POST /api/admin/propose-resolution", () => {
  it("requires an API key when one is configured", async () => {
    vi.stubEnv("ENGINE_API_KEY", "test-key");

    const res = await harness.req("POST", "/api/admin/propose-resolution", {
      marketId: "m1",
      winningOutcome: 0,
    });

    expect(res.status).toBe(401);

    vi.unstubAllEnvs();
  });

  it("rejects proposing before market resolution time", async () => {
    (harness.deps.db.getMarketById as any).mockResolvedValue({
      id: "m1",
      market_id: "m1",
      status: "ACTIVE",
      condition_id: "0xcond",
      on_chain_market_id: "1",
      resolution_time: "2100-01-01T00:00:00.000Z",
    });

    const res = await harness.req(
      "POST",
      "/api/admin/propose-resolution",
      {
        marketId: "m1",
        winningOutcome: 0,
      },
      { authorization: "Bearer test-key" },
    );

    expect(res.status).toBe(400);
    expect((res.body.error as string).toLowerCase()).toContain("cannot be resolved yet");
  });
});

describe("POST /api/admin/finalize-resolution", () => {
  it("rejects finalizing if not yet proposed", async () => {
    (harness.deps.db.getMarketById as any).mockResolvedValue({
      id: "m1",
      market_id: "m1",
      status: "ACTIVE",
      condition_id: "0xcond",
      on_chain_market_id: "1",
    });

    const res = await harness.req("POST", "/api/admin/finalize-resolution", {
      marketId: "m1",
    });

    expect(res.status).toBe(400);
    expect((res.body.error as string).toLowerCase()).toContain("not yet proposed");
  });
});

describe("errorHandler", () => {
  it("handles ZodError", () => {
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    errorHandler(
      new z.ZodError([
        {
          code: "too_small",
          minimum: 1,
          type: "string",
          inclusive: true,
          message: "Required",
          path: ["field"],
        },
      ]),
      {} as any,
      mockRes as any,
      vi.fn(),
    );
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });
});

describe("GET /metrics", () => {
  it("requires an API key when one is configured", async () => {
    vi.stubEnv("ENGINE_API_KEY", "test-key");

    const res = await harness.req("GET", "/metrics");
    expect(res.status).toBe(401);

    vi.unstubAllEnvs();
  });
});

describe("GET /api/portfolio/:address/rewards", () => {
  it("returns claimable rewards for a user", async () => {
    (harness.deps.db.getClaimableRewards as any).mockResolvedValue([
      {
        market_id: "mkt-1",
        outcome_index: 0,
        amount: "500000",
        market: {
          id: "uuid-1",
          market_id: "mkt-1",
          on_chain_market_id: "1",
          title: "Test market",
          description: "",
          category: "crypto",
          outcome_count: 2,
          outcome_labels: ["Yes", "No"],
          collateral_token: "0xtoken",
          resolution_source: "",
          resolution_time: new Date("2025-01-01"),
          status: "RESOLVED",
          winning_outcome: 0,
          total_volume: "1000000",
          liquidity: "0",
          created_at: new Date(),
          updated_at: new Date(),
          condition_id: "0xcondition",
        },
      },
    ]);

    const res = await harness.req("GET", "/api/portfolio/0xuser1/rewards");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});

describe("POST /api/admin/seed-market", () => {
  it("disables manual market seeding in production by default", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENGINE_API_KEY", "test-key");

    const res = await harness.req(
      "POST",
      "/api/admin/seed-market",
      {
        marketId: "probe",
        title: "Probe",
        outcomeCount: 2,
        outcomeLabels: ["Yes", "No"],
        collateralToken: "0xtoken",
      },
      { authorization: "Bearer test-key" },
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("disabled");

    vi.unstubAllEnvs();
  });
});

describe("GET /api/markets/:id/quote", () => {
  const mockMarket = {
    id: "m1",
    market_id: "m1",
    outcome_count: 2,
    outcome_labels: ["Yes", "No"],
    collateral_token: "0xusdc",
    status: "ACTIVE",
    condition_id: "0x1234",
  };

  it("returns 404 for unknown market", async () => {
    (harness.deps.db.getMarketById as any).mockResolvedValue(null);
    const res = await harness.req("GET", "/api/markets/unknown/quote");
    expect(res.status).toBe(404);
  });

  it("returns max available from CLOB and AMM", async () => {
    (harness.deps.db.getMarketById as any).mockResolvedValue(mockMarket);
    (harness.deps.orderBook.getAllOrders as any).mockResolvedValue([
      { remainingAmount: "5000000", price: "0.50" },
      { remainingAmount: "3000000", price: "0.55" },
    ]);
    (harness.deps.ammState.loadState as any).mockResolvedValue({
      marketId: "m1",
      b: 100,
      quantities: [0, 0],
      active: true,
    });

    const res = await harness.req("GET", "/api/markets/m1/quote?outcomeIndex=0&side=BUY");
    expect(res.status).toBe(200);
    expect(parseFloat(res.body.data.clobAvailable)).toBe(8);
    expect(parseFloat(res.body.data.maxAvailable)).toBeGreaterThan(8);
  });
});
