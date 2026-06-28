import * as fs from "node:fs";
import * as readline from "node:readline";
import { loadConfig, parseTtlMs, pidPath, publicUrl } from "../config/index.js";
import type { Config } from "../config/index.js";
import { callApi } from "../lib/api-client.js";

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
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }) + "\n"
  );
}

const TOOLS = [
  {
    name: "deploy_html",
    description:
      "Deploy HTML content (or a file bundle) and get a public URL served from your wildcard subdomain. Returns the URL.",
    inputSchema: {
      type: "object",
      properties: {
        html: { type: "string", description: "HTML content to deploy (single-file mode)" },
        files: {
          type: "object",
          description:
            "Bundle mode: object mapping relative file paths to base64-encoded content (e.g. { 'index.html': '<base64>', 'style.css': '<base64>' }). Use instead of 'html' for multi-file deployments.",
          additionalProperties: { type: "string" },
        },
        entry: {
          type: "string",
          description: "Root file path within the bundle to serve for '/'. Default 'index.html'.",
        },
        filename: {
          type: "string",
          description: "Display name for the deployment (optional, defaults to 'claude.html')",
        },
        slug: {
          type: "string",
          description:
            "Existing slug or name to update rather than create a new deployment (optional)",
        },
        name: {
          type: "string",
          description:
            "Stable human-readable name for the deployment, e.g. 'dashboard'. Becomes dashboard.mydev.com. Lowercase letters, digits, hyphens only.",
        },
      },
    },
  },
  {
    name: "list_deployments",
    description: "List all currently deployed HTML files with their URLs and expiry times.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "remove_deployment",
    description: "Remove a deployed HTML file by its slug or name.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Slug or name of the deployment to remove" },
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
      const html = args.html !== undefined ? String(args.html) : undefined;
      const files = args.files as Record<string, string> | undefined;
      const entry = args.entry ? String(args.entry) : "index.html";
      const filename = String(args.filename ?? "claude.html");
      const slugArg = args.slug ? String(args.slug) : undefined;
      const nameArg = args.name ? String(args.name) : undefined;

      const body: Record<string, unknown> = { filename, entry };
      if (html !== undefined) body.html = html;
      else if (files) body.files = files;
      else throw new Error("Provide either 'html' or 'files'");

      if (slugArg) body.slug = slugArg;
      if (nameArg) body.name = nameArg;

      const result = (await callApi<{ slug?: string; error?: string }>(
        config.api_port,
        "POST",
        "/deploy",
        body
      ));
      if (result.error) throw new Error(result.error);

      const resolvedSlug = result.slug ?? slugArg!;
      const url = publicUrl(config, nameArg ?? resolvedSlug);
      const ttlMs = parseTtlMs(config.ttl);
      const expiry = ttlMs > 0 ? ` (expires in ${config.ttl})` : "";
      return `${url}${expiry}`;
    }

    case "list_deployments": {
      const result = await callApi<{
        files: Array<{ slug: string; filename: string; created: number; expires: number; name?: string }>;
      }>(config.api_port, "GET", "/files");
      if (!result.files || result.files.length === 0) return "No deployments found.";
      const now = Date.now();
      return result.files
        .map((f) => {
          const url = publicUrl(config, f.name ?? f.slug);
          const expiry =
            f.expires > 0
              ? f.expires > now
                ? `expires in ${formatDuration(f.expires - now)}`
                : "EXPIRED"
              : "no expiry";
          const nameTag = f.name ? `  name: ${f.name}` : "";
          return `${f.slug}  ${url}  [${f.filename}]${nameTag}  ${expiry}`;
        })
        .join("\n");
    }

    case "remove_deployment": {
      const slug = String(args.slug ?? "");
      const result = await callApi<{ removed: boolean }>(
        config.api_port,
        "DELETE",
        `/files/${slug}`
      );
      return result.removed ? `Removed: ${slug}` : `Not found: ${slug}`;
    }

    case "server_status": {
      const pidFile = pidPath();
      if (!fs.existsSync(pidFile)) return "uptool: stopped";
      const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      try {
        process.kill(pid, 0);
        return `uptool: running (pid ${pid})\nBase URL: ${publicUrl(config, "<slug>")}`;
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
            serverInfo: { name: "uptool", version: "0.2.0" },
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
