import { loadConfig, publicUrl } from "../config/index.js";
import { callApi } from "../lib/api-client.js";

function formatDuration(ms: number): string {
  const h = Math.floor(ms / (1000 * 60 * 60));
  const m = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

interface FileRecord {
  slug: string;
  filename: string;
  created: number;
  expires: number;
  name?: string;
  hits?: number;
  last_seen?: number;
  protected?: boolean;
}

function formatHits(f: FileRecord, now: number): string {
  const hits = f.hits ?? 0;
  if (hits === 0 || !f.last_seen) return "never viewed";
  return `${hits} hit${hits === 1 ? "" : "s"} · last seen ${formatDuration(now - f.last_seen)} ago`;
}

export async function listCommand(opts: { json?: boolean } = {}): Promise<void> {
  const config = loadConfig();

  try {
    const result = await callApi<{ files: FileRecord[] }>(config.api_port, "GET", "/files");
    const files = result.files ?? [];

    if (opts.json) {
      const records = files.map((f) => ({
        slug: f.slug,
        url: publicUrl(config, f.name ?? f.slug),
        filename: f.filename,
        name: f.name ?? null,
        created: f.created,
        expires: f.expires,
        hits: f.hits ?? 0,
        last_seen: f.last_seen ?? null,
        protected: Boolean(f.protected),
      }));
      console.log(JSON.stringify(records));
      return;
    }

    if (files.length === 0) {
      console.log("No deployed files.");
      return;
    }

    const now = Date.now();
    for (const f of files) {
      // Use name as the subdomain if available (stable URL)
      const url = publicUrl(config, f.name ?? f.slug);
      const expiry =
        f.expires > 0
          ? f.expires > now
            ? `expires in ${formatDuration(f.expires - now)}`
            : "EXPIRED"
          : "no expiry";
      const nameTag = f.name ? `  name: ${f.name}` : "";
      console.log(
        `${f.slug}  ${url}  [${f.filename}]${nameTag}  ${expiry}  ${formatHits(f, now)}`
      );
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
