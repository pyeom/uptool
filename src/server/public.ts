import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { Config } from "../config/index.js";
import { ManifestStore } from "../storage/index.js";

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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

/** Resolve the client IP, honoring X-Forwarded-For only when proxy is trusted. */
function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    if (raw) return raw.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** Extract the subdomain slug from the Host header. Returns null if not a valid subdomain. */
function extractSlug(host: string, baseUrl: string): string | null {
  const base = baseUrl.replace(/^https?:\/\//, "");
  const slug = host.replace(new RegExp(`\\.${escapeRegex(base)}(:\\d+)?$`), "");
  if (!slug || slug === host) return null;
  return slug;
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
  message: string
): void {
  const headers: http.OutgoingHttpHeaders = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
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
  const host = req.headers.host ?? "";
  const slugOrName = extractSlug(host, config.base_url);

  if (!slugOrName) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><h1>uptool</h1><p>No slug in host: ${host}</p></body></html>`);
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
    // Cache HTML with no-cache (LLM iterate loop — always fresh);
    // long cache for static assets
    "Cache-Control": isHtml ? "no-cache" : "public, max-age=3600",
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

  headers["Content-Length"] = body.length;
  res.writeHead(200, headers);
  res.end(body);
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
