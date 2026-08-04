import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { ManifestStore } from "../src/storage/index.js";
import { createApiServer } from "../src/server/api.js";
import { DEFAULT_CONFIG } from "../src/config/index.js";

const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  base_url: "test.local",
  api_port: 0,
  max_body_bytes: 1024, // small limit for testing
};

const TEST_TOKEN = "test-token-abc123";

function apiRequest(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
  token: string | null = TEST_TOKEN
): Promise<{ status: number; data: unknown; contentType?: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path: urlPath,
        method,
        headers: {
          ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let raw = "";
        const contentType = res.headers["content-type"];
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw), contentType });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: raw, contentType });
          }
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("API server", () => {
  let tmpDir: string;
  let store: ManifestStore;
  let server: http.Server;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "uptool-api-"));
        store = new ManifestStore(tmpDir, { ttl: "72h", max_versions: 5 });
        server = createApiServer(TEST_CONFIG, store, TEST_TOKEN);
        server.listen(0, "127.0.0.1", resolve);
      })
  );

  afterEach(
    () =>
      new Promise<void>((resolve) => {
        store.flushNow();
        server.close(() => {
          fs.rmSync(tmpDir, { recursive: true });
          resolve();
        });
      })
  );

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  it("rejects requests without a token", async () => {
    const { status } = await apiRequest(server, "GET", "/files", undefined, null);
    expect(status).toBe(401);
  });

  it("rejects requests with a wrong token", async () => {
    const { status } = await apiRequest(server, "GET", "/files", undefined, "wrong-token");
    expect(status).toBe(401);
  });

  it("rejects deploy without a token", async () => {
    const { status } = await apiRequest(
      server,
      "POST",
      "/deploy",
      { html: "<h1>x</h1>" },
      null
    );
    expect(status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // POST /deploy
  // -------------------------------------------------------------------------

  it("deploys single HTML and returns a slug", async () => {
    const { status, data } = await apiRequest(server, "POST", "/deploy", {
      html: "<h1>Test</h1>",
    });
    expect(status).toBe(200);
    expect((data as { slug: string }).slug).toMatch(/^[a-z0-9]{8}$/);
  });

  it("deploys a bundle and returns a slug", async () => {
    const files = {
      "index.html": Buffer.from("<h1>Bundle</h1>").toString("base64"),
      "style.css": Buffer.from("body{}").toString("base64"),
    };
    const { status, data } = await apiRequest(server, "POST", "/deploy", {
      files,
      entry: "index.html",
      filename: "mysite",
    });
    expect(status).toBe(200);
    const slug = (data as { slug: string }).slug;
    expect(slug).toMatch(/^[a-z0-9]{8}$/);

    // Verify bundle stored correctly
    const result = store.readFile(slug, "/style.css");
    expect(result).not.toBeNull();
    expect(result!.buffer.toString()).toBe("body{}");
  });

  it("updates existing deployment by slug", async () => {
    const { data: d1 } = await apiRequest(server, "POST", "/deploy", {
      html: "<h1>v1</h1>",
    });
    const slug = (d1 as { slug: string }).slug;

    const { status, data: d2 } = await apiRequest(server, "POST", "/deploy", {
      html: "<h1>v2</h1>",
      slug,
    });
    expect(status).toBe(200);
    expect((d2 as { slug: string }).slug).toBe(slug);
    expect(store.readFile(slug, "/")!.buffer.toString()).toBe("<h1>v2</h1>");
  });

  it("rejects missing html and files", async () => {
    const { status } = await apiRequest(server, "POST", "/deploy", { filename: "test.html" });
    expect(status).toBe(400);
  });

  it("rejects invalid named slug", async () => {
    const { status, data } = await apiRequest(server, "POST", "/deploy", {
      html: "<h1>x</h1>",
      name: "INVALID NAME!",
    });
    expect(status).toBe(400);
    expect((data as { error: string }).error).toContain("Invalid name");
  });

  it("stores with a valid name", async () => {
    const { status, data } = await apiRequest(server, "POST", "/deploy", {
      html: "<h1>Named</h1>",
      name: "my-app",
    });
    expect(status).toBe(200);
    expect(store.resolveSlug("my-app")).not.toBeNull();
    void data;
  });

  it("returns 413 when body exceeds max_body_bytes", async () => {
    const big = "x".repeat(2000); // over the 1024 test limit
    const { status } = await apiRequest(server, "POST", "/deploy", { html: big });
    expect(status).toBe(413);
  });

  it("returns 413 when a file exceeds max_file_size", async () => {
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "uptool-api-lim-"));
    const limitedStore = new ManifestStore(tmpDir2, {
      ttl: "72h",
      max_versions: 5,
      max_file_size: 100,
    });
    const limitedServer = createApiServer(TEST_CONFIG, limitedStore, TEST_TOKEN);
    await new Promise<void>((resolve) => limitedServer.listen(0, "127.0.0.1", resolve));

    try {
      const { status, data } = await apiRequest(limitedServer, "POST", "/deploy", {
        html: "x".repeat(500),
      });
      expect(status).toBe(413);
      expect((data as { error: string }).error).toContain("max_file_size");
    } finally {
      limitedStore.flushNow();
      await new Promise<void>((resolve) => limitedServer.close(() => resolve()));
      fs.rmSync(tmpDir2, { recursive: true });
    }
  });

  // -------------------------------------------------------------------------
  // GET /files
  // -------------------------------------------------------------------------

  it("lists all deployments", async () => {
    store.store("<h1>A</h1>", null, "index.html", "a.html");
    store.store("<h1>B</h1>", null, "index.html", "b.html");

    const { status, data } = await apiRequest(server, "GET", "/files");
    expect(status).toBe(200);
    expect((data as { files: unknown[] }).files.length).toBe(2);
  });

  it("returns empty list when no deployments", async () => {
    const { status, data } = await apiRequest(server, "GET", "/files");
    expect(status).toBe(200);
    expect((data as { files: unknown[] }).files.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // DELETE /files/:slug
  // -------------------------------------------------------------------------

  it("removes a deployment", async () => {
    const slug = store.store("<h1>bye</h1>", null, "index.html", "b.html");
    const { status, data } = await apiRequest(server, "DELETE", `/files/${slug}`);
    expect(status).toBe(200);
    expect((data as { removed: boolean }).removed).toBe(true);
    expect(store.getEntry(slug)).toBeNull();
  });

  it("returns 404 when removing non-existent slug", async () => {
    const { status } = await apiRequest(server, "DELETE", "/files/nothere1");
    expect(status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // POST /files/:slug/rollback
  // -------------------------------------------------------------------------

  it("rolls back a deployment", async () => {
    const slug = store.store("<h1>v1</h1>", null, "index.html", "t.html");
    store.update(slug, "<h1>v2</h1>", null, "index.html", "t.html");

    const { status, data } = await apiRequest(server, "POST", `/files/${slug}/rollback`);
    expect(status).toBe(200);
    expect((data as { restored: string }).restored).toBeTruthy();
    expect(store.readFile(slug, "/")!.buffer.toString()).toBe("<h1>v1</h1>");
  });

  it("returns 404 rollback when no versions", async () => {
    const slug = store.store("<h1>only</h1>", null, "index.html", "t.html");
    const { status } = await apiRequest(server, "POST", `/files/${slug}/rollback`);
    expect(status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // POST /files/:slug/touch
  // -------------------------------------------------------------------------

  it("touch renews expiry", async () => {
    const slug = store.store("<p>t</p>", null, "index.html", "t.html");
    const before = store.getEntry(slug)!.expires;
    const { status, data } = await apiRequest(server, "POST", `/files/${slug}/touch`, {
      ttl: "7d",
    });
    expect(status).toBe(200);
    expect((data as { expires: number }).expires).toBeGreaterThan(before);
  });

  it("touch with ttl 0 sets never-expire", async () => {
    const slug = store.store("<p>t</p>", null, "index.html", "t.html");
    const { status, data } = await apiRequest(server, "POST", `/files/${slug}/touch`, {
      ttl: "0",
    });
    expect(status).toBe(200);
    expect((data as { expires: number }).expires).toBe(0);
  });

  it("touch returns 404 for unknown slug", async () => {
    const { status } = await apiRequest(server, "POST", "/files/nothere1/touch", {
      ttl: "7d",
    });
    expect(status).toBe(404);
  });

  it("touch returns 400 on invalid ttl", async () => {
    const slug = store.store("<p>t</p>", null, "index.html", "t.html");
    const { status } = await apiRequest(server, "POST", `/files/${slug}/touch`, {
      ttl: "banana",
    });
    expect(status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Protected deploys (key)
  // -------------------------------------------------------------------------

  it("stores the access key from the deploy body", async () => {
    const { status, data } = await apiRequest(server, "POST", "/deploy", {
      html: "<h1>secret</h1>",
      key: "sekret",
    });
    expect(status).toBe(200);
    const slug = (data as { slug: string }).slug;
    expect(store.getEntry(slug)!.key).toBe("sekret");
  });

  it("update without key keeps existing protection", async () => {
    const { data } = await apiRequest(server, "POST", "/deploy", {
      html: "<h1>v1</h1>",
      key: "sekret",
    });
    const slug = (data as { slug: string }).slug;
    await apiRequest(server, "POST", "/deploy", { html: "<h1>v2</h1>", slug });
    expect(store.getEntry(slug)!.key).toBe("sekret");
  });

  // -------------------------------------------------------------------------
  // Unknown routes
  // -------------------------------------------------------------------------

  it("returns 404 for unknown route", async () => {
    const { status } = await apiRequest(server, "GET", "/unknown");
    expect(status).toBe(404);
  });

  it("returns 404 for /admin (removed)", async () => {
    const { status } = await apiRequest(server, "GET", "/admin");
    expect(status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Body reassembly across chunk boundaries (UTF-8 safety)
  // -------------------------------------------------------------------------

  it("reassembles a multi-byte UTF-8 char split across TCP chunks without corruption", async () => {
    // Use a dedicated server with a large enough max_body_bytes.
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "uptool-api-utf8-"));
    const bigStore = new ManifestStore(tmpDir2, { ttl: "72h", max_versions: 5 });
    const bigConfig = { ...TEST_CONFIG, max_body_bytes: 1024 * 1024 };
    const bigServer = createApiServer(bigConfig, bigStore, TEST_TOKEN);
    await new Promise<void>((resolve) => bigServer.listen(0, "127.0.0.1", resolve));

    try {
      // Build HTML well over 64KB containing accented chars and an emoji.
      const filler = "café ".repeat(15000); // > 64KB, includes accented chars
      const html = filler + "🎉END";
      const payloadStr = JSON.stringify({ html });
      const payloadBuf = Buffer.from(payloadStr, "utf8");
      expect(payloadBuf.length).toBeGreaterThan(65536);

      // Find a multi-byte character and split the buffer inside its byte
      // sequence, so no single "chunk" write contains a complete character.
      const emojiBuf = Buffer.from("🎉", "utf8"); // 4 bytes
      const emojiIdx = payloadBuf.indexOf(emojiBuf);
      expect(emojiIdx).toBeGreaterThan(-1);
      const splitAt = emojiIdx + 2; // split mid-character

      const chunk1 = payloadBuf.subarray(0, splitAt);
      const chunk2 = payloadBuf.subarray(splitAt);

      const addr = bigServer.address() as { port: number };

      const parsed = await new Promise<{ slug: string }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: addr.port,
            path: "/deploy",
            method: "POST",
            headers: {
              Authorization: `Bearer ${TEST_TOKEN}`,
              "Content-Type": "application/json",
              "Content-Length": payloadBuf.length,
            },
          },
          (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () => {
              expect(res.statusCode).toBe(200);
              resolve(JSON.parse(raw) as { slug: string });
            });
          }
        );
        req.on("error", reject);
        req.on("socket", (socket) => socket.setNoDelay(true));
        req.write(chunk1, () => {
          // Force the two chunks onto separate TCP reads on the server side.
          setTimeout(() => req.end(chunk2), 20);
        });
      });

      const stored = bigStore.readFile(parsed.slug, "/");
      expect(stored).not.toBeNull();
      expect(stored!.buffer.toString("utf8")).toBe(html);
    } finally {
      bigStore.flushNow();
      await new Promise<void>((resolve) => bigServer.close(() => resolve()));
      fs.rmSync(tmpDir2, { recursive: true });
    }
  });
});
