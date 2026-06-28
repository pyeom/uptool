import * as http from "node:http";
import { Config } from "../config/index.js";
import { storeFile, updateFile, removeFile, listFiles, stripMarkdownFences } from "../storage/index.js";

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

export function createApiServer(config: Config): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost`);

    if (req.method === "POST" && url.pathname === "/deploy") {
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as { html: string; filename?: string; slug?: string };
        const html = stripMarkdownFences(parsed.html);
        const filename = parsed.filename ?? "untitled.html";

        if (parsed.slug) {
          updateFile(config.storage_path, parsed.slug, html, filename, config.ttl);
          json(res, 200, { slug: parsed.slug });
        } else {
          const slug = storeFile(config.storage_path, html, filename, config.ttl);
          json(res, 200, { slug });
        }
      } catch (err) {
        json(res, 400, { error: String(err) });
      }
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/files/")) {
      const slug = url.pathname.slice("/files/".length);
      const removed = removeFile(config.storage_path, slug);
      json(res, removed ? 200 : 404, { removed });
      return;
    }

    if (req.method === "GET" && url.pathname === "/files") {
      const files = listFiles(config.storage_path);
      json(res, 200, { files });
      return;
    }

    json(res, 404, { error: "Not found" });
  });
}
