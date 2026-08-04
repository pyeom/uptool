import * as fs from "node:fs";
import { logPath } from "../config/index.js";
import { readLogTail } from "./status.js";

const DEFAULT_LINES = 50;

/**
 * Print the daemon log. Reads `~/.uptool/server.log` directly — no config file
 * and no running daemon required, so it still works on a half-set-up install
 * (or precisely when the daemon died and you want to know why).
 */
export function logsCommand(opts: { follow?: boolean; lines?: string } = {}): void {
  const file = logPath();

  if (!fs.existsSync(file)) {
    console.error(`No log file at ${file}. Start the daemon first: uptool serve`);
    process.exitCode = 1;
    return;
  }

  const lineCount = opts.lines ? parseInt(opts.lines, 10) : DEFAULT_LINES;
  if (!Number.isFinite(lineCount) || lineCount < 1) {
    console.error(`Invalid line count: ${opts.lines}`);
    process.exitCode = 1;
    return;
  }

  const tail = readLogTail(file, lineCount);
  if (tail) console.log(tail);

  if (opts.follow) followLog(file);
}

/**
 * Print bytes appended to `file` after the initial tail, until Ctrl-C.
 *
 * Uses fs.watchFile (stat polling) rather than fs.watch: watch's inotify events
 * are unreliable for append-only writes across platforms and give no size, and
 * polling hands us the previous/current stat pair that truncation detection
 * needs anyway. A log tailer is not hot enough for the 1s interval to matter.
 */
export function followLog(file: string, intervalMs = 1000): () => void {
  let offset = fs.statSync(file).size;

  fs.watchFile(file, { interval: intervalMs }, (curr) => {
    // Truncated or rotated: the file we were reading is gone or reset, so
    // reading from the old offset would emit garbage. Restart from the top.
    if (curr.size < offset) offset = 0;
    if (curr.size === offset) return;

    const fd = fs.openSync(file, "r");
    try {
      const len = curr.size - offset;
      const buf = Buffer.alloc(len);
      const read = fs.readSync(fd, buf, 0, len, offset);
      offset += read;
      process.stdout.write(buf.subarray(0, read).toString("utf8"));
    } finally {
      fs.closeSync(fd);
    }
  });

  const stop = (): void => fs.unwatchFile(file);
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
  return stop;
}
