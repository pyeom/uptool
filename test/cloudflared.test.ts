import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { install } from "cloudflared";
import { findBinary, ensureBinary, version, run } from "../src/lib/cloudflared.js";

/**
 * These tests never touch the network and never assume a real cloudflared is
 * installed: the npm package is mocked so its `bin` points at a path that
 * cannot exist, and every binary under test is a shell script we write into a
 * temp dir that we inject into PATH.
 */
vi.mock("cloudflared", () => ({
  bin: "/nonexistent-uptool-test/cloudflared",
  install: vi.fn(async () => {
    throw new Error("install() must not reach the network in tests");
  }),
}));

// Safety net, same idea as test/helpers.ts: a test that throws before its
// cleanup would otherwise leak a temp dir per case.
const liveDirs = new Set<string>();
process.on("exit", () => {
  for (const dir of liveDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort — the exit handler must not throw
    }
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uptool-test-cfd-"));
  liveDirs.add(dir);
  return dir;
}

/** Writes an executable shell script and returns its path. */
function fakeBin(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  fs.chmodSync(p, 0o755);
  return p;
}

const VERSION_LINE = "cloudflared version 2026.7.3 (built 2026-07-23-09:58 UTC)";

let dirs: string[];
const realPath = process.env.PATH;

beforeEach(() => {
  dirs = [];
  // vi.restoreAllMocks() only restores spies, so the module mock keeps whatever
  // a previous test taught it — clear it explicitly.
  vi.mocked(install).mockClear();
});

afterEach(() => {
  process.env.PATH = realPath;
  for (const dir of dirs) {
    liveDirs.delete(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function scratch(): string {
  const dir = tempDir();
  dirs.push(dir);
  return dir;
}

describe("findBinary", () => {
  it("prefers an explicit path over one on PATH", () => {
    const onPath = scratch();
    fakeBin(onPath, "cloudflared", `echo "${VERSION_LINE}"`);
    process.env.PATH = onPath;

    const other = scratch();
    const explicit = fakeBin(other, "my-cloudflared", `echo "${VERSION_LINE}"`);

    expect(findBinary(explicit)).toBe(explicit);
  });

  it("falls back to PATH when the explicit path is empty or unusable", () => {
    const dir = scratch();
    const onPath = fakeBin(dir, "cloudflared", `echo "${VERSION_LINE}"`);
    process.env.PATH = dir;

    expect(findBinary()).toBe(onPath);
    expect(findBinary("")).toBe(onPath);
    expect(findBinary("   ")).toBe(onPath);
    expect(findBinary(path.join(dir, "does-not-exist"))).toBe(onPath);
  });

  it("ignores a non-executable file on PATH", () => {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, "cloudflared"), "not executable", { mode: 0o644 });
    process.env.PATH = dir;

    expect(findBinary()).toBeNull();
  });

  it("returns null when nothing is installed anywhere", () => {
    process.env.PATH = scratch();
    expect(findBinary()).toBeNull();
  });
});

describe("ensureBinary", () => {
  it("returns the existing binary without installing anything", async () => {
    const dir = scratch();
    const bin = fakeBin(dir, "cloudflared", `echo "${VERSION_LINE}"`);
    process.env.PATH = dir;

    await expect(ensureBinary()).resolves.toBe(bin);
    expect(install).not.toHaveBeenCalled();
  });

  it("announces the download before installing, and returns the installed path", async () => {
    process.env.PATH = scratch();
    const dest = scratch();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(install).mockImplementation(async () =>
      fakeBin(dest, "cloudflared", `echo "${VERSION_LINE}"`)
    );

    const bin = await ensureBinary();

    expect(bin).toBe(path.join(dest, "cloudflared"));
    // The warning has to come before the download starts, not after.
    expect(log.mock.calls[0][0]).toMatch(/downloading/i);
  });

  it("throws if the installed file is not executable", async () => {
    process.env.PATH = scratch();
    const dest = scratch();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(install).mockImplementation(async () => {
      const p = path.join(dest, "cloudflared");
      fs.writeFileSync(p, "junk", { mode: 0o644 });
      return p;
    });

    await expect(ensureBinary()).rejects.toThrow(/not executable/);
  });
});

describe("run", () => {
  it("captures stdout, stderr and the exit code", async () => {
    const dir = scratch();
    const bin = fakeBin(dir, "cloudflared", 'echo "out:$1"\necho "err" >&2\nexit 3');

    const res = await run(["hello"], { bin });
    expect(res.stdout.trim()).toBe("out:hello");
    expect(res.stderr.trim()).toBe("err");
    expect(res.code).toBe(3);
  });

  it("passes env through to the child", async () => {
    const dir = scratch();
    const bin = fakeBin(dir, "cloudflared", 'echo "$UPTOOL_TEST_VAR"');

    const res = await run([], { bin, env: { UPTOOL_TEST_VAR: "injected" } });
    expect(res.stdout.trim()).toBe("injected");
  });

  it("resolves the binary from PATH when no bin is given", async () => {
    const dir = scratch();
    fakeBin(dir, "cloudflared", 'echo "from-path"');
    process.env.PATH = dir;

    const res = await run([]);
    expect(res.stdout.trim()).toBe("from-path");
  });

  it("rejects when no binary can be found", async () => {
    process.env.PATH = scratch();
    await expect(run([])).rejects.toThrow(/not found/);
  });

  it("kills the child and rejects when it outlives the timeout", async () => {
    const dir = scratch();
    // Deliberately does NOT touch process.env.PATH: the child inherits it, and
    // a PATH stripped down to a temp dir would make `sleep` itself unfindable
    // (the script would exit 127 instead of hanging).
    const bin = fakeBin(dir, "cloudflared", "sleep 30");

    await expect(run([], { bin, timeoutMs: 100 })).rejects.toThrow(/timed out after 100ms/);
  });

  it("reports a missing binary clearly", async () => {
    const bin = path.join(scratch(), "gone");
    await expect(run([], { bin })).rejects.toThrow(/not found at/);
  });

  it("reports a non-executable binary clearly", async () => {
    const dir = scratch();
    const bin = path.join(dir, "cloudflared");
    fs.writeFileSync(bin, "#!/bin/sh\ntrue\n", { mode: 0o644 });

    await expect(run([], { bin })).rejects.toThrow(/not executable/);
  });
});

describe("version", () => {
  it("extracts just the version number", async () => {
    const dir = scratch();
    const bin = fakeBin(dir, "cloudflared", `echo "${VERSION_LINE}"`);

    await expect(version(bin)).resolves.toBe("2026.7.3");
  });

  it("reads the version off stderr too", async () => {
    const dir = scratch();
    const bin = fakeBin(dir, "cloudflared", `echo "${VERSION_LINE}" >&2`);

    await expect(version(bin)).resolves.toBe("2026.7.3");
  });

  it("falls back to the raw first line when the output is unexpected", async () => {
    const dir = scratch();
    const bin = fakeBin(dir, "cloudflared", 'echo "surprise output"\necho "second line"');

    await expect(version(bin)).resolves.toBe("surprise output");
  });

  it("uses the binary found on PATH when none is given", async () => {
    const dir = scratch();
    fakeBin(dir, "cloudflared", `echo "${VERSION_LINE}"`);
    process.env.PATH = dir;

    await expect(version()).resolves.toBe("2026.7.3");
  });
});
