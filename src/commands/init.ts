import * as readline from "node:readline";
import * as path from "node:path";
import * as os from "node:os";
import { Config, DEFAULT_CONFIG, saveConfig, configPath } from "../config/index.js";

function prompt(rl: readline.Interface, question: string, fallback: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`${question} [${fallback}]: `, (answer) => {
      resolve(answer.trim() || fallback);
    });
  });
}

export async function initCommand(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("uptool init — configure your HTML serving setup\n");

  const base_url = await prompt(rl, "Base URL (e.g. mydev.com)", DEFAULT_CONFIG.base_url || "mydev.com");
  const portStr = await prompt(rl, "Public HTTP port", String(DEFAULT_CONFIG.port));
  const apiPortStr = await prompt(rl, "Internal API port", String(DEFAULT_CONFIG.api_port));
  const ttl = await prompt(rl, "File TTL (e.g. 72h, 7d, 0 = no expiry)", DEFAULT_CONFIG.ttl);
  const storage_path = await prompt(
    rl,
    "Storage path",
    path.join(os.homedir(), ".uptool", "files")
  );

  rl.close();

  const config: Config = {
    base_url,
    port: parseInt(portStr, 10),
    api_port: parseInt(apiPortStr, 10),
    ttl,
    storage_path,
  };

  saveConfig(config);
  console.log(`\n✓ Config saved to ${configPath()}`);
  console.log(`\nDNS setup required:`);
  console.log(`  Add a wildcard A record: *.${base_url} → <your machine's public IP>`);
  console.log(`  If behind a router, forward port ${config.port} to this machine.`);
  console.log(`\nNo static IP? Use Cloudflare Tunnel:`);
  console.log(`  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/`);
  console.log(`\nStart serving: uptool serve`);
}
