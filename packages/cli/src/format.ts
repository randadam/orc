/**
 * A wall-clock duration, rounded to something a person reads at a glance.
 *
 * @param ms the duration in milliseconds, or null when it is not known yet
 * @returns e.g. `820ms`, `4.2s`, `1m12s`, `2h03m`, or `-` for null
 */
export function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * How long a run took, from its two timestamps.
 *
 * @param startedAt an ISO instant
 * @param endedAt an ISO instant, or null while the run is going
 * @returns the elapsed milliseconds, or null when either end is unreadable
 */
export function elapsed(startedAt: string, endedAt: string | null): number | null {
  const start = Date.parse(startedAt);
  const end = endedAt === null ? Date.now() : Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
}

/**
 * Render rows as space-aligned columns, one line each.
 *
 * @param header the column titles
 * @param rows one array of cells per line; short rows are padded
 * @returns the lines, without a trailing newline
 */
export function table(header: string[], rows: string[][]): string[] {
  const all = [header, ...rows];
  const widths = header.map((_, col) => Math.max(...all.map((r) => (r[col] ?? "").length)));
  return all.map((row) =>
    row
      .map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

/**
 * Render label/value pairs with the labels aligned.
 *
 * @param pairs one `[label, value]` per line
 * @returns the lines, without a trailing newline
 */
export function fields(pairs: [string, string][]): string[] {
  const width = Math.max(0, ...pairs.map(([label]) => label.length));
  return pairs.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
}
