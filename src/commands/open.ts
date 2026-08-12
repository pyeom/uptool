import * as child_process from "node:child_process";
import { loadConfig, publicUrl } from "../config/index.js";

/**
 * Hand a URL to the desktop's default browser.
 *
 * Detached and unref'd so the CLI can exit immediately instead of waiting on
 * the browser it just launched.
 */
export function openUrl(url: string): void {
  const launcher =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
      ? "start"
      : "xdg-open";

  child_process.spawn(launcher, [url], { stdio: "ignore", detached: true }).unref();
}

export async function openCommand(slug: string): Promise<void> {
  const config = loadConfig();
  const url = publicUrl(config, slug);
  openUrl(url);
  console.log(`✓ Opening ${url}`);
}
