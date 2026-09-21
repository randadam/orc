import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Project-local extension. Its command appearing in `get_commands` proves `.pi/` was trusted. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("orc-trust-marker", {
    description: "Present only when the project's .pi/ loaded",
    handler: async () => {},
  });
}
