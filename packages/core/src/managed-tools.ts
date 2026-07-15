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
      waitBehavior: {
        type: "string",
        enum: ["queue", "report", "interrupt"],
        description: "Collaboration only: queue without affecting an active wait, count as an expected report, or interrupt the wait for an urgent blocker.",
      },
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
      citations: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["url", "title"],
          properties: {
            url: { type: "string", minLength: 1, maxLength: 2048 },
            title: { type: "string", minLength: 1, maxLength: 240 },
          },
        },
      },
    },
    allOf: [{
      if: { properties: { intent: { const: "collaboration" } }, required: ["intent"] },
      then: { required: ["recipientAgentIds", "waitBehavior"] },
    }],
  },
};

export const PONDEROSA_SPAWN_AGENT_TOOL: RuntimeDynamicToolSpec = {
  name: "ponderosa_spawn_agent",
  description: "Create one tracked Ponderosa agent that reports directly to the calling agent. Model and effort are durable defaults for its turns; omitted values inherit the caller's current selection. Manager identity and conversation ownership are server-derived.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["displayName", "idempotencyKey"],
    properties: {
      displayName: { type: "string", minLength: 1, maxLength: 100 },
      initialMessage: { type: "string", maxLength: 65536 },
      runtime: { type: "string", minLength: 1 },
      model: { type: "string" },
      effort: { type: "string" },
      presetId: { type: "string" },
      idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
    },
  },
};

export const PONDEROSA_WAIT_FOR_REPORTS_TOOL: RuntimeDynamicToolSpec = {
  name: "ponderosa_wait_for_reports",
  description: "Park after requesting work. Matching collaboration reports are persisted without waking this agent until all, any, or a quorum of the expected stable agent IDs have replied. User messages and managed-agent failures wake immediately.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["mode", "expectedAgentIds"],
    properties: {
      mode: { type: "string", enum: ["all", "any", "quorum"] },
      expectedAgentIds: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
      quorum: { type: "integer", minimum: 1, maximum: 100 },
      deadline: { type: "string", description: "Optional future ISO-8601 timestamp that wakes the agent with the reports received so far." },
    },
  },
};
