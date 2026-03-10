import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Protocol messages
// ---------------------------------------------------------------------------

interface SubscribeMessage {
  type: "subscribe";
  channel?: string;
  channels?: string[];
}

interface UnsubscribeMessage {
  type: "unsubscribe";
  channel?: string;
  channels?: string[];
}

interface PongMessage {
  type: "pong";
}

type IncomingMessage = SubscribeMessage | UnsubscribeMessage | PongMessage;

interface ErrorMessage {
  type: "error";
  message: string;
}

interface SubscribedMessage {
  type: "subscribed";
  channel: string;
}

interface UnsubscribedMessage {
  type: "unsubscribed";
  channel: string;
}

interface PingMessage {
  type: "ping";
}

// ---------------------------------------------------------------------------
// Channel patterns
// ---------------------------------------------------------------------------

/**
 * Valid channel patterns:
 *   price:{marketId}:{outcomeIndex}
 *   trades:{marketId}
 *
 * NOTE: portfolio:{address} removed — no server broadcast uses it,
 * and it would leak dark market data without WS-level auth.
 */
const CHANNEL_PATTERN =
  /^(price:[a-zA-Z0-9_-]+:\d+|trades:[a-zA-Z0-9_-]+)$/;

function isValidChannel(channel: string): boolean {
  return CHANNEL_PATTERN.test(channel);
}

// ---------------------------------------------------------------------------
// Connection wrapper
// ---------------------------------------------------------------------------

interface Connection {
  id: string;
  ws: WebSocket;
  channels: Set<string>;
  alive: boolean;
  connectedAt: Date;
}

// ---------------------------------------------------------------------------
// WebSocketManager
// ---------------------------------------------------------------------------

export interface WebSocketManagerOptions {
  /** Heartbeat interval in milliseconds (default: 30 000). */
  heartbeatInterval?: number;
  /** Maximum channels a single connection may subscribe to. */
  maxChannelsPerConnection?: number;
}

export class WebSocketManager {
  private wss: WebSocketServer | null = null;
  private readonly connections = new Map<string, Connection>();
  /** channel -> set of connection ids */
  private readonly channelSubscribers = new Map<string, Set<string>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatInterval: number;
  private readonly maxChannels: number;

