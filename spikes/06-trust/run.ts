import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pi } from "../lib/rpc.ts";
import { report } from "../lib/finding.ts";
import { cleanupTmp, tmp } from "../lib/tmp.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MARKER = "orc-trust-marker";

/** A throwaway project whose `.pi/` holds settings and the marker extension. */
function project(): string {
  const dir = tmp("proj");
  mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), "{}\n");
  cpSync(join(here, "marker.ts"), join(dir, ".pi", "extensions", "marker.ts"));
  return dir;
}

/** A throwaway HOME, optionally carrying a global `defaultProjectTrust`. */
function home(defaultProjectTrust?: "ask" | "always" | "never"): string {
  const dir = tmp("home");
  if (defaultProjectTrust) {
    mkdirSync(join(dir, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "agent", "settings.json"),
      `${JSON.stringify({ defaultProjectTrust })}\n`,
    );
  }
  return dir;
}

/** Start Pi in a fresh project and report whether the project's `.pi/` extension loaded. */
async function markerLoads(label: string, opts: { home: string; extraArgs?: string[] }): Promise<boolean> {
  const pi = new Pi({
    home: opts.home,
    cwd: project(),
    args: [
      "--no-session",
      "--provider",
      "anthropic",
      "--model",
      "claude-haiku-4-5",
      ...(opts.extraArgs ?? []),
    ],
    timeoutMs: 60_000,
  });
  try {
    const res = await pi.call({ type: "get_commands" });
    const data = res.data as { commands?: Array<{ name: string }> } | undefined;
    const loaded = (data?.commands ?? []).some((c) => c.name === MARKER);
    console.log(`  ${label}: marker ${loaded ? "loaded" : "absent"}`);
    return loaded;
  } finally {
    await pi.close();
  }
}

const noHandler = await markerLoads("1 default, no handler ", { home: home() });
const handler = await markerLoads("2 project_trust handler", {
  home: home(),
  extraArgs: ["-e", join(here, "ext.ts")],
});
const setting = await markerLoads("3 defaultProjectTrust  ", { home: home("always") });
const approve = await markerLoads("4 --approve flag       ", { home: home(), extraArgs: ["--approve"] });
cleanupTmp();

const headlessDefault = noHandler ? "loads" : "declines-silently";
report({
  spike: "06-trust",
  pass: handler && setting,
  line:
    `TRUST: headless default = ${headlessDefault}; handler works: ${handler ? "y" : "n"}; ` +
    `defaultProjectTrust=always works: ${setting ? "y" : "n"}; --approve works: ${approve ? "y" : "n"}`,
  script: "spikes/06-trust/run.ts",
});
