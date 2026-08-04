import * as crypto from "node:crypto";
import * as http from "node:http";

/**
 * Check Basic Auth against a deployment's access key.
 * Any username is accepted; the password must equal the key (constant-time).
 */
export function basicAuthOk(req: http.IncomingMessage, key: string): boolean {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) return false;
  const password = Buffer.from(decoded.slice(sep + 1));
  const expected = Buffer.from(key);
  if (password.length !== expected.length) return false;
  return crypto.timingSafeEqual(password, expected);
}
