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
      fs.unlinkSync(pidPath());
    } else {
      console.log("uptool: stopped");
    }
  } else {
    console.log(`uptool: running (pid ${pid})`);
  }

  const log = logPath();
  if (fs.existsSync(log)) {
    const lines = fs.readFileSync(log, "utf8").trim().split("\n");
    const tail = lines.slice(-10).join("\n");
    console.log(`\n--- last 10 log lines (${log}) ---`);
    console.log(tail);
  }
}
