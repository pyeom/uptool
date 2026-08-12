import { describe, it, expect } from "vitest";
import { isMarkdownPath, renderMarkdown } from "../src/lib/markdown.js";

describe("isMarkdownPath", () => {
  it("matches .md and .markdown, case-insensitively", () => {
    expect(isMarkdownPath("notes.md")).toBe(true);
    expect(isMarkdownPath("/tmp/NOTES.MD")).toBe(true);
    expect(isMarkdownPath("readme.markdown")).toBe(true);
  });

  it("does not match anything else", () => {
    expect(isMarkdownPath("index.html")).toBe(false);
    expect(isMarkdownPath("style.css")).toBe(false);
    // A name that merely contains "md" is not Markdown.
    expect(isMarkdownPath("mdfile.txt")).toBe(false);
  });
});

describe("renderMarkdown", () => {
  it("renders a standalone document, not a fragment", () => {
    const out = renderMarkdown("# Hello\n\nSome *text*.", "notes.md");
    expect(out).toMatch(/^<!DOCTYPE html>/);
    expect(out).toContain("<h1>Hello</h1>");
    expect(out).toContain("<em>text</em>");
    expect(out).toContain("<style>");
  });

  it("prefers the first heading over the filename for the title", () => {
    const out = renderMarkdown("# Real Title\n\nbody", "notes.md");
    expect(out).toContain("<title>Real Title</title>");
  });

  it("falls back to the filename when there is no heading", () => {
    const out = renderMarkdown("just a paragraph", "notes.md");
    expect(out).toContain("<title>notes.md</title>");
  });

  it("escapes the title so a heading cannot break out of the tag", () => {
    const out = renderMarkdown("# </title><script>alert(1)</script>", "x.md");
    expect(out).not.toContain("<title></title><script>");
    expect(out).toContain("&lt;/title&gt;");
  });

  it("renders code fences and tables", () => {
    const out = renderMarkdown(
      "```js\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |",
      "x.md"
    );
    expect(out).toContain("<pre>");
    expect(out).toContain("<table>");
  });
});
