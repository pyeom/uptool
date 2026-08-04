import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { startDaemon, runCli, type Daemon } from "./helpers.js";

/**
 * Smoke test for test/helpers.ts itself: proves the daemon-spawning +
 * CLI-running plumbing works end to end. Not the CLI suite — just enough to
 * catch a broken foundation before four other test suites build on it.
 */
describe("helpers smoke test", () => {
  let daemon: Daemon | undefined;

  afterAll(async () => {
    await daemon?.stop();
  });

  it("deploys via the real CLI against a spawned daemon and serves the result", async () => {
    daemon = await startDaemon();

    const htmlPath = path.join(os.tmpdir(), `uptool-helpers-test-${Date.now()}.html`);
    fs.writeFileSync(htmlPath, "<h1>hello from helpers.test.ts</h1>");

    const result = await runCli(["deploy", htmlPath], { home: daemon.home });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/https?:\/\//);

    const match = result.stdout.match(/https?:\/\/\S+/);
    expect(match).not.toBeNull();
    const url = new URL(match![0]);

    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: daemon!.pubPort,
          path: url.pathname,
          method: "GET",
          headers: { Host: url.hostname },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve(data));
        }
      );
      req.on("error", reject);
      req.end();
    });

    expect(body).toContain("hello from helpers.test.ts");

    fs.rmSync(htmlPath, { force: true });
  }, 20_000);
});
