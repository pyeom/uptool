import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { serveCommand } from "./commands/serve.js";
import { deployCommand } from "./commands/deploy.js";
import { listCommand } from "./commands/list.js";
import { rmCommand } from "./commands/rm.js";
import { stopCommand } from "./commands/stop.js";
import { statusCommand } from "./commands/status.js";
import { installServiceCommand } from "./commands/install-service.js";
import { touchCommand } from "./commands/touch.js";
import { openCommand } from "./commands/open.js";
import { rollbackCommand } from "./commands/rollback.js";
import { mcpCommand } from "./commands/mcp.js";
import {
  setUrlCommand,
  setPortCommand,
  setApiPortCommand,
  setStorageCommand,
  configCommand,
} from "./commands/config.js";

const program = new Command();

program
  .name("uptool")
  .description("Serve LLM-generated HTML files via wildcard subdomains on your own domain")
  .version("0.2.0");

program
  .command("init")
  .description("Interactive setup wizard")
  .action(() => initCommand());

program
  .command("serve")
  .description("Start the uptool daemon")
  .option("--foreground", "Run in foreground instead of daemonizing", false)
  .action((opts) => serveCommand(opts));

program
  .command("deploy [files...]")
  .description(
    "Deploy HTML file(s), directory bundle(s), or stdin — prints the public URL(s)"
  )
  .option("-u, --update <slug>", "Update an existing deployment by slug or name (single file only)")
  .option("-n, --name <name>", "Assign a stable named slug (single file only)")
  .option(
    "--protect [key]",
    "Require Basic Auth to view (autogenerates a key when none is given)"
  )
  .option("--qr", "Print a QR code for the public URL", false)
  .option(
    "--watch",
    "Watch the file/directory and redeploy on change (single target only)",
    false
  )
  .action((files, opts) => deployCommand(files, opts));

program
  .command("touch <slug>")
  .description("Renew a deployment's expiry without redeploying")
  .option("-t, --ttl <ttl>", "New TTL (e.g. 7d, 72h, 30m, 0 = never). Default: config ttl")
  .action((slug, opts) => touchCommand(slug, opts));

program
  .command("list")
  .description("List all deployed files")
  .action(() => listCommand());

program
  .command("rm <slug>")
  .description("Remove a deployed file by slug or name")
  .action((slug) => rmCommand(slug));

program
  .command("open <slug>")
  .description("Open a deployment in the default browser")
  .action((slug) => openCommand(slug));

program
  .command("rollback <slug>")
  .description("Restore the previous version of a deployment")
  .action((slug) => rollbackCommand(slug));

program
  .command("stop")
  .description("Stop the uptool daemon")
  .action(() => stopCommand());

program
  .command("status")
  .description("Show daemon status and recent log")
  .option("--json", "Machine-readable output for monitoring (exit 1 if unhealthy)", false)
  .action((opts) => statusCommand(opts));

program
  .command("install-service")
  .description("Install a systemd user service (auto-restart, start on boot)")
  .action(() => installServiceCommand());

program
  .command("url")
  .description("Set base URL and test connectivity")
  .action(() => setUrlCommand());

program
  .command("port")
  .description("Set public HTTP port")
  .action(() => setPortCommand());

program
  .command("api_port")
  .description("Set internal API port")
  .action(() => setApiPortCommand());

program
  .command("storage")
  .description("Set storage path")
  .action(() => setStorageCommand());

program
  .command("config")
  .description("Reconfigure all settings interactively")
  .action(() => configCommand());

program
  .command("mcp")
  .description("Start MCP server (stdio, for Claude Code integration)")
  .action(() => mcpCommand());

program.parse();
