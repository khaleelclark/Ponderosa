import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";
import { constants as fsConstants, existsSync, promises as fs } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type {
  Adapter,
  ApiPriceProfile,
  AgentSpawnRequest,
  AgentWaitRequest,
  AgentWaitResponse,
  AgentMessageChannel,
  AgentEvent,
  CommunicationEvent,
  AgentHealthProjectionDto,
  ArtifactContentDto,
  ChatMessage,
  EngineAuthStatus,
  EngineDto,
  ProjectEngineCapabilitiesDto,
  ProjectFolderOptionsDto,
  WorkspaceChangeDto,
  WorkspaceFileReviewDto,
  WorkspaceStatusDto,
  CreateProjectRequest,
  UpdateProjectRequest,
  FilesResponse,
  HealthDto,
  ReadinessDto,
  ConversationMessageDto,
  ConversationDetailDto,
  CollaborationViewDto,
  AssetDto,
  ImageAttachmentDto,
  CreateDirectReplyRequest,
  CreateMultiAgentDirectMessageRequest,
  CreateUserReactionRequest,
  CreateUserReactionResponse,
  DirectReplyResponse,
  MultiAgentDirectMessageResponse,
  SseEventEnvelope,
  AgentStreamEvent,
  SendAgentMessageRequest,
  AgentDto,
  MessageReferenceDto,
  RuntimeSession,
  UpdateAgentOrganizationRequest,
  TeamDirectoryDto,
  TokenUsage,
  TokenUsageSummaryDto,
} from "@ponderosa/core";
import { deriveCommunicationBehavior, PONDEROSA_SEND_MESSAGE_TOOL, PONDEROSA_SPAWN_AGENT_TOOL, PONDEROSA_WAIT_FOR_REPORTS_TOOL } from "@ponderosa/core";
import { artifactContentPath, attachmentPath, attachmentsDir, type LogEvent, type ConversationDeliveryIntent, type StoredLogEvent, AgentStore } from "@ponderosa/agents";
import { shouldRolloverEngineSession } from "@ponderosa/engines";
import { ASSET_LIMITS, AssetError, AssetStore, contentDisposition } from "./assets.js";
import { ContextCursorStore } from "./context-cursors.js";
import { EngineAuthStatusCache } from "./engine-auth-cache.js";
import { projectAgentHealth, type ActiveRunObservation } from "./agent-health.js";
import { RunLedger, type RunFence, type RuntimeOwnershipState } from "./run-ledger.js";
import {
  CollaborationDeliveryStore,
  type CollaborationDelivery,
  type CollaborationDeliveryBatch,
} from "./handoffs.js";
import { UserReactionStore } from "./user-reactions.js";
import { AgentWaitStore, type AgentWaitCondition } from "./agent-waits.js";

export interface EngineRegistration {
  adapter: Adapter;
  authStatus?: () => Promise<EngineAuthStatus>;
}

export interface CreateServerOptions {
  dataDir: string;
  store?: AgentStore;
  engines: EngineRegistration[];
  webDist?: string;
  authToken?: string;
  /** Immutable source revision for deploy/runtime parity checks. */
  buildRevision?: string;
  /** Host-local origin injected into runtime tools; agents run on this server host. */
  agentBaseUrl?: string;
  logger?: boolean;
  /** Deterministic scheduling seams for retry tests; production uses host timers and randomness. */
  deliveryScheduling?: {
    now?: () => number;
    random?: () => number;
    setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    /** Test-only internal claim response override. */
    claimStatus?: () => number | undefined;
  };
  /** Deterministic execution-lease supervision seams; production uses one host timer per active run. */
  executionLeaseScheduling?: {
    leaseMs?: number;
    /** Persistent runtimes prove process liveness at this cadence. */
    heartbeatMs?: number;
    now?: () => number;
    setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    clearTimer?: (timer: NodeJS.Timeout) => void;
  };
  /** Bound persistent runtime resources after a turn becomes idle. */
  runtimeSessionScheduling?: {
    idleTtlMs?: number;
    /** Maximum number of completed runtimes kept warm across all agents. */
    maxIdleSessions?: number;
    now?: () => number;
    setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    clearTimer?: (timer: NodeJS.Timeout) => void;
  };
  /** Deterministic same-process event-consumer fault seam; never enabled in production configuration. */
  runtimeEventFaults?: {
    beforePersist?: (context: { agentId: string; runId: string; generation: number; event: AgentEvent }) => void | Promise<void>;
    stallAfterMs?: number;
    onOwnershipState?: (context: { agentId: string; runId: string; generation: number; state: RuntimeOwnershipState }) => void;
  };
  /** Deterministic message-claim race seam; never enabled in production configuration. */
  messageLifecycleFaults?: {
    beforeRunClaim?: (context: { agentId: string; runId: string }) => void | Promise<void>;
    afterRunClaim?: (context: { agentId: string; runId: string; generation: number }) => void | Promise<void>;
  };
}

interface ActiveRun {
  runId: string;
  startedAt: string;
  executionId: string;
  leaseExpiresAt: string;
  controller: AbortController;
  messageCapability: string;
  deliveryIds?: string[];
  leaseTimer?: NodeJS.Timeout;
  livenessTimer?: NodeJS.Timeout;
  generation: number;
  ownershipState: RuntimeOwnershipState;
  lastEventReceivedAt?: string;
  lastEventPersistedAt?: string;
  runtimeSession?: RuntimeSession;
}

interface PersistentRuntime {
  session: RuntimeSession;
  iterator: AsyncIterator<AgentEvent>;
  /** Stable secrets injected once into the persistent engine process. */
  messageCapability: string;
  /** Set only while the runtime is eligible for warm-pool eviction. */
  idleSince?: number;
  idleTimer?: NodeJS.Timeout;
}

export const COLLABORATION_DISPATCH_LIMITS = {
  maxBatchDeliveries: 20,
  maxBatchUtf8Bytes: 224 * 1024,
  maxDispatchAttempts: 5,
  baseRetryMs: 250,
  maxRetryMs: 30_000,
  jitterRatio: 0.2,
} as const;

/**
 * Collaboration room projections are a display timeline, not an authorization
 * boundary. Runtime context must be selected from the canonical audience:
 * stable-ID collaboration recipients see their deliveries, while organization
 * broadcasts are deliberately shared project context. Missing/unrecognized
 * canonical events fail closed instead of falling back to rendered mentions.
 */
function canonicalAudienceIncludes(
  event: CommunicationEvent | undefined,
  projectId: string,
  recipientAgentId: string,
): boolean {
  if (!event) return false;
  const behavior = deriveCommunicationBehavior(event);
  return (behavior.contextPolicy === "organizational" && event.projectId === projectId) ||
    behavior.deliveryRecipients.some((recipient) => recipient.kind === "agent" && recipient.agentId === recipientAgentId);
}

function recipientCollaborationMessages(
  messages: ConversationMessageDto[],
  events: CommunicationEvent[],
  projectId: string,
  recipientAgentId: string,
): ConversationMessageDto[] {
  const eventsById = new Map(events.map((event) => [event.eventId, event]));
  return messages.filter((message) => {
    if (!message.communicationEventId) return false;
    return canonicalAudienceIncludes(eventsById.get(message.communicationEventId), projectId, recipientAgentId);
  });
}

/**
 * Future room context contains only canonical organizational communication.
 * Rendered tags are display affordances and never narrow or widen context.
 */
function organizationalMasterMessages(
  messages: ConversationMessageDto[],
  events: CommunicationEvent[],
  projectId: string,
  _recipientAgentId: string,
  _agents: AgentDto[],
): ConversationMessageDto[] {
  const eventsById = new Map(events.map((event) => [event.eventId, event]));
  return messages.filter((message) => {
    if (!message.communicationEventId) return false;
    const event = eventsById.get(message.communicationEventId);
    if (!event || event.projectId !== projectId) return false;
    return deriveCommunicationBehavior(event).contextPolicy === "organizational";
  });
}

/** A deferred user or agent turn.  Queues are per-agent and FIFO. */
interface PendingTurn {
  text: string;
  communicationEventId?: string;
  model?: string;
  effort?: string;
  agentMentionDepth: number;
  agentMentionTrail: string[];
  collaborationConversationId?: string;
  sourceChannel?: "main";
  sourceConversationId?: string;
  sourceAuthorAgentId?: string;
  /** Set only by the server's persisted collaboration delivery dispatcher. */
  collaborationDeliveryId?: string;
  /** Fixed snapshot; deliveries queued after dispatch begins are excluded. */
  collaborationDeliveryIds?: string[];
  replyTo?: MessageReferenceDto;
  replyToMessageId?: string;
  attachmentIds?: string[];
}

interface AgentMessageCapability {
  agentId: string;
  conversationId?: string;
  runId: string;
  mentionDepth: number;
  mentionTrail: string[];
  /** Completed Broadcasts answering a plain shared Master request render as ordinary chat prose. */
  plainSharedReply?: boolean;
}

interface InboundMessageContext {
  channel: AgentMessageChannel;
  author: string;
  mentionedAgents: string[];
  addressedToCurrentAgent: boolean;
}

type Subscriber = (stored: StoredLogEvent) => void;

// Keep only a bounded replay-detection window. This is deliberately not a total
// collaboration-hop limit: a healthy organization may have a long-running
// exchange, while exact repeated handoffs still need cycle protection.
const MAX_AGENT_MENTION_REPLAY_WINDOW = 64;
const MAX_TEXT_LENGTH = 64 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SSE_SUBSCRIBERS_PER_STREAM = 20;
const MAX_ATTACHMENTS_PER_MESSAGE = 4;

function secretEqual(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false;
  const actual = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function isAgentStreamEvent(event: StoredLogEvent["event"]): event is AgentStreamEvent {
  return event.type !== "user_message";
}

function agentMentionHandle(title: string): string {
  return title
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "");
}

function mentionRelayFingerprint(authorAgentId: string, targetAgentId: string, text: string): string {
  return createHash("sha256")
    .update(authorAgentId)
    .update("\0")
    .update(targetAgentId)
    .update("\0")
    .update(text.trim().replace(/\s+/g, " ").toLocaleLowerCase())
    .digest("hex");
}

function advanceMentionTrail(mentionTrail: string[], messageFingerprint: string): string[] {
  return [...mentionTrail, messageFingerprint].slice(-MAX_AGENT_MENTION_REPLAY_WINDOW);
}

function mergeMentionTrails(deliveries: CollaborationDelivery[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const delivery of deliveries) {
    for (const fingerprint of delivery.mentionTrail) {
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      merged.push(fingerprint);
    }
  }
  return merged;
}

function mentionedAgents(text: string, agents: AgentDto[], authorAgentId: string): AgentDto[] {
  const byHandle = new Map(
    agents.map((agent) => [agentMentionHandle(agent.title).toLocaleLowerCase(), agent]),
  );
  const mentioned = new Map<string, AgentDto>();
  for (const match of text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)) {
    const handle = match[1]!.toLocaleLowerCase();
    if (handle === "broadcast" || handle === "user" || handle === "everyone") continue;
    const agent = byHandle.get(handle);
    if (agent && agent.id !== authorAgentId) mentioned.set(agent.id, agent);
  }
  return [...mentioned.values()];
}

function hasEveryoneMention(text: string): boolean {
  return /(?:^|\s)#everyone(?=$|\s|[.,!?;:])/iu.test(text);
}

function stripLeadingScopeTag(text: string, tag: "broadcast" | "user"): string {
  return text.replace(new RegExp(`^#${tag}(?=$|\\s)\\s*`, "iu"), "").trim();
}

function renderScopedMessage(tag: "broadcast" | "user", text: string): string {
  return `#${tag} ${stripLeadingScopeTag(text, tag)}`.trimEnd();
}

function isSingleEmoji(input: string): boolean {
  const value = input.trim();
  if (!value) return false;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
  return graphemes.length === 1 && /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3)/u.test(value);
}

function inboundContext(
  channel: AgentMessageChannel,
  author: string,
  text: string,
  agents: AgentDto[],
  currentAgentId: string,
): InboundMessageContext {
  const mentioned = mentionedAgents(text, agents, "");
  return {
    channel,
    author,
    mentionedAgents: mentioned.map((agent) => `#${agentMentionHandle(agent.title)}`),
    addressedToCurrentAgent: mentioned.some((agent) => agent.id === currentAgentId),
  };
}

function messageContextPrompt(context: InboundMessageContext): string[] {
  return [
    "Incoming message metadata:",
    `- channel: ${context.channel}`,
    `- author: ${context.author}`,
    `- tagged agents: ${context.mentionedAgents.join(", ") || "none"}`,
    `- you were tagged: ${context.addressedToCurrentAgent ? "yes" : "no"}`,
    "Use this metadata to distinguish a direct request from a message aimed at someone else.",
  ];
}

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
    if (message.text.length <= remaining) {
      selected.push(message);
      remaining -= message.text.length;
      continue;
    }
    const marker = "[Earlier content omitted at session boundary]\n";
    const clipped = remaining > marker.length
      ? `${marker}${message.text.slice(-(remaining - marker.length))}`
      : message.text.slice(-remaining);
    selected.push({ ...message, text: clipped });
    remaining = 0;
  }
  return selected.reverse();
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
  return [
    "Canonical Ponderosa runtime identity (authoritative for this turn):",
    `- your agent id: ${agent.id}`,
    `- your display name: ${agent.title}`,
    `- your project id: ${agent.projectId}`,
    `- your execution id: ${executionId}`,
    `You are exactly ${agent.title} (${agent.id}). Never claim another visible agent's name or identity.`,
    "Visible-agent metadata describes possible recipients, not alternate identities for you.",
  ].join("\n");
}

function agentMessagingPrompt(): string[] {
  return [
    "Communication scope is immutable. Choose the scope when creating a message; never try to promote or re-scope an existing message.",
    "Your ordinary runtime response is execution-scoped output saved in your Work log tab. It is never delivered to the manager, agents, or organization.",
    "If anyone should receive information, explicitly call the Ponderosa send-message tool with exactly one intent: direct_to_user, collaboration, or broadcast.",
    "The tool is named ponderosa_send_message in Codex and mcp__ponderosa__send_message in Claude.",
    'Example arguments: {"intent":"collaboration","recipientAgentIds":["stable-agent-id"],"text":"Please review this","idempotencyKey":"stable-retry-key"}.',
    'Set intent to "broadcast", "direct_to_user", or "collaboration". The server owns routing and renders #broadcast, #user, and recipient #tags; never write routing tags into message text.',
    'For a long-form result, keep text as a concise summary and add document: {"title":"Useful title","content":"# Full Markdown...","mediaType":"text/markdown"}. Documents may be up to 256 KiB; do not truncate them into the 4,000-character summary.',
    'A document inherits the message intent exactly. Broadcast documents are organizational; direct_to_user and collaboration documents remain private to that audience.',
    'When context contains a document id, retrieve the full Markdown only when needed with: curl -sS "$PONDEROSA_DOCUMENT_URL/<document-id>" -H "Authorization: Bearer $PONDEROSA_AGENT_MESSAGE_TOKEN"',
    "Agents cannot create reactions. A user emoji reaction arrives as a private notification with immutable reply context identifying the message they reacted to.",
    "Collaboration requires a non-empty recipientAgentIds array containing stable IDs from the visible-agent metadata.",
    'Discover current teammates with GET "$PONDEROSA_AGENT_DIRECTORY_URL" or one stable identity with GET "$PONDEROSA_AGENT_DIRECTORY_URL/<agent-id>" using the same Bearer token.',
    "The organization graph describes accountability and lifecycle ownership, not permitted communication paths.",
    "Contact the smallest set of agents who need to act on the information. You may collaborate directly across reporting branches when another agent owns the affected work, has the needed expertise, requested the work, or will consume the result.",
    "Reply directly to the agent who requested work. Send decisions to affected owners, deliverables to their consumers, and blockers to whoever can resolve them. Escalate to a manager only for priority conflicts, scope or ownership decisions, unresolved disagreements, resource needs, or outcomes that manager owns.",
    "Managers are decision owners and synthesizers, not message relays. Do not send them routine peer coordination merely because they are above you in the organization.",
    "Every Collaboration message must carry an actionable request, decision, handoff, evidence, blocker, or completion result. Do not send acknowledgments, greetings, thanks, duplicate updates, speculative status chatter, or FYI-only messages that wake an agent without requiring action.",
    "If you are a top-level agent, Broadcast completed answers and task results from a shared Conversation request, plus other durable organizational knowledge such as decisions, verified findings, outcomes, or material blockers.",
    "Never Broadcast acknowledgments, questions, thanks, routine progress, promises to act, or duplicate confirmations.",
    "Use Collaboration for agent-to-agent coordination. Use direct_to_user only for a question or private update the user themselves needs, never as an automatic completion receipt. If a private finding later matters organizationally, create a new Broadcast summary; the private source remains unchanged.",
    "A valid collaboration intent is persisted and queued as a separate follow-up turn when the recipient is active; it is never injected into an in-flight response.",
    "After asking another agent to work, register a durable wait when your next action depends on one or more reports, then end your turn. Do not poll, sleep, or remain active. Agents run independently and return results through Collaboration.",
    "The wait tool is ponderosa_wait_for_reports in Codex and mcp__ponderosa__wait_for_reports in Claude. Supply stable expectedAgentIds and mode all, any, or quorum. Matching reports persist without waking you until the condition is satisfied; a user message or managed-agent failure wakes you immediately.",
    "Registering a wait is execution control, not a communication event. Do not Direct Message or Broadcast merely to announce that you registered a wait or are waiting.",
    "Never include your own stable agent ID in Collaboration recipients. After a wait completes, deliver the synthesis to the original requester or accountable consumer; keep an internal-only note in Work log.",
    "Each collaboration intent is a separate FIFO delivery (not coalesced). If one arrives while you are active, it waits for a safe turn boundary. If that active turn is cancelled, queued deliveries remain queued; a cancelled delivery turn itself is retried.",
    "Your direct reports are ordinary agents with their own chat, activity, files, and execution audit. Coordinate with them and any other relevant agent using stable IDs from the directory.",
    "Accumulate results across notification turns and deliver one integrated result to the requester or accountable outcome owner once the expected work has reported.",
    'If your runtime context is becoming unwieldy, request a fresh session after this turn with: curl -sS -X POST "$PONDEROSA_AGENT_ROLLOVER_URL" -H "Authorization: Bearer $PONDEROSA_AGENT_MESSAGE_TOKEN"',
  ];
}

function runtimeSelectionError(adapter: Adapter, model?: string, effort?: string): string | undefined {
  const selectedModel = model?.trim() || undefined;
  const selectedEffort = effort?.trim() || undefined;
  const models = adapter.listModels();
  const concreteModels = models.filter((option) => option.id);
  const matchedModel = selectedModel ? concreteModels.find((option) => option.id === selectedModel) : undefined;
  // A missing/unreadable provider cache is unknown availability, not evidence
  // that an already-configured model disappeared.
  if (selectedModel && concreteModels.length > 0 && !matchedModel) return "model is not available for engine";
  const knownEfforts = selectedModel
    ? matchedModel?.efforts ?? (adapter.modelSpecificEfforts ? undefined : adapter.listEfforts(selectedModel))
    : adapter.listEfforts();
  if (selectedEffort && knownEfforts && !knownEfforts.some((option) => option.id === selectedEffort)) {
    return selectedModel ? "effort is not available for model" : "effort is not available for engine";
  }
}

function normalizedRuntimeSelection(adapter: Adapter, model?: string, effort?: string): { model?: string; effort?: string } {
  const selectedModel = model?.trim() || undefined;
  const selectedEffort = effort?.trim() || undefined;
  const modelIsStale = selectedModel && runtimeSelectionError(adapter, selectedModel, undefined)?.startsWith("model ");
  const normalizedModel = modelIsStale ? undefined : selectedModel;
  const effortIsStale = selectedEffort && runtimeSelectionError(adapter, normalizedModel, selectedEffort)?.startsWith("effort ");
  return {
    ...(normalizedModel ? { model: normalizedModel } : {}),
    ...(selectedEffort && !effortIsStale ? { effort: selectedEffort } : {}),
  };
}

function sharedRequestCompletionPrompt(): string {
  return [
    "Required completion contract for this Project-chat request:",
    "- Before this run ends, send exactly one broadcast containing the final answer, completed result, or material blocker for the user.",
    "- The user cannot see your ordinary runtime response; it is audit-only Work log output.",
    "- Do not finish with only ordinary response text. Do not broadcast an acknowledgment or promise to act.",
    "- Use this exact completion action, replacing <final answer> with your concise result:",
    '  Call the Ponderosa send-message tool with {"intent":"broadcast","text":"<final answer>"}.',
  ].join("\n");
}

function directUserRequestCompletionPrompt(): string {
  return [
    "Required completion contract for this private user-to-agent request:",
    "- Before this run ends, send exactly one direct_to_user message containing the answer, completed result, question, or material blocker for the user.",
    "- Do not Broadcast this private reply. Broadcast is only for a separate durable organizational update you intentionally choose to make.",
    "- The user cannot see your ordinary runtime response; it is audit-only Work log output.",
    "- Call the Ponderosa send-message tool with {\"intent\":\"direct_to_user\",\"text\":\"<reply>\"}.",
  ].join("\n");
}

function teamDirectoryPrompt(directory: TeamDirectoryDto): string {
  return [
    "Current Team Directory (structured stable identities; use agentId for routing):",
    ...directory.agents.map((agent) => JSON.stringify(agent)),
  ].join("\n");
}

function sharedBroadcastContextPrompt(messages: ConversationMessageDto[], agents: AgentDto[]): string {
  const names = new Map(agents.map((agent) => [agent.id, agent.title]));
  return [
    "Shared Broadcast context from Project chat (organizational knowledge; supplied independently of private chat):",
    ...(messages.length ? messages.map((message) => {
      const author = message.authorAgentId ? names.get(message.authorAgentId) ?? "Agent" : "User";
      return `${author}: ${message.text}`;
    }) : ["(No Broadcasts yet.)"]),
  ].join("\n");
}

function agentSpawnPrompt(): string[] {
  return [
    "When creating another agent under Ponderosa, never use an engine's internal spawn_agent, Task, or subagent mechanism; those agents are untracked and forbidden.",
    "Use only Ponderosa's managed-agent creation bridge. The new agent is a normal agent that reports directly to you:",
    "The tool is named ponderosa_spawn_agent in Codex and mcp__ponderosa__spawn_agent in Claude.",
    'Example arguments: {"displayName":"Safe name","initialMessage":"Optional task, role, or introduction","runtime":"codex","model":"gpt-5.6-luna","effort":"high","idempotencyKey":"stable-key"}.',
    "Set model and effort when the report should use a different tier. If omitted, the child inherits your current model and effort as durable defaults.",
    "initialMessage is optional. You may create an idle report and introduce or steer it later through ordinary Collaboration.",
    "Do not send managerAgentId, parentAgentId, agentId, conversationId, or execution ownership fields. Ponderosa derives the reporting line from your active capability.",
    "After asking reports to work, register a durable wait for the expected stable agent IDs when synthesis depends on their replies, then end your turn. Do not poll or sleep.",
  ];
}

function managerRelationshipPrompt(agent: Pick<AgentDto, "managerAgentId">): string[] {
  if (!agent.managerAgentId) {
    return ["You are a top-level agent. You report to the user and may publish intentional organizational Broadcasts."];
  }
  return [
    `You are a managed agent. Your direct manager is the stable agent id ${agent.managerAgentId}.`,
    "That relationship defines accountability, escalation, creation, and lifecycle ownership; it does not restrict who you may contact.",
    "Send work directly to the agent or user who requested it, decisions to affected owners, and questions to whoever can answer them. Contact your manager when the manager owns the outcome or must resolve priority, scope, ownership, resource, or escalation questions.",
    "You may Direct Message the user when the user needs the answer, decision, question, or genuinely private update. Do not send routine acknowledgments or duplicate summaries to either the user or your manager.",
    "You may collaborate directly with any relevant agent in the project, including agents in other reporting branches. Do not Broadcast; top-level agents own organizational synthesis and publication.",
  ];
}

