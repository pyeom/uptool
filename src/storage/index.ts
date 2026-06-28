import * as fs from "node:fs";
import * as path from "node:path";
import { resolvePath, parseTtlMs } from "../config/index.js";

export interface ManifestEntry {
  filename: string;
  created: number;
  expires: number;
}

export type Manifest = Record<string, ManifestEntry>;

function manifestPath(storageDir: string): string {
  return path.join(storageDir, "manifest.json");
}

export function loadManifest(storageDir: string): Manifest {
  const p = manifestPath(storageDir);
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function saveManifest(storageDir: string, manifest: Manifest): void {
  fs.writeFileSync(manifestPath(storageDir), JSON.stringify(manifest, null, 2));
}

export function ensureStorageDir(storageDir: string): string {
  const resolved = resolvePath(storageDir);
  if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

export function generateSlug(manifest: Manifest): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let attempt = 0; attempt < 100; attempt++) {
    let slug = "";
    for (let i = 0; i < 8; i++) {
      slug += chars[Math.floor(Math.random() * chars.length)];
    }
    if (!manifest[slug]) return slug;
  }
  throw new Error("Failed to generate unique slug after 100 attempts");
}

export function storeFile(
  storageDir: string,
  html: string,
  filename: string,
  ttl: string
): string {
  const resolved = ensureStorageDir(storageDir);
  const manifest = loadManifest(resolved);
  const slug = generateSlug(manifest);
  const ttlMs = parseTtlMs(ttl);
  const now = Date.now();

  fs.writeFileSync(path.join(resolved, `${slug}.html`), html, "utf8");

  manifest[slug] = {
    filename,
    created: now,
    expires: ttlMs > 0 ? now + ttlMs : 0,
  };
  saveManifest(resolved, manifest);
  return slug;
}

export function updateFile(
  storageDir: string,
  slug: string,
  html: string,
  filename: string,
  ttl: string
): void {
  const resolved = ensureStorageDir(storageDir);
  const manifest = loadManifest(resolved);
  if (!manifest[slug]) throw new Error(`Slug not found: ${slug}`);
  const ttlMs = parseTtlMs(ttl);
  const now = Date.now();

  fs.writeFileSync(path.join(resolved, `${slug}.html`), html, "utf8");
  manifest[slug] = {
    filename,
    created: manifest[slug].created,
    expires: ttlMs > 0 ? now + ttlMs : 0,
  };
  saveManifest(resolved, manifest);
}

export function removeFile(storageDir: string, slug: string): boolean {
  const resolved = resolvePath(storageDir);
  const manifest = loadManifest(resolved);
  if (!manifest[slug]) return false;

  const filePath = path.join(resolved, `${slug}.html`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  delete manifest[slug];
  saveManifest(resolved, manifest);
  return true;
}

export function readFile(storageDir: string, slug: string): string | null {
  const resolved = resolvePath(storageDir);
  const manifest = loadManifest(resolved);
  if (!manifest[slug]) return null;

  if (manifest[slug].expires > 0 && Date.now() > manifest[slug].expires) {
    removeFile(storageDir, slug);
    return null;
  }

  const filePath = path.join(resolved, `${slug}.html`);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

export function cleanExpired(storageDir: string): number {
  const resolved = resolvePath(storageDir);
  if (!fs.existsSync(resolved)) return 0;
  const manifest = loadManifest(resolved);
  const now = Date.now();
  let count = 0;

  for (const [slug, entry] of Object.entries(manifest)) {
    if (entry.expires > 0 && now > entry.expires) {
      const filePath = path.join(resolved, `${slug}.html`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      delete manifest[slug];
      count++;
    }
  }

  if (count > 0) saveManifest(resolved, manifest);
  return count;
}

export function listFiles(storageDir: string): Array<ManifestEntry & { slug: string }> {
  const resolved = resolvePath(storageDir);
  const manifest = loadManifest(resolved);
  return Object.entries(manifest).map(([slug, entry]) => ({ slug, ...entry }));
}

export function stripMarkdownFences(input: string): string {
  const fenceMatch = input.match(/^```(?:html)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) return fenceMatch[1];
  return input;
}
