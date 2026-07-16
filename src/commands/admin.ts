import * as fs from "node:fs";
import * as child_process from "node:child_process";
import { loadConfig, tokenPath } from "../config/index.js";

export async function adminCommand(): Promise<void> {
  const config = loadConfig();

  if (!fs.existsSync(tokenPath())) {
    console.error("Auth token not found. Run: uptool init");
    process.exitCode = 1;
    return;
  }
  const token = fs.readFileSync(tokenPath(), "utf8").trim();

  const url = `http://127.0.0.1:${config.api_port}/admin?token=${token}`;
  console.log(`✓ Admin page: ${url}`);

  const launcher =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
      ? "start"
      : "xdg-open";

  child_process.spawn(launcher, [url], { stdio: "ignore", detached: true }).unref();
}
