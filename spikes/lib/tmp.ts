import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created: string[] = [];

/** A fresh temp directory, removed when `cleanupTmp` runs. */
export function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `orc-spike-${prefix}-`));
  created.push(dir);
  return dir;
}

export function cleanupTmp(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}
