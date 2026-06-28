import * as fs from "node:fs";
import * as http from "node:http";
import { loadConfig, parseTtlMs } from "../config/index.js";

function postToApi(apiPort: number, body: object): Promise<{ slug: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: apiPort,
        path: "/deploy",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) reject(new Error(parsed.error));
            else resolve(parsed);
          } catch {
            reject(new Error(`Invalid response: ${data}`));
          }
        });
      }
    );
    req.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
        reject(new Error("Server not running. Run: uptool serve"));
      } else {
        reject(err);
      }
    });
    req.write(payload);
    req.end();
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

export async function deployCommand(
  filePath: string | undefined,
  opts: { update?: string }
): Promise<void> {
  const config = loadConfig();
  let html: string;
  let filename: string;

  if (filePath) {
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
    html = fs.readFileSync(filePath, "utf8");
    filename = filePath.split("/").pop() ?? filePath;
  } else {
    html = await readStdin();
    filename = "stdin.html";
  }

  if (!html.trim()) {
    console.error("No content provided.");
    process.exit(1);
  }

  try {
    const body: Record<string, string> = { html, filename };
    if (opts.update) body.slug = opts.update;

    const result = await postToApi(config.api_port, body);
    const url = `http://${result.slug}.${config.base_url}`;
    const ttlMs = parseTtlMs(config.ttl);
    const expiry = ttlMs > 0 ? `  (expires in ${config.ttl})` : "";
    console.log(`✓ ${url}${expiry}`);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
