import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as net from "node:net";
import { TunnelProcess, tunnelHealthy } from "../src/lib/tunnel-process.js";
import { freePort, startDaemon, tempHome, writeConfig } from "./helpers.js";

/**
 * test/tunnel-process.test.ts — the cloudflared supervisor.
 *
 * No network and no real cloudflared: every spawn resolves to one of the fake
 * shell scripts below, which record each start in a file so restarts are
 * countable. Metrics ports always come from freePort() — the default 20241 is
 * cloudflared's own, so a developer machine already running a tunnel would
 * answer the probe and make a test pass for the wrong reason.
 */

/** Records its args, stays alive until killed, and records the SIGTERM too. */
const FAKE_LONG = `#!/bin/sh
echo "$@" >> "$FAKE_CF_LOG"
echo "hello from the tunnel"
sleep 60 &
child=$!
trap 'echo stopped >> "$FAKE_CF_LOG"; kill $child 2>/dev/null; exit 0' TERM
wait $child
`;

/** Records its args, then dies immediately — a crash loop. */
const FAKE_CRASH = `#!/bin/sh
echo "$@" >> "$FAKE_CF_LOG"
exit 1
`;

/** Ignores SIGTERM outright, so only SIGKILL can end it. */
const FAKE_DEAF = `#!/bin/sh
echo "$@" >> "$FAKE_CF_LOG"
trap '' TERM
while true; do sleep 1; done
`;

interface Ctx {
  home: string;
  bin: string;
  log: string;
  yml: string;
  cleanup: () => void;
}

let ctx: Ctx | undefined;
let supervisor: TunnelProcess | undefined;

function setup(script: string): Ctx {
  const { home, cleanup } = tempHome();
  const bin = path.join(home, "cloudflared");
  fs.writeFileSync(bin, script, { mode: 0o755 });
  const yml = path.join(home, ".uptool", "cloudflared.yml");
  fs.writeFileSync(yml, "tunnel: fake\n");
  const log = path.join(home, "starts.log");
  process.env.FAKE_CF_LOG = log;
  return { home, bin, log, yml, cleanup };
}

function readLog(log: string): string[] {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
}

/** One line per spawn, args included; "stopped" lines are SIGTERM receipts. */
function starts(log: string): string[] {
  return readLog(log).filter((l) => l.startsWith("tunnel "));
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("TunnelProcess", () => {
  afterEach(async () => {
    supervisor?.close();
    supervisor = undefined;
    vi.restoreAllMocks();
    delete process.env.FAKE_CF_LOG;
    // Give the SIGTERM'd child a beat to die: removing the temp home out from
    // under a fake that is still opening its log file makes it complain on
    // stderr, which the supervisor faithfully reprints into the test output.
    await sleep(100);
    ctx?.cleanup();
    ctx = undefined;
  });

  it("spawns with the global flags before the run subcommand", async () => {
    ctx = setup(FAKE_LONG);
    const metricsPort = await freePort();
    supervisor = await TunnelProcess.create(ctx.bin, ctx.yml, metricsPort);

    await waitFor(() => starts(ctx!.log).length === 1);
    expect(starts(ctx.log)[0]).toBe(
      `tunnel --config ${ctx.yml} --metrics 127.0.0.1:${metricsPort} run`
    );
  });

  it("prefixes the child's output with [cloudflared]", async () => {
    ctx = setup(FAKE_LONG);
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    supervisor = await TunnelProcess.create(ctx.bin, ctx.yml, await freePort());
    await waitFor(() => written.some((l) => l.includes("hello from the tunnel")));

    expect(written).toContain("[cloudflared] hello from the tunnel\n");
  });

  it("restarts a child that dies", async () => {
    ctx = setup(FAKE_CRASH);
    supervisor = await TunnelProcess.create(ctx.bin, ctx.yml, await freePort());

    // Backoff is 1s then 2s, so a second start lands ~1s in.
    await waitFor(() => starts(ctx!.log).length >= 2, 4000);
  });

  it("never restarts after close()", async () => {
    ctx = setup(FAKE_CRASH);
    supervisor = await TunnelProcess.create(ctx.bin, ctx.yml, await freePort());

    await waitFor(() => starts(ctx!.log).length >= 1);
    supervisor.close();
    supervisor = undefined;

    const seen = starts(ctx.log).length;
    await sleep(1500); // longer than the first backoff
    expect(starts(ctx.log).length).toBe(seen);
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    ctx = setup(FAKE_DEAF);
    const s = await TunnelProcess.create(ctx.bin, ctx.yml, await freePort());
    await waitFor(() => starts(ctx!.log).length >= 1);

    // close() resolving at all is the assertion: this child never honors
    // SIGTERM, so only the SIGKILL escalation can end it. Before shutdown
    // awaited close(), the daemon exited here and left it orphaned.
    const start = Date.now();
    await s.close();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(4900); // waited out the 5s SIGTERM grace
    expect(elapsed).toBeLessThan(8000); // and did not hang
  }, 15_000);

  it("close() is idempotent and safe after the child is gone", async () => {
    ctx = setup(FAKE_CRASH);
    const s = await TunnelProcess.create(ctx.bin, ctx.yml, await freePort());
    await waitFor(() => starts(ctx!.log).length >= 1);
    await sleep(100);
    expect(() => {
      s.close();
      s.close();
    }).not.toThrow();
  });
});

describe("tunnelHealthy ownership", () => {
  /**
   * Stand in for an unrelated cloudflared: something that answers 200 on
   * /ready, exactly like the real one, but that uptool did not start.
   */
  function fakeMetricsServer(): Promise<{ port: number; close: () => Promise<void> }> {
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        res.writeHead(req.url === "/ready" ? 200 : 404);
        res.end('{"status":200,"readyConnections":3}');
      });
      srv.listen(0, "127.0.0.1", () => {
        resolve({
          port: (srv.address() as net.AddressInfo).port,
          close: () => new Promise<void>((r) => srv.close(() => r())),
        });
      });
    });
  }

  let home: { home: string; cleanup: () => void } | undefined;
  const realHome = process.env.HOME;

  afterEach(() => {
    home?.cleanup();
    home = undefined;
    // Restore rather than delete: os.homedir() reads HOME, and unsetting it
    // would follow this worker into whatever runs next.
    process.env.HOME = realHome;
  });

  it("is false when no tunnel state was recorded", async () => {
    home = tempHome();
    process.env.HOME = home.home;
    expect(await tunnelHealthy()).toBe(false);
  });

  it("does not claim a stranger's cloudflared as ours", async () => {
    home = tempHome();
    process.env.HOME = home.home;
    const foreign = await fakeMetricsServer();

    try {
      // The exact shape of the bug: a live metrics server on the recorded port,
      // but the process uptool started is long gone. PID 1 is init, which is
      // alive but is certainly not our cloudflared — so use a PID that cannot
      // be running instead.
      const deadPid = 2 ** 22; // above /proc/sys/kernel/pid_max on Linux
      fs.writeFileSync(
        path.join(home.home, ".uptool", "tunnel.json"),
        JSON.stringify({ pid: deadPid, metrics_port: foreign.port })
      );

      expect(await tunnelHealthy()).toBe(false);
    } finally {
      await foreign.close();
    }
  });

  it("is true when our own process is alive and the port answers", async () => {
    home = tempHome();
    process.env.HOME = home.home;
    const mine = await fakeMetricsServer();

    try {
      // process.pid is alive by definition, standing in for a live child.
      fs.writeFileSync(
        path.join(home.home, ".uptool", "tunnel.json"),
        JSON.stringify({ pid: process.pid, metrics_port: mine.port })
      );

      expect(await tunnelHealthy()).toBe(true);
    } finally {
      await mine.close();
    }
  });
});

