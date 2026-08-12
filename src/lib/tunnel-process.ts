import * as child_process from "node:child_process";
import { Readable } from "node:stream";

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

  constructor(
    private bin: string,
    private configPath: string,
    private metricsPort: number
  ) {
    this.start();
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

    prefixLines(child.stdout, process.stdout);
    prefixLines(child.stderr, process.stderr);

    // ENOENT/EACCES arrive here instead of as a throw; "exit" still fires after.
    child.on("error", (err) => {
      console.error(`[cloudflared] spawn failed: ${err.message}`);
    });

    child.on("exit", (code, signal) => {
      this.child = null;
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

/** cloudflared's metrics server answers 200 on /ready once it has live connections. */
export async function probeReady(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ready`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
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
