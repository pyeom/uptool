import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import qrcode from "qrcode-terminal";
import { loadConfig, publicUrl, parseTtlMs, type Config } from "../config/index.js";
import { callApi } from "../lib/api-client.js";
import { validateBundlePath } from "../storage/index.js";
import { debounce, formatTime } from "../lib/watch.js";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

/** Recursively collect files in a directory, skipping dotfiles and node_modules. */
export function walkDir(dir: string, baseDir: string): Array<{ rel: string; full: string }> {
  const results: Array<{ rel: string; full: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(baseDir, full).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      results.push(...walkDir(full, baseDir));
    } else {
      results.push({ rel, full });
    }
  }
  return results;
}

export async function buildBody(
  filePath: string | undefined
): Promise<Record<string, unknown>> {
  if (!filePath) {
    const html = await readStdin();
    if (!html.trim()) {
      console.error("No content provided.");
      process.exit(1);
    }
    return { html, filename: "stdin.html" };
  }

  if (!fs.existsSync(filePath)) {
    console.error(`Not found: ${filePath}`);
    process.exit(1);
    return {};
  }

  if (fs.statSync(filePath).isDirectory()) {
    const entries = walkDir(filePath, filePath);
    if (entries.length === 0) {
      console.error(`Directory is empty: ${filePath}`);
      process.exit(1);
    }

    const files: Record<string, string> = {};
    for (const { rel, full } of entries) {
      if (!validateBundlePath(rel)) {
        console.warn(`Skipping invalid path: ${rel}`);
        continue;
      }
      files[rel] = fs.readFileSync(full).toString("base64");
    }

    let entry = "index.html";
    if (!files["index.html"]) {
      const htmlFiles = Object.keys(files).filter((p) => p.endsWith(".html") && !p.includes("/"));
      if (htmlFiles.length === 1) {
        entry = htmlFiles[0];
      } else if (htmlFiles.length === 0) {
        console.error(`No HTML files found in directory (top-level): ${filePath}`);
        process.exit(1);
      } else {
        console.error(
          `Multiple HTML files found at root level with no index.html: ${filePath}`
        );
        process.exit(1);
      }
    }

    return { files, entry, filename: path.basename(path.resolve(filePath)) };
  }

  const html = fs.readFileSync(filePath, "utf8");
  return { html, filename: path.basename(filePath) };
}

/** Watch a file or directory and redeploy (in place, by slug) on change. */
function watchAndRedeploy(
  target: string,
  slug: string,
  key: string | undefined,
  config: Config,
  ttl?: string
): void {
  console.log(`\nWatching ${target} for changes... (Ctrl-C to stop)`);

  const redeploy = debounce(async () => {
    try {
      const body = await buildBody(target);
      body.slug = slug;
      if (key) body.key = key;
      // Without this every redeploy would silently reset the expiry to the
      // config default, quietly undoing an explicit --ttl.
      if (ttl !== undefined) body.ttl = ttl;
      const result = await callApi<{ slug?: string; error?: string }>(
        config.api_port,
        "POST",
        "/deploy",
        body
      );
      if (result.error) throw new Error(result.error);
      // `slug` here is the stable identifier (name if one was assigned, else
      // the random slug) — it doesn't change across redeploys, unlike
      // result.slug which is always the underlying random slug.
      const url = publicUrl(config, slug);
      console.log(`↻ redeployed ${url} (${formatTime()})`);
    } catch (err) {
      console.error(`Error redeploying: ${(err as Error).message}`);
    }
  }, 300);

  const isDir = fs.statSync(target).isDirectory();

  if (isDir) {
    try {
      fs.watch(target, { recursive: true }, () => redeploy());
      return;
    } catch {
      // Recursive fs.watch unavailable on this platform/Node version — fall
      // back to watching each file individually.
      for (const { full } of walkDir(target, target)) {
        try {
          fs.watch(full, () => redeploy());
        } catch {
          // ignore files that can't be watched
        }
      }
    }
  } else {
    fs.watch(target, () => redeploy());
  }
}

export async function deployCommand(
  filePaths: string[],
  opts: {
    update?: string;
    name?: string;
    protect?: string | boolean;
    qr?: boolean;
    watch?: boolean;
    ttl?: string;
  }
): Promise<void> {
  const config = loadConfig();

  // Validate locally for a fast, clear error before writing anything.
  if (opts.ttl !== undefined) {
    try {
      parseTtlMs(opts.ttl);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  }

  const multi = filePaths.length > 1;
  if (multi && (opts.update || opts.name)) {
    console.error("--update and --name are not supported when deploying multiple files.");
    process.exit(1);
  }

  if (opts.watch && filePaths.length !== 1) {
    console.error("--watch requires exactly one file or directory argument (no stdin).");
    process.exit(1);
  }

  // --protect: true = autogenerate a key, string = user-supplied key
  const key =
    opts.protect === true
      ? crypto.randomBytes(12).toString("base64url")
      : opts.protect || undefined;

  const targets = filePaths.length === 0 ? [undefined] : filePaths;
  const ttl = opts.ttl ?? config.ttl;
  const ttlMs = parseTtlMs(ttl);
  const expiry = ttlMs > 0 ? `  (expires in ${ttl})` : "";

  let anyError = false;
  let watchTarget: string | undefined;
  let watchSlug: string | undefined;

  for (const filePath of targets) {
    const body = await buildBody(filePath);

    if (!opts.update && opts.name) body.name = opts.name;
    if (opts.update) body.slug = opts.update;
    if (key) body.key = key;
    if (opts.ttl !== undefined) body.ttl = opts.ttl;

    try {
      const result = await callApi<{ slug?: string; error?: string }>(
        config.api_port,
        "POST",
        "/deploy",
        body
      );
      if (result.error) throw new Error(result.error);
      // Stable identifier: whatever the caller addressed the deployment by
      // (--update value, or the name just assigned) — it stays valid across
      // redeploys, unlike result.slug. Falls back to the random slug.
      const urlSlug = opts.update ?? opts.name ?? (result.slug as string);
      const url = publicUrl(config, urlSlug);
      console.log(`✓ ${url}${expiry}`);
      if (key) console.log(`  key: ${key}  (Basic Auth password — any username)`);
      if (opts.qr) qrcode.generate(url, { small: true });
      if (opts.watch && filePath) {
        watchTarget = filePath;
        watchSlug = urlSlug;
      }
    } catch (err) {
      console.error(`Error deploying ${filePath ?? "stdin"}: ${(err as Error).message}`);
      anyError = true;
    }
  }

  if (anyError) process.exit(1);

  if (opts.watch && watchTarget && watchSlug) {
    watchAndRedeploy(watchTarget, watchSlug, key, config, opts.ttl);
  }
}
