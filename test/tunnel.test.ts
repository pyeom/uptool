import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "smol-toml";
import { freePort, runCli, tempHome, writeConfig } from "./helpers.js";

/**
 * test/tunnel.test.ts — `uptool tunnel` contract.
 *
 * Nothing here touches the network or a real cloudflared: every invocation
 * resolves to the fake shell script below, injected at the front of PATH.
 * The fake keeps its tunnel list in a file so idempotency is observable.
 */

const FAKE_UUID = "11111111-2222-3333-4444-555555555555";

const FAKE_CLOUDFLARED = `#!/bin/sh
UUID=${FAKE_UUID}
case "$1" in
  --version|version|-v)
    echo "cloudflared version 2024.1.0 (fake)"; exit 0 ;;
esac
if [ "$1" = "tunnel" ]; then
  case "$2" in
    list)
      if [ -s "$FAKE_CF_STATE" ]; then cat "$FAKE_CF_STATE"; else echo '[]'; fi
      exit 0 ;;
    create)
      printf '[{"id":"%s","name":"%s"}]' "$UUID" "$3" > "$FAKE_CF_STATE"
      echo "Created tunnel $3 with id $UUID"
      exit 0 ;;
    ingress)
      echo "Validating rules from $4"; echo "OK"; exit 0 ;;
    route)
      if [ -n "$FAKE_CF_ROUTE_OK" ]; then echo "Added CNAME"; exit 0; fi
      echo "Failed to add route: code: 1004: DNS Validation Error: wildcard records are not supported here" >&2
      exit 1 ;;
  esac
fi
echo "fake cloudflared: unhandled args: $*" >&2
exit 1
`;

interface Ctx {
  home: string;
  binDir: string;
  state: string;
  cleanup: () => void;
}

let ctx: Ctx;

function setupHome(opts: { base_url?: string; tunnel?: string } = {}): Ctx {
  const { home, cleanup } = tempHome();
  writeConfig(home, { base_url: opts.base_url ?? "example.invalid", port: 3000 });
  if (opts.tunnel) {
    fs.appendFileSync(path.join(home, ".uptool", "config.toml"), `\ntunnel = "${opts.tunnel}"\n`);
  }

  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "cloudflared"), FAKE_CLOUDFLARED, { mode: 0o755 });

  return { home, binDir, state: path.join(home, "cf-state.json"), cleanup };
}

function env(c: Ctx, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: `${c.binDir}:${process.env.PATH}`, FAKE_CF_STATE: c.state, ...extra };
}

function writeCert(home: string): void {
  const dir = path.join(home, ".cloudflared");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cert.pem"), "fake-cert");
}

function readConfig(home: string): Record<string, unknown> {
  return parse(fs.readFileSync(path.join(home, ".uptool", "config.toml"), "utf8")) as Record<
    string,
    unknown
  >;
}

function ymlPath(home: string): string {
  return path.join(home, ".uptool", "cloudflared.yml");
}

