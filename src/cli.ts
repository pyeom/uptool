import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { serveCommand } from "./commands/serve.js";
import { deployCommand } from "./commands/deploy.js";
import { listCommand } from "./commands/list.js";
import { rmCommand } from "./commands/rm.js";
import { stopCommand } from "./commands/stop.js";
import { statusCommand } from "./commands/status.js";

const program = new Command();

program
  .name("uptool")
  .description("Serve LLM-generated HTML files via wildcard subdomains on your own domain")
  .version("0.1.0");

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
  .command("deploy [file]")
  .description("Deploy an HTML file (or stdin) and get a URL back")
  .option("-u, --update <slug>", "Update an existing deployment by slug")
  .action((file, opts) => deployCommand(file, opts));

program
  .command("list")
  .description("List all deployed files")
  .action(() => listCommand());

program
  .command("rm <slug>")
  .description("Remove a deployed file by slug")
  .action((slug) => rmCommand(slug));

program
  .command("stop")
  .description("Stop the uptool daemon")
  .action(() => stopCommand());

program
  .command("status")
  .description("Show daemon status and recent log")
  .action(() => statusCommand());

program.parse();
