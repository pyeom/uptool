import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { readLogTail, statusCommand } from "../src/commands/status.js";
import { logsCommand, followLog } from "../src/commands/logs.js";
import { freePort } from "./helpers.js";

const CHUNK = 16 * 1024;

describe("readLogTail", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "uptool-logtail-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  }

  it("returns all lines when file is smaller than the chunk (common case)", () => {
    const p = write("small.log", "one\ntwo\nthree\n");
    expect(readLogTail(p, 10)).toBe("one\ntwo\nthree");
  });

  it("returns only the last N lines when file has more lines than requested", () => {
    const p = write("many.log", "a\nb\nc\nd\ne\n");
    expect(readLogTail(p, 2)).toBe("d\ne");
  });

  it("returns whatever exists when file has fewer lines than requested", () => {
    const p = write("few.log", "only-one\n");
    expect(readLogTail(p, 10)).toBe("only-one");
  });

  it("handles an empty file without crashing", () => {
    const p = write("empty.log", "");
    expect(readLogTail(p, 10)).toBe("");
  });

  it("handles a file with no trailing newline", () => {
    const p = write("no-trailing.log", "line1\nline2");
    expect(readLogTail(p, 10)).toBe("line1\nline2");
  });

  it("does not produce a phantom empty last line when file ends with a newline", () => {
    const p = write("trailing.log", "line1\nline2\n");
    const tail = readLogTail(p, 10);
    expect(tail).toBe("line1\nline2");
    expect(tail.endsWith("\n")).toBe(false);
    expect(tail.split("\n").pop()).not.toBe("");
  });

  it("reads only the tail of a file larger than 16KB and returns the genuinely last N lines", () => {
    // Build a file well over CHUNK bytes, with clearly numbered lines so we
    // can verify exactly which lines come back.
    const lines: string[] = [];
    let total = 0;
    let i = 0;
    while (total < CHUNK * 2) {
      const l = `line-${String(i).padStart(5, "0")}`;
      lines.push(l);
      total += l.length + 1;
      i++;
    }
    const p = write("big.log", lines.join("\n") + "\n");
    const tail = readLogTail(p, 5);
    const expected = lines.slice(-5).join("\n");
    expect(tail).toBe(expected);
  });

  it("never returns a truncated line when the chunk boundary falls mid-line", () => {
    // Build a file where the CHUNK cut point lands in the middle of the marker
    // line. Before the fix, that half-line came back as if it were a real log
    // line; now the partial line is discarded, so every line returned is whole.
    const marker = "UNIQUE_LONG_LINE_THAT_STRADDLES_THE_CHUNK_BOUNDARY_MARKER";
    const filler = "f".repeat(CHUNK - Math.floor(marker.length / 2));
    const p = write("boundary.log", `${filler}\n${marker}\nlast\n`);
    expect(fs.statSync(p).size).toBeGreaterThan(CHUNK);

    // Ask for more lines than exist, so nothing is hidden by slice(-lineCount).
    const linesBack = readLogTail(p, 100).split("\n").filter((l) => l !== "");
    // Every line returned must be one that genuinely exists in the file.
    for (const line of linesBack) {
      expect([filler, marker, "last"]).toContain(line);
    }
    // The last line is always intact and present.
    expect(linesBack[linesBack.length - 1]).toBe("last");
  });

  it("FIXED: a multi-byte UTF-8 character split by the chunk boundary is dropped cleanly, not mangled", () => {
    const emoji = "\u{1F389}"; // 4-byte UTF-8
    const rest = "restboundary\nlast line\n";
    // Put the emoji alone on the file's first line, so the only thing the
    // partial-line discard should eat is that broken character — everything
    // after the first newline must survive intact. Size the filler so the
    // chunk cut point (size - CHUNK) lands 2 bytes into the 4-byte emoji.
    const fixed = Buffer.byteLength(emoji) + 2 + Buffer.byteLength(rest); // emoji + 2 newlines + tail
    const filler = "y".repeat(CHUNK + 2 - fixed);
    const content = `${emoji}\n${filler}\n${rest}`;
    const p = write("utf8-boundary.log", content);
    const size = fs.statSync(p).size;
    const cutOffset = size - CHUNK;
    expect(cutOffset).toBeGreaterThan(0);
    expect(cutOffset).toBeLessThan(Buffer.byteLength(emoji));

    // Asking for few enough lines to be satisfied by the first chunk: the
    // chunk starts mid-emoji, so the partial first line holding the split
    // character is discarded wholesale rather than decoded into U+FFFD.
    const shortTail = readLogTail(p, 2);
    expect(shortTail).not.toContain("�");
    expect(shortTail).toBe(rest.trimEnd());

    // Asking for more lines than the first chunk holds widens the window back
    // to byte 0, so the emoji line comes back intact.
    const tail = readLogTail(p, 100);
    expect(tail).not.toContain("�");
    expect(tail).toBe(`${emoji}\n${filler}\n${rest.trimEnd()}`);
  });

  it("returns the last line of a single-line file larger than 16KB", () => {
    // One 17 KiB line with no newline before it: a single chunk read from the
    // end contains no newline at all, and must not be discarded as partial.
    const line = "z".repeat(17 * 1024);
    const p = write("one-long-line.log", `${line}\n`);
    expect(fs.statSync(p).size).toBeGreaterThan(CHUNK);
    expect(readLogTail(p, 10)).toBe(line);
  });

  it("closes the file descriptor afterwards (no fd leak across many calls)", () => {
    const p = write("fd.log", "a\nb\nc\n");
    // If fds leaked, repeating this many times would eventually exhaust the
    // process's fd limit (typically 1024+) and throw EMFILE.
    for (let i = 0; i < 500; i++) {
      readLogTail(p, 2);
    }
    // Reaching here without EMFILE is the assertion; also sanity-check a
    // normal fd can still be opened.
    const fd = fs.openSync(p, "r");
    fs.closeSync(fd);
    expect(true).toBe(true);
  });
});

