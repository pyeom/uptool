import * as crypto from "node:crypto";
import qrcode from "qrcode-terminal";
import { loadConfig, publicUrl } from "../config/index.js";
import { callApi } from "../lib/api-client.js";
import { ensureBinary } from "../lib/cloudflared.js";
import { startQuickTunnel } from "../lib/quick-tunnel.js";
import { buildBody } from "./deploy.js";

/**
 * Deploy a file and expose it on a throwaway public URL.
 *
 * This is the path for people with no domain: no Cloudflare account, no DNS
 * record, no port forwarding. The URL lives as long as the command runs.
 */
export async function shareCommand(
  filePath: string | undefined,
  opts: { protect?: string | boolean; qr?: boolean }
): Promise<void> {
  const config = loadConfig();

  if (!config.base_url) {
    console.error("base_url is not set. Run: uptool init");
    process.exit(1);
  }

  const key =
    opts.protect === true
      ? crypto.randomBytes(12).toString("base64url")
      : opts.protect || undefined;

  const body = await buildBody(filePath);
  if (key) body.key = key;

  const result = await callApi<{ slug?: string; error?: string }>(
    config.api_port,
    "POST",
    "/deploy",
    body
  );
  if (result.error) throw new Error(result.error);
  const slug = result.slug as string;

  const bin = await ensureBinary(config.cloudflared_path);
  console.log("Opening a public tunnel…");

  // The Host cloudflared should present to the local server: whatever the
  // public server already routes this deployment by.
  const hostHeader = `${slug}.${config.base_url}`;

  const tunnel = await startQuickTunnel(bin, config.port, hostHeader, (reason) => {
    console.error(`\n! tunnel closed unexpectedly (${reason}) — the link is dead.`);
    console.error(`  Re-run uptool share to get a new one.`);
  });

  console.log(`\n✓ ${tunnel.url}`);
  if (key) console.log(`  key: ${key}  (Basic Auth password — any username)`);
  if (opts.qr) qrcode.generate(tunnel.url, { small: true });
  console.log(`\nAnyone with this link can view it. Ctrl-C ends the tunnel.`);
  console.log(`The deployment itself stays local: ${publicUrl(config, slug)} (uptool rm ${slug})`);

  await waitForInterrupt();

  console.log("\nClosing tunnel…");
  await tunnel.close();
  console.log(`✓ Link is dead. Content still deployed as ${slug}.`);
}

/** Block until Ctrl-C (or SIGTERM), so the tunnel stays up while the user shares. */
function waitForInterrupt(): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
}
