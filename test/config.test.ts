import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseTtlMs,
  publicUrl,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  loadOrGenerateToken,
  saveToken,
  tokenPath,
  configPath,
  cloudflaredYmlPath,
  resolvePath,
  type Config,
} from "../src/config/index.js";

describe("parseTtlMs", () => {
  it("parses hours", () => {
    expect(parseTtlMs("72h")).toBe(72 * 60 * 60 * 1000);
    expect(parseTtlMs("1h")).toBe(60 * 60 * 1000);
  });

  it("parses days", () => {
    expect(parseTtlMs("7d")).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("parses minutes", () => {
    expect(parseTtlMs("30m")).toBe(30 * 60 * 1000);
  });

  it("returns 0 for '0'", () => {
    expect(parseTtlMs("0")).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(parseTtlMs("")).toBe(0);
  });

  it("throws on invalid format", () => {
    expect(() => parseTtlMs("1y")).toThrow(/Invalid TTL/);
    expect(() => parseTtlMs("abc")).toThrow(/Invalid TTL/);
  });

  it("throws on whitespace", () => {
    expect(() => parseTtlMs(" 72h")).toThrow(/Invalid TTL/);
    expect(() => parseTtlMs("72h ")).toThrow(/Invalid TTL/);
  });

  it("throws on a bare number with no unit", () => {
    expect(() => parseTtlMs("72")).toThrow(/Invalid TTL/);
  });

  it("throws on an unknown unit", () => {
    expect(() => parseTtlMs("72s")).toThrow(/Invalid TTL/);
    expect(() => parseTtlMs("72w")).toThrow(/Invalid TTL/);
  });

  it("throws on a negative value", () => {
    expect(() => parseTtlMs("-5h")).toThrow(/Invalid TTL/);
  });

  it("handles a huge value", () => {
    expect(parseTtlMs("999999d")).toBe(999999 * 24 * 60 * 60 * 1000);
  });
});

describe("publicUrl", () => {
  const cfg = { ...DEFAULT_CONFIG, base_url: "mydev.com", scheme: "http" };

  it("builds base URL for slug", () => {
    expect(publicUrl(cfg, "abc123de")).toBe("http://abc123de.mydev.com");
  });

  it("appends file path when provided", () => {
    expect(publicUrl(cfg, "abc123de", "/style.css")).toBe("http://abc123de.mydev.com/style.css");
  });

  it("strips leading slash from file path", () => {
    expect(publicUrl(cfg, "abc123de", "/img/logo.png")).toBe(
      "http://abc123de.mydev.com/img/logo.png"
    );
  });

  it("returns bare URL for '/' path", () => {
    expect(publicUrl(cfg, "abc123de", "/")).toBe("http://abc123de.mydev.com");
  });

  it("respects https scheme", () => {
    const secureCfg = { ...cfg, scheme: "https" };
    expect(publicUrl(secureCfg, "abc123de")).toBe("https://abc123de.mydev.com");
  });
});

// ---------------------------------------------------------------------------
// File-system-touching config functions.
//
// loadConfig/saveConfig/tokenPath/etc. all derive paths from os.homedir(),
// which reads process.env.HOME on Linux. We override HOME to a disposable
// temp dir for every test in this block and restore it unconditionally in
// afterEach — a leak here would let these tests clobber the developer's
// real ~/.uptool.
// ---------------------------------------------------------------------------

describe("config file I/O (isolated HOME)", () => {
  const realHome = process.env.HOME;
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "uptool-cfg-test-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    // Assigning undefined would store the literal string "undefined".
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("HOME override actually takes effect", () => {
    // os.homedir() re-reads process.env.HOME on Linux — confirm it, since
    // everything else in this block relies on that being true.
    expect(os.homedir()).toBe(tmpHome);
    expect(configPath()).toBe(path.join(tmpHome, ".uptool", "config.toml"));
  });

  describe("saveConfig / loadConfig round-trip", () => {
    it("round-trips a full config, including cert_file/key_file", () => {
      const cfg: Config = {
        ...DEFAULT_CONFIG,
        base_url: "example.com",
        port: 4000,
        cert_file: "/etc/certs/cert.pem",
        key_file: "/etc/certs/key.pem",
      };
      saveConfig(cfg);
      const loaded = loadConfig();
      expect(loaded.base_url).toBe("example.com");
      expect(loaded.port).toBe(4000);
      expect(loaded.cert_file).toBe("/etc/certs/cert.pem");
      expect(loaded.key_file).toBe("/etc/certs/key.pem");
    });

    it("omits cert_file/key_file from disk and from the reloaded config when undefined", () => {
      const cfg: Config = { ...DEFAULT_CONFIG, base_url: "example.com" };
      expect(cfg.cert_file).toBeUndefined();
      saveConfig(cfg);

      // smol-toml can't serialize `undefined` — saveConfig explicitly filters
      // it out. Assert it's actually absent from the written file, not just
      // present-but-empty.
      const raw = fs.readFileSync(configPath(), "utf8");
      expect(raw).not.toContain("cert_file");
      expect(raw).not.toContain("key_file");

      const loaded = loadConfig();
      expect(loaded.cert_file).toBeUndefined();
      expect(loaded.key_file).toBeUndefined();
    });

    it("merges a partial TOML on disk over DEFAULT_CONFIG", () => {
      const dir = path.join(tmpHome, ".uptool");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "config.toml"), `base_url = "partial.example.com"\nport = 9999\n`);

      const loaded = loadConfig();
      // Specified keys win
      expect(loaded.base_url).toBe("partial.example.com");
      expect(loaded.port).toBe(9999);
      // Unspecified keys fall back to defaults
      expect(loaded.api_port).toBe(DEFAULT_CONFIG.api_port);
      expect(loaded.ttl).toBe(DEFAULT_CONFIG.ttl);
      expect(loaded.max_versions).toBe(DEFAULT_CONFIG.max_versions);
    });

    it("a pre-tunnel config.toml still loads, with tunnelling off by default", () => {
      // Retro-compatibility: a config written before the tunnel keys existed
      // must keep working, and must not silently opt into a tunnel.
      const dir = path.join(tmpHome, ".uptool");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "config.toml"), `base_url = "old.example.com"\nport = 3000\n`);

      const loaded = loadConfig();
      expect(loaded.base_url).toBe("old.example.com");
      expect(loaded.tunnel).toBe("none");
      expect(loaded.tunnel_name).toBe("uptool");
      expect(loaded.tunnel_id).toBe("");
      // 0 = pick a free port at startup; see tunnel-process.ts.
      expect(loaded.tunnel_metrics_port).toBe(0);
      expect(loaded.cloudflared_path).toBe("");
      // Previously the public server listened on every interface (no host arg)
      expect(loaded.bind).toBe("0.0.0.0");
    });

    it("cloudflaredYmlPath sits next to config.toml in the config dir", () => {
      expect(cloudflaredYmlPath()).toBe(path.join(tmpHome, ".uptool", "cloudflared.yml"));
    });

    it("throws with 'uptool init' guidance when config file is missing", () => {
      expect(() => loadConfig()).toThrow(/uptool init/);
    });

    it("malformed TOML — document actual behaviour", () => {
      const dir = path.join(tmpHome, ".uptool");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "config.toml"), `this is not valid toml === [[[`);

      // FINDING: loadConfig does not wrap the smol-toml parse error, so a
      // malformed config.toml surfaces smol-toml's raw parser error (not the
      // friendly "Run: uptool init" guidance a user gets for a missing file).
      // Not fixed here per instructions — src/ is off-limits for this task.
      expect(() => loadConfig()).toThrow();
    });
  });

  describe("token handling", () => {
    it("generates a 64-char hex token when absent", () => {
      const token = loadOrGenerateToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it("reuses an existing token instead of generating a new one", () => {
      const first = loadOrGenerateToken();
      const second = loadOrGenerateToken();
      expect(second).toBe(first);
    });

    it("saveToken writes the token file with mode 0600", () => {
      saveToken("abc123");
      const mode = fs.statSync(tokenPath()).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it("re-chmods an existing token file that was loosened to 0644", () => {
      saveToken("abc123");
      fs.chmodSync(tokenPath(), 0o644);
      expect(fs.statSync(tokenPath()).mode & 0o777).toBe(0o644);

      const token = loadOrGenerateToken();
      expect(token).toBe("abc123");
      expect(fs.statSync(tokenPath()).mode & 0o777).toBe(0o600);
    });

    it("generates a fresh token when the existing token file is empty", () => {
      const dir = path.join(tmpHome, ".uptool");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tokenPath(), "", { mode: 0o600 });

      const token = loadOrGenerateToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});

describe("resolvePath", () => {
  it("expands a leading ~ to the home directory", () => {
    expect(resolvePath("~/foo/bar")).toBe(path.join(os.homedir(), "foo/bar"));
  });

  it("leaves absolute paths unchanged", () => {
    expect(resolvePath("/abs/path")).toBe("/abs/path");
  });

  it("leaves relative paths unchanged", () => {
    expect(resolvePath("rel/path")).toBe("rel/path");
  });
});
