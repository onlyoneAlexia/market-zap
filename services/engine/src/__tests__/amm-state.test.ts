import { describe, it, expect, beforeEach } from "vitest";
import { AmmStateManager } from "../amm-state.js";
import { createMockRedis, MockRedisClient } from "./mock-redis.js";

describe("AmmStateManager", () => {
  let redis: ReturnType<typeof createMockRedis>;
  let manager: AmmStateManager;

  beforeEach(() => {
    redis = createMockRedis();
    (redis as unknown as MockRedisClient).clear?.();
    manager = new AmmStateManager(redis);
  });

  it("initializes a pool with correct defaults", async () => {
    const state = await manager.initPool("m1", 100, 2);
    expect(state.marketId).toBe("m1");
    expect(state.b).toBe(100);
    expect(state.quantities).toEqual([0, 0]);
    expect(state.active).toBe(true);
  });

  it("loads a previously initialized pool", async () => {
    await manager.initPool("m1", 100, 2);
    const loaded = await manager.loadState("m1");
    expect(loaded).not.toBeNull();
    expect(loaded!.marketId).toBe("m1");
    expect(loaded!.b).toBe(100);
    expect(loaded!.quantities).toEqual([0, 0]);
    expect(loaded!.active).toBe(true);
  });

  it("returns null for non-existent pool", async () => {
    const state = await manager.loadState("nonexistent");
    expect(state).toBeNull();
  });

  it("saves and loads updated state", async () => {
    await manager.initPool("m1", 100, 2);
    await manager.saveState({
      marketId: "m1",
      b: 100,
      quantities: [15, 5],
      active: true,
    });
    const loaded = await manager.loadState("m1");
    expect(loaded!.quantities).toEqual([15, 5]);
  });

  it("deactivates a pool", async () => {
    await manager.initPool("m1", 100, 2);
    await manager.deactivatePool("m1");
    const state = await manager.loadState("m1");
    expect(state!.active).toBe(false);
  });

  it("hasActivePool returns true for active pool", async () => {
    await manager.initPool("m1", 100, 2);
    expect(await manager.hasActivePool("m1")).toBe(true);
  });

  it("hasActivePool returns false for inactive pool", async () => {
    await manager.initPool("m1", 100, 2);
    await manager.deactivatePool("m1");
    expect(await manager.hasActivePool("m1")).toBe(false);
  });

  it("hasActivePool returns false for non-existent pool", async () => {
    expect(await manager.hasActivePool("nonexistent")).toBe(false);
  });

  it("updateState applies mutation correctly", async () => {
    await manager.initPool("m1", 100, 2);
    const result = await manager.updateState("m1", (s) => ({
      ...s,
      quantities: [10, 5],
    }));
    expect(result).not.toBeNull();
    expect(result!.quantities).toEqual([10, 5]);

    const loaded = await manager.loadState("m1");
    expect(loaded!.quantities).toEqual([10, 5]);
  });

  it("updateState returns null for inactive pool", async () => {
    await manager.initPool("m1", 100, 2);
    await manager.deactivatePool("m1");
    const result = await manager.updateState("m1", (s) => ({
      ...s,
      quantities: [10, 0],
    }));
    expect(result).toBeNull();
  });

  it("updateState returns null for non-existent pool", async () => {
    const result = await manager.updateState("nonexistent", (s) => s);
    expect(result).toBeNull();
  });

  it("updateState returns null when mutate returns null", async () => {
    await manager.initPool("m1", 100, 2);
    const result = await manager.updateState("m1", () => null);
    expect(result).toBeNull();
  });

  it("deletePool removes the pool entirely", async () => {
    await manager.initPool("m1", 100, 2);
    await manager.deletePool("m1");
    const state = await manager.loadState("m1");
    expect(state).toBeNull();
  });

  it("supports multi-outcome pools", async () => {
    const state = await manager.initPool("m1", 50, 4);
    expect(state.quantities).toEqual([0, 0, 0, 0]);

    await manager.saveState({ ...state, quantities: [10, 20, 5, 15] });
    const loaded = await manager.loadState("m1");
    expect(loaded!.quantities).toEqual([10, 20, 5, 15]);
  });
});
