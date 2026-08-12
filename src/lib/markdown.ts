import { marked } from "marked";

/**
 * Render Markdown into a standalone HTML document.
 *
 * LLMs emit far more Markdown than HTML, and a raw `marked` conversion renders
 * as unstyled Times New Roman — technically correct and unpleasant to read. The
 * stylesheet below is deliberately small: readable defaults, a light/dark pair,
 * and nothing to configure.
 */

const STYLE = `
:root { --bg:#fbfaf9; --fg:#1c1917; --muted:#78716c; --line:#e7e5e4; --card:#fff; --accent:#c2410c; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#1c1917; --fg:#f5f5f4; --muted:#a8a29e; --line:#44403c; --card:#292524; --accent:#fb923c; }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 3rem 1.5rem; background: var(--bg); color: var(--fg);
  font: 16px/1.7 ui-sans-serif, system-ui, -apple-system, sans-serif;
}
main { max-width: 46rem; margin: 0 auto; }
h1, h2, h3, h4 { line-height: 1.25; letter-spacing: -.01em; margin: 2.5rem 0 1rem; }
h1 { font-size: 2rem; margin-top: 0; }
h2 { font-size: 1.4rem; padding-bottom: .4rem; border-bottom: 1px solid var(--line); }
h3 { font-size: 1.1rem; }
p, ul, ol, blockquote, table { margin: 1rem 0; }
li { margin: .3rem 0; }
a { color: var(--accent); }
code {
  font: .875em ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--line); padding: .15em .4em; border-radius: 4px;
}
pre {
  background: var(--card); border: 1px solid var(--line); border-radius: 8px;
  padding: 1rem 1.25rem; overflow-x: auto;
}
pre code { background: none; padding: 0; font-size: .875rem; line-height: 1.5; }
blockquote {
  margin-left: 0; padding-left: 1rem; border-left: 3px solid var(--line); color: var(--muted);
}
table { width: 100%; border-collapse: collapse; font-size: .95rem; }
th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid var(--line); }
th { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
img { max-width: 100%; height: auto; }
hr { border: 0; border-top: 1px solid var(--line); margin: 2.5rem 0; }
`.trim();

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** True for the extensions uptool treats as Markdown. */
export function isMarkdownPath(filePath: string): boolean {
  return /\.(md|markdown)$/i.test(filePath);
}

/**
 * Convert Markdown to a full HTML page. `title` shows in the browser tab; the
 * first `# heading` wins over it when there is one.
 */
export function renderMarkdown(md: string, title: string): string {
  const body = marked.parse(md, { async: false }) as string;
  const heading = md.match(/^#\s+(.+)$/m)?.[1]?.trim();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading ?? title)}</title>
<style>
${STYLE}
</style>
</head>
<body>
<main>
${body}</main>
</body>
</html>
`;
}
