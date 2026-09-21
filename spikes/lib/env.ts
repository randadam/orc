import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENV_FILE = join(dirname(dirname(fileURLToPath(import.meta.url))), ".env");

/** Exit code a spike uses for "did not run", so `run-all.sh` can tell a skip from a failure. */
export const SKIP_EXIT = 2;

function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const value = line.slice(eq + 1).trim();
    const quoted = value.length > 1 && (value.startsWith('"') || value.startsWith("'"));
    out[line.slice(0, eq).trim()] = quoted ? value.slice(1, -1) : value;
  }
  return out;
}

let cached: Record<string, string> | undefined;

function dotenv(): Record<string, string> {
  if (cached) return cached;
  try {
    cached = parse(readFileSync(ENV_FILE, "utf8"));
  } catch {
    cached = {};
  }
  return cached;
}

/**
 * The Anthropic key for the model-backed spikes.
 *
 * The real environment wins over `spikes/.env`, and either name is accepted.
 * Returns undefined when no key is configured.
 */
export function anthropicKey(): string | undefined {
  const file = dotenv();
  return [
    process.env.ANTHROPIC_API_KEY,
    process.env.ANTHROPIC_KEY,
    file.ANTHROPIC_API_KEY,
    file.ANTHROPIC_KEY,
  ].find((v) => v !== undefined && v.length > 0);
}

/** Return the key, or print why this spike cannot run and exit `SKIP_EXIT`. */
export function requireKey(spike: string): string {
  const key = anthropicKey();
  if (key) return key;
  console.log(`SKIP ${spike}: no key.`);
  console.log(`  Put ANTHROPIC_KEY=sk-... in spikes/.env, or set ANTHROPIC_API_KEY in the environment.`);
  process.exit(SKIP_EXIT);
}
