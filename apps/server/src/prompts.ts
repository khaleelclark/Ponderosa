import type {
  AgentDto,
  ConversationMessageDto,
  MessageDto,
  TeamDirectoryDto,
} from "@ponderosa/core";
import {
  truncateUnicodeCodePoints,
  unicodeCodePointLength,
} from "@ponderosa/core";
import {
  messageContextPrompt,
  type InboundMessageContext,
} from "./agent-mentions.js";

const MAX_SEED_HISTORY_CHARS = 24_000;
const MAX_SEED_HISTORY_MESSAGES = 40;

/**
 * Runtime sessions retain their own context. This budget applies only when a
 * session boundary forces Ponderosa to seed again; canonical history remains on
 * disk and can still be queried explicitly.
 */
export function boundedSeedHistory<T extends { text: string }>(
  messages: T[],
  maxChars = MAX_SEED_HISTORY_CHARS,
  maxMessages = MAX_SEED_HISTORY_MESSAGES,
): T[] {
  const selected: T[] = [];
  let remaining = maxChars;
  for (let index = messages.length - 1; index >= 0 && selected.length < maxMessages && remaining > 0; index -= 1) {
    const message = messages[index]!;
    const messageLength = unicodeCodePointLength(message.text);
    if (messageLength <= remaining) {
      selected.push(message);
      remaining -= messageLength;
      continue;
    }
    const marker = "[Earlier content omitted at session boundary]\n";
    const markerLength = unicodeCodePointLength(marker);
    const clipped = remaining > markerLength
      ? `${marker}${[...message.text].slice(-(remaining - markerLength)).join("")}`
      : [...message.text].slice(-remaining).join("");
    selected.push({ ...message, text: clipped });
    remaining = 0;
  }
  return selected.reverse();
}

/**
 * Continued provider sessions consume new canonical room history in FIFO
 * pages. Unlike a seed (which intentionally selects the newest tail), a
 * continuation must never jump over an older unseen message merely to fit the
 * prompt budget. Canonical messages larger than the entire page are represented
 * by a bounded preview; their complete content remains available through the
 * older-context/artifact retrieval surface.
 */
export function boundedContinuationHistory<T extends { text: string }>(
  messages: T[],
  maxChars = MAX_SEED_HISTORY_CHARS,
  maxMessages = MAX_SEED_HISTORY_MESSAGES,
): T[] {
  const selected: T[] = [];
  let remaining = maxChars;
  for (const message of messages) {
    if (selected.length >= maxMessages || remaining <= 0) break;
    const messageLength = unicodeCodePointLength(message.text);
    if (messageLength <= remaining) {
      selected.push(message);
      remaining -= messageLength;
      continue;
    }
    if (selected.length > 0) break;
    const marker = "\n[Remaining content is available from the older-context reference]";
    const available = Math.max(0, remaining - unicodeCodePointLength(marker));
    selected.push({
      ...message,
      text: available > 0
        ? `${truncateUnicodeCodePoints(message.text, available)}${marker}`
        : truncateUnicodeCodePoints(message.text, remaining),
    });
    remaining = 0;
  }
  return selected;
}

function contextSection(
  name: string,
  priority: "AUTHORITATIVE" | "ACTION REQUIRED" | "RELEVANT BACKGROUND" | "ON-DEMAND REFERENCE",
  lines: string[],
): string {
  return [`[${name} | ${priority}]`, ...lines].join("\n");
}

/**
 * Bind every turn to one canonical agent/execution identity. Runtime sessions
 * may be resumed and display names may be reused, so neither provider memory
 * nor the visible-agent roster is allowed to answer "who am I?".
 */
export function runtimeIdentityPrompt(
  agent: Pick<AgentDto, "id" | "title" | "projectId">,
  executionId: string,
): string {
  return contextSection("IDENTITY · CURRENT RUN", "AUTHORITATIVE", [
    `- your agent id: ${agent.id}`,
    `- your display name: ${agent.title}`,
    `- your project id: ${agent.projectId}`,
    `- your execution id: ${executionId}`,
    `You are exactly ${agent.title} (${agent.id}). Never claim another visible agent's name or identity.`,
    "Visible-agent metadata describes possible recipients, not alternate identities for you.",
  ]);
}

function sharedRequestCompletionPrompt(): string {
  return contextSection("RESPONSE CONTRACT", "ACTION REQUIRED", [
    "Before this Run ends, call ponderosa_message({text: \"<final answer>\"}) exactly once with the completed result or material blocker.",
    "Ponderosa will publish this shared Project-chat reply as a Broadcast. Ordinary runtime output remains Work log only.",
  ]);
}

