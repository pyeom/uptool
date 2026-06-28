import * as fs from "node:fs";
import * as path from "node:path";
import * as child_process from "node:child_process";
import { loadConfig, configDir, pidPath, logPath, resolvePath } from "../config/index.js";
import { createApiServer } from "../server/api.js";
import { createPublicServer } from "../server/public.js";
import { cleanExpired } from "../storage/index.js";

export function serveCommand(opts: { foreground?: boolean }): void {
  const config = loadConfig();

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

    const child = child_process.spawn(process.execPath, [process.argv[1], "serve", "--foreground"], {
      detached: true,
      stdio: ["ignore", out, err],
    });
    child.unref();

    console.log(`✓ uptool daemon started → *.${config.base_url} (port ${config.port})`);
    console.log(`  pid: ${child.pid}  log: ${logFile}`);
    process.exit(0);
  }

  // Foreground mode — actual server process
  const dir = configDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pidPath(), String(process.pid));

  process.on("SIGTERM", () => {
    if (fs.existsSync(pidPath())) fs.unlinkSync(pidPath());
    process.exit(0);
  });

  process.on("SIGINT", () => {
    if (fs.existsSync(pidPath())) fs.unlinkSync(pidPath());
    process.exit(0);
  });

  const expired = cleanExpired(config.storage_path);
  if (expired > 0) console.log(`Cleaned ${expired} expired file(s)`);

  setInterval(() => cleanExpired(config.storage_path), 60 * 60 * 1000);

  const publicServer = createPublicServer(config);
  const apiServer = createApiServer(config);

  publicServer.listen(config.port, () => {
    console.log(`Public server listening on port ${config.port}`);
  });

  apiServer.listen(config.api_port, "127.0.0.1", () => {
    console.log(`API server listening on 127.0.0.1:${config.api_port}`);
  });
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
