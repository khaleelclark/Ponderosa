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

/** Communication V3 provider surface. Common delegation forms keep Request and
 * Join mechanics server-owned; advanced forms remain available for unusual
 * lifetimes, quorum conditions, and exact recovery. */
export const PONDEROSA_COORDINATE_TOOL: RuntimeDynamicToolSpec = {
  name: "ponderosa_coordinate",
  description: "Delegate common tracked work to one Agent with {recipientAgentId,text} or fan out atomically with {delegations:[...]}. Ponderosa supplies stable idempotency, indefinite lifetimes, and one all-results Join whose default wakePolicy each_result reactivates you as new results arrive while preserving the open parent workflow. For ordinary final-only fan-out, keep the common form and set completionMode:\"join\" with wakePolicy:\"final_only\". Use completionMode:\"record\" only for genuine fire-and-observe work; completionMode:\"callback\" preserves the legacy ungrouped per-result wake. Use the advanced requests/join form only for quorum/any conditions, custom per-request lifetimes, existing-request recovery, or custom satisfying outcomes. A returned joinId already exists; do not create it again.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    oneOf: [
      { required: ["recipientAgentId", "text"] },
      { required: ["delegations"] },
      { required: ["requests"] },
    ],
    properties: {
      idempotencyKey: { type: "string", minLength: 1, maxLength: 200, description: "Advanced override. The server derives a stable key for the common delegation form." },
      recipientAgentId: { type: "string", minLength: 1, maxLength: 200, description: "Common delegation recipient stable Agent ID." },
      text: { type: "string", minLength: 1, maxLength: 4000, description: "Common self-contained assignment, question, or consultation." },
      delegations: {
        type: "array", minItems: 1, maxItems: 100,
        description: "Common parallel fan-out. Every item becomes one Request in the same aggregate all-results Join.",
        items: {
          type: "object", additionalProperties: false, required: ["recipientAgentId", "text"],
          properties: {
            recipientAgentId: { type: "string", minLength: 1, maxLength: 200 },
            text: { type: "string", minLength: 1, maxLength: 4000 },
          },
        },
      },
      completionMode: {
        type: "string", enum: ["join", "callback", "record"],
        description: "Common delegation defaults join. join uses one aggregate Join; callback wakes once per unjoined result; record stores and displays results without an Agent wake.",
      },
      wakePolicy: {
        type: "string", enum: ["each_result", "final_only"],
        description: "For completionMode join, defaults each_result. each_result wakes on newly terminal members and again only as needed until the Join is terminal; final_only wakes only when the Join condition ends.",
      },
      awaitResult: { type: "boolean", description: "Legacy common-form alias: true means completionMode join; false means callback. Prefer completionMode." },
      deadlineAt: { type: "string", description: "Optional common-request deadline. Omit for an indefinite lifetime." },
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
          wakePolicy: { type: "string", enum: ["each_result", "final_only"], description: "Advanced Join delivery policy. Defaults final_only for backward compatibility." },
          requestIds: {
            type: "array", minItems: 0, maxItems: 100, uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 200 },
            description: "Existing requests owned by you to include in this immutable join. Omit or use [] when joining requests created in the same call; at least one ID is required when requests is empty.",
          },
        },
      },
    },
  },
};

/** Read-only retrieval for durable result references advertised to the current
 * Run. The byte budget is provider-visible so models can paginate deliberately
 * instead of discovering response-size limits through rejected calls. */