  constructor(options: WebSocketManagerOptions = {}) {
    this.heartbeatInterval = options.heartbeatInterval ?? 30_000;
    this.maxChannels = options.maxChannelsPerConnection ?? 50;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Attach to an existing HTTP server. */
  attach(server: HttpServer): void {
    this.wss = new WebSocketServer({ server, path: "/ws" });

    this.wss.on("connection", (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    this.wss.on("error", (err) => {
      console.error("[ws] server error:", err.message);
    });

    this.startHeartbeat();
    console.log("[ws] WebSocket server attached at /ws");
  }

  /** Gracefully close all connections. */
  async shutdown(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const conn of this.connections.values()) {
      conn.ws.close(1001, "Server shutting down");
    }
    this.connections.clear();
    this.channelSubscribers.clear();

    return new Promise<void>((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          console.log("[ws] server closed");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // -----------------------------------------------------------------------
  // Broadcasting
  // -----------------------------------------------------------------------

  /** Send data to all subscribers of a channel. */
  broadcast(channel: string, data: unknown): void {
    const subscribers = this.channelSubscribers.get(channel);
    if (!subscribers || subscribers.size === 0) return;

    const payload = JSON.stringify({ channel, data });

    for (const connId of subscribers) {
      const conn = this.connections.get(connId);
      if (conn && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(payload);
      }
    }
  }

  /** Number of active connections. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** Number of distinct subscribed channels. */
  get channelCount(): number {
    return this.channelSubscribers.size;
  }

  // -----------------------------------------------------------------------
  // Connection handling
  // -----------------------------------------------------------------------

  private handleConnection(ws: WebSocket): void {
    const conn: Connection = {
      id: randomUUID(),
      ws,
      channels: new Set(),
      alive: true,
      connectedAt: new Date(),
    };

    this.connections.set(conn.id, conn);
    console.log(
      `[ws] new connection ${conn.id} (total: ${this.connections.size})`,
    );

    ws.on("message", (raw: RawData) => {
      this.handleMessage(conn, raw);
    });

    ws.on("close", () => {
      this.handleDisconnect(conn);
    });

    ws.on("error", (err) => {
      console.error(`[ws] connection ${conn.id} error:`, err.message);
      this.handleDisconnect(conn);
    });

    ws.on("pong", () => {
      conn.alive = true;
    });
  }

  private handleMessage(conn: Connection, raw: RawData): void {
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(raw.toString()) as IncomingMessage;
    } catch {
      this.send(conn, { type: "error", message: "Invalid JSON" });
      return;
    }

    switch (msg.type) {
      case "subscribe": {
        // Accept both `channel` (single) and `channels` (array)
        const subs = msg.channels ?? (msg.channel ? [msg.channel] : []);
        for (const ch of subs) {
          this.handleSubscribe(conn, ch);
        }
        break;
      }
      case "unsubscribe": {
        const unsubs = msg.channels ?? (msg.channel ? [msg.channel] : []);
        for (const ch of unsubs) {
          this.handleUnsubscribe(conn, ch);
        }
        break;
      }
      case "pong":
        conn.alive = true;
        break;
      default:
        this.send(conn, {
          type: "error",
          message: `Unknown message type: ${(msg as { type: string }).type}`,
        });
    }
  }

  private handleSubscribe(conn: Connection, channel: string): void {
    if (!isValidChannel(channel)) {
      this.send(conn, {
        type: "error",
        message: `Invalid channel: ${channel}`,
      });
      return;
    }

    if (conn.channels.size >= this.maxChannels) {
      this.send(conn, {
        type: "error",
        message: `Maximum ${this.maxChannels} channel subscriptions reached`,
      });
      return;
    }

    conn.channels.add(channel);

    let subs = this.channelSubscribers.get(channel);
    if (!subs) {
      subs = new Set();
      this.channelSubscribers.set(channel, subs);
    }
    subs.add(conn.id);

    this.send(conn, { type: "subscribed", channel } satisfies SubscribedMessage);
  }

  private handleUnsubscribe(conn: Connection, channel: string): void {
    conn.channels.delete(channel);

    const subs = this.channelSubscribers.get(channel);
    if (subs) {
      subs.delete(conn.id);
      if (subs.size === 0) {
        this.channelSubscribers.delete(channel);
      }
    }

    this.send(conn, { type: "unsubscribed", channel } satisfies UnsubscribedMessage);
  }

  private handleDisconnect(conn: Connection): void {
    // Remove from all channel subscriber sets.
    for (const channel of conn.channels) {
      const subs = this.channelSubscribers.get(channel);
      if (subs) {
        subs.delete(conn.id);
        if (subs.size === 0) {
          this.channelSubscribers.delete(channel);
        }
      }
    }

    this.connections.delete(conn.id);
    console.log(
      `[ws] connection ${conn.id} closed (total: ${this.connections.size})`,
    );
  }

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const conn of this.connections.values()) {
        if (!conn.alive) {
          console.log(`[ws] terminating unresponsive connection ${conn.id}`);
          conn.ws.terminate();
          this.handleDisconnect(conn);
          continue;
        }
        conn.alive = false;
        // Send both a WebSocket-level ping and an application-level ping.
        conn.ws.ping();
        this.send(conn, { type: "ping" } satisfies PingMessage);
      }
    }, this.heartbeatInterval);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private send(
    conn: Connection,
    msg: SubscribedMessage | UnsubscribedMessage | PingMessage | ErrorMessage,
  ): void {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(msg));
    }
  }
}
