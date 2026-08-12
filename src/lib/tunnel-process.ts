import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import { Readable } from "node:stream";
import { tunnelStatePath } from "../config/index.js";

/**
 * Supervises a long-running `cloudflared tunnel run` as a child of the daemon.
 *
 * The daemon's own stdout is already redirected to ~/.uptool/server.log, so
 * re-emitting cloudflared's output line by line with a `[cloudflared]` prefix
 * is what makes `uptool logs` show tunnel activity next to uptool's own.
 *
 * Nothing in here throws at the caller: a cloudflared that dies in a loop must
 * never take the daemon (or local HTTP serving) down with it.
 */

const MAX_BACKOFF_MS = 30_000;
/** A child that lasted this long was healthy — its death is a blip, not a crash loop. */
const HEALTHY_MS = 60_000;

export class TunnelProcess {
  private child: child_process.ChildProcess | null = null;
  private stopping = false;
  private backoffMs = 1000;
  private restarts = 0;
  private timer: NodeJS.Timeout | null = null;

  private constructor(
    private bin: string,
    private configPath: string,
    private metricsPort: number
  ) {
    this.start();
  }

  /**
   * `configuredPort` of 0 means "pick one" — cloudflared's documented default
   * (20241) belongs to whichever cloudflared grabbed it first, so uptool asks
   * the OS for a port nobody holds and records it for the health check.
   */
  static async create(
    bin: string,
    configPath: string,
    configuredPort: number
  ): Promise<TunnelProcess> {
    const port = configuredPort > 0 ? configuredPort : await freePort();
    return new TunnelProcess(bin, configPath, port);
  }

  private start(): void {
    // Global flags must come before the `run` subcommand — cloudflared ignores
    // them once the subcommand has been parsed.
    const args = [
      "tunnel",
      "--config",
      this.configPath,
      "--metrics",
      `127.0.0.1:${this.metricsPort}`,
      "run",
    ];

    const startedAt = Date.now();
    const child = child_process.spawn(this.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    // Rewritten on every restart: the PID changes, and a stale one would make
    // the health check answer for a process that no longer exists.
    if (child.pid) writeTunnelState({ pid: child.pid, metrics_port: this.metricsPort });

    prefixLines(child.stdout, process.stdout);
    prefixLines(child.stderr, process.stderr);

    // ENOENT/EACCES arrive here instead of as a throw; "exit" still fires after.
    child.on("error", (err) => {
      console.error(`[cloudflared] spawn failed: ${err.message}`);
    });

    child.on("exit", (code, signal) => {
      this.child = null;
      clearTunnelState();
      if (this.stopping) return;

      if (Date.now() - startedAt > HEALTHY_MS) {
        this.backoffMs = 1000;
        this.restarts = 0;
      }
      this.restarts++;
      const wait = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      console.error(
        `[cloudflared] exited (${signal ?? `code ${code}`}) — restart #${this.restarts} in ${wait / 1000}s`
      );
      // unref'd: a pending restart must not keep the daemon alive on its own.
      this.timer = setTimeout(() => this.start(), wait);
      this.timer.unref();
    });
  }

  /**
   * SIGTERM, then SIGKILL if it is still around 5s later. Safe to call twice.
   *
   * Resolves once the child is actually gone, so the daemon can await it before
   * exiting. Returning early would leave a cloudflared that is slow to die
   * orphaned, and the next `uptool serve` would start a second connector for
   * the same tunnel — which Cloudflare happily accepts as a replica and then
   * routes traffic to.
   */
  close(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    clearTunnelState();

    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let kill: NodeJS.Timeout;
      let giveUp: NodeJS.Timeout;
      const done = (): void => {
        clearTimeout(kill);
        clearTimeout(giveUp);
        resolve();
      };

      kill = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, 5000);
      // Anything still alive a second after SIGKILL is stuck in the kernel and
      // will not answer. Stop waiting — the daemon still has to be able to exit.
      giveUp = setTimeout(done, 6000);

      child.once("exit", done);
      try {
        child.kill("SIGTERM");
      } catch {
        done();
      }
    });
  }
}

/** What the daemon records about the cloudflared child it owns. */
export interface TunnelState {
  /** PID of the cloudflared process. */
  pid: number;
  /** Metrics port that process was actually given. */
  metrics_port: number;
}

export function readTunnelState(): TunnelState | null {
  try {
    const raw = fs.readFileSync(tunnelStatePath(), "utf8");
    const state = JSON.parse(raw) as TunnelState;
    if (typeof state.pid !== "number" || typeof state.metrics_port !== "number") return null;
    return state;
  } catch {
    // absent or unreadable — no tunnel of ours is running
    return null;
  }
}

function writeTunnelState(state: TunnelState): void {
  try {
    fs.writeFileSync(tunnelStatePath(), JSON.stringify(state));
  } catch (err) {
    // Losing the state file only costs us health reporting, not the tunnel.
    console.error(`[uptool] could not record tunnel state: ${(err as Error).message}`);
  }
}

function clearTunnelState(): void {
  try {
    fs.unlinkSync(tunnelStatePath());
  } catch {
    // already gone
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** cloudflared's metrics server answers 200 on /ready once it has live connections. */
async function probePort(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ready`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Is *our* tunnel connected?
 *
 * The ownership check is the point. cloudflared's default metrics port (20241)
 * is the same for every cloudflared on the machine, so probing a port alone
 * would happily report an unrelated tunnel — including one the user runs by
 * hand — as uptool's, leaving `status --json` green while uptool is unreachable.
 *
 * So: only trust the probe when the process we recorded is still alive.
 */
export async function tunnelHealthy(): Promise<boolean> {
  const state = readTunnelState();
  if (!state || !isAlive(state.pid)) return false;
  return probePort(state.metrics_port);
}

/** Ask the OS for a free port by binding to 0 and reading the assignment back. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function prefixLines(src: Readable | null, dest: NodeJS.WritableStream): void {
  if (!src) return;
  let pending = "";
  src.setEncoding("utf8");
  src.on("data", (chunk: string) => {
    const lines = (pending + chunk).split("\n");
    // A chunk can cut a line in half — hold the tail until the rest arrives.
    pending = lines.pop() ?? "";
    for (const line of lines) dest.write(`[cloudflared] ${line}\n`);
  });
  src.on("end", () => {
    if (pending) dest.write(`[cloudflared] ${pending}\n`);
    pending = "";
  });
}
