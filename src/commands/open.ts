import * as child_process from "node:child_process";
import { loadConfig, publicUrl } from "../config/index.js";

export async function openCommand(slug: string): Promise<void> {
  const config = loadConfig();
  const url = publicUrl(config, slug);

  const launcher =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
      ? "start"
      : "xdg-open";

  child_process.spawn(launcher, [url], { stdio: "ignore", detached: true }).unref();
  console.log(`✓ Opening ${url}`);
}
