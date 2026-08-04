import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { Config } from "../config/index.js";
import { ManifestStore } from "../storage/index.js";
import { extractSlug } from "../lib/slug.js";
import { basicAuthOk } from "../lib/basic-auth.js";

interface TrackedSocket extends WebSocket {
  isAlive?: boolean;
}

const HEARTBEAT_MS = 30_000;

/**
 * Manages WebSocket connections for live-reload.
 *
 * Attaches to the public HTTP server's `upgrade` event and handles only
 * connections to `/__lr`. Each connection is tracked by slug so that
 * when a deployment is updated the daemon can broadcast "reload" to all
 * open tabs for that slug.
 */
export class WsManager {
  private clients = new Map<string, Set<TrackedSocket>>();
  private wss: WebSocketServer;
  private heartbeat: NodeJS.Timeout;

  constructor(server: http.Server, config: Config, store: ManifestStore) {
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

      // Protected deployments require the same Basic Auth as the public
      // HTTP server, otherwise a third party who knows the URL could
      // observe update events for a private deployment.
      const resolved = store.resolveSlug(slug);
      const manifestEntry = resolved ? store.getEntry(resolved) : null;
      if (manifestEntry?.key && !basicAuthOk(req, manifestEntry.key)) {
        socket.destroy();
        return;
      }

      // Key by the canonical slug: broadcasts come from the store's "updated"
      // event, which always emits the canonical slug — a client that connected
      // via a name would never be reached under the host-derived key.
      const key = resolved ?? slug;

      this.wss.handleUpgrade(req, socket, head, (ws: TrackedSocket) => {
        if (!this.clients.has(key)) this.clients.set(key, new Set());
        const clientSet = this.clients.get(key)!;
        clientSet.add(ws);

        ws.isAlive = true;
        ws.on("pong", () => {
          ws.isAlive = true;
        });

        ws.on("close", () => {
          clientSet.delete(ws);
          if (clientSet.size === 0) this.clients.delete(key);
        });

        ws.on("error", () => {
          clientSet.delete(ws);
        });
      });
    });

    // Dead connections (client vanished without a clean close) never get
    // removed on their own — sweep periodically and terminate anything
    // that hasn't ponged since the previous sweep.
    this.heartbeat = setInterval(() => {
      for (const [slug, clientSet] of this.clients) {
        for (const ws of clientSet) {
          if (ws.isAlive === false) {
            clientSet.delete(ws);
            ws.terminate();
            continue;
          }
          ws.isAlive = false;
          ws.ping();
        }
        if (clientSet.size === 0) this.clients.delete(slug);
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
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
    clearInterval(this.heartbeat);
    this.wss.close();
  }
}
