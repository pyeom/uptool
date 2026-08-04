import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { WebSocket } from "ws";
import { ManifestStore, type Manifest } from "../src/storage/index.js";
import { createPublicServer, RateLimiter } from "../src/server/public.js";
import { WsManager } from "../src/server/ws.js";
import { DEFAULT_CONFIG } from "../src/config/index.js";

// Minimal config for tests
const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  base_url: "test.local",
  port: 0,
  scheme: "http",
  csp: "default-src 'self';",
  live_reload: false, // disable for simpler assertions
};

function makeRequest(
  server: http.Server,
  host: string,
  urlPath = "/",
  extraHeaders: http.OutgoingHttpHeaders = {},
  method = "GET"
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path: urlPath,
        method,
        headers: { host, ...extraHeaders },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Public server", () => {
  let tmpDir: string;
  let store: ManifestStore;
  let server: http.Server;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "uptool-pub-"));
        store = new ManifestStore(tmpDir, { ttl: "72h", max_versions: 0 });
        server = createPublicServer(TEST_CONFIG, store);
        server.listen(0, "127.0.0.1", resolve);
      })
  );

  afterEach(
    () =>
      new Promise<void>((resolve) => {
        // Flush any pending debounced manifest write before deleting tmpDir —
        // otherwise the 500ms debounce timer from a store()/update() call in
        // this test can fire after tmpDir is gone, throwing an uncaught
        // ENOENT from inside the timer (a pre-existing race in ManifestStore
        // flushing; flushing eagerly here just avoids tripping it in tests).
        store.flushNow();
        server.close(() => {
          fs.rmSync(tmpDir, { recursive: true });
          resolve();
        });
      })
  );

  it("serves HTML for a valid slug", async () => {
    const slug = store.store("<h1>Hello</h1>", null, "index.html", "t.html");
    const { status, body, headers } = await makeRequest(
      server,
      `${slug}.test.local`
    );
    expect(status).toBe(200);
    expect(body).toBe("<h1>Hello</h1>");
    expect(headers["content-type"]).toContain("text/html");
  });

  it("returns 404 for unknown slug", async () => {
    const { status } = await makeRequest(server, "unknownxx.test.local");
    expect(status).toBe(404);
  });

  it("serves asset by path with correct mime type", async () => {
    const html = Buffer.from("<h1>hi</h1>").toString("base64");
    const css = Buffer.from("body{color:red}").toString("base64");
    const slug = store.store(
      null,
      { "index.html": html, "style.css": css },
      "index.html",
      "site"
    );

    const { status, body, headers } = await makeRequest(
      server,
      `${slug}.test.local`,
      "/style.css"
    );
    expect(status).toBe(200);
    expect(body).toBe("body{color:red}");
    expect(headers["content-type"]).toContain("text/css");
  });

  it("adds security headers", async () => {
    const slug = store.store("<p>hi</p>", null, "index.html", "t.html");
    const { headers } = await makeRequest(server, `${slug}.test.local`);
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["content-security-policy"]).toBe(TEST_CONFIG.csp);
  });

  it("injects live-reload script when live_reload=true", async () => {
    const lrConfig = { ...TEST_CONFIG, live_reload: true };
    const lrServer = createPublicServer(lrConfig, store);
    await new Promise<void>((r) => lrServer.listen(0, "127.0.0.1", r));

    const slug = store.store("<h1>hi</h1></body>", null, "index.html", "t.html");
    const { body } = await makeRequest(lrServer, `${slug}.test.local`);
    expect(body).toContain("/__lr");
    expect(body).toContain("location.reload");

    await new Promise<void>((r) => lrServer.close(r));
  });

  it("returns 404 for path traversal attempts", async () => {
    const slug = store.store("<h1>safe</h1>", null, "index.html", "s.html");
    const { status } = await makeRequest(
      server,
      `${slug}.test.local`,
      "/../../../etc/passwd"
    );
    expect(status).toBe(404);
  });

  it("returns 200 for root when no slug in host", async () => {
    const { status, body } = await makeRequest(server, "notasubdomain.example.com");
    expect(status).toBe(200);
    expect(body).toContain("uptool");
  });

  it("returns identical Content-Length and empty body for HEAD", async () => {
    const slug = store.store("<h1>Hello</h1>", null, "index.html", "t.html");
    const get = await makeRequest(server, `${slug}.test.local`, "/", {}, "GET");
    const head = await makeRequest(server, `${slug}.test.local`, "/", {}, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
    expect(head.body).toBe("");
  });

  it("returns 405 with Allow header for unsupported methods", async () => {
    const slug = store.store("<h1>Hello</h1>", null, "index.html", "t.html");
    const { status, headers } = await makeRequest(
      server, `${slug}.test.local`, "/", {}, "POST"
    );
    expect(status).toBe(405);
    expect(headers["allow"]).toBe("GET, HEAD");
  });

  it("resolves named slug", async () => {
    store.store("<h1>Named</h1>", null, "index.html", "n.html", "myapp");
    const { status, body } = await makeRequest(server, "myapp.test.local");
    expect(status).toBe(200);
    expect(body).toBe("<h1>Named</h1>");
  });

  // -------------------------------------------------------------------------
  // Protected deployments (Basic Auth)
  // -------------------------------------------------------------------------

  describe("protected deployments", () => {
    const basic = (user: string, pass: string) => ({
      Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
    });

    it("returns 401 with WWW-Authenticate when no credentials", async () => {
      const slug = store.store(
        "<h1>Secret</h1>", null, "index.html", "s.html", undefined, "sekret"
      );
      const { status, headers, body } = await makeRequest(server, `${slug}.test.local`);
      expect(status).toBe(401);
      expect(headers["www-authenticate"]).toContain("Basic");
      expect(body).not.toContain("Secret");
    });

    it("returns 401 with wrong password", async () => {
      const slug = store.store(
        "<h1>Secret</h1>", null, "index.html", "s.html", undefined, "sekret"
      );
      const { status } = await makeRequest(
        server, `${slug}.test.local`, "/", basic("u", "wrong")
      );
      expect(status).toBe(401);
    });

    it("serves content with correct password, any username", async () => {
      const slug = store.store(
        "<h1>Secret</h1>", null, "index.html", "s.html", undefined, "sekret"
      );
      const a = await makeRequest(server, `${slug}.test.local`, "/", basic("alice", "sekret"));
      expect(a.status).toBe(200);
      expect(a.body).toBe("<h1>Secret</h1>");
      const b = await makeRequest(server, `${slug}.test.local`, "/", basic("", "sekret"));
      expect(b.status).toBe(200);
    });

    it("protects bundle assets too", async () => {
      const files = {
        "index.html": Buffer.from("<h1>hi</h1>").toString("base64"),
        "app.js": Buffer.from("console.log(1)").toString("base64"),
      };
      const slug = store.store(null, files, "index.html", "site", undefined, "sekret");
      const noAuth = await makeRequest(server, `${slug}.test.local`, "/app.js");
      expect(noAuth.status).toBe(401);
      const withAuth = await makeRequest(
        server, `${slug}.test.local`, "/app.js", basic("x", "sekret")
      );
      expect(withAuth.status).toBe(200);
    });

    it("leaves unprotected slugs open", async () => {
      const slug = store.store("<h1>Open</h1>", null, "index.html", "o.html");
      const { status } = await makeRequest(server, `${slug}.test.local`);
      expect(status).toBe(200);
    });

    it("update with undefined key keeps protection; empty string removes it", async () => {
      const slug = store.store(
        "<h1>v1</h1>", null, "index.html", "s.html", undefined, "sekret"
      );
      store.update(slug, "<h1>v2</h1>", null, "index.html", "s.html");
      expect((await makeRequest(server, `${slug}.test.local`)).status).toBe(401);

      store.update(slug, "<h1>v3</h1>", null, "index.html", "s.html", "");
      expect((await makeRequest(server, `${slug}.test.local`)).status).toBe(200);
    });
  });

  describe("live-reload websocket auth", () => {
    it("rejects /__lr upgrade on a protected slug without credentials", async () => {
      const wsManager = new WsManager(server, TEST_CONFIG, store);
      const slug = store.store(
        "<h1>Secret</h1>", null, "index.html", "s.html", undefined, "sekret"
      );
      const addr = server.address() as { port: number };
      const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/__lr`, {
        headers: { host: `${slug}.test.local` },
      });
      await new Promise<void>((resolve) => {
        ws.on("unexpected-response", () => resolve());
        ws.on("error", () => resolve());
        ws.on("open", () => resolve());
      });
      expect(ws.readyState).not.toBe(WebSocket.OPEN);
      wsManager.close();
    });

    it("accepts /__lr upgrade on a protected slug with correct Basic Auth", async () => {
      const wsManager = new WsManager(server, TEST_CONFIG, store);
      const slug = store.store(
        "<h1>Secret</h1>", null, "index.html", "s.html", undefined, "sekret"
      );
      const addr = server.address() as { port: number };
      const auth = `Basic ${Buffer.from("u:sekret").toString("base64")}`;
      const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/__lr`, {
        headers: { host: `${slug}.test.local`, authorization: auth },
      });
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      wsManager.close();
    });
  });

  // -------------------------------------------------------------------------
  // Cache-Control per content type
  // -------------------------------------------------------------------------

  describe("Cache-Control", () => {
    it("protected deployments get 'private, no-store' regardless of content type", async () => {
      const slug = store.store(
        "<h1>Secret</h1>", null, "index.html", "s.html", undefined, "sekret"
      );
      const auth = { Authorization: `Basic ${Buffer.from("u:sekret").toString("base64")}` };
      const { headers } = await makeRequest(server, `${slug}.test.local`, "/", auth);
      expect(headers["cache-control"]).toBe("private, no-store");
    });

    it("HTML gets 'no-cache'", async () => {
      const slug = store.store("<h1>hi</h1>", null, "index.html", "t.html");
      const { headers } = await makeRequest(server, `${slug}.test.local`);
      expect(headers["cache-control"]).toBe("no-cache");
    });

    it("other assets get 'public, max-age=3600'", async () => {
      const files = {
        "index.html": Buffer.from("<h1>hi</h1>").toString("base64"),
        "style.css": Buffer.from("body{}").toString("base64"),
      };
      const slug = store.store(null, files, "index.html", "site");
      const { headers } = await makeRequest(server, `${slug}.test.local`, "/style.css");
      expect(headers["cache-control"]).toBe("public, max-age=3600");
    });
  });

  // -------------------------------------------------------------------------
  // Basic Auth edge cases (beyond the "protected deployments" block above)
  // -------------------------------------------------------------------------

  describe("Basic Auth edge cases", () => {
    it("malformed/undecodable Authorization header returns 401, no crash", async () => {
      const slug = store.store(
        "<h1>Secret</h1>", null, "index.html", "s.html", undefined, "sekret"
      );
      const { status } = await makeRequest(server, `${slug}.test.local`, "/", {
        Authorization: "NotBasic garbage!!!",
      });
      expect(status).toBe(401);

      const { status: status2 } = await makeRequest(server, `${slug}.test.local`, "/", {
        Authorization: "Basic",
      });
      expect(status2).toBe(401);
    });

    it("a password of the wrong length returns 401 without throwing", async () => {
      const slug = store.store(
        "<h1>Secret</h1>", null, "index.html", "s.html", undefined, "sekret"
      );
      const shortPass = {
        Authorization: `Basic ${Buffer.from("u:short").toString("base64")}`,
      };
      const longPass = {
        Authorization: `Basic ${Buffer.from("u:way-too-long-password").toString("base64")}`,
      };
      expect((await makeRequest(server, `${slug}.test.local`, "/", shortPass)).status).toBe(401);
      expect((await makeRequest(server, `${slug}.test.local`, "/", longPass)).status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // RateLimiter (exported from public.ts)
  // -------------------------------------------------------------------------

  describe("RateLimiter", () => {
    it("allows up to the limit then blocks", () => {
      const rl = new RateLimiter(3);
      expect(rl.allow("1.2.3.4")).toBe(true);
      expect(rl.allow("1.2.3.4")).toBe(true);
      expect(rl.allow("1.2.3.4")).toBe(true);
      expect(rl.allow("1.2.3.4")).toBe(false);
    });

    it("a 429 response carries Retry-After", async () => {
      const limitedConfig = { ...TEST_CONFIG, rate_limit_rpm: 1 };
      const limitedServer = createPublicServer(limitedConfig, store);
      await new Promise<void>((r) => limitedServer.listen(0, "127.0.0.1", r));

      const slug = store.store("<h1>hi</h1>", null, "index.html", "t.html");
      await makeRequest(limitedServer, `${slug}.test.local`);
      const second = await makeRequest(limitedServer, `${slug}.test.local`);
      expect(second.status).toBe(429);
      expect(second.headers["retry-after"]).toBe("60");

      await new Promise<void>((r) => limitedServer.close(r));
    });

    it("limit <= 0 disables it entirely", () => {
      const rl = new RateLimiter(0);
      for (let i = 0; i < 1000; i++) expect(rl.allow("same-ip")).toBe(true);
      const rlNeg = new RateLimiter(-5);
      expect(rlNeg.allow("same-ip")).toBe(true);
    });

    it("prune() drops expired windows so the map can't grow unbounded", () => {
      vi.useFakeTimers();
      try {
        const rl = new RateLimiter(2);
        rl.allow("1.1.1.1");
        rl.allow("2.2.2.2");
        expect((rl as unknown as { hits: Map<string, unknown> }).hits.size).toBe(2);

        vi.advanceTimersByTime(61_000); // past the 60s fixed window
        rl.prune();
        expect((rl as unknown as { hits: Map<string, unknown> }).hits.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // -------------------------------------------------------------------------
  // trust_proxy
  // -------------------------------------------------------------------------

  describe("trust_proxy", () => {
    it("with trust_proxy ON, rate limiting keys off X-Forwarded-For (first entry)", async () => {
      const trustingConfig = { ...TEST_CONFIG, rate_limit_rpm: 1, trust_proxy: true };
      const trustingServer = createPublicServer(trustingConfig, store);
      await new Promise<void>((r) => trustingServer.listen(0, "127.0.0.1", r));

      const slug = store.store("<h1>hi</h1>", null, "index.html", "t.html");
      // Two different spoofed X-Forwarded-For IPs must be tracked separately
      const a1 = await makeRequest(trustingServer, `${slug}.test.local`, "/", {
        "X-Forwarded-For": "9.9.9.1, 5.5.5.5",
      });
      const a2 = await makeRequest(trustingServer, `${slug}.test.local`, "/", {
        "X-Forwarded-For": "9.9.9.2, 5.5.5.5",
      });
      expect(a1.status).toBe(200);
      expect(a2.status).toBe(200); // different forwarded IP, own quota

      // Same forwarded IP hits its own limit on the second request
      const b1 = await makeRequest(trustingServer, `${slug}.test.local`, "/", {
        "X-Forwarded-For": "9.9.9.3",
      });
      const b2 = await makeRequest(trustingServer, `${slug}.test.local`, "/", {
        "X-Forwarded-For": "9.9.9.3",
      });
      expect(b1.status).toBe(200);
      expect(b2.status).toBe(429);

      await new Promise<void>((r) => trustingServer.close(r));
    });

    it("with trust_proxy OFF, X-Forwarded-For is ignored (socket address used)", async () => {
      const ignoringConfig = { ...TEST_CONFIG, rate_limit_rpm: 1, trust_proxy: false };
      const ignoringServer = createPublicServer(ignoringConfig, store);
      await new Promise<void>((r) => ignoringServer.listen(0, "127.0.0.1", r));

      const slug = store.store("<h1>hi</h1>", null, "index.html", "t.html");
      // Spoofing different X-Forwarded-For values must NOT bypass the limit —
      // both requests come from the same real socket (127.0.0.1 test client).
      const c1 = await makeRequest(ignoringServer, `${slug}.test.local`, "/", {
        "X-Forwarded-For": "1.1.1.1",
      });
      const c2 = await makeRequest(ignoringServer, `${slug}.test.local`, "/", {
        "X-Forwarded-For": "2.2.2.2",
      });
      expect(c1.status).toBe(200);
      expect(c2.status).toBe(429);

      await new Promise<void>((r) => ignoringServer.close(r));
    });
  });

  // -------------------------------------------------------------------------
  // Extensionless URL resolution / directory index
  // -------------------------------------------------------------------------

  describe("extensionless URL resolution", () => {
    it("serves about.html for /about", async () => {
      const files = {
        "index.html": Buffer.from("<h1>home</h1>").toString("base64"),
        "about.html": Buffer.from("<h1>about</h1>").toString("base64"),
      };
      const slug = store.store(null, files, "index.html", "site");
      const { status, body } = await makeRequest(server, `${slug}.test.local`, "/about");
      expect(status).toBe(200);
      expect(body).toBe("<h1>about</h1>");
    });

    it("serves index.html inside a directory path", async () => {
      const files = {
        "index.html": Buffer.from("<h1>home</h1>").toString("base64"),
        "blog/index.html": Buffer.from("<h1>blog</h1>").toString("base64"),
      };
      const slug = store.store(null, files, "index.html", "site");
      const { status, body } = await makeRequest(server, `${slug}.test.local`, "/blog");
      expect(status).toBe(200);
      expect(body).toBe("<h1>blog</h1>");
    });

    it("404s for a directory with no index.html inside it", async () => {
      const files = {
        "index.html": Buffer.from("<h1>home</h1>").toString("base64"),
        "empty/placeholder.txt": Buffer.from("x").toString("base64"),
      };
      const slug = store.store(null, files, "index.html", "site");
      const { status } = await makeRequest(server, `${slug}.test.local`, "/empty");
      expect(status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Expired deployment
  // -------------------------------------------------------------------------

  it("returns 404 for an expired deployment without deleting it", async () => {
    const slug = store.store("<h1>gone</h1>", null, "index.html", "t.html");
    (store as unknown as { manifest: Manifest }).manifest[slug].expires = Date.now() - 1000;

    const { status } = await makeRequest(server, `${slug}.test.local`);
    expect(status).toBe(404);
    // readFile refuses to serve past expiry without deleting — entry persists
    expect(store.getEntry(slug)).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // View counting (recordHit)
  // -------------------------------------------------------------------------

  describe("view counting", () => {
    it("an HTML page view increments hits by exactly one", async () => {
      const slug = store.store("<h1>hi</h1>", null, "index.html", "t.html");
      await makeRequest(server, `${slug}.test.local`);
      expect(store.getEntry(slug)!.hits).toBe(1);
    });

    it("fetching a CSS/JS/image asset does not increment", async () => {
      const files = {
        "index.html": Buffer.from("<h1>hi</h1>").toString("base64"),
        "style.css": Buffer.from("body{}").toString("base64"),
        "app.js": Buffer.from("console.log(1)").toString("base64"),
      };
      const slug = store.store(null, files, "index.html", "site");
      await makeRequest(server, `${slug}.test.local`, "/style.css");
      await makeRequest(server, `${slug}.test.local`, "/app.js");
      expect(store.getEntry(slug)!.hits).toBeUndefined();
    });

    it("a 404 does not increment", async () => {
      const slug = store.store("<h1>hi</h1>", null, "index.html", "t.html");
      await makeRequest(server, `${slug}.test.local`, "/nope.html");
      expect(store.getEntry(slug)!.hits).toBeUndefined();
    });

    it("a HEAD request does not increment", async () => {
      const slug = store.store("<h1>hi</h1>", null, "index.html", "t.html");
      await makeRequest(server, `${slug}.test.local`, "/", {}, "HEAD");
      expect(store.getEntry(slug)!.hits).toBeUndefined();
    });

    it("a 401 on a protected deployment does not increment, a successful authenticated view does", async () => {
      const slug = store.store(
        "<h1>Secret</h1>", null, "index.html", "s.html", undefined, "sekret"
      );
      await makeRequest(server, `${slug}.test.local`);
      expect(store.getEntry(slug)!.hits).toBeUndefined();

      const auth = { Authorization: `Basic ${Buffer.from("u:sekret").toString("base64")}` };
      await makeRequest(server, `${slug}.test.local`, "/", auth);
      expect(store.getEntry(slug)!.hits).toBe(1);
    });
  });

  it("a handler that throws produces a 500, not a dead daemon", async () => {
    const slug = store.store("<h1>hi</h1>", null, "index.html", "t.html");
    const original = store.readFile.bind(store);
    store.readFile = () => {
      throw new Error("boom");
    };
    try {
      const { status } = await makeRequest(server, `${slug}.test.local`);
      expect(status).toBe(500);
    } finally {
      store.readFile = original;
    }

    // Daemon survives — a normal request right after still works.
    const { status } = await makeRequest(server, `${slug}.test.local`);
    expect(status).toBe(200);
  });
});
