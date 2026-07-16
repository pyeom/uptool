import * as fs from "node:fs";
import { pidPath, logPath, loadConfig, Config } from "../config/index.js";
import { callApi } from "../lib/api-client.js";

function readPid(): number | null {
  const pidFile = pidPath();
  if (!fs.existsSync(pidFile)) return null;
  const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
  return Number.isFinite(pid) ? pid : null;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Probe the internal API. Returns deployment count, or null if unreachable. */
async function probeApi(config: Config): Promise<number | null> {
  try {
    const result = await callApi<{ files?: unknown[] }>(
      config.api_port,
      "GET",
      "/files"
    );
    return Array.isArray(result.files) ? result.files.length : null;
  } catch {
    return null;
  }
}

export async function statusCommand(opts: { json?: boolean } = {}): Promise<void> {
  const pid = readPid();
  const running = pid !== null && isRunning(pid);

  if (opts.json) {
    let config: Config | null = null;
    try {
      config = loadConfig();
    } catch {
      // not initialised — still report process state
    }
    const deployments = running && config ? await probeApi(config) : null;
    const healthy = running && deployments !== null;
    console.log(
      JSON.stringify({
        running,
        healthy,
        pid: running ? pid : null,
        api_responding: deployments !== null,
        deployments,
        base_url: config?.base_url ?? null,
        port: config?.port ?? null,
        api_port: config?.api_port ?? null,
      })
    );
    // Non-zero exit when unhealthy so monitors can alert on it
    process.exit(healthy ? 0 : 1);
  }

  if (!running) {
    if (pid !== null) {
      console.log(`uptool: stopped (stale PID file, pid ${pid})`);
    } else {
      console.log("uptool: stopped");
    }
    // Clean up the PID file even when its contents were unparseable; tolerate
    // it vanishing between the existence check and the unlink.
    try {
      if (fs.existsSync(pidPath())) fs.unlinkSync(pidPath());
    } catch {
      // already gone — nothing to clean
    }
  } else {
    console.log(`uptool: running (pid ${pid})`);
  }

  const log = logPath();
  if (fs.existsSync(log)) {
    const tail = readLogTail(log, 10);
    console.log(`\n--- last 10 log lines (${log}) ---`);
    console.log(tail);
  }
}

/**
 * Read the last `lineCount` lines of a file without loading it whole.
 * Reads a bounded chunk from the end — plenty for 10 log lines.
 */
function readLogTail(logFile: string, lineCount: number): string {
  const CHUNK = 16 * 1024;
  const fd = fs.openSync(logFile, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const readLen = Math.min(size, CHUNK);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, size - readLen);
    const lines = buf.toString("utf8").trim().split("\n");
    return lines.slice(-lineCount).join("\n");
  } finally {
    fs.closeSync(fd);
  }
}
