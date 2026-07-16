import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import * as net from "node:net";
import * as child_process from "node:child_process";

/**
 * End-to-end suite: builds the CLI (if needed) and drives the real daemon as
 * a child process — the only test file here that doesn't use in-process
 * harnesses. Exercises deploy / fetch / auth / touch / protect / remove
 * through the actual API + public HTTP servers.
 */

const ROOT = path.join(__dirname, "..");
const CLI_PATH = path.join(ROOT, "dist", "cli.js");

/** Find a free TCP port by binding to port 0 and reading it back. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

/** Poll until a TCP port accepts connections, or reject after timeoutMs. */
function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Timed out waiting for port ${port}`));
        } else {
          setTimeout(attempt, 100);
        }
      });
    };
    attempt();
  });
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(opts: http.RequestOptions, body?: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("e2e", () => {
  let tmpHome: string;
  let child: child_process.ChildProcess;
  let apiPort: number;
  let pubPort: number;
  let token: string;
  const baseUrl = "e2e.local";

  beforeAll(async () => {
    if (!fs.existsSync(CLI_PATH)) {
      child_process.execSync("npm run build", { cwd: ROOT, stdio: "inherit" });
    }

    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "uptool-e2e-"));
    const uptoolDir = path.join(tmpHome, ".uptool");
    fs.mkdirSync(uptoolDir, { recursive: true });

    pubPort = await findFreePort();
    apiPort = await findFreePort();

    const configToml = [
      `base_url = "${baseUrl}"`,
      `port = ${pubPort}`,
      `api_port = ${apiPort}`,
      `ttl = "72h"`,
      `storage_path = "${path.join(uptoolDir, "files").replace(/\\/g, "\\\\")}"`,
    ].join("\n");
    fs.writeFileSync(path.join(uptoolDir, "config.toml"), configToml);

    child = child_process.spawn(process.execPath, [CLI_PATH, "serve", "--foreground"], {
      env: { ...process.env, HOME: tmpHome },
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForPort(apiPort);
    await waitForPort(pubPort);

    // Token is written by the daemon on startup — wait for it to appear.
    const tokenPath = path.join(uptoolDir, "token");
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(tokenPath)) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for token file");
      await new Promise((r) => setTimeout(r, 50));
    }
    token = fs.readFileSync(tokenPath, "utf8").trim();
  }, 20_000);

  afterAll(async () => {
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        child.once("exit", resolve);
        setTimeout(resolve, 3000);
      });
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("deploys via POST /deploy with a valid token", async () => {
    const payload = JSON.stringify({ html: "<h1>Hello e2e</h1>" });
    const res = await request(
      {
        hostname: "127.0.0.1",
        port: apiPort,
        path: "/deploy",
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      payload
    );
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as { slug: string };
    expect(data.slug).toMatch(/^[a-z0-9]+$/);
    slug = data.slug;
  });

  let slug: string;

  it("serves the deployed HTML on the public server via Host header", async () => {
    const res = await request({
      hostname: "127.0.0.1",
      port: pubPort,
      path: "/",
      method: "GET",
      headers: { Host: `${slug}.${baseUrl}` },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("Hello e2e");
  });

  it("rejects deploy without a token", async () => {
    const payload = JSON.stringify({ html: "<h1>nope</h1>" });
    const res = await request(
      {
        hostname: "127.0.0.1",
        port: apiPort,
        path: "/deploy",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      payload
    );
    expect(res.status).toBe(401);
  });

  it("renews expiry via touch", async () => {
    const payload = JSON.stringify({ ttl: "7d" });
    const res = await request(
      {
        hostname: "127.0.0.1",
        port: apiPort,
        path: `/files/${slug}/touch`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      payload
    );
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as { expires: number };
    expect(data.expires).toBeGreaterThan(Date.now());
  });

  let protectedSlug: string;

  it("deploys a protected site requiring Basic Auth", async () => {
    const payload = JSON.stringify({ html: "<h1>secret e2e</h1>", key: "sekret" });
    const res = await request(
      {
        hostname: "127.0.0.1",
        port: apiPort,
        path: "/deploy",
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      payload
    );
    expect(res.status).toBe(200);
    protectedSlug = (JSON.parse(res.body) as { slug: string }).slug;

    const unauth = await request({
      hostname: "127.0.0.1",
      port: pubPort,
      path: "/",
      method: "GET",
      headers: { Host: `${protectedSlug}.${baseUrl}` },
    });
    expect(unauth.status).toBe(401);

    const basic = Buffer.from(":sekret").toString("base64");
    const authed = await request({
      hostname: "127.0.0.1",
      port: pubPort,
      path: "/",
      method: "GET",
      headers: {
        Host: `${protectedSlug}.${baseUrl}`,
        Authorization: `Basic ${basic}`,
      },
    });
    expect(authed.status).toBe(200);
    expect(authed.body).toContain("secret e2e");
  });

  it("removes a deployment and 404s on subsequent public fetch", async () => {
    const res = await request({
      hostname: "127.0.0.1",
      port: apiPort,
      path: `/files/${slug}`,
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    const fetched = await request({
      hostname: "127.0.0.1",
      port: pubPort,
      path: "/",
      method: "GET",
      headers: { Host: `${slug}.${baseUrl}` },
    });
    expect(fetched.status).toBe(404);
  });
});
