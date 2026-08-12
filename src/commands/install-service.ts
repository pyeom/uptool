import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Generate a systemd user service so the daemon survives reboots and
 * restarts on failure. Writes ~/.config/systemd/user/uptool.service.
 */
export function installServiceCommand(): void {
  if (process.platform !== "linux") {
    console.error("install-service requires systemd (Linux only).");
    process.exit(1);
  }

  // Quote + escape for a systemd ExecStart value: backslashes, double quotes,
  // and % specifiers (%% is a literal percent in unit files).
  const q = (s: string): string =>
    `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

  const node = q(process.execPath);
  // Resolve symlinks (npm global bin is usually a symlink into node_modules)
  const cli = q(fs.realpathSync(process.argv[1]));

  const unit = `[Unit]
Description=uptool — selfhosted HTML serving daemon
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${node} ${cli} serve --foreground
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;

  const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
  fs.mkdirSync(unitDir, { recursive: true });
  const unitPath = path.join(unitDir, "uptool.service");
  fs.writeFileSync(unitPath, unit);

  console.log(`✓ Wrote ${unitPath}`);
  console.log(`\nEnable and start:`);
  console.log(`  systemctl --user daemon-reload`);
  console.log(`  systemctl --user enable --now uptool`);
  console.log(`\nStart on boot without logging in:`);
  console.log(`  loginctl enable-linger ${os.userInfo().username}`);
  console.log(`\nNote: stop any manually started daemon first (uptool stop),`);
  console.log(`otherwise the service will fail to bind its ports.`);
  console.log(`\nIn tunnel mode, cloudflared runs as a child of the daemon — no`);
  console.log(`second unit to install. Make sure ~/.cloudflared/cert.pem is`);
  console.log(`readable by the user the service runs as (${os.userInfo().username}).`);
}