describe("serve + tunnel", () => {
  it("spawns nothing when tunnel is off", async () => {
    const { home, cleanup } = tempHome();
    const bin = path.join(home, "cloudflared");
    fs.writeFileSync(bin, FAKE_LONG, { mode: 0o755 });
    const log = path.join(home, "starts.log");
    cleanup();

    const daemon = await startDaemon({
      cloudflared_path: bin,
      env: { FAKE_CF_LOG: log },
    });
    try {
      await sleep(300);
      expect(fs.existsSync(log)).toBe(false);
    } finally {
      await daemon.stop();
    }
  });

  it("runs cloudflared when the tunnel is on, and stops it on shutdown", async () => {
    const outer = tempHome();
    const bin = path.join(outer.home, "cloudflared");
    fs.writeFileSync(bin, FAKE_LONG, { mode: 0o755 });
    const log = path.join(outer.home, "starts.log");

    const metricsPort = await freePort();
    const daemon = await startDaemon({
      tunnel: "cloudflare",
      tunnel_metrics_port: metricsPort,
      cloudflared_path: bin,
      cloudflared_yml: "tunnel: fake\n",
      env: { FAKE_CF_LOG: log },
    });
    try {
      await waitFor(() => starts(log).length >= 1, 5000);
      expect(starts(log)[0]).toContain(`--metrics 127.0.0.1:${metricsPort}`);
      await daemon.stop();
      // SIGTERM to the daemon must take cloudflared with it, not orphan it.
      await waitFor(() => readLog(log).includes("stopped"), 3000);
      expect(starts(log).length).toBe(1);
    } finally {
      await daemon.stop();
      outer.cleanup();
    }
  });

  it("keeps serving when cloudflared is missing", async () => {
    const empty = tempHome();
    const daemon = await startDaemon({
      tunnel: "cloudflare",
      cloudflared_path: path.join(empty.home, "does-not-exist"),
      env: { PATH: empty.home },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.apiPort}/files`, {
        headers: { Authorization: `Bearer ${daemon.token}` },
      });
      expect(res.status).toBe(200);
    } finally {
      await daemon.stop();
      empty.cleanup();
    }
  });
});
