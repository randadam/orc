import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** CLI extension that owns the trust decision, so no prompt is ever reached. */
export default function (pi: ExtensionAPI) {
  pi.on("project_trust", async () => ({ trusted: "yes" as const, remember: false }));
}
