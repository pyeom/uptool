import * as fs from "node:fs";
import { pidPath } from "../config/index.js";

export function stopCommand(): void {
  const pidFile = pidPath();
  if (!fs.existsSync(pidFile)) {
    console.error("uptool is not running (no PID file found).");
    process.exit(1);
  }

  const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
  try {
    process.kill(pid, "SIGTERM");
    fs.unlinkSync(pidFile);
    console.log(`✓ uptool stopped (pid ${pid})`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      fs.unlinkSync(pidFile);
      console.log("Process was not running. PID file cleaned up.");
    } else {
      console.error(`Failed to stop process: ${(err as Error).message}`);
      process.exit(1);
    }
  }
}
