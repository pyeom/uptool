import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import * as child_process from "node:child_process";

/**
 * Shared test infrastructure for spawning the real CLI/daemon as child
 * processes. Everything here isolates HOME so tests never touch the
 * developer's real ~/.uptool (config, token, deployed files).
 */

const ROOT = path.join(__dirname, "..");
export const CLI_PATH = path.join(ROOT, "dist", "cli.js");

/**
 * Throwaway directory to use as HOME for a spawned CLI process.
 *
 * GUARANTEE: src/config/index.ts derives every path it touches
 * (configDir/configPath/tokenPath/storage_path default/etc.) from
 * os.homedir(), and Node's os.homedir() on Linux/macOS reads the HOME env
 * var. Every helper here that spawns a child process sets HOME to this
 * directory, so nothing spawned through these helpers can read or write the
 * real ~/.uptool. This does NOT protect you if you call functions from
 * src/config directly in-process in the test runner itself (that process's
 * real HOME is unaffected but so is os.homedir() — don't call loadConfig()
 * etc. without an isolated HOME of your own in that case).
 */
export function tempHome(): { home: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "uptool-test-"));
  fs.mkdirSync(path.join(home, ".uptool"), { recursive: true });
  liveHomes.add(home);
  return {
    home,
    cleanup: () => {
      liveHomes.delete(home);
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

// Safety net. A test that throws before its cleanup(), or a daemon whose stop()
// never runs, would otherwise leak a temp dir and a live `serve` process for
// every such case. These track what this process created so it can be reclaimed
// on the way out regardless of how the test ended.
const liveHomes = new Set<string>();
const liveDaemons = new Set<child_process.ChildProcess>();

process.on("exit", () => {
  for (const child of liveDaemons) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const home of liveHomes) {
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      // best effort — the exit handler must not throw
    }
  }
});

export interface ConfigOverrides {
  base_url?: string;
  port?: number;
  api_port?: number;
  ttl?: string;
  storage_path?: string;
  token?: string;
}

/**
 * Writes a valid config.toml + token file (mode 0600) into a temp home, so a
 * spawned CLI has something to load. Returns the token used.
 */
export function writeConfig(home: string, overrides: ConfigOverrides = {}): string {
  const uptoolDir = path.join(home, ".uptool");
  fs.mkdirSync(uptoolDir, { recursive: true });

  const base_url = overrides.base_url ?? "test.local";
  const port = overrides.port ?? 0;
  const api_port = overrides.api_port ?? 0;
  const ttl = overrides.ttl ?? "72h";
  const storage_path = overrides.storage_path ?? path.join(uptoolDir, "files");
  const token = overrides.token ?? "test-token-" + Math.random().toString(36).slice(2);

  const configToml = [
    `base_url = "${base_url}"`,
    `port = ${port}`,
    `api_port = ${api_port}`,
    `ttl = "${ttl}"`,
    `storage_path = ${JSON.stringify(storage_path)}`,
  ].join("\n");
  fs.writeFileSync(path.join(uptoolDir, "config.toml"), configToml);
  fs.writeFileSync(path.join(uptoolDir, "token"), token, { mode: 0o600 });
  fs.chmodSync(path.join(uptoolDir, "token"), 0o600);

  return token;
}

/**
 * Reserve an ephemeral TCP port by binding to port 0 and reading it back,
 * then closing the socket. Note: there's an inherent race between closing
 * this probe socket and a later process rebinding the same port number — a
 * concurrent process could grab it first. Prefer letting servers themselves
 * bind port 0 and report back their address where that's possible (e.g.
 * in-process http.Server via server.listen(0) + server.address().port);
 * this helper is for cases where the port must be chosen ahead of spawning
 * a child process (e.g. passed via config.toml before `serve` starts).
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

/** Poll until a TCP port accepts connections, or reject after timeoutMs. */
export function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Timed out waiting for port ${port}`));
        } else {
          setTimeout(attempt, 100);
        }
      });
    };
    attempt();
  });
}

function assertCliBuilt(): void {
  if (!fs.existsSync(CLI_PATH)) {
    throw new Error(
      `dist/cli.js not found at ${CLI_PATH}. The test suite runs the built CLI as a ` +
        `child process — run "npm run build" first (or just "npm test", which builds ` +
        `automatically).`
    );
  }
}

export interface Daemon {
  apiPort: number;
  pubPort: number;
  token: string;
  home: string;
  stop: () => Promise<void>;
}

export interface StartDaemonOpts extends ConfigOverrides {
  /** Extra env vars to set on the spawned process. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawns `node dist/cli.js serve --foreground` with an isolated HOME and
 * ephemeral ports, waits until both the API and public servers are actually
 * accepting connections, and returns the resolved ports plus a stop()
 * that kills the process and waits for exit. Never leaves the process
 * running if startup fails partway through.
 */
export async function startDaemon(opts: StartDaemonOpts = {}): Promise<Daemon> {
  assertCliBuilt();

  const { home, cleanup } = tempHome();
  const pubPort = opts.port ?? (await freePort());
  const apiPort = opts.api_port ?? (await freePort());
  const token = writeConfig(home, { ...opts, port: pubPort, api_port: apiPort });

  const child = child_process.spawn(process.execPath, [CLI_PATH, "serve", "--foreground"], {
    env: { ...process.env, ...opts.env, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  liveDaemons.add(child);

  // Drain both pipes: an unread pipe fills at ~64KB and blocks the daemon.
  // Keep only the recent tail, for the startup-failure message.
  const TAIL = 8 * 1024;
  let out = "";
  let err = "";
  child.stdout.on("data", (c: Buffer) => (out = (out + c).slice(-TAIL)));
  child.stderr.on("data", (c: Buffer) => (err = (err + c).slice(-TAIL)));

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    liveDaemons.delete(child);
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    cleanup();
  };

  try {
    await waitForPort(apiPort);
    await waitForPort(pubPort);
  } catch (e) {
    await stop();
    throw new Error(
      `daemon failed to start: ${(e as Error).message}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`
    );
  }

  return { apiPort, pubPort, token, home, stop };
}

export interface RunCliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface RunCliOpts {
  home?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Runs `node dist/cli.js <args>` with an isolated HOME (a fresh tempHome()
 * unless one is passed in `opts.home`, e.g. to talk to a daemon started with
 * startDaemon()), optional stdin input, and returns { stdout, stderr, code }.
 */
export function runCli(args: string[], opts: RunCliOpts = {}): Promise<RunCliResult> {
  assertCliBuilt();

  const home = opts.home ?? tempHome().home;

  return new Promise((resolve, reject) => {
    const child = child_process.spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, ...opts.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`runCli timed out after ${opts.timeoutMs ?? 15_000}ms: ${args.join(" ")}`));
    }, opts.timeoutMs ?? 15_000);

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();

    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code });
    });
  });
}
