import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebSocketManager } from "../api/websocket.js";

// We test the WebSocketManager's internal logic by creating mock WebSocket objects
// and exercising the connection/subscription handlers.

function createMockWs() {
  const handlers: Record<string, Function[]> = {};
  return {
    on: vi.fn((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
    ping: vi.fn(),
    readyState: 1, // WebSocket.OPEN
    _handlers: handlers,
    _emit(event: string, ...args: unknown[]) {
      (handlers[event] ?? []).forEach((h) => h(...args));
    },
  };
}

describe("WebSocketManager", () => {
  let manager: WebSocketManager;

  beforeEach(() => {
    manager = new WebSocketManager({
      heartbeatInterval: 30_000,
      maxChannelsPerConnection: 5,
    });
  });

  describe("connection tracking", () => {
    it("starts with 0 connections", () => {
      expect(manager.connectionCount).toBe(0);
    });

    it("tracks connections when handleConnection is called", () => {
      const ws = createMockWs();
      (manager as any).handleConnection(ws);

      expect(manager.connectionCount).toBe(1);
    });

    it("removes connections on close", () => {
      const ws = createMockWs();
      (manager as any).handleConnection(ws);

      expect(manager.connectionCount).toBe(1);

      // Trigger close
      ws._emit("close");
      expect(manager.connectionCount).toBe(0);
    });

    it("handles multiple connections", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      (manager as any).handleConnection(ws1);
      (manager as any).handleConnection(ws2);

      expect(manager.connectionCount).toBe(2);
    });
  });

  describe("subscription handling", () => {
    it("subscribes to valid channels", () => {
      const ws = createMockWs();
      (manager as any).handleConnection(ws);

      // Send subscribe message
      ws._emit("message", Buffer.from(JSON.stringify({
        type: "subscribe",
        channel: "trades:market-1",
      })));

      expect(manager.channelCount).toBe(1);
      // Verify subscribed confirmation was sent
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"subscribed"'),
      );
    });

    it("rejects invalid channel names", () => {
      const ws = createMockWs();
      (manager as any).handleConnection(ws);

      ws._emit("message", Buffer.from(JSON.stringify({
        type: "subscribe",
        channel: "invalid-channel",
      })));

      expect(manager.channelCount).toBe(0);
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"error"'),
      );
    });

    it("accepts price channel pattern", () => {
      const ws = createMockWs();
      (manager as any).handleConnection(ws);

      ws._emit("message", Buffer.from(JSON.stringify({
        type: "subscribe",
        channel: "price:market-1:0",
      })));

      expect(manager.channelCount).toBe(1);
    });

    it("rejects removed portfolio channel pattern", () => {
      const ws = createMockWs();
      (manager as any).handleConnection(ws);

      ws._emit("message", Buffer.from(JSON.stringify({
        type: "subscribe",
        channel: "portfolio:0xabcdef1234567890",
      })));

      // portfolio channel was removed (no server broadcast, dark market leak risk)
      expect(manager.channelCount).toBe(0);
    });

    it("unsubscribes from channels", () => {
      const ws = createMockWs();
      (manager as any).handleConnection(ws);

      ws._emit("message", Buffer.from(JSON.stringify({
        type: "subscribe",
        channel: "trades:market-1",
      })));
      expect(manager.channelCount).toBe(1);

      ws._emit("message", Buffer.from(JSON.stringify({
        type: "unsubscribe",
        channel: "trades:market-1",
      })));
      expect(manager.channelCount).toBe(0);
    });

    it("enforces max channel limit", () => {
      const ws = createMockWs();
      (manager as any).handleConnection(ws);

      // Subscribe to max (5) channels
      for (let i = 0; i < 5; i++) {
        ws._emit("message", Buffer.from(JSON.stringify({
          type: "subscribe",
          channel: `trades:market-${i}`,
        })));
      }
      expect(manager.channelCount).toBe(5);

      // Try subscribing to one more
      ws._emit("message", Buffer.from(JSON.stringify({
        type: "subscribe",
        channel: "trades:market-extra",
      })));

      // Should get an error, not 6 channels
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining("Maximum"),
      );
    });

    it("cleans up channel subscriptions on disconnect", () => {
      const ws = createMockWs();
      (manager as any).handleConnection(ws);

      ws._emit("message", Buffer.from(JSON.stringify({
        type: "subscribe",
        channel: "trades:market-1",
      })));
      ws._emit("message", Buffer.from(JSON.stringify({
        type: "subscribe",
        channel: "price:market-1:0",
      })));
      expect(manager.channelCount).toBe(2);

      ws._emit("close");
      expect(manager.channelCount).toBe(0);
    });
  });

  describe("message handling", () => {
    it("handles invalid JSON gracefully", () => {
      const ws = createMockWs();
      (manager as any).handleConnection(ws);

      ws._emit("message", Buffer.from("not json"));

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining("Invalid JSON"),
      );
    });

    it("handles unknown message types", () => {
      const ws = createMockWs();
      (manager as any).handleConnection(ws);

      ws._emit("message", Buffer.from(JSON.stringify({
        type: "unknown",
      })));

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining("Unknown message type"),
      );
    });

    it("handles pong messages", () => {
      const ws = createMockWs();
      (manager as any).handleConnection(ws);

      // Should not throw
      ws._emit("message", Buffer.from(JSON.stringify({
        type: "pong",
      })));
    });
  });

  describe("broadcast", () => {
    it("sends to subscribed connections only", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      (manager as any).handleConnection(ws1);
      (manager as any).handleConnection(ws2);

      // Only ws1 subscribes
      ws1._emit("message", Buffer.from(JSON.stringify({
        type: "subscribe",
        channel: "trades:market-1",
      })));

      // Clear send mock to isolate broadcast
      ws1.send.mockClear();
      ws2.send.mockClear();

      manager.broadcast("trades:market-1", { trade: "data" });

      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).not.toHaveBeenCalled();
    });

    it("does nothing for empty channel", () => {
      manager.broadcast("trades:nonexistent", { data: "test" });
      // Should not throw
    });

    it("sends properly formatted payload", () => {
      const ws = createMockWs();
      (manager as any).handleConnection(ws);

      ws._emit("message", Buffer.from(JSON.stringify({
        type: "subscribe",
        channel: "trades:market-1",
      })));

      ws.send.mockClear();
      manager.broadcast("trades:market-1", { price: "0.5" });

      const sentPayload = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sentPayload.channel).toBe("trades:market-1");
      expect(sentPayload.data).toEqual({ price: "0.5" });
    });
  });

  describe("heartbeat", () => {
    it("marks connections alive on pong", () => {
      const ws = createMockWs();
      (manager as any).handleConnection(ws);

      // Get connection and mark it dead (simulating heartbeat cycle)
      const connId = [...(manager as any).connections.keys()][0];
      const conn = (manager as any).connections.get(connId);
      conn.alive = false;

      // Trigger pong handler
      ws._emit("pong");
      expect(conn.alive).toBe(true);
    });

    it("application-level pong message marks alive", () => {
      const ws = createMockWs();
      (manager as any).handleConnection(ws);

      const connId = [...(manager as any).connections.keys()][0];
      const conn = (manager as any).connections.get(connId);
      conn.alive = false;

      // Send application-level pong
      ws._emit("message", Buffer.from(JSON.stringify({ type: "pong" })));
      expect(conn.alive).toBe(true);
    });
  });

  describe("shutdown", () => {
    it("clears all connections", async () => {
      const ws = createMockWs();
      (manager as any).handleConnection(ws);

      await manager.shutdown();

      expect(manager.connectionCount).toBe(0);
      expect(manager.channelCount).toBe(0);
      expect(ws.close).toHaveBeenCalledWith(1001, "Server shutting down");
    });
  });
});
