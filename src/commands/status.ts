import * as fs from "node:fs";
import { pidPath, logPath } from "../config/index.js";

export function statusCommand(): void {
  const pidFile = pidPath();
  if (!fs.existsSync(pidFile)) {
    console.log("uptool: stopped");
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
  let running = false;
  try {
    process.kill(pid, 0);
    running = true;
  } catch {
    running = false;
  }

  if (running) {
    console.log(`uptool: running (pid ${pid})`);
  } else {
    console.log(`uptool: stopped (stale PID file, pid ${pid})`);
    fs.unlinkSync(pidFile);
  }

  const log = logPath();
  if (fs.existsSync(log)) {
    const lines = fs.readFileSync(log, "utf8").trim().split("\n");
    const tail = lines.slice(-10).join("\n");
    console.log(`\n--- last 10 log lines (${log}) ---`);
    console.log(tail);
  }
}
