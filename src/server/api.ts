import * as http from "node:http";
import { Config } from "../config/index.js";
import { ManifestStore, stripMarkdownFences, isValidName } from "../storage/index.js";

const DEFAULT_ENTRY = "index.html";

/**
 * Read the request body, enforcing a maximum byte limit.
 * Rejects with code "TOO_LARGE" if the limit is exceeded.
 */
function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;

    let overflow = false;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes && !overflow) {
        overflow = true;
        const err = new Error("Request entity too large") as NodeJS.ErrnoException;
        err.code = "TOO_LARGE";
        reject(err);
        // Do NOT destroy the socket here — the handler still needs to write
        // the 413 response while the connection is open.
        return;
      }
      if (!overflow) data += chunk.toString();
    });

    req.on("end", () => { if (!overflow) resolve(data); });
    req.on("error", (err) => { if (!overflow) reject(err); });
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

/** Allowed Host header values for the internal API (loopback only). */
function isAllowedApiHost(host: string): boolean {
  const name = host.split(":")[0];
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

export function createApiServer(config: Config, store: ManifestStore): http.Server {
  return http.createServer(async (req, res) => {
    try {
      await handleApiRequest(req, res, config, store);
    } catch (err) {
      // Never let a handler error crash the daemon.
      if (!res.headersSent) json(res, 500, { error: String(err) });
      else res.end();
    }
  });
}

async function handleApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: Config,
  store: ManifestStore
): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    // Reject requests whose Host header is not loopback. The API binds to
    // 127.0.0.1, but that alone does NOT stop DNS-rebinding: a malicious web
    // page can resolve its own domain to 127.0.0.1 and POST here from the
    // user's browser. Validating Host closes that hole — rebind attacks carry
    // the attacker's hostname, not a loopback name.
    if (!isAllowedApiHost(req.headers.host ?? "")) {
      json(res, 403, { error: "Forbidden host" });
      return;
    }

    // ------------------------------------------------------------------
    // POST /deploy — create or update a deployment
    // ------------------------------------------------------------------
    if (req.method === "POST" && url.pathname === "/deploy") {
      let bodyStr: string;
      try {
        bodyStr = await readBody(req, config.max_body_bytes);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "TOO_LARGE") {
          json(res, 413, { error: "Request entity too large" });
        } else {
          json(res, 400, { error: String(err) });
        }
        return;
      }

      try {
        const parsed = JSON.parse(bodyStr) as {
          /** Single HTML string (back-compat). */
          html?: string;
          /** Bundle: relPath → base64 content. */
          files?: Record<string, string>;
          /** Root file within the bundle (default "index.html"). */
          entry?: string;
          /** Display name. */
          filename?: string;
          /** Existing slug (or name) to update instead of creating new. */
          slug?: string;
          /** Stable human-readable name (e.g. "dashboard"). */
          name?: string;
        };

        // Validate name if provided
        if (parsed.name && !isValidName(parsed.name)) {
          json(res, 400, {
            error: `Invalid name "${parsed.name}". Use lowercase letters, digits, hyphens; start with letter/digit; max 31 chars.`,
          });
          return;
        }

        const entry = parsed.entry ?? DEFAULT_ENTRY;
        const filename = parsed.filename ?? "untitled.html";

        // Resolve content: html string OR files bundle
        let html: string | null = null;
        let files: Record<string, string> | null = null;

        if (parsed.html !== undefined) {
          html = stripMarkdownFences(parsed.html);
        } else if (parsed.files !== undefined) {
          files = parsed.files;
        } else {
          json(res, 400, { error: "Provide either 'html' or 'files'" });
          return;
        }

        if (parsed.slug) {
          // Update existing deployment (slug field accepts slug OR name)
          const resolvedSlug = store.update(parsed.slug, html, files, entry, filename);
          json(res, 200, { slug: resolvedSlug });
        } else {
          const slug = store.store(html, files, entry, filename, parsed.name);
          json(res, 200, { slug });
        }
      } catch (err) {
        json(res, 400, { error: String(err) });
      }
      return;
    }

    // ------------------------------------------------------------------
    // DELETE /files/:slug — remove a deployment
    // ------------------------------------------------------------------
    if (req.method === "DELETE" && url.pathname.startsWith("/files/")) {
      const slug = url.pathname.slice("/files/".length);
      const removed = store.remove(slug);
      json(res, removed ? 200 : 404, { removed });
      return;
    }

    // ------------------------------------------------------------------
    // GET /files — list all deployments
    // ------------------------------------------------------------------
    if (req.method === "GET" && url.pathname === "/files") {
      json(res, 200, { files: store.list() });
      return;
    }

    // ------------------------------------------------------------------
    // POST /files/:slug/rollback — restore previous version
    // ------------------------------------------------------------------
    if (
      req.method === "POST" &&
      /^\/files\/[^/]+\/rollback$/.test(url.pathname)
    ) {
      const slug = url.pathname.split("/")[2];
      try {
        const restored = store.rollback(slug);
        if (!restored) {
          json(res, 404, { error: `No versions to roll back for: ${slug}` });
        } else {
          json(res, 200, { restored });
        }
      } catch (err) {
        json(res, 400, { error: String(err) });
      }
      return;
    }

    json(res, 404, { error: "Not found" });
}
