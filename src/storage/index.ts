import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { resolvePath, parseTtlMs } from "../config/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ManifestEntry {
  /** Display name (original filename or dir name). */
  filename: string;
  created: number;
  expires: number;
  /** Root file within the slug directory to serve for `/`. Default "index.html". */
  entry: string;
  /** Optional stable name (e.g. "dashboard" → dashboard.mydev.com). */
  name?: string;
  /** Saved version timestamps (newest first). Used for rollback. */
  versions?: string[];
}

export type Manifest = Record<string, ManifestEntry>;

// ---------------------------------------------------------------------------
// Pure helpers (no side effects — easy to unit-test)
// ---------------------------------------------------------------------------

const SLUG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Generate a cryptographically random 8-char base-36 slug that doesn't
 * collide with any existing entry in the manifest.
 */
export function generateSlug(manifest: Manifest): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const bytes = crypto.randomBytes(8);
    let slug = "";
    for (let i = 0; i < 8; i++) {
      slug += SLUG_CHARS[bytes[i] % SLUG_CHARS.length];
    }
    if (!manifest[slug]) return slug;
  }
  throw new Error("Failed to generate unique slug after 100 attempts");
}

/**
 * Strip markdown code fences from LLM output.
 * Handles both whole-string fences and fences embedded in prose.
 */
export function stripMarkdownFences(input: string): string {
  // Whole-string fence (original behaviour, most precise)
  const wholeMatch = input.match(/^```(?:html)?\s*\n([\s\S]*?)\n```\s*$/);
  if (wholeMatch) return wholeMatch[1];
  // First fenced block in prose
  const inlineMatch = input.match(/```(?:html)?\s*\n([\s\S]*?)\n```/);
  if (inlineMatch) return inlineMatch[1];
  return input;
}

/**
 * Validate a bundle-relative file path supplied by the user (or an LLM).
 * Rejects absolute paths, path traversal, and dotfiles/dotdirs.
 */
export function validateBundlePath(p: string): boolean {
  if (!p || typeof p !== "string") return false;
  if (path.isAbsolute(p)) return false;
  const normalized = path.normalize(p);
  if (normalized.startsWith("..")) return false;
  // Reject dotfiles / dotdirs (protects internal .versions dir)
  const parts = normalized.split(path.sep);
  if (parts.some((part) => part.startsWith("."))) return false;
  return true;
}

/** Validate a named-slug identifier. */
export function isValidName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,30}$/.test(name);
}

// ---------------------------------------------------------------------------
// MIME types (no dep — small static map)
// ---------------------------------------------------------------------------

const MIME_MAP: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".cjs": "application/javascript",
  ".json": "application/json",
  ".jsonld": "application/ld+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".map": "application/json",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
};

export function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Low-level disk I/O (used internally by ManifestStore)
// ---------------------------------------------------------------------------

function manifestPath(storageDir: string): string {
  return path.join(storageDir, "manifest.json");
}

export function loadManifest(storageDir: string): Manifest {
  const p = manifestPath(storageDir);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Manifest;
  } catch {
    return {};
  }
}

function saveManifestSync(storageDir: string, manifest: Manifest): void {
  // Atomic write: dump to a temp file then rename. A crash mid-write leaves the
  // old manifest intact instead of a truncated/corrupt JSON file.
  const target = manifestPath(storageDir);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, target);
}

