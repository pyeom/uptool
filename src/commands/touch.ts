import { loadConfig, parseTtlMs } from "../config/index.js";
import { callApi, ApiError } from "../lib/api-client.js";

export async function touchCommand(
  slug: string,
  opts: { ttl?: string }
): Promise<void> {
  const config = loadConfig();
  const ttl = opts.ttl ?? config.ttl;

  // Validate locally for a fast, clear error before hitting the API
  try {
    parseTtlMs(ttl);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  try {
    const result = await callApi<{ slug?: string; expires?: number; error?: string }>(
      config.api_port,
      "POST",
      `/files/${slug}/touch`,
      { ttl }
    );
    if (result.error) throw new Error(result.error);
    if (result.expires === 0) {
      console.log(`✓ ${result.slug} never expires`);
    } else {
      console.log(`✓ ${result.slug} expires in ${ttl}`);
    }
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : (err as Error).message;
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}
