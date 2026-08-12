import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as zlib from "node:zlib";
import { Config } from "../config/index.js";
import { ManifestStore } from "../storage/index.js";
import { extractSlug } from "../lib/slug.js";
import { basicAuthOk } from "../lib/basic-auth.js";

/**
 * Tiny inline script injected before </body> when live_reload is enabled.
 * Uses protocol-relative WS URL so it works for both http (ws://) and https (wss://).
 */
const RELOAD_SCRIPT =
  `<script>(function(){` +
  `var p=location.protocol.replace('http','ws');` +
  `var ws=new WebSocket(p+'//'+location.host+'/__lr');` +
  `ws.onmessage=function(e){if(e.data==='reload')location.reload();};` +
  `ws.onclose=function(){setTimeout(function(){location.reload();},2000);};` +
  `}());</script>`;

/**
 * Fixed-window per-IP rate limiter. Dependency-free; memory is bounded by
 * pruning expired windows. `limit <= 0` disables it (always allows).
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; reset: number }>();
  private readonly windowMs = 60_000;

  constructor(private readonly limit: number) {}

  /** Record a hit for `ip`; returns false once the per-minute limit is exceeded. */
  allow(ip: string): boolean {
    if (this.limit <= 0) return true;
    const now = Date.now();
    const rec = this.hits.get(ip);
    if (!rec || now >= rec.reset) {
      this.hits.set(ip, { count: 1, reset: now + this.windowMs });
      return true;
    }
    rec.count++;
    return rec.count <= this.limit;
  }

  /** Drop expired windows so the map can't grow without bound. */
  prune(): void {
    const now = Date.now();
    for (const [ip, rec] of this.hits) {
      if (now >= rec.reset) this.hits.delete(ip);
    }
  }
}

/** Resolve the client IP, honoring proxy headers only when proxy is trusted. */
function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    // CF-Connecting-IP first: Cloudflare rewrites it on every request with the
    // real visitor IP, so unlike X-Forwarded-For a client can't append a fake
    // entry to it. Fall back to XFF for non-Cloudflare proxies.
    const cf = req.headers["cf-connecting-ip"];
    const cfRaw = Array.isArray(cf) ? cf[0] : cf;
    if (cfRaw) return cfRaw.split(",")[0].trim();

    const xff = req.headers["x-forwarded-for"];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    if (raw) return raw.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * Below this, compression costs more bytes (and CPU) than it saves once the
 * Content-Encoding header and the framing are accounted for.
 */
const COMPRESS_MIN_BYTES = 1024;

/** Types worth compressing. Everything else is already compressed (png, woff2, …). */
function isCompressible(contentType: string): boolean {
  const type = contentType.split(";")[0].trim();
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/javascript" ||
    type === "application/xml" ||
    type === "image/svg+xml"
  );
}

/**
 * Compress `body` with the best encoding the client accepts, or return null to
 * send it as-is.
 *
 * Brotli beats gzip on text but its default quality (11) is far too slow to run
 * per request; 5 gives most of the win for a fraction of the cost. Compression
 * is synchronous, which is fine for the sizes uptool serves — deployments are
 * capped at max_file_size (5 MB by default) and text that large is rare.
 */
function compress(
  body: Buffer,
  contentType: string,
  acceptEncoding: string | undefined
): { body: Buffer; encoding: string } | null {
  if (body.length < COMPRESS_MIN_BYTES || !isCompressible(contentType)) return null;

  const accepted = (acceptEncoding ?? "").toLowerCase();
  if (accepted.includes("br")) {
    return {
      body: zlib.brotliCompressSync(body, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
      }),
      encoding: "br",
    };
  }
  if (accepted.includes("gzip")) {
    return { body: zlib.gzipSync(body), encoding: "gzip" };
  }
  return null;
}

function applySecurityHeaders(
  headers: http.OutgoingHttpHeaders,
  config: Config
): void {
  headers["X-Content-Type-Options"] = "nosniff";
  headers["Referrer-Policy"] = "no-referrer";
  if (config.csp) headers["Content-Security-Policy"] = config.csp;
}

function sendErrorPage(
  res: http.ServerResponse,
  status: number,
  config: Config,
  message: string,
  extraHeaders: http.OutgoingHttpHeaders = {}
): void {
  const headers: http.OutgoingHttpHeaders = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
    ...extraHeaders,
  };
  applySecurityHeaders(headers, config);
  res.writeHead(status, headers);
  res.end(`<html><body><h1>${status}</h1><p>${message}</p></body></html>`);
}

