import { loadConfig } from "../config/index.js";
import { removeFile } from "../storage/index.js";

export function rmCommand(slug: string): void {
  const config = loadConfig();
  const removed = removeFile(config.storage_path, slug);
  if (removed) {
    console.log(`✓ Removed ${slug}`);
  } else {
    console.error(`Not found: ${slug}`);
    process.exit(1);
  }
}
