import * as fs from "node:fs";
import * as path from "node:path";
import * as child_process from "node:child_process";
import { bin as packageBin, install } from "cloudflared";

/**
 * Access layer for the `cloudflared` binary: where it lives, how to get it,
 * and how to run one-shot commands with it.
 *
 * The npm `cloudflared` package ships an installer, not the binary — its
 * postinstall is blocked in package.json, so nothing is downloaded until
 * ensureBinary() asks for it. A cloudflared already on the user's PATH is
 * always preferred, which is what saves the ~50MB download for most people.
 *
 * Nothing here spawns long-running processes; tunnels live elsewhere.
 */

const BIN_NAME = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";

export interface CloudflaredResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function isExecutable(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Ruta al binario si ya está disponible, o null si hay que instalarlo. */
export function findBinary(cloudflaredPath?: string): string | null {
  if (cloudflaredPath && cloudflaredPath.trim() && isExecutable(cloudflaredPath)) {
    return cloudflaredPath;
  }

  // Walking PATH by hand instead of shelling out to `which`/`where`: portable
  // across platforms and one less process to spawn.
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, BIN_NAME);
    if (isExecutable(candidate)) return candidate;
  }

  if (fs.existsSync(packageBin)) return packageBin;

  return null;
}

/** Igual que findBinary pero instala el binario si falta. Lanza si no puede. */
export async function ensureBinary(cloudflaredPath?: string): Promise<string> {
  const found = findBinary(cloudflaredPath);
  if (found) return found;

  // Never download 50MB silently in the middle of someone's command.
  console.log("cloudflared not found — downloading it (~50MB, one time)...");
  const installed = await install(packageBin);

  if (!isExecutable(installed)) {
    throw new Error(
      `cloudflared was downloaded to ${installed} but is not executable. ` +
        `Install it yourself and pass its path via cloudflared_path in config.toml.`
    );
  }
  console.log(`cloudflared installed at ${installed}`);
  return installed;
}

/** Versión reportada por el binario, ej. "2026.7.3". */
export async function version(bin?: string): Promise<string> {
  const { stdout, stderr } = await run(["--version"], { bin });
  const line = (stdout + stderr).trim().split("\n")[0] ?? "";
  return /cloudflared version (\S+)/.exec(line)?.[1] ?? line;
}

/** Ejecuta cloudflared con args y captura su salida. No es para procesos de larga duración. */
export function run(
  args: string[],
  opts: { bin?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<CloudflaredResult> {
  const bin = opts.bin ?? findBinary();
  if (!bin) {
    return Promise.reject(
      new Error("cloudflared binary not found — run ensureBinary() first to install it.")
    );
  }
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return new Promise((resolve, reject) => {
    // spawn without a shell: args never get re-parsed, so a hostname with
    // shell metacharacters in it can't turn into a command.
    const child = child_process.spawn(bin, args, {
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`cloudflared ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(new Error(`cloudflared binary not found at ${bin}`));
      } else if (code === "EACCES") {
        reject(new Error(`cloudflared binary at ${bin} is not executable (chmod +x it)`));
      } else {
        reject(err);
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}
