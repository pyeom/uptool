import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as dns from "node:dns";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  loadConfig,
  saveConfig,
  cloudflaredYmlPath,
  configPath,
  Config,
} from "../config/index.js";
import { ensureBinary, findBinary, run, version } from "../lib/cloudflared.js";
import { readTunnelState, tunnelHealthy } from "../lib/tunnel-process.js";

/** Where `cloudflared tunnel login` drops the account certificate. */
function certPath(): string {
  return path.join(os.homedir(), ".cloudflared", "cert.pem");
}

/** Config is optional for `login` — the user may not have run `uptool init` yet. */
function tryLoadConfig(): Config | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

export async function tunnelLoginCommand(opts: { force?: boolean } = {}): Promise<void> {
  const cert = certPath();
  if (fs.existsSync(cert) && !opts.force) {
    console.log(`✓ Already logged in — ${cert} exists.`);
    console.log(`  Re-run with --force to authorize a different account/zone.`);
    return;
  }

  const bin = await ensureBinary(tryLoadConfig()?.cloudflared_path);
  console.log("Opening your browser to authorize cloudflared…");
  console.log("Pick the zone (domain) you want to serve from.\n");

  // stdio: inherit — this flow prints a URL, waits, and is meant to be watched.
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(bin, ["tunnel", "login"], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", resolve);
  });

  if (code !== 0) {
    console.error(`\ncloudflared tunnel login failed (exit ${code}).`);
    process.exit(1);
  }
  console.log(`\n✓ Certificate written to ${cert}`);
  console.log(`Next: uptool tunnel setup`);
}

export async function tunnelSetupCommand(): Promise<void> {
  const config = loadConfig();

  if (!fs.existsSync(certPath())) {
    console.error(`No Cloudflare certificate at ${certPath()}.`);
    console.error(`Run: uptool tunnel login`);
    process.exit(1);
  }

  if (!config.base_url) {
    console.error("base_url is not set. Run: uptool url");
    process.exit(1);
  }

  warnIfNotApex(config.base_url);

  const bin = await ensureBinary(config.cloudflared_path);
  const uuid = await findOrCreateTunnel(bin, config.tunnel_name);

  const ymlPath = cloudflaredYmlPath();
  fs.mkdirSync(path.dirname(ymlPath), { recursive: true });
  fs.writeFileSync(ymlPath, renderYml(uuid, config.base_url, config.port));
  console.log(`✓ Wrote ${ymlPath}`);

  const validate = await run(["tunnel", "ingress", "validate", "--config", ymlPath], { bin });
  if (validate.code !== 0) {
    console.error(`Invalid tunnel config (${ymlPath}):`);
    console.error(validate.stderr.trim() || validate.stdout.trim());
    process.exit(1);
  }

  const hostname = `*.${config.base_url}`;
  const route = await run(["tunnel", "route", "dns", config.tunnel_name, hostname], { bin });
  if (route.code === 0) {
    console.log(`✓ DNS route created for ${hostname}`);
  } else {
    // Expected path: the Cloudflare API rejects wildcard records created this
    // way (coolify#2926, dokploy#2703). Not fatal — the record works fine when
    // added by hand.
    console.log(`\n! cloudflared could not create the wildcard DNS record:`);
    console.log(`  ${(route.stderr.trim() || route.stdout.trim()).split("\n").pop()}`);
    console.log(`\n  This is expected. Add it yourself in the Cloudflare dashboard`);
    console.log(`  (${config.base_url} → DNS → Records → Add record):`);
    console.log(`\n    Type:   CNAME`);
    console.log(`    Name:   *`);
    console.log(`    Target: ${uuid}.cfargotunnel.com`);
    console.log(`    Proxy:  Proxied (orange cloud)`);
    console.log(`\n  Proxied wildcard records are available on every plan, Free included.`);
  }

  await checkDns(config.base_url);

  const next: Config = {
    ...config,
    tunnel: "cloudflare",
    tunnel_id: uuid,
    scheme: "https",
    trust_proxy: true,
    bind: "127.0.0.1",
  };
  reportChanges(config, next);
  saveConfig(next);

  console.log(`\nNext: uptool serve`);
}

export async function tunnelStatusCommand(): Promise<void> {
  const config = loadConfig();

  if (config.tunnel !== "cloudflare") {
    console.log("tunnel: off (local mode)");
    console.log(`Serving directly on ${config.bind}:${config.port} over ${config.scheme}.`);
    console.log(`Enable with: uptool tunnel setup`);
    return;
  }

  const bin = findBinary(config.cloudflared_path);
  if (bin) {
    let v = "unknown";
    try {
      v = await version(bin);
    } catch {
      // binary present but unrunnable — the path is still worth reporting
    }
    console.log(`binary:    ${bin} (${v.trim()})`);
  } else {
    console.log(`binary:    not found`);
  }

  const cert = certPath();
  console.log(`cert.pem:  ${fs.existsSync(cert) ? cert : "missing — run: uptool tunnel login"}`);
  const yml = cloudflaredYmlPath();
  console.log(`config:    ${fs.existsSync(yml) ? yml : "missing — run: uptool tunnel setup"}`);
  console.log(`tunnel_id: ${config.tunnel_id || "(unset)"}`);

  const state = readTunnelState();
  const ready = await tunnelHealthy();
  console.log(
    ready
      ? `health:    connected (pid ${state!.pid}, metrics on :${state!.metrics_port})`
      : state
        ? `health:    not connected (cloudflared pid ${state.pid} is gone or has no live connections)`
        : `health:    not running — the daemon has no cloudflared of its own`
  );

  const problems: string[] = [];
  if (config.scheme !== "https") problems.push(`scheme is "${config.scheme}", should be "https"`);
  if (!config.trust_proxy) problems.push(`trust_proxy is false, should be true`);
  if (config.bind !== "127.0.0.1") problems.push(`bind is "${config.bind}", should be "127.0.0.1"`);
  if (problems.length > 0) {
    console.log(`\n! Inconsistent config for tunnel mode:`);
    for (const p of problems) console.log(`  - ${p}`);
    console.log(`  Fix with: uptool tunnel setup`);
  }
}

