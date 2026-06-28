import { describe, it, expect } from "vitest";
import { parseTtlMs, publicUrl, DEFAULT_CONFIG } from "../src/config/index.js";

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