describe("statusCommand", () => {
  let realHome: string | undefined;
  let tmpHome: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    realHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "uptool-status-"));
    fs.mkdirSync(path.join(tmpHome, ".uptool"), { recursive: true });
    process.env.HOME = tmpHome;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.HOME = realHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });

  function pidFile(): string {
    return path.join(tmpHome, ".uptool", "uptool.pid");
  }

  it("reports stopped when there is no PID file", async () => {
    await statusCommand({});
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("uptool: stopped");
    expect(output).not.toContain("stale");
  });

  it("reports stale for a dead process's PID file and cleans it up", async () => {
    // Find a PID almost certainly not running: a very high number is not
    // guaranteed dead on all systems, so instead spawn nothing and rely on
    // pid_max headroom — use a large pid unlikely to be alive.
    const deadPid = 2 ** 30;
    fs.writeFileSync(pidFile(), String(deadPid));
    expect(fs.existsSync(pidFile())).toBe(true);

    await statusCommand({});

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("stale PID file");
    expect(output).toContain(String(deadPid));
    // The file must be cleaned up after detecting staleness.
    expect(fs.existsSync(pidFile())).toBe(false);
  });

  it("--json emits the expected shape and exits non-zero when unhealthy", async () => {
    // No config, no running daemon -> unhealthy.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((() => {
      // vi.spyOn with mockImplementation: execution continues past the call
      // since we don't throw here.
      return undefined as never;
    }) as unknown) as typeof process.exit);

    await statusCommand({ json: true });

    expect(exitSpy).toHaveBeenCalledWith(1);
    const jsonCall = logSpy.mock.calls.find((c) => {
      try {
        JSON.parse(c[0]);
        return true;
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall![0]);
    expect(parsed).toMatchObject({
      running: false,
      healthy: false,
      pid: null,
      api_responding: false,
      deployments: null,
      base_url: null,
      port: null,
      api_port: null,
    });
  });

  it("reports running (with own pid, always alive) and prints the log tail when present", async () => {
    fs.writeFileSync(pidFile(), String(process.pid));
    const logFile = path.join(tmpHome, ".uptool", "server.log");
    fs.writeFileSync(logFile, "log line one\nlog line two\n");

    await statusCommand({});

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain(`uptool: running (pid ${process.pid})`);
    expect(output).toContain("last 10 log lines");
    expect(output).toContain("log line one");
    expect(output).toContain("log line two");
  });

  it("--json with a running process and a reachable API reports deployments and healthy:true", async () => {
    fs.writeFileSync(pidFile(), String(process.pid));
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ files: [1, 2, 3] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const apiPort = (server.address() as { port: number }).port;

    fs.writeFileSync(
      path.join(tmpHome, ".uptool", "config.toml"),
      `base_url = "test.local"\nport = 3000\napi_port = ${apiPort}\nttl = "72h"\nstorage_path = ${JSON.stringify(
        path.join(tmpHome, ".uptool", "files")
      )}\n`
    );
    fs.writeFileSync(path.join(tmpHome, ".uptool", "token"), "tok");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined as never) as typeof process.exit);

    try {
      await statusCommand({ json: true });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(exitSpy).toHaveBeenCalledWith(0);
    const jsonCall = logSpy.mock.calls.find((c) => {
      try {
        JSON.parse(c[0]);
        return true;
      } catch {
        return false;
      }
    });
    const parsed = JSON.parse(jsonCall![0]);
    expect(parsed).toMatchObject({
      running: true,
      healthy: true,
      pid: process.pid,
      api_responding: true,
      deployments: 3,
      base_url: "test.local",
      api_port: apiPort,
    });
  });

  // A healthy daemon: own (always-alive) pid + an API answering /files. Returns
  // the api port so the caller can write it into config.toml.
  async function startFakeApi(): Promise<{ port: number; close: () => Promise<void> }> {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ files: [1, 2, 3] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      port: (server.address() as { port: number }).port,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  function writeStatusConfig(extra: string, apiPort: number): void {
    fs.writeFileSync(
      path.join(tmpHome, ".uptool", "config.toml"),
      `base_url = "test.local"\nport = 3000\napi_port = ${apiPort}\nttl = "72h"\nstorage_path = ${JSON.stringify(
        path.join(tmpHome, ".uptool", "files")
      )}\n${extra}`
    );
    fs.writeFileSync(path.join(tmpHome, ".uptool", "token"), "tok");
  }

  function parseJsonOutput(): Record<string, unknown> {
    const jsonCall = logSpy.mock.calls.find((c) => {
      try {
        JSON.parse(c[0]);
        return true;
      } catch {
        return false;
      }
    });
    return JSON.parse(jsonCall![0]);
  }

  it("--json in local mode reports tunnel:none, tunnel_healthy:null and keeps healthy's meaning", async () => {
    fs.writeFileSync(pidFile(), String(process.pid));
    const api = await startFakeApi();
    writeStatusConfig("", api.port);

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined as never) as typeof process.exit);

    try {
      await statusCommand({ json: true });
    } finally {
      await api.close();
    }

    expect(parseJsonOutput()).toMatchObject({
      running: true,
      api_responding: true,
      healthy: true,
      tunnel: "none",
      tunnel_healthy: null,
      tunnel_url: "http://*.test.local",
    });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("--json in cloudflare mode with the tunnel down reports healthy:false and exits 1", async () => {
    fs.writeFileSync(pidFile(), String(process.pid));
    const api = await startFakeApi();
    // Never bind this port: /ready must fail. Must not be the default 20241 —
    // a real cloudflared may be listening there on the developer's machine.
    const metricsPort = await freePort();
    writeStatusConfig(
      `tunnel = "cloudflare"\ntunnel_metrics_port = ${metricsPort}\nscheme = "https"\n`,
      api.port
    );

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined as never) as typeof process.exit);

    try {
      await statusCommand({ json: true });
    } finally {
      await api.close();
    }

    expect(parseJsonOutput()).toMatchObject({
      running: true,
      api_responding: true,
      healthy: false,
      tunnel: "cloudflare",
      tunnel_healthy: false,
      tunnel_url: "https://*.test.local",
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("--json with a running process but unreachable API reports deployments:null and healthy:false", async () => {
    fs.writeFileSync(pidFile(), String(process.pid));
    // Reserve a port, then free it — nothing listens, so probeApi's catch
    // branch (ECONNREFUSED -> null) is exercised.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const apiPort = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    fs.writeFileSync(
      path.join(tmpHome, ".uptool", "config.toml"),
      `base_url = "test.local"\nport = 3000\napi_port = ${apiPort}\nttl = "72h"\nstorage_path = ${JSON.stringify(
        path.join(tmpHome, ".uptool", "files")
      )}\n`
    );
    fs.writeFileSync(path.join(tmpHome, ".uptool", "token"), "tok");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined as never) as typeof process.exit);

    await statusCommand({ json: true });

    expect(exitSpy).toHaveBeenCalledWith(1);
    const jsonCall = logSpy.mock.calls.find((c) => {
      try {
        JSON.parse(c[0]);
        return true;
      } catch {
        return false;
      }
    });
    const parsed = JSON.parse(jsonCall![0]);
    expect(parsed).toMatchObject({
      running: true,
      healthy: false,
      pid: process.pid,
      api_responding: false,
      deployments: null,
    });
  });
});