export function ensureStorageDir(storageDir: string): string {
  const resolved = resolvePath(storageDir);
  if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

// ---------------------------------------------------------------------------
// ManifestStore — in-memory manifest owned by the daemon process
// ---------------------------------------------------------------------------

// Typed EventEmitter declaration for TypeScript
declare interface ManifestStore {
  on(event: "updated", listener: (slug: string) => void): this;
  emit(event: "updated", slug: string): boolean;
}

/**
 * Daemon-owned in-memory manifest.  All reads/writes go through this object.
 * Flushes to manifest.json debounced (500 ms) after every mutation.
 *
 * CLI sub-commands that run in separate processes MUST use the HTTP API to
 * communicate with the daemon — they cannot access this store directly.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class ManifestStore extends EventEmitter {
  /** Resolved, absolute path to the storage directory. */
  readonly storageDir: string;

  private manifest: Manifest = {};
  /** name → slug reverse index for O(1) named-slug lookup. */
  private nameIndex = new Map<string, string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ttl: string;
  private readonly maxVersions: number;

  constructor(
    storageDir: string,
    options: { ttl: string; max_versions: number }
  ) {
    super();
    this.storageDir = ensureStorageDir(storageDir);
    this.ttl = options.ttl;
    this.maxVersions = options.max_versions;
    this.manifest = loadManifest(this.storageDir);
    // Back-fill missing 'entry' field from legacy single-file deployments
    for (const [slug, entry] of Object.entries(this.manifest)) {
      if (!entry.entry) this.manifest[slug].entry = "index.html";
    }
    // Build name index
    for (const [slug, entry] of Object.entries(this.manifest)) {
      if (entry.name) this.nameIndex.set(entry.name, slug);
    }
    this._migrateLegacy();
  }

  // -------------------------------------------------------------------------
  // Migration
  // -------------------------------------------------------------------------

  /** Move old `<slug>.html` flat files into `<slug>/index.html` directories. */
  private _migrateLegacy(): void {
    let migrated = 0;
    for (const slug of Object.keys(this.manifest)) {
      const oldFile = path.join(this.storageDir, `${slug}.html`);
      if (fs.existsSync(oldFile)) {
        const slugDir = path.join(this.storageDir, slug);
        if (!fs.existsSync(slugDir)) fs.mkdirSync(slugDir, { recursive: true });
        fs.renameSync(oldFile, path.join(slugDir, "index.html"));
        migrated++;
      }
    }
    if (migrated > 0) this.scheduleFlush();
  }

  // -------------------------------------------------------------------------
  // Flush
  // -------------------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      saveManifestSync(this.storageDir, this.manifest);
      this.flushTimer = null;
    }, 500);
  }

  /** Flush immediately (e.g. on SIGTERM). */
  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    saveManifestSync(this.storageDir, this.manifest);
  }

  // -------------------------------------------------------------------------
  // Slug resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve a slug-or-name to the canonical slug.
   * Returns null if not found.
   */
  resolveSlug(slugOrName: string): string | null {
    if (this.manifest[slugOrName]) return slugOrName;
    const byName = this.nameIndex.get(slugOrName);
    if (byName && this.manifest[byName]) return byName;
    return null;
  }

  getEntry(slug: string): ManifestEntry | null {
    return this.manifest[slug] ?? null;
  }

  list(): Array<ManifestEntry & { slug: string }> {
    return Object.entries(this.manifest).map(([slug, entry]) => ({ slug, ...entry }));
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  /**
   * Store a new deployment. Pass either `html` (single-file back-compat)
   * or `files` (base64 bundle map).
   * Returns the generated slug.
   */
  store(
    html: string | null,
    files: Record<string, string> | null,
    entry: string,
    filename: string,
    name?: string
  ): string {
    if (name) {
      if (!isValidName(name)) {
        throw new Error(
          `Invalid name "${name}". Use lowercase letters, digits, hyphens; start with letter/digit; max 31 chars.`
        );
      }
      if (this.nameIndex.has(name)) {
        const existing = this.nameIndex.get(name)!;
        throw new Error(
          `Name "${name}" already in use (slug: ${existing}). Use --update ${name} to update it.`
        );
      }
    }

    const slug = generateSlug(this.manifest);
    const slugDir = path.join(this.storageDir, slug);
    fs.mkdirSync(slugDir, { recursive: true });

    this._writeBundleFiles(slugDir, html, files, entry);

    const ttlMs = parseTtlMs(this.ttl);
    const now = Date.now();
    this.manifest[slug] = {
      filename,
      created: now,
      expires: ttlMs > 0 ? now + ttlMs : 0,
      entry,
      ...(name ? { name } : {}),
    };

    if (name) this.nameIndex.set(name, slug);
    this.scheduleFlush();
    return slug;
  }

  /**
   * Update an existing deployment in-place.
   * Accepts slug or named slug.
   */
  update(
    slugOrName: string,
    html: string | null,
    files: Record<string, string> | null,
    entry: string,
    filename: string
  ): string {
    const slug = this.resolveSlug(slugOrName);
    if (!slug) throw new Error(`Slug not found: ${slugOrName}`);

    const existing = this.manifest[slug];
    const slugDir = path.join(this.storageDir, slug);

    // Save current state as a version before overwriting
    if (this.maxVersions > 0) {
      this._saveVersion(slug, slugDir);
    }

    // Clear current content (preserve .versions dir)
    this._clearSlugFiles(slugDir);

    this._writeBundleFiles(slugDir, html, files, entry);

    const ttlMs = parseTtlMs(this.ttl);
    const now = Date.now();
    this.manifest[slug] = {
      ...existing,
      filename,
      expires: ttlMs > 0 ? now + ttlMs : 0,
      entry,
    };

    this.scheduleFlush();
    this.emit("updated", slug);
    return slug;
  }

  /** Remove a deployment by slug or name. Returns false if not found. */
  remove(slugOrName: string): boolean {
    const slug = this.resolveSlug(slugOrName);
    if (!slug) return false;

    const entry = this.manifest[slug];
    const slugDir = path.join(this.storageDir, slug);
    if (fs.existsSync(slugDir)) fs.rmSync(slugDir, { recursive: true });

    if (entry.name) this.nameIndex.delete(entry.name);
    delete this.manifest[slug];
    this.scheduleFlush();
    return true;
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  /**
   * Read a file from within a slug's bundle.
   * `urlPath` is the URL path (e.g. "/" or "/style.css").
   * Returns null if: slug not found, expired, traversal attempt, or file missing.
   */
  readFile(
    slugOrName: string,
    urlPath: string
  ): { buffer: Buffer; contentType: string } | null {
    const slug = this.resolveSlug(slugOrName);
    if (!slug) return null;

    const entry = this.manifest[slug];
    if (entry.expires > 0 && Date.now() > entry.expires) {
      // Expired — don't delete here; let the hourly sweep handle it
      return null;
    }

    const slugDir = path.join(this.storageDir, slug);

    // Resolve URL path → relative file path
    const relPath =
      urlPath === "/" || urlPath === "" ? entry.entry : urlPath.replace(/^\/+/, "");

    // Reject dotfile paths (includes .versions)
    if (!validateBundlePath(relPath)) return null;

    const fullPath = path.resolve(slugDir, relPath);

    // Double-check containment (belt + suspenders)
    if (
      fullPath !== slugDir &&
      !fullPath.startsWith(slugDir + path.sep)
    ) {
      return null;
    }

    // Serve directory → index.html inside it
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      const indexPath = path.join(fullPath, "index.html");
      if (!fs.existsSync(indexPath)) return null;
      return { buffer: fs.readFileSync(indexPath), contentType: "text/html; charset=utf-8" };
    }

    if (!fs.existsSync(fullPath)) {
      // Try adding .html for extensionless URLs (e.g. /about → about.html)
      if (!path.extname(relPath)) {
        const withExt = fullPath + ".html";
        if (fs.existsSync(withExt)) {
          return { buffer: fs.readFileSync(withExt), contentType: "text/html; charset=utf-8" };
        }
      }
      return null;
    }

    return { buffer: fs.readFileSync(fullPath), contentType: mimeForPath(fullPath) };
  }

  // -------------------------------------------------------------------------
  // Versioning (P3)
  // -------------------------------------------------------------------------

  /**
   * Rollback the latest version of a slug.
   * Returns the restored version timestamp, or null if nothing to roll back.
   */
  rollback(slugOrName: string): string | null {
    const slug = this.resolveSlug(slugOrName);
    if (!slug) return null;

    const entry = this.manifest[slug];
    if (!entry.versions || entry.versions.length === 0) return null;

    const latestTs = entry.versions[0];
    const slugDir = path.join(this.storageDir, slug);
    const versionDir = path.join(slugDir, ".versions", latestTs);

    if (!fs.existsSync(versionDir)) return null;

    // Read stored entry point from version metadata
    const metaPath = path.join(versionDir, ".meta");
    const restoredEntry = fs.existsSync(metaPath)
      ? fs.readFileSync(metaPath, "utf8").trim()
      : entry.entry;

    // Replace current content with version (keep .versions dir)
    this._clearSlugFiles(slugDir);

    for (const item of fs.readdirSync(versionDir)) {
      if (item.startsWith(".")) continue; // skip .meta and other dotfiles
      const src = path.join(versionDir, item);
      const dst = path.join(slugDir, item);
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        this._copyDir(src, dst);
      } else {
        fs.copyFileSync(src, dst);
      }
    }

    this.manifest[slug] = {
      ...entry,
      entry: restoredEntry,
      versions: entry.versions.slice(1),
    };

    this.scheduleFlush();
    this.emit("updated", slug);
    return latestTs;
  }

  // -------------------------------------------------------------------------
  // Expiry sweep
  // -------------------------------------------------------------------------

  /** Remove all expired deployments. Returns count removed. */
  cleanExpired(): number {
    const now = Date.now();
    let count = 0;
    for (const [slug, entry] of Object.entries(this.manifest)) {
      if (entry.expires > 0 && now > entry.expires) {
        this.remove(slug);
        count++;
      }
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _writeBundleFiles(
    slugDir: string,
    html: string | null,
    files: Record<string, string> | null,
    entry: string
  ): void {
    if (html !== null) {
      fs.writeFileSync(path.join(slugDir, entry), stripMarkdownFences(html), "utf8");
    } else if (files) {
      for (const [relPath, base64Content] of Object.entries(files)) {
        if (!validateBundlePath(relPath)) continue;
        const fullPath = path.join(slugDir, relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, Buffer.from(base64Content, "base64"));
      }
    }
  }

  private _clearSlugFiles(slugDir: string): void {
    if (!fs.existsSync(slugDir)) return;
    for (const item of fs.readdirSync(slugDir)) {
      if (item === ".versions") continue; // preserve version history
      fs.rmSync(path.join(slugDir, item), { recursive: true });
    }
  }

  private _saveVersion(slug: string, slugDir: string): void {
    if (!fs.existsSync(slugDir)) return;

    const entry = this.manifest[slug];
    const versionsDir = path.join(slugDir, ".versions");
    const ts = Date.now().toString();
    const versionDir = path.join(versionsDir, ts);

    fs.mkdirSync(versionDir, { recursive: true });

    // Write metadata (entry point, for accurate rollback)
    fs.writeFileSync(path.join(versionDir, ".meta"), entry.entry, "utf8");

    // Copy current non-.versions content into the version dir
    this._copyDir(slugDir, versionDir, [".versions"]);

    // Update manifest versions list, pruning beyond max
    const versions = [ts, ...(entry.versions ?? [])];
    const keep = versions.slice(0, this.maxVersions);
    for (const old of versions.slice(this.maxVersions)) {
      const oldDir = path.join(versionsDir, old);
      if (fs.existsSync(oldDir)) fs.rmSync(oldDir, { recursive: true });
    }
    this.manifest[slug].versions = keep;
  }

  private _copyDir(src: string, dst: string, exclude: string[] = []): void {
    if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
    for (const item of fs.readdirSync(src)) {
      if (exclude.includes(item)) continue;
      const srcPath = path.join(src, item);
      const dstPath = path.join(dst, item);
      if (fs.statSync(srcPath).isDirectory()) {
        this._copyDir(srcPath, dstPath, exclude);
      } else {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }
}
