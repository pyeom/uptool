import { loadConfig } from "../config/index.js";
import { callApi } from "../lib/api-client.js";

export async function rmCommand(slug: string): Promise<void> {
  const config = loadConfig();

  try {
    const result = await callApi<{ removed: boolean; error?: string }>(
      config.api_port,
      "DELETE",
      `/files/${slug}`
    );
    if (result.removed) {
      console.log(`✓ Removed ${slug}`);
    } else {
      console.error(`Not found: ${slug}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
