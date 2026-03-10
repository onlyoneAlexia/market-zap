import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRestTestHarness } from "./rest-test-utils.js";

let harness: ReturnType<typeof createRestTestHarness>;

beforeAll(() => {
  harness = createRestTestHarness();
});

beforeEach(() => {
  harness.reset();
});

describe("POST /api/orders", () => {
  const validOrder = {
    marketId: "0xm1",
    outcomeIndex: 0,
    side: "BID",
    orderType: "LIMIT",
    price: "0.65",
    amount: "1000000000000000000",
    user: "0xuser",
    nonce: "12345",
    signature: "0x0,0x0",
  };

  beforeEach(() => {
    (harness.deps.db.getMarketById as any).mockResolvedValue({
      market_id: "0xm1",
      status: "ACTIVE",
      outcome_count: 2,
      collateral_token: "0xusdc",
      condition_id: "0xabc123def456",
      on_chain_market_id: "1",
    });
    process.env.SKIP_BALANCE_CHECK = "true";
  });

  afterEach(() => {
    delete process.env.SKIP_BALANCE_CHECK;
    delete process.env.CONDITIONAL_TOKENS_ADDRESS;
  });

  it("returns 400 for invalid body", async () => {
    const res = await harness.req("POST", "/api/orders", { bad: "data" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("returns 404 when market does not exist", async () => {
    (harness.deps.db.getMarketById as any).mockResolvedValue(null);
    const res = await harness.req("POST", "/api/orders", validOrder);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Market not found");
  });

  it("returns 400 when market is not active", async () => {
    (harness.deps.db.getMarketById as any).mockResolvedValue({
      market_id: "0xm1",
      status: "RESOLVED",
      outcome_count: 2,
      collateral_token: "0xusdc",
    });
    const res = await harness.req("POST", "/api/orders", validOrder);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("RESOLVED");
  });

  it("returns 400 when the market has passed its resolution time", async () => {
    (harness.deps.db.getMarketById as any).mockResolvedValue({
      market_id: "0xm1",
      status: "ACTIVE",
      outcome_count: 2,
      collateral_token: "0xusdc",
      condition_id: "0xabc123def456",
      on_chain_market_id: "1",
      resolution_time: new Date(Date.now() - 60_000),
    });

    const res = await harness.req("POST", "/api/orders", validOrder);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Market has ended and can no longer be traded");
    expect(harness.deps.matcher.match).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid outcome index", async () => {
    const res = await harness.req("POST", "/api/orders", {
      ...validOrder,
      outcomeIndex: 5,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid outcome index");
  });

  it("submits valid order and calls matcher", async () => {
    const res = await harness.req("POST", "/api/orders", validOrder);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(harness.deps.matcher.match).toHaveBeenCalledTimes(1);
    expect(harness.deps.db.upsertOrder).toHaveBeenCalledTimes(1);
  });

  it("rejects underfunded MARKET BID using worst-case price bound", async () => {
    process.env.SKIP_BALANCE_CHECK = "false";
    (harness.deps.balanceChecker.checkBalance as any).mockResolvedValue(500_000n);
    (harness.deps.db.getUnsettledBuyCosts as any).mockResolvedValue(0n);
    (harness.deps.db.getOpenOrderReservations as any).mockResolvedValue(0n);

    const res = await harness.req("POST", "/api/orders", {
      ...validOrder,
      orderType: "MARKET",
      price: "0.0001",
      amount: "1000000",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Insufficient deposited balance");
  });

  it("rejects underfunded ASK when outcome-token inventory is insufficient", async () => {
    process.env.SKIP_BALANCE_CHECK = "false";
    process.env.CONDITIONAL_TOKENS_ADDRESS = "0xct";
    (harness.deps.balanceChecker.checkErc1155Balance as any).mockResolvedValue(100n);
    (harness.deps.db.getUnsettledSellAmount as any).mockResolvedValue(20n);
    (harness.deps.db.getOpenOutcomeOrderReservations as any).mockResolvedValue(40n);

    const res = await harness.req("POST", "/api/orders", {
      ...validOrder,
      side: "ASK",
      amount: "70",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Insufficient outcome-token balance");
  });

  it("stores outcome-token reservation for resting ASK limit orders", async () => {
    (harness.deps.matcher.match as any).mockResolvedValue({
      trades: [],
      remainingAmount: 500n,
      restingOnBook: true,
      consumedOrders: [],
      preMatchAmmState: null,
      postClobAmmState: null,
      restedOrder: {
        nonce: "12345",
        marketId: "0xm1",
        outcomeIndex: 0,
        side: "ASK",
        price: "0.65",
        amount: "1000",
        remainingAmount: "500",
        user: "0xuser",
        createdAt: new Date().toISOString(),
        signature: "0x0,0x0",
        orderType: "LIMIT",
        expiry: 0,
      },
    });

    const res = await harness.req("POST", "/api/orders", {
      ...validOrder,
      side: "ASK",
      amount: "1000",
    });

    expect(res.status).toBe(201);
    expect(harness.deps.db.insertOutcomeOrderReservation).toHaveBeenCalledWith(
      "12345",
      "0xuser",
      "0xm1",
      0,
      expect.any(String),
      "500",
    );
  });

  it("updates maker order status and reservation from consumed BID fills", async () => {
    (harness.deps.matcher.match as any).mockResolvedValue({
      trades: [
        {
          id: "t1",
          marketId: "0xm1",
          outcomeIndex: 0,
          buyer: "0xuser",
          seller: "0xmaker",
          price: "0.50",
          fillAmount: "600",
          buyerNonce: "12345",
          sellerNonce: "maker_nonce",
          matchedAt: new Date().toISOString(),
          makerOrder: {
            trader: "0xmaker",
            price: "0.50",
            amount: "1000",
            nonce: "maker_nonce",
            expiry: 0,
            signature: "sig",
            isBuy: true,
          },
          takerOrder: {
            trader: "0xuser",
            price: "0.65",
            amount: "600",
            nonce: "12345",
            expiry: 0,
            signature: "0x0,0x0",
            isBuy: true,
          },
        },
      ],
      remainingAmount: 0n,
      restingOnBook: false,
      consumedOrders: [
        {
          original: {
            nonce: "maker_nonce",
            marketId: "0xm1",
            outcomeIndex: 0,
            side: "BID",
            price: "0.50",
            amount: "1000",
            remainingAmount: "1000",
            user: "0xmaker",
            createdAt: new Date().toISOString(),
            signature: "sig",
            orderType: "LIMIT",
            expiry: 0,
          },
          newRemaining: "400",
        },
      ],
      preMatchAmmState: null,
      postClobAmmState: null,
      restedOrder: null,
    });

    const res = await harness.req("POST", "/api/orders", { ...validOrder, amount: "600" });
    expect(res.status).toBe(201);
    expect(harness.deps.db.updateOrderStatus).toHaveBeenCalledWith(
      "maker_nonce",
      "PARTIALLY_FILLED",
      "600",
    );
    expect(harness.deps.db.deleteOrderReservation).toHaveBeenCalledWith("maker_nonce");
    expect(harness.deps.db.insertOrderReservation).toHaveBeenCalledWith(
      "maker_nonce",
      "0xmaker",
      "0xusdc",
      "202",
    );
  });

  it("updates maker ASK reservation from consumed fills", async () => {
    (harness.deps.matcher.match as any).mockResolvedValue({
      trades: [
        {
          id: "t1",
          marketId: "0xm1",
          outcomeIndex: 0,
          buyer: "0xbuyer",
          seller: "0xmaker",
          price: "0.48",
          fillAmount: "600",
          buyerNonce: "12345",
          sellerNonce: "maker_ask_nonce",
          matchedAt: new Date().toISOString(),
          makerOrder: {
            trader: "0xmaker",
            price: "0.48",
            amount: "1000",
            nonce: "maker_ask_nonce",
            expiry: 0,
            signature: "sig",
            isBuy: false,
          },
          takerOrder: {
            trader: "0xbuyer",
            price: "0.50",
            amount: "600",
            nonce: "12345",
            expiry: 0,
            signature: "0x0,0x0",
            isBuy: true,
          },
        },
      ],
      remainingAmount: 0n,
      restingOnBook: false,
      consumedOrders: [
        {
          original: {
            nonce: "maker_ask_nonce",
            marketId: "0xm1",
            outcomeIndex: 0,
            side: "ASK",
            price: "0.48",
            amount: "1000",
            remainingAmount: "1000",
            user: "0xmaker",
            createdAt: new Date().toISOString(),
            signature: "sig",
            orderType: "LIMIT",
            expiry: 0,
          },
          newRemaining: "400",
        },
      ],
      preMatchAmmState: null,
      postClobAmmState: null,
      restedOrder: null,
    });

    const res = await harness.req("POST", "/api/orders", { ...validOrder, amount: "600" });
    expect(res.status).toBe(201);
    expect(harness.deps.db.deleteOutcomeOrderReservation).toHaveBeenCalledWith(
      "maker_ask_nonce",
    );
    expect(harness.deps.db.insertOutcomeOrderReservation).toHaveBeenCalledWith(
      "maker_ask_nonce",
      "0xmaker",
      "0xm1",
      0,
      expect.any(String),
      "400",
    );
  });
});

describe("DELETE /api/orders/:nonce", () => {
  it("returns 400 when user or signature query params are missing", async () => {
    const res1 = await harness.req("DELETE", "/api/orders/nonce123");
    expect(res1.status).toBe(400);
    const res2 = await harness.req("DELETE", "/api/orders/nonce123?user=0xAlice");
    expect(res2.status).toBe(400);
  });

  it("returns 404 when order not found in DB", async () => {
    (harness.deps.db.getOrderByNonce as any).mockResolvedValue(null);
    const res = await harness.req(
      "DELETE",
      "/api/orders/nonce123?user=0xAlice&signature=0xsig",
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when caller address does not match order owner", async () => {
    (harness.deps.db.getOrderByNonce as any).mockResolvedValue({
      nonce: "nonce123",
      market_id: "m1",
      outcome_index: 0,
      user_address: "0xAlice",
      signature: "0xsig",
      status: "OPEN",
    });
    const res = await harness.req(
      "DELETE",
      "/api/orders/nonce123?user=0xBob&signature=0xsig",
    );
    expect(res.status).toBe(403);
    expect(harness.deps.db.updateOrderStatus).not.toHaveBeenCalled();
  });

  it("returns 403 when signature does not match", async () => {
    (harness.deps.db.getOrderByNonce as any).mockResolvedValue({
      nonce: "nonce123",
      market_id: "m1",
      outcome_index: 0,
      user_address: "0xAlice",
      signature: "0xrealSig",
      status: "OPEN",
    });
    const res = await harness.req(
      "DELETE",
      "/api/orders/nonce123?user=0xAlice&signature=0xwrongSig",
    );
    expect(res.status).toBe(403);
    expect(harness.deps.db.updateOrderStatus).not.toHaveBeenCalled();
  });

  it("cancels order in DB when not on book", async () => {
    (harness.deps.db.getOrderByNonce as any).mockResolvedValue({
      nonce: "nonce123",
      market_id: "m1",
      outcome_index: 0,
      user_address: "0xAlice",
      signature: "0xsig",
      status: "OPEN",
    });
    const res = await harness.req(
      "DELETE",
      "/api/orders/nonce123?user=0xAlice&signature=0xsig",
    );
    expect(res.status).toBe(200);
    expect(harness.deps.db.updateOrderStatus).toHaveBeenCalledWith("nonce123", "CANCELLED");
  });

  it("cancels existing order when found in DB and on book", async () => {
    (harness.deps.db.getOrderByNonce as any).mockResolvedValue({
      nonce: "nonce123",
      market_id: "m1",
      outcome_index: 0,
      user_address: "0xAlice",
      signature: "0xsig",
    });
    (harness.deps.orderBook.findOrderByNonce as any).mockResolvedValue({
      nonce: "nonce123",
      user: "0xAlice",
      marketId: "m1",
      outcomeIndex: 0,
      side: "BID",
      price: "0.50",
      amount: "100",
      remainingAmount: "100",
      createdAt: new Date().toISOString(),
      signature: "0xsig",
      orderType: "LIMIT",
      expiry: 0,
    });
    (harness.deps.orderBook.removeOrder as any).mockResolvedValue(true);

    const res = await harness.req(
      "DELETE",
      "/api/orders/nonce123?user=0xAlice&signature=0xsig",
    );

    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(true);
    expect(harness.deps.db.updateOrderStatus).toHaveBeenCalledWith("nonce123", "CANCELLED");
  });

  it("allows cancel with case-insensitive address match", async () => {
    (harness.deps.db.getOrderByNonce as any).mockResolvedValue({
      nonce: "nonce123",
      market_id: "m1",
      outcome_index: 0,
      user_address: "0xALICE",
      signature: "0xsig",
      status: "OPEN",
    });
    const res = await harness.req(
      "DELETE",
      "/api/orders/nonce123?user=0xalice&signature=0xsig",
    );
    expect(res.status).toBe(200);
    expect(harness.deps.db.updateOrderStatus).toHaveBeenCalledWith("nonce123", "CANCELLED");
  });

  it("returns 400 when order is already in terminal state", async () => {
    (harness.deps.db.getOrderByNonce as any).mockResolvedValue({
      nonce: "nonce123",
      market_id: "m1",
      outcome_index: 0,
      user_address: "0xAlice",
      signature: "0xsig",
      status: "FILLED",
    });
    const res = await harness.req(
      "DELETE",
      "/api/orders/nonce123?user=0xAlice&signature=0xsig",
    );
    expect(res.status).toBe(400);
  });
});
