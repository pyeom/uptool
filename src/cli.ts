import { Command } from "commander";
import { version } from "../package.json";
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
import { logsCommand } from "./commands/logs.js";
import { shareCommand } from "./commands/share.js";
import { pruneCommand } from "./commands/prune.js";
import {
  tunnelLoginCommand,
  tunnelSetupCommand,
  tunnelStatusCommand,
  tunnelOffCommand,
} from "./commands/tunnel.js";
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
  .version(version);

program
  .command("init")
  .description("Interactive setup wizard")
  .action(() => initCommand());

program
  .command("serve")
  .description("Start the uptool daemon")
  .option("--foreground", "Run in foreground instead of daemonizing", false)
  .action((opts) =>
    serveCommand(opts).catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    })
  );

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
    "Watch the file(s)/directory(ies) and redeploy on change",
    false
  )
  .option("-t, --ttl <ttl>", "Expiry for this deployment (e.g. 2h, 7d, 0 = never)")
  .option("-o, --open", "Open the deployment in the default browser", false)
  .option("--markdown", "Treat the input as Markdown (implied by .md/.markdown)", false)
  .action((files, opts) => deployCommand(files, opts));

program
  .command("share [file]")
  .description("Deploy and expose it on a throwaway public URL (no domain needed)")
  .option(
    "--protect [key]",
    "Require Basic Auth to view (autogenerates a key when none is given)"
  )
  .option("--qr", "Print a QR code for the public URL", false)
  .action((file, opts) => {
    shareCommand(file, opts).catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    });
  });

program
  .command("touch <slug>")
  .description("Renew a deployment's expiry without redeploying")
  .option("-t, --ttl <ttl>", "New TTL (e.g. 7d, 72h, 30m, 0 = never). Default: config ttl")
  .action((slug, opts) => touchCommand(slug, opts));

program
  .command("list")
  .description("List all deployed files")
  .option("--json", "Machine-readable output", false)
  .action((opts) => listCommand(opts));

program
  .command("prune")
  .description("Remove expired deployments, and optionally ones nobody views")
  .option("--unseen <ttl>", "Also remove deployments not viewed in this long (e.g. 30d)")
  .option("--dry-run", "List what would be removed without removing it", false)
  .option("--json", "Machine-readable output", false)
  .action((opts) => pruneCommand(opts));

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
  .command("logs")
  .description("Print the daemon log")
  .option("-n, --lines <n>", "Number of lines to show (default 50)")
  .option("-f, --follow", "Follow the log as it grows (Ctrl-C to stop)", false)
  .action((opts) => logsCommand(opts));

program
  .command("install-service")
  .description("Install a systemd user service (auto-restart, start on boot)")
  .action(() => installServiceCommand());

const tunnel = program
  .command("tunnel")
  .description("Expose uptool through a Cloudflare Tunnel (no open ports)");

/**
 * The cloudflared helpers reject (rather than returning a non-zero code) when
 * the binary is missing, unrunnable, or hangs past its timeout. Commander does
 * not await actions, so without this an operator would get a raw
 * ERR_UNHANDLED_REJECTION stack instead of the message.
 */
function tunnelAction(fn: () => Promise<void>): () => void {
  return () => {
    fn().catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    });
  };
}

tunnel
  .command("login")
  .description("Authorize cloudflared with your Cloudflare account")
  .option("--force", "Re-run the browser flow even if a certificate exists", false)
  .action((opts) => tunnelAction(() => tunnelLoginCommand(opts))());

tunnel
  .command("setup")
  .description("Create the tunnel, write its config, and switch uptool to tunnel mode")
  .action(tunnelAction(() => tunnelSetupCommand()));

tunnel
  .command("status")
  .description("Show tunnel mode, binary, config and connection health")
  .action(tunnelAction(() => tunnelStatusCommand()));

tunnel
  .command("off")
  .description("Switch back to serving locally (keeps the tunnel on Cloudflare)")
  .action(() => tunnelOffCommand());

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

program.parse();
