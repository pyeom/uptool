import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { ManifestStore } from "../src/storage/index.js";
import { createPublicServer } from "../src/server/public.js";
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
  urlPath = "/"
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: "127.0.0.1", port: addr.port, path: urlPath, headers: { host } },
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

  it("resolves named slug", async () => {
    store.store("<h1>Named</h1>", null, "index.html", "n.html", "myapp");
    const { status, body } = await makeRequest(server, "myapp.test.local");
    expect(status).toBe(200);
    expect(body).toBe("<h1>Named</h1>");
  });
});
