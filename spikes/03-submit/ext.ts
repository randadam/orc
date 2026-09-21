import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** The schema `ask()` would be built on. Exported so `run.ts` validates against this exact object. */
export const submitSchema = Type.Object({
  summary: Type.String({ description: "One-paragraph assessment" }),
  risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
    description: "Overall risk",
  }),
  files: Type.Array(Type.String(), { description: "Paths the assessment concerns" }),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(
    defineTool({
      name: "submit_result",
      label: "Submit Result",
      description: "Return the final structured answer. Use this as your last action.",
      promptSnippet: "Finish by calling submit_result with the structured answer",
      parameters: submitSchema,
      async execute(_toolCallId, params) {
        return {
          content: [{ type: "text", text: `submitted: ${params.risk}` }],
          details: params,
          // The point of the spike: this is what should skip the follow-up LLM call.
          terminate: true,
        };
      },
    }),
  );
}
