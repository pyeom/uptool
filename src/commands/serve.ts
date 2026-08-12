import * as fs from "node:fs";
import * as child_process from "node:child_process";
import {
  loadConfig,
  configDir,
  pidPath,
  logPath,
  loadOrGenerateToken,
  cloudflaredYmlPath,
  Config,
} from "../config/index.js";
import { createApiServer } from "../server/api.js";
import { createPublicServer } from "../server/public.js";
import { WsManager } from "../server/ws.js";
import { TunnelProcess } from "../lib/tunnel-process.js";
import { findBinary } from "../lib/cloudflared.js";
import { ManifestStore } from "../storage/index.js";

export async function serveCommand(opts: { foreground?: boolean }): Promise<void> {
  const config = loadConfig();

  // -------------------------------------------------------------------------
  // Daemon mode: fork a background process
  // -------------------------------------------------------------------------
  if (!opts.foreground) {
    const pidFile = pidPath();
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      if (isRunning(pid)) {
        console.error(`uptool already running (pid ${pid}). Use: uptool stop`);
        process.exit(1);
      }
      fs.unlinkSync(pidFile);
    }

    const logFile = logPath();
    const out = fs.openSync(logFile, "a");
    const err = fs.openSync(logFile, "a");

    const child = child_process.spawn(
      process.execPath,
      [process.argv[1], "serve", "--foreground"],
      { detached: true, stdio: ["ignore", out, err] }
    );
    child.unref();

    console.log(`✓ uptool daemon started → *.${config.base_url} (port ${config.port})`);
    console.log(`  pid: ${child.pid}  log: ${logFile}`);
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // Foreground mode: the actual server process
  // -------------------------------------------------------------------------
  const dir = configDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pidPath(), String(process.pid));

  // Ensure token exists (or generate if missing)
  const token = loadOrGenerateToken();

  // Initialise in-memory manifest store (single owner of all state)
  const store = new ManifestStore(config.storage_path, {
    ttl: config.ttl,
    max_versions: config.max_versions,
    max_file_size: config.max_file_size,
    max_total_storage: config.max_total_storage,
  });

  const expired = store.cleanExpired();
  if (expired > 0) console.log(`Cleaned ${expired} expired file(s)`);

  // Hourly expiry sweep
  setInterval(() => {
    const n = store.cleanExpired();
    if (n > 0) console.log(`Cleaned ${n} expired file(s)`);
  }, 60 * 60 * 1000);

  const publicServer = createPublicServer(config, store);
  const apiServer = createApiServer(config, store, token);

  // Live reload: attach WebSocket manager and wire store 'updated' events
  let wsManager: WsManager | null = null;
  if (config.live_reload) {
    wsManager = new WsManager(publicServer, config, store);
    store.on("updated", (slug: string) => wsManager!.broadcast(slug, "reload"));
  }

  const tunnel = config.tunnel === "cloudflare" ? await startTunnel(config) : null;

  // Graceful shutdown
  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    // A second SIGTERM mid-shutdown must not re-run any of this.
    if (shuttingDown) return;
    shuttingDown = true;
    store.flushNow();
    wsManager?.close();
    // Awaited, and before the pidfile goes away: `uptool stop` must not leave an
    // orphan cloudflared behind pointing at a daemon that no longer exists.
    await tunnel?.close();
    if (fs.existsSync(pidPath())) fs.unlinkSync(pidPath());
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  // Last-resort guards. Request handlers already catch their own errors, so a
  // throw reaching here is unexpected — log it, persist state, but keep the
  // daemon alive rather than dropping every live deployment.
  process.on("uncaughtException", (err) => {
    console.error(`[uptool] uncaughtException: ${err?.stack ?? err}`);
    store.flushNow();
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[uptool] unhandledRejection: ${String(reason)}`);
  });

  // Surface bind failures (e.g. port already in use) with a clear message
  // instead of an opaque stack trace, then exit.
  function onListenError(label: string, port: number) {
    return (err: NodeJS.ErrnoException): void => {
      if (err.code === "EADDRINUSE") {
        console.error(`[uptool] ${label} port ${port} already in use.`);
      } else if (err.code === "EACCES") {
        console.error(`[uptool] ${label} port ${port} requires elevated privileges.`);
      } else {
        console.error(`[uptool] ${label} failed to listen: ${err.message}`);
      }
      process.exit(1);
    };
  }

  publicServer.on("error", onListenError("public server", config.port));
  apiServer.on("error", onListenError("API server", config.api_port));

  publicServer.listen(config.port, config.bind, () => {
    console.log(`Public server listening on ${config.bind}:${config.port}`);
  });

  apiServer.listen(config.api_port, "127.0.0.1", () => {
    console.log(`API server listening on 127.0.0.1:${config.api_port}`);
  });
}

/**
 * Every failure here is non-fatal on purpose: a missing binary or a broken
 * tunnel must still leave the daemon serving over local HTTP.
 */
async function startTunnel(config: Config): Promise<TunnelProcess | null> {
  const bin = findBinary(config.cloudflared_path);
  const yml = cloudflaredYmlPath();
  if (!bin) {
    console.error(`[uptool] tunnel is on but cloudflared was not found — run: uptool tunnel setup`);
  } else if (!fs.existsSync(yml)) {
    console.error(`[uptool] tunnel is on but ${yml} is missing — run: uptool tunnel setup`);
  } else {
    try {
      return await TunnelProcess.create(bin, yml, config.tunnel_metrics_port);
    } catch (err) {
      console.error(`[uptool] could not start cloudflared: ${(err as Error).message}`);
    }
  }
  console.error(`[uptool] continuing without a tunnel — serving locally only.`);
  return null;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
