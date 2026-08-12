import * as child_process from "node:child_process";

/**
 * A Cloudflare "quick tunnel": a throwaway `*.trycloudflare.com` URL that needs
 * no account, no domain and no DNS record.
 *
 * uptool routes by subdomain, but a quick tunnel only ever gets one hostname.
 * `--http-host-header` bridges the two: cloudflared rewrites the Host to
 * `<slug>.<base_url>` before handing the request to the local server, so the
 * existing subdomain routing keeps working untouched — including the
 * live-reload WebSocket upgrade.
 */

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export interface QuickTunnel {
  /** The public `https://…trycloudflare.com` URL. */
  url: string;
  /** Terminate the tunnel. Resolves once cloudflared is actually gone. */
  close(): Promise<void>;
}

/**
 * Start a quick tunnel to `port`, rewriting the Host header to `hostHeader`.
 * Resolves once cloudflared prints its public URL.
 *
 * Deliberately not supervised: a restarted quick tunnel gets a *different*
 * random URL, so silently reviving it would leave whoever you sent the link to
 * staring at a dead one. If it dies, the caller is told instead.
 */
export function startQuickTunnel(
  bin: string,
  port: number,
  hostHeader: string,
  onExit?: (reason: string) => void,
  timeoutMs = 30_000
): Promise<QuickTunnel> {
  const args = [
    "tunnel",
    "--url",
    `http://127.0.0.1:${port}`,
    "--http-host-header",
    hostHeader,
  ];

  return new Promise<QuickTunnel>((resolve, reject) => {
    // detached: its own process group, so a Ctrl-C in the terminal reaches
    // uptool only. Otherwise cloudflared would take the SIGINT too and die
    // before close() runs, turning an ordinary exit into a scary warning.
    const child = child_process.spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    // cloudflared announces the URL on stderr, but read both: which stream it
    // lands on has moved between releases.
    let output = "";
    let settled = false;
    let closing = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`cloudflared did not report a URL within ${timeoutMs / 1000}s:\n${output}`));
    }, timeoutMs);

    const scan = (chunk: Buffer): void => {
      output += chunk.toString();
      if (settled) return;
      const match = output.match(URL_RE);
      if (!match) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        url: match[0],
        close: () => {
          closing = true;
          return stop(child);
        },
      });
    };

    child.stdout.on("data", scan);
    child.stderr.on("data", scan);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`could not run cloudflared: ${err.message}`));
    });

    child.on("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`cloudflared exited (${signal ?? `code ${code}`}):\n${output}`));
        return;
      }
      // A close() we asked for is not a surprise worth reporting.
      if (!closing) onExit?.(signal ?? `code ${code}`);
    });
  });
}

/** SIGTERM, SIGKILL after 5s, resolving only once the process is really gone. */
function stop(child: child_process.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let kill: NodeJS.Timeout;
    let giveUp: NodeJS.Timeout;
    const done = (): void => {
      clearTimeout(kill);
      clearTimeout(giveUp);
      resolve();
    };

    kill = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 5000);
    giveUp = setTimeout(done, 6000);

    child.once("exit", done);
    try {
      child.kill("SIGTERM");
    } catch {
      done();
    }
  });
}
