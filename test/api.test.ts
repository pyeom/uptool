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

function apiRequest(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path: urlPath,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: raw });
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
        server = createApiServer(TEST_CONFIG, store);
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
  // Unknown routes
  // -------------------------------------------------------------------------

  it("returns 404 for unknown route", async () => {
    const { status } = await apiRequest(server, "GET", "/unknown");
    expect(status).toBe(404);
  });
});