function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: Config,
  store: ManifestStore
): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain", Allow: "GET, HEAD" });
    res.end("Method Not Allowed");
    return;
  }

  const host = req.headers.host ?? "";
  const slugOrName = extractSlug(host, config.base_url);

  if (!slugOrName) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><h1>uptool</h1><p>No slug in host: ${host}</p></body></html>`);
    return;
  }

  // Protected deployment? Require Basic Auth before serving anything.
  // Basic Auth (not a ?key= param) so the browser re-sends credentials on
  // every asset request within the bundle (CSS/JS/images).
  const resolved = store.resolveSlug(slugOrName);
  const manifestEntry = resolved ? store.getEntry(resolved) : null;
  const isProtected = Boolean(manifestEntry?.key);
  if (manifestEntry?.key && !basicAuthOk(req, manifestEntry.key)) {
    sendErrorPage(res, 401, config, "Authorization required", {
      "WWW-Authenticate": 'Basic realm="uptool"',
    });
    return;
  }

  // Parse URL path (strip query string)
  const urlPath = new URL(req.url ?? "/", "http://localhost").pathname;

  // Serve the file from the bundle
  const result = store.readFile(slugOrName, urlPath);

  if (!result) {
    sendErrorPage(res, 404, config, `Not found: ${host}${urlPath}`);
    return;
  }

  const isHtml = result.contentType.startsWith("text/html");

  const headers: http.OutgoingHttpHeaders = {
    "Content-Type": result.contentType,
    // Protected content must never land in a shared cache. Otherwise:
    // no-cache HTML (LLM iterate loop — always fresh), long cache for assets.
    "Cache-Control": isProtected
      ? "private, no-store"
      : isHtml
        ? "no-cache"
        : "public, max-age=3600",
  };
  applySecurityHeaders(headers, config);

  let body = result.buffer;

  // Inject live-reload script into HTML responses
  if (isHtml && config.live_reload) {
    let html = result.buffer.toString("utf8");
    if (html.includes("</body>")) {
      html = html.replace("</body>", `${RELOAD_SCRIPT}</body>`);
    } else {
      html += RELOAD_SCRIPT;
    }
    body = Buffer.from(html, "utf8");
  }

  const compressed = compress(body, result.contentType, req.headers["accept-encoding"]);
  if (compressed) {
    body = compressed.body;
    headers["Content-Encoding"] = compressed.encoding;
  }
  // Always announced, even uncompressed: a cache that stored this response must
  // not hand it to a client that negotiated a different encoding.
  headers["Vary"] = "Accept-Encoding";

  headers["Content-Length"] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);

  // Count actual page views only: successful, HTML, not a HEAD probe.
  if (isHtml && req.method === "GET") {
    store.recordHit(slugOrName);
  }
}

/**
 * Create the public-facing HTTP(S) server.
 * If `config.cert_file` and `config.key_file` are both set, returns an HTTPS server.
 */
export function createPublicServer(config: Config, store: ManifestStore): http.Server {
  const limiter = new RateLimiter(config.rate_limit_rpm);

  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    try {
      if (!limiter.allow(clientIp(req, config.trust_proxy))) {
        res.writeHead(429, { "Content-Type": "text/plain", "Retry-After": "60" });
        res.end("Too Many Requests");
        return;
      }
      handleRequest(req, res, config, store);
    } catch (err) {
      // A throw here (e.g. EACCES reading a file) must not take down the daemon.
      if (!res.headersSent) {
        sendErrorPage(res, 500, config, "Internal server error");
      } else {
        res.end();
      }
    }
  };

  let server: http.Server;
  if (config.cert_file && config.key_file) {
    const serverOptions: https.ServerOptions = {
      cert: fs.readFileSync(config.cert_file),
      key: fs.readFileSync(config.key_file),
    };
    // https.Server extends http.Server — cast is safe
    server = https.createServer(serverOptions, handler) as unknown as http.Server;
  } else {
    server = http.createServer(handler);
  }

  // Bound slow/abusive connections. Defaults leave the door open to slowloris
  // when this server faces the public internet.
  server.requestTimeout = 30_000; // whole request must complete in 30s
  server.headersTimeout = 10_000; // headers must arrive within 10s
  server.keepAliveTimeout = 5_000;
  server.timeout = 60_000; // hard socket inactivity cap

  // Prune the rate-limiter map periodically; unref so it never blocks exit.
  if (config.rate_limit_rpm > 0) {
    const t = setInterval(() => limiter.prune(), 60_000);
    t.unref();
    server.on("close", () => clearInterval(t));
  }

  return server;
}
