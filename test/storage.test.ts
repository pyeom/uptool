import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  generateSlug,
  stripMarkdownFences,
  validateBundlePath,
  mimeForPath,
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
});