export const PONDEROSA_RESULT_TOOL: RuntimeDynamicToolSpec = {
  name: "ponderosa_result",
  description: "Retrieve durable result references that are reachable from the current authoritative Run. Use refs from fullResultRef or artifact references in this Run; references stay stable, while access is recomputed per Run. Results are ordered and paginated without creating Runs, Activations, Requests, Joins, messages, or artifacts.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["refs"],
    properties: {
      refs: {
        type: "array", minItems: 1, maxItems: 20, uniqueItems: true,
        items: { type: "string", pattern: "^ponderosa://(activation|artifact)/[^/]+$", maxLength: 260 },
        description: "One to twenty stable ponderosa://activation/<id> or ponderosa://artifact/<id> references, in desired return order.",
      },
      cursor: {
        type: "string", minLength: 1, maxLength: 4096,
        description: "Opaque continuation cursor returned by the preceding call. Reuse it with the exact same refs and maxBytes.",
      },
      maxBytes: {
        type: "integer", minimum: 4096, maximum: 262144,
        description: "Overall raw-content byte budget for this page. Defaults to 65536 bytes; valid range is 4096 through 262144.",
      },
    },
  },
};

export const PONDEROSA_TEAM_DIRECTORY_TOOL: RuntimeDynamicToolSpec = {
  name: "ponderosa_team_directory",
  description: "Retrieve the current run-scoped Team Chat directory through Ponderosa. Use this instead of localhost HTTP, browser access, or reading Ponderosa storage directly. Omit agentId for the visible roster; provide one stable ID for a focused entry.",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: { agentId: { type: "string", minLength: 1, maxLength: 200 } },
  },
};

export const PONDEROSA_CONTEXT_TOOL: RuntimeDynamicToolSpec = {
  name: "ponderosa_context",
  description: "Retrieve older scoped history only when the current Run contains an OLDER SCOPED CONTEXT reference. This run-fenced tool returns canonical messages without relying on shell access to localhost.",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: {
      before: { type: "string", description: "Optional ISO timestamp cursor from a previous response." },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Defaults 20." },
    },
  },
};

export const PONDEROSA_UPDATE_REQUEST_TOOL: RuntimeDynamicToolSpec = {
  name: "ponderosa_update_request",
  description: "Report the canonical result of the current correlated Request with {text}, or ask its requester a blocking follow-up with {question}. Ponderosa resolves the sole attached Request, generates stable idempotency, and defaults text to completed. Add kind only for progress, waiting, blocked/failed, answer, cancellation, or supersession. Supply requestId only when the Run has multiple attached Requests or when mutating an exact authorized historical outbound Request.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    anyOf: [{ required: ["text"] }, { required: ["question"] }, { required: ["kind"] }],
    properties: {
      requestId: {
        type: "string", minLength: 1, maxLength: 200,
        description: "Optional when exactly one correlated request is attached to this run. Required, and matched exactly, when multiple requests are attached.",
      },
      updateId: { type: "string", minLength: 1, maxLength: 200, description: "Advanced override. The server derives a stable update ID for the common report form." },
      kind: {
        type: "string",
        enum: ["progress", "waiting_dependency", "dependency_resolved", "question", "answer", "completed", "blocked", "failed", "cancelled", "superseded"],
        description: "Use completed for the recipient's result/reply. Use question only for a recipient's blocking follow-up; use answer only for the original requester's correlated response.",
      },
      text: { type: "string", maxLength: 4000 },
      question: { type: "string", minLength: 1, maxLength: 4000, description: "Common blocking follow-up to the original requester; maps to a correlated question update." },
      inReplyToUpdateId: { type: "string", minLength: 1, maxLength: 200, description: "Required for kind answer. Copy the exact inReplyToUpdateId from the coordination_question Activation." },
    },
  },
};

export const PONDEROSA_MESSAGE_TOOL: RuntimeDynamicToolSpec = {
  name: "ponderosa_message",
  description: "Reply to the current uncorrelated activation with {text}. Ponderosa inherits the audience, conversation, visibility, and stable idempotency when there is one unambiguous reply target. Use explicit intent only to publish a separate organizational Broadcast, contact different Agents, or resolve an ambiguous/non-message activation. Use coordinate for tracked work and update_request for a correlated result.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      intent: {
        type: "string", enum: ["broadcast", "direct_to_user", "collaboration"],
        description: "Exact routing enum. Use direct_to_user for a private user reply; user_dm is not a tool value.",
      },
      text: { type: "string", minLength: 1, maxLength: 4000 },
      steeringInjectionId: {
        type: "string", minLength: 1,
        description: "When the current Run has received steering, copy the exact steeringInjectionId from the newest Ponderosa activation prompt. Ponderosa rejects output fenced behind an acknowledged steer.",
      },
      recipientAgentIds: {
        type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string" },
        description: "Required for collaboration. Always an array, including one recipient.",
      },
      urgency: { type: "string", enum: ["ordinary", "urgent"] },
      idempotencyKey: { type: "string", minLength: 1, maxLength: 200, description: "Advanced override. The server derives a stable key for an inferred reply." },
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