function directUserRequestCompletionPrompt(): string {
  return contextSection("RESPONSE CONTRACT", "ACTION REQUIRED", [
    "Before this Run ends, call ponderosa_message({text: \"<reply>\"}) exactly once with the answer, question, completed result, or material blocker.",
    "Ponderosa will keep this reply private to the user and this Agent. Ordinary runtime output remains Work log only.",
  ]);
}

function teamDirectoryPrompt(directory: TeamDirectoryDto): string {
  return contextSection("TEAM DIRECTORY", "ON-DEMAND REFERENCE", [
    `${directory.agents.length} visible Agent${directory.agents.length === 1 ? "" : "s"} are currently in scope.`,
    "Fetch current identities, reporting lines, and status only when needed with ponderosa_team_directory({}).",
  ]);
}

function olderContextPrompt(): string {
  return contextSection("OLDER SCOPED CONTEXT", "ON-DEMAND REFERENCE", [
    "Earlier messages in this Agent's current scoped history were omitted from the bounded provider input.",
    "Fetch them only if the current request needs that history with ponderosa_context({}).",
  ]);
}

function boundedHistoryOmitted<T extends { text: string }>(source: T[], selected: T[]): boolean {
  if (source.length !== selected.length) return true;
  return source.some((message, index) => message.text !== selected[index]?.text);
}

type ScopedContextMessage = MessageDto | ConversationMessageDto;

function mergeScopedContextSources(
  sources: Array<{ items: ScopedContextMessage[]; hasMore: boolean }>,
  limit: number,
): { newest: ScopedContextMessage[]; hasMore: boolean } {
  const deduped = new Map<string, ScopedContextMessage>();
  for (const source of sources) for (const message of source.items) {
    const key = message.communicationEventId ?? `${message.createdAt}\0${message.role}\0${message.text}`;
    const current = deduped.get(key);
    if (!current || message.id > current.id) deduped.set(key, message);
  }
  const ordered = [...deduped.values()].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  return {
    newest: ordered.slice(0, limit),
    hasMore: sources.some((source) => source.hasMore) || ordered.length > limit,
  };
}

// Reserve response-envelope room so the complete serialized tool page remains
// below 64 KiB, not merely the sum of message bodies.
const MAX_CONTEXT_PAGE_UTF8_BYTES = 60 * 1024;

function byteBoundScopedContext(
  newest: ScopedContextMessage[],
  maximumBytes = MAX_CONTEXT_PAGE_UTF8_BYTES,
): { messages: ScopedContextMessage[]; consumed: number; truncated: boolean } {
  const selected: ScopedContextMessage[] = [];
  let used = 0;
  for (const message of newest) {
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (used + bytes <= maximumBytes) {
      selected.push(message);
      used += bytes;
      continue;
    }
    if (selected.length > 0) break;
    const marker = "\n[Content clipped to keep this context page byte-bounded]";
    const shellBytes = Buffer.byteLength(JSON.stringify({ ...message, text: marker }), "utf8");
    const allowance = Math.max(0, maximumBytes - shellBytes);
    const source = Buffer.from(message.text, "utf8");
    let end = Math.min(source.length, allowance);
    while (end > 0) {
      try {
        const prefix = new TextDecoder("utf-8", { fatal: true }).decode(source.subarray(0, end));
        const clipped = { ...message, text: `${prefix}${marker}` };
        const serializedBytes = Buffer.byteLength(JSON.stringify(clipped), "utf8");
        if (serializedBytes <= maximumBytes) {
          selected.push(clipped);
          break;
        }
        end = Math.max(0, end - (serializedBytes - maximumBytes) - 1);
      } catch { end -= 1; }
    }
    if (selected.length === 0) selected.push({ ...message, text: marker.trim() });
    return { messages: selected, consumed: 1, truncated: true };
  }
  return { messages: selected, consumed: selected.length, truncated: selected.length < newest.length };
}

function sharedBroadcastContextPrompt(messages: ConversationMessageDto[], agents: AgentDto[]): string {
  const names = new Map(agents.map((agent) => [agent.id, agent.title]));
  return [
    "[SHARED PROJECT HISTORY | RELEVANT BACKGROUND]",
    ...(messages.length ? messages.map((message) => {
      const author = message.authorAgentId ? names.get(message.authorAgentId) ?? "Agent" : "User";
      return `${author}: ${message.text}`;
    }) : ["(No Broadcasts yet.)"]),
  ].join("\n");
}

