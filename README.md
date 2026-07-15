# uptool

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

You need:

1. **A domain you control** (e.g. `mydev.com`)
2. **A wildcard DNS record** pointing to your machine:
   ```
   *.mydev.com  →  A  →  <your machine's public IP>
   ```
3. **Port forwarding** on your router: port 3000 (or whichever you configure) → your machine

> **No static IP?** Use [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — free, no port forwarding needed.

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
# cert_file = "/path/fullchain.pem"   # enables HTTPS when set with key_file
# key_file  = "/path/privkey.pem"
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
# x7k2mq  http://x7k2mq.mydev.com  [dashboard.html]  expires in 71h 45m
```

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
  └── Internal API   (port 3001)  — localhost only, accepts deploy/list/rm

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
- **Protected deployments use Basic Auth.** `--protect` keys are stored in the local manifest and checked with a constant-time compare. Over plain HTTP the key travels base64-encoded, not encrypted — combine `--protect` with HTTPS or treat it as a speed bump, not a lock.
- **Use HTTPS for anything real.** Set `cert_file`/`key_file` (certs for your own domain), or terminate TLS at a proxy such as Cloudflare Tunnel. Plain HTTP sends content — and the live-reload socket — in the clear.
- **Abuse controls.** The public server sets request/header/idle timeouts by default. Deploys are capped by `max_file_size` (5 MB) and `max_total_storage` (500 MB) so a looping LLM can't fill your disk. For raw internet exposure you can also set `rate_limit_rpm`. Behind a proxy/tunnel, set `trust_proxy = true` so the limit keys off the real visitor IP instead of the proxy.

Found a vulnerability? Open an issue at https://github.com/pyeom/uptool/issues (or mark it security-sensitive).

---

## License

MIT — see [LICENSE](LICENSE).
