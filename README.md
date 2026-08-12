# uptool

[![CI](https://github.com/pyeom/uptool/actions/workflows/ci.yml/badge.svg)](https://github.com/pyeom/uptool/actions/workflows/ci.yml)

Serve LLM-generated HTML files from your own machine via wildcard subdomains.

Your LLM runs `uptool deploy` → gets back a URL → you open it anywhere.

```
LLM writes dashboard.html
LLM runs: uptool deploy dashboard.html
LLM says: ✓ http://x7k2mq.mydev.com  (expires in 72h)
You open it on your phone, tablet, or any browser
```

No cloud service. No third-party uploads. Your machine, your domain.

---

## Install

```bash
npm install -g uptool
# or use without installing:
npx uptool <command>
```

### Manual installation (from source)

Build and install from the repository — useful for trying unreleased changes or contributing:

```bash
# 1. Clone
git clone https://github.com/pyeom/uptool.git
cd uptool

# 2. Install dependencies
npm install

# 3. Build (compiles src/ → dist/cli.js)
npm run build

# 4a. Link it as a global `uptool` command…
npm link

# 4b. …or run directly without linking:
node dist/cli.js <command>
```

Verify it works:

```bash
uptool --version
```

To remove a linked build later:

```bash
npm unlink -g uptool
```

> Requires Node.js ≥ 18.

---

## Prerequisites

**No domain? You need nothing at all** — jump to [Share a file](#share-a-file-no-domain-needed).

To serve on your own domain you need one you control (e.g. `mydev.com`), plus, depending on how you expose it (see [Exposure modes](#exposure-modes)):

- **Local mode** (default) — a wildcard DNS record `*.mydev.com → A → <your machine's public IP>`, and port forwarding on your router for port 3000 (or whichever you configure).
- **Cloudflare Tunnel mode** — the domain must be a zone in a Cloudflare account. No public IP, no open ports, no forwarding.

---

## Share a file (no domain needed)

```bash
uptool share report.html
# Opening a public tunnel…
# ✓ https://harbor-recreation-chen-promoted.trycloudflare.com
```

Deploys the file and puts it behind a throwaway [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/): a random public URL, over HTTPS, with no domain, no Cloudflare account and no DNS record. Send the link to anyone. Ctrl-C ends it.

Combines with `--qr` (handy for opening it on a phone) and `--protect` (Basic Auth on top of the link). Live reload works through the tunnel, so `--update`ing the deployment refreshes any open tab.

The link is not resumable: a new `uptool share` gets a new random URL. The deployment itself stays on your machine after Ctrl-C — remove it with `uptool rm <slug>`.

> Quick tunnels are rate-limited and explicitly not meant for production. For something durable, use a domain and one of the exposure modes below.

---

## Exposure modes

| | `uptool share` | Local (default) | Cloudflare Tunnel |
|---|---|---|---|
| Domain needed | none | your own | your own, as a Cloudflare zone |
| Account needed | none | none | Cloudflare (free plan is enough) |
| URL | random, per share | `<slug>.mydev.com`, stable | `<slug>.mydev.com`, stable |
| Lifetime | while the command runs | as long as the daemon runs | as long as the daemon runs |
| DNS | none | wildcard A record → your public IP | wildcard CNAME → the tunnel |
| Router | nothing to open | port forwarding required | nothing to open |
| Public IP | not needed | required (static or dynamic DNS) | not needed |
| HTTPS | included | your own certs (`cert_file`/`key_file`) or a proxy | included, terminated by Cloudflare |

Local mode is the default and requires no account anywhere: uptool listens on your machine and the internet reaches it directly. Nothing about it changed when tunnels were added — if you never run `uptool tunnel` or `uptool share`, nothing extra is spawned.

Tunnel mode runs `cloudflared` as a child of the daemon, which dials out to Cloudflare and receives traffic over that connection.

```bash
uptool tunnel login   # browser flow; authorizes cloudflared for one zone,
                      # writing ~/.cloudflared/cert.pem
uptool tunnel setup   # creates (or reuses) the tunnel, writes
                      # ~/.uptool/cloudflared.yml, tries the DNS record, and
                      # switches the config to https + trust_proxy + 127.0.0.1
uptool tunnel status  # binary, cert, config, tunnel id, live health
uptool tunnel off     # back to local mode; deletes nothing on Cloudflare
```

`uptool status` reports tunnel health too, and `uptool status --json` gains `tunnel`, `tunnel_healthy` and `tunnel_url`. In tunnel mode the daemon is only healthy when the tunnel is connected.

### Use the apex domain

Cloudflare's free Universal SSL covers a single wildcard level: `*.mydev.com` gets a valid certificate, `*.dev.mydev.com` does not. Set `base_url` to the apex domain (`mydev.com`), or browsers will show a TLS error on every deployment. The alternative is Advanced Certificate Manager (paid) or bringing your own certificate.

### The wildcard DNS record is usually manual

`uptool tunnel setup` tries to create the record, but the Cloudflare API rejects wildcard records created that way. This is expected — add it yourself, in the dashboard under **DNS → Records → Add record**:

```
Type:   CNAME
Name:   *
Target: <tunnel-UUID>.cfargotunnel.com
Proxy:  Proxied (orange cloud)
```

`setup` prints the UUID for you. Proxied wildcard records are available on every plan, Free included.

---

## Setup

```bash
uptool init
```

Walks you through configuration and writes `~/.uptool/config.toml`:

```toml
base_url = "mydev.com"
port = 3000        # public HTTP server
api_port = 3001    # internal API (localhost only)
ttl = "72h"        # file expiry — 0 = never
storage_path = "~/.uptool/files"

# Optional
max_file_size = 5242880        # max bytes per deployed file (0 = unlimited, default 5 MB)
max_total_storage = 524288000  # max bytes across all deployments (0 = unlimited, default 500 MB)
rate_limit_rpm = 0     # per-IP requests/min on the public server (0 = off)
trust_proxy = false    # read X-Forwarded-For for client IP (only behind a proxy you control)
bind = "0.0.0.0"       # interface the public server listens on
# cert_file = "/path/fullchain.pem"   # enables HTTPS when set with key_file
# key_file  = "/path/privkey.pem"

# Tunnel — written by `uptool tunnel setup`, not by `uptool init`
tunnel = "none"              # "none" (default) or "cloudflare"
tunnel_name = "uptool"       # name of the Cloudflare tunnel to create/reuse
tunnel_id = ""               # UUID, filled in by setup
tunnel_metrics_port = 20241  # cloudflared's local metrics port (health checks)
cloudflared_path = ""        # explicit binary path; empty = look it up in PATH
```

---

## Usage

### Start the server

```bash
uptool serve
```

Starts as a background daemon. Logs go to `~/.uptool/server.log`.

### Deploy a file

```bash
uptool deploy dashboard.html
# ✓ http://x7k2mq.mydev.com  (expires in 72h)
```

### Deploy from stdin

```bash
cat output.html | uptool deploy
# or pipe directly from a script
echo "<h1>Hello</h1>" | uptool deploy
```

LLM output wrapped in markdown fences is handled automatically:

```
```html
<h1>Hello</h1>
```
→ strips fences, deploys the HTML
```

### Update an existing deployment

Keep the same URL while the LLM iterates:

```bash
uptool deploy v2.html --update x7k2mq
# same URL, new content
```

### QR code

Print a scannable QR code for the URL, handy for pulling a deploy up on a phone:

```bash
uptool deploy dashboard.html --qr
```

With multiple files in one invocation, a QR is printed after each URL.

### Watch and redeploy

Keep the process running and redeploy in place whenever the source changes:

```bash
uptool deploy dashboard.html --watch
# ✓ http://x7k2mq.mydev.com
# Watching dashboard.html for changes... (Ctrl-C to stop)
# ↻ redeployed http://x7k2mq.mydev.com (14:32:07)
```

Works on a single file or a directory bundle, and combines with `--qr` (printed once, on the first deploy). Changes are debounced 300ms. `--watch` requires exactly one file/directory argument and can't be used with stdin. Stop with Ctrl-C.

### Protected deployments

Require a key to view (dashboards with semi-private data, drafts):

```bash
uptool deploy report.html --protect            # autogenerates a key
# ✓ http://x7k2mq9a.mydev.com
#   key: dGhpc2lzYWtleQ  (Basic Auth password — any username)

uptool deploy report.html --protect mysecret   # or bring your own
```

The browser prompts once (leave the username blank, paste the key as the password) and re-sends credentials for every asset in the bundle. Updating with `--update` keeps the existing key. Use HTTPS — Basic Auth over plain HTTP is readable in transit.

### Renew expiry

Extend a deployment's TTL without redeploying:

```bash
uptool touch x7k2mq9a --ttl 7d   # 7 more days from now
uptool touch dashboard --ttl 0   # never expire
uptool touch x7k2mq9a            # renew with the configured default ttl
```

### List deployments

```bash
uptool list
# x7k2mq  http://x7k2mq.mydev.com  [dashboard.html]  expires in 71h 45m  3 hits · last seen 12m ago
# a9f3kd2p  http://a9f3kd2p.mydev.com  [draft.html]  expires in 20h 3m  never viewed
```

View counts track HTML page loads only — assets inside a bundle, 404s and
`HEAD` requests don't inflate the number. They survive daemon restarts and
`--update` redeploys.

For scripts (or for the LLM driving uptool), `--json` emits the full record:

```bash
uptool list --json
# [{"slug":"x7k2mq","url":"http://x7k2mq.mydev.com","filename":"dashboard.html",
#   "created":1754006400000,"expires":1754265600000,"hits":3,
#   "last_seen":1754092800000,"protected":false}]
```

Access keys of protected deployments are never included in either output.

### Remove a deployment

```bash
uptool rm x7k2mq
```

### Daemon control

```bash
uptool stop           # stop the daemon
uptool status         # check if running + last 10 log lines
uptool status --json  # machine-readable health for monitoring (exit 1 if unhealthy)
```

### Logs

```bash
uptool logs           # last 50 lines of ~/.uptool/server.log
uptool logs -n 200    # last 200 lines
uptool logs -f        # follow as it grows (Ctrl-C to stop)
```

Reads the log file directly — no daemon or config needed, so it still works
when the daemon is down, which is usually when you want it.

### Run as a systemd service (Linux)

Survives reboots and restarts on failure:

```bash
uptool install-service
systemctl --user daemon-reload
systemctl --user enable --now uptool

# start on boot without logging in:
loginctl enable-linger $USER
```

Point Uptime Kuma (or any monitor) at a cron job running `uptool status --json` — it exits non-zero when the daemon or API is down.

---

## LLM integration

Tell your LLM to deploy files using `uptool deploy`. Example prompt addition:

> When you create an HTML file for me to review, run `uptool deploy <filename>` and include the returned URL in your response.

Works with Claude Code, Cursor, Cline, or any tool-enabled LLM that can run shell commands.

---

## How it works

```
uptool serve
  ├── Public server  (port 3000)  — routes by subdomain slug → serves HTML
  ├── Internal API   (port 3001)  — localhost only, accepts deploy/list/rm
  └── cloudflared    (tunnel mode only) — child process, dials out to
                                          Cloudflare and forwards to port 3000

uptool deploy file.html
  └── POSTs HTML to internal API → gets slug back → prints URL
```

Files stored at `~/.uptool/files/<slug>.html`. Manifest at `~/.uptool/files/manifest.json`. Expired files cleaned on startup and hourly.

---

## TTL format

| Value | Meaning |
|-------|---------|
| `72h` | 72 hours |
| `7d`  | 7 days  |
| `30m` | 30 minutes |
| `0`   | Never expires |

---

## Security & threat model

uptool serves files from **your** machine on **your** domain, reachable by anyone on the internet. Understand what that means before you point a domain at it.

- **Anything you deploy is public.** There is no login wall on served pages. Anyone with the URL can view the content. Don't deploy secrets, credentials, or private data.
- **Slugs are unguessable; names are not.** Random slugs (`x7k2mq`) are 8 chars of crypto-random base36 — not enumerable. But a named deployment (`--name dashboard`) is trivially guessable (`dashboard.yourdomain`). Use names only for content you're fine exposing.
- **You are responsible for what you host.** Serving content on your domain makes you the publisher of it. Don't deploy untrusted HTML you wouldn't stand behind.
- **The internal API is protected with a bearer token.** It binds to `127.0.0.1` and checks the `Authorization: Bearer <token>` header. The token is stored in `~/.uptool/token` (mode 0600, readable by your user only) and generated during `uptool init`. All CLI commands read this token and pass it to the daemon.
- **Protected deployments use Basic Auth.** `--protect` keys are stored in the local manifest and checked with a constant-time compare. Over plain HTTP the key travels base64-encoded, not encrypted — so in local mode combine `--protect` with HTTPS or treat it as a speed bump, not a lock. In tunnel mode the visitor's connection is HTTPS already, so the key is encrypted in transit.
- **Use HTTPS for anything real.** In tunnel mode this is handled for you: Cloudflare terminates TLS and the local server only listens on `127.0.0.1`. In local mode you have to arrange it — set `cert_file`/`key_file` with certs for your own domain, or terminate TLS at a proxy. Plain HTTP sends content — and the live-reload socket — in the clear.
- **`cert.pem` is a broad credential.** `uptool tunnel login` writes `~/.cloudflared/cert.pem`, which authorizes managing tunnels and DNS records for the whole zone — not just this tunnel. Treat it like an API key: user-readable only, and don't copy it to machines you don't trust.
- **Abuse controls.** The public server sets request/header/idle timeouts by default. Deploys are capped by `max_file_size` (5 MB) and `max_total_storage` (500 MB) so a looping LLM can't fill your disk. For raw internet exposure you can also set `rate_limit_rpm`. Behind a proxy/tunnel, set `trust_proxy = true` so the limit keys off the real visitor IP instead of the proxy.

Found a vulnerability? Open an issue at https://github.com/pyeom/uptool/issues (or mark it security-sensitive).

---

## License

MIT — see [LICENSE](LICENSE).