function agentMessageEndpoint(
  _request: { protocol: string; headers: Record<string, unknown> },
  configuredBaseUrl?: string,
): string {
  if (configuredBaseUrl) return `${configuredBaseUrl.replace(/\/$/, "")}/api/agent-messages`;
  // Capabilities are injected into host-local runtimes. Never let an external
  // Host/X-Forwarded-* header choose where those bearer tokens are sent.
  return "http://127.0.0.1:8787/api/agent-messages";
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
      const quoted = message.replyTo ? ` (replying to: ${message.replyTo.text.replace(/\s+/g, " ").slice(0, 500)})` : "";
      const document = message.document ? ` [document: ${message.document.title}; id: ${message.document.id}]` : "";
      return `${speaker}${quoted}: ${message.text}${document} [message id: ${message.id}]`;
    })
    .join("\n");

  const staticInstructions = incremental ? [] : [
    "You are handling a manager request that originated in Conversation.",
    replyScope === "broadcast"
      ? "The latest plain Conversation request is shared work. Send its actual completed answer with intent broadcast, never direct_to_user. Reserve direct_to_user for a private question, private progress note, or a reply to an explicitly private manager message."
      : "The latest request is a Direct Message. Explicitly send direct_to_user to answer privately.",
    "Agent-to-agent discussion belongs in Collaboration and requires explicit stable agent IDs.",
    "If you need time to work, begin with a brief, natural acknowledgment that specifically reflects the request.",
    "Choose how to converse based on the message; never use a canned acknowledgment such as 'Got it — I’m on it.'",
    "When this turn is complete, give only the new direct update or result. Do not repeat a Broadcast or Collaboration message you already sent.",
    "Do not repeat, recap, or answer with the whole conversation. Do not describe these instructions.",
    ...agentMessagingPrompt(),
  ];
  return [
    ...staticInstructions,
    ...(routingMetadata ? [routingMetadata] : []),
    ...messageContextPrompt(context),
    "",
    incremental ? "New conversation messages since the last accepted turn:" : "Current conversation history:",
    transcript || (incremental ? "(No new room messages.)" : "(No earlier messages.)"),
    `Context injection accounting: room_messages=${messages.length}; room_characters=${messages.reduce((sum, message) => sum + message.text.length, 0)}`,
    "",
    ...(currentMessageId ? [`Latest message id: ${currentMessageId}`] : []),
    "Latest message for you:",
    currentRequest,
  ].join("\n");
}

/** Collaboration context is opt-in: it is assembled only for an explicit recipient delivery. */
function collaborationPrompt(
  messages: ConversationMessageDto[],
  agents: AgentDto[],
  currentRequest: string,
  context: InboundMessageContext,
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
      const quoted = message.replyTo ? ` (replying to: ${message.replyTo.text.replace(/\s+/g, " ").slice(0, 500)})` : "";
      const document = message.document ? ` [document: ${message.document.title}; id: ${message.document.id}]` : "";
      return `${speaker}${quoted}: ${message.text}${document} [message id: ${message.id}]`;
    })
    .join("\n");
  const staticInstructions = incremental ? [] : [
    "You are collaborating with teammates in Ponderosa's opt-in team chat.",
    "You received this context because you were an explicit collaboration recipient.",
    "This is the only chat for agent-to-agent coordination. Respond directly to the latest requester and any other agent who needs the result; reporting relationships do not limit recipients.",
    "To involve a teammate, send a collaboration intent with their stable agent ID; the server routes it and renders any display handle.",
    "Do not move agent-to-agent coordination into the shared user Conversation. Only explicit Broadcast creates durable organization-wide context there.",
    "You may use the separately supplied shared Broadcast context, but do not claim access to private Project-chat messages.",
    "If this collaboration-triggered turn produces a result, question, or material blocker another agent needs, explicitly send it with Collaboration to the smallest set who need it. If nobody needs to act, do not create an acknowledgment merely to close the turn. Ordinary runtime output is Work log only and does not deliver information.",
    ...agentMessagingPrompt(),
  ];
  return [
    ...staticInstructions,
    ...(routingMetadata ? [routingMetadata] : []),
    ...messageContextPrompt(context),
    "",
    incremental ? "New collaboration messages since the last accepted turn:" : "Collaboration chat history:",
    transcript || (incremental ? "(No new room messages.)" : "(No earlier collaboration messages.)"),
    `Context injection accounting: room_messages=${messages.length}; room_characters=${messages.reduce((sum, message) => sum + message.text.length, 0)}`,
    "",
    ...(currentMessageId ? [`Latest message id: ${currentMessageId}`] : []),
    "Latest message for you:",
    currentRequest,
  ].join("\n");
}

function individualChatPrompt(currentRequest: string, context: InboundMessageContext): string {
  return [
    "You are replying in your individual Ponderosa agent chat.",
    ...messageContextPrompt(context),
    ...agentMessagingPrompt(),
    "",
    "Latest message for you:",
    currentRequest,
  ].join("\n");
}

/** Minimal turn prompt for a session that already received the full protocol. */
function continuationPrompt(currentRequest: string, context: InboundMessageContext): string {
  const channelRule = context.channel === "collaboration"
    ? "If this collaboration-triggered turn produces a result, question, or material blocker another agent needs, explicitly send it with Collaboration to the smallest set of stable agent IDs who need it; reporting relationships do not limit recipients. If nobody needs to act, do not send an acknowledgment merely to close the turn."
    : context.channel === "main"
      ? "A plain shared Conversation request must receive its completed answer through broadcast, not direct_to_user. Use direct_to_user only for a private question or progress note."
      : "Explicitly use direct_to_user when the manager should receive an answer.";
  return [
    ...messageContextPrompt(context),
    channelRule,
    "Latest message for you:",
    currentRequest,
  ].join("\n");
}

function replyContext(reference: MessageReferenceDto | undefined): string {
  if (!reference) return "";
  const quote = reference.text.replace(/\s+/g, " ").trim().slice(0, 1200);
  return `\nReplying specifically to this earlier message:\n> ${quote}\n`;
}

function envelope(agentId: string, stored: StoredLogEvent, replayed = false): SseEventEnvelope | undefined {
  if (!isAgentStreamEvent(stored.event)) return undefined;
  return { agentId, seq: stored.seq, ts: stored.ts, event: stored.event, ...(replayed ? { replayed: true } : {}) };
}

