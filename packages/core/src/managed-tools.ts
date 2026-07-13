import type { RuntimeDynamicToolSpec } from "./adapter.js";

/** One canonical schema shared by every engine transport. */
export const PONDEROSA_SEND_MESSAGE_TOOL: RuntimeDynamicToolSpec = {
  name: "ponderosa_send_message",
  description: "Send one explicitly scoped Ponderosa message. This is the only way ordinary runtime output reaches a user, another agent, or the organization.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["intent", "text"],
    properties: {
      intent: { type: "string", enum: ["broadcast", "direct_to_user", "collaboration"] },
      text: { type: "string", minLength: 1, maxLength: 4000 },
      recipientAgentIds: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
      idempotencyKey: { type: "string", maxLength: 200 },
      document: {
        type: "object",
        additionalProperties: false,
        required: ["title", "content"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 160 },
          content: { type: "string", minLength: 1 },
          mediaType: { type: "string", enum: ["text/markdown"] },
        },
      },
    },
  },
};
