import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse, stringify } from "smol-toml";

export interface Config {
  base_url: string;
  port: number;
  api_port: number;
  ttl: string;
  storage_path: string;
}

export const DEFAULT_CONFIG: Config = {
  base_url: "",
  port: 3000,
  api_port: 3001,
  ttl: "72h",
  storage_path: path.join(os.homedir(), ".uptool", "files"),
};

export function configDir(): string {
  return path.join(os.homedir(), ".uptool");
}

export function configPath(): string {
  return path.join(configDir(), "config.toml");
}

export function pidPath(): string {
  return path.join(configDir(), "uptool.pid");
}

export function logPath(): string {
  return path.join(configDir(), "server.log");
}

export function loadConfig(): Config {
  const p = configPath();
  if (!fs.existsSync(p)) {
    throw new Error(`Config not found. Run: uptool init`);
  }
  const raw = fs.readFileSync(p, "utf8");
  const parsed = parse(raw) as Partial<Config>;
  return { ...DEFAULT_CONFIG, ...parsed };
}

export function saveConfig(config: Config): void {
  const dir = configDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), stringify(config as unknown as Record<string, unknown>));
}

export function resolvePath(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}

export function parseTtlMs(ttl: string): number {
  if (!ttl || ttl === "0") return 0;
  const match = ttl.match(/^(\d+)(h|d|m)$/);
  if (!match) throw new Error(`Invalid TTL format: ${ttl}. Use e.g. 72h, 7d, 30m`);
  const n = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === "h") return n * 60 * 60 * 1000;
  if (unit === "d") return n * 24 * 60 * 60 * 1000;
  if (unit === "m") return n * 60 * 1000;
  return 0;
}
