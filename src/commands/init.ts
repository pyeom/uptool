import * as fs from "node:fs";
import * as readline from "node:readline";
import * as path from "node:path";
import * as os from "node:os";
import {
  Config,
  DEFAULT_CONFIG,
  saveConfig,
  configPath,
  loadOrGenerateToken,
  tokenPath,
} from "../config/index.js";

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

  console.log("No domain? Keep the default and share files with: uptool share <file>\n");
  const base_url = await prompt(
    rl,
    "Base URL (a domain you own, e.g. mydev.com)",
    DEFAULT_CONFIG.base_url
  );
  const portStr = await prompt(rl, "Public HTTP port", String(DEFAULT_CONFIG.port));
  const apiPortStr = await prompt(rl, "Internal API port", String(DEFAULT_CONFIG.api_port));
  const ttl = await prompt(rl, "File TTL (e.g. 72h, 7d, 0 = no expiry)", DEFAULT_CONFIG.ttl);
  const storage_path = await prompt(
    rl,
    "Storage path",
    path.join(os.homedir(), ".uptool", "files")
  );

  const tunnelAnswer = await prompt(
    rl,
    "Expose with Cloudflare Tunnel? (no port forwarding, HTTPS included) (y/n)",
    "n"
  );

  rl.close();

  // Only a signpost: `uptool tunnel setup` is what writes tunnel = "cloudflare",
  // after checking the certificate, the zone and the DNS record are in place.
  const wantsTunnel = /^y/i.test(tunnelAnswer);

  const config: Config = {
    ...DEFAULT_CONFIG,
    base_url,
    port: parseInt(portStr, 10),
    api_port: parseInt(apiPortStr, 10),
    ttl,
    storage_path,
  };

  saveConfig(config);
  const tokenExisted = fs.existsSync(tokenPath());
  loadOrGenerateToken();
  console.log(`\n✓ Config saved to ${configPath()}`);
  console.log(
    tokenExisted
      ? `✓ Auth token ready (existing ~/.uptool/token kept)`
      : `✓ Auth token generated (stored in ~/.uptool/token)`
  );
  if (wantsTunnel) {
    console.log(`\nTunnel setup (${base_url} must be a zone in your Cloudflare account):`);
    console.log(`  1. uptool tunnel login   — authorize cloudflared for the zone`);
    console.log(`  2. uptool tunnel setup   — create the tunnel and switch uptool over`);
    console.log(`\nNo wildcard A record and no port forwarding needed.`);
  } else {
    console.log(`\nDNS setup required:`);
    console.log(`  Add a wildcard A record: *.${base_url} → <your machine's public IP>`);
    console.log(`  If behind a router, forward port ${config.port} to this machine.`);
    console.log(`\nNo static IP? Use Cloudflare Tunnel:`);
    console.log(`  uptool tunnel login && uptool tunnel setup`);
  }
  console.log(`\nStart serving: uptool serve`);
}
