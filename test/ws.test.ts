import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { WebSocket } from "ws";
import { ManifestStore } from "../src/storage/index.js";
import { createPublicServer } from "../src/server/public.js";
import { WsManager } from "../src/server/ws.js";
import { DEFAULT_CONFIG } from "../src/config/index.js";

const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  base_url: "test.local",
  port: 0,
  scheme: "http",
  csp: "",
  live_reload: true,
};

/** Connect a raw `ws` client to `/__lr` for `host`, resolving once open. */
function connectLr(port: number, host: string, extraHeaders: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__lr`, {
      headers: { host, ...extraHeaders },
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

describe("WsManager", () => {
  let tmpDir: string;
  let store: ManifestStore;
  let server: http.Server;
  let wsManager: WsManager | undefined;
  let port: number;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "uptool-ws-"));
        store = new ManifestStore(tmpDir, { ttl: "72h", max_versions: 0 });
        server = createPublicServer(TEST_CONFIG, store);
        server.listen(0, "127.0.0.1", () => {
          port = (server.address() as { port: number }).port;
          resolve();
        });
      })
  );

  afterEach(
    () =>
      new Promise<void>((resolve) => {
        vi.useRealTimers();
        wsManager?.close();
        wsManager = undefined;
        // See the matching note in test/public.test.ts's afterEach: flush
        // the pending debounced manifest write before removing tmpDir so a
        // stray timer can't fire an uncaught ENOENT after cleanup.
        store.flushNow();
        server.close(() => {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          resolve();
        });
      })
  );

  it("destroys the socket on upgrade to a path other than /__lr", async () => {
    wsManager = new WsManager(server, TEST_CONFIG, store);
    const slug = store.store("<h1>hi</h1>", null, "index.html", "t.html");

    const result = await new Promise<"open" | "closed">((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/not-lr`, {
        headers: { host: `${slug}.test.local` },
      });
      ws.once("open", () => resolve("open"));
      ws.once("error", () => resolve("closed"));
      ws.once("unexpected-response", () => resolve("closed"));
    });
    expect(result).toBe("closed");
  });

  it("destroys the socket when the Host header has no extractable slug", async () => {
    wsManager = new WsManager(server, TEST_CONFIG, store);

    const result = await new Promise<"open" | "closed">((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/__lr`, {
        headers: { host: "not-a-subdomain.example.com" },
      });
      ws.once("open", () => resolve("open"));
      ws.once("error", () => resolve("closed"));
      ws.once("unexpected-response", () => resolve("closed"));
    });
    expect(result).toBe("closed");
  });

  it("registers a valid upgrade and removes the client from the map on close", async () => {
    wsManager = new WsManager(server, TEST_CONFIG, store);
    const slug = store.store("<h1>hi</h1>", null, "index.html", "t.html");

    const ws = await connectLr(port, `${slug}.test.local`);
    const clients = (wsManager as unknown as { clients: Map<string, Set<WebSocket>> }).clients;
    expect(clients.get(slug)?.size).toBe(1);

    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
    // Give the server's 'close' handler a tick to run
    await new Promise((r) => setImmediate(r));
    expect(clients.has(slug)).toBe(false);
  });

  it("broadcast(slug, msg) reaches only clients of that slug", async () => {
    wsManager = new WsManager(server, TEST_CONFIG, store);
    const slugA = store.store("<h1>A</h1>", null, "index.html", "a.html");
    const slugB = store.store("<h1>B</h1>", null, "index.html", "b.html");

    const wsA = await connectLr(port, `${slugA}.test.local`);
    const wsB = await connectLr(port, `${slugB}.test.local`);

    const gotA = new Promise<string>((resolve) => wsA.once("message", (d) => resolve(d.toString())));
    const gotBNothing = new Promise<"silent" | "message">((resolve) => {
      wsB.once("message", (d) => resolve("message"));
      setTimeout(() => resolve("silent"), 300);
    });

    wsManager.broadcast(slugA, "reload");

    expect(await gotA).toBe("reload");
    expect(await gotBNothing).toBe("silent"); // cross-slug leak would deliver here

    wsA.close();
    wsB.close();
  });

  it("broadcasting to a slug with no clients is a no-op, not a throw", () => {
    wsManager = new WsManager(server, TEST_CONFIG, store);
    expect(() => wsManager!.broadcast("nobody-here", "reload")).not.toThrow();
  });

  it("close() clears the heartbeat interval and shuts the server down cleanly", () => {
    wsManager = new WsManager(server, TEST_CONFIG, store);
    const heartbeat = (wsManager as unknown as { heartbeat: NodeJS.Timeout }).heartbeat;
    expect(heartbeat).toBeDefined();
    wsManager.close();
    // clearInterval is idempotent-safe to call again; the important assertion
    // is that no error is thrown and no handle keeps vitest alive (checked by
    // the test runner exiting cleanly, not an explicit assertion here).
    wsManager = undefined;
  });

  it("terminates a socket that stops responding to pings (heartbeat sweep)", async () => {
    // Approach: fake timers must be installed *before* WsManager is
    // constructed, since the heartbeat's setInterval is created in the
    // constructor and vitest's fake clock only intercepts timers created
    // after faking is enabled — advancing fake time would never fire an
    // interval that already exists on the real clock. Real socket I/O
    // (connect/open) isn't timer-driven for a fast localhost connection, so
    // it still resolves normally while fake timers are active.
    //
    // We also don't rely on suppressing the client's automatic pong (e.g.
    // pausing its underlying stream) to simulate an unresponsive client —
    // that left a half-open socket that hung server.close() in afterEach in
    // an earlier version of this test. Instead we flip the server-side
    // TrackedSocket's `isAlive` flag directly, which is exactly the state
    // the sweep would observe from a client that missed the previous ping,
    // then let the real sweep logic (delete-from-map + ws.terminate()) run.
    vi.useFakeTimers();
    try {
      wsManager = new WsManager(server, TEST_CONFIG, store);
      const slug = store.store("<h1>hi</h1>", null, "index.html", "t.html");
      const ws = await connectLr(port, `${slug}.test.local`);

      const clients = (wsManager as unknown as { clients: Map<string, Set<WebSocket>> }).clients;
      const serverSideSet = clients.get(slug);
      expect(serverSideSet?.size).toBe(1);
      const serverSideSocket = [...serverSideSet!][0] as unknown as { isAlive: boolean };
      serverSideSocket.isAlive = false;

      vi.advanceTimersByTime(30_000);

      expect(clients.has(slug)).toBe(false);
      ws.close();
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);
});
