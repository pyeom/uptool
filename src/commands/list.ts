import { loadConfig } from "../config/index.js";
import { listFiles } from "../storage/index.js";

export function listCommand(): void {
  const config = loadConfig();
  const files = listFiles(config.storage_path);

  if (files.length === 0) {
    console.log("No deployed files.");
    return;
  }

  const now = Date.now();
  const rows = files.map((f) => {
    const url = `http://${f.slug}.${config.base_url}`;
    const expiry =
      f.expires > 0
        ? f.expires > now
          ? `expires in ${formatDuration(f.expires - now)}`
          : "EXPIRED"
        : "no expiry";
    return `${f.slug}  ${url}  [${f.filename}]  ${expiry}`;
  });

  console.log(rows.join("\n"));
}

function formatDuration(ms: number): string {
  const h = Math.floor(ms / (1000 * 60 * 60));
  const m = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
