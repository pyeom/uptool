import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  generateSlug,
  stripMarkdownFences,
  validateBundlePath,
  mimeForPath,
  dirSize,
  ManifestStore,
  type Manifest,
} from "../src/storage/index.js";
import { DEFAULT_CONFIG } from "../src/config/index.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("generateSlug", () => {
  it("returns 8 alphanumeric chars", () => {
    const slug = generateSlug({});
    expect(slug).toMatch(/^[a-z0-9]{8}$/);
  });

  it("avoids collision with existing slugs", () => {
    // Build a manifest that contains every possible 1-char slug (not realistic
    // but proves the retry loop works for collisions on short slugs)
    const manifest: Manifest = {};
    for (let i = 0; i < 200; i++) {
      const s = generateSlug(manifest);
      expect(manifest[s]).toBeUndefined();
      manifest[s] = { filename: "x", created: 0, expires: 0, entry: "index.html" };
    }
    expect(Object.keys(manifest).length).toBe(200);
  });

  it("generates unique slugs across calls", () => {
    const manifest: Manifest = {};
    const slugs = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const s = generateSlug(manifest);
      expect(slugs.has(s)).toBe(false);
      slugs.add(s);
      manifest[s] = { filename: "x", created: 0, expires: 0, entry: "index.html" };
    }
  });
});

describe("stripMarkdownFences", () => {
  it("returns plain text unchanged", () => {
    expect(stripMarkdownFences("<h1>Hello</h1>")).toBe("<h1>Hello</h1>");
  });

  it("strips whole-string fence", () => {
    const input = "```html\n<h1>Hi</h1>\n```";
    expect(stripMarkdownFences(input)).toBe("<h1>Hi</h1>");
  });

  it("strips generic fence without html tag", () => {
    const input = "```\n<h1>Hi</h1>\n```";
    expect(stripMarkdownFences(input)).toBe("<h1>Hi</h1>");
  });

  it("extracts first fenced block from prose", () => {
    const input =
      "Here is your dashboard:\n\n```html\n<h1>Dashboard</h1>\n```\n\nLet me know if you need changes.";
    expect(stripMarkdownFences(input)).toBe("<h1>Dashboard</h1>");
  });

  it("prefers whole-string match over inline when both apply", () => {
    // If the whole string IS a fence, use that
    const input = "```html\n<p>content</p>\n```";
    expect(stripMarkdownFences(input)).toBe("<p>content</p>");
  });
});

