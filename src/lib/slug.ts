function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract the subdomain slug from the Host header. Returns null if not a valid subdomain. */
export function extractSlug(host: string, baseUrl: string): string | null {
  const base = baseUrl.replace(/^https?:\/\//, "");
  const slug = host.replace(new RegExp(`\\.${escapeRegex(base)}(:\\d+)?$`), "");
  if (!slug || slug === host) return null;
  return slug;
}
