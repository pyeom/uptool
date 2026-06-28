import * as http from "node:http";
import { Config } from "../config/index.js";
import { readFile } from "../storage/index.js";

export function createPublicServer(config: Config): http.Server {
  return http.createServer((req, res) => {
    const host = req.headers.host ?? "";
    const baseUrl = config.base_url.replace(/^https?:\/\//, "");

    const slug = host.replace(new RegExp(`\\.${escapeRegex(baseUrl)}(:\\d+)?$`), "");

    if (!slug || slug === host) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><h1>uptool</h1><p>No slug in host: ${host}</p></body></html>`);
      return;
    }

    const html = readFile(config.storage_path, slug);

    if (!html) {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end(`<html><body><h1>404</h1><p>File not found or expired: ${slug}</p></body></html>`);
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