function managerRelationshipPrompt(agent: Pick<AgentDto, "managerAgentId">): string[] {
  if (!agent.managerAgentId) {
    return ["[REPORTING RELATIONSHIP | AUTHORITATIVE]", "You are a top-level Agent. You report to the user and may publish intentional organizational Broadcasts."];
  }
  return [
    "[REPORTING RELATIONSHIP | AUTHORITATIVE]",
    `You are a managed agent. Your direct manager is the stable agent id ${agent.managerAgentId}.`,
    "That relationship defines accountability, escalation, creation, and lifecycle ownership; it does not restrict who you may contact.",
    "Send work directly to the agent or user who requested it, decisions to affected owners, and questions to whoever can answer them. Contact your manager when the manager owns the outcome or must resolve priority, scope, ownership, resource, or escalation questions.",
    "You may Direct Message the user when the user needs the answer, decision, question, or genuinely private update. Do not send routine acknowledgments or duplicate summaries to either the user or your manager.",
    "You may collaborate directly with any relevant agent in the project, including agents in other reporting branches. Do not Broadcast; top-level agents own organizational synthesis and publication.",
  ];
}

/**
 * Give a conversation agent the shared room context and a lightweight teammate
 * response contract. This is intentionally part of the next user prompt (rather
 * than engine-specific configuration) so new and resumed agents behave alike.
 */
function conversationPrompt(
  messages: ConversationMessageDto[],
  agents: AgentDto[],
  currentRequest: string,
  context: InboundMessageContext,
  replyScope: "broadcast" | "direct_to_user",
  currentMessageId?: string,
  incremental = false,
  routingMetadata?: string,
): string {
  const names = new Map(agents.map((agent) => [agent.id, agent.title]));
  const transcript = messages
    .map((message) => {
      const speaker = message.authorAgentId
        ? names.get(message.authorAgentId) ?? "Agent"
        : message.role === "user"
          ? "Manager"
          : "Team";
      const document = message.document ? ` [document: ${message.document.title}; id: ${message.document.id}]` : "";
      return `${speaker}: ${message.text}${document} [message id: ${message.id}]`;
    })
    .join("\n");

  const staticInstructions = incremental ? [] : [
    "[CONVERSATION CONTRACT | AUTHORITATIVE]",
    "You are handling a manager request that originated in Project chat.",
    replyScope === "broadcast"
      ? "The latest plain Project-chat request is shared work. The inferred reply publishes its completed answer to the Project."
      : "The latest request is a Direct Message. The inferred reply remains private.",
    "Agent-to-agent discussion belongs in Collaboration and requires explicit stable agent IDs.",
    "Send the new result once; do not recap the entire history or send an acknowledgment-only message.",
  ];
  return [
    ...staticInstructions,
    ...(routingMetadata ? [routingMetadata] : []),
    ...messageContextPrompt(context),
    "",
    incremental ? "[NEW PROJECT MESSAGES | RELEVANT BACKGROUND]" : "[PROJECT HISTORY | RELEVANT BACKGROUND]",
    transcript || (incremental ? "(No new room messages.)" : "(No earlier messages.)"),
    `Context injection accounting: room_messages=${messages.length}; room_characters=${messages.reduce((sum, message) => sum + unicodeCodePointLength(message.text), 0)}`,
    "",
    ...(currentMessageId ? [`Latest message id: ${currentMessageId}`] : []),
    "[CURRENT REQUEST | ACTION REQUIRED]",
    currentRequest,
  ].join("\n");
}

function individualChatPrompt(currentRequest: string, context: InboundMessageContext): string {
  return [
    "[CONVERSATION CONTRACT | AUTHORITATIVE]",
    "You are replying in your individual Ponderosa Agent chat.",
    ...messageContextPrompt(context),
    "",
    "[CURRENT REQUEST | ACTION REQUIRED]",
    currentRequest,
  ].join("\n");
}

/** Minimal turn prompt for a session that already received the full protocol. */
function continuationPrompt(currentRequest: string, context: InboundMessageContext): string {
  const channelRule = context.channel === "collaboration"
    ? "If this uncorrelated Collaboration turn needs a response, ponderosa_message({text}) replies to its sender. Use explicit recipients only when someone else must act."
    : context.channel === "main"
      ? "ponderosa_message({text}) inherits whether this Project-chat request is shared or private."
      : "ponderosa_message({text}) replies privately to the user when this activation has an unambiguous user origin.";
  return [
    ...messageContextPrompt(context),
    channelRule,
    "[CURRENT REQUEST | ACTION REQUIRED]",
    currentRequest,
  ].join("\n");
}

export {
  MAX_SEED_HISTORY_MESSAGES,
  boundedHistoryOmitted,
  byteBoundScopedContext,
  contextSection,
  continuationPrompt,
  conversationPrompt,
  directUserRequestCompletionPrompt,
  individualChatPrompt,
  managerRelationshipPrompt,
  mergeScopedContextSources,
  olderContextPrompt,
  sharedBroadcastContextPrompt,
  sharedRequestCompletionPrompt,
  teamDirectoryPrompt,
};
export type {
  ScopedContextMessage,
};
