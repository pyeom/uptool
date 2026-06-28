import { loadConfig, publicUrl } from "../config/index.js";
import { callApi } from "../lib/api-client.js";

export async function rollbackCommand(slug: string): Promise<void> {
  const config = loadConfig();

  try {
    const result = await callApi<{ restored?: string; error?: string }>(
      config.api_port,
      "POST",
      `/files/${slug}/rollback`
    );

    if (result.error) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }

    const url = publicUrl(config, slug);
    console.log(`✓ Rolled back ${slug} to version ${result.restored}`);
    console.log(`  ${url}`);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
