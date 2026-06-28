import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { Config } from "../config/index.js";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSlug(host: string, baseUrl: string): string | null {
  const base = baseUrl.replace(/^https?:\/\//, "");
  const slug = host.replace(new RegExp(`\\.${escapeRegex(base)}(:\\d+)?$`), "");
  if (!slug || slug === host) return null;
  return slug;
}

/**
 * Manages WebSocket connections for live-reload.
 *
 * Attaches to the public HTTP server's `upgrade` event and handles only
 * connections to `/__lr`. Each connection is tracked by slug so that
 * when a deployment is updated the daemon can broadcast "reload" to all
 * open tabs for that slug.
 */
export class WsManager {
  private clients = new Map<string, Set<WebSocket>>();
  private wss: WebSocketServer;

  constructor(server: http.Server, config: Config) {
    this.wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      // Only handle the live-reload path
      if (req.url !== "/__lr") {
        socket.destroy();
        return;
      }

      const host = req.headers.host ?? "";
      const slug = extractSlug(host, config.base_url);
      if (!slug) {
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        if (!this.clients.has(slug)) this.clients.set(slug, new Set());
        const clientSet = this.clients.get(slug)!;
        clientSet.add(ws);

        ws.on("close", () => {
          clientSet.delete(ws);
          if (clientSet.size === 0) this.clients.delete(slug);
        });

        ws.on("error", () => {
          clientSet.delete(ws);
        });
      });
    });
  }

  /** Broadcast a message to all open WebSocket clients for a slug. */
  broadcast(slug: string, message: string): void {
    const clients = this.clients.get(slug);
    if (!clients) return;
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }

  close(): void {
    this.wss.close();
  }
}
