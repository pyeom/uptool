import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { startQuickTunnel } from "../src/lib/quick-tunnel.js";
import { tempHome } from "./helpers.js";

/**
 * test/quick-tunnel.test.ts — the throwaway `*.trycloudflare.com` tunnel.
 *
 * No network and no real cloudflared: the fakes below print the same shapes the
 * real binary does, so the URL scraping and the process lifecycle are exercised
 * without ever opening a public URL.
 */

const URL = "https://songs-extremely-gospel-sellers.trycloudflare.com";

/** Announces the URL on stderr — where the real cloudflared puts it — and waits. */
const FAKE_STDERR = `#!/bin/sh
echo "$@" >> "$FAKE_LOG"
echo "some banner" >&2
echo "|  ${URL}  |" >&2
trap 'exit 0' TERM
while true; do sleep 1; done
`;

/** Same, but on stdout: which stream carries it has moved between releases. */
const FAKE_STDOUT = `#!/bin/sh
echo "${URL}"
trap 'exit 0' TERM
while true; do sleep 1; done
`;

/** Connects to nothing and never announces a URL. */
const FAKE_SILENT = `#!/bin/sh
trap 'exit 0' TERM
while true; do sleep 1; done
`;

/** Dies before it can announce anything. */
const FAKE_DIES = `#!/bin/sh
echo "failed to connect to the edge" >&2
exit 1
`;

let ctx: { home: string; cleanup: () => void } | undefined;

function fakeBin(script: string): string {
  ctx = tempHome();
  const bin = path.join(ctx.home, "cloudflared");
  fs.writeFileSync(bin, script, { mode: 0o755 });
  process.env.FAKE_LOG = path.join(ctx.home, "args.log");
  return bin;
}

describe("startQuickTunnel", () => {
  afterEach(() => {
    ctx?.cleanup();
    ctx = undefined;
  });

  it("scrapes the public URL from stderr and passes the Host rewrite", async () => {
    const bin = fakeBin(FAKE_STDERR);
    const tunnel = await startQuickTunnel(bin, 8099, "x7k2mq.uptool.local");

    expect(tunnel.url).toBe(URL);

    // The Host rewrite is the whole trick: without it a single-hostname tunnel
    // could not reach a deployment that is routed by subdomain.
    const args = fs.readFileSync(process.env.FAKE_LOG!, "utf8");
    expect(args).toContain("--url http://127.0.0.1:8099");
    expect(args).toContain("--http-host-header x7k2mq.uptool.local");

    await tunnel.close();
  });

  it("also finds the URL on stdout", async () => {
    const tunnel = await startQuickTunnel(fakeBin(FAKE_STDOUT), 8099, "a.uptool.local");
    expect(tunnel.url).toBe(URL);
    await tunnel.close();
  });

  it("gives up when no URL is announced", async () => {
    await expect(
      startQuickTunnel(fakeBin(FAKE_SILENT), 8099, "a.uptool.local", undefined, 1500)
    ).rejects.toThrow(/did not report a URL/);
  });

  it("reports the output when cloudflared dies before announcing", async () => {
    await expect(
      startQuickTunnel(fakeBin(FAKE_DIES), 8099, "a.uptool.local")
    ).rejects.toThrow(/failed to connect to the edge/);
  });

  it("does not cry wolf when the caller closed it", async () => {
    const seen: string[] = [];
    const tunnel = await startQuickTunnel(
      fakeBin(FAKE_STDERR),
      8099,
      "a.uptool.local",
      (reason) => seen.push(reason)
    );

    await tunnel.close();
    // close() resolves on the child's exit, so the callback would already have
    // fired by now if the intentional shutdown were being misreported.
    expect(seen).toEqual([]);
  });
});
