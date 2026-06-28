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
port = 3000       # public HTTP server
api_port = 3001   # internal API (localhost only)
ttl = "72h"       # file expiry — 0 = never
storage_path = "~/.uptool/files"
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
uptool stop      # stop the daemon
uptool status    # check if running + last 10 log lines
```

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

## License

MIT
