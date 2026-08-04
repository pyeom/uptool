import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { PassThrough } from "node:stream";
import { walkDir, buildBody } from "../src/commands/deploy.js";
import { startDaemon, runCli, type Daemon } from "./helpers.js";

// Partial mock: keep every real export of storage/index.js, but let
// validateBundlePath reject a specific fixture filename so we can exercise
// the "skip invalid path" branch in buildBody without needing a directory
// traversal that walkDir itself could never produce (walkDir already skips
// dotfiles/dot-dirs and never emits ".." segments — see report).
vi.mock("../src/storage/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/storage/index.js")>();
  return {
    ...actual,
    validateBundlePath: (p: string) => (p === "blocked.txt" ? false : actual.validateBundlePath(p)),
  };
});

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "uptool-deploy-test-"));
}

// ---------------------------------------------------------------------------
// walkDir
// ---------------------------------------------------------------------------

describe("walkDir", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkTmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips dotfiles and dot-directories", () => {
    fs.writeFileSync(path.join(dir, ".env"), "secret");
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".git", "config"), "x");
    fs.writeFileSync(path.join(dir, "keep.txt"), "ok");

    const entries = walkDir(dir, dir);
    expect(entries.map((e) => e.rel)).toEqual(["keep.txt"]);
  });

  it("skips node_modules", () => {
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "node_modules", "pkg.js"), "x");
    fs.writeFileSync(path.join(dir, "app.js"), "x");

    const entries = walkDir(dir, dir);
    expect(entries.map((e) => e.rel)).toEqual(["app.js"]);
  });

  it("recurses into subdirectories with forward-slash relative paths", () => {
    fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a", "b", "deep.txt"), "x");

    const entries = walkDir(dir, dir);
    expect(entries.map((e) => e.rel)).toEqual(["a/b/deep.txt"]);
    expect(entries[0].rel).not.toContain("\\");
  });

  it("returns an empty array for an empty directory", () => {
    expect(walkDir(dir, dir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildBody
// ---------------------------------------------------------------------------

describe("buildBody", () => {
  let dir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkTmpDir();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((() => undefined) as unknown) as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  // -- single file ------------------------------------------------------

  it("single .html file yields { html, filename }", async () => {
    const file = path.join(dir, "page.html");
    fs.writeFileSync(file, "<h1>hi</h1>");

    const body = await buildBody(file);
    expect(body).toEqual({ html: "<h1>hi</h1>", filename: "page.html" });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("non-existent path hits the error path", async () => {
    const missing = path.join(dir, "nope.html");
    await buildBody(missing);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Not found"));
  });

  // -- entry-point resolution -------------------------------------------

  it("directory with index.html: entry is index.html", async () => {
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>root</h1>");
    fs.writeFileSync(path.join(dir, "other.html"), "<h1>other</h1>");

    const body = await buildBody(dir);
    expect(body.entry).toBe("index.html");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("directory with exactly one top-level .html and no index.html: that file is entry", async () => {
    fs.writeFileSync(path.join(dir, "app.html"), "<h1>app</h1>");

    const body = await buildBody(dir);
    expect(body.entry).toBe("app.html");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("directory with no top-level html: error path", async () => {
    fs.writeFileSync(path.join(dir, "data.json"), "{}");

    await buildBody(dir);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("No HTML files found"));
  });

  it("html only in a subdirectory still errors (not a top-level candidate)", async () => {
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "page.html"), "<h1>nested</h1>");

    await buildBody(dir);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("No HTML files found"));
  });

  it("directory with multiple top-level html files and no index.html: ambiguous error", async () => {
    fs.writeFileSync(path.join(dir, "a.html"), "<h1>a</h1>");
    fs.writeFileSync(path.join(dir, "b.html"), "<h1>b</h1>");

    await buildBody(dir);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Multiple HTML files"));
  });

  it("empty directory hits the 'directory is empty' error path", async () => {
    await buildBody(dir);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("empty"))).toBe(true);
  });

  // -- bundle assembly ----------------------------------------------------

  it("base64-encodes files keyed by relative path", async () => {
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>root</h1>");
    fs.mkdirSync(path.join(dir, "css"));
    fs.writeFileSync(path.join(dir, "css", "style.css"), "body{margin:0}");

    const body = await buildBody(dir);
    const files = body.files as Record<string, string>;
    expect(files["index.html"]).toBe(Buffer.from("<h1>root</h1>").toString("base64"));
    expect(files["css/style.css"]).toBe(Buffer.from("body{margin:0}").toString("base64"));
    expect(body.filename).toBe(path.basename(dir));
  });

  it("binary files round-trip byte-exactly through base64", async () => {
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>root</h1>");
    // Minimal PNG signature + a few bytes, not a valid image but real binary content
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x7f]);
    fs.writeFileSync(path.join(dir, "logo.png"), pngBytes);

    const body = await buildBody(dir);
    const files = body.files as Record<string, string>;
    const roundTripped = Buffer.from(files["logo.png"], "base64");
    expect(roundTripped.equals(pngBytes)).toBe(true);
  });

  it("skips paths rejected by validateBundlePath with a warning", async () => {
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>root</h1>");
    fs.writeFileSync(path.join(dir, "blocked.txt"), "should not be included");

    const body = await buildBody(dir);
    const files = body.files as Record<string, string>;
    expect(files["blocked.txt"]).toBeUndefined();
    expect(files["index.html"]).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("blocked.txt"));
  });

  // -- stdin ----------------------------------------------------------------

  describe("stdin", () => {
    let originalStdin: NodeJS.ReadStream;

    beforeEach(() => {
      originalStdin = process.stdin;
    });

    afterEach(() => {
      Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
    });

    it("reads stdin content and names it stdin.html", async () => {
      const fake = new PassThrough();
      Object.defineProperty(process, "stdin", { value: fake, configurable: true });

      const promise = buildBody(undefined);
      fake.end("<h1>from stdin</h1>");
      const body = await promise;

      expect(body).toEqual({ html: "<h1>from stdin</h1>", filename: "stdin.html" });
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("empty/whitespace-only stdin hits the error path", async () => {
      const fake = new PassThrough();
      Object.defineProperty(process, "stdin", { value: fake, configurable: true });

      const promise = buildBody(undefined);
      fake.end("   \n  ");
      await promise;

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("No content provided"));
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: a deployed directory bundle actually serves
// ---------------------------------------------------------------------------

function httpGet(
  port: number,
  host: string,
  urlPath: string
): Promise<{ status: number; body: string; contentType?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method: "GET", headers: { Host: host } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: raw, contentType: res.headers["content-type"] })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("deploy integration (directory bundle)", () => {
  let daemon: Daemon;
  let dir: string;

  beforeEach(async () => {
    daemon = await startDaemon();
    dir = mkTmpDir();
  });

  afterEach(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await daemon.stop();
  });

  it("serves the entry at / and a nested asset at its path", async () => {
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>Hello Bundle</h1>");
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "assets", "style.css"), "body{color:red}");

    const result = await runCli(["deploy", dir], { home: daemon.home, timeoutMs: 15000 });
    expect(result.code).toBe(0);

    const match = result.stdout.match(/https?:\/\/([^./]+)\.test\.local/);
    expect(match).not.toBeNull();
    const slug = match![1];
    const host = `${slug}.test.local`;

    const root = await httpGet(daemon.pubPort, host, "/");
    expect(root.status).toBe(200);
    expect(root.body).toContain("Hello Bundle");
    expect(root.contentType).toContain("text/html");

    const asset = await httpGet(daemon.pubPort, host, "/assets/style.css");
    expect(asset.status).toBe(200);
    expect(asset.body).toBe("body{color:red}");
    expect(asset.contentType).toContain("text/css");
  });
});
