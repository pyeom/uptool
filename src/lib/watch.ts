/**
 * Small helpers used by `deploy --watch`. Kept separate from deploy.ts so
 * they're easy to unit test without spinning up fs.watch or the API client.
 */

/** Debounce: collapse rapid-fire calls into one, `ms` after the last call. */
export function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return ((...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

/** Format a Date as local HH:MM:SS, used in the `↻ redeployed ...` log line. */
export function formatTime(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