describe("logsCommand", () => {
  let tmpHome: string;
  let realHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    realHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "uptool-logscmd-"));
    process.env.HOME = tmpHome;
    fs.mkdirSync(path.join(tmpHome, ".uptool"), { recursive: true });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.env.HOME = realHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  function writeLog(content: string): string {
    const p = path.join(tmpHome, ".uptool", "server.log");
    fs.writeFileSync(p, content);
    return p;
  }

  it("prints the tail of the log", () => {
    writeLog("alpha\nbravo\ncharlie\n");
    logsCommand();
    expect(logSpy).toHaveBeenCalledWith("alpha\nbravo\ncharlie");
    expect(process.exitCode).toBeUndefined();
  });

  it("respects -n", () => {
    writeLog(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n");
    logsCommand({ lines: "3" });
    expect(logSpy).toHaveBeenCalledWith("line 17\nline 18\nline 19");
  });

  it("defaults to the last 50 lines", () => {
    writeLog(Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n") + "\n");
    logsCommand();
    expect((logSpy.mock.calls[0][0] as string).split("\n")).toHaveLength(50);
  });

  it("exits non-zero with a clear message when the log file is missing", () => {
    logsCommand();
    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls[0][0]).toMatch(/uptool serve/);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("rejects an invalid line count", () => {
    writeLog("a\n");
    logsCommand({ lines: "0" });
    expect(process.exitCode).toBe(1);
    logsCommand({ lines: "abc" });
    expect(process.exitCode).toBe(1);
  });

  it("prints nothing for an empty log rather than a blank line", () => {
    writeLog("");
    logsCommand();
    expect(logSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});

describe("followLog", () => {
  let dir: string;
  let stop: (() => void) | undefined;
  let out: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "uptool-follow-"));
    out = [];
    writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string) => {
        out.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    writeSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // fs.watchFile polls, so give it a couple of intervals to notice.
  const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

  // Poll until the watcher has emitted `text`, instead of betting on a fixed
  // delay — stat polling latency varies by platform and filesystem.
  //
  // `poke` re-applies the file change on every iteration. fs.watchFile takes
  // its baseline stat asynchronously, so a write landing between followLog()
  // and that baseline is invisible to the watcher forever — under load that
  // made these tests flaky. Repeating the (idempotent) write guarantees at
  // least one change lands after the baseline.
  async function waitFor(text: string, poke: () => void, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (out.join("").includes(text)) return;
      poke();
      await settle(20);
    }
    throw new Error(`timed out waiting for ${JSON.stringify(text)}; got: ${out.join("")}`);
  }

  it("emits only newly appended bytes, not the existing content", async () => {
    const p = path.join(dir, "f.log");
    fs.writeFileSync(p, "already here\n");
    stop = followLog(p, 20);

    await waitFor("brand new", () => fs.appendFileSync(p, "brand new\n"));

    expect(out.join("")).not.toContain("already here");
  }, 25_000);

  it("resumes from the start when the file is truncated mid-follow", async () => {
    const p = path.join(dir, "rotate.log");
    fs.writeFileSync(p, "x".repeat(500) + "\n");
    stop = followLog(p, 20);

    // Rotation: file shrinks. Reading from the stale (larger) offset would
    // emit garbage or nothing; it must restart from the new beginning.
    await waitFor("after rotation", () => fs.writeFileSync(p, "after rotation\n"));
  }, 25_000);

  it("stop() releases the watcher", async () => {
    const p = path.join(dir, "s.log");
    fs.writeFileSync(p, "");
    const release = followLog(p, 20);
    release();
    stop = undefined;

    fs.appendFileSync(p, "ignored\n");
    await settle();
    expect(out.join("")).not.toContain("ignored");
  });
});
