import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Sweep the temp dirs the suite creates.
 *
 * Individual tests clean up after themselves, and test/helpers.ts registers a
 * process-exit handler as a second line of defence — but neither survives a
 * worker being killed, so leftovers still accumulate in /tmp across runs. This
 * teardown runs once after the whole suite and reclaims whatever is left.
 *
 * Only touches directories matching the suite's own `uptool-*-` prefixes
 * inside the OS temp dir; nothing else is in scope.
 */
export function teardown(): void {
  const tmp = os.tmpdir();
  let removed = 0;
  for (const name of fs.readdirSync(tmp)) {
    if (!/^uptool-[a-z0-9-]+-/.test(name)) continue;
    try {
      fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
      removed++;
    } catch {
      // Another run may own it, or it may be gone already — never fail the
      // suite over cleanup.
    }
  }
  if (removed > 0) console.log(`[test teardown] removed ${removed} temp dir(s)`);
}