/** First-order operator Decision. It pauses only the Agent's next dependent
 * action; it does not pretend the host sandbox structurally forbids the work. */
export const PONDEROSA_DECISION_TOOL: RuntimeDynamicToolSpec = {
  name: "ponderosa_decision",
  description: "Ask the user one durable question with {question}. Ponderosa derives stable idempotency and defaults to an open text answer; providing options defaults to choice. Use mode:approval for permission. Every approval/choice includes a Something else path. Set blocking false when safe independent work remains. Structural deletion, re-parenting, or promotion must use a Decision first.",
  inputSchema: {
    type: "object", additionalProperties: false,
    required: ["question"],
    properties: {
      idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
      mode: { type: "string", enum: ["approval", "choice", "text"] },
      question: { type: "string", minLength: 1, maxLength: 1000 },
      context: { type: "string", maxLength: 4000 },
      options: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", additionalProperties: false, required: ["id", "label"], properties: { id: { type: "string", minLength: 1, maxLength: 80 }, label: { type: "string", minLength: 1, maxLength: 120 }, description: { type: "string", maxLength: 400 } } } },
      allowOther: { type: "boolean", description: "Defaults true and cannot be disabled for approval or choice." },
      blocking: { type: "boolean", description: "Defaults true." },
    },
  },
};

export const PONDEROSA_MANAGE_TOOL: RuntimeDynamicToolSpec = {
  name: "ponderosa_manage",
  description: "Safely inspect or manage your visible Ponderosa descendant organization. Call describe to discover scope, plan with a complete operation list, then apply the returned planId. Creating/renaming Agents and stopping descendants may be autonomous. delete_agent and set_manager require a resolved approval Decision ID. Plans are exact, scoped to this Run, idempotent, and audited; this never manages provider-native helpers or arbitrary Projects.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["action"],
    properties: {
      action: { type: "string", enum: ["describe", "plan", "apply"] },
      idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
      planId: { type: "string", minLength: 1, maxLength: 200 },
      operations: { type: "array", minItems: 1, maxItems: 100, items: {
        type: "object", additionalProperties: false, required: ["kind"],
        properties: {
          kind: { type: "string", enum: ["create_agent", "rename_agent", "stop_agent", "delete_agent", "set_manager"] },
          ref: { type: "string", maxLength: 100 },
          targetAgentId: { type: "string", maxLength: 200 },
          parentRef: { type: "string", maxLength: 200 },
          managerAgentId: { type: ["string", "null"] },
          title: { type: "string", maxLength: 80 },
          engine: { type: "string" },
          model: { type: "string" },
          effort: { type: "string" },
          instructions: { type: "string", maxLength: 4000 },
          decisionId: { type: "string", maxLength: 200 },
        },
      } },
    },
  },
};

/** Engine-agnostic, host-owned browser tools. These are execution capabilities,
 * not Communication V3 tools, and are authorized only during their owning Run.
 * An operator may explicitly route them to the Project browser for that Run. */
export const PONDEROSA_BROWSER_TOOLS: RuntimeDynamicToolSpec[] = [
  {
    name: "ponderosa_browser_open",
    description: "Open or reuse the browser authorized for this exact run. This is normally a private run browser; an operator may instead lend the persistent Project browser. Only http(s) URLs are accepted. Returns a bounded semantic page snapshot.",
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
    description: "Close the private browser owned by this run. When the operator lent the persistent Project browser, return control to the operator without closing it.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
];
