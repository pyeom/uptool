/**
 * Shared HTTP client for CLI commands that talk to the daemon's internal API.
 * Extracted from deploy.ts / mcp.ts to avoid duplication.
 */
import * as http from "node:http";

export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export function callApi<T = unknown>(
  port: number,
  method: string,
  urlPath: string,
  body?: object
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path: urlPath,
      method,
      headers: payload
        ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          }
        : {},
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch {
          reject(new ApiError(`Invalid API response: ${data}`));
        }
      });
    });

    req.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
        reject(new ApiError("uptool server not running — run: uptool serve"));
      } else {
        reject(err);
      }
    });

    if (payload) req.write(payload);
    req.end();
  });
}
