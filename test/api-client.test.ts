import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { callApi, ApiError } from "../src/lib/api-client.js";

/**
 * In-process coverage: callApi() reads the token via tokenPath(), which
 * derives from os.homedir(), which on Linux reads process.env.HOME at call
 * time (verified — no caching). We override HOME per-test and always restore
 * it in afterEach, even on failure.
 */

let realHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "uptool-apiclient-"));
  fs.mkdirSync(path.join(tmpHome, ".uptool"), { recursive: true });
  process.env.HOME = tmpHome;
});

afterEach(() => {
  // Assigning undefined would store the literal string "undefined".
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writeToken(value: string) {
  fs.writeFileSync(path.join(tmpHome, ".uptool", "token"), value);
}

describe("callApi — token errors", () => {
  it("rejects with ApiError when token file is missing", async () => {
    await expect(callApi(9999, "GET", "/files")).rejects.toMatchObject({
      name: "ApiError",
      message: "Auth token not found. Run: uptool init",
    });
  });

  it("rejects with the same error when token file is empty/whitespace", async () => {
    writeToken("   \n\t  ");
    await expect(callApi(9999, "GET", "/files")).rejects.toMatchObject({
      name: "ApiError",
      message: "Auth token not found. Run: uptool init",
    });
  });
});

describe("callApi — network errors", () => {
  it("rejects with an actionable message on ECONNREFUSED", async () => {
    writeToken("tok");
    // Nothing listening on this port.
    const port = await freeUnusedPort();
    await expect(callApi(port, "GET", "/files")).rejects.toMatchObject({
      name: "ApiError",
      message: "uptool server not running — run: uptool serve",
    });
  });

  it("propagates a synchronous client-side error (bad port) unwrapped", async () => {
    writeToken("tok");
    // Negative port triggers a RangeError / ERR_SOCKET_BAD_PORT from Node's
    // http client before any socket 'error' event, which is not
    // ECONNREFUSED and must propagate unwrapped (not turned into ApiError).
    await expect(callApi(-1, "GET", "/files")).rejects.not.toMatchObject({
      name: "ApiError",
    });
  });

  it("propagates non-ECONNREFUSED socket errors (e.g. ECONNRESET) via req.on('error') unwrapped", async () => {
    writeToken("tok");
    // A server that destroys the connection immediately produces a genuine
    // async 'error' event on the request with a non-ECONNREFUSED code,
    // exercising the reject(err) passthrough branch distinct from the
    // ECONNREFUSED branch.
    const server = http.createServer();
    server.on("connection", (sock) => sock.destroy());
    await listen(server);
    const port = (server.address() as { port: number }).port;
    try {
      const err = await callApi(port, "GET", "/files").catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).not.toBe("ApiError");
      expect((err as NodeJS.ErrnoException).code).not.toBe("ECONNREFUSED");
    } finally {
      await closeServer(server);
    }
  });
});

describe("callApi — request/response handling", () => {
  it("sends Authorization: Bearer <token> header", async () => {
    writeToken("secret-token-123");
    const { port, getRequest, close } = await startEchoServer();
    try {
      await expect(callApi(port, "GET", "/files")).resolves.toEqual({ ok: true });
      const req = getRequest();
      expect(req.headers["authorization"]).toBe("Bearer secret-token-123");
    } finally {
      await close();
    }
  });

  it("rejects with ApiError including the body on non-JSON response", async () => {
    writeToken("tok");
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>not json</html>");
    });
    await listen(server);
    const port = (server.address() as { port: number }).port;
    try {
      await expect(callApi(port, "GET", "/files")).rejects.toMatchObject({
        name: "ApiError",
        message: expect.stringContaining("<html>not json</html>"),
      });
    } finally {
      await closeServer(server);
    }
  });

  it("serialises body with correct Content-Type and byte-accurate Content-Length (multi-byte UTF-8)", async () => {
    writeToken("tok");
    const body = { text: "café 🎉 — accénts and emoji" };
    const expectedJson = JSON.stringify(body);
    const expectedByteLength = Buffer.byteLength(expectedJson, "utf8");
    // Sanity: byte length must differ from JS string length for this input,
    // otherwise the test wouldn't actually exercise the UTF-8 path.
    expect(expectedByteLength).not.toBe(expectedJson.length);

    const { port, getRequest, getRawBody, close } = await startEchoServer();
    try {
      await callApi(port, "POST", "/deploy", body);
      const req = getRequest();
      expect(req.headers["content-type"]).toBe("application/json");
      expect(req.headers["content-length"]).toBe(String(expectedByteLength));
      expect(getRawBody()).toBe(expectedJson);
    } finally {
      await close();
    }
  });

  it("resolves parsed JSON on success", async () => {
    writeToken("tok");
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ files: [1, 2, 3] }));
    });
    await listen(server);
    const port = (server.address() as { port: number }).port;
    try {
      await expect(callApi(port, "GET", "/files")).resolves.toEqual({ files: [1, 2, 3] });
    } finally {
      await closeServer(server);
    }
  });

  it("documents behaviour on empty response body", async () => {
    writeToken("tok");
    const server = http.createServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    await listen(server);
    const port = (server.address() as { port: number }).port;
    try {
      // FINDING: an empty body is not valid JSON, so JSON.parse("") throws
      // and callApi rejects with ApiError("Invalid API response: ") — even
      // for a deliberate 204 No Content. Any real endpoint returning 204
      // would surface as a client-side "Invalid API response" error rather
      // than a clean success. Documented here, not fixed (api-client.ts is
      // not in scope for this task).
      await expect(callApi(port, "GET", "/files")).rejects.toMatchObject({
        name: "ApiError",
        message: "Invalid API response: ",
      });
    } finally {
      await closeServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function freeUnusedPort(): Promise<number> {
  const server = http.createServer();
  await listen(server);
  const port = (server.address() as { port: number }).port;
  await closeServer(server);
  return port; // nothing listens here after close
}

/** Spins up a server that echoes request metadata for inspection, replying { ok: true }. */
async function startEchoServer(): Promise<{
  port: number;
  getRequest: () => http.IncomingMessage;
  getRawBody: () => string;
  close: () => Promise<void>;
}> {
  let lastReq: http.IncomingMessage | undefined;
  let lastBody = "";
  const server = http.createServer((req, res) => {
    lastReq = req;
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      lastBody = raw;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await listen(server);
  const port = (server.address() as { port: number }).port;
  return {
    port,
    getRequest: () => {
      if (!lastReq) throw new Error("no request received");
      return lastReq;
    },
    getRawBody: () => lastBody,
    close: () => closeServer(server),
  };
}
