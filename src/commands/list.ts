import { loadConfig, publicUrl } from "../config/index.js";
import { callApi } from "../lib/api-client.js";

function formatDuration(ms: number): string {
  const h = Math.floor(ms / (1000 * 60 * 60));
  const m = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export async function listCommand(): Promise<void> {
  const config = loadConfig();

  try {
    const result = await callApi<{
      files: Array<{
        slug: string;
        filename: string;
        created: number;
        expires: number;
        name?: string;
      }>;
    }>(config.api_port, "GET", "/files");

    if (!result.files || result.files.length === 0) {
      console.log("No deployed files.");
      return;
    }

    const now = Date.now();
    for (const f of result.files) {
      // Use name as the subdomain if available (stable URL)
      const url = publicUrl(config, f.name ?? f.slug);
      const expiry =
        f.expires > 0
          ? f.expires > now
            ? `expires in ${formatDuration(f.expires - now)}`
            : "EXPIRED"
          : "no expiry";
      const nameTag = f.name ? `  name: ${f.name}` : "";
      console.log(`${f.slug}  ${url}  [${f.filename}]${nameTag}  ${expiry}`);
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
