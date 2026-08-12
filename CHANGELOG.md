# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## Unreleased

### Added

- **`uptool deploy --ttl <ttl>`** sets the expiry for a single deployment
  instead of using the configured default. Works on update too, and `--watch`
  reapplies it on every redeploy.
- **`deploy --watch` accepts several targets.** Each is watched and redeployed
  to its own URL; previously it refused more than one.
- **`uptool prune`** removes expired deployments on demand, and with
  `--unseen <ttl>` also the ones nobody has opened. `--dry-run` previews.
- **Markdown deployments.** `.md`/`.markdown` files are rendered to a styled
  standalone HTML page; `--markdown` forces it for stdin. Adds `marked` as a
  dependency.
- **Automatic gzip/brotli compression** for text responses over 1 KB, with
  `Vary: Accept-Encoding` on every response.
- **`uptool deploy --open`** opens the deployment in the default browser,
  reusing the launcher `uptool open` already had.
- **`uptool share <file>` — a public link with no domain and no account.**
  Deploys the file and exposes it through a Cloudflare quick tunnel, printing a
  random `*.trycloudflare.com` URL over HTTPS. Ctrl-C ends the tunnel; the
  deployment stays local. Works with `--qr` and `--protect`, and live reload
  works through the tunnel. `base_url` now defaults to `uptool.local`, so uptool
  is usable without owning a domain at all.
- **Optional Cloudflare Tunnel mode.** `uptool tunnel login` authorizes
  cloudflared for one zone, `uptool tunnel setup` creates the tunnel and
  switches uptool to HTTPS behind it, `uptool tunnel status` shows what's
  wired up and whether the tunnel is connected, and `uptool tunnel off` goes
  back. In this mode the public server binds to `127.0.0.1` only: no port
  forwarding, no public IP, no certificates to manage. The `cloudflared`
  binary is downloaded on demand and runs as a child of the daemon.
- **`uptool status` knows about the tunnel.** Text output gains a tunnel line,
  `--json` gains `tunnel`, `tunnel_healthy` and `tunnel_url`. `healthy` (and
  therefore the exit code) additionally requires a connected tunnel — but only
  when tunnel mode is on; in local mode its meaning is unchanged.
- **`uptool init` asks whether to use a tunnel** and prints the two commands to
  run. It doesn't enable anything itself.

Default behaviour is unchanged: `tunnel = "none"`, the server still binds
`0.0.0.0` over plain HTTP, and nothing extra is spawned unless you opt in.

## 0.3.0 - 2026-08-01

### Added

- **View counts.** Each deployment tracks how many times its page was actually
  viewed (HTML page loads only — bundle assets, 404s and HEAD requests don't
  count) plus when it was last seen. Shown in `uptool list`, persisted across
  daemon restarts, and kept when you redeploy with `--update`.
- **`uptool list --json`** — machine-readable output for scripts and for the
  LLM agent driving uptool. Access keys of protected deployments are never
  included.
- **`uptool logs`** — print the daemon log without going through
  `uptool status`. Supports `-n <lines>` (default 50) and `-f` to follow, which
  survives log rotation. Reads the file directly, so it works even when the
  daemon is down — which is when you need it.

### Fixed

- **Request bodies with multi-byte characters over ~64 KB were silently
  corrupted.** The API decoded each TCP chunk separately, so an accented letter
  or emoji split across a chunk boundary became a replacement character.
- **`uptool deploy --name <name>` printed the random slug URL** instead of the
  name-based one, even though the deployment was reachable at the name.
- **The live-reload WebSocket ignored `--protect`.** A protected deployment's
  reload socket accepted any client, leaking the fact that a private deployment
  had been updated. It now requires the same credentials as the page, and dead
  sockets are reaped by a heartbeat instead of accumulating.
- **The public server answered every HTTP method as if it were GET**, including
  returning a body for `HEAD`. Now only GET and HEAD are served; anything else
  gets a 405.
- **`uptool status` mangled log lines at the 16 KB read boundary**, truncating a
  line and turning a split multi-byte character into `�`.
- A failed background flush of the manifest could take down the daemon as an
  uncaught exception; it's now logged, with the in-memory state authoritative.

### Removed (BREAKING)

- **MCP server** (`uptool mcp`). uptool is CLI-only now — an agent that already
  has a shell doesn't need a second MCP surface exposing the same commands.
  Replacement: call the CLI directly (`uptool deploy`, `uptool list`, etc.).
- **Admin web UI** (`uptool admin` and the `GET /admin` API route). Same
  reasoning — one surface to keep in sync instead of two. Use `uptool list`,
  `uptool rm`, `uptool rollback` from the CLI instead.

## 0.2.0

Previous release.
