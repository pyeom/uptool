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
  /** "http" or "https" — used when building public URLs */
  scheme: string;
  /** Max request body size in bytes for the internal API. Default 10 MB. */
  max_body_bytes: number;
  /** Content-Security-Policy header sent with served HTML. Empty string = omit. */
  csp: string;
  /** Inject live-reload WebSocket script into served HTML. Default true. */
  live_reload: boolean;
  /** How many versions to keep per deployment. 0 = disable versioning. Default 5. */
  max_versions: number;
  /** Path to TLS certificate file (PEM). Optional — enables HTTPS if set with key_file. */
  cert_file?: string;
  /** Path to TLS private key file (PEM). Optional — enables HTTPS if set with cert_file. */
  key_file?: string;
  /**
   * Per-IP request cap for the public server, in requests per minute.
   * 0 = disabled (default). Leave off when behind a reverse proxy / tunnel that
   * collapses every visitor to one source IP — set `trust_proxy` instead.
   */
  rate_limit_rpm: number;
  /**
   * Trust the X-Forwarded-For header for the client IP (rate limiting).
   * Only enable behind a proxy you control (e.g. Cloudflare Tunnel); otherwise
   * clients can spoof their IP. Default false.
   */
  trust_proxy: boolean;
}

export const DEFAULT_CONFIG: Config = {
  base_url: "",
  port: 3000,
  api_port: 3001,
  ttl: "72h",
  storage_path: path.join(os.homedir(), ".uptool", "files"),
  scheme: "http",
  max_body_bytes: 10 * 1024 * 1024, // 10 MB
  csp: "default-src 'self' 'unsafe-inline' 'unsafe-eval' *; img-src * data: blob:;",
  live_reload: true,
  max_versions: 5,
  rate_limit_rpm: 0,
  trust_proxy: false,
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
  // Filter undefined values — smol-toml can't serialize them
  const toWrite = Object.fromEntries(
    Object.entries(config).filter(([, v]) => v !== undefined)
  );
  fs.writeFileSync(configPath(), stringify(toWrite as Record<string, unknown>));
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

/** Build a public URL for a slug (and optional file path within the bundle). */
export function publicUrl(config: Config, slug: string, filePath?: string): string {
  const base = `${config.scheme}://${slug}.${config.base_url}`;
  if (!filePath || filePath === "/") return base;
  return `${base}/${filePath.replace(/^\/+/, "")}`;
}
