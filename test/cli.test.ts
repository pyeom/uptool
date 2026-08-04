import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { startDaemon, runCli, tempHome, writeConfig, type Daemon } from "./helpers.js";

/**
 * test/cli.test.ts — the user-facing contract.
 *
 * Runs the real dist/cli.js as a child process against a real daemon and
 * asserts on exit codes + stdout/stderr content. This is what an LLM agent
 * driving uptool actually sees — no in-process shortcuts.
 *
 * KNOWN LIMITATION: v8 coverage does not instrument subprocesses, so this
 * file does not move the coverage number for src/commands/*. That's expected
 * — this suite locks the CLI contract, not code coverage.
 */

function writeHtmlFile(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe("cli.test.ts", () => {
  let daemon: Daemon;
  let scratch: string;

  beforeAll(async () => {
    daemon = await startDaemon();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "uptool-cli-test-"));
  }, 20_000);

  afterAll(async () => {
    await daemon?.stop();
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------
  // deploy
  // ---------------------------------------------------------------------
  describe("deploy", () => {
    it("deploys a single HTML file and prints its URL", async () => {
      const f = writeHtmlFile(scratch, "single.html", "<h1>single</h1>");
      const res = await runCli(["deploy", f], { home: daemon.home });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/https?:\/\/\S+/);
    });

    it("deploys from stdin", async () => {
      const res = await runCli(["deploy"], { home: daemon.home, input: "<h1>from stdin</h1>" });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/https?:\/\/\S+/);
    });

    it("deploys a directory bundle", async () => {
      const dir = path.join(scratch, "bundle1");
      fs.mkdirSync(dir);
      writeHtmlFile(dir, "index.html", "<h1>bundle root</h1>");
      writeHtmlFile(dir, "other.txt", "hello");
      const res = await runCli(["deploy", dir], { home: daemon.home });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/https?:\/\/\S+/);
    });

    it("deploys multiple files in one invocation, one URL per file", async () => {
      const f1 = writeHtmlFile(scratch, "multi1.html", "<h1>multi1</h1>");
      const f2 = writeHtmlFile(scratch, "multi2.html", "<h1>multi2</h1>");
      const res = await runCli(["deploy", f1, f2], { home: daemon.home });
      expect(res.code).toBe(0);
      const urls = res.stdout.match(/https?:\/\/\S+/g) ?? [];
      expect(urls.length).toBe(2);
    });

    it("--update <slug> keeps the same URL across redeploys", async () => {
      const f = writeHtmlFile(scratch, "update1.html", "<h1>v1</h1>");
      const first = await runCli(["deploy", f], { home: daemon.home });
      expect(first.code).toBe(0);
      const firstUrl = first.stdout.match(/https?:\/\/\S+/)![0];
      const slug = new URL(firstUrl).hostname.split(".")[0];

      fs.writeFileSync(f, "<h1>v2</h1>");
      const second = await runCli(["deploy", f, "--update", slug], { home: daemon.home });
      expect(second.code).toBe(0);
      const secondUrl = second.stdout.match(/https?:\/\/\S+/)![0];
      expect(secondUrl).toBe(firstUrl);
    });

    it("--name <name> prints the name-based URL name.<base_url> (regression guard)", async () => {
      const f = writeHtmlFile(scratch, "named.html", "<h1>named</h1>");
      const uniqueName = "dashboard" + Math.random().toString(36).slice(2, 8);
      const res = await runCli(["deploy", f, "--name", uniqueName], { home: daemon.home });
      expect(res.code).toBe(0);
      const url = res.stdout.match(/https?:\/\/\S+/)![0];
      expect(new URL(url).hostname).toMatch(new RegExp(`^${uniqueName}\\.`));
    });

    it("--protect prints a key line and the URL", async () => {
      const f = writeHtmlFile(scratch, "protected.html", "<h1>secret</h1>");
      const res = await runCli(["deploy", f, "--protect"], { home: daemon.home });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/https?:\/\/\S+/);
      expect(res.stdout.toLowerCase()).toMatch(/key/);
    });

    it("--qr emits QR output", async () => {
      const f = writeHtmlFile(scratch, "qr.html", "<h1>qr</h1>");
      const res = await runCli(["deploy", f, "--qr"], { home: daemon.home });
      expect(res.code).toBe(0);
      // QR ascii art uses block characters; just assert stdout is much
      // longer than a plain deploy (the QR ascii block dominates output).
      expect(res.stdout.length).toBeGreaterThan(200);
    });

    it("rejects --name with multiple files", async () => {
      const f1 = writeHtmlFile(scratch, "rejn1.html", "<h1>1</h1>");
      const f2 = writeHtmlFile(scratch, "rejn2.html", "<h1>2</h1>");
      const res = await runCli(["deploy", f1, f2, "--name", "nope"], { home: daemon.home });
      expect(res.code).not.toBe(0);
    });

    it("rejects --watch with zero targets", async () => {
      const res = await runCli(["deploy", "--watch"], { home: daemon.home, timeoutMs: 5000 });
      expect(res.code).not.toBe(0);
    });

    it("rejects --watch with multiple targets", async () => {
      const f1 = writeHtmlFile(scratch, "watch1.html", "<h1>1</h1>");
      const f2 = writeHtmlFile(scratch, "watch2.html", "<h1>2</h1>");
      const res = await runCli(["deploy", f1, f2, "--watch"], { home: daemon.home, timeoutMs: 5000 });
      expect(res.code).not.toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------
  describe("list", () => {
    it("shows empty-state message when there are no deployments", async () => {
      const empty = await startDaemon();
      try {
        const res = await runCli(["list"], { home: empty.home });
        expect(res.code).toBe(0);
        expect(res.stdout.toLowerCase()).toMatch(/no deployed/);
      } finally {
        await empty.stop();
      }
    }, 20_000);

    it("lists one line per deployment containing slug and URL", async () => {
      const f = writeHtmlFile(scratch, "listtarget.html", "<h1>list me</h1>");
      const deploy = await runCli(["deploy", f], { home: daemon.home });
      const url = deploy.stdout.match(/https?:\/\/\S+/)![0];
      const slug = new URL(url).hostname.split(".")[0];

      const res = await runCli(["list"], { home: daemon.home });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain(slug);
      expect(res.stdout).toContain(url);
    });
  });

  // ---------------------------------------------------------------------
  // rm
  // ---------------------------------------------------------------------
  describe("rm", () => {
    it("removes a deployment (exit 0)", async () => {
      const f = writeHtmlFile(scratch, "rmtarget.html", "<h1>rm me</h1>");
      const deploy = await runCli(["deploy", f], { home: daemon.home });
      const url = deploy.stdout.match(/https?:\/\/\S+/)![0];
      const slug = new URL(url).hostname.split(".")[0];

      const res = await runCli(["rm", slug], { home: daemon.home });
      expect(res.code).toBe(0);
    });

    it("unknown slug exits non-zero with a Not found message", async () => {
      const res = await runCli(["rm", "does-not-exist-slug"], { home: daemon.home });
      expect(res.code).not.toBe(0);
      expect(res.stderr.toLowerCase()).toMatch(/not found/);
    });
  });

  // ---------------------------------------------------------------------
  // touch
  // ---------------------------------------------------------------------
  describe("touch", () => {
    it("--ttl 7d reports the new expiry", async () => {
      const f = writeHtmlFile(scratch, "touchttl.html", "<h1>touch</h1>");
      const deploy = await runCli(["deploy", f], { home: daemon.home });
      const url = deploy.stdout.match(/https?:\/\/\S+/)![0];
      const slug = new URL(url).hostname.split(".")[0];

      const res = await runCli(["touch", slug, "--ttl", "7d"], { home: daemon.home });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/7d/);
    });

    it("--ttl 0 reports never-expires", async () => {
      const f = writeHtmlFile(scratch, "touchnever.html", "<h1>touch never</h1>");
      const deploy = await runCli(["deploy", f], { home: daemon.home });
      const url = deploy.stdout.match(/https?:\/\/\S+/)![0];
      const slug = new URL(url).hostname.split(".")[0];

      const res = await runCli(["touch", slug, "--ttl", "0"], { home: daemon.home });
      expect(res.code).toBe(0);
      expect(res.stdout.toLowerCase()).toMatch(/never/);
    });

    it("invalid ttl exits non-zero", async () => {
      const f = writeHtmlFile(scratch, "touchinvalid.html", "<h1>touch invalid</h1>");
      const deploy = await runCli(["deploy", f], { home: daemon.home });
      const url = deploy.stdout.match(/https?:\/\/\S+/)![0];
      const slug = new URL(url).hostname.split(".")[0];

      const res = await runCli(["touch", slug, "--ttl", "not-a-ttl"], { home: daemon.home });
      expect(res.code).not.toBe(0);
    });

    it("unknown slug exits non-zero", async () => {
      const res = await runCli(["touch", "does-not-exist-slug", "--ttl", "7d"], {
        home: daemon.home,
      });
      expect(res.code).not.toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // rollback
  // ---------------------------------------------------------------------
  describe("rollback", () => {
    it("rolls back after --update and reports the restored version", async () => {
      const f = writeHtmlFile(scratch, "rollback1.html", "<h1>rb v1</h1>");
      const first = await runCli(["deploy", f], { home: daemon.home });
      const url = first.stdout.match(/https?:\/\/\S+/)![0];
      const slug = new URL(url).hostname.split(".")[0];

      fs.writeFileSync(f, "<h1>rb v2</h1>");
      const update = await runCli(["deploy", f, "--update", slug], { home: daemon.home });
      expect(update.code).toBe(0);

      const res = await runCli(["rollback", slug], { home: daemon.home });
      expect(res.code).toBe(0);
      expect(res.stdout.toLowerCase()).toMatch(/version/);
    });

    it("a deployment with no versions exits non-zero", async () => {
      const f = writeHtmlFile(scratch, "rollbacknone.html", "<h1>no history</h1>");
      const deploy = await runCli(["deploy", f], { home: daemon.home });
      const url = deploy.stdout.match(/https?:\/\/\S+/)![0];
      const slug = new URL(url).hostname.split(".")[0];

      const res = await runCli(["rollback", slug], { home: daemon.home });
      expect(res.code).not.toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // status
  // ---------------------------------------------------------------------
  describe("status", () => {
    it("reports running + pid against a live daemon", async () => {
      const res = await runCli(["status"], { home: daemon.home });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/running/);
      expect(res.stdout).toMatch(/pid/i);
    });

    it("--json reports valid JSON with running/healthy true, exit 0", async () => {
      const res = await runCli(["status", "--json"], { home: daemon.home });
      expect(res.code).toBe(0);
      const data = JSON.parse(res.stdout);
      expect(data.running).toBe(true);
      expect(data.healthy).toBe(true);
    });

    it("with no daemon, --json exits 1 and reports unhealthy", async () => {
      const { home } = tempHome();
      writeConfig(home);
      const res = await runCli(["status", "--json"], { home });
      expect(res.code).toBe(1);
      const data = JSON.parse(res.stdout);
      expect(data.running).toBe(false);
      expect(data.healthy).toBe(false);
    });
  });

  // ---------------------------------------------------------------------
  // errors without a daemon
  // ---------------------------------------------------------------------
  describe("errors without a daemon", () => {
    it("list against a stopped daemon exits non-zero with actionable message", async () => {
      const { home } = tempHome();
      writeConfig(home);
      const res = await runCli(["list"], { home });
      expect(res.code).not.toBe(0);
      expect(res.stderr).toMatch(/uptool server not running.*uptool serve/);
    });

    it("deploy against a stopped daemon exits non-zero with actionable message", async () => {
      const { home } = tempHome();
      writeConfig(home);
      const f = writeHtmlFile(scratch, "nodaemon.html", "<h1>no daemon</h1>");
      const res = await runCli(["deploy", f], { home });
      expect(res.code).not.toBe(0);
      expect(res.stderr).toMatch(/uptool server not running.*uptool serve/);
    });
  });

  // ---------------------------------------------------------------------
  // no config at all
  // ---------------------------------------------------------------------
  describe("no config at all", () => {
    it("running a command with no config.toml exits non-zero and tells user to run uptool init", async () => {
      const { home } = tempHome();
      // Deliberately do NOT write a config — home only has an empty .uptool dir.
      const res = await runCli(["list"], { home });
      expect(res.code).not.toBe(0);
      expect(res.stdout + res.stderr).toMatch(/uptool init/);
    });
  });

  // ---------------------------------------------------------------------
  // --version / --help
  // ---------------------------------------------------------------------
  describe("--version / --help", () => {
    it("--version prints 0.3.0", async () => {
      const res = await runCli(["--version"], { home: daemon.home });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("0.3.0");
    });

    it("--help lists the commands and does not mention mcp or admin (deleted this cycle)", async () => {
      const res = await runCli(["--help"], { home: daemon.home });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/deploy/);
      expect(res.stdout).toMatch(/list/);
      expect(res.stdout).not.toMatch(/\bmcp\b/i);
      expect(res.stdout).not.toMatch(/\badmin\b/i);
    });
  });

  describe("list --json", () => {
    it("emits parseable JSON on stdout with the observability fields", async () => {
      const f = writeHtmlFile(scratch, "jsontarget.html", "<h1>json</h1>");
      const deploy = await runCli(["deploy", f], { home: daemon.home });
      const slug = new URL(deploy.stdout.match(/https?:\/\/\S+/)![0]).hostname.split(".")[0];

      const res = await runCli(["list", "--json"], { home: daemon.home });
      expect(res.code).toBe(0);
      // Must be pure JSON — an LLM agent parses this, so no decorative lines.
      const parsed = JSON.parse(res.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      const entry = parsed.find((e: { slug: string }) => e.slug === slug);
      expect(entry).toBeDefined();
      expect(entry).toMatchObject({ slug, hits: 0, last_seen: null, protected: false });
      expect(typeof entry.url).toBe("string");
    }, 20_000);

    it("never leaks the access key of a protected deployment", async () => {
      const f = writeHtmlFile(scratch, "secret.html", "<h1>secret</h1>");
      const deploy = await runCli(["deploy", f, "--protect", "hunter2"], { home: daemon.home });
      expect(deploy.code).toBe(0);
      const slug = new URL(deploy.stdout.match(/https?:\/\/\S+/)![0]).hostname.split(".")[0];

      const res = await runCli(["list", "--json"], { home: daemon.home });
      expect(res.stdout).not.toContain("hunter2");
      // Assert on this test's own entry — the daemon.home is shared.
      const entry = JSON.parse(res.stdout).find((e: { slug: string }) => e.slug === slug);
      expect(entry).toMatchObject({ slug, protected: true });
    }, 20_000);
  });

  describe("logs", () => {
    // startDaemon runs `serve --foreground` with piped stdio, so no
    // ~/.uptool/server.log exists in tests — that file is only written when
    // the daemon is backgrounded. `logs` just reads a file, so write one.
    function seedLog(home: string, content: string): void {
      fs.writeFileSync(path.join(home, ".uptool", "server.log"), content);
    }

    it("prints the daemon log", async () => {
      const { home } = tempHome();
      writeConfig(home);
      seedLog(home, "Public server listening on port 3000\nAPI server listening\n");
      const res = await runCli(["logs"], { home });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/listening/i);
    });

    it("respects -n", async () => {
      const { home } = tempHome();
      writeConfig(home);
      seedLog(home, "one\ntwo\nthree\n");
      const res = await runCli(["logs", "-n", "1"], { home });
      expect(res.code).toBe(0);
      expect(res.stdout.trim().split("\n")).toHaveLength(1);
      expect(res.stdout.trim()).toBe("three");
    });

    it("exits non-zero with guidance when no log file exists", async () => {
      const { home } = tempHome();
      const res = await runCli(["logs"], { home });
      expect(res.code).not.toBe(0);
      expect(res.stderr).toMatch(/uptool serve/);
    });
  });

});
