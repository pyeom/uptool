import { loadConfig, parseTtlMs } from "../config/index.js";
import { callApi, ApiError } from "../lib/api-client.js";

interface Pruned {
  slug: string;
  filename: string;
  reason: string;
}

/**
 * Reclaim deployments on demand.
 *
 * The daemon already sweeps expired ones hourly; this exists for the other
 * half — the pile of one-off deploys nobody ever opened.
 */
export async function pruneCommand(opts: {
  unseen?: string;
  dryRun?: boolean;
  json?: boolean;
}): Promise<void> {
  const config = loadConfig();

  if (opts.unseen !== undefined) {
    try {
      parseTtlMs(opts.unseen);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  }

  try {
    const result = await callApi<{ pruned?: Pruned[]; error?: string }>(
      config.api_port,
      "POST",
      "/prune",
      { unseen: opts.unseen, dry_run: opts.dryRun }
    );
    if (result.error) throw new Error(result.error);
    const pruned = result.pruned ?? [];

    if (opts.json) {
      console.log(JSON.stringify(pruned));
      return;
    }

    if (pruned.length === 0) {
      console.log(opts.unseen ? "Nothing to prune." : "Nothing expired.");
      return;
    }

    for (const { slug, filename, reason } of pruned) {
      console.log(`${opts.dryRun ? "would remove" : "removed"}  ${slug}  [${filename}]  ${reason}`);
    }
    console.log(
      opts.dryRun
        ? `\n${pruned.length} would be removed. Re-run without --dry-run to do it.`
        : `\n${pruned.length} removed.`
    );
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : (err as Error).message;
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}