describe("validateBundlePath", () => {
  it("accepts simple filenames", () => {
    expect(validateBundlePath("index.html")).toBe(true);
    expect(validateBundlePath("style.css")).toBe(true);
    expect(validateBundlePath("img/logo.png")).toBe(true);
    expect(validateBundlePath("js/app.js")).toBe(true);
  });

  it("rejects absolute paths", () => {
    expect(validateBundlePath("/etc/passwd")).toBe(false);
  });

  it("rejects path traversal", () => {
    expect(validateBundlePath("../other")).toBe(false);
    expect(validateBundlePath("foo/../../etc/passwd")).toBe(false);
  });

  it("rejects dotfiles and dotdirs", () => {
    expect(validateBundlePath(".hidden")).toBe(false);
    expect(validateBundlePath(".versions/old")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(validateBundlePath("")).toBe(false);
  });
});

describe("mimeForPath", () => {
  it("returns correct MIME types", () => {
    expect(mimeForPath("index.html")).toBe("text/html; charset=utf-8");
    expect(mimeForPath("style.css")).toBe("text/css; charset=utf-8");
    expect(mimeForPath("app.js")).toBe("application/javascript");
    expect(mimeForPath("data.json")).toBe("application/json");
    expect(mimeForPath("icon.svg")).toBe("image/svg+xml");
    expect(mimeForPath("photo.jpg")).toBe("image/jpeg");
    expect(mimeForPath("font.woff2")).toBe("font/woff2");
  });

  it("returns octet-stream for unknown extensions", () => {
    expect(mimeForPath("file.xyz")).toBe("application/octet-stream");
  });
});

// ---------------------------------------------------------------------------
// ManifestStore
// ---------------------------------------------------------------------------

describe("ManifestStore", () => {
  let tmpDir: string;
  let store: ManifestStore;

  const storeOpts = { ttl: DEFAULT_CONFIG.ttl, max_versions: DEFAULT_CONFIG.max_versions };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "uptool-test-"));
    store = new ManifestStore(tmpDir, storeOpts);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  // -------------------------------------------------------------------------
  // store / readFile (single HTML)
  // -------------------------------------------------------------------------

  it("stores a single HTML file and reads it back", () => {
    const slug = store.store("<h1>Hello</h1>", null, "index.html", "test.html");
    const result = store.readFile(slug, "/");
    expect(result).not.toBeNull();
    expect(result!.contentType).toBe("text/html; charset=utf-8");
    expect(result!.buffer.toString()).toBe("<h1>Hello</h1>");
  });

  it("stores a bundle and reads files by path", () => {
    const html = Buffer.from("<h1>Hi</h1>").toString("base64");
    const css = Buffer.from("body{margin:0}").toString("base64");
    const slug = store.store(
      null,
      { "index.html": html, "style.css": css },
      "index.html",
      "site"
    );

    const root = store.readFile(slug, "/");
    expect(root!.buffer.toString()).toBe("<h1>Hi</h1>");

    const stylesheet = store.readFile(slug, "/style.css");
    expect(stylesheet!.contentType).toBe("text/css; charset=utf-8");
    expect(stylesheet!.buffer.toString()).toBe("body{margin:0}");
  });

  it("returns null for unknown slug", () => {
    expect(store.readFile("nonexistent", "/")).toBeNull();
  });

  it("returns null for expired entry without removing it mid-read", () => {
    const slug = store.store("<p>bye</p>", null, "index.html", "x.html");
    // Manually expire it
    (store as unknown as { manifest: Manifest }).manifest[slug].expires = Date.now() - 1000;

    expect(store.readFile(slug, "/")).toBeNull();
    // Entry still exists — removal is left to the sweep
    expect(store.getEntry(slug)).not.toBeNull();
  });

  it("strips markdown fences from HTML string on store", () => {
    const slug = store.store("```html\n<h1>Test</h1>\n```", null, "index.html", "t.html");
    const result = store.readFile(slug, "/");
    expect(result!.buffer.toString()).toBe("<h1>Test</h1>");
  });

  // -------------------------------------------------------------------------
  // Path traversal guard
  // -------------------------------------------------------------------------

  it("rejects traversal paths in readFile", () => {
    const slug = store.store("<h1>Safe</h1>", null, "index.html", "safe.html");
    expect(store.readFile(slug, "/../../../etc/passwd")).toBeNull();
    expect(store.readFile(slug, "/.versions/old")).toBeNull();
  });

  it("rejects traversal paths in bundle", () => {
    // Traversal paths in the files map should be silently skipped
    const bad = Buffer.from("evil").toString("base64");
    const good = Buffer.from("<h1>ok</h1>").toString("base64");
    const slug = store.store(
      null,
      { "index.html": good, "../evil.txt": bad },
      "index.html",
      "test"
    );

    // Only index.html should exist; ../evil.txt must not be written
    const slugDir = path.join(store.storageDir, slug);
    expect(fs.existsSync(path.join(slugDir, "index.html"))).toBe(true);
    // The traversal target outside storageDir/slug MUST not exist
    expect(fs.existsSync(path.join(store.storageDir, "evil.txt"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // update / remove
  // -------------------------------------------------------------------------

  it("updates an existing deployment", () => {
    const slug = store.store("<h1>v1</h1>", null, "index.html", "test.html");
    store.update(slug, "<h1>v2</h1>", null, "index.html", "test.html");
    const result = store.readFile(slug, "/");
    expect(result!.buffer.toString()).toBe("<h1>v2</h1>");
  });

  it("resolves named slug on update", () => {
    const slug = store.store("<h1>v1</h1>", null, "index.html", "t.html", "myapp");
    store.update("myapp", "<h1>v2</h1>", null, "index.html", "t.html");
    const result = store.readFile(slug, "/");
    expect(result!.buffer.toString()).toBe("<h1>v2</h1>");
  });

  it("removes a deployment", () => {
    const slug = store.store("<h1>bye</h1>", null, "index.html", "x.html");
    const removed = store.remove(slug);
    expect(removed).toBe(true);
    expect(store.readFile(slug, "/")).toBeNull();
    const slugDir = path.join(store.storageDir, slug);
    expect(fs.existsSync(slugDir)).toBe(false);
  });

  it("returns false when removing non-existent slug", () => {
    expect(store.remove("doesnotexist")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Named slugs
  // -------------------------------------------------------------------------

  it("stores and retrieves by name", () => {
    store.store("<h1>Named</h1>", null, "index.html", "n.html", "dashboard");
    const result = store.readFile("dashboard", "/");
    expect(result!.buffer.toString()).toBe("<h1>Named</h1>");
  });

  it("throws on duplicate name", () => {
    store.store("<h1>A</h1>", null, "index.html", "a.html", "myapp");
    expect(() =>
      store.store("<h1>B</h1>", null, "index.html", "b.html", "myapp")
    ).toThrow(/already in use/);
  });

  it("removes name index on delete", () => {
    store.store("<h1>A</h1>", null, "index.html", "a.html", "myapp");
    const slug = store.resolveSlug("myapp")!;
    store.remove(slug);
    expect(store.resolveSlug("myapp")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Versioning (rollback)
  // -------------------------------------------------------------------------

  it("saves a version on update and allows rollback", () => {
    const slug = store.store("<h1>v1</h1>", null, "index.html", "t.html");
    store.update(slug, "<h1>v2</h1>", null, "index.html", "t.html");

    expect(store.readFile(slug, "/")!.buffer.toString()).toBe("<h1>v2</h1>");

    const ts = store.rollback(slug);
    expect(ts).not.toBeNull();
    expect(store.readFile(slug, "/")!.buffer.toString()).toBe("<h1>v1</h1>");
  });

  it("returns null rollback when no versions exist", () => {
    const slug = store.store("<h1>only</h1>", null, "index.html", "t.html");
    expect(store.rollback(slug)).toBeNull();
  });

  it("prunes versions beyond max_versions", () => {
    const maxStore = new ManifestStore(tmpDir + "-max", { ttl: "72h", max_versions: 2 });
    const slug = maxStore.store("<h1>v1</h1>", null, "index.html", "t.html");
    maxStore.update(slug, "<h1>v2</h1>", null, "index.html", "t.html");
    maxStore.update(slug, "<h1>v3</h1>", null, "index.html", "t.html");
    maxStore.update(slug, "<h1>v4</h1>", null, "index.html", "t.html");

    const entry = maxStore.getEntry(slug)!;
    expect((entry.versions ?? []).length).toBeLessThanOrEqual(2);

    fs.rmSync(tmpDir + "-max", { recursive: true });
  });

  // -------------------------------------------------------------------------
  // touch (renewable TTL)
  // -------------------------------------------------------------------------

  describe("touch", () => {
    it("extends expiry with an explicit ttl", () => {
      const slug = store.store("<p>t</p>", null, "index.html", "t.html");
      const before = store.getEntry(slug)!.expires;
      const result = store.touch(slug, "7d");
      expect(result).not.toBeNull();
      expect(result!.expires).toBeGreaterThan(before);
      expect(result!.expires).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
      expect(store.getEntry(slug)!.expires).toBe(result!.expires);
    });

    it("ttl '0' sets never-expire", () => {
      const slug = store.store("<p>t</p>", null, "index.html", "t.html");
      const result = store.touch(slug, "0");
      expect(result!.expires).toBe(0);
    });

    it("falls back to the store default ttl when omitted", () => {
      const slug = store.store("<p>t</p>", null, "index.html", "t.html");
      const result = store.touch(slug);
      // Default ttl is 72h
      const expected = Date.now() + 72 * 60 * 60 * 1000;
      expect(Math.abs(result!.expires - expected)).toBeLessThan(5000);
    });

    it("works by name", () => {
      store.store("<p>t</p>", null, "index.html", "t.html", "myapp");
      const result = store.touch("myapp", "7d");
      expect(result).not.toBeNull();
    });

    it("returns null for unknown slug", () => {
      expect(store.touch("nothere1", "7d")).toBeNull();
    });

    it("throws on invalid ttl format", () => {
      const slug = store.store("<p>t</p>", null, "index.html", "t.html");
      expect(() => store.touch(slug, "banana")).toThrow(/Invalid TTL/);
    });
  });

  // -------------------------------------------------------------------------
  // cleanExpired
  // -------------------------------------------------------------------------

  it("cleanExpired removes expired entries", () => {
    const slug = store.store("<p>temp</p>", null, "index.html", "t.html");
    (store as unknown as { manifest: Manifest }).manifest[slug].expires = Date.now() - 1;

    const count = store.cleanExpired();
    expect(count).toBe(1);
    expect(store.getEntry(slug)).toBeNull();
  });

  it("cleanExpired does not remove non-expired entries", () => {
    const slug = store.store("<p>keep</p>", null, "index.html", "k.html");
    const count = store.cleanExpired();
    // TTL is "72h" so it won't expire
    expect(count).toBe(0);
    expect(store.getEntry(slug)).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Legacy migration
  // -------------------------------------------------------------------------

  it("migrates old flat <slug>.html files to <slug>/index.html on init", () => {
    // Write a legacy flat file
    const fakeSlug = "legacyab";
    const legacyManifest = {
      [fakeSlug]: { filename: "old.html", created: Date.now(), expires: 0, entry: "index.html" },
    };
    fs.writeFileSync(
      path.join(tmpDir, "manifest.json"),
      JSON.stringify(legacyManifest)
    );
    fs.writeFileSync(path.join(tmpDir, `${fakeSlug}.html`), "<h1>Legacy</h1>");

    // Re-init the store — migration should run
    const s2 = new ManifestStore(tmpDir, storeOpts);
    const result = s2.readFile(fakeSlug, "/");
    expect(result).not.toBeNull();
    expect(result!.buffer.toString()).toBe("<h1>Legacy</h1>");
    // Old flat file should be gone
    expect(fs.existsSync(path.join(tmpDir, `${fakeSlug}.html`))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Storage limits (max_file_size / max_total_storage)
  // -------------------------------------------------------------------------

  describe("storage limits", () => {
    it("rejects a single HTML file over max_file_size", () => {
      const limited = new ManifestStore(tmpDir + "-lim1", {
        ...storeOpts,
        max_file_size: 100,
      });
      const big = "x".repeat(200);
      expect(() =>
        limited.store(big, null, "index.html", "big.html")
      ).toThrow(/max_file_size/);
      fs.rmSync(tmpDir + "-lim1", { recursive: true });
    });

    it("rejects a bundle file over max_file_size", () => {
      const limited = new ManifestStore(tmpDir + "-lim2", {
        ...storeOpts,
        max_file_size: 100,
      });
      const files = {
        "index.html": Buffer.from("<h1>ok</h1>").toString("base64"),
        "big.bin": Buffer.from("y".repeat(200)).toString("base64"),
      };
      expect(() =>
        limited.store(null, files, "index.html", "site")
      ).toThrow(/big\.bin/);
      fs.rmSync(tmpDir + "-lim2", { recursive: true });
    });

    it("rejects deploys once max_total_storage is exceeded", () => {
      const dir = tmpDir + "-lim3";
      const limited = new ManifestStore(dir, {
        ...storeOpts,
        max_total_storage: 300,
      });
      limited.store("a".repeat(200), null, "index.html", "a.html");
      expect(() =>
        limited.store("b".repeat(200), null, "index.html", "b.html")
      ).toThrow(/max_total_storage/);
      fs.rmSync(dir, { recursive: true });
    });

    it("allows deploys again after removing content", () => {
      const dir = tmpDir + "-lim4";
      const limited = new ManifestStore(dir, {
        ...storeOpts,
        max_total_storage: 300,
      });
      const slug = limited.store("a".repeat(200), null, "index.html", "a.html");
      limited.remove(slug);
      expect(() =>
        limited.store("b".repeat(200), null, "index.html", "b.html")
      ).not.toThrow();
      fs.rmSync(dir, { recursive: true });
    });

    it("writes nothing to disk when a limit rejects the deploy", () => {
      const dir = tmpDir + "-lim5";
      const limited = new ManifestStore(dir, {
        ...storeOpts,
        max_file_size: 100,
      });
      try {
        limited.store("x".repeat(200), null, "index.html", "big.html");
      } catch {
        // expected
      }
      // Storage dir must contain no slug directories
      const entries = fs.readdirSync(dir).filter((e) => e !== "manifest.json");
      expect(entries).toEqual([]);
      fs.rmSync(dir, { recursive: true });
    });

    it("allows an equal-sized replacement at the quota when versioning is off", () => {
      const dir = tmpDir + "-lim7";
      const limited = new ManifestStore(dir, {
        ttl: "72h",
        max_versions: 0, // replaced content frees its bytes
        max_total_storage: 300,
      });
      const slug = limited.store("a".repeat(250), null, "index.html", "a.html");
      expect(() =>
        limited.update(slug, "b".repeat(250), null, "index.html", "a.html")
      ).not.toThrow();
      // Growing past the quota still fails
      expect(() =>
        limited.update(slug, "c".repeat(400), null, "index.html", "a.html")
      ).toThrow(/max_total_storage/);
      fs.rmSync(dir, { recursive: true });
    });

    it("counts existing content against the quota when versioning keeps it", () => {
      const dir = tmpDir + "-lim8";
      const limited = new ManifestStore(dir, {
        ttl: "72h",
        max_versions: 2, // old content archived into .versions — not freed
        max_total_storage: 300,
      });
      const slug = limited.store("a".repeat(250), null, "index.html", "a.html");
      expect(() =>
        limited.update(slug, "b".repeat(250), null, "index.html", "a.html")
      ).toThrow(/max_total_storage/);
      fs.rmSync(dir, { recursive: true });
    });

    it("measures exact decoded base64 sizes (padding-aware)", () => {
      const dir = tmpDir + "-lim9";
      const limited = new ManifestStore(dir, {
        ttl: "72h",
        max_versions: 0,
        max_file_size: 1,
      });
      // "YQ==" decodes to exactly 1 byte ("a") — must pass a 1-byte limit
      expect(() =>
        limited.store(null, { "index.html": "YQ==" }, "index.html", "a.html")
      ).not.toThrow();
      // 2 bytes must fail
      expect(() =>
        limited.store(null, { "index.html": Buffer.from("ab").toString("base64") }, "index.html", "b.html")
      ).toThrow(/max_file_size/);
      fs.rmSync(dir, { recursive: true });
    });

    it("exposes err.code = FILE_TOO_LARGE / QUOTA_EXCEEDED, not just a message", () => {
      const dir1 = tmpDir + "-code1";
      const limited1 = new ManifestStore(dir1, { ...storeOpts, max_file_size: 10 });
      let err1: NodeJS.ErrnoException | undefined;
      try {
        limited1.store("x".repeat(20), null, "index.html", "big.html");
      } catch (e) {
        err1 = e as NodeJS.ErrnoException;
      }
      expect(err1?.code).toBe("FILE_TOO_LARGE");
      fs.rmSync(dir1, { recursive: true });

      const dir2 = tmpDir + "-code2";
      const limited2 = new ManifestStore(dir2, { ...storeOpts, max_total_storage: 10 });
      let err2: NodeJS.ErrnoException | undefined;
      try {
        limited2.store("x".repeat(20), null, "index.html", "big.html");
      } catch (e) {
        err2 = e as NodeJS.ErrnoException;
      }
      expect(err2?.code).toBe("QUOTA_EXCEEDED");
      fs.rmSync(dir2, { recursive: true });
    });

    it("base64 size estimation matches true decoded byte length for 0/1/2 padding chars", () => {
      // 0 padding: length divisible by 4 exactly (e.g. 3 bytes -> 4 b64 chars)
      const noPad = Buffer.from("abc").toString("base64"); // "YWJj", no '='
      expect(noPad.endsWith("=")).toBe(false);
      // 1 padding char: 2 bytes -> "YWI="
      const onePad = Buffer.from("ab").toString("base64");
      expect(onePad.endsWith("=") && !onePad.endsWith("==")).toBe(true);
      // 2 padding chars: 1 byte -> "YQ=="
      const twoPad = Buffer.from("a").toString("base64");
      expect(twoPad.endsWith("==")).toBe(true);

      for (const [b64, trueLen] of [
        [noPad, 3],
        [onePad, 2],
        [twoPad, 1],
      ] as const) {
        const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
        const estimated = Math.floor((b64.length * 3) / 4) - padding;
        expect(estimated).toBe(trueLen);
        expect(estimated).toBe(Buffer.from(b64, "base64").length);
      }
    });

    it("limits disabled (0 = unlimited) short-circuits entirely", () => {
      const dir = tmpDir + "-unlimited";
      const limited = new ManifestStore(dir, {
        ttl: "72h",
        max_versions: 0,
        max_file_size: 0,
        max_total_storage: 0,
      });
      expect(() =>
        limited.store("z".repeat(10_000), null, "index.html", "big.html")
      ).not.toThrow();
      fs.rmSync(dir, { recursive: true });
    });

    it("applies limits on update too", () => {
      const dir = tmpDir + "-lim6";
      const limited = new ManifestStore(dir, {
        ...storeOpts,
        max_file_size: 100,
      });
      const slug = limited.store("<h1>v1</h1>", null, "index.html", "t.html");
      expect(() =>
        limited.update(slug, "x".repeat(200), null, "index.html", "t.html")
      ).toThrow(/max_file_size/);
      // Original content untouched
      expect(limited.readFile(slug, "/")!.buffer.toString()).toBe("<h1>v1</h1>");
      fs.rmSync(dir, { recursive: true });
    });
  });

  // -------------------------------------------------------------------------
  // Atomic manifest persistence
  // -------------------------------------------------------------------------

  describe("manifest atomicity", () => {
    it("flushNow writes valid JSON and leaves no temp files", () => {
      store.store("<h1>A</h1>", null, "index.html", "a.html");
      store.flushNow();

      const manifestFile = path.join(store.storageDir, "manifest.json");
      expect(fs.existsSync(manifestFile)).toBe(true);
      // Parses cleanly
      const parsed = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      expect(Object.keys(parsed).length).toBe(1);
      // No leftover .tmp files from the write-then-rename
      const leftovers = fs.readdirSync(store.storageDir).filter((f) => f.endsWith(".tmp"));
      expect(leftovers).toEqual([]);
    });

    it("keeps the previous manifest intact if a stale temp file exists", () => {
      store.store("<h1>A</h1>", null, "index.html", "a.html");
      store.flushNow();
      // Simulate a crash that left a corrupt temp file behind
      fs.writeFileSync(path.join(store.storageDir, "manifest.json.999.tmp"), "{corrupt");

      // Reload — must read the good manifest, not the temp file
      const s2 = new ManifestStore(store.storageDir, storeOpts);
      expect(s2.list().length).toBe(1);
    });

    it("flushNow cancels the pending debounced flush (no stray write later)", () => {
      vi.useFakeTimers();
      try {
        store.store("<h1>A</h1>", null, "index.html", "a.html");
        store.flushNow();
        const mtimeAfterFlush = fs.statSync(
          path.join(store.storageDir, "manifest.json")
        ).mtimeMs;

        // Advance past the 500ms debounce window. If the pending timer from
        // store() were NOT cancelled by flushNow(), this would fire another
        // (harmless but redundant) write; if it somehow raced a deleted dir
        // it would throw (the bug this test exists to rule out).
        vi.advanceTimersByTime(1000);

        const mtimeAfterAdvance = fs.statSync(
          path.join(store.storageDir, "manifest.json")
        ).mtimeMs;
        expect(mtimeAfterAdvance).toBe(mtimeAfterFlush);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a manifest written by flushNow reloads correctly in a fresh store", () => {
      store.store("<h1>A</h1>", null, "index.html", "a.html");
      store.store("<h1>B</h1>", null, "index.html", "b.html", "named-b");
      store.flushNow();

      const fresh = new ManifestStore(store.storageDir, storeOpts);
      expect(fresh.list().length).toBe(2);
      expect(fresh.resolveSlug("named-b")).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // dirSize
  // -------------------------------------------------------------------------

  describe("dirSize", () => {
    it("returns 0 for a missing directory", () => {
      expect(dirSize(path.join(tmpDir, "does-not-exist"))).toBe(0);
    });

    it("recurses into nested directories", () => {
      const nested = path.join(tmpDir, "a", "b", "c");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "a", "top.txt"), "12345"); // 5 bytes
      fs.writeFileSync(path.join(tmpDir, "a", "b", "mid.txt"), "1234567890"); // 10 bytes
      fs.writeFileSync(path.join(nested, "leaf.txt"), "123"); // 3 bytes

      expect(dirSize(path.join(tmpDir, "a"))).toBe(18);
    });
  });

  // -------------------------------------------------------------------------
  // Version pruning deletes directories from disk
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // recordHit (view counts)
  // -------------------------------------------------------------------------

  describe("recordHit", () => {
    it("increments hits and stamps last_seen", () => {
      const slug = store.store("<h1>v1</h1>", null, "index.html", "t.html");
      expect(store.getEntry(slug)!.hits).toBeUndefined();

      const before = Date.now();
      store.recordHit(slug);
      const entry = store.getEntry(slug)!;
      expect(entry.hits).toBe(1);
      expect(entry.last_seen).toBeGreaterThanOrEqual(before);

      store.recordHit(slug);
      expect(store.getEntry(slug)!.hits).toBe(2);
    });

    it("is a silent no-op for an unknown slug", () => {
      expect(() => store.recordHit("doesnotexist")).not.toThrow();
    });

    it("resolves a named slug", () => {
      store.store("<h1>v1</h1>", null, "index.html", "t.html", "myapp");
      store.recordHit("myapp");
      const slug = store.resolveSlug("myapp")!;
      expect(store.getEntry(slug)!.hits).toBe(1);
    });

    it("survives update() — redeploying keeps the view count", () => {
      const slug = store.store("<h1>v1</h1>", null, "index.html", "t.html");
      store.recordHit(slug);
      store.recordHit(slug);
      store.update(slug, "<h1>v2</h1>", null, "index.html", "t.html");
      expect(store.getEntry(slug)!.hits).toBe(2);
    });

    it("survives a store reload from disk", () => {
      const slug = store.store("<h1>v1</h1>", null, "index.html", "t.html");
      store.recordHit(slug);
      store.recordHit(slug);
      store.flushNow();

      const reloaded = new ManifestStore(store.storageDir, storeOpts);
      expect(reloaded.getEntry(slug)!.hits).toBe(2);
    });

    it("a legacy entry with no hits field reads as zero, not NaN", () => {
      const slug = store.store("<h1>v1</h1>", null, "index.html", "t.html");
      // Simulate a legacy manifest entry written before hits existed
      delete (store as unknown as { manifest: Manifest }).manifest[slug].hits;

      store.recordHit(slug);
      expect(store.getEntry(slug)!.hits).toBe(1);
      expect(Number.isNaN(store.getEntry(slug)!.hits)).toBe(false);
    });

    it("list() exposes hits/last_seen while still stripping key", () => {
      const slug = store.store(
        "<h1>v1</h1>", null, "index.html", "t.html", undefined, "sekret"
      );
      store.recordHit(slug);
      const listed = store.list().find((e) => e.slug === slug)!;
      expect(listed.hits).toBe(1);
      expect(listed.last_seen).toBeTypeOf("number");
      expect(listed.protected).toBe(true);
      expect((listed as unknown as { key?: string }).key).toBeUndefined();
    });

    it("rollback() keeps the view count — hits track the slug/URL, not a content version", () => {
      const slug = store.store("<h1>v1</h1>", null, "index.html", "t.html");
      store.recordHit(slug);
      store.update(slug, "<h1>v2</h1>", null, "index.html", "t.html");
      store.recordHit(slug);
      expect(store.getEntry(slug)!.hits).toBe(2);

      store.rollback(slug);
      expect(store.getEntry(slug)!.hits).toBe(2);
    });
  });

  it("prunes versions beyond max_versions from disk, not just the manifest", () => {
    const dir = tmpDir + "-prune-disk";
    const maxStore = new ManifestStore(dir, { ttl: "72h", max_versions: 2 });
    const slug = maxStore.store("<h1>v1</h1>", null, "index.html", "t.html");
    maxStore.update(slug, "<h1>v2</h1>", null, "index.html", "t.html");
    maxStore.update(slug, "<h1>v3</h1>", null, "index.html", "t.html");
    maxStore.update(slug, "<h1>v4</h1>", null, "index.html", "t.html");

    const entry = maxStore.getEntry(slug)!;
    const versionsDir = path.join(dir, slug, ".versions");
    const onDisk = fs.readdirSync(versionsDir);

    // Disk must match the manifest exactly — no orphaned old version dirs
    expect(onDisk.sort()).toEqual([...(entry.versions ?? [])].sort());
    expect(onDisk.length).toBeLessThanOrEqual(2);

    fs.rmSync(dir, { recursive: true });
  });
});
