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
  description: "Create correlated requests with {idempotencyKey, requests:[{recipientAgentId,text,lifetime}], optional join}; immutably join previously created owned requests with {idempotencyKey, requests:[], join:{mode,requestIds}}; or inspect overflow activation IDs. Each request text must be self-contained because recipients do not inherit your hidden prompt: include exact constraints, values, artifact paths, and requested output. Do not use recipient/objective/context fields. Every new request needs an explicit lifetime. A successful result containing joinId means the join already exists; do not call coordinate again for it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    oneOf: [
      { required: ["idempotencyKey", "requests"] },
      { required: ["inspectActivationIds"] },
    ],
    properties: {
      idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
      requests: {
        type: "array", minItems: 0, maxItems: 100,
        description: "New requests. Use an empty array only when join.requestIds names existing requests owned by you.",
        items: {
          type: "object", additionalProperties: false,
          required: ["recipientAgentId", "text", "lifetime"],
          properties: {
            requestId: { type: "string", minLength: 1, maxLength: 200 },
            recipientAgentId: { type: "string", minLength: 1, maxLength: 200, description: "Stable recipient agent ID." },
            text: { type: "string", minLength: 1, maxLength: 4000, description: "Complete bounded, self-contained request. Include exact constraints, values, artifact paths, and requested output; the recipient cannot see your hidden prompt. Do not split it into objective/context fields." },
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
          requestIds: {
            type: "array", minItems: 0, maxItems: 100, uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 200 },
            description: "Existing requests owned by you to include in this immutable join. Omit or use [] when joining requests created in the same call; at least one ID is required when requests is empty.",
          },
        },
      },
      inspectActivationIds: {
        type: "array", minItems: 1, maxItems: 20, uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 200 },
        description: "Retrieve complete durable payloads for activation references supplied in the current run.",
      },
    },
  },
};

export const PONDEROSA_UPDATE_REQUEST_TOOL: RuntimeDynamicToolSpec = {
  name: "ponderosa_update_request",
  description: "Append one authorized, idempotent update to a correlated request. A terminal update is the canonical final handoff: completed, blocked, or failed requires a self-contained text result and replaces a separate ordinary report/message. Omit requestId when the current run has exactly one attached correlated request; Ponderosa resolves it authoritatively. Supply the exact requestId only when the run contains multiple correlated requests. A recipient answers the request itself with completed (including when the request text is a consultation question). question means the recipient is asking the original requester for missing information. answer is only the original requester replying to that question and must reference the question updateId.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["updateId", "kind"],
    properties: {
      requestId: {
        type: "string", minLength: 1, maxLength: 200,
        description: "Optional when exactly one correlated request is attached to this run. Required, and matched exactly, when multiple requests are attached.",
      },
      updateId: { type: "string", minLength: 1, maxLength: 200 },
      kind: {
        type: "string",
        enum: ["progress", "waiting_dependency", "dependency_resolved", "question", "answer", "completed", "blocked", "failed", "cancelled", "superseded"],
        description: "Use completed for the recipient's result/reply. Use question only for a recipient's blocking follow-up; use answer only for the original requester's correlated response.",
      },
      text: { type: "string", maxLength: 4000 },
      inReplyToUpdateId: { type: "string", minLength: 1, maxLength: 200 },
    },
  },
};

export const PONDEROSA_MESSAGE_TOOL: RuntimeDynamicToolSpec = {
  name: "ponderosa_message",
  description: "Send an uncorrelated Ponderosa message with exactly {intent,text,idempotencyKey}. intent is exactly broadcast, direct_to_user, or collaboration; never use intent:user_dm or a direct_to_user boolean. collaboration additionally requires recipientAgentIds as an array, even for one recipient; never use singular recipientAgentId. Use coordinate, not message, when work needs a tracked outcome. After terminally updating a correlated request, an ordinary message to its requester is a passive audit copy; use urgency:urgent only for a material correction that truly requires action.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["intent", "text", "idempotencyKey"],
    properties: {
      intent: {
        type: "string", enum: ["broadcast", "direct_to_user", "collaboration"],
        description: "Exact routing enum. Use direct_to_user for a private user reply; user_dm is not a tool value.",
      },
      text: { type: "string", minLength: 1, maxLength: 4000 },
      recipientAgentIds: {
        type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string" },
        description: "Required for collaboration. Always an array, including one recipient.",
      },
      urgency: { type: "string", enum: ["ordinary", "urgent"] },
      idempotencyKey: { type: "string", minLength: 1, maxLength: 200, description: "Stable key for this logical message and its exact retries." },
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

/** Organization capability, deliberately distinct from provider-native/internal helpers. */
export const PONDEROSA_CREATE_MANAGED_AGENT_TOOL: RuntimeDynamicToolSpec = {
  name: "ponderosa_create_managed_agent",
  description: "Create one visible Ponderosa-managed Agent in the current Team Chat. This is the required capability when the user asks for Agents, workers, reviewers, or a visible team; never substitute a provider-native/internal helper. The Agent, its opening correlated Request, and (by default) an all-results Join are created together. Set awaitResult:false only when no Join is desired.",
  inputSchema: {
    type: "object", additionalProperties: false,
    required: ["idempotencyKey", "title", "engine", "text", "lifetime"],
    properties: {
      idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
      title: { type: "string", minLength: 2, maxLength: 60 },
      engine: { type: "string", enum: ["codex", "claude"] },
      model: { type: "string", maxLength: 200 },
      effort: { type: "string", maxLength: 40 },
      text: { type: "string", minLength: 1, maxLength: 4000, description: "Self-contained assignment and acceptance criteria." },
      lifetime: REQUEST_LIFETIME_SCHEMA,
      awaitResult: { type: "boolean", description: "Defaults true; creates a durable all-results Join owned by the manager." },
    },
  },
};

/** Engine-agnostic, host-owned browser tools. These are execution capabilities,
 * not Communication V3 tools, and are authorized only during their owning Run. */
export const PONDEROSA_BROWSER_TOOLS: RuntimeDynamicToolSpec[] = [
  {
    name: "ponderosa_browser_open",
    description: "Open or reuse the host-managed browser session owned by this exact run. Only http(s) URLs are accepted. Returns a bounded semantic page snapshot.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { url: { type: "string", minLength: 1, maxLength: 2048 } },
    },
  },
  {
    name: "ponderosa_browser_navigate",
    description: "Navigate the owned browser to an http(s) URL. Fails while the operator has control.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["url"],
      properties: { url: { type: "string", minLength: 1, maxLength: 2048 } },
    },
  },
  {
    name: "ponderosa_browser_inspect",
    description: "Inspect the owned browser's current URL, title, and a bounded semantic snapshot of visible controls and text.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "ponderosa_browser_act",
    description: "Operate the owned browser by CSS selector or key. Fails while the operator has control. Fill text is never copied into the activity summary.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["action"],
      properties: {
        action: { type: "string", enum: ["click", "fill", "key"] },
        selector: { type: "string", minLength: 1, maxLength: 500 },
        text: { type: "string", maxLength: 4000 },
        key: { type: "string", minLength: 1, maxLength: 40 },
      },
    },
  },
  {
    name: "ponderosa_browser_screenshot",
    description: "Capture the current browser viewport as a run-scoped PNG artifact. Live operator frames are not persisted unless this tool is called.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "ponderosa_browser_take_control",
    description: "Return browser input control to the agent. Control ownership is explicit so agent and operator input cannot race.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "ponderosa_browser_close",
    description: "Close the browser session owned by this run and delete its temporary browser profile.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
];
