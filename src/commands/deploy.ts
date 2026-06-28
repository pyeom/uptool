import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, publicUrl, parseTtlMs } from "../config/index.js";
import { callApi } from "../lib/api-client.js";
import { validateBundlePath } from "../storage/index.js";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

/** Recursively collect files in a directory, skipping dotfiles and node_modules. */
function walkDir(dir: string, baseDir: string): Array<{ rel: string; full: string }> {
  const results: Array<{ rel: string; full: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(baseDir, full).replace(/\\/g, "/"); // normalise separators
    if (entry.isDirectory()) {
      results.push(...walkDir(full, baseDir));
    } else {
      results.push({ rel, full });
    }
  }
  return results;
}

export async function deployCommand(
  filePath: string | undefined,
  opts: { update?: string; name?: string }
): Promise<void> {
  const config = loadConfig();

  let body: Record<string, unknown>;

  if (!filePath) {
    // No path → read from stdin (single HTML)
    const html = await readStdin();
    if (!html.trim()) {
      console.error("No content provided.");
      process.exit(1);
    }
    body = { html, filename: "stdin.html" };

  } else if (!fs.existsSync(filePath)) {
    console.error(`Not found: ${filePath}`);
    process.exit(1);
    return;

  } else if (fs.statSync(filePath).isDirectory()) {
    // Directory → bundle
    const entries = walkDir(filePath, filePath);
    if (entries.length === 0) {
      console.error("Directory is empty.");
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

    // Determine entry point
    let entry = "index.html";
    if (!files["index.html"]) {
      const htmlFiles = Object.keys(files).filter((p) => p.endsWith(".html") && !p.includes("/"));
      if (htmlFiles.length === 1) {
        entry = htmlFiles[0];
      } else if (htmlFiles.length === 0) {
        console.error("No HTML files found in directory (top-level).");
        process.exit(1);
      } else {
        console.error(
          `Multiple HTML files found at root level with no index.html. Add an index.html or use --update with a specific file.`
        );
        process.exit(1);
      }
    }

    body = { files, entry, filename: path.basename(path.resolve(filePath)) };

  } else {
    // Single file
    const html = fs.readFileSync(filePath, "utf8");
    body = { html, filename: path.basename(filePath) };
  }

  if (opts.update) body.slug = opts.update;
  if (opts.name) body.name = opts.name;

  try {
    const result = await callApi<{ slug?: string; error?: string }>(
      config.api_port,
      "POST",
      "/deploy",
      body
    );
    if (result.error) throw new Error(result.error);
    // For updates the server returns the (possibly resolved) slug
    const slug = result.slug ?? (opts.update as string);
    const url = publicUrl(config, slug);
    const ttlMs = parseTtlMs(config.ttl);
    const expiry = ttlMs > 0 ? `  (expires in ${config.ttl})` : "";
    console.log(`✓ ${url}${expiry}`);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