export function tunnelOffCommand(): void {
  const config = loadConfig();
  const next: Config = {
    ...config,
    tunnel: "none",
    scheme: "http",
    trust_proxy: false,
    bind: "0.0.0.0",
  };
  reportChanges(config, next);
  saveConfig(next);

  console.log(`\nLeft in place (nothing was deleted on Cloudflare):`);
  console.log(`  tunnel ${config.tunnel_name} (${config.tunnel_id || "no id"})`);
  console.log(`  ${cloudflaredYmlPath()}`);
  console.log(`  ${certPath()}`);
  console.log(`Re-enable with: uptool tunnel setup`);
}

// ---------------------------------------------------------------------------

/**
 * Cloudflare's Universal SSL certificate covers `*.example.com` but not
 * `*.sub.example.com` — one wildcard level only.
 */
function warnIfNotApex(baseUrl: string): void {
  if (baseUrl.split(".").length <= 2) return;
  console.log(`\n!! ${baseUrl} is not an apex domain.`);
  console.log(`   Cloudflare's free Universal SSL covers one wildcard level, so`);
  console.log(`   <slug>.${baseUrl} will NOT get a valid certificate — browsers`);
  console.log(`   will show a TLS error.`);
  console.log(`   Options: use the apex domain (uptool url), buy Advanced`);
  console.log(`   Certificate Manager, or ignore this if you supply your own cert.\n`);
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Reuse a same-named tunnel if one exists, so `setup` can be re-run safely. */
async function findOrCreateTunnel(bin: string, name: string): Promise<string> {
  const list = await run(["tunnel", "list", "--output", "json"], { bin });
  if (list.code !== 0) {
    console.error(`Could not list tunnels:`);
    console.error(list.stderr.trim() || list.stdout.trim());
    process.exit(1);
  }
  let tunnels: { id?: string; name?: string }[] = [];
  try {
    tunnels = JSON.parse(list.stdout || "[]") ?? [];
  } catch {
    console.error(`Unexpected output from cloudflared tunnel list:\n${list.stdout}`);
    process.exit(1);
  }
  const existing = tunnels.find((t) => t.name === name && t.id);
  if (existing) {
    console.log(`✓ Reusing existing tunnel "${name}" (${existing.id})`);
    return existing.id!;
  }

  const created = await run(["tunnel", "create", name], { bin });
  if (created.code !== 0) {
    console.error(`Could not create tunnel "${name}":`);
    console.error(created.stderr.trim() || created.stdout.trim());
    process.exit(1);
  }
  const uuid = `${created.stdout}\n${created.stderr}`.match(UUID_RE)?.[0];
  if (!uuid) {
    console.error(`Created tunnel "${name}" but found no UUID in the output:`);
    console.error(created.stdout.trim() || created.stderr.trim());
    process.exit(1);
  }
  console.log(`✓ Created tunnel "${name}" (${uuid})`);
  return uuid;
}

function renderYml(uuid: string, baseUrl: string, port: number): string {
  const credentials = path.join(os.homedir(), ".cloudflared", `${uuid}.json`);
  return [
    `tunnel: ${uuid}`,
    `credentials-file: ${credentials}`,
    `ingress:`,
    `  - hostname: ${JSON.stringify(`*.${baseUrl}`)}`,
    `    service: http://127.0.0.1:${port}`,
    `  - service: http_status:404`,
    ``,
  ].join("\n");
}

/** Cheap proof the wildcard record exists: resolve a name nothing else could serve. */
async function checkDns(baseUrl: string): Promise<void> {
  const probe = `uptool-${crypto.randomBytes(4).toString("hex")}.${baseUrl}`;
  try {
    await Promise.race([
      dns.promises.resolve4(probe),
      // unref'd: on the happy path this timer is still pending when the race
      // settles, and a referenced one would hold the CLI open for 5s after
      // setup has already finished.
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 5000).unref()
      ),
    ]);
    console.log(`✓ Wildcard DNS resolves (${probe})`);
  } catch {
    console.log(`\n! ${probe} does not resolve yet.`);
    console.log(`  The wildcard record is missing or still propagating —`);
    console.log(`  deployments won't be reachable until it does.`);
  }
}

function reportChanges(before: Config, after: Config): void {
  const changed = (Object.keys(after) as (keyof Config)[]).filter(
    (k) => before[k] !== after[k]
  );
  if (changed.length === 0) {
    console.log(`\nConfig already up to date.`);
    return;
  }
  console.log(`\nUpdating ${configPath()}:`);
  for (const k of changed) {
    console.log(`  ${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(after[k])}`);
  }
}
