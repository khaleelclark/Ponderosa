import type { RuntimeDynamicToolSpec } from "./adapter.js";

const REQUEST_LIFETIME_SCHEMA = {
  oneOf: [
    {
      type: "object", additionalProperties: false, required: ["kind", "at"],
      properties: { kind: { const: "deadline" }, at: { type: "string" } },
    },
    {
      type: "object", additionalProperties: false, required: ["kind"],
      properties: { kind: { const: "indefinite" } },
    },
  ],
} as const;

/** Communication V3 provider surface. Keep this to three tools: coordination
 * is asynchronous by default and an optional join is part of the same call. */
export const PONDEROSA_COORDINATE_TOOL: RuntimeDynamicToolSpec = {
  name: "ponderosa_coordinate",
  description: "Create one or more correlated work/consultation requests. You may keep working; include an optional join only when your next action depends on their outcomes.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["idempotencyKey", "requests"],
    properties: {
      idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
      requests: {
        type: "array", minItems: 1, maxItems: 100,
        items: {
          type: "object", additionalProperties: false,
          required: ["recipientAgentId", "text", "lifetime"],
          properties: {
            requestId: { type: "string", minLength: 1, maxLength: 200 },
            recipientAgentId: { type: "string", minLength: 1, maxLength: 200 },
            text: { type: "string", minLength: 1, maxLength: 4000 },
            lifetime: REQUEST_LIFETIME_SCHEMA,
          },
        },
      },
      join: {
        type: "object", additionalProperties: false, required: ["mode"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 200 },
          mode: { type: "string", enum: ["all", "any", "quorum"] },
          quorum: { type: "integer", minimum: 1, maximum: 100 },
          deadlineAt: { type: "string" },
          satisfyingOutcomes: {
            type: "array", minItems: 1, uniqueItems: true,
            items: { type: "string", enum: ["completed", "blocked", "failed", "cancelled", "superseded", "recipient_unavailable", "outcome_unknown", "expired"] },
          },
        },
      },
    },
  },
};

export const PONDEROSA_UPDATE_REQUEST_TOOL: RuntimeDynamicToolSpec = {
  name: "ponderosa_update_request",
  description: "Append one authorized, idempotent update to a correlated request. Questions are blocking and answers must reference the stable question update ID.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["requestId", "updateId", "kind"],
    properties: {
      requestId: { type: "string", minLength: 1, maxLength: 200 },
      updateId: { type: "string", minLength: 1, maxLength: 200 },
      kind: {
        type: "string",
        enum: ["progress", "waiting_dependency", "dependency_resolved", "question", "answer", "completed", "blocked", "failed", "cancelled", "superseded"],
      },
      text: { type: "string", maxLength: 4000 },
      inReplyToUpdateId: { type: "string", minLength: 1, maxLength: 200 },
    },
  },
};

export const PONDEROSA_MESSAGE_TOOL: RuntimeDynamicToolSpec = {
  name: "ponderosa_message",
  description: "Send an uncorrelated Ponderosa message. Use coordinate, not message, when work needs a tracked outcome.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["intent", "text", "idempotencyKey"],
    properties: {
      intent: { type: "string", enum: ["broadcast", "direct_to_user", "collaboration"] },
      text: { type: "string", minLength: 1, maxLength: 4000 },
      recipientAgentIds: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string" } },
      urgency: { type: "string", enum: ["ordinary", "urgent"] },
      idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
      document: {
        type: "object", additionalProperties: false, required: ["title", "content"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 160 },
          content: { type: "string", minLength: 1 },
          mediaType: { type: "string", enum: ["text/markdown"] },
        },
      },
      citations: {
        type: "array", maxItems: 10,
        items: {
          type: "object", additionalProperties: false, required: ["url", "title"],
          properties: {
            url: { type: "string", minLength: 1, maxLength: 2048 },
            title: { type: "string", minLength: 1, maxLength: 240 },
          },
        },
      },
    },
    allOf: [{
      if: { properties: { intent: { const: "collaboration" } }, required: ["intent"] },
      then: { required: ["recipientAgentIds"] },
    }],
  },
};

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
