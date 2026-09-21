import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The reason string, exported so `run.ts` can look for it in what the model was told. */
export const VETO_REASON = "blocked by spike: bash is not permitted in this run";

/** CLI extension that vetoes every bash call. The kill criterion rides on this hook. */
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName === "bash") return { block: true, reason: VETO_REASON };
  });
}