function writeSse(res: NodeJS.WritableStream, name: string, id: number | undefined, data: unknown): void {
  if (id !== undefined) res.write(`id: ${id}\n`);
  res.write(`event: ${name}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function contentTypeForStatic(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json") || file.endsWith(".webmanifest")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
  if (file.endsWith(".ico")) return "image/x-icon";
  if (file.endsWith(".woff")) return "font/woff";
  if (file.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function cacheControlForStatic(file: string): string {
  const base = path.basename(file);
  if (base === "index.html" || base === "sw.js" || base === "register-sw.js" || base === "manifest.webmanifest") return "no-cache";
  if (file.includes(`${path.sep}static${path.sep}`)) return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
}

function contentTypeForArtifact(file: string): ArtifactContentDto["contentType"] {
  if (file.endsWith(".md")) return "markdown";
  if (file.endsWith(".patch") || file.endsWith(".diff")) return "diff";
  return "text";
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function safeRelativePath(input: string | undefined): string {
  const value = input ?? "";
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (normalized === "." || normalized === "/") return "";
  if (normalized.startsWith("../") || normalized === ".." || path.isAbsolute(value)) {
    throw new Error("path escapes project");
  }
  return normalized;
}

const FILE_REFERENCE_IGNORED_SEGMENTS = new Set([
  "node_modules", "vendor", "dist", "build", "coverage", "__pycache__",
  ".git", ".hg", ".svn", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
]);

/** File mentions are model context, so credential-ish and generated paths fail closed. */
export function isProjectFileReferenceAllowed(relativePath: string): boolean {
  const segments = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  return segments.every((segment) =>
    !FILE_REFERENCE_IGNORED_SEGMENTS.has(segment) &&
    !segment.startsWith(".") &&
    !/(?:^|[-_.])(secret|secrets|credential|credentials|token|tokens|password|passwd|oauth)(?:$|[-_.])/iu.test(segment),
  );
}

async function readScopedPath(root: string, relInput: string | undefined): Promise<FilesResponse> {
  const rel = safeRelativePath(relInput);
  if (rel && !isProjectFileReferenceAllowed(rel)) throw new Error("path is excluded from project references");
  const rootReal = await fs.realpath(root);
  const target = path.resolve(rootReal, rel);
  const targetReal = await fs.realpath(target);
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
    throw new Error("path escapes project");
  }

  const stat = await fs.stat(targetReal);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(targetReal, { withFileTypes: true });
    return {
      kind: "dir",
      path: rel,
      entries: entries
        .filter((entry) => (entry.isDirectory() || entry.isFile()) && isProjectFileReferenceAllowed(path.posix.join(rel, entry.name)))
        .map((entry) => ({
          name: entry.name,
          path: path.posix.join(rel, entry.name),
          kind: entry.isDirectory() ? ("dir" as const) : ("file" as const),
        }))
        .sort((a, b) => Number(a.kind === "file") - Number(b.kind === "file") || a.name.localeCompare(b.name)),
    };
  }

  if (stat.size > MAX_FILE_BYTES) throw new Error("file exceeds 2 MiB browser limit");
  const buffer = await fs.readFile(targetReal);
  return isUtf8(buffer)
    ? { kind: "file", path: rel, content: buffer.toString("utf8"), encoding: "utf-8" }
    : { kind: "file", path: rel, content: buffer.toString("base64"), encoding: "base64" };
}

const WORKSPACE_REVIEW_MAX_BYTES = 2 * 1024 * 1024;

function isWorkspaceReviewPathAllowed(relativePath: string): boolean {
  const segments = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  return segments.every((segment) =>
    !FILE_REFERENCE_IGNORED_SEGMENTS.has(segment) &&
    !/^\.env(?:\.|$)/iu.test(segment) &&
    !/(?:^|[-_.])(secret|secrets|credential|credentials|token|tokens|password|passwd|oauth)(?:$|[-_.])/iu.test(segment),
  );
}

interface GitResult { stdout: string; stderr: string; exitCode: number }

function runGit(root: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "color.ui=false", ...args],
      { cwd: root, encoding: "utf8", timeout: 8_000, maxBuffer: WORKSPACE_REVIEW_MAX_BYTES },
      (error, stdout, stderr) => {
        if (error && typeof error.code === "string") return reject(error);
        resolve({ stdout, stderr, exitCode: typeof error?.code === "number" ? error.code : 0 });
      },
    );
  });
}

export function parseGitStatus(output: string): WorkspaceChangeDto[] {
  const records = output.split("\0");
  const changes: WorkspaceChangeDto[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const x = record[0]!;
    const y = record[1]!;
    const pathValue = record.slice(3);
    const renamed = x === "R" || y === "R" || x === "C" || y === "C";
    const previousPath = renamed ? records[index += 1] : undefined;
    if (!isWorkspaceReviewPathAllowed(pathValue)) continue;
    const combined = `${x}${y}`;
    changes.push({
      path: pathValue,
      ...(previousPath && isWorkspaceReviewPathAllowed(previousPath) ? { previousPath } : {}),
      kind: renamed ? "rename" : combined.includes("D") ? "delete" : combined === "??" || combined.includes("A") ? "create" : "edit",
      staged: x !== " " && x !== "?",
      unstaged: y !== " " && y !== "?",
      untracked: combined === "??",
    });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

async function workspaceStatus(projectId: string, root: string): Promise<WorkspaceStatusDto> {
  const generatedAt = new Date().toISOString();
  try {
    const inside = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") return { projectId, isGitRepository: false, generatedAt, changes: [] };
    const [status, branch, head] = await Promise.all([
      runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
      runGit(root, ["rev-parse", "--short", "HEAD"]),
    ]);
    return {
      projectId,
      isGitRepository: true,
      branch: branch.stdout.trim() || undefined,
      head: head.stdout.trim() || undefined,
      generatedAt,
      changes: parseGitStatus(status.stdout),
    };
  } catch {
    return { projectId, isGitRepository: false, generatedAt, changes: [] };
  }
}

async function workspaceFile(projectId: string, root: string, input: string | undefined): Promise<WorkspaceFileReviewDto> {
  const relativePath = safeRelativePath(input);
  if (!relativePath || !isWorkspaceReviewPathAllowed(relativePath)) throw new Error("path is excluded from workspace review");
  const rootReal = await fs.realpath(root);
  const candidate = path.resolve(rootReal, relativePath);
  if (!candidate.startsWith(`${rootReal}${path.sep}`)) throw new Error("path escapes project");

  const [staged, unstaged] = await Promise.all([
    runGit(rootReal, ["diff", "--cached", "--no-ext-diff", "--unified=3", "--", relativePath]),
    runGit(rootReal, ["diff", "--no-ext-diff", "--unified=3", "--", relativePath]),
  ]);
  let exists = false;
  let content: string | undefined;
  let truncated = staged.stdout.length + unstaged.stdout.length >= WORKSPACE_REVIEW_MAX_BYTES;
  try {
    const resolved = await fs.realpath(candidate);
    if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${path.sep}`)) throw new Error("path escapes project");
    const stat = await fs.stat(resolved);
    exists = stat.isFile();
    if (exists && stat.size <= MAX_FILE_BYTES) {
      const body = await fs.readFile(resolved);
      if (isUtf8(body)) content = body.toString("utf8");
    } else if (exists) {
      truncated = true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const stagedDiff = staged.stdout;
  const unstagedDiff = unstaged.stdout;
  let diff = [stagedDiff, unstagedDiff].filter(Boolean).join("\n");
  if (!diff && exists && content !== undefined) {
    const lines = content.split("\n");
    diff = [`--- /dev/null`, `+++ b/${relativePath}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n");
    if (diff.length > WORKSPACE_REVIEW_MAX_BYTES) {
      diff = diff.slice(0, WORKSPACE_REVIEW_MAX_BYTES);
      truncated = true;
    }
  }
  return { projectId, path: relativePath, exists, ...(content !== undefined ? { content } : {}), diff, stagedDiff, unstagedDiff, truncated };
}

function roundedUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function projectedRunCost(usage: TokenUsage, profile: ApiPriceProfile): number | undefined {
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  const cached = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteInputTokens ?? 0;
  const uncached = usage.inputTokens - cached - cacheWrite;
  if ([usage.inputTokens, usage.outputTokens, cached, cacheWrite, uncached].some((value) => !Number.isSafeInteger(value) || value < 0)) return undefined;
  const long = profile.longContext && usage.inputTokens > profile.longContext.inputTokenThreshold
    ? profile.longContext : undefined;
  const inputMultiplier = long?.inputMultiplier ?? 1;
  const outputMultiplier = long?.outputMultiplier ?? 1;
  const cacheWriteRate = profile.cacheWriteInputUsdPerMillion ?? profile.inputUsdPerMillion;
  return (
    uncached * profile.inputUsdPerMillion * inputMultiplier +
    cached * profile.cachedInputUsdPerMillion * inputMultiplier +
    cacheWrite * cacheWriteRate * inputMultiplier +
    usage.outputTokens * profile.outputUsdPerMillion * outputMultiplier
  ) / 1_000_000;
}

export function createServer(opts: CreateServerOptions): FastifyInstance {
  const store = opts.store ?? new AgentStore(opts.dataDir);
  store.recoverInterruptedExecutions();
  const assets = new AssetStore(opts.dataDir);
  const engines = new Map(opts.engines.map((engine) => [engine.adapter.id, engine]));
  const projectedUsage = (scope: { type: "overall" } | { type: "project" | "agent"; id: string }): TokenUsageSummaryDto => {
    const summary = store.getTokenUsage(scope);
    const grouped = new Map<string, { engine: string; requestedModel?: string; profile: ApiPriceProfile; runs: number; usd: number }>();
    let pricedRuns = 0;
    for (const run of store.getMeteredRuns(scope)) {
      const profile = engines.get(run.engine)?.adapter.apiPriceProfile?.(run.model);
      const usd = profile ? projectedRunCost(run.usage, profile) : undefined;
      if (usd === undefined || !profile) continue;
      pricedRuns += 1;
      const key = `${run.engine}\0${run.model ?? ""}\0${profile.pricingModel}`;
      const current = grouped.get(key) ?? { engine: run.engine, requestedModel: run.model, profile, runs: 0, usd: 0 };
      current.runs += 1;
      current.usd += usd;
      grouped.set(key, current);
    }
    const breakdown = [...grouped.values()].map((item) => ({
      engine: item.engine,
      ...(item.requestedModel ? { requestedModel: item.requestedModel } : {}),
      pricingModel: item.profile.pricingModel,
      proxy: Boolean(item.profile.proxy),
      runs: item.runs,
      usd: roundedUsd(item.usd),
    })).sort((a, b) => b.usd - a.usd);
    const catalogVersion = [...grouped.values()].map((item) => item.profile.catalogVersion).sort().at(-1) ?? "2026-07-13";
    return {
      ...summary,
      projectedApiCost: {
        currency: "USD",
        usd: roundedUsd(breakdown.reduce((total, item) => total + item.usd, 0)),
        basis: "api_list_price_proxy",
        catalogVersion,
        pricedRuns,
        unpricedRuns: summary.finalizedRuns - pricedRuns,
        coverage: summary.finalizedRuns ? pricedRuns / summary.finalizedRuns : null,
        breakdown,
      },
    };
  };
  const activeRuns = new Map<string, ActiveRun>();
  const runtimeSessions = new Map<string, PersistentRuntime>();
  const organizationEnvelopeStates = new Map<string, { sessionId: string; hash: string }>();
  const collaborationDeliveries = new CollaborationDeliveryStore(opts.dataDir);
  const agentWaits = new AgentWaitStore(opts.dataDir);
  const userReactions = new UserReactionStore(opts.dataDir);
  const runLedger = new RunLedger(opts.dataDir);
  const engineAuthStatuses = new EngineAuthStatusCache();
  const engineCapabilityCache = new Map<string, { expiresAt: number; value: Promise<ProjectEngineCapabilitiesDto> }>();
  const contextCursors = new ContextCursorStore(opts.dataDir);
  const managedWorkspacesRoot = path.resolve(opts.dataDir, "workspaces");
  const agentMessageCapabilities = new Map<string, AgentMessageCapability>();
  // An agent can request rollover while its capability is live. The reset is
  // applied only after the turn ends, so it never destroys an in-flight session.
  const scheduledSessionRollovers = new Map<string, string>();
  const dispatchingTurns = new Set<string>();
  const deliveryRetryTimers = new Map<string, NodeJS.Timeout>();
  const waitDeadlineTimers = new Map<string, NodeJS.Timeout>();
  const deliveryDispatches = new Set<Promise<void>>();
  // Capability used only by this server's queue dispatcher. It prevents a client
  // from attaching arbitrary collaboration history to a direct agent request.
  const collaborationDispatchKey = randomUUID();
  // Prevent an internal dequeue from being appended to the tail if another
  // request claims the agent in the tiny dispatch race window.
  const turnDispatchKey = randomUUID();
  const subscribers = new Map<string, Set<Subscriber>>();
  const directReplyClaims = new Set<string>();
  const deletingAgentIds = new Set<string>();
  let closed = false;
  let assetSweep: NodeJS.Timeout | undefined;
  const recordCommunication = (event: CommunicationEvent): CommunicationEvent =>
    store.appendCommunicationEvent(event).event;
  const executionLeaseMs = opts.executionLeaseScheduling?.leaseMs ?? 6 * 60 * 1000;
  const executionHeartbeatMs = opts.executionLeaseScheduling?.heartbeatMs ?? Math.max(1, Math.floor(executionLeaseMs / 3));
  const executionLeaseNow = opts.executionLeaseScheduling?.now ?? Date.now;
  const setExecutionLeaseTimer = opts.executionLeaseScheduling?.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearExecutionLeaseTimer = opts.executionLeaseScheduling?.clearTimer ?? clearTimeout;
  const leaseExpiry = () => new Date(executionLeaseNow() + executionLeaseMs).toISOString();
  const deliveryNow = opts.deliveryScheduling?.now ?? Date.now;
  const deliveryRandom = opts.deliveryScheduling?.random ?? Math.random;
  const setDeliveryTimer = opts.deliveryScheduling?.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const runtimeStallAfterMs = opts.runtimeEventFaults?.stallAfterMs ?? 30_000;
  const runtimeIdleTtlMs = opts.runtimeSessionScheduling?.idleTtlMs ?? 90_000;
  const configuredMaxIdleSessions = Number.parseInt(process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS ?? "", 10);
  const requestedMaxIdleSessions = opts.runtimeSessionScheduling?.maxIdleSessions ?? configuredMaxIdleSessions;
  const runtimeMaxIdleSessions = Number.isInteger(requestedMaxIdleSessions) && requestedMaxIdleSessions >= 0
    ? requestedMaxIdleSessions
    : 0;
  const runtimeSessionNow = opts.runtimeSessionScheduling?.now ?? Date.now;
  const setRuntimeIdleTimer = opts.runtimeSessionScheduling?.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearRuntimeIdleTimer = opts.runtimeSessionScheduling?.clearTimer ?? clearTimeout;

  function cancelRuntimeIdleClose(runtime: PersistentRuntime | undefined): void {
    if (!runtime) return;
    runtime.idleSince = undefined;
    if (runtime.idleTimer) {
      clearRuntimeIdleTimer(runtime.idleTimer);
      runtime.idleTimer = undefined;
    }
  }

  function removePersistentRuntime(agentId: string, runtime: PersistentRuntime): void {
    if (runtimeSessions.get(agentId) !== runtime) return;
    cancelRuntimeIdleClose(runtime);
    runtimeSessions.delete(agentId);
  }

  function trimIdleRuntimeSessions(): void {
    const idle = [...runtimeSessions.entries()]
      .filter(([agentId, runtime]) => !activeRuns.has(agentId) && runtime.idleSince !== undefined)
      .sort((left, right) => left[1].idleSince! - right[1].idleSince!);
    for (const [agentId, runtime] of idle.slice(0, Math.max(0, idle.length - runtimeMaxIdleSessions))) {
      removePersistentRuntime(agentId, runtime);
      void runtime.session.close().catch(() => undefined);
    }
  }

  function scheduleRuntimeIdleClose(agentId: string, runtime: PersistentRuntime): void {
    cancelRuntimeIdleClose(runtime);
    runtime.idleSince = runtimeSessionNow();
    runtime.idleTimer = setRuntimeIdleTimer(() => {
      if (closed || activeRuns.has(agentId) || runtimeSessions.get(agentId) !== runtime) return;
      removePersistentRuntime(agentId, runtime);
      void runtime.session.close().catch(() => undefined);
    }, runtimeIdleTtlMs);
    runtime.idleTimer.unref?.();
    trimIdleRuntimeSessions();
  }

  const runFence = (agentId: string, run: ActiveRun): RunFence => ({ agentId, runId: run.runId, generation: run.generation });

  function ownsActiveRun(agentId: string, run: ActiveRun): boolean {
    return activeRuns.get(agentId) === run && runLedger.owns(runFence(agentId, run));
  }

  function transitionRun(agentId: string, run: ActiveRun, state: RuntimeOwnershipState): boolean {
    const claim = runLedger.transition(runFence(agentId, run), state);
    if (!claim) return false;
    run.ownershipState = state;
    opts.runtimeEventFaults?.onOwnershipState?.({ agentId, runId: run.runId, generation: run.generation, state });
    return true;
  }

  function receiveRuntimeEvent(agentId: string, run: ActiveRun): boolean {
    if (!ownsActiveRun(agentId, run) || run.ownershipState === "cancelling") return false;
    const at = new Date().toISOString();
    run.lastEventReceivedAt = at;
    return Boolean(runLedger.transition(runFence(agentId, run), run.ownershipState, { lastEventReceivedAt: at }));
  }

  async function waitBeforeRuntimePersist(agentId: string, run: ActiveRun, event: AgentEvent): Promise<boolean> {
    await opts.runtimeEventFaults?.beforePersist?.({ agentId, runId: run.runId, generation: run.generation, event });
    return ownsActiveRun(agentId, run) && run.ownershipState !== "cancelling";
  }

  function persistRuntimeEvent(agentId: string, run: ActiveRun, event: LogEvent): StoredLogEvent | undefined {
    if (!ownsActiveRun(agentId, run) || run.ownershipState === "cancelling") return undefined;
    const stored = store.appendEvent(agentId, event);
    const at = new Date().toISOString();
    run.lastEventPersistedAt = at;
    const recovered = run.ownershipState === "stalled";
    runLedger.transition(runFence(agentId, run), recovered ? "running" : run.ownershipState, { lastEventPersistedAt: at });
    if (recovered) {
      run.ownershipState = "running";
      opts.runtimeEventFaults?.onOwnershipState?.({ agentId, runId: run.runId, generation: run.generation, state: "running" });
    }
    publish(agentId, stored);
    return stored;
  }

  function clearRunLeaseTimer(run: ActiveRun): void {
    if (!run.leaseTimer) return;
    clearExecutionLeaseTimer(run.leaseTimer);
    run.leaseTimer = undefined;
  }

  function clearRunLivenessTimer(run: ActiveRun): void {
    if (!run.livenessTimer) return;
    clearExecutionLeaseTimer(run.livenessTimer);
    run.livenessTimer = undefined;
  }

  function scheduleRuntimeLivenessHeartbeat(agentId: string, run: ActiveRun): void {
    clearRunLivenessTimer(run);
    if (!run.runtimeSession) return;
    run.livenessTimer = setExecutionLeaseTimer(() => {
      run.livenessTimer = undefined;
      if (closed || !ownsActiveRun(agentId, run)) return;
      let alive = false;
      try { alive = run.runtimeSession?.isAlive() === true; } catch { /* failed liveness checks do not renew */ }
      if (!alive) return;
      if (renewExecutionLease(agentId, run)) scheduleRuntimeLivenessHeartbeat(agentId, run);
    }, executionHeartbeatMs);
    run.livenessTimer.unref?.();
  }

  function expireExecutionLease(agentId: string, run: ActiveRun): void {
    if (closed || !ownsActiveRun(agentId, run)) return;
    const remaining = Date.parse(run.leaseExpiresAt) - executionLeaseNow();
    if (remaining > 0) {
      run.leaseTimer = setExecutionLeaseTimer(() => expireExecutionLease(agentId, run), remaining);
      run.leaseTimer.unref?.();
      return;
    }

    // Delete the claim and revoke capabilities before aborting. Any synchronous
    // or late async continuation from this generation therefore fails its CAS.
    activeRuns.delete(agentId);
    clearRunLeaseTimer(run);
    clearRunLivenessTimer(run);
    agentMessageCapabilities.delete(run.messageCapability);
    scheduledSessionRollovers.delete(agentId);
    runLedger.transition(runFence(agentId, run), "failed");
    const lifecycle = store.appendEvent(agentId, {
      type: "agent_lifecycle", status: "failed", reason: "execution_lease_expired", executionId: run.executionId,
    });
    publish(agentId, lifecycle);
    notifyManagerOfChildFailure(agentId, run.executionId, "execution lease expired");
    if (run.deliveryIds?.length) {
      for (const id of run.deliveryIds) {
        collaborationDeliveries.retryFailedTurn(id, "execution lease expired");
      }
    }
    const persistentRuntime = runtimeSessions.get(agentId);
    if (persistentRuntime) {
      removePersistentRuntime(agentId, persistentRuntime);
      void persistentRuntime.session.close().catch(() => undefined);
    }
    run.controller.abort();
    runDeliveryDispatch(agentId);
  }

  function renewExecutionLease(agentId: string, run: ActiveRun): boolean {
    if (!ownsActiveRun(agentId, run)) return false;
    clearRunLeaseTimer(run);
    run.leaseExpiresAt = leaseExpiry();
    run.leaseTimer = setExecutionLeaseTimer(() => expireExecutionLease(agentId, run), executionLeaseMs);
    run.leaseTimer.unref?.();
    return true;
  }

  function claimActiveRun(agentId: string, run: ActiveRun): void {
    activeRuns.set(agentId, run);
    renewExecutionLease(agentId, run);
  }

  function releaseActiveRun(agentId: string, run: ActiveRun, state: "completed" | "failed" | "cancelled"): boolean {
    if (!ownsActiveRun(agentId, run)) return false;
    activeRuns.delete(agentId);
    clearRunLeaseTimer(run);
    clearRunLivenessTimer(run);
    runLedger.transition(runFence(agentId, run), state);
    return true;
  }

  function withUserReactions<T extends { communicationEventId?: string }>(messages: T[]): T[] {
    return messages.map((message) => message.communicationEventId ? {
      ...message,
      reactions: userReactions.forCommunication(message.communicationEventId),
    } : message);
  }

  function conversationDetail(conversationId: string): ConversationDetailDto | undefined {
    const detail = store.getConversationDetail(conversationId);
    if (!detail) return detail;
    return { ...detail, messages: withUserReactions(store.getProjectedConversationMessages(conversationId, "main")) };
  }

  function collaborationViewDetail(conversationId: string): CollaborationViewDto | undefined {
    const detail = store.getCollaborationViewDetail(conversationId);
    if (!detail) return detail;
    return { ...detail, messages: withUserReactions(store.getProjectedConversationMessages(conversationId, "collaboration")) };
  }

  function agentDetail(agentId: string): import("@ponderosa/core").AgentDetailDto | undefined {
    const detail = store.getAgentDetail(agentId);
    if (!detail) return detail;
    return { ...detail, messages: withUserReactions(store.getProjectedAgentMessages(agentId)) };
  }

  const agentMessages = (agentId: string) => store.getProjectedAgentMessages(agentId);

  function agentHealth(scope: AgentHealthProjectionDto["scope"], agents: AgentDto[]): AgentHealthProjectionDto {
    const now = Date.now();
    for (const [agentId, run] of activeRuns) {
      if (run.ownershipState !== "running" || !run.lastEventReceivedAt) continue;
      const received = Date.parse(run.lastEventReceivedAt);
      const persisted = run.lastEventPersistedAt ? Date.parse(run.lastEventPersistedAt) : 0;
      if (received > persisted && now - received >= runtimeStallAfterMs) transitionRun(agentId, run, "stalled");
    }
    const ownership = new Map<string, ActiveRunObservation>(activeRuns);
    for (const claim of runLedger.all()) {
      if (claim.state === "interrupted" && !ownership.has(claim.agentId)) ownership.set(claim.agentId, {
        startedAt: claim.createdAt, executionId: claim.runId, ownershipState: "interrupted",
      });
    }
    return projectAgentHealth({
      scope,
      agents,
      activeRuns: ownership,
      compactingAgents: scheduledSessionRollovers,
      queuedDeliveries: (agentId) => collaborationDeliveries.pending(agentId),
      events: (agentId) => store.readEvents(agentId),
    });
  }

  function teamDirectory(projectId: string): TeamDirectoryDto {
    const agents = store.listAgents(projectId).filter((agent) => !agent.archived);
    const health = agentHealth({ type: "project", id: projectId }, agents);
    const healthById = new Map(health.agents.map((agent) => [agent.agentId, agent]));
    return {
      projectId, generatedAt: health.generatedAt,
      agents: agents.map((agent) => {
        return {
          agentId: agent.id, displayName: agent.title,
          role: agent.presetSnapshot?.name ?? "Generalist",
          description: agent.presetSnapshot?.description ?? `General-purpose agent ${agent.title}`,
          status: healthById.get(agent.id)?.status ?? "idle",
          ...(agent.managerAgentId ? { managerAgentId: agent.managerAgentId } : {}),
          childAgentIds: agents.filter((candidate) => candidate.managerAgentId === agent.id).map((candidate) => candidate.id).sort(),
          engine: agent.activeEngine,
          ...(agent.presetSnapshot ? { preset: { id: agent.presetSnapshot.id, name: agent.presetSnapshot.name } } : {}),
        };
      }).sort((a, b) => a.displayName.localeCompare(b.displayName) || a.agentId.localeCompare(b.agentId)),
    };
  }

  const app = Fastify({
    bodyLimit: ASSET_LIMITS.maxRequestBytes,
    logger: opts.logger === false ? false : {
      redact: {
        paths: ["req.headers.authorization", "req.headers.x-ponderosa-prompt-access"],
        censor: "[REDACTED]",
      },
    },
  });
  for (const mediaType of ["image/png", "image/jpeg", "image/webp", "application/pdf", "application/zip", "application/octet-stream"]) {
    app.addContentTypeParser(mediaType, { parseAs: "buffer", bodyLimit: ASSET_LIMITS.maxRequestBytes }, (_request, body, done) => done(null, body));
  }

  function pendingTurnFromDelivery(delivery: CollaborationDelivery): PendingTurn {
    return {
      text: delivery.text,
      communicationEventId: delivery.communicationEventId,
      model: delivery.model,
      effort: delivery.effort,
      agentMentionDepth: delivery.relayDepth,
      agentMentionTrail: delivery.mentionTrail,
      collaborationConversationId: delivery.kind === "direct" ? undefined : delivery.conversationId,
      sourceChannel: delivery.sourceChannel,
      sourceConversationId: delivery.sourceChannel === "main" ? delivery.conversationId : undefined,
      sourceAuthorAgentId: delivery.authorAgentId,
      collaborationDeliveryId: delivery.id,
      replyToMessageId: delivery.replyToMessageId,
      replyTo: delivery.replyTo,
      attachmentIds: delivery.attachmentIds,
    };
  }

  function canShareCollaborationBatch(first: CollaborationDelivery, candidate: CollaborationDelivery): boolean {
    return first.kind !== "direct" && candidate.kind !== "direct" &&
      !first.replyToMessageId && !candidate.replyToMessageId;
  }

  function formatDeliveryBatch(batch: CollaborationDeliveryBatch): string {
    const entries = batch.deliveries.map((delivery, index) => {
      const authorAgent = delivery.authorAgentId ? store.getAgent(delivery.authorAgentId) : undefined;
      const author = authorAgent
        ? `${authorAgent.title} (#${agentMentionHandle(authorAgent.title)}, agent ${authorAgent.id})`
        : "Manager";
      return [
        `--- Entry ${index + 1} ---`,
        `Author: ${author}`,
        `UTC timestamp: ${delivery.createdAt}`,
        "Original message (exact):",
        delivery.text,
      ].join("\n");
    });
    return [
      `CollaborationDeliveryBatch (${batch.deliveries.length} deliveries; canonical server order)`,
      ...entries,
    ].join("\n\n");
  }

  function pendingTurnFromBatch(deliveries: CollaborationDelivery[]): PendingTurn {
    const first = deliveries[0]!;
    const mentionTrail = mergeMentionTrails(deliveries);
    return {
      ...pendingTurnFromDelivery(first),
      text: formatDeliveryBatch({ deliveries }),
      agentMentionDepth: mentionTrail.length,
      agentMentionTrail: mentionTrail,
      communicationEventId: undefined,
      sourceAuthorAgentId: undefined,
      collaborationDeliveryId: undefined,
      collaborationDeliveryIds: deliveries.map((delivery) => delivery.id),
    };
  }

  function boundedDeliveryBatch(pending: CollaborationDelivery[]): CollaborationDelivery[] {
    const first = pending[0];
    if (!first) return [];
    if (first.kind === "direct" || first.replyToMessageId) return [first];
    const batch: CollaborationDelivery[] = [];
    for (const candidate of pending) {
      if (!canShareCollaborationBatch(first, candidate) || batch.length >= COLLABORATION_DISPATCH_LIMITS.maxBatchDeliveries) break;
      const proposed = [...batch, candidate];
      // A batch is one causal turn. Never flatten away an earlier delivery's
      // replay evidence just to fit the bounded lineage window; leave the
      // candidate queued for its own subsequent turn instead.
      if (mergeMentionTrails(proposed).length > MAX_AGENT_MENTION_REPLAY_WINDOW) break;
      const bytes = Buffer.byteLength(formatDeliveryBatch({ deliveries: proposed }), "utf8");
      if (bytes > COLLABORATION_DISPATCH_LIMITS.maxBatchUtf8Bytes) break;
      batch.push(candidate);
    }
    return batch;
  }

  function dispatchRetryDelay(attempt: number): number {
    const exponential = Math.min(
      COLLABORATION_DISPATCH_LIMITS.maxRetryMs,
      COLLABORATION_DISPATCH_LIMITS.baseRetryMs * (2 ** Math.max(0, attempt - 1)),
    );
    const jitter = exponential * COLLABORATION_DISPATCH_LIMITS.jitterRatio * ((deliveryRandom() * 2) - 1);
    return Math.max(0, Math.round(exponential + jitter));
  }

  function clearWaitDeadline(agentId: string): void {
    const timer = waitDeadlineTimers.get(agentId);
    if (timer) clearTimeout(timer);
    waitDeadlineTimers.delete(agentId);
  }

  function scheduleWaitDeadline(wait: AgentWaitCondition): void {
    clearWaitDeadline(wait.agentId);
    if (!wait.deadline || wait.status !== "active") return;
    const delay = Math.max(0, Date.parse(wait.deadline) - deliveryNow());
    const timer = setDeliveryTimer(() => {
      waitDeadlineTimers.delete(wait.agentId);
      const active = agentWaits.active(wait.agentId);
      if (!active || active.id !== wait.id) return;
      const evaluation = agentWaits.evaluate(wait.agentId, collaborationDeliveries.pending(wait.agentId), collaborationDeliveries, deliveryNow());
      if (evaluation.wait?.status !== "expired") return;
      queueCollaborationDelivery({
        messageId: `wait-deadline:${wait.id}`,
        targetAgentId: wait.agentId,
        text: `Durable wait deadline reached. Continue with the reports received so far and explicitly identify any missing reporters from: ${wait.expectedAgentIds.join(", ")}.`,
        relayDepth: 0,
        mentionTrail: [],
        kind: "manager_notification",
      });
    }, delay);
    timer.unref?.();
    waitDeadlineTimers.set(wait.agentId, timer);
  }

  function scheduleDeliveryDispatch(agentId: string, delayMs = 0): void {
    if (closed || activeRuns.has(agentId) || deliveryRetryTimers.has(agentId)) return;
    const timer = setDeliveryTimer(() => {
      deliveryRetryTimers.delete(agentId);
      runDeliveryDispatch(agentId);
    }, delayMs);
    timer.unref?.();
    deliveryRetryTimers.set(agentId, timer);
  }

  function runDeliveryDispatch(agentId: string): void {
    const dispatch = dispatchNextTurn(agentId);
    deliveryDispatches.add(dispatch);
    void dispatch.finally(() => deliveryDispatches.delete(dispatch));
  }

  /**
   * Persist before enqueueing. A tag therefore survives cancellation, process
   * restart, and dispatch races instead of existing only in collaboration history.
   */
  function queueCollaborationDelivery(
    input: Omit<CollaborationDelivery, "id" | "status" | "createdAt"> & { createdAt?: string },
  ): CollaborationDelivery | undefined {
    if (closed) return undefined;
    const queued = collaborationDeliveries.queue(input);
    if (queued.delivery.communicationEventId) {
      const target = store.getAgent(queued.delivery.targetAgentId);
      if (target) {
        store.appendCommunicationProjection(target.projectId, {
          eventId: queued.delivery.communicationEventId,
          surface: "agent_inbox",
          projectionKey: target.id,
          projectedAt: queued.delivery.createdAt,
        });
      }
    }
    scheduleDeliveryDispatch(queued.delivery.targetAgentId);
    return queued.delivery;
  }

  async function dispatchNextTurn(agentId: string): Promise<void> {
    if (closed) return;
    if (activeRuns.has(agentId)) return;
    if (dispatchingTurns.has(agentId)) {
      scheduleDeliveryDispatch(agentId);
      return;
    }
    dispatchingTurns.add(agentId);
    let retryScheduled = false;
    let waitHeld = false;
    try {
    const pending = collaborationDeliveries.pending(agentId);
    const waitEvaluation = agentWaits.evaluate(agentId, pending, collaborationDeliveries, deliveryNow());
    if (waitEvaluation.wait?.status !== "active") clearWaitDeadline(agentId);
    if (waitEvaluation.hold) {
      waitHeld = true;
      return;
    }
    const delivery = pending[0];
    if (!delivery) return;
    const eligibleAt = delivery.nextDispatchAt ? Date.parse(delivery.nextDispatchAt) : 0;
    if (eligibleAt > deliveryNow()) {
      scheduleDeliveryDispatch(agentId, eligibleAt - deliveryNow());
      return;
    }
    // Direct follow-ups retain their exact existing behavior and remain FIFO
    // barriers. Every consecutive collaboration delivery for this recipient is
    // one fixed snapshot, regardless of author or relay metadata.
    const batch = boundedDeliveryBatch(pending);
    if (batch.length === 0) {
      collaborationDeliveries.fail(delivery.id, `delivery exceeds ${COLLABORATION_DISPATCH_LIMITS.maxBatchUtf8Bytes} UTF-8 batch bytes; dead-lettered`);
      return;
    }
    const next = batch.length > 1 ? pendingTurnFromBatch(batch) : pendingTurnFromDelivery(delivery);
    const deliveryIds = batch.map((item) => item.id);

    collaborationDeliveries.markBatchDelivered(deliveryIds);
    const injectedStatus = opts.deliveryScheduling?.claimStatus?.();
    const response = injectedStatus === undefined ? await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      headers: {
        ...(opts.authToken ? { authorization: `Bearer ${opts.authToken}` } : {}),
        ...(deliveryIds.length
          ? { "x-ponderosa-collaboration-dispatch": collaborationDispatchKey }
          : {}),
        "x-ponderosa-turn-dispatch": turnDispatchKey,
      },
      payload: next,
    }) : { statusCode: injectedStatus };
    // `app.close()` may have run while the internal injection was in flight.
    // Never mutate a delivery ledger after shutdown has revoked its data dir.
    if (closed) return;
    // Another request may have claimed the agent between our check and the
    // injected request. Put this turn back at the head without changing order.
    if (response.statusCode === 409) {
      collaborationDeliveries.requeueBatch(deliveryIds, true);
    } else if (response.statusCode === 429 || response.statusCode >= 500) {
      const attempt = Math.max(...deliveryIds.map((id) => collaborationDeliveries.get(id)?.dispatchAttempts ?? 0)) + 1;
      const delay = dispatchRetryDelay(attempt);
      const nextDispatchAt = new Date(deliveryNow() + delay).toISOString();
      const retried = collaborationDeliveries.retryDispatchBatch(
        deliveryIds,
        `delivery dispatch rejected (${response.statusCode})`,
        nextDispatchAt,
        COLLABORATION_DISPATCH_LIMITS.maxDispatchAttempts,
      );
      if (retried.some((item) => item.status === "queued")) {
        scheduleDeliveryDispatch(agentId, delay);
        retryScheduled = true;
      } else {
        const failed = retried[0];
        const target = failed ? store.getAgent(failed.targetAgentId) : undefined;
        if (failed?.conversationId && target) {
          appendCollaborationSystemNotice(
            failed.conversationId,
            `⚠️ #${agentMentionHandle(target.title)} was not notified because their follow-up delivery exhausted bounded retries. The handoff is retained as failed; retry manually or contact the manager.`,
            `delivery-failure:${failed.id}`,
          );
        }
      }
    } else if (response.statusCode >= 300) {
      collaborationDeliveries.failBatch(deliveryIds, `delivery dispatch rejected (${response.statusCode})`);
      const delivery = collaborationDeliveries.get(deliveryIds[0]!);
      const target = delivery ? store.getAgent(delivery.targetAgentId) : undefined;
      if (delivery?.conversationId && target) {
        appendCollaborationSystemNotice(
          delivery.conversationId,
          `⚠️ #${agentMentionHandle(target.title)} was not notified because their follow-up delivery failed. The handoff remains recorded; retry or contact the manager.`,
          `delivery-failure:${delivery.id}`,
        );
      }
    }
    } finally {
      dispatchingTurns.delete(agentId);
      if (!closed && !retryScheduled && !waitHeld && !activeRuns.has(agentId) && collaborationDeliveries.pendingCount(agentId) > 0) {
        scheduleDeliveryDispatch(agentId);
      }
    }
  }

  /**
   * Repair the crash window between appending a canonical collaboration message
   * and appending its recipient inbox record. The persisted boundary prevents an
   * upgrade from replaying messages created before durable delivery existed.
   */
  function reconcileCanonicalInbox(): string[] {
    const boundary = collaborationDeliveries.reconciliationBoundary();
    const recipients = new Set<string>();
    for (const project of store.listProjects()) {
      for (const master of store.listConversations(project.id)) {
        for (const { message, intent, messageReceiptKey, deliveryOrderKey } of store.getConversationDeliveryIntents(master.id, boundary)) {
          const target = store.getAgent(intent.targetAgentId);
          if (!target || target.archived || !target.conversationIds.includes(master.id)) continue;
          if (messageReceiptKey) collaborationDeliveries.rememberMessageReceipt(messageReceiptKey, message.id);
          const queued = collaborationDeliveries.queue({
            conversationId: master.id,
            messageId: message.id,
            communicationEventId: message.communicationEventId,
            targetAgentId: intent.targetAgentId,
            authorAgentId: message.authorAgentId,
            text: message.text,
            relayDepth: intent.relayDepth,
            mentionTrail: intent.mentionTrail,
            kind: intent.kind,
            audience: intent.audience,
            createdAt: message.createdAt,
            orderKey: deliveryOrderKey,
            sourceChannel: intent.kind === "direct" ? "main" : undefined,
            attachmentIds: intent.kind === "direct" ? message.attachments?.map((item) => item.id) : undefined,
          });
          recipients.add(intent.targetAgentId);
        }
      }
    }
    return [...recipients];
  }

  app.addHook("onRequest", async (request, reply) => {
    const provided = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if ((request.url === "/api/agent-messages" || request.url === "/api/agent-spawns" || request.url === "/api/agent-waits" || request.url.startsWith("/api/agent-documents/") || request.url === "/api/agent-directory" || request.url.startsWith("/api/agent-directory/") || request.url === "/api/agent-session/rollover") && provided && agentMessageCapabilities.has(provided)) return;
    if (!opts.authToken) return;
    if (request.url === "/api/health" || request.url === "/api/ready") return;
    if (!secretEqual(provided, opts.authToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/") || !["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
    const origin = request.headers.origin;
    if (!origin) return; // Non-browser clients and host-local runtime bridges.
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return reply.code(403).send({ error: "cross-origin mutation forbidden" });
    }
    const requestHost = request.headers.host?.toLowerCase();
    if (!requestHost || originHost !== requestHost) {
      return reply.code(403).send({ error: "cross-origin mutation forbidden" });
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    return payload;
  });

  app.addHook("onReady", async () => {
    // Resume handoffs left queued or unacknowledged by a previous process after
    // Fastify has finished registering the internal dispatch route.
    const interruptedDeliveryIds = new Set(runLedger.all()
      .filter((claim) => claim.state === "interrupted")
      .flatMap((claim) => claim.deliveryIds ?? []));
    const recipients = new Set(collaborationDeliveries.recoverUnacknowledged(interruptedDeliveryIds));
    for (const agentId of reconcileCanonicalInbox()) recipients.add(agentId);
    for (const wait of agentWaits.allActive()) scheduleWaitDeadline(wait);
    for (const agentId of recipients) {
      scheduleDeliveryDispatch(agentId);
    }
    const reconcileAssets = async () => {
      for (const project of store.listProjects()) {
        for (const agent of store.listAgents(project.id)) {
          const associated = new Set(store.getMessages(agent.id).flatMap((message) => message.attachments?.map((item) => item.id) ?? []));
          await assets.reconcile(project.id, agent.id, associated);
        }
      }
    };
    await reconcileAssets();
    assetSweep = setInterval(() => { if (!closed) void reconcileAssets(); }, 60 * 60 * 1000);
    assetSweep.unref();
  });

  app.addHook("onClose", async () => {
    closed = true;
    for (const timer of deliveryRetryTimers.values()) clearTimeout(timer);
    deliveryRetryTimers.clear();
    for (const timer of waitDeadlineTimers.values()) clearTimeout(timer);
    waitDeadlineTimers.clear();
    if (assetSweep) clearInterval(assetSweep);
    for (const [agentId, run] of activeRuns) {
      clearRunLeaseTimer(run);
      clearRunLivenessTimer(run);
      transitionRun(agentId, run, "interrupted");
      run.controller.abort();
    }
    activeRuns.clear();
    for (const runtime of runtimeSessions.values()) cancelRuntimeIdleClose(runtime);
    await Promise.allSettled([...runtimeSessions.values()].map(({ session }) => session.close()));
    runtimeSessions.clear();
    await Promise.allSettled([...deliveryDispatches]);
    assets.close();
    store.close();
  });

  function publish(agentId: string, stored: StoredLogEvent): void {
    for (const subscriber of subscribers.get(agentId) ?? []) subscriber(stored);
  }

  function projectBroadcastToAgentAudit(
    agentId: string,
    event: Extract<CommunicationEvent, { intent: "broadcast" }>,
    attachments?: AssetDto[],
  ): void {
    if (store.readCommunicationProjections(event.projectId).some((projection) =>
      projection.eventId === event.eventId && projection.surface === "direct_agent_audit" &&
      projection.projectionKey === agentId && projection.message)) return;
    const role = event.sender.kind === "user" ? "user" : event.sender.kind === "system" ? "system" : "assistant";
    const stored = store.appendEvent(agentId, {
      type: "communication_projection",
      communicationEventId: event.eventId,
      text: renderScopedMessage("broadcast", event.text),
      role,
      attachments,
    });
    publish(agentId, stored);
  }

  function projectBroadcastToAgentAudits(
    event: Extract<CommunicationEvent, { intent: "broadcast" }>,
    excludedAgentIds: Iterable<string> = [],
    attachments?: AssetDto[],
  ): void {
    const excluded = new Set(excludedAgentIds);
    // A Broadcast is shared through its Conversation context, not copied into
    // every agent's private history. Only its actual agent author owns a local
    // audit projection; user/system broadcasts have no individual author.
    if (event.sender.kind !== "agent" || excluded.has(event.sender.agentId)) return;
    const author = store.getAgent(event.sender.agentId);
    if (author && !author.archived) projectBroadcastToAgentAudit(author.id, event, attachments);
  }

  function subscribe(agentId: string, subscriber: Subscriber): () => void {
    let set = subscribers.get(agentId);
    if (!set) {
      set = new Set();
      subscribers.set(agentId, set);
    }
    set.add(subscriber);
    return () => {
      set?.delete(subscriber);
      if (set?.size === 0) subscribers.delete(agentId);
    };
  }

  function resolveCollaborationIntents(
    conversationId: string,
    authorAgentId: string,
    text: string,
    _relayDepth: number,
    mentionTrail: string[],
  ): { intents: ConversationDeliveryIntent[]; blocked: Array<{ title: string; reason: string }> } {
    const detail = collaborationViewDetail(conversationId);
    const eligible = detail?.agents.filter((agent) => !agent.archived && agent.id !== authorAgentId) ?? [];
    const targetsById = new Map(
      mentionedAgents(text, eligible, authorAgentId).map((agent) => [agent.id, agent]),
    );
    if (hasEveryoneMention(text)) {
      for (const agent of eligible) targetsById.set(agent.id, agent);
    }
    const targets = [...targetsById.values()];
    const intents: ConversationDeliveryIntent[] = [];
    const blocked: Array<{ title: string; reason: string }> = [];
    for (const target of targets) {
      const fingerprint = mentionRelayFingerprint(authorAgentId, target.id, text);
      const blockedReason = authorAgentId && mentionTrail.includes(fingerprint)
        ? "the same handoff already occurred in this collaboration chain"
        : undefined;
      if (blockedReason) {
        blocked.push({ title: target.title, reason: blockedReason });
      } else {
        const nextTrail = authorAgentId ? advanceMentionTrail(mentionTrail, fingerprint) : [];
        intents.push({
          targetAgentId: target.id,
          relayDepth: nextTrail.length,
          mentionTrail: nextTrail,
          kind: "tag",
          audience: hasEveryoneMention(text) ? "everyone" : "mention",
        });
      }
    }
    return { intents, blocked };
  }

  function resolveExplicitCollaborationIntents(
    conversationId: string,
    authorAgentId: string,
    recipientAgentIds: string[],
    text: string,
    _relayDepth: number,
    mentionTrail: string[],
  ): { text: string; intents: ConversationDeliveryIntent[]; error?: string } {
    const detail = store.getCollaborationViewDetail(conversationId);
    const members = new Map((detail?.agents ?? []).map((agent) => [agent.id, agent]));
    const targetIds = [...new Set(recipientAgentIds)];
    const targets = targetIds.map((id) => members.get(id));
    if (targets.some((target) => !target || target.archived || target.id === authorAgentId)) {
      return { text, intents: [], error: "every collaboration recipient must be a different active agent in this conversation" };
    }
    const renderedText = `${targets.map((target) => `#${agentMentionHandle(target!.title)}`).join(" ")} ${text}`;
    const intents: ConversationDeliveryIntent[] = [];
    for (const target of targets) {
      const fingerprint = mentionRelayFingerprint(authorAgentId, target!.id, renderedText);
      if (mentionTrail.includes(fingerprint)) {
        return { text, intents: [], error: "the same collaboration handoff already occurred in this delivery chain" };
      }
      const nextTrail = advanceMentionTrail(mentionTrail, fingerprint);
      intents.push({
        targetAgentId: target!.id,
        relayDepth: nextTrail.length,
        mentionTrail: nextTrail,
        kind: "tag",
        audience: "mention",
      });
    }
    return { text: renderedText, intents };
  }

  function queueRecordedCollaborationMessage(
    conversationId: string,
    message: ConversationMessageDto,
    authorAgentId: string | undefined,
    intents: ConversationDeliveryIntent[],
  ): void {
    const orderKey = store.getConversationMessageDeliveryOrderKey(conversationId, message.id);
    const master = store.getConversation(conversationId);
    const communication = master && message.communicationEventId
      ? store.getCommunicationEvent(master.projectId, message.communicationEventId)
      : undefined;
    const deliveryText = communication?.document
      ? `${message.text}\n\nDocument: ${communication.document.title} (id: ${communication.document.id}). Retrieve it on demand with PONDEROSA_DOCUMENT_URL.`
      : message.text;
    for (const intent of intents) {
      queueCollaborationDelivery({
        conversationId,
        messageId: message.id,
        communicationEventId: message.communicationEventId,
        targetAgentId: intent.targetAgentId,
        authorAgentId,
        text: deliveryText,
        relayDepth: intent.relayDepth,
        mentionTrail: intent.mentionTrail,
        kind: intent.kind,
        audience: intent.audience,
        createdAt: message.createdAt,
        orderKey,
        replyToMessageId: message.replyTo?.messageId,
      });
    }
  }

  function appendBlockedMentionWarnings(
    conversationId: string,
    blocked: Array<{ title: string; reason: string }>,
  ): void {
    for (const item of blocked) {
      appendCollaborationSystemNotice(
        conversationId,
        `⚠️ #${agentMentionHandle(item.title)} was not notified because ${item.reason}. Please ask the manager to continue the conversation.`,
      );
    }
  }

  function appendCollaborationSystemNotice(
    conversationId: string,
    text: string,
    idempotencyKey?: string,
  ): ConversationMessageDto | undefined {
    const master = store.getConversation(conversationId);
    if (!master) return undefined;
    const communication = recordCommunication({
      eventId: randomUUID(), schemaVersion: 1, projectId: master.projectId, conversationId,
      sender: { kind: "system", component: "collaboration-supervision" },
      intent: "direct_to_user", audience: { kind: "user", userId: "local-operator" },
      text, createdAt: new Date().toISOString(), ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    const existing = communication
      ? store.getConversationMessages(conversationId, "collaboration").find((message) => message.communicationEventId === communication.eventId)
      : undefined;
    if (existing) return existing;
    return store.appendConversationMessage(
      conversationId, { role: "system", text }, undefined, "collaboration", undefined, undefined, communication?.eventId,
    );
  }

  function notifyManagerOfChildFailure(childAgentId: string, executionId: string, failure: string): void {
    if (closed) return;
    const child = store.getAgent(childAgentId);
    const manager = child?.managerAgentId ? store.getAgent(child.managerAgentId) : undefined;
    if (!child || !manager || manager.archived) return;
    const createdAt = new Date().toISOString();
    queueCollaborationDelivery({
      conversationId: child.conversationIds.find((id) => manager.conversationIds.includes(id)),
      messageId: `managed-agent:${child.id}:${executionId}:failure`,
      targetAgentId: manager.id,
      authorAgentId: child.id,
      text: [
        "Internal managed-agent update (not a chat message).",
        `${child.title} (${child.id}) encountered a runtime failure during execution ${executionId}.`,
        `Failure: ${failure}`,
        "The agent remains in your organization and can be steered or retried.",
      ].join("\n"),
      relayDepth: 0,
      mentionTrail: [],
      kind: "manager_notification",
      createdAt,
      orderKey: store.nextDeliveryOrderKey(createdAt),
    });
  }

  app.get("/api/agent-directory", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    const author = capability ? store.getAgent(capability.agentId) : undefined;
    if (!capability || !active || active.runId !== capability.runId || active.messageCapability !== token || !author) {
      return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    }
    return teamDirectory(author.projectId);
  });

  app.get<{ Params: { agentId: string } }>("/api/agent-directory/:agentId", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    const author = capability ? store.getAgent(capability.agentId) : undefined;
    if (!capability || !active || active.runId !== capability.runId || active.messageCapability !== token || !author) {
      return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    }
    const entry = teamDirectory(author.projectId).agents.find((agent) => agent.agentId === request.params.agentId);
    return entry ?? reply.code(404).send({ error: "agent not found in this project" });
  });

  app.post<{
    Body: SendAgentMessageRequest;
  }>("/api/agent-messages", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    if (!capability) return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    const active = activeRuns.get(capability.agentId);
    if (!active || active.runId !== capability.runId || active.messageCapability !== token) {
      return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    }
    const intent = request.body?.intent;
    const text = request.body?.text?.trim();
    if (!(["broadcast", "direct_to_user", "collaboration"] as const).includes(intent)) {
      return reply.code(400).send({ error: "intent must be broadcast, direct_to_user, or collaboration" });
    }
    const currentAuthor = store.getAgent(capability.agentId);
    if (intent === "broadcast" && currentAuthor?.managerAgentId) {
      return reply.code(409).send({
        error: "managed agents cannot broadcast; use collaboration with the agents who need the information",
        managerAgentId: currentAuthor.managerAgentId,
      });
    }
    if (!text) return reply.code(400).send({ error: "text is required" });
    const scopedText = intent === "broadcast" ? stripLeadingScopeTag(text, "broadcast") : text;
    if (!scopedText) return reply.code(400).send({ error: "text is required after the broadcast scope" });
    if (text.length > 4000) return reply.code(400).send({ error: "text must be 4000 characters or fewer" });
    const requestedDocument = request.body?.document;
    if (requestedDocument && (requestedDocument.mediaType && requestedDocument.mediaType !== "text/markdown")) {
      return reply.code(400).send({ error: "document mediaType must be text/markdown" });
    }
    const documentTitle = requestedDocument?.title?.trim();
    const documentContent = requestedDocument?.content;
    if (requestedDocument && (!documentTitle || !documentContent?.trim())) return reply.code(400).send({ error: "document title and content are required" });
    if (documentTitle && documentTitle.length > 160) return reply.code(400).send({ error: "document title must be 160 characters or fewer" });
    if (documentContent && Buffer.byteLength(documentContent, "utf8") > 256 * 1024) return reply.code(413).send({ error: "document must be 256 KiB or fewer" });
    const idempotencyKey = request.body?.idempotencyKey?.trim();
    if (idempotencyKey && idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 200 characters or fewer" });
    const receiptKey = idempotencyKey ? `${capability.runId}:${intent}:${idempotencyKey}` : undefined;
    if (receiptKey) {
      const previousMessageId = collaborationDeliveries.messageReceipt(receiptKey);
      if (previousMessageId) return { intent, messageId: previousMessageId, replayed: true };
    }

    if (!currentAuthor || currentAuthor.archived) {
      return reply.code(409).send({ error: "agent is no longer available" });
    }
    const document = documentTitle && documentContent ? {
      id: randomUUID(), title: documentTitle, mediaType: "text/markdown" as const,
      content: documentContent, byteLength: Buffer.byteLength(documentContent, "utf8"),
      authorAgentId: capability.agentId, executionId: capability.runId,
      createdAt: new Date().toISOString(),
    } : undefined;

    if (intent === "direct_to_user") {
      const communication = recordCommunication({
        eventId: randomUUID(),
        schemaVersion: 2,
        projectId: currentAuthor.projectId,
        ...(capability.conversationId ? { conversationId: capability.conversationId } : {}),
        sender: { kind: "agent", agentId: capability.agentId, executionId: capability.runId },
        intent: "user_dm",
        audience: { kind: "user_agent", userId: "local-operator", agentId: capability.agentId },
        text,
        ...(document ? { document } : {}),
        createdAt: new Date().toISOString(),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      store.appendCommunicationProjection(currentAuthor.projectId, {
        eventId: communication.eventId,
        surface: "user_inbox",
        projectionKey: "local-operator",
        projectedAt: communication.createdAt,
      });
      if (capability.conversationId) {
        store.appendConversationMessage(
          capability.conversationId,
          { text: renderScopedMessage("user", text) },
          capability.agentId,
          "main",
          undefined,
          undefined,
          communication.eventId,
        );
      }
      const stored = store.appendEvent(capability.agentId, {
        type: "communication_projection", communicationEventId: communication.eventId, text,
      });
      publish(capability.agentId, stored);
      const messageId = `agent-event-${stored.seq}`;
      if (receiptKey) collaborationDeliveries.rememberMessageReceipt(receiptKey, messageId);
      return { intent, eventId: communication.eventId, messageId, replayed: false };
    }
    if (!capability.conversationId) {
      return reply.code(409).send({ error: "agent is not linked to a conversation" });
    }
    if (!currentAuthor.conversationIds.includes(capability.conversationId)) {
      return reply.code(409).send({ error: "agent is no longer an active member of this conversation" });
    }
    let renderedText = scopedText;
    let routing: { intents: ConversationDeliveryIntent[]; blocked: Array<{ title: string; reason: string }> } = { intents: [], blocked: [] };
    if (intent === "collaboration") {
      const recipientAgentIds = request.body.recipientAgentIds;
      if (!Array.isArray(recipientAgentIds) || recipientAgentIds.length === 0) {
        return reply.code(400).send({ error: "collaboration requires at least one recipientAgentId" });
      }
      if (recipientAgentIds.length > 100) return reply.code(400).send({ error: "collaboration supports at most 100 recipients" });
      const resolved = resolveExplicitCollaborationIntents(
        capability.conversationId,
        capability.agentId,
        recipientAgentIds,
        text,
        capability.mentionDepth,
        capability.mentionTrail,
      );
      if (resolved.error) return reply.code(400).send({ error: resolved.error });
      renderedText = resolved.text;
      routing = { intents: resolved.intents, blocked: [] };
    }
    const channel = intent === "broadcast" ? "main" : "collaboration";
    const communication = recordCommunication(intent === "broadcast" ? {
      eventId: randomUUID(),
      schemaVersion: 2,
      projectId: currentAuthor.projectId,
      conversationId: capability.conversationId,
      sender: { kind: "agent", agentId: capability.agentId, executionId: capability.runId },
      intent,
      audience: { kind: "organization", organizationId: currentAuthor.projectId },
      text: scopedText,
      ...(document ? { document } : {}),
      createdAt: new Date().toISOString(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    } : {
      eventId: randomUUID(),
      schemaVersion: 2,
      projectId: currentAuthor.projectId,
      conversationId: capability.conversationId,
      sender: { kind: "agent", agentId: capability.agentId, executionId: capability.runId },
      intent,
      audience: { kind: "agents", agentIds: routing.intents.map((item) => item.targetAgentId) as [string, ...string[]] },
      text,
      ...(document ? { document } : {}),
      createdAt: new Date().toISOString(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    const message = store.appendConversationMessage(
      capability.conversationId,
      { role: "assistant", text: renderedText },
      capability.agentId,
      channel,
      routing.intents,
      receiptKey,
      communication?.eventId,
    );
    if (!message) return reply.code(404).send({ error: "conversation not found" });
    if (communication?.intent === "broadcast") projectBroadcastToAgentAudits(communication, [], message.attachments);
    if (communication?.intent === "collaboration") {
      const authorAudit = store.appendEvent(capability.agentId, {
        type: "communication_projection",
        communicationEventId: communication.eventId,
        text: renderedText,
        role: "assistant",
        attachments: message.attachments,
      });
      publish(capability.agentId, authorAudit);
    }
    if (receiptKey) collaborationDeliveries.rememberMessageReceipt(receiptKey, message.id);
    if (intent === "collaboration") {
      queueRecordedCollaborationMessage(capability.conversationId, message, capability.agentId, routing.intents);
      appendBlockedMentionWarnings(capability.conversationId, routing.blocked);
    }
    return { intent, eventId: communication?.eventId, messageId: message.id, replayed: false };
  });

  function agentCanReadDocument(event: CommunicationEvent, agentId: string): boolean {
    const agent = store.getAgent(agentId);
    if (!agent || agent.projectId !== event.projectId || agent.archived) return false;
    if (event.intent === "broadcast") return !event.conversationId || agent.conversationIds.includes(event.conversationId);
    if (event.schemaVersion === 2 && event.intent === "user_dm") {
      return event.sender.kind === "agent" && event.sender.agentId === agentId;
    }
    if (event.intent === "collaboration") {
      return event.audience.agentIds.includes(agentId) || (event.sender.kind === "agent" && event.sender.agentId === agentId);
    }
    return event.sender.kind === "agent" && event.sender.agentId === agentId;
  }

  app.get<{ Params: { documentId: string } }>("/api/agent-documents/:documentId", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    if (!capability || !active || active.runId !== capability.runId || active.messageCapability !== token) {
      return reply.code(401).send({ error: "invalid or expired agent document capability" });
    }
    const agent = store.getAgent(capability.agentId);
    const found = agent ? store.getCommunicationDocument(agent.projectId, request.params.documentId) : undefined;
    if (!found || !agentCanReadDocument(found.event, capability.agentId)) return reply.code(404).send({ error: "document not found" });
    return { ...found.document };
  });

  app.post("/api/agent-session/rollover", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    if (!capability) return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    const active = activeRuns.get(capability.agentId);
    if (!active || active.runId !== capability.runId || active.messageCapability !== token) {
      return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    }
    scheduledSessionRollovers.set(capability.agentId, new Date().toISOString());
    return { scheduled: true, afterRunId: capability.runId };
  });

  app.post<{ Body: AgentWaitRequest }>("/api/agent-waits", async (request, reply): Promise<AgentWaitResponse | unknown> => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    const agent = capability ? store.getAgent(capability.agentId) : undefined;
    if (!capability || !active || active.runId !== capability.runId || active.messageCapability !== token || !agent) {
      return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    }
    const mode = request.body?.mode;
    const expectedAgentIds = Array.isArray(request.body?.expectedAgentIds)
      ? [...new Set(request.body.expectedAgentIds.map((id) => id?.trim()).filter(Boolean))]
      : [];
    if (!(mode === "all" || mode === "any" || mode === "quorum")) {
      return reply.code(400).send({ error: "mode must be all, any, or quorum" });
    }
    if (expectedAgentIds.length === 0 || expectedAgentIds.length > 100 || expectedAgentIds.length !== request.body.expectedAgentIds.length) {
      return reply.code(400).send({ error: "expectedAgentIds must contain 1 to 100 unique stable agent IDs" });
    }
    const expectedAgents = expectedAgentIds.map((id) => store.getAgent(id));
    if (expectedAgents.some((candidate) => !candidate || candidate.archived || candidate.projectId !== agent.projectId || candidate.id === agent.id)) {
      return reply.code(400).send({ error: "every expected reporter must be another active agent in this project" });
    }
    const quorum = mode === "all" ? expectedAgentIds.length : mode === "any" ? 1 : request.body.quorum;
    if (!Number.isInteger(quorum) || quorum! < 1 || quorum! > expectedAgentIds.length) {
      return reply.code(400).send({ error: "quorum must be an integer between 1 and the number of expected reporters" });
    }
    const deadline = request.body.deadline?.trim();
    if (deadline && (!Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= deliveryNow())) {
      return reply.code(400).send({ error: "deadline must be a future ISO-8601 timestamp" });
    }
    const registered = agentWaits.register({
      agentId: agent.id,
      executionId: capability.runId,
      mode,
      expectedAgentIds,
      quorum: quorum!,
      deliveryWatermark: collaborationDeliveries.watermark(),
      ...(deadline ? { deadline } : {}),
    });
    scheduleWaitDeadline(registered.wait);
    return {
      waitId: registered.wait.id,
      mode: registered.wait.mode,
      expectedAgentIds: registered.wait.expectedAgentIds,
      quorum: registered.wait.quorum,
      ...(registered.wait.deadline ? { deadline: registered.wait.deadline } : {}),
      replayed: registered.replayed,
    };
  });

  app.post<{ Body: AgentSpawnRequest & Record<string, unknown> }>(
    "/api/agent-spawns",
    async (request, reply) => {
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
      const capability = token ? agentMessageCapabilities.get(token) : undefined;
      const active = capability ? activeRuns.get(capability.agentId) : undefined;
      const parent = capability ? store.getAgent(capability.agentId) : undefined;
      if (!capability || !active || active.runId !== capability.runId || active.messageCapability !== token || !parent) {
        return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
      }
      const forbiddenOwnership = ["managerAgentId", "parentAgentId", "agentId", "conversationId", "executionId"]
        .find((field) => request.body && field in request.body);
      if (forbiddenOwnership) {
        return reply.code(403).send({ error: `ownership field ${forbiddenOwnership} is server-controlled` });
      }
      const input = request.body;
      const displayName = input?.displayName?.trim();
      const initialMessage = input?.initialMessage?.trim();
      const idempotencyKey = input?.idempotencyKey?.trim();
      if (!displayName || !idempotencyKey) {
        return reply.code(400).send({ error: "displayName and idempotencyKey are required" });
      }
      if (displayName.length > 100 || (initialMessage?.length ?? 0) > MAX_TEXT_LENGTH || idempotencyKey.length > 200) {
        return reply.code(400).send({ error: "agent creation fields exceed their size limits" });
      }
      const conversationId = capability.conversationId ?? parent.conversationId;
      const conversation = conversationId ? store.getConversation(conversationId) : undefined;
      if (!conversation || conversation.projectId !== parent.projectId || !parent.conversationIds.includes(conversation.id)) {
        return reply.code(409).send({ error: "spawning agent must belong to an active conversation" });
      }
      const roomId = conversation.id;
      const preset = input.presetId ? store.getAgentPreset(input.presetId) : undefined;
      if (input.presetId && (!preset || preset.projectId !== parent.projectId || !preset.enabled)) {
        return reply.code(400).send({ error: "preset is unavailable for this project" });
      }
      const runtime = preset?.engine ?? input.runtime?.trim() ?? parent.activeEngine;
      const configuredRuntime = engines.get(runtime);
      if (!configuredRuntime) return reply.code(400).send({ error: "runtime is not configured" });
      const parentRuns = store.getRuns(parent.id);
      const latestParentRun = [...parentRuns].reverse().find((run) => run.engine === runtime);
      const inheritParentSelection = runtime === parent.activeEngine;
      const requestedModel = input.model?.trim() || undefined;
      const requestedEffort = input.effort?.trim() || undefined;
      const inherited = inheritParentSelection
        ? normalizedRuntimeSelection(
            configuredRuntime.adapter,
            latestParentRun ? latestParentRun.model : parent.model ?? parent.presetSnapshot?.model,
            latestParentRun ? latestParentRun.effort : parent.effort ?? parent.presetSnapshot?.effort,
          )
        : {};
      const hasModelOverride = preset?.model !== undefined || input.model !== undefined;
      const modelOverride = preset?.model ?? requestedModel;
      if (hasModelOverride) {
        const modelError = runtimeSelectionError(configuredRuntime.adapter, modelOverride, undefined);
        if (modelError) return reply.code(400).send({ error: modelError });
      }
      const model = hasModelOverride ? modelOverride : inherited.model;
      const hasEffortOverride = preset?.effort !== undefined || input.effort !== undefined;
      const effortOverride = preset?.effort ?? requestedEffort;
      if (hasEffortOverride) {
        const effortError = runtimeSelectionError(configuredRuntime.adapter, model, effortOverride);
        if (effortError) return reply.code(400).send({ error: effortError });
      }
      const effort = hasEffortOverride ? effortOverride : hasModelOverride ? undefined : inherited.effort;

      const replay = store.findAgentSpawn(parent.id, capability.runId, idempotencyKey);
      if (replay) {
        if (replay.title !== displayName || replay.spawnPrompt !== initialMessage || replay.activeEngine !== runtime ||
          replay.model !== model || replay.effort !== effort || replay.presetSnapshot?.id !== preset?.id) {
          return reply.code(409).send({ error: "idempotencyKey was already used with different agent creation fields" });
        }
        return { agent: replay, accepted: true, replayed: true };
      }

      let child: AgentDto | undefined;
      try {
        child = store.createAgent(parent.projectId, {
          title: displayName,
          engine: runtime,
          conversationId: roomId,
          model,
          effort,
          presetId: preset?.id,
          managerAgentId: parent.id,
        }, {
          agentId: parent.id,
          executionId: capability.runId,
          idempotencyKey,
          prompt: initialMessage,
        });
        if (initialMessage) {
          const routing = resolveExplicitCollaborationIntents(
            roomId,
            parent.id,
            [child.id],
            initialMessage,
            capability.mentionDepth,
            capability.mentionTrail,
          );
          if (routing.error) throw new Error(routing.error);
          const communication = recordCommunication({
            eventId: randomUUID(),
            schemaVersion: 2,
            projectId: parent.projectId,
            conversationId: roomId,
            sender: { kind: "agent", agentId: parent.id, executionId: capability.runId },
            intent: "collaboration",
            audience: { kind: "agents", agentIds: [child.id] },
            text: initialMessage,
            createdAt: new Date().toISOString(),
            idempotencyKey: `agent-spawn:${capability.runId}:${idempotencyKey}`,
          });
          const message = store.appendConversationMessage(
            roomId,
            { role: "assistant", text: routing.text },
            parent.id,
            "collaboration",
            routing.intents,
            undefined,
            communication.eventId,
          );
          if (!message) throw new Error("spawn message could not be recorded");
          queueRecordedCollaborationMessage(roomId, message, parent.id, routing.intents);
        }
        return reply.code(201).send({ agent: child, accepted: true, replayed: false });
      } catch (error) {
        if (child) store.deleteAgent(child.id);
        return reply.code(409).send({ error: error instanceof Error ? error.message : "agent could not be created" });
      }
    },
  );

  app.get("/api/health", async (): Promise<HealthDto> => ({
    status: "ok",
    service: "ponderosa",
    version: "0.0.0",
    revision: opts.buildRevision?.trim() || "development",
  }));

  app.get("/api/ready", async (_request, reply): Promise<ReadinessDto> => {
    let dataDirectory: ReadinessDto["checks"]["dataDirectory"];
    try {
      await fs.access(opts.dataDir, fsConstants.R_OK | fsConstants.W_OK);
      dataDirectory = { ok: true, detail: "data directory is readable and writable" };
    } catch (error) {
      dataDirectory = { ok: false, detail: `data directory unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }

    let projections: ReadinessDto["checks"]["projections"];
    try {
      store.listProjects();
      projections = { ok: true, detail: "projection database query succeeded" };
    } catch (error) {
      projections = { ok: false, detail: `projection database unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }

    const runtimeStatuses = await Promise.all([...engines.entries()].map(async ([id, registration]) => {
      try {
        const status = registration.authStatus
          ? await engineAuthStatuses.get(id, registration.authStatus)
          : { authenticated: true, detail: "runtime registered (authentication status not reported)" };
        return { id, authenticated: status.authenticated, ...(status.detail ? { detail: status.detail } : {}) };
      } catch (error) {
        return { id, authenticated: false, detail: `runtime check failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    }));
    const available = runtimeStatuses.filter((runtime) => runtime.authenticated).length;
    const runtimes = {
      ok: available > 0,
      detail: engines.size === 0
        ? "no runtimes are configured"
        : `${available} of ${engines.size} configured runtimes available`,
    };
    const communicationReports = store.listProjects().map((project) => ({
      projectId: project.id,
      report: store.reconcileCommunicationEvents(project.id),
    }));
    const driftedProjects = communicationReports.filter(({ report }) => !report.ok).map(({ projectId }) => projectId);
    const communicationParity = driftedProjects.length === 0;
    const communicationMigration = {
      ok: communicationParity,
      detail: communicationParity
        ? "canonical communication projections=ok"
        : `canonical communication projections=drift in ${driftedProjects.length} quarantined project(s); new work remains available`,
    };
    // Projection drift is project-scoped diagnostic state. It must not make
    // unrelated clean projects or the entire daemon reject new work.
    const canAcceptWork = !closed && dataDirectory.ok && projections.ok && runtimes.ok;
    const body: ReadinessDto = {
      status: canAcceptWork ? "ready" : "not_ready",
      service: "ponderosa",
      version: "0.0.0",
      canAcceptWork,
      checks: {
        daemon: { ok: !closed, detail: closed ? "daemon is shutting down" : "daemon request loop is running" },
        dataDirectory,
        projections,
        runtimes,
        communicationMigration,
      },
      runtimes: runtimeStatuses,
    };
    if (!canAcceptWork) reply.code(503);
    return body;
  });

  app.get("/api/projects", async () => store.listProjects());
  app.get("/api/project-folders", async (): Promise<ProjectFolderOptionsDto> => {
    await fs.mkdir(managedWorkspacesRoot, { recursive: true });
    const registered = store.listProjects().map((project) => ({ hostPath: project.hostPath, name: project.label, source: "registered" as const }));
    const managedEntries = await fs.readdir(managedWorkspacesRoot, { withFileTypes: true });
    const managed = managedEntries.filter((entry) => entry.isDirectory()).map((entry) => ({
      hostPath: path.join(managedWorkspacesRoot, entry.name), name: entry.name, source: "managed" as const,
    }));
    const folders = new Map<string, ProjectFolderOptionsDto["folders"][number]>();
    for (const folder of [...registered, ...managed]) if (!folders.has(folder.hostPath)) folders.set(folder.hostPath, folder);
    return { managedRoot: managedWorkspacesRoot, folders: [...folders.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  });

  app.post<{ Body: CreateProjectRequest }>("/api/projects", async (request, reply) => {
    const label = request.body?.label?.trim();
    if (!label) return reply.code(400).send({ error: "label is required" });
    if (request.body.hostPath && request.body.createFolderName) return reply.code(400).send({ error: "choose an existing folder or create a new one, not both" });
    await fs.mkdir(managedWorkspacesRoot, { recursive: true });
    let hostPath: string;
    if (request.body.hostPath) {
      const candidate = path.resolve(request.body.hostPath);
      try {
        const stat = await fs.stat(candidate);
        if (!stat.isDirectory()) return reply.code(400).send({ error: "hostPath must be a directory" });
        hostPath = await fs.realpath(candidate);
      } catch {
        return reply.code(400).send({ error: "hostPath does not exist" });
      }
    } else {
      const requestedName = request.body.createFolderName?.trim();
      if (requestedName && (!/^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,79}$/u.test(requestedName) || requestedName === "." || requestedName === "..")) {
        return reply.code(400).send({ error: "folder name must be a single safe name" });
      }
      const automaticName = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "project"}-${randomUUID().slice(0, 8)}`;
      hostPath = path.join(managedWorkspacesRoot, requestedName || automaticName);
      try {
        await fs.mkdir(hostPath, { recursive: false });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return reply.code(409).send({ error: "folder already exists" });
        throw error;
      }
    }
    return store.createProject({ label, hostPath });
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const project = store.getProject(request.params.id);
    return project ?? reply.code(404).send({ error: "project not found" });
  });

  app.patch<{ Params: { id: string }; Body: UpdateProjectRequest }>("/api/projects/:id", async (request, reply) => {
    const label = request.body?.label?.trim();
    if (!label) return reply.code(400).send({ error: "label is required" });
    return store.updateProject(request.params.id, { label }) ?? reply.code(404).send({ error: "project not found" });
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const project = store.getProject(request.params.id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const agents = store.listAgents(project.id);
    const agentIds = new Set(agents.map((agent) => agent.id));
    for (const agentId of agentIds) deletingAgentIds.add(agentId);
    const conversationIds = new Set(store.listConversations(project.id).map((master) => master.id));
    for (const agentId of agentIds) {
      const active = activeRuns.get(agentId);
      if (active) {
        clearRunLeaseTimer(active);
        clearRunLivenessTimer(active);
        active.controller.abort();
        activeRuns.delete(agentId);
        agentMessageCapabilities.delete(active.messageCapability);
      }
      const runtime = runtimeSessions.get(agentId);
      if (runtime) {
        removePersistentRuntime(agentId, runtime);
        await runtime.session.close().catch(() => undefined);
      }
      subscribers.delete(agentId);
      dispatchingTurns.delete(agentId);
      scheduledSessionRollovers.delete(agentId);
      clearWaitDeadline(agentId);
    }
    collaborationDeliveries.deleteAgents(agentIds);
    agentWaits.deleteAgents(agentIds);
    userReactions.deleteProject(project.id);
    contextCursors.deleteAgents(agentIds);
    runLedger.deleteAgents(agentIds);
    store.deleteProject(project.id);
    for (const agentId of agentIds) deletingAgentIds.delete(agentId);
    engineCapabilityCache.clear();
    return { deleted: true };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/communication-reconciliation", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    const report = store.reconcileCommunicationEvents(request.params.id);
    if (!report.ok) reply.code(409);
    return report;
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/agent-health", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    return agentHealth(
      { type: "project", id: request.params.id },
      store.listAgents(request.params.id),
    );
  });

  app.get("/api/usage", async () => projectedUsage({ type: "overall" }));

  app.get<{ Params: { id: string } }>("/api/projects/:id/usage", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    return projectedUsage({ type: "project", id: request.params.id });
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/team-directory", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    return teamDirectory(request.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/conversations", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    return store.listConversations(request.params.id);
  });

  app.post<{
    Params: { id: string };
    Body: { title: string; defaultEngine?: string; defaultModel?: string; defaultEffort?: string };
  }>("/api/projects/:id/conversations", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    if (!request.body?.title) return reply.code(400).send({ error: "title is required" });
    if (request.body.defaultEngine && !engines.has(request.body.defaultEngine)) {
      return reply.code(400).send({ error: "unknown engine" });
    }
    if (!request.body.defaultEngine && (request.body.defaultModel || request.body.defaultEffort)) {
      return reply.code(400).send({ error: "default engine is required when selecting a model or effort" });
    }
    if (request.body.defaultEngine) {
      const selectionError = runtimeSelectionError(
        engines.get(request.body.defaultEngine)!.adapter,
        request.body.defaultModel,
        request.body.defaultEffort,
      );
      if (selectionError) return reply.code(400).send({ error: selectionError });
    }
    return store.createConversation(request.params.id, request.body);
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const detail = conversationDetail(request.params.id);
    return detail ?? reply.code(404).send({ error: "conversation not found" });
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id/agent-health", async (request, reply) => {
    const master = store.getConversation(request.params.id);
    if (!master) return reply.code(404).send({ error: "conversation not found" });
    const agents = store.listAgents(master.projectId).filter((agent) => agent.conversationIds.includes(master.id));
    return agentHealth({ type: "conversation", id: master.id }, agents);
  });

  app.patch<{
    Params: { id: string };
    Body: {
      title?: string;
      defaultEngine?: string | null;
      defaultModel?: string | null;
      defaultEffort?: string | null;
      archived?: boolean;
    };
  }>("/api/conversations/:id", async (request, reply) => {
    const current = store.getConversation(request.params.id);
    if (!current) return reply.code(404).send({ error: "conversation not found" });
    if (request.body?.defaultEngine && !engines.has(request.body.defaultEngine)) {
      return reply.code(400).send({ error: "unknown engine" });
    }
    const defaultEngine = request.body.defaultEngine === null ? undefined : request.body.defaultEngine ?? current.defaultEngine;
    const defaultModel = request.body.defaultModel === null ? undefined : request.body.defaultModel ?? current.defaultModel;
    const defaultEffort = request.body.defaultEffort === null ? undefined : request.body.defaultEffort ?? current.defaultEffort;
    if (!defaultEngine && (defaultModel || defaultEffort)) {
      return reply.code(400).send({ error: "default engine is required when selecting a model or effort" });
    }
    if (defaultEngine) {
      const configuredDefaultEngine = engines.get(defaultEngine);
      if (!configuredDefaultEngine) return reply.code(400).send({ error: "unknown engine" });
      const selectionError = runtimeSelectionError(configuredDefaultEngine.adapter, defaultModel, defaultEffort);
      if (selectionError) return reply.code(400).send({ error: selectionError });
    }
    const conversation = store.updateConversation(request.params.id, request.body ?? {});
    return conversation;
  });

  app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const deleted = store.deleteConversation(request.params.id);
    return deleted ? { deleted: true } : reply.code(404).send({ error: "conversation not found" });
  });

  app.post<{
    Params: { id: string };
    Body: { role?: "user" | "assistant" | "system"; text: string; replyToMessageId?: string; directReplyToAuthorAgentId?: string; attachments?: AssetDto[] };
  }>("/api/conversations/:id/messages", async (request, reply) => {
    const requestedText = request.body?.text?.trim();
    const text = requestedText ? stripLeadingScopeTag(requestedText, "broadcast") : "";
    if (!text) return reply.code(400).send({ error: "broadcast text is required after #broadcast" });
    if (request.body.directReplyToAuthorAgentId) return reply.code(400).send({ error: "use the idempotent direct-replies endpoint" });
    if (text.length > MAX_TEXT_LENGTH) return reply.code(400).send({ error: "text must be 65536 characters or fewer" });
    const master = store.getConversation(request.params.id);
    if (!master) return reply.code(404).send({ error: "conversation not found" });
    const requestedAssets = request.body.attachments ?? [];
    if (!Array.isArray(requestedAssets) || requestedAssets.length > MAX_ATTACHMENTS_PER_MESSAGE) return reply.code(400).send({ error: "at most 4 assets are allowed" });
    const validatedAssets: AssetDto[] = [];
    for (const requested of requestedAssets) {
      const owner = store.getAgent(requested.agentId);
      const stored = owner?.projectId === master.projectId && owner.conversationIds.includes(master.id)
        ? await assetMetadata(owner.id, requested.id) : undefined;
      if (!stored) return reply.code(404).send({ error: "asset not found" });
      const { projectId: _projectId, originalFile: _originalFile, previewFile: _previewFile, associatedAt: _associatedAt, ...publicAsset } = stored;
      validatedAssets.push({ ...publicAsset, state: "associated" });
    }
    if (validatedAssets.reduce((sum, item) => sum + item.size, 0) > ASSET_LIMITS.maxMessageBytes) return reply.code(413).send({ error: "message asset quota exceeded" });
    const communication = recordCommunication({
      eventId: randomUUID(),
      schemaVersion: 1,
      projectId: master.projectId,
      conversationId: master.id,
      sender: { kind: "user", userId: "local-operator" },
      intent: "broadcast",
      audience: { kind: "organization", organizationId: master.projectId },
      text,
      createdAt: new Date().toISOString(),
    });
    let message;
    try {
      message = store.appendConversationMessage(request.params.id, {
        role: request.body.role,
        text: renderScopedMessage("broadcast", text),
        replyToMessageId: request.body.replyToMessageId,
        attachments: validatedAssets,
      }, undefined, "main", undefined, undefined, communication?.eventId);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "reply target was not found in this conversation" });
    }
    await Promise.all(validatedAssets.map((asset) => {
      const owner = store.getAgent(asset.agentId)!;
      return assets.associate(owner.projectId, owner.id, [asset.id]);
    }));
    if (communication?.intent === "broadcast" && message) projectBroadcastToAgentAudits(communication, [], message.attachments);
    return message ?? reply.code(404).send({ error: "conversation not found" });
  });

  app.post<{ Params: { id: string }; Body: CreateMultiAgentDirectMessageRequest }>(
    "/api/conversations/:id/direct-messages",
    async (request, reply) => {
      const text = request.body?.text?.trim() ?? "";
      const recipients = request.body?.recipients ?? [];
      const replyToMessageId = request.body?.replyToMessageId?.trim() || undefined;
      const idempotencyKey = request.body?.idempotencyKey?.trim() ?? "";
      if (!text) return reply.code(400).send({ error: "text is required" });
      if (text.length > MAX_TEXT_LENGTH) return reply.code(400).send({ error: "text must be 65536 characters or fewer" });
      if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
      if (!Array.isArray(recipients) || recipients.length === 0 || recipients.length > 100) {
        return reply.code(400).send({ error: "1 to 100 recipients are required" });
      }
      const agentIds = recipients.map((recipient) => recipient.agentId?.trim());
      if (agentIds.some((id) => !id) || new Set(agentIds).size !== agentIds.length) {
        return reply.code(400).send({ error: "recipient agent IDs must be unique" });
      }
      for (const recipient of recipients) {
        const attachmentIds = recipient.attachmentIds ?? [];
        if (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE || new Set(attachmentIds).size !== attachmentIds.length) {
          return reply.code(400).send({ error: "each recipient supports at most 4 unique attachments" });
        }
      }
      const master = store.getConversation(request.params.id);
      if (!master || master.archived) return reply.code(404).send({ error: "conversation not found" });
      const targets = agentIds.map((agentId) => store.getAgent(agentId));
      if (targets.some((target) => !target || target.archived || !target.conversationIds.includes(master.id))) {
        return reply.code(404).send({ error: "direct message recipient not found" });
      }
      const receiptKey = `multi-direct:${master.id}:${idempotencyKey}`;
      const persistedIntents = () => store.getConversationDeliveryIntents(master.id)
        .filter((item) => item.messageReceiptKey === receiptKey && item.intent.kind === "direct");
      const queueMissingDeliveries = (message: ConversationMessageDto): MultiAgentDirectMessageResponse["recipients"] => {
        return persistedIntents().map(({ intent, deliveryOrderKey }) => {
          const existingDelivery = collaborationDeliveries.getForMessageTarget(message.id, intent.targetAgentId);
          const wasBusy = activeRuns.has(intent.targetAgentId);
          const delivery = existingDelivery ?? queueCollaborationDelivery({
            conversationId: master.id,
            messageId: message.id,
            communicationEventId: message.communicationEventId,
            targetAgentId: intent.targetAgentId,
            text,
            relayDepth: intent.relayDepth,
            mentionTrail: intent.mentionTrail,
            kind: "direct",
            createdAt: message.createdAt,
            orderKey: deliveryOrderKey,
            sourceChannel: "main",
            replyToMessageId,
            attachmentIds: intent.attachmentIds,
          });
          if (!delivery) throw new Error("direct message delivery could not be persisted");
          return { agentId: intent.targetAgentId, queued: existingDelivery ? existingDelivery.status === "queued" : wasBusy };
        });
      };
      const existingMessageId = collaborationDeliveries.messageReceipt(receiptKey);
      const existing = existingMessageId
        ? store.getConversationMessages(master.id).find((message) => message.id === existingMessageId)
        : store.getConversationMessageByReceiptKey(master.id, receiptKey);
      if (existing) {
        const intents = persistedIntents();
        const persistedRecipients = intents.map(({ intent }) => ({
          agentId: intent.targetAgentId,
          attachmentIds: intent.attachmentIds ?? [],
        }));
        const requestedRecipients = recipients.map((recipient) => ({ agentId: recipient.agentId, attachmentIds: recipient.attachmentIds ?? [] }));
        const sameRequest = existing.text === text && existing.replyTo?.messageId === replyToMessageId &&
          JSON.stringify(persistedRecipients) === JSON.stringify(requestedRecipients);
        if (!sameRequest) return reply.code(409).send({ error: "idempotency key was used with another direct message" });
        collaborationDeliveries.rememberMessageReceipt(receiptKey, existing.id);
        return {
          messageId: existing.id,
          replayed: true,
          recipients: queueMissingDeliveries(existing),
        } satisfies MultiAgentDirectMessageResponse;
      }
      if (directReplyClaims.has(receiptKey)) {
        return reply.code(409).send({ error: "direct message with this idempotency key is in progress", retryable: true });
      }
      directReplyClaims.add(receiptKey);
      try {
        const attachmentsByAgent = await Promise.all(recipients.map(async (recipient) => {
          const attached = await Promise.all((recipient.attachmentIds ?? []).map((id) => assetMetadata(recipient.agentId, id)));
          if (attached.some((item) => !item || item.agentId !== recipient.agentId)) throw new AssetError(404, "direct message attachment not found");
          if (attached.reduce((sum, item) => sum + (item?.size ?? 0), 0) > ASSET_LIMITS.maxMessageBytes) {
            throw new AssetError(413, "message asset quota exceeded");
          }
          return attached as ImageAttachmentDto[];
        }));
        const intents: ConversationDeliveryIntent[] = recipients.map((recipient) => ({
          targetAgentId: recipient.agentId,
          relayDepth: 0,
          mentionTrail: [],
          kind: "direct",
          ...(recipient.attachmentIds?.length ? { attachmentIds: recipient.attachmentIds } : {}),
        }));
        const communication = recordCommunication({
          eventId: randomUUID(), schemaVersion: 2, projectId: master.projectId, conversationId: master.id,
          sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
          audience: { kind: "user_agents", userId: "local-operator", agentIds: agentIds as [string, ...string[]] },
          text, createdAt: new Date().toISOString(), idempotencyKey: receiptKey,
        });
        if (!communication) return reply.code(503).send({ error: "direct message could not be recorded" });
        store.appendCommunicationProjection(master.projectId, {
          eventId: communication.eventId,
          surface: "user_inbox",
          projectionKey: "local-operator",
          projectedAt: communication.createdAt,
        });
        let message: ConversationMessageDto | undefined;
        try {
          message = store.appendConversationMessage(
            master.id,
            { text, replyToMessageId, attachments: attachmentsByAgent[0] },
            undefined,
            "main",
            intents,
            receiptKey,
            communication.eventId,
          );
        } catch (error) {
          return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid direct message" });
        }
        if (!message) return reply.code(404).send({ error: "conversation not found" });
        collaborationDeliveries.rememberMessageReceipt(receiptKey, message.id);
        return {
          messageId: message.id,
          replayed: false,
          recipients: queueMissingDeliveries(message),
        } satisfies MultiAgentDirectMessageResponse;
      } catch (error) {
        if (error instanceof AssetError) return reply.code(error.statusCode).send({ error: error.message });
        throw error;
      } finally {
        directReplyClaims.delete(receiptKey);
      }
    },
  );

  app.post<{ Body: CreateUserReactionRequest }>("/api/user-reactions", async (request, reply) => {
    const projectId = request.body?.projectId?.trim() ?? "";
    const communicationEventId = request.body?.communicationEventId?.trim() ?? "";
    const emoji = request.body?.emoji?.trim() ?? "";
    const idempotencyKey = request.body?.idempotencyKey?.trim() ?? "";
    if (!projectId || !communicationEventId) return reply.code(400).send({ error: "projectId and communicationEventId are required" });
    if (!isSingleEmoji(emoji)) return reply.code(400).send({ error: "emoji must be one emoji grapheme" });
    if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
    const communication = store.getCommunicationEvent(projectId, communicationEventId);
    if (!communication || communication.sender.kind !== "agent") {
      return reply.code(404).send({ error: "agent-authored message not found" });
    }
    const target = store.getAgent(communication.sender.agentId);
    if (!target || target.archived || target.projectId !== projectId) {
      return reply.code(404).send({ error: "message author not found" });
    }
    let result: ReturnType<UserReactionStore["set"]>;
    try {
      result = userReactions.set({
        idempotencyKey,
        projectId,
        communicationEventId,
        targetAuthorAgentId: target.id,
        emoji,
        replyTo: {
          messageId: communicationEventId,
          text: communication.text,
          role: "assistant",
          authorAgentId: target.id,
        },
      });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "reaction conflict" });
    }
    const deliveryMessageId = `reaction:${result.event.id}`;
    const existingDelivery = collaborationDeliveries.getForMessageTarget(deliveryMessageId, target.id);
    const wasBusy = activeRuns.has(target.id);
    const delivery = existingDelivery ?? queueCollaborationDelivery({
      conversationId: communication.conversationId ?? target.conversationId,
      messageId: deliveryMessageId,
      targetAgentId: target.id,
      text: `the user reacted with ${emoji}`,
      relayDepth: 0,
      mentionTrail: [],
      kind: "direct",
      createdAt: result.event.createdAt,
      orderKey: store.nextDeliveryOrderKey(result.event.createdAt),
      replyToMessageId: communicationEventId,
      replyTo: result.event.replyTo,
    });
    if (!delivery) return reply.code(503).send({ error: "reaction notification could not be persisted" });
    return {
      replayed: result.replayed,
      queued: existingDelivery ? existingDelivery.status === "queued" : wasBusy,
      targetAuthorAgentId: target.id,
      reactions: userReactions.forCommunication(communicationEventId),
    } satisfies CreateUserReactionResponse;
  });

  app.post<{ Params: { id: string }; Body: CreateDirectReplyRequest }>(
    "/api/conversations/:id/direct-replies",
    async (request, reply) => {
      const text = request.body?.text?.trim() ?? "";
      const replyToMessageId = request.body?.replyToMessageId?.trim() ?? "";
      const targetAuthorAgentId = request.body?.targetAuthorAgentId?.trim() ?? "";
      const idempotencyKey = request.body?.idempotencyKey?.trim() ?? "";
      const attachmentIds = request.body?.attachmentIds ?? [];
      if (!text && attachmentIds.length === 0) return reply.code(400).send({ error: "text or an attachment is required" });
      if (text.length > MAX_TEXT_LENGTH) return reply.code(400).send({ error: "text must be 65536 characters or fewer" });
      if (!replyToMessageId || !targetAuthorAgentId) return reply.code(400).send({ error: "reply target and author are required" });
      if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
      if (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE || new Set(attachmentIds).size !== attachmentIds.length) {
        return reply.code(400).send({ error: "at most 4 unique attachments are allowed" });
      }
      const master = store.getConversation(request.params.id);
      if (!master || master.archived) return reply.code(404).send({ error: "conversation not found" });
      const receiptKey = `direct-reply:${master.id}:${idempotencyKey}`;
      const existingMessageId = collaborationDeliveries.messageReceipt(receiptKey);
      const existing = existingMessageId
        ? store.getConversationMessages(master.id).find((message) => message.id === existingMessageId)
        : store.getConversationMessageByReceiptKey(master.id, receiptKey);
      const target = store.getAgent(targetAuthorAgentId);
      if (!target || target.archived || !target.conversationIds.includes(master.id)) return reply.code(404).send({ error: "direct reply target not found" });
      const renderedText = `#${agentMentionHandle(target.title)} ${text}`.trimEnd();
      if (existing) {
        const sameRequest = existing.text === renderedText && existing.replyTo?.messageId === replyToMessageId &&
          existing.replyTo.authorAgentId === targetAuthorAgentId &&
          JSON.stringify(existing.attachments?.map((item) => item.id) ?? []) === JSON.stringify(attachmentIds);
        if (!sameRequest) return reply.code(409).send({ error: "idempotency key was used with another direct reply" });
        collaborationDeliveries.rememberMessageReceipt(receiptKey, existing.id);
        let delivery = collaborationDeliveries.getForMessageTarget(existing.id, targetAuthorAgentId);
        if (!delivery) {
          const persisted = store.getConversationDeliveryIntents(master.id).find(({ message, intent, messageReceiptKey }) =>
            message.id === existing.id && messageReceiptKey === receiptKey &&
            intent.kind === "direct" && intent.targetAgentId === targetAuthorAgentId,
          );
          if (!persisted) {
            return reply.code(503).send({
              error: "direct reply delivery intent is unavailable; retry after recovery",
              retryable: true,
            });
          }
          try {
            delivery = queueCollaborationDelivery({
              conversationId: master.id,
              messageId: existing.id,
              communicationEventId: existing.communicationEventId,
              targetAgentId: persisted.intent.targetAgentId,
              text,
              relayDepth: persisted.intent.relayDepth,
              mentionTrail: persisted.intent.mentionTrail,
              kind: "direct",
              createdAt: existing.createdAt,
              orderKey: persisted.deliveryOrderKey,
              sourceChannel: "main",
              replyToMessageId,
              attachmentIds: existing.attachments?.map((item) => item.id),
            });
          } catch {
            delivery = undefined;
          }
          if (!delivery) {
            return reply.code(503).send({
              error: "direct reply delivery could not be persisted; retry is safe",
              retryable: true,
            });
          }
        }
        return {
          messageId: existing.id,
          targetAuthorAgentId,
          replayed: true,
          queued: delivery?.status === "queued",
        } satisfies DirectReplyResponse;
      }
      if (directReplyClaims.has(receiptKey)) {
        return reply.code(409).send({ error: "direct reply with this idempotency key is in progress", retryable: true });
      }
      directReplyClaims.add(receiptKey);
      try {
      const attached = await Promise.all(attachmentIds.map((id) => assetMetadata(target.id, id)));
      if (attached.some((item) => !item || item.agentId !== target.id)) return reply.code(404).send({ error: "direct reply attachment not found" });
      const attachments = attached as ImageAttachmentDto[];
      const intent: ConversationDeliveryIntent = {
        targetAgentId: target.id,
        relayDepth: 0,
        mentionTrail: [],
        kind: "direct",
      };
      const communication = recordCommunication({
        eventId: randomUUID(),
        schemaVersion: 2,
        projectId: master.projectId,
        conversationId: master.id,
        sender: { kind: "user", userId: "local-operator" },
        intent: "user_dm",
        audience: { kind: "user_agent", userId: "local-operator", agentId: target.id },
        text,
        createdAt: new Date().toISOString(),
        idempotencyKey: receiptKey,
      });
      let message: ConversationMessageDto | undefined;
      try {
        message = store.appendConversationMessage(
          master.id,
          { text: renderedText, replyToMessageId, directReplyToAuthorAgentId: target.id, attachments },
          undefined,
          "main",
          [intent],
          receiptKey,
          communication?.eventId,
        );
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid direct reply" });
      }
      if (!message) return reply.code(404).send({ error: "conversation not found" });
      collaborationDeliveries.rememberMessageReceipt(receiptKey, message.id);
      const wasBusy = activeRuns.has(target.id);
      const delivery = queueCollaborationDelivery({
        conversationId: master.id,
        messageId: message.id,
        communicationEventId: message.communicationEventId,
        targetAgentId: target.id,
        text,
        relayDepth: 0,
        mentionTrail: [],
        kind: "direct",
        createdAt: message.createdAt,
        orderKey: store.getConversationMessageDeliveryOrderKey(master.id, message.id),
        sourceChannel: "main",
        replyToMessageId,
        attachmentIds,
      });
      if (!delivery) return reply.code(503).send({ error: "direct reply delivery could not be persisted" });
      return {
        messageId: message.id,
        targetAuthorAgentId: target.id,
        replayed: false,
        queued: wasBusy,
      } satisfies DirectReplyResponse;
      } finally {
        directReplyClaims.delete(receiptKey);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/conversations/:id/collaboration", async (request, reply) => {
    const detail = collaborationViewDetail(request.params.id);
    return detail ?? reply.code(404).send({ error: "conversation not found" });
  });

  app.post<{
    Params: { id: string };
    Body: { text: string; recipientAgentIds?: string[]; replyToMessageId?: string; directReplyToAuthorAgentId?: string };
  }>("/api/conversations/:id/collaboration/messages", async (request, reply) => {
    const text = request.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: "text is required" });
    if (text.length > MAX_TEXT_LENGTH) return reply.code(400).send({ error: "text must be 65536 characters or fewer" });
    if (request.body.directReplyToAuthorAgentId) return reply.code(400).send({ error: "Reply Directly is available only in main chat" });
    const detail = collaborationViewDetail(request.params.id);
    if (!detail) return reply.code(404).send({ error: "conversation not found" });

    let renderedText = text;
    let routing: { intents: ConversationDeliveryIntent[]; blocked: Array<{ title: string; reason: string }> };
    if (request.body.recipientAgentIds !== undefined) {
      const ids = request.body.recipientAgentIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) {
        return reply.code(400).send({ error: "collaboration requires 1 to 100 recipientAgentIds" });
      }
      const uniqueIds = [...new Set(ids)];
      const members = new Map(detail.agents.map((agent) => [agent.id, agent]));
      const targets = uniqueIds.map((id) => members.get(id));
      if (targets.some((target) => !target || target.archived)) {
        return reply.code(400).send({ error: "every collaboration recipient must be an active agent in this conversation" });
      }
      renderedText = `${targets.map((target) => `#${agentMentionHandle(target!.title)}`).join(" ")} ${text}`;
      routing = {
        intents: targets.map((target) => ({
          targetAgentId: target!.id, relayDepth: 0, mentionTrail: [], kind: "tag", audience: "mention",
        })),
        blocked: [],
      };
    } else {
      return reply.code(400).send({ error: "collaboration requires explicit recipientAgentIds" });
    }
    if (routing.intents.length === 0) {
      return reply.code(400).send({ error: "collaboration requires at least one explicit recipient" });
    }
    const master = store.getConversation(request.params.id)!;
    if (request.body.replyToMessageId) {
      const replyTarget = detail.messages.find((message) => message.id === request.body.replyToMessageId);
      const replyEvent = replyTarget?.communicationEventId
        ? store.getCommunicationEvent(master.projectId, replyTarget.communicationEventId)
        : undefined;
      if (!replyTarget || routing.intents.some((intent) =>
        intent.targetAgentId !== replyTarget.authorAgentId &&
        !canonicalAudienceIncludes(replyEvent, master.projectId, intent.targetAgentId))) {
        return reply.code(400).send({ error: "reply target is not visible to every collaboration recipient" });
      }
    }
    const communication = recordCommunication({
      eventId: randomUUID(), schemaVersion: 2, projectId: master.projectId, conversationId: master.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "collaboration",
      audience: { kind: "agents", agentIds: routing.intents.map((item) => item.targetAgentId) as [string, ...string[]] },
      text, createdAt: new Date().toISOString(),
    });
    let message;
    try { message = store.appendConversationMessage(
      request.params.id,
      { role: "user", text: renderedText, replyToMessageId: request.body.replyToMessageId },
      undefined,
      "collaboration",
      routing.intents,
      undefined,
      communication?.eventId,
    ); } catch { return reply.code(400).send({ error: "reply target was not found in this conversation" }); }
    const notifiedAgentIds: string[] = [];
    queueRecordedCollaborationMessage(request.params.id, message!, undefined, routing.intents);
    notifiedAgentIds.push(...routing.intents.map((intent) => intent.targetAgentId));
    return {
      message,
      audience: hasEveryoneMention(text) ? "everyone" : "mention",
      notifiedAgentIds,
    };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/agents", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    return store.listAgents(request.params.id);
  });

  const validatePreset = (input: { name?: string; description?: string; guidance?: string; engine?: string; model?: string | null; effort?: string | null }, partial = false): string | undefined => {
    if (!partial && (!input.name?.trim() || !input.description?.trim() || !input.guidance?.trim() || !input.engine)) return "name, description, guidance, and engine are required";
    if (input.name !== undefined && (input.name.trim().length < 2 || input.name.trim().length > 60)) return "name must be 2-60 characters";
    if (input.description !== undefined && input.description.trim().length > 240) return "description must be at most 240 characters";
    if (input.guidance !== undefined && (input.guidance.trim().length < 10 || input.guidance.trim().length > 8000)) return "guidance must be 10-8000 characters";
    if (input.engine) {
      const configured = engines.get(input.engine); if (!configured) return "unknown engine";
      return runtimeSelectionError(configured.adapter, input.model ?? undefined, input.effort ?? undefined);
    }
  };
  app.get<{ Params: { id: string } }>("/api/projects/:id/agent-presets", async (request, reply) => store.getProject(request.params.id) ? store.listAgentPresets(request.params.id) : reply.code(404).send({ error: "project not found" }));
  app.post<{ Params: { id: string }; Body: import("@ponderosa/core").CreateAgentPresetRequest }>("/api/projects/:id/agent-presets", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    const error = validatePreset(request.body ?? {}); if (error) return reply.code(400).send({ error });
    return reply.code(201).send(store.createAgentPreset(request.params.id, request.body));
  });
  app.patch<{ Params: { id: string }; Body: import("@ponderosa/core").UpdateAgentPresetRequest }>("/api/agent-presets/:id", async (request, reply) => {
    const current = store.getAgentPreset(request.params.id); if (!current) return reply.code(404).send({ error: "preset not found" });
    const body = request.body ?? {};
    if (Object.keys(body).some((key) => !["name", "description", "guidance", "engine", "model", "effort", "enabled"].includes(key))) return reply.code(400).send({ error: "unknown preset field" });
    const error = validatePreset({ ...current, ...body }, true); if (error) return reply.code(400).send({ error });
    return store.updateAgentPreset(request.params.id, body)!;
  });
  app.delete<{ Params: { id: string } }>("/api/agent-presets/:id", async (request, reply) => store.deleteAgentPreset(request.params.id) ? { deleted: true } : reply.code(404).send({ error: "preset not found" }));

  app.post<{
    Params: { id: string };
    Body: { title: string; engine: string; conversationId?: string; model?: string; effort?: string; initialMessage?: string; replyToMessageId?: string; presetId?: string; managerAgentId?: string };
  }>(
    "/api/projects/:id/agents",
    async (request, reply) => {
      if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
      if (!request.body?.title || !request.body?.engine) {
        return reply.code(400).send({ error: "title and engine are required" });
      }
      if (request.body.presetId) {
        const preset = store.getAgentPreset(request.body.presetId);
        if (!preset || preset.projectId !== request.params.id || !preset.enabled) return reply.code(400).send({ error: "preset is unavailable for this project" });
        request.body.engine = preset.engine; request.body.model = preset.model; request.body.effort = preset.effort;
      }
      if (!engines.has(request.body.engine)) return reply.code(400).send({ error: "unknown engine" });
      const selectionError = runtimeSelectionError(engines.get(request.body.engine)!.adapter, request.body.model, request.body.effort);
      if (selectionError) return reply.code(400).send({ error: selectionError });
      if (request.body.managerAgentId) {
        const manager = store.getAgent(request.body.managerAgentId);
        if (!manager || manager.projectId !== request.params.id || manager.archived) {
          return reply.code(400).send({ error: "manager must be an active agent in this project" });
        }
        request.body.conversationId ??= manager.conversationId;
        if (request.body.conversationId && !manager.conversationIds.includes(request.body.conversationId)) {
          return reply.code(400).send({ error: "manager must belong to the selected conversation" });
        }
      }
      if (request.body.conversationId) {
        const conversation = store.getConversation(request.body.conversationId);
        if (!conversation || conversation.projectId !== request.params.id) {
          return reply.code(400).send({ error: "conversation does not belong to project" });
        }
        if (request.body.replyToMessageId && !store.getConversationMessages(request.body.conversationId, "main").some((message) => message.id === request.body.replyToMessageId)) {
          return reply.code(400).send({ error: "reply target was not found in this conversation" });
        }
      }
      const initialMessage = request.body.initialMessage?.trim();
      if (initialMessage && request.body.managerAgentId && !request.body.conversationId) {
        return reply.code(400).send({ error: "a managed agent opening message requires its manager to belong to a Project chat" });
      }
      let agent;
      try {
        agent = store.createAgent(request.params.id, request.body);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "agent could not be created" });
      }
      if (initialMessage) {
        if (agent.managerAgentId && agent.conversationId) {
          const routing = resolveExplicitCollaborationIntents(
            agent.conversationId,
            "user:local-operator",
            [agent.id],
            initialMessage,
            0,
            [],
          );
          if (routing.error) {
            store.deleteAgent(agent.id);
            return reply.code(400).send({ error: routing.error });
          }
          const communication = recordCommunication({
            eventId: randomUUID(), schemaVersion: 2, projectId: agent.projectId, conversationId: agent.conversationId,
            sender: { kind: "user", userId: "local-operator" }, intent: "collaboration",
            audience: { kind: "agents", agentIds: [agent.id] }, text: initialMessage,
            createdAt: new Date().toISOString(),
            ...(request.body.replyToMessageId ? { causationId: request.body.replyToMessageId } : {}),
          });
          const message = store.appendConversationMessage(
            agent.conversationId,
            { role: "user", text: routing.text },
            undefined,
            "collaboration",
            routing.intents,
            undefined,
            communication.eventId,
          );
          if (!message) {
            store.deleteAgent(agent.id);
            return reply.code(409).send({ error: "managed agent opening message could not be recorded" });
          }
          queueRecordedCollaborationMessage(agent.conversationId, message, undefined, routing.intents);
          return agent;
        }
        let initialCommunicationEventId: string | undefined;
        if (agent.conversationId) {
          const communication = recordCommunication({
            eventId: randomUUID(), schemaVersion: 2, projectId: agent.projectId, conversationId: agent.conversationId,
            sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
            audience: { kind: "user_agent", userId: "local-operator", agentId: agent.id }, text: initialMessage,
            createdAt: new Date().toISOString(),
          });
          initialCommunicationEventId = communication?.eventId;
          if (communication?.intent === "user_dm") store.appendCommunicationProjection(agent.projectId, {
            eventId: communication.eventId,
            surface: "user_inbox",
            projectionKey: communication.audience.userId,
            projectedAt: communication.createdAt,
          });
          store.appendConversationMessage(
            agent.conversationId,
            { text: `#${agentMentionHandle(agent.title)} ${initialMessage}`, replyToMessageId: request.body.replyToMessageId },
            undefined, "main", undefined, undefined, initialCommunicationEventId,
          );
        }
        const turn = await app.inject({
          method: "POST",
          url: `/api/agents/${agent.id}/messages`,
          headers: {
            ...(opts.authToken ? { authorization: `Bearer ${opts.authToken}` } : {}),
            ...(initialCommunicationEventId ? { "x-ponderosa-turn-dispatch": turnDispatchKey } : {}),
          },
          payload: {
            text: initialMessage,
            model: request.body.model,
            effort: request.body.effort,
            sourceChannel: "main",
            ...(agent.conversationId ? { sourceConversationId: agent.conversationId } : {}),
            ...(request.body.replyToMessageId ? { replyToMessageId: request.body.replyToMessageId } : {}),
            ...(initialCommunicationEventId ? { communicationEventId: initialCommunicationEventId } : {}),
          },
        });
        if (turn.statusCode >= 400) {
          store.deleteAgent(agent.id);
          return reply.code(turn.statusCode).send(turn.json());
        }
      }
      return agent;
    },
  );

  app.get<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    const detail = agentDetail(request.params.id);
    return detail ?? reply.code(404).send({ error: "agent not found" });
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id/usage", async (request, reply) => {
    if (!store.getAgent(request.params.id)) return reply.code(404).send({ error: "agent not found" });
    return projectedUsage({ type: "agent", id: request.params.id });
  });

  app.patch<{ Params: { id: string }; Body: { title?: string; archived?: boolean } }>(
    "/api/agents/:id",
    async (request, reply) => {
      const agent = store.updateAgent(request.params.id, request.body ?? {});
      return agent ?? reply.code(404).send({ error: "agent not found" });
    },
  );

  app.put<{ Params: { id: string }; Body: UpdateAgentOrganizationRequest }>(
    "/api/agents/:id/manager",
    async (request, reply) => {
      if (!request.body || !("managerAgentId" in request.body) ||
        (request.body.managerAgentId !== null && (typeof request.body.managerAgentId !== "string" || !request.body.managerAgentId.trim()))) {
        return reply.code(400).send({ error: "managerAgentId must be a stable agent ID or null" });
      }
      try {
        const agent = store.updateAgentOrganization(request.params.id, request.body);
        return agent ?? reply.code(404).send({ error: "agent not found" });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid agent organization" });
      }
    },
  );

  app.put<{
    Params: { id: string };
    Body: { conversationIds: string[]; primaryConversationId?: string };
  }>("/api/agents/:id/conversation-memberships", async (request, reply) => {
    if (!Array.isArray(request.body?.conversationIds)) {
      return reply.code(400).send({ error: "conversationIds is required" });
    }
    try {
      const agent = store.updateAgentConversationMemberships(request.params.id, request.body);
      return agent ?? reply.code(404).send({ error: "agent not found" });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid membership" });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    const { id } = request.params;
    const subtree = store.listAgentSubtree(id);
    if (subtree.length === 0) return reply.code(404).send({ error: "agent not found" });
    for (const agent of subtree) deletingAgentIds.add(agent.id);
    for (const agent of subtree) {
      const run = activeRuns.get(agent.id);
      if (run) {
        run.controller.abort();
        if (releaseActiveRun(agent.id, run, "cancelled")) {
          agentMessageCapabilities.delete(run.messageCapability);
        }
      }
      const runtime = runtimeSessions.get(agent.id);
      if (runtime) {
        removePersistentRuntime(agent.id, runtime);
        await runtime.session.close().catch(() => undefined);
      }
    }
    const deleted = store.deleteAgent(id);
    if (!deleted) {
      for (const agent of subtree) deletingAgentIds.delete(agent.id);
      return reply.code(404).send({ error: "agent not found" });
    }
    const deletedAgentIds = new Set(subtree.map((agent) => agent.id));
    for (const agentId of deletedAgentIds) {
      subscribers.delete(agentId);
      dispatchingTurns.delete(agentId);
      scheduledSessionRollovers.delete(agentId);
      clearWaitDeadline(agentId);
    }
    collaborationDeliveries.deleteAgents(deletedAgentIds);
    agentWaits.deleteAgents(deletedAgentIds);
    contextCursors.deleteAgents(deletedAgentIds);
    runLedger.deleteAgents(deletedAgentIds);
    for (const agentId of deletedAgentIds) deletingAgentIds.delete(agentId);
    return { deleted: true, deletedAgentIds: subtree.map((agent) => agent.id) };
  });

  app.post("/api/agents/:id/switch-engine", async (_request, reply) =>
    reply.code(501).send({ error: "switch-engine is a v2 endpoint" }),
  );

  app.get("/api/agents/:id/search", async (_request, reply) =>
    reply.code(501).send({ error: "search is a v2 endpoint" }),
  );

  const assetMetadata = async (agentId: string, id: string) => {
    const agent = store.getAgent(agentId);
    if (!agent) return undefined;
    const metadata = await assets.read(agent.projectId, agent.id, id);
    return metadata && await assets.content(agent.projectId, agent.id, id, false) ? metadata : undefined;
  };

  const limits = { ...ASSET_LIMITS, maxAttachmentsPerMessage: ASSET_LIMITS.maxAssetsPerMessage };
  app.get("/api/attachment-limits", async () => limits);
  app.get("/api/asset-limits", async () => ASSET_LIMITS);

  app.post<{ Params: { id: string }; Body: Buffer }>("/api/agents/:id/attachments", async (request, reply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent) return reply.code(404).send({ error: "agent not found" });
    const body = request.body;
    try {
      const asset = await assets.stage({ projectId: agent.projectId, agentId: agent.id, body,
        name: request.headers["x-ponderosa-filename"], declaredType: String(request.headers["x-ponderosa-media-type"] ?? request.headers["content-type"] ?? "") });
      return reply.code(201).send(asset);
    } catch (error) {
      if (error instanceof AssetError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.get<{ Params: { id: string; attachmentId: string } }>("/api/agents/:id/attachments/:attachmentId", async (request, reply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent) return reply.code(404).send({ error: "asset not found" });
    const content = await assets.content(agent.projectId, agent.id, request.params.attachmentId, true);
    if (!content) return reply.code(404).send({ error: "asset not found" });
    return reply.header("content-type", "image/png").header("content-disposition", "inline")
      .header("cache-control", "private, no-store").header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox").send(content.body);
  });

  app.get<{ Params: { id: string; assetId: string } }>("/api/agents/:id/assets/:assetId/preview", async (request, reply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent) return reply.code(404).send({ error: "asset not found" });
    const content = await assets.content(agent.projectId, agent.id, request.params.assetId, true);
    if (!content) return reply.code(404).send({ error: "asset not found" });
    return reply.header("content-type", "image/png").header("content-disposition", "inline")
      .header("cache-control", "private, no-store").header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox").send(content.body);
  });

  app.get<{ Params: { id: string; assetId: string } }>("/api/agents/:id/assets/:assetId/download", async (request, reply) => {
    if (request.headers.range) return reply.code(416).header("accept-ranges", "none").send({ error: "range requests are not supported" });
    const agent = store.getAgent(request.params.id);
    if (!agent) return reply.code(404).send({ error: "asset not found" });
    const content = await assets.content(agent.projectId, agent.id, request.params.assetId, false);
    if (!content) return reply.code(404).send({ error: "asset not found" });
    return reply.header("content-type", "application/octet-stream")
      .header("content-disposition", contentDisposition(content.asset.name))
      .header("cache-control", "private, no-store").header("x-content-type-options", "nosniff")
      .header("accept-ranges", "none").send(content.body);
  });

  app.delete<{ Params: { id: string; attachmentId: string } }>("/api/agents/:id/attachments/:attachmentId", async (request, reply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent) return reply.code(404).send({ error: "asset not found" });
    const asset = await assets.read(agent.projectId, agent.id, request.params.attachmentId);
    if (!asset) return reply.code(404).send({ error: "asset not found" });
    if (asset.state === "associated") return reply.code(409).send({ error: "sent assets cannot be deleted" });
    if (!await assets.remove(agent.projectId, agent.id, request.params.attachmentId)) return reply.code(404).send({ error: "asset not found" });
    return reply.code(204).send();
  });

  app.post<{
    Params: { id: string };
    Body: {
      text: string;
      model?: string;
      effort?: string;
      agentMentionDepth?: number;
      agentMentionTrail?: string[];
      collaborationConversationId?: string;
      collaborationDeliveryId?: string;
      collaborationDeliveryIds?: string[];
      sourceChannel?: "main";
      shareWithOrganization?: boolean;
      activeRunDelivery?: "steer" | "queue";
      sourceConversationId?: string;
      sourceAuthorAgentId?: string;
      replyToMessageId?: string;
      /** Server-only immutable context for a delivery that is not itself a chat message. */
      replyTo?: MessageReferenceDto;
      attachmentIds?: string[];
      /** Server-only link used when one action projects into room and audit timelines. */
      communicationEventId?: string;
    };
  }>(
    "/api/agents/:id/messages",
    async (request, reply) => {
      if (deletingAgentIds.has(request.params.id)) return reply.code(404).send({ error: "agent not found" });
      const agent = store.getAgent(request.params.id);
      if (!agent) return reply.code(404).send({ error: "agent not found" });
      const project = store.getProject(agent.projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      const engine = engines.get(agent.activeEngine);
      if (!engine) return reply.code(400).send({ error: "unknown engine" });
      const text = request.body?.text?.trim() ?? "";
      const activeRunDelivery = request.body?.activeRunDelivery ?? "steer";
      if (activeRunDelivery !== "steer" && activeRunDelivery !== "queue") {
        return reply.code(400).send({ error: "activeRunDelivery must be steer or queue" });
      }
      const priorRuns = store.getRuns(agent.id);
      const latestRun = priorRuns.at(-1);
      const recovered = normalizedRuntimeSelection(
        engine.adapter,
        latestRun ? latestRun.model : agent.model ?? agent.presetSnapshot?.model,
        latestRun ? latestRun.effort : agent.effort ?? agent.presetSnapshot?.effort,
      );
      const hasModelOverride = request.body.model !== undefined;
      const requestedModel = request.body.model?.trim() || undefined;
      if (hasModelOverride) {
        const modelError = runtimeSelectionError(engine.adapter, requestedModel, undefined);
        if (modelError) return reply.code(400).send({ error: modelError });
      }
      const effectiveModel = hasModelOverride ? requestedModel : recovered.model;
      const hasEffortOverride = request.body.effort !== undefined;
      const requestedEffort = request.body.effort?.trim() || undefined;
      if (hasEffortOverride) {
        const effortError = runtimeSelectionError(engine.adapter, effectiveModel, requestedEffort);
        if (effortError) return reply.code(400).send({ error: effortError });
      }
      const effectiveEffort = hasEffortOverride
        ? requestedEffort
        : hasModelOverride
          ? undefined
          : normalizedRuntimeSelection(engine.adapter, effectiveModel, recovered.effort).effort;
      const attachmentIds = request.body?.attachmentIds ?? [];
      if (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE || new Set(attachmentIds).size !== attachmentIds.length) return reply.code(400).send({ error: "at most 4 unique attachments are allowed" });
      const attached = (await Promise.all(attachmentIds.map((id) => assetMetadata(agent.id, id))));
      if (attached.some((item) => !item || item.agentId !== agent.id)) return reply.code(404).send({ error: "asset not found" });
      const messageAttachments = (attached as NonNullable<(typeof attached)[number]>[]).map(({ projectId: _projectId, originalFile: _originalFile, previewFile: _previewFile, associatedAt: _associatedAt, ...item }) => ({ ...item, state: "associated" as const })) as AssetDto[];
      if (messageAttachments.reduce((sum, item) => sum + item.size, 0) > ASSET_LIMITS.maxMessageBytes) return reply.code(413).send({ error: "message asset quota exceeded" });
      if (!text && messageAttachments.length === 0) return reply.code(400).send({ error: "text or an attachment is required" });
      if (text.length > MAX_TEXT_LENGTH) return reply.code(400).send({ error: "text must be 65536 characters or fewer" });
      const collaborationConversationId = request.body.collaborationConversationId;
      if (collaborationConversationId !== undefined && !agent.conversationIds.includes(collaborationConversationId)) {
        return reply.code(400).send({ error: "team chat does not belong to agent" });
      }
      if (
        collaborationConversationId !== undefined &&
        request.headers["x-ponderosa-collaboration-dispatch"] !== collaborationDispatchKey
      ) {
        return reply.code(403).send({ error: "collaboration context must be delivered by an explicit recipient event" });
      }
      const sourceConversationId = request.body.sourceConversationId;
      if (sourceConversationId !== undefined && !agent.conversationIds.includes(sourceConversationId)) {
        return reply.code(400).send({ error: "conversation does not belong to agent" });
      }
      if (request.body.sourceChannel === "main" && sourceConversationId) {
        const sourceMaster = store.getConversation(sourceConversationId);
        if (!sourceMaster || sourceMaster.archived) {
          return reply.code(400).send({ error: "archived conversations cannot route new turns" });
        }
      }
      const shareWithOrganization = request.body.shareWithOrganization === true;
      if (shareWithOrganization && (request.body.sourceChannel !== "main" || !sourceConversationId || collaborationConversationId)) {
        return reply.code(400).send({ error: "shared turns must originate from a Conversation" });
      }
      const directMessageConversationId = sourceConversationId ?? agent.conversationId;
      if (request.body.replyTo && request.headers["x-ponderosa-collaboration-dispatch"] !== collaborationDispatchKey) {
        return reply.code(403).send({ error: "reply context is server-controlled" });
      }
      const directReplyTarget = request.body.replyToMessageId
        ? agentMessages(agent.id).find((message) => message.id === request.body.replyToMessageId)
        : undefined;
      const sourceMasterReply = request.body.replyToMessageId && directMessageConversationId
        ? store.getConversationMessages(directMessageConversationId, "main")
            .find((message) => message.id === request.body.replyToMessageId)
        : undefined;
      const sourceCollaborationReply = request.body.replyToMessageId && collaborationConversationId
        ? store.getConversationMessages(collaborationConversationId, "collaboration")
            .find((message) => message.id === request.body.replyToMessageId)
        : undefined;
      if (request.body.replyToMessageId && !request.body.replyTo && !directReplyTarget && !sourceMasterReply && !sourceCollaborationReply) {
        return reply.code(400).send({ error: "reply target was not found in this conversation" });
      }
      const collaborationDeliveryId = request.body.collaborationDeliveryId;
      const collaborationDeliveryIds = request.body.collaborationDeliveryIds;
      const requestedDeliveryIds = collaborationDeliveryIds ?? (collaborationDeliveryId ? [collaborationDeliveryId] : []);
      const inboxDeliveries = requestedDeliveryIds.map((id) => collaborationDeliveries.get(id));
      const inboxDelivery = inboxDeliveries[0];
      if (
        requestedDeliveryIds.length > 0 &&
        (request.headers["x-ponderosa-collaboration-dispatch"] !== collaborationDispatchKey ||
          inboxDeliveries.some((delivery) => delivery?.targetAgentId !== agent.id || delivery.status !== "delivered") ||
          (inboxDelivery?.kind !== "direct" && !collaborationConversationId))
      ) {
        return reply.code(403).send({ error: "collaboration delivery must be dispatched by the server" });
      }
      const inheritedCommunicationEventId = requestedDeliveryIds.length === 1
        ? inboxDelivery?.communicationEventId : undefined;
      const serverCommunicationEventId = request.body.communicationEventId;
      if (serverCommunicationEventId && request.headers["x-ponderosa-turn-dispatch"] !== turnDispatchKey) {
        return reply.code(403).send({ error: "communication event identity is server-controlled" });
      }
      if (serverCommunicationEventId && !store.getCommunicationEvent(project.id, serverCommunicationEventId)) {
        return reply.code(400).send({ error: "communication event was not found in this project" });
      }
      const communicationEventId = serverCommunicationEventId ?? (requestedDeliveryIds.length === 0
        ? recordCommunication(shareWithOrganization ? {
            eventId: randomUUID(), schemaVersion: 2, projectId: project.id, conversationId: sourceConversationId!,
            sender: { kind: "user", userId: "local-operator" }, intent: "broadcast",
            audience: { kind: "organization", organizationId: project.id }, text,
            createdAt: new Date().toISOString(),
          } : {
            eventId: randomUUID(), schemaVersion: 2, projectId: project.id,
            ...((sourceConversationId ?? agent.conversationId) ? { conversationId: sourceConversationId ?? agent.conversationId } : {}),
            sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
            audience: { kind: "user_agent", userId: "local-operator", agentId: agent.id }, text,
            createdAt: new Date().toISOString(),
          })?.eventId
        : inheritedCommunicationEventId);
      const communication = communicationEventId
        ? store.getCommunicationEvent(project.id, communicationEventId)
        : undefined;
      const sharedCommunication = communication?.intent === "broadcast" ? communication : undefined;
      const sharedTaskTurn = Boolean(sharedCommunication && (shareWithOrganization || serverCommunicationEventId));
      const directUserTaskTurn = Boolean(
        communication?.schemaVersion === 2 &&
        communication.intent === "user_dm" &&
        communication.sender.kind === "user" &&
        (communication.audience.kind === "user_agent"
          ? communication.audience.agentId === agent.id
          : communication.audience.agentIds.includes(agent.id)),
      );
      let sourceMasterMessage: ConversationMessageDto | undefined;
      if (!serverCommunicationEventId && requestedDeliveryIds.length === 0 && communicationEventId) {
        if (communication?.schemaVersion === 2 && communication.intent === "user_dm") {
          store.appendCommunicationProjection(project.id, {
            eventId: communicationEventId,
            surface: "user_inbox",
            projectionKey: communication.audience.userId,
            projectedAt: communication.createdAt,
          });
        }
      }
      if (!serverCommunicationEventId && requestedDeliveryIds.length === 0 && communicationEventId && directMessageConversationId) {
        sourceMasterMessage = store.appendConversationMessage(directMessageConversationId, {
          role: "user",
          text: sharedCommunication ? text : `#${agentMentionHandle(agent.title)} ${text}`,
          attachments: messageAttachments,
          replyToMessageId: sourceMasterReply?.id,
        }, undefined, "main", undefined, undefined, communicationEventId);
        if (sharedCommunication) projectBroadcastToAgentAudits(sharedCommunication, [agent.id], messageAttachments);
      }
      if (!sourceMasterMessage && communication && directMessageConversationId) {
        sourceMasterMessage = store.getConversationMessages(directMessageConversationId, "main")
          .find((message) => message.communicationEventId === communication.eventId);
      }
      const mentionDepth = request.body.agentMentionDepth;
      if (
        mentionDepth !== undefined &&
        (!Number.isInteger(mentionDepth) || mentionDepth < 0 || mentionDepth > MAX_AGENT_MENTION_REPLAY_WINDOW)
      ) {
        return reply.code(400).send({ error: "agentMentionDepth must be an integer from 0 to 64" });
      }
      const mentionTrail = request.body.agentMentionTrail ?? [];
      if (
        !Array.isArray(mentionTrail) ||
        mentionTrail.length > MAX_AGENT_MENTION_REPLAY_WINDOW ||
        mentionTrail.some((fingerprint) => !/^[a-f0-9]{64}$/.test(fingerprint)) ||
        mentionTrail.length !== (mentionDepth ?? 0)
      ) {
        return reply.code(400).send({
          error: "agentMentionTrail must contain one relay fingerprint for each agentMentionDepth step",
        });
      }
      const pendingTurn: PendingTurn = {
        text,
        communicationEventId,
        model: request.body.model,
        effort: request.body.effort,
        agentMentionDepth: mentionDepth ?? 0,
        agentMentionTrail: mentionTrail,
        collaborationConversationId,
        collaborationDeliveryId,
        collaborationDeliveryIds,
        sourceChannel: request.body.sourceChannel === "main" ? "main" : undefined,
        sourceAuthorAgentId: request.body.sourceAuthorAgentId,
        replyToMessageId: request.body.replyToMessageId,
        replyTo: request.body.replyTo ?? (request.body.replyToMessageId
          ? (() => {
              const replyTarget = directReplyTarget ?? sourceMasterReply ?? sourceCollaborationReply;
              return replyTarget ? { messageId: replyTarget.id, text: replyTarget.text, role: replyTarget.role } : undefined;
            })()
          : undefined),
      };
      const auditText = text;
      if (requestedDeliveryIds.length === 0) {
        if (agentWaits.cancel(agent.id, "user message override")) clearWaitDeadline(agent.id);
      }
      const existingRun = activeRuns.get(agent.id);
      if (existingRun) {
        if (messageAttachments.length) return reply.code(409).send({ error: "wait for the active turn before sending attachments", retryable: true });
        if (communicationEventId) {
          try {
            store.recordRunTrigger(project.id, communicationEventId, agent.id);
          } catch (error) {
            return reply.code(409).send({ error: error instanceof Error ? error.message : "message cannot trigger this agent" });
          }
        }
        if (activeRunDelivery === "steer" && existingRun.runtimeSession) {
          const steered = await existingRun.runtimeSession.steer({
            prompt: `${runtimeIdentityPrompt(agent, existingRun.runId)}\n\nSteering update for the active turn:\n${text}${replyContext(pendingTurn.replyTo)}`,
            kind: requestedDeliveryIds.length > 0 ? "collaboration" : "user_message",
            model: request.body.model,
            effort: request.body.effort,
            clientMessageId: communicationEventId,
          });
          if (steered.status === "accepted") {
            const stored = store.appendEvent(agent.id, {
              type: "user_message",
              text: auditText,
              communicationEventId,
              replyTo: pendingTurn.replyTo,
            });
            publish(agent.id, stored);
            if (requestedDeliveryIds.length > 0) {
              collaborationDeliveries.acknowledgeBatch(requestedDeliveryIds);
            }
            renewExecutionLease(agent.id, existingRun);
            return { queued: false, steered: true, runId: existingRun.runId, mode: "steer", communicationEventId };
          }
        }
        // A dispatcher that lost the claim race needs to restore the dequeued
        // item at the head itself; ordinary manager and agent messages join the
        // FIFO queue and receive an explicit acknowledgement.
        if (request.headers["x-ponderosa-turn-dispatch"] === turnDispatchKey) {
          return reply.code(409).send({ error: "agent already has an active run" });
        }
        const createdAt = new Date().toISOString();
        const delivery = queueCollaborationDelivery({
          conversationId: sourceConversationId ?? agent.conversationId,
          messageId: `direct-${randomUUID()}`,
          communicationEventId,
          targetAgentId: agent.id,
          text,
          relayDepth: mentionDepth ?? 0,
          mentionTrail,
          kind: "direct",
          createdAt,
          orderKey: store.nextDeliveryOrderKey(createdAt),
          model: request.body.model,
          effort: request.body.effort,
          sourceChannel: request.body.sourceChannel === "main" ? "main" : undefined,
          replyToMessageId: request.body.replyToMessageId,
        });
        if (!delivery) return reply.code(503).send({ error: "turn could not be persisted" });
        const position = collaborationDeliveries.pendingCount(agent.id);
        return reply.code(202).send({ queued: true, position, communicationEventId });
      }

      const fullHistory: ChatMessage[] = agentMessages(agent.id)
        .filter((message) => {
          if (!message.communicationEventId) return true;
          const communication = store.getCommunicationEvent(project.id, message.communicationEventId);
          if (communication?.intent !== "broadcast") return true;
          // Conversation supplies shared Broadcast context explicitly. Individual
          // history retains only Broadcasts actually authored by this agent.
          return request.body.sourceChannel !== "main" && communication.sender.kind === "agent" &&
            communication.sender.agentId === agent.id;
        })
        .map((message) => ({
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        attachments: message.attachments?.map((item) => ({
          name: item.name,
          mediaType: item.mediaType,
          size: item.size,
          localPath: path.join(attachmentsDir(opts.dataDir, agent.projectId, agent.id), `${item.id}.bin`),
          available: existsSync(path.join(attachmentsDir(opts.dataDir, agent.projectId, agent.id), `${item.id}.bin`)),
        })),
        }));
      const runId = randomUUID();
      const controller = new AbortController();
      const reusablePersistentRuntime = engine.adapter.openSession ? runtimeSessions.get(agent.id) : undefined;
      cancelRuntimeIdleClose(reusablePersistentRuntime);
      const messageCapability = reusablePersistentRuntime?.messageCapability ?? randomUUID();
      const resumeSessionId = store.resumeSessionId(agent.id);
      const mode = resumeSessionId ? "continue" : "seed";
      const history = boundedSeedHistory(fullHistory);
      // An omitted model/effort means "keep this agent's current provider
      // identity", not "forget how this run should be attributed". Recover the
      // latest explicit selection so collaboration wake-ups and restarts remain
      // priceable even though they do not repeat UI controls in every delivery.
      // Project-chat turns receive the user-facing conversation. Collaboration context is
      // assembled only after the collaboration endpoint successfully tagged this
      // particular linked agent.
      const routingConversationId = sourceConversationId ?? agent.conversationId;
      const conversation = routingConversationId
        ? conversationDetail(routingConversationId)
        : undefined;
      const collaboration = collaborationConversationId
        ? collaborationViewDetail(collaborationConversationId)
        : undefined;
      const sourceChannel: AgentMessageChannel = collaboration
        ? "collaboration"
        : request.body.sourceChannel === "main"
          ? "main"
          : "individual";
      const contextAgents = collaboration?.agents ?? conversation?.agents ?? [agent];
      const sourceAuthor = collaboration && request.body.sourceAuthorAgentId
        ? contextAgents.find((candidate) => candidate.id === request.body.sourceAuthorAgentId)?.title ?? "Agent"
        : "Manager";
      const context = inboundContext(sourceChannel, sourceAuthor, text, contextAgents, agent.id);
      const cursorChannel = sourceChannel === "main" || sourceChannel === "collaboration" ? sourceChannel : undefined;
      const cursorConversationId = cursorChannel ? routingConversationId : undefined;
      const cursorModel = effectiveModel ?? "(default)";
      const routingMetadata = cursorConversationId && cursorChannel
        ? [
            "Current room routing and membership:",
            `- room: ${cursorConversationId}`,
            `- channel: ${cursorChannel}`,
            `- primary room: ${agent.conversationId ?? "none"}`,
            `- room memberships: ${agent.conversationIds.join(", ") || "none"}`,
            `- visible agents: ${contextAgents.map((candidate) => `${candidate.title} (${candidate.id})`).join(", ") || "none"}`,
          ].join("\n")
        : undefined;
      const routingHash = createHash("sha256").update(routingMetadata ?? "").digest("hex");
      const cursorScope = resumeSessionId && cursorConversationId && cursorChannel
        ? {
            agentId: agent.id,
            engine: agent.activeEngine,
            model: cursorModel,
            sessionId: resumeSessionId,
            conversationId: cursorConversationId,
            channel: cursorChannel,
          }
        : undefined;
      const latestSessionCursor = resumeSessionId ? contextCursors.latestForSession(agent.id, resumeSessionId) : undefined;
      const sameEngineModelEpoch = !latestSessionCursor ||
        (latestSessionCursor.engine === agent.activeEngine && latestSessionCursor.model === cursorModel);
      const previousCursor = cursorScope && sameEngineModelEpoch ? contextCursors.get(cursorScope) : undefined;
      const allRoomMessagesIncludingCurrent = collaboration
        ? recipientCollaborationMessages(
            collaboration.messages,
            store.readCommunicationEvents(project.id),
            project.id,
            agent.id,
          )
        : conversation && sourceChannel === "main"
          ? organizationalMasterMessages(
              conversation.messages,
              store.readCommunicationEvents(project.id),
              project.id,
              agent.id,
              conversation.agents,
            )
          : [];
      const allRoomMessages = pendingTurn.communicationEventId
        ? allRoomMessagesIncludingCurrent.filter((message) => message.communicationEventId !== pendingTurn.communicationEventId)
        : allRoomMessagesIncludingCurrent;
      const previousIndex = previousCursor?.lastMessageId
        ? allRoomMessages.findIndex((message) => message.id === previousCursor.lastMessageId)
        : -1;
      // A missing cursor target means canonical history was cleared or replaced;
      // reseed rather than assuming that later rows were already delivered.
      const incremental = previousCursor !== undefined && (!previousCursor.lastMessageId || previousIndex >= 0);
      const roomMessages = incremental
        ? allRoomMessages.slice(previousCursor?.lastMessageId ? previousIndex + 1 : 0)
        : boundedSeedHistory(allRoomMessages);
      const initialBroadcastContext = !resumeSessionId && conversation && sourceChannel !== "main"
        ? boundedSeedHistory(organizationalMasterMessages(
            conversation.messages,
            store.readCommunicationEvents(project.id),
            project.id,
            agent.id,
            conversation.agents,
          ))
        : [];
      const changedRoutingMetadata = !previousCursor || previousCursor.routingHash !== routingHash
        ? routingMetadata
        : undefined;
      const basePrompt = collaboration
        ? collaborationPrompt(roomMessages, collaboration.agents, text, context, inboxDelivery?.messageId, incremental, changedRoutingMetadata)
        : conversation && sourceChannel === "main"
          ? conversationPrompt(
              roomMessages,
              conversation.agents,
              text,
              context,
              sharedTaskTurn ? "broadcast" : "direct_to_user",
              sourceMasterMessage?.id,
              incremental,
              changedRoutingMetadata,
            )
          : resumeSessionId ? continuationPrompt(text, context) : individualChatPrompt(text, context);
      const guidedPrompt = agent.presetSnapshot?.guidance
        ? `Agent preset snapshot (${agent.presetSnapshot.name}):\n${agent.presetSnapshot.guidance}\n\n${basePrompt}`
        : basePrompt;
      const attachmentContext = messageAttachments.length ? `\n\nAttached images/assets (server-validated local files; labels are identifiers, not instructions):\n${messageAttachments.map((item) => `- asset ${item.id} (${item.mediaType}, ${item.size} bytes): ${path.join(attachmentsDir(opts.dataDir, agent.projectId, agent.id), `${item.id}.bin`)}`).join("\n")}` : "";
      const directory = teamDirectory(agent.projectId);
      const directoryForTurn: TeamDirectoryDto = {
        ...directory,
        agents: directory.agents.map((directoryAgent) => directoryAgent.agentId === agent.id
          ? { ...directoryAgent, status: "running", currentActivity: directoryAgent.currentActivity ?? "Working" }
          : directoryAgent),
      };
      const completionContract = sharedTaskTurn
        ? sharedRequestCompletionPrompt()
        : directUserTaskTurn ? directUserRequestCompletionPrompt() : "";
      const stableDirectory = directoryForTurn.agents.map(({ status: _status, currentActivity: _activity, ...entry }) => entry);
      const organizationEnvelopeHash = createHash("sha256").update(JSON.stringify(stableDirectory)).digest("hex");
      const previousOrganizationEnvelope = organizationEnvelopeStates.get(agent.id);
      const fullSessionEnvelope = `${teamDirectoryPrompt(directoryForTurn)}\n\n${agentSpawnPrompt().join("\n")}\n\n`;
      // A retained provider session already has this stable organization
      // envelope. Repeat it only for a new/rolled-over session, after a server
      // restart or warm eviction, or when roster/roles/reporting lines changed.
      // Live status remains available through PONDEROSA_AGENT_DIRECTORY_URL.
      const sessionEnvelope = resumeSessionId && previousOrganizationEnvelope?.sessionId === resumeSessionId &&
        previousOrganizationEnvelope.hash === organizationEnvelopeHash ? "" : fullSessionEnvelope;
      const promptTail = `${managerRelationshipPrompt(agent).join("\n")}\n\nThe live team directory and current activity are available from PONDEROSA_AGENT_DIRECTORY_URL when routing or discovery requires them.${initialBroadcastContext.length ? `\n\n${sharedBroadcastContextPrompt(initialBroadcastContext, conversation?.agents ?? [])}` : ""}\n\n${guidedPrompt}${completionContract ? `\n\n${completionContract}` : ""}${replyContext(pendingTurn.replyTo)}${attachmentContext}`;
      const prompt = `${runtimeIdentityPrompt(agent, runId)}\n\n${sessionEnvelope}${promptTail}`;
      // A resume-time compaction fallback seeds a genuinely fresh provider
      // session and therefore must restore the envelope even if the first
      // attempt expected the old thread to retain it.
      const freshPrompt = sessionEnvelope ? prompt : `${runtimeIdentityPrompt(agent, runId)}\n\n${fullSessionEnvelope}${promptTail}`;
      const agentMessageUrl = agentMessageEndpoint(request, opts.agentBaseUrl);

      await opts.messageLifecycleFaults?.beforeRunClaim?.({ agentId: agent.id, runId });
      // No await may be introduced between this recheck and the claim. Deletion
      // marks the agent unavailable before its own first await.
      if (deletingAgentIds.has(agent.id) || !store.getAgent(agent.id)) {
        return reply.code(404).send({ error: "agent not found" });
      }
      let durableClaim: ReturnType<RunLedger["claim"]>;
      try {
        durableClaim = runLedger.claim(agent.id, runId, requestedDeliveryIds);
      } catch {
        return reply.code(409).send({ error: "agent run ownership changed; retry safely", retryable: true });
      }
      await opts.messageLifecycleFaults?.afterRunClaim?.({
        agentId: agent.id,
        runId,
        generation: durableClaim.generation,
      });
      if (deletingAgentIds.has(agent.id) || !store.getAgent(agent.id)) {
        runLedger.transition({ agentId: agent.id, runId, generation: durableClaim.generation }, "cancelled");
        return reply.code(404).send({ error: "agent not found" });
      }

      if (pendingTurn.communicationEventId) {
        try {
          store.recordRunTrigger(project.id, pendingTurn.communicationEventId, agent.id);
        } catch (error) {
          runLedger.transition({ agentId: agent.id, runId, generation: durableClaim.generation }, "failed");
          return reply.code(409).send({ error: error instanceof Error ? error.message : "message cannot trigger this agent" });
        }
      }

      const userStored = store.appendEvent(agent.id, {
        type: "user_message", text: auditText, communicationEventId: pendingTurn.communicationEventId,
        replyTo: pendingTurn.replyTo, attachments: messageAttachments,
      });
      try {
        await assets.associate(agent.projectId, agent.id, attachmentIds);
      } catch (error) {
        runLedger.transition({ agentId: agent.id, runId, generation: durableClaim.generation }, "failed");
        throw error;
      }
      if (deletingAgentIds.has(agent.id) || !store.getAgent(agent.id)) {
        runLedger.transition({ agentId: agent.id, runId, generation: durableClaim.generation }, "cancelled");
        return reply.code(404).send({ error: "agent not found" });
      }
      publish(agent.id, userStored);

      const startedAt = new Date().toISOString();
      const runningLifecycle = store.appendEvent(agent.id, {
        type: "agent_lifecycle", status: "running", reason: "active_run", executionId: runId,
        ...(effectiveModel ? { model: effectiveModel } : {}),
        ...(effectiveEffort ? { effort: effectiveEffort } : {}),
      });
      publish(agent.id, runningLifecycle);
      const activeRun: ActiveRun = {
        runId, startedAt, executionId: runId, leaseExpiresAt: leaseExpiry(), controller, messageCapability,
        ...(requestedDeliveryIds.length ? { deliveryIds: requestedDeliveryIds } : {}),
        generation: durableClaim.generation,
        ownershipState: "running",
      };
      claimActiveRun(agent.id, activeRun);
      agentMessageCapabilities.set(messageCapability, {
        agentId: agent.id,
        conversationId: routingConversationId,
        runId,
        mentionDepth: mentionDepth ?? 0,
        mentionTrail,
        ...(sharedTaskTurn ? { plainSharedReply: true } : {}),
      });

      void (async () => {
        // Consolidate ordinary response deltas into one durable, execution-scoped
        // Work log entry. Communication is created only by explicit intent calls.
        let runError: string | undefined;
        let finalText = "";
        let firstTextSeq: number | undefined;
        let lastTextSeq: number | undefined;
        try {
          const environment = {
            PONDEROSA_AGENT_MESSAGE_URL: agentMessageUrl,
            PONDEROSA_DOCUMENT_URL: agentMessageUrl.replace(/\/api\/agent-messages$/, "/api/agent-documents"),
            PONDEROSA_AGENT_DIRECTORY_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-directory`,
            PONDEROSA_AGENT_SPAWN_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-spawns`,
            PONDEROSA_AGENT_WAIT_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-waits`,
            PONDEROSA_AGENT_MESSAGE_TOKEN: messageCapability,
            PONDEROSA_AGENT_ROLLOVER_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-session/rollover`,
            PONDEROSA_INTERNAL_SUBAGENTS_DISABLED: "1",
          };
          let persistentRuntime = reusablePersistentRuntime;
          if (engine.adapter.openSession && !persistentRuntime) {
            const session = await engine.adapter.openSession({
              agentId: agent.id,
              cwd: project.hostPath,
              resumeSessionId,
              history,
              model: effectiveModel,
              effort: effectiveEffort,
              environment,
              dynamicTools: [PONDEROSA_SEND_MESSAGE_TOOL, PONDEROSA_SPAWN_AGENT_TOOL, PONDEROSA_WAIT_FOR_REPORTS_TOOL],
              handleDynamicToolCall: async (call) => {
                const url = call.name === PONDEROSA_SEND_MESSAGE_TOOL.name
                  ? "/api/agent-messages"
                  : call.name === PONDEROSA_SPAWN_AGENT_TOOL.name
                    ? "/api/agent-spawns"
                    : call.name === PONDEROSA_WAIT_FOR_REPORTS_TOOL.name
                      ? "/api/agent-waits"
                    : undefined;
                if (!url) {
                  return { success: false, text: `Unknown Ponderosa tool: ${call.name}` };
                }
                const response = await app.inject({
                  method: "POST",
                  url,
                  headers: {
                    authorization: `Bearer ${messageCapability}`,
                    "content-type": "application/json",
                  },
                  payload: JSON.stringify(call.arguments ?? {}),
                });
                return {
                  success: response.statusCode >= 200 && response.statusCode < 300,
                  text: response.body,
                };
              },
              signal: controller.signal,
            });
            persistentRuntime = {
              session,
              iterator: session.events[Symbol.asyncIterator](),
              messageCapability,
            };
            runtimeSessions.set(agent.id, persistentRuntime);
          }
          if (persistentRuntime) {
            activeRun.runtimeSession = persistentRuntime.session;
            scheduleRuntimeLivenessHeartbeat(agent.id, activeRun);
          }
          let persistentTurnStarted = false;
          const startStream = (sessionId?: string): AsyncIterable<AgentEvent> => sessionId
            ? persistentRuntime
              ? {
                  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
                    if (!persistentTurnStarted) {
                      await persistentRuntime!.session.startTurn({
                        prompt,
                        kind: requestedDeliveryIds.length > 0 ? "collaboration" : "user_message",
                        model: effectiveModel,
                        effort: effectiveEffort,
                        clientMessageId: communicationEventId,
                      });
                      persistentTurnStarted = true;
                    }
                    while (true) {
                      const next = await persistentRuntime!.iterator.next();
                      if (next.done) {
                        removePersistentRuntime(agent.id, persistentRuntime!);
                        yield { type: "error", message: "persistent engine session stopped" };
                        return;
                      }
                      yield next.value;
                      if (next.value.type === "turn_done" || next.value.type === "error") return;
                    }
                  },
                }
              : engine.adapter.continue({
                  agentId: agent.id,
                  cwd: project.hostPath,
                  prompt,
                  resumeSessionId: sessionId,
                  model: effectiveModel,
                  effort: effectiveEffort,
                  environment,
                  signal: controller.signal,
                })
            : persistentRuntime
              ? {
                  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
                    if (!persistentTurnStarted) {
                      await persistentRuntime!.session.startTurn({
                        prompt,
                        kind: requestedDeliveryIds.length > 0 ? "collaboration" : "user_message",
                        model: effectiveModel,
                        effort: effectiveEffort,
                        clientMessageId: communicationEventId,
                      });
                      persistentTurnStarted = true;
                    }
                    while (true) {
                      const next = await persistentRuntime!.iterator.next();
                      if (next.done) {
                        removePersistentRuntime(agent.id, persistentRuntime!);
                        yield { type: "error", message: "persistent engine session stopped" };
                        return;
                      }
                      yield next.value;
                      if (next.value.type === "turn_done" || next.value.type === "error") return;
                    }
                  },
                }
              : engine.adapter.seed({
                  agentId: agent.id,
                  cwd: project.hostPath,
                  prompt: freshPrompt,
                  history,
                  model: effectiveModel,
                  effort: effectiveEffort,
                  environment,
                  signal: controller.signal,
                });

          let sessionId = resumeSessionId;
          let rolloverAttempted = false;
          let sawMaterialRuntimeEvent = false;
          while (true) {
            const bufferedSessionEvents: AgentEvent[] = [];
            let retryFresh = false;
            for await (const event of startStream(sessionId)) {
              if (closed || controller.signal.aborted || !renewExecutionLease(agent.id, activeRun)) break;
              if (!receiveRuntimeEvent(agent.id, activeRun)) break;
              if (opts.runtimeEventFaults?.beforePersist && !await waitBeforeRuntimePersist(agent.id, activeRun, event)) break;
              // Codex can emit its session id immediately before a resume-time
              // compaction failure. Hold only those initial session events so a
              // failed resume does not restore the stale id after we clear it.
              if (sessionId && event.type === "session") {
                bufferedSessionEvents.push(event);
                continue;
              }
              if (
                sessionId &&
                !rolloverAttempted &&
                !sawMaterialRuntimeEvent &&
                event.type === "error" &&
                shouldRolloverEngineSession(engine.adapter.id, event.message)
              ) {
                store.clearResumeSession(agent.id, "resume_compaction_failed");
                sessionId = undefined;
                rolloverAttempted = true;
                retryFresh = true;
                break;
              }

              for (const buffered of bufferedSessionEvents.splice(0)) {
                persistRuntimeEvent(agent.id, activeRun, buffered);
              }
              if (event.type !== "error") sawMaterialRuntimeEvent = true;
              const logEvent: LogEvent = event.type === "text" || event.type === "reasoning" || event.type === "work_item_update" || event.type === "turn_done"
                ? { ...event, executionId: runId }
                : event;
              const stored = persistRuntimeEvent(agent.id, activeRun, logEvent);
              if (!stored) break;
              if (event.type === "text") {
                finalText += event.delta;
                firstTextSeq ??= stored.seq;
                lastTextSeq = stored.seq;
              }
              if (event.type === "error") runError = event.message;
            }
            if (!retryFresh) break;
          }
        } catch (err) {
          if (closed || controller.signal.aborted || !ownsActiveRun(agent.id, activeRun)) return;
          const message = err instanceof Error ? err.message : String(err);
          persistRuntimeEvent(agent.id, activeRun, { type: "error", message });
          runError = message;
        } finally {
          const owned = ownsActiveRun(agent.id, activeRun);
          if (owned && scheduledSessionRollovers.delete(agent.id)) {
            store.clearResumeSession(agent.id, "explicit_compaction");
          }
          if (owned && !closed && !controller.signal.aborted) {
            if (!runError && finalText.trim() && firstTextSeq !== undefined && lastTextSeq !== undefined) {
              const output = store.appendEvent(agent.id, {
                type: "agent_output",
                executionId: runId,
                text: finalText.trimEnd(),
                sourceSeqStart: firstTextSeq,
                sourceSeqEnd: lastTextSeq,
              });
              publish(agent.id, output);
            }
            const terminal = store.appendEvent(agent.id, {
              type: "agent_lifecycle",
              status: runError ? "failed" : "completed",
              reason: runError ? "runtime_error" : "turn_completed",
              executionId: runId,
            });
            publish(agent.id, terminal);
            const acceptedSessionId = !runError ? store.resumeSessionId(agent.id) : undefined;
            if (acceptedSessionId) organizationEnvelopeStates.set(agent.id, {
              sessionId: acceptedSessionId,
              hash: organizationEnvelopeHash,
            });
            if (runError) notifyManagerOfChildFailure(agent.id, runId, runError);
          }
          const released = releaseActiveRun(agent.id, activeRun, controller.signal.aborted ? "cancelled" : runError ? "failed" : "completed");
          if (released) {
            agentMessageCapabilities.delete(messageCapability);
          }
          if (released && !closed && requestedDeliveryIds.length) {
            // A cancelled delivery turn is not an acknowledgement. Put it back
            // into the durable queue; ordinary pending deliveries remain queued.
            if (controller.signal.aborted) collaborationDeliveries.requeueBatch(requestedDeliveryIds);
            else if (runError) {
              for (const id of requestedDeliveryIds) collaborationDeliveries.retryFailedTurn(id, runError);
            }
            else collaborationDeliveries.acknowledgeBatch(requestedDeliveryIds);
          }
          if (released && !closed && !controller.signal.aborted && !runError && cursorConversationId && cursorChannel) {
            const acceptedSessionId = store.resumeSessionId(agent.id);
            if (acceptedSessionId) {
              contextCursors.commit({
                agentId: agent.id,
                engine: agent.activeEngine,
                model: cursorModel,
                sessionId: acceptedSessionId,
                conversationId: cursorConversationId,
                channel: cursorChannel,
                lastMessageId: allRoomMessagesIncludingCurrent.at(-1)?.id,
                routingHash,
              });
            }
          }
          const retainedRuntime = runtimeSessions.get(agent.id);
          if (released && retainedRuntime && !closed) scheduleRuntimeIdleClose(agent.id, retainedRuntime);
          // Mentions received while this agent was working are never dropped.
          // Start the oldest queued follow-up as soon as its current turn closes.
          if (released) runDeliveryDispatch(agent.id);
        }
      })();

      return { queued: false, runId, mode, communicationEventId };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { lastEventId?: string } }>(
    "/api/agents/:id/stream",
    async (request, reply) => {
      if (!store.getAgent(request.params.id)) return reply.code(404).send({ error: "agent not found" });
      if ((subscribers.get(request.params.id)?.size ?? 0) >= MAX_SSE_SUBSCRIBERS_PER_STREAM) {
        return reply.code(429).send({ error: "too many stream subscribers" });
      }
      const lastEventId = request.headers["last-event-id"] ?? request.query.lastEventId ?? "0";
      const sinceSeq = Number(Array.isArray(lastEventId) ? lastEventId[0] : lastEventId);
      const replayFrom = Number.isFinite(sinceSeq) ? sinceSeq : 0;

      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      writeSse(reply.raw, "heartbeat", undefined, { ts: new Date().toISOString() });

      let lastWrittenSeq = replayFrom;
      let replaying = true;
      const queued: StoredLogEvent[] = [];
      const writeStored = (stored: StoredLogEvent, replayed = false): void => {
        if (stored.seq <= lastWrittenSeq) return;
        const env = envelope(request.params.id, stored, replayed);
        lastWrittenSeq = stored.seq;
        if (env) writeSse(reply.raw, "message", stored.seq, env);
      };
      const unsubscribe = subscribe(request.params.id, (stored) => {
        if (replaying) {
          queued.push(stored);
          return;
        }
        writeStored(stored);
      });

      for (const stored of store.readEventsSince(request.params.id, replayFrom)) {
        writeStored(stored, true);
      }
      replaying = false;
      for (const stored of queued) writeStored(stored);

      const heartbeat = setInterval(() => {
        writeSse(reply.raw, "heartbeat", undefined, { ts: new Date().toISOString() });
      }, 15000);

      request.raw.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    },
  );

  app.post<{ Params: { id: string } }>("/api/agents/:id/cancel", async (request) => {
    const run = activeRuns.get(request.params.id);
    if (!run || !transitionRun(request.params.id, run, "cancelling")) return { cancelled: false };
    if (run.deliveryIds?.length) collaborationDeliveries.cancelBatch(run.deliveryIds, "cancelled by user");
    const released = releaseActiveRun(request.params.id, run, "cancelled");
    if (released) {
      agentMessageCapabilities.delete(run.messageCapability);
      scheduledSessionRollovers.delete(request.params.id);
    }
    run.controller.abort();
    const runtime = runtimeSessions.get(request.params.id);
    if (runtime) {
      removePersistentRuntime(request.params.id, runtime);
      await runtime.session.close().catch(() => undefined);
    }
    const lifecycle = store.appendEvent(request.params.id, {
      type: "agent_lifecycle", status: "cancelled", reason: "agent_cancelled",
      executionId: run.executionId,
    });
    publish(request.params.id, lifecycle);
    if (released) runDeliveryDispatch(request.params.id);
    return { cancelled: true };
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/compact", async (request, reply) => {
    if (!store.getAgent(request.params.id)) return reply.code(404).send({ error: "agent not found" });
    if (activeRuns.has(request.params.id)) {
      return reply.code(409).send({ error: "cannot compact an agent with an active run", retryable: true });
    }
    const runtime = runtimeSessions.get(request.params.id);
    if (runtime) {
      removePersistentRuntime(request.params.id, runtime);
      await runtime.session.close();
    }
    return { compacted: store.clearResumeSession(request.params.id, "explicit_compaction") };
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id/runs", async (request, reply) => {
    if (!store.getAgent(request.params.id)) return reply.code(404).send({ error: "agent not found" });
    return store.getRuns(request.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id/work-items", async (request, reply) => {
    if (!store.getAgent(request.params.id)) return reply.code(404).send({ error: "agent not found" });
    return store.getWorkItems(request.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id/artifacts", async (request, reply) => {
    if (!store.getAgent(request.params.id)) return reply.code(404).send({ error: "agent not found" });
    return store.getArtifacts(request.params.id);
  });

  app.get<{ Params: { projectId: string; documentId: string } }>(
    "/api/projects/:projectId/communication-documents/:documentId",
    async (request, reply) => {
      const found = store.getCommunicationDocument(request.params.projectId, request.params.documentId);
      if (!found) return reply.code(404).send({ error: "document not found" });
      const { content, ...metadata } = found.document;
      const root = `/api/projects/${encodeURIComponent(request.params.projectId)}/communication-documents/${encodeURIComponent(found.document.id)}`;
      return { ...metadata, previewUrl: root, downloadUrl: `${root}/download`, content };
    },
  );

  app.get<{ Params: { projectId: string; documentId: string } }>(
    "/api/projects/:projectId/communication-documents/:documentId/download",
    async (request, reply) => {
      const found = store.getCommunicationDocument(request.params.projectId, request.params.documentId);
      if (!found) return reply.code(404).send({ error: "document not found" });
      return reply.type("text/markdown; charset=utf-8")
        .header("Content-Disposition", contentDisposition(`${found.document.title}.md`))
        .send(found.document.content);
    },
  );

  async function generatedPdf(
    projectId: string,
    agentId: string,
    artifactId: string,
  ): Promise<{ body: Buffer; name: string } | undefined> {
    const project = store.getProject(projectId);
    const agent = store.getAgent(agentId);
    if (!project || !agent || agent.projectId !== project.id) return undefined;
    const generatedPath = store.getGeneratedPdfPath(agent.id, artifactId);
    if (!generatedPath) return undefined;
    try {
      const root = await fs.realpath(project.hostPath);
      const candidate = path.isAbsolute(generatedPath)
        ? generatedPath
        : path.resolve(root, generatedPath);
      const resolved = await fs.realpath(candidate);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return undefined;
      const info = await fs.stat(resolved);
      if (!info.isFile() || info.size > 32 * 1024 * 1024) return undefined;
      return { body: await fs.readFile(resolved), name: path.basename(resolved) };
    } catch {
      return undefined;
    }
  }

  app.get<{ Params: { projectId: string; id: string; aid: string } }>(
    "/api/projects/:projectId/agents/:id/generated-artifacts/:aid/preview",
    async (request, reply) => {
      const file = await generatedPdf(request.params.projectId, request.params.id, request.params.aid);
      if (!file) return reply.code(404).send({ error: "generated PDF not found" });
      return reply.type("application/pdf").header("Content-Disposition", contentDisposition(file.name).replace(/^attachment/, "inline")).send(file.body);
    },
  );

  app.get<{ Params: { projectId: string; id: string; aid: string } }>(
    "/api/projects/:projectId/agents/:id/generated-artifacts/:aid/download",
    async (request, reply) => {
      const file = await generatedPdf(request.params.projectId, request.params.id, request.params.aid);
      if (!file) return reply.code(404).send({ error: "generated PDF not found" });
      return reply.type("application/pdf").header("Content-Disposition", contentDisposition(file.name)).send(file.body);
    },
  );

  app.get<{ Params: { id: string; aid: string } }>(
    "/api/agents/:id/artifacts/:aid",
    async (request, reply) => {
      const agent = store.getAgent(request.params.id);
      if (!agent) return reply.code(404).send({ error: "agent not found" });
      const artifact = store.getArtifact(agent.id, request.params.aid);
      if (!artifact) return reply.code(404).send({ error: "artifact not found" });
      const file = artifactContentPath(opts.dataDir, agent.projectId, agent.id, artifact.path);
      if (existsSync(file) && (await fs.stat(file)).size > MAX_FILE_BYTES) return reply.code(413).send({ error: "artifact exceeds 2 MiB viewer limit" });
      const content = existsSync(file) ? await fs.readFile(file, "utf8") : "";
      return { ...artifact, content, contentType: contentTypeForArtifact(artifact.path) };
    },
  );

  app.get<{ Querystring: { projectId?: string; path?: string } }>("/api/files", async (request, reply) => {
    const projectId = request.query.projectId;
    if (!projectId) return reply.code(400).send({ error: "projectId is required" });
    const project = store.getProject(projectId);
    if (!project) return reply.code(404).send({ error: "project not found" });
    try {
      return await readScopedPath(project.hostPath, request.query.path);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "invalid path" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/workspace", async (request, reply) => {
    const project = store.getProject(request.params.id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    return workspaceStatus(project.id, project.hostPath);
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/projects/:id/workspace/file", async (request, reply) => {
    const project = store.getProject(request.params.id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    try {
      return await workspaceFile(project.id, project.hostPath, request.query.path);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid workspace path" });
    }
  });

  app.get("/api/engines", async (): Promise<EngineDto[]> => {
    return Promise.all(
      Array.from(engines.values()).map(async ({ adapter, authStatus }) => {
        let status: EngineAuthStatus;
        try {
          status = authStatus
            ? await engineAuthStatuses.get(adapter.id, authStatus)
            : { authenticated: false };
        } catch (err) {
          status = {
            authenticated: false,
            detail: err instanceof Error ? err.message : "auth status check failed",
          };
        }
        const models = adapter.listModels();
        return {
          id: adapter.id,
          displayName: adapter.displayName,
          models: models.map((model) => ({
            ...model,
            ...(model.efforts !== undefined
              ? { efforts: model.efforts }
              : !adapter.modelSpecificEfforts || !model.id
                ? { efforts: adapter.listEfforts(model.id || undefined) }
                : {}),
          })),
          efforts: adapter.listEfforts(),
          modelCatalogKnown: !adapter.modelSpecificEfforts || models.some((model) => Boolean(model.id)),
          authenticated: status.authenticated,
          authDetail: status.detail,
        };
      }),
    );
  });

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/engine-capabilities",
    async (request, reply): Promise<ProjectEngineCapabilitiesDto[] | FastifyReply> => {
      const project = store.getProject(request.params.id);
      if (!project) return reply.code(404).send({ error: "project not found" });
      return Promise.all([...engines.values()].map(({ adapter }) => {
        const key = `${project.hostPath}\0${adapter.id}`;
        const cached = engineCapabilityCache.get(key);
        if (cached && cached.expiresAt > Date.now()) return cached.value;
        const value = Promise.resolve(adapter.capabilities
          ? adapter.capabilities(project.hostPath)
          : { steering: false, persistentSessions: false, commands: [], mcpServers: [] })
          .then((capabilities) => ({ engineId: adapter.id, ...capabilities }));
        engineCapabilityCache.set(key, { expiresAt: Date.now() + 5 * 60_000, value });
        void value.catch(() => engineCapabilityCache.delete(key));
        return value;
      }));
    },
  );

  if (opts.webDist) {
    app.get("/*", async (request, reply) => {
      try {
        const rawPath = request.url.split("?")[0] ?? "/";
        if (rawPath === "/api" || rawPath.startsWith("/api/")) return reply.code(404).send();
        const rel = rawPath === "/" ? "index.html" : safeRelativePath(decodeURIComponent(rawPath.slice(1)));
        const target = path.resolve(opts.webDist!, rel);
        const root = path.resolve(opts.webDist!);
        if (target !== root && !target.startsWith(root + path.sep)) return reply.code(404).send();
        const targetExists = await pathExists(target);
        const file = targetExists ? target : path.join(root, "index.html");
        if (!targetExists && !(await pathExists(file))) return reply.code(404).send();
        const [rootReal, fileReal] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
        if (fileReal !== rootReal && !fileReal.startsWith(rootReal + path.sep)) return reply.code(404).send();
        return reply
          .header("Cache-Control", cacheControlForStatic(file))
          .type(contentTypeForStatic(file))
          .send(await fs.readFile(file));
      } catch {
        return reply.code(404).send();
      }
    });
  }

  return app;
}