describe("tunnel.test.ts", () => {
  beforeEach(() => {
    ctx = setupHome();
  });
  afterEach(() => {
    ctx?.cleanup();
  });

  describe("setup", () => {
    it("refuses to run without a Cloudflare certificate", async () => {
      const res = await runCli(["tunnel", "setup"], { home: ctx.home, env: env(ctx) });
      expect(res.code).toBe(1);
      expect(res.stderr).toMatch(/uptool tunnel login/);
      expect(fs.existsSync(ymlPath(ctx.home))).toBe(false);
    });

    it("is idempotent — a second run reuses the same tunnel", async () => {
      writeCert(ctx.home);

      const first = await runCli(["tunnel", "setup"], { home: ctx.home, env: env(ctx) });
      expect(first.code).toBe(0);
      expect(first.stdout).toMatch(/Created tunnel/);

      const second = await runCli(["tunnel", "setup"], { home: ctx.home, env: env(ctx) });
      expect(second.code).toBe(0);
      expect(second.stdout).toMatch(/Reusing existing tunnel/);

      expect(JSON.parse(fs.readFileSync(ctx.state, "utf8"))).toHaveLength(1);
      expect(readConfig(ctx.home).tunnel_id).toBe(FAKE_UUID);
      expect(fs.readFileSync(ymlPath(ctx.home), "utf8")).toContain(`tunnel: ${FAKE_UUID}`);
    });

    it("writes a wildcard ingress rule pointing at the local port", async () => {
      writeCert(ctx.home);
      const res = await runCli(["tunnel", "setup"], { home: ctx.home, env: env(ctx) });
      expect(res.code).toBe(0);

      const yml = fs.readFileSync(ymlPath(ctx.home), "utf8");
      expect(yml).toContain(`hostname: "*.example.invalid"`);
      expect(yml).toContain("service: http://127.0.0.1:3000");
      expect(yml).toContain("service: http_status:404");
      expect(yml).toContain(path.join(ctx.home, ".cloudflared", `${FAKE_UUID}.json`));
    });

    it("prints manual DNS instructions when route dns fails, without failing", async () => {
      writeCert(ctx.home);
      const res = await runCli(["tunnel", "setup"], { home: ctx.home, env: env(ctx) });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/Type:\s+CNAME/);
      expect(res.stdout).toMatch(/Name:\s+\*/);
      expect(res.stdout).toContain(`${FAKE_UUID}.cfargotunnel.com`);
      expect(res.stdout).toMatch(/Proxied/);
    });

    it("switches the config into tunnel mode", async () => {
      writeCert(ctx.home);
      await runCli(["tunnel", "setup"], { home: ctx.home, env: env(ctx) });
      const cfg = readConfig(ctx.home);
      expect(cfg.tunnel).toBe("cloudflare");
      expect(cfg.scheme).toBe("https");
      expect(cfg.trust_proxy).toBe(true);
      expect(cfg.bind).toBe("127.0.0.1");
    });

    it("warns that a non-apex base_url breaks Universal SSL", async () => {
      const sub = setupHome({ base_url: "apps.mydev.invalid" });
      try {
        writeCert(sub.home);
        const res = await runCli(["tunnel", "setup"], { home: sub.home, env: env(sub) });
        expect(res.code).toBe(0);
        expect(res.stdout).toMatch(/not an apex domain/);
      } finally {
        sub.cleanup();
      }
    });

    it("does not warn for an apex base_url", async () => {
      writeCert(ctx.home);
      const res = await runCli(["tunnel", "setup"], { home: ctx.home, env: env(ctx) });
      expect(res.stdout).not.toMatch(/not an apex domain/);
    });
  });

  describe("status", () => {
    it("reports local mode and exits 0 when the tunnel is off", async () => {
      const res = await runCli(["tunnel", "status"], { home: ctx.home, env: env(ctx) });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/local mode/);
    });

    it("flags a config that claims tunnel mode but is not wired for it", async () => {
      // Pin the metrics port to one nothing is listening on. The default 20241
      // is cloudflared's own, so on a machine already running a tunnel the
      // health probe would find that real one and report "connected".
      const deadPort = await freePort();
      fs.appendFileSync(
        path.join(ctx.home, ".uptool", "config.toml"),
        `\ntunnel = "cloudflare"\ntunnel_id = "${FAKE_UUID}"\ntunnel_metrics_port = ${deadPort}\n`
      );
      const res = await runCli(["tunnel", "status"], { home: ctx.home, env: env(ctx) });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/Inconsistent config/);
      expect(res.stdout).toMatch(/scheme/);
      expect(res.stdout).toMatch(/trust_proxy/);
      expect(res.stdout).toMatch(/bind/);
      expect(res.stdout).toMatch(/not running/);
    });
  });

  describe("off", () => {
    it("reverts every tunnel-mode key and keeps the files on disk", async () => {
      writeCert(ctx.home);
      await runCli(["tunnel", "setup"], { home: ctx.home, env: env(ctx) });

      const res = await runCli(["tunnel", "off"], { home: ctx.home, env: env(ctx) });
      expect(res.code).toBe(0);

      const cfg = readConfig(ctx.home);
      expect(cfg.tunnel).toBe("none");
      expect(cfg.scheme).toBe("http");
      expect(cfg.trust_proxy).toBe(false);
      expect(cfg.bind).toBe("0.0.0.0");
      // The tunnel itself is untouched — id kept so `setup` can pick it back up
      expect(cfg.tunnel_id).toBe(FAKE_UUID);
      expect(fs.existsSync(ymlPath(ctx.home))).toBe(true);
      expect(fs.existsSync(path.join(ctx.home, ".cloudflared", "cert.pem"))).toBe(true);
    });
  });

  describe("login", () => {
    it("is a no-op when a certificate already exists", async () => {
      writeCert(ctx.home);
      const res = await runCli(["tunnel", "login"], { home: ctx.home, env: env(ctx) });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/Already logged in/);
    });
  });
});
