import * as readline from "node:readline";
import * as http from "node:http";
import { loadConfig, saveConfig, configPath, DEFAULT_CONFIG, Config } from "../config/index.js";

function prompt(rl: readline.Interface, question: string, fallback: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`${question} [${fallback}]: `, (answer) => {
      resolve(answer.trim() || fallback);
    });
  });
}

function loadOrDefault(): Config {
  try {
    return loadConfig();
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function testUrl(baseUrl: string, port: number): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const hostname = `test.${baseUrl}`;
    const req = http.get({ hostname, port, path: "/", timeout: 4000 }, (res) => {
      resolve({ ok: true, detail: `HTTP ${res.statusCode} from ${hostname}:${port}` });
      res.resume();
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, detail: `timeout connecting to ${hostname}:${port}` });
    });
    req.on("error", (err) => {
      resolve({ ok: false, detail: err.message });
    });
  });
}

export async function setUrlCommand(): Promise<void> {
  const config = loadOrDefault();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const base_url = await prompt(rl, "Base URL (e.g. mydev.com)", config.base_url || "mydev.com");
  rl.close();

  config.base_url = base_url;
  saveConfig(config);
  console.log(`✓ base_url set to ${base_url}`);

  process.stdout.write(`  Testing connectivity to test.${base_url}:${config.port} ... `);
  const result = await testUrl(base_url, config.port);
  if (result.ok) {
    console.log(`OK (${result.detail})`);
  } else {
    console.log(`unreachable (${result.detail})`);
    console.log(`  Server may not be running or DNS/port-forward not set up yet.`);
  }
}

export async function setPortCommand(): Promise<void> {
  const config = loadOrDefault();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const portStr = await prompt(rl, "Public HTTP port", String(config.port));
  rl.close();

  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error("Invalid port number.");
    process.exit(1);
  }
  config.port = port;
  saveConfig(config);
  console.log(`✓ port set to ${port}`);
}

export async function setApiPortCommand(): Promise<void> {
  const config = loadOrDefault();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const portStr = await prompt(rl, "Internal API port", String(config.api_port));
  rl.close();

  const api_port = parseInt(portStr, 10);
  if (isNaN(api_port) || api_port < 1 || api_port > 65535) {
    console.error("Invalid port number.");
    process.exit(1);
  }
  config.api_port = api_port;
  saveConfig(config);
  console.log(`✓ api_port set to ${api_port}`);
}

export async function setStorageCommand(): Promise<void> {
  const config = loadOrDefault();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const storage_path = await prompt(rl, "Storage path", config.storage_path);
  rl.close();

  config.storage_path = storage_path;
  saveConfig(config);
  console.log(`✓ storage_path set to ${storage_path}`);
}

export async function configCommand(): Promise<void> {
  const config = loadOrDefault();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("uptool config — update settings (enter to keep current value)\n");

  const base_url = await prompt(rl, "Base URL", config.base_url || "mydev.com");
  const portStr = await prompt(rl, "Public HTTP port", String(config.port));
  const apiPortStr = await prompt(rl, "Internal API port", String(config.api_port));
  const ttl = await prompt(rl, "File TTL (e.g. 72h, 7d, 0 = no expiry)", config.ttl);
  const storage_path = await prompt(rl, "Storage path", config.storage_path);

  rl.close();

  const port = parseInt(portStr, 10);
  const api_port = parseInt(apiPortStr, 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    console.error("Invalid port number.");
    process.exit(1);
  }
  if (isNaN(api_port) || api_port < 1 || api_port > 65535) {
    console.error("Invalid API port number.");
    process.exit(1);
  }

  const updated: Config = { ...config, base_url, port, api_port, ttl, storage_path };
  saveConfig(updated);
  console.log(`\n✓ Config saved to ${configPath()}`);
}
