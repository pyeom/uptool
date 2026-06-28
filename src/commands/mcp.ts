import * as http from "node:http";
import * as fs from "node:fs";
import * as readline from "node:readline";
import { loadConfig, parseTtlMs, pidPath } from "../config/index.js";
import type { Config } from "../config/index.js";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

function send(id: number | string | null | undefined, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }) + "\n");
}

function sendError(id: number | string | null | undefined, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }) + "\n");
}

function callApi(config: Config, method: string, path: string, body?: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: config.api_port,
      path,
      method,
      headers: payload
        ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
        : {},
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid API response: ${data}`));
        }
      });
    });
    req.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
        reject(new Error("uptool server not running — run: uptool serve"));
      } else {
        reject(err);
      }
    });
    if (payload) req.write(payload);
    req.end();
  });
}

const TOOLS = [
  {
    name: "deploy_html",
    description:
      "Deploy HTML content and get a public URL served from your wildcard subdomain. Returns the URL.",
    inputSchema: {
      type: "object",
      properties: {
        html: { type: "string", description: "HTML content to deploy" },
        filename: { type: "string", description: "Display name for the file (optional, defaults to claude.html)" },
        slug: { type: "string", description: "Existing slug to update rather than create a new deployment (optional)" },
      },
      required: ["html"],
    },
  },
  {
    name: "list_deployments",
    description: "List all currently deployed HTML files with their URLs and expiry times.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "remove_deployment",
    description: "Remove a deployed HTML file by its slug.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Slug of the deployment to remove" },
      },
      required: ["slug"],
    },
  },
  {
    name: "server_status",
    description: "Check if the uptool server daemon is running and get its base URL.",
    inputSchema: { type: "object", properties: {} },
  },
];

function formatDuration(ms: number): string {
  const h = Math.floor(ms / (1000 * 60 * 60));
  const m = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function handleToolCall(
  config: Config,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "deploy_html": {
      const html = String(args.html ?? "");
      const filename = String(args.filename ?? "claude.html");
      const slug = args.slug ? String(args.slug) : undefined;
      const body: Record<string, string> = { html, filename };
      if (slug) body.slug = slug;
      const result = (await callApi(config, "POST", "/deploy", body)) as {
        slug?: string;
        error?: string;
      };
      if (result.error) throw new Error(result.error);
      const url = `http://${result.slug}.${config.base_url}`;
      const ttlMs = parseTtlMs(config.ttl);
      const expiry = ttlMs > 0 ? ` (expires in ${config.ttl})` : "";
      return `${url}${expiry}`;
    }

    case "list_deployments": {
      const result = (await callApi(config, "GET", "/files")) as {
        files: Array<{ slug: string; filename: string; created: number; expires: number }>;
      };
      if (!result.files || result.files.length === 0) return "No deployments found.";
      const now = Date.now();
      return result.files
        .map((f) => {
          const url = `http://${f.slug}.${config.base_url}`;
          const expiry =
            f.expires > 0
              ? f.expires > now
                ? `expires in ${formatDuration(f.expires - now)}`
                : "EXPIRED"
              : "no expiry";
          return `${f.slug}  ${url}  [${f.filename}]  ${expiry}`;
        })
        .join("\n");
    }

    case "remove_deployment": {
      const slug = String(args.slug ?? "");
      const result = (await callApi(config, "DELETE", `/files/${slug}`)) as { removed: boolean };
      return result.removed ? `Removed: ${slug}` : `Not found: ${slug}`;
    }

    case "server_status": {
      const pidFile = pidPath();
      if (!fs.existsSync(pidFile)) return "uptool: stopped";
      const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      try {
        process.kill(pid, 0);
        return `uptool: running (pid ${pid})\nBase URL: http://<slug>.${config.base_url}`;
      } catch {
        return `uptool: stopped (stale PID ${pid})`;
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function mcpCommand(): void {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`uptool mcp: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: RpcRequest;
    try {
      req = JSON.parse(trimmed) as RpcRequest;
    } catch {
      sendError(null, -32700, "Parse error");
      return;
    }

    // Notifications have no id and require no response
    if (req.id === undefined && req.method.startsWith("notifications/")) return;

    try {
      switch (req.method) {
        case "initialize":
          send(req.id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "uptool", version: "0.1.0" },
          });
          break;

        case "tools/list":
          send(req.id, { tools: TOOLS });
          break;

        case "tools/call": {
          const { name, arguments: args = {} } = req.params as {
            name: string;
            arguments?: Record<string, unknown>;
          };
          try {
            const text = await handleToolCall(config, name, args);
            send(req.id, { content: [{ type: "text", text }] });
          } catch (err) {
            send(req.id, {
              content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
              isError: true,
            });
          }
          break;
        }

        default:
          sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      sendError(req.id, -32603, `Internal error: ${(err as Error).message}`);
    }
  });

  rl.on("close", () => process.exit(0));
}
