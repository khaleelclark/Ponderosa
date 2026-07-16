import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";
import { promises as dns } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type Socket } from "node:net";
import type { IncomingMessage } from "node:http";
import { Readable, Transform } from "node:stream";
import { constants as fsConstants, existsSync, promises as fs } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import webpush from "web-push";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import type {
  Adapter,
  ApiPriceProfile,
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
  HostFolderBrowseDto,
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
  QueuedConversationMessageDto,
  CancelQueuedMessageRequest,
  CancelQueuedMessageResponse,
  CorrectConversationMessageRequest,
  CorrectConversationMessageResponse,
  SseEventEnvelope,
  AgentStreamEvent,
  SendAgentMessageRequest,
  AgentDto,
  MessageReferenceDto,
  RuntimeSession,
  UpdateAgentOrganizationRequest,
  TeamDirectoryDto,
  TokenUsage,
  TokenUsageRangeDto,
  TokenUsageBreakdownDto,
  TokenUsageSummaryDto,
  ProjectedApiCostComponentsDto,
  PutConversationDraftRequest,
  DraftAttachmentDto,
  UpdateWorkspacePreferencesRequest,
  WorkspaceEventEnvelope,
  WorkspaceEvent,
  WorkspaceNotificationDto,
  NotificationPreferencesDto,
  NotificationPreference,
  VerifiedCitationDto,
  WebPushSubscriptionDto,
  CancelAgentRunRequest,
  CancelAgentRunResponse,
  CreateLinkPreviewRequest,
  LinkPreviewDto,
} from "@ponderosa/core";
import {
  agentRoleProfile,
  deriveCommunicationBehavior,
  PONDEROSA_COORDINATE_TOOL,
  PONDEROSA_MESSAGE_TOOL,
  PONDEROSA_UPDATE_REQUEST_TOOL,
  TERMINAL_REQUEST_STATES,
  type CoordinationRequestState,
  type CoordinationRequestUpdateKind,
  type RequestLifetime,
} from "@ponderosa/core";
import { artifactContentPath, attachmentPath, attachmentsDir, type LogEvent, type ConversationDeliveryIntent, type StoredLogEvent, AgentStore, WorkspaceStore, CoordinationV3Store } from "@ponderosa/agents";
import { ASSET_LIMITS, AssetError, AssetStore, contentDisposition } from "./assets.js";
import { ContextCursorStore } from "./context-cursors.js";
import { EngineAuthStatusCache } from "./engine-auth-cache.js";
import { projectAgentHealth, type ActiveRunObservation } from "./agent-health.js";
import { UserReactionStore } from "./user-reactions.js";
import { CoordinationV3Scheduler } from "./coordination-v3-scheduler.js";

type RuntimeOwnershipState = "running" | "stalled" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted";

type LinkPreviewSocketPair = {
  client: WebSocket;
  upstream: WebSocket;
  openedAt: number;
  lastActivityAt: number;
  clientAlive: boolean;
  upstreamAlive: boolean;
  closing?: boolean;
};

type LinkPreviewRegistration = {
  origin: string;
  expiresAt: number;
  projectId: string;
  agentId: string;
  runId: string;
  conversationId?: string;
  connections: Set<LinkPreviewSocketPair>;
  httpConnections: Set<AbortController>;
  reconnectAttempts: number[];
};

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
  /** Deterministic test seam; production resolves and pins public DNS itself. */
  linkFaviconLoader?: (target: URL) => Promise<{ body: Buffer; mediaType: string }>;
  /** Deterministic limits for the opaque localhost-preview transport. */
  linkPreviewScheduling?: {
    registrationTtlMs?: number;
    upstreamHandshakeTimeoutMs?: number;
    heartbeatMs?: number;
    maxConnectionsPerRegistration?: number;
    maxTotalConnections?: number;
    maxPayloadBytes?: number;
    maxBufferedBytes?: number;
    maxPendingFrames?: number;
    maxHttpConnectionsPerRegistration?: number;
    maxIdleMs?: number;
    closeGraceMs?: number;
    maxReconnectsPerWindow?: number;
    reconnectWindowMs?: number;
  };
  /** Explicit roots exposed by the host folder picker. */
  allowedBrowseRoots?: string[];
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
  /** Communication V3 scheduler tuning. V3 is unconditional. */
  communicationV3?: {
    maxConcurrentRuns?: number;
    pollMs?: number;
    /** Scheduler ownership lease. Defaults to the provider execution lease so
     * ordinary long turns cannot be mistaken for abandoned work. */
    leaseMs?: number;
  };
  /** Deterministic message-claim race seam; never enabled in production configuration. */
  messageLifecycleFaults?: {
    beforeRunClaim?: (context: { agentId: string; runId: string }) => void | Promise<void>;
    afterRunClaim?: (context: { agentId: string; runId: string; generation: number }) => void | Promise<void>;
  };
}

const nonPublicFaviconAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) nonPublicFaviconAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["100::", 64],
  ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) nonPublicFaviconAddresses.addSubnet(network, prefix, "ipv6");

function externalFaviconTarget(raw: string): URL | undefined {
  let target: URL;
  try { target = new URL(raw); } catch { return undefined; }
  const hostname = target.hostname.toLowerCase();
  if (target.protocol !== "https:" || target.username || target.password || (target.port && target.port !== "443")
    || !hostname || hostname === "localhost" || hostname.endsWith(".local") || isIP(hostname)) return undefined;
  return new URL(`https://${hostname}/favicon.ico`);
}

async function loadExternalFavicon(target: URL): Promise<{ body: Buffer; mediaType: string }> {
  const addresses = await dns.lookup(target.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address, family }) => nonPublicFaviconAddresses.check(address, family === 6 ? "ipv6" : "ipv4"))) {
    throw new Error("favicon host does not resolve exclusively to public addresses");
  }
  const selected = addresses[0]!;
  return await new Promise((resolve, reject) => {
    const request = httpsRequest({
      protocol: "https:", hostname: target.hostname, port: 443, path: "/favicon.ico", method: "GET",
      servername: target.hostname,
      headers: { accept: "image/png,image/x-icon,image/vnd.microsoft.icon,image/gif,image/webp,image/jpeg", "user-agent": "Ponderosa favicon fetch" },
      lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
    }, (response) => {
      const mediaType = (response.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
      const allowed = new Set(["image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/gif", "image/webp", "image/jpeg"]);
      if (response.statusCode !== 200 || !allowed.has(mediaType)) {
        response.resume();
        reject(new Error("favicon response was unavailable or unsafe"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) request.destroy(new Error("favicon exceeds 64 KiB"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve({ body: Buffer.concat(chunks), mediaType }));
      response.on("error", reject);
    });
    request.setTimeout(5_000, () => request.destroy(new Error("favicon request timed out")));
    request.on("error", reject);
    request.end();
  });
}

interface ActiveRun {
  runId: string;
  startedAt: string;
  executionId: string;
  leaseExpiresAt: string;
  controller: AbortController;
  messageCapability: string;
  leaseTimer?: NodeJS.Timeout;
  livenessTimer?: NodeJS.Timeout;
  generation: number;
  ownershipState: RuntimeOwnershipState;
  lastEventReceivedAt?: string;
  lastEventPersistedAt?: string;
  runtimeSession?: RuntimeSession;
  v3SchedulerRunId?: string;
  v3FencingToken?: number;
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
  sourceChannel?: "main";
  sourceConversationId?: string;
  sourceAuthorAgentId?: string;
  replyTo?: MessageReferenceDto;
  replyToMessageId?: string;
  attachmentIds?: string[];
}

interface AgentMessageCapability {
  agentId: string;
  conversationId?: string;
  runId: string;
  v3SchedulerRunId: string;
  v3FencingToken: number;
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

function communicationV3Prompt(): string[] {
  return [
    "Communication V3 separates messages, correlated requests, joins, activations, and runs.",
    "Your ordinary runtime response is Work log only. Explicitly use ponderosa_message when a user, agent, or the organization needs uncorrelated information.",
    "Use ponderosa_coordinate for tracked work or consultation. In every request JSON object, include lifetime: {kind: \"indefinite\"} unless it has a real deadline, in which case use {kind: \"deadline\", at: <ISO timestamp>}.",
    "Every coordination request must be self-contained. The recipient receives the request text and durable activation payload, not your hidden prompt or provider-session context. Include exact constraints, values, artifact paths, and the requested output; never refer only to \"the constraints above\" or similar missing context.",
    "A coordination request does not make you wait. Add the optional join only when your next action depends on all, any, or a quorum of the request outcomes.",
    "Prefer creating related requests and their join in one coordinate call. If valid requests were already created separately, recover without duplicating them by calling coordinate with a new idempotencyKey, requests: [], and join: {mode, requestIds: [their returned IDs]}.",
    "When a successful coordinate result contains joinId, that join already exists. Do not create or recover it again; end the turn if no other action remains.",
    "If an activation contains fullResultRef, call ponderosa_coordinate with inspectActivationIds containing those activation IDs to retrieve the complete durable payload.",
    "Use ponderosa_update_request for progress, temporary waiting_dependency, dependency_resolved, one blocking question, a correlated answer, or a terminal outcome. When this run has exactly one attached correlated request, omit requestId so Ponderosa resolves it from authoritative run state; provide an exact requestId only when multiple requests are attached. As a request recipient, reply to the request itself with completed—even when its text is a consultation question. Use question only to ask the original requester for missing information; answer is only the original requester replying to that question and references the question updateId.",
    "A terminal request update is a commit point: finish the request's edits and final checks first; afterward, do not change request-owned work or send a duplicate follow-up message because the requester receives the outcome through its join.",
    "An ordinary message to that requester after your terminal update is retained as a passive audit copy and does not wake them. If you discover a genuinely material correction that requires action, send it with urgency urgent; do not use urgency to repeat or embellish the committed result.",
    "Questions use a stable updateId; answers must reference it with inReplyToUpdateId. blocked is terminal; waiting_dependency is temporary.",
    "A human message, question, or urgent event never cancels your existing joins. Handle the activation and return to waiting when a join remains unresolved.",
    "Keep bounded work context-bounded: inspect only necessary resources with targeted queries and bounded ranges; never load an entire large artifact or unbounded log/diff when a focused view will do. Avoid rereading unchanged material, run final verification once, then publish the terminal update and stop.",
    "Do not poll, sleep, send acknowledgments, or create progress-only wakeups. End the turn after creating a join when no other action remains.",
    "Only these three communication tools exist: ponderosa_coordinate, ponderosa_update_request, and ponderosa_message.",
    'Discover stable teammate IDs with GET "$PONDEROSA_AGENT_DIRECTORY_URL" using the Bearer token.',
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
    '  Call ponderosa_message with {"intent":"broadcast","text":"<final answer>","idempotencyKey":"stable-completion-key"}.',
  ].join("\n");
}

function directUserRequestCompletionPrompt(): string {
  return [
    "Required completion contract for this private user-to-agent request:",
    "- Before this run ends, send exactly one direct_to_user message containing the answer, completed result, question, or material blocker for the user.",
    "- Do not Broadcast this private reply. Broadcast is only for a separate durable organizational update you intentionally choose to make.",
    "- The user cannot see your ordinary runtime response; it is audit-only Work log output.",
    '- Call ponderosa_message with {"intent":"direct_to_user","text":"<reply>","idempotencyKey":"stable-reply-key"}.',
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
    ...communicationV3Prompt(),
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

function individualChatPrompt(currentRequest: string, context: InboundMessageContext): string {
  return [
    "You are replying in your individual Ponderosa agent chat.",
    ...messageContextPrompt(context),
    ...communicationV3Prompt(),
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

export function parseTokenUsageRange(query: { from?: string; to?: string }): TokenUsageRangeDto {
  const range: TokenUsageRangeDto = {};
  for (const key of ["from", "to"] as const) {
    const value = query[key];
    if (value === undefined) continue;
    const timestamp = new Date(value);
    if (!value.trim() || Number.isNaN(timestamp.valueOf())) throw new Error(`${key} must be a valid ISO timestamp`);
    range[key] = timestamp.toISOString();
  }
  if (range.from && range.to && range.from >= range.to) throw new Error("from must be earlier than to");
  return range;
}

type RawCostComponents = {
  [Key in keyof ProjectedApiCostComponentsDto]: { tokens: number; usd: number };
};

function emptyCostComponents(): RawCostComponents {
  return {
    uncachedInput: { tokens: 0, usd: 0 },
    cachedInput: { tokens: 0, usd: 0 },
    cacheWriteInput: { tokens: 0, usd: 0 },
    output: { tokens: 0, usd: 0 },
  };
}

function addTokenUsage(target: TokenUsage, source: TokenUsage): void {
  const keys: Array<keyof TokenUsage> = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) target[key] = (target[key] ?? 0) + value;
  }
}

function addCostComponents(target: RawCostComponents, source: RawCostComponents): void {
  for (const key of Object.keys(target) as Array<keyof RawCostComponents>) {
    target[key].tokens += source[key].tokens;
    target[key].usd += source[key].usd;
  }
}

function serializedCostComponents(components: RawCostComponents): ProjectedApiCostComponentsDto {
  return Object.fromEntries(Object.entries(components).map(([key, value]) => [key, {
    tokens: value.tokens,
    usd: roundedUsd(value.usd),
  }])) as unknown as ProjectedApiCostComponentsDto;
}

/**
 * The workspace stream is a coarse invalidation bus, not a second copy of every
 * agent's execution stream. High-frequency output stays on the per-agent SSE
 * channel and in the canonical agent log.
 */
export function workspaceAgentEventCategory(event: LogEvent): Extract<WorkspaceEvent, { type: "agent_event" }>["category"] | undefined {
  switch (event.type) {
    case "agent_lifecycle": return "lifecycle";
    case "file_change": return "file";
    case "command":
    case "work_item_update":
    case "test_result": return "task";
    case "session":
    case "session_reset": return "state";
    case "communication_projection": return "message";
    default: return undefined;
  }
}

export function notificationKindForCommunication(event: CommunicationEvent): WorkspaceNotificationDto["kind"] | undefined {
  if (event.sender.kind !== "agent") return undefined;
  if (event.intent === "broadcast") return "broadcasts";
  if (event.schemaVersion === 2 && event.intent === "user_dm") return "direct_responses";
  if (event.audienceSelector === "everyone") return "everyone";
  if (event.intent === "collaboration") return "collaboration";
  return undefined;
}

export function notificationPreferenceMatches(
  preference: NotificationPreference | NotificationPreferencesDto,
  event: CommunicationEvent,
  kind: WorkspaceNotificationDto["kind"],
): boolean {
  if (typeof preference === "object") {
    if (preference.allMessages) return true;
    if (kind === "direct_responses") return preference.directReplies;
    if (kind === "project_responses") return preference.projectChatMessages && event.intent === "broadcast" && Boolean(event.conversationId);
    if (kind === "broadcasts" || kind === "everyone") return preference.broadcasts;
    if (kind === "mentions") return preference.mentions;
    return false;
  }
  if (preference === "none") return false;
  if (preference === "all_messages") return true;
  if (preference === "project_responses") return event.intent === "broadcast" && Boolean(event.conversationId);
  // #user is represented structurally as an agent-to-user DM, never inferred
  // from rendered text. It is the only current communication that mentions the operator.
  if (preference === "mentions") return kind === "direct_responses";
  return preference === kind;
}

export function conciseConversationTitle(text: string): string | undefined {
  const normalized = text
    .replace(/^\s*(?:#(?:broadcast|everyone|user|[\w-]+)\s+)+/i, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[`*_#>\[\](){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  const words = normalized.split(" ").filter(Boolean).slice(0, 6);
  if (words.length < 2) return undefined;
  return words.join(" ").replace(/[\s,.;:!?-]+$/g, "").slice(0, 72).trim() || undefined;
}

const TITLE_STOP_WORDS = new Set("a an and are as at be by can could for from get give have how i if in into is it me my of on or please request should that the this to update we what when with you your".split(" "));

/** Deterministic semantic title used when no provider title service is
 * available. It combines the first operator intent and first agent outcome,
 * extracts distinctive terms, and title-cases them without copying a query. */
export function semanticConversationTitle(operatorText: string, agentText: string): string | undefined {
  // Deliberately title the outcome rather than copying/truncating the
  // operator's request. Keep the intent parameter in the contract for a
  // future local summarizer without changing the route shape.
  void operatorText;
  const words = agentText
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 2 && !TITLE_STOP_WORDS.has(word.toLowerCase()));
  const unique: string[] = [];
  for (const word of words) if (!unique.some((item) => item.toLowerCase() === word.toLowerCase())) unique.push(word);
  if (unique.length === 0) return undefined;
  return unique.slice(0, 5).map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ").slice(0, 72);
}

export function normalizeExternalCitations(value: unknown, verifiedAt = new Date().toISOString()): VerifiedCitationDto[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) throw new Error("citations must be an array of at most 10 sources");
  const result = new Map<string, VerifiedCitationDto>();
  for (const item of value) {
    const source = item as { url?: unknown; title?: unknown };
    const title = typeof source?.title === "string" ? source.title.trim().replace(/\s+/g, " ") : "";
    if (!title || title.length > 240 || typeof source?.url !== "string" || source.url.length > 2048) {
      throw new Error("each citation requires a URL and a title of at most 240 characters");
    }
    let url: URL;
    try { url = new URL(source.url); } catch { throw new Error("citation URL is invalid"); }
    const hostname = url.hostname.toLowerCase();
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || hostname === "localhost" || hostname.endsWith(".local") || /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|::1$|fc|fd)/i.test(hostname)) {
      throw new Error("citation URL must be an external HTTP(S) address without credentials");
    }
    url.hash = "";
    result.set(url.toString(), { url: url.toString(), title, verifiedAt });
  }
  return [...result.values()];
}

function projectedRequestCost(usage: TokenUsage, profile: ApiPriceProfile): { usd: number; components: RawCostComponents } | undefined {
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
  const components: RawCostComponents = {
    uncachedInput: { tokens: uncached, usd: uncached * profile.inputUsdPerMillion * inputMultiplier / 1_000_000 },
    cachedInput: { tokens: cached, usd: cached * profile.cachedInputUsdPerMillion * inputMultiplier / 1_000_000 },
    cacheWriteInput: { tokens: cacheWrite, usd: cacheWrite * cacheWriteRate * inputMultiplier / 1_000_000 },
    output: { tokens: usage.outputTokens, usd: usage.outputTokens * profile.outputUsdPerMillion * outputMultiplier / 1_000_000 },
  };
  return { usd: Object.values(components).reduce((total, item) => total + item.usd, 0), components };
}

/** Price request-tiered models per provider request, never from an aggregate guess. */
export function projectedRunCost(
  usage: TokenUsage,
  profile: ApiPriceProfile,
  providerRequestUsage?: TokenUsage[],
): { usd: number; components: RawCostComponents } | undefined {
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  const requiresRequestGranularity = Boolean(
    profile.longContext && usage.inputTokens > profile.longContext.inputTokenThreshold,
  );
  if (!requiresRequestGranularity) return projectedRequestCost(usage, profile);
  if (!providerRequestUsage?.length) return undefined;

  const reconciledKeys: Array<keyof TokenUsage> = [
    "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens",
  ];
  for (const key of reconciledKeys) {
    const aggregateValue = usage[key] ?? 0;
    const requestValue = providerRequestUsage.reduce((total, request) => total + (request[key] ?? 0), 0);
    if (aggregateValue !== requestValue) return undefined;
  }

  const components = emptyCostComponents();
  let usd = 0;
  for (const request of providerRequestUsage) {
    const cost = projectedRequestCost(request, profile);
    if (!cost) return undefined;
    usd += cost.usd;
    addCostComponents(components, cost.components);
  }
  return { usd, components };
}

export function createServer(opts: CreateServerOptions): FastifyInstance {
  const store = opts.store ?? new AgentStore(opts.dataDir);
  const coordinationV3 = new CoordinationV3Store(store.sqlite);
  const coordinationV3WorkerId = `server:${process.pid}`;
  const workspace = new WorkspaceStore(opts.dataDir);
  const workspaceSubscribers = new Set<(event: WorkspaceEventEnvelope) => void>();
  const publishWorkspace = (event: WorkspaceEventEnvelope): void => {
    for (const subscriber of workspaceSubscribers) subscriber(event);
  };
  const appendWorkspace = (event: Parameters<WorkspaceStore["append"]>[0]): WorkspaceEventEnvelope => {
    const stored = workspace.append(event);
    publishWorkspace(stored);
    return stored;
  };
  const publishWorkspaceSince = (cursor: number): void => {
    for (const event of workspace.readSince(cursor)) publishWorkspace(event);
  };
  const vapid = {
    publicKey: process.env.PONDEROSA_VAPID_PUBLIC_KEY?.trim(),
    privateKey: process.env.PONDEROSA_VAPID_PRIVATE_KEY?.trim(),
    subject: process.env.PONDEROSA_VAPID_SUBJECT?.trim() || "mailto:admin@localhost",
  };
  const webPushConfigured = Boolean(vapid.publicKey && vapid.privateKey);
  if (webPushConfigured) webpush.setVapidDetails(vapid.subject, vapid.publicKey!, vapid.privateKey!);
  async function deliverPush(notification: import("@ponderosa/core").WorkspaceNotificationDto): Promise<void> {
    if (!webPushConfigured) return;
    await Promise.allSettled(workspace.listPushSubscriptions().map(async (subscription) => {
      try {
        await webpush.sendNotification({ endpoint: subscription.endpoint, expirationTime: subscription.expirationTime, keys: subscription.keys }, JSON.stringify({
          notificationId: notification.id,
          title: notification.title,
          body: notification.body,
          projectId: notification.projectId,
          conversationId: notification.conversationId,
          url: notification.conversationId
            ? `/projects/${encodeURIComponent(notification.projectId)}/chats/${encodeURIComponent(notification.conversationId)}`
            : `/projects/${encodeURIComponent(notification.projectId)}`,
        }), { TTL: 60 * 60, urgency: "normal", topic: notification.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) });
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          const cursor = workspace.cursor();
          workspace.deletePushSubscription(subscription.deviceId);
          publishWorkspaceSince(cursor);
        }
      }
    }));
  }
  store.recoverInterruptedExecutions();
  const assets = new AssetStore(opts.dataDir);
  const engines = new Map(opts.engines.map((engine) => [engine.adapter.id, engine]));
  const projectedUsage = (
    scope: { type: "overall" } | { type: "project" | "agent"; id: string },
    range: TokenUsageRangeDto = {},
  ): TokenUsageSummaryDto => {
    const summary = store.getTokenUsage(scope, range);
    const grouped = new Map<string, { engine: string; requestedModel?: string; profile: ApiPriceProfile; runs: number; usd: number; components: RawCostComponents }>();
    const usageGrouped = new Map<string, TokenUsageBreakdownDto>();
    const recentTurns: TokenUsageSummaryDto["recentTurns"] = [];
    const components = emptyCostComponents();
    let pricedRuns = 0;
    for (const run of store.getMeteredRuns(scope, range)) {
      const profile = engines.get(run.engine)?.adapter.apiPriceProfile?.(run.model);
      const cost = profile ? projectedRunCost(run.usage, profile, run.providerRequestUsage) : undefined;
      const usageKey = [run.projectId, run.conversationId ?? "", run.agentId, run.engine, run.model ?? ""].join("\0");
      const usageCurrent: TokenUsageBreakdownDto = usageGrouped.get(usageKey) ?? {
        projectId: run.projectId,
        ...(run.conversationId ? { conversationId: run.conversationId } : {}),
        agentId: run.agentId,
        agentTitle: run.agentTitle,
        engine: run.engine as TokenUsageBreakdownDto["engine"],
        ...(run.model ? { model: run.model } : {}),
        runs: 0,
        usage: {},
        pricingAvailableRuns: 0,
        unpricedRuns: 0,
      };
      usageCurrent.runs += 1;
      addTokenUsage(usageCurrent.usage, run.usage);
      if (cost && profile) {
        pricedRuns += 1;
        usageCurrent.pricingAvailableRuns += 1;
        usageCurrent.estimatedCostUsd = roundedUsd((usageCurrent.estimatedCostUsd ?? 0) + cost.usd);
        const key = `${run.engine}\0${run.model ?? ""}\0${profile.pricingModel}`;
        const current = grouped.get(key) ?? { engine: run.engine, requestedModel: run.model, profile, runs: 0, usd: 0, components: emptyCostComponents() };
        current.runs += 1;
        current.usd += cost.usd;
        addCostComponents(current.components, cost.components);
        addCostComponents(components, cost.components);
        grouped.set(key, current);
      } else {
        usageCurrent.unpricedRuns += 1;
      }
      usageGrouped.set(usageKey, usageCurrent);
      recentTurns.push({
        projectId: run.projectId,
        ...(run.conversationId ? { conversationId: run.conversationId } : {}),
        agentId: run.agentId,
        agentTitle: run.agentTitle,
        executionId: run.executionId,
        engine: run.engine as TokenUsageBreakdownDto["engine"],
        ...(run.model ? { model: run.model } : {}),
        startedAt: run.startedAt,
        ...(run.completedAt ? { completedAt: run.completedAt } : {}),
        usage: run.usage,
        ...(cost && profile ? { estimatedCostUsd: roundedUsd(cost.usd), pricingModel: profile.pricingModel } : {}),
        pricingAvailable: Boolean(cost && profile),
      });
    }
    const costBreakdown = [...grouped.values()].map((item) => ({
      engine: item.engine,
      ...(item.requestedModel ? { requestedModel: item.requestedModel } : {}),
      pricingModel: item.profile.pricingModel,
      proxy: Boolean(item.profile.proxy),
      runs: item.runs,
      usd: roundedUsd(item.usd),
      components: serializedCostComponents(item.components),
    })).sort((a, b) => b.usd - a.usd);
    const catalogVersion = [...grouped.values()].map((item) => item.profile.catalogVersion).sort().at(-1) ?? "2026-07-13";
    return {
      ...summary,
      breakdown: [...usageGrouped.values()].sort((a, b) => (b.estimatedCostUsd ?? 0) - (a.estimatedCostUsd ?? 0) || b.runs - a.runs),
      recentTurns: recentTurns.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 10),
      projectedApiCost: {
        currency: "USD",
        usd: roundedUsd(costBreakdown.reduce((total, item) => total + item.usd, 0)),
        basis: "api_list_price_proxy",
        catalogVersion,
        pricedRuns,
        unpricedRuns: summary.finalizedRuns - pricedRuns,
        coverage: summary.finalizedRuns ? pricedRuns / summary.finalizedRuns : null,
        components: serializedCostComponents(components),
        breakdown: costBreakdown,
      },
    };
  };
  const activeRuns = new Map<string, ActiveRun>();
  const linkPreviews = new Map<string, LinkPreviewRegistration>();
  const linkPreviewTtlMs = opts.linkPreviewScheduling?.registrationTtlMs ?? 4 * 60 * 60 * 1000;
  const linkPreviewHandshakeTimeoutMs = opts.linkPreviewScheduling?.upstreamHandshakeTimeoutMs ?? 10_000;
  const linkPreviewHeartbeatMs = opts.linkPreviewScheduling?.heartbeatMs ?? 5_000;
  const linkPreviewMaxPerRegistration = opts.linkPreviewScheduling?.maxConnectionsPerRegistration ?? 8;
  const linkPreviewMaxTotal = opts.linkPreviewScheduling?.maxTotalConnections ?? 32;
  const linkPreviewMaxPayload = opts.linkPreviewScheduling?.maxPayloadBytes ?? 1024 * 1024;
  const linkPreviewMaxBuffered = opts.linkPreviewScheduling?.maxBufferedBytes ?? 2 * 1024 * 1024;
  const linkPreviewMaxPendingFrames = opts.linkPreviewScheduling?.maxPendingFrames ?? 64;
  const linkPreviewMaxHttpPerRegistration = opts.linkPreviewScheduling?.maxHttpConnectionsPerRegistration ?? 64;
  const linkPreviewCloseGraceMs = opts.linkPreviewScheduling?.closeGraceMs ?? 1_000;
  const linkPreviewMaxPathBytes = 4 * 1024;
  const linkPreviewMaxReconnectsPerWindow = opts.linkPreviewScheduling?.maxReconnectsPerWindow ?? 24;
  const linkPreviewReconnectWindowMs = opts.linkPreviewScheduling?.reconnectWindowMs ?? 10_000;
  const linkPreviewMaxIdleMs = opts.linkPreviewScheduling?.maxIdleMs ?? 2 * 60 * 1000;
  const linkPreviewMaxConnectionLifetimeMs = Math.min(linkPreviewTtlMs, 4 * 60 * 60 * 1000);
  const linkPreviewWss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: linkPreviewMaxPayload,
    handleProtocols: (protocols) => protocols.has("vite-hmr") ? "vite-hmr" : protocols.has("vite-ping") ? "vite-ping" : false,
  });
  let linkPreviewSweep: NodeJS.Timeout | undefined;
  const runtimeSessions = new Map<string, PersistentRuntime>();
  const organizationEnvelopeStates = new Map<string, { sessionId: string; hash: string }>();
  const userReactions = new UserReactionStore(opts.dataDir);
  const engineAuthStatuses = new EngineAuthStatusCache();
  const engineCapabilityCache = new Map<string, { expiresAt: number; value: Promise<ProjectEngineCapabilitiesDto> }>();
  const contextCursors = new ContextCursorStore(opts.dataDir);
  const managedWorkspacesRoot = path.resolve(opts.dataDir, "workspaces");
  const draftAttachmentsRoot = path.resolve(opts.dataDir, "draft-attachments");
  const draftAttachmentId = /^[a-f0-9-]{36}$/i;
  const draftAttachmentTypes = new Set<string>(ASSET_LIMITS.acceptedMediaTypes);
  const draftAttachmentDir = (draftId: string) => path.join(draftAttachmentsRoot, createHash("sha256").update(draftId).digest("hex"));
  const draftAttachmentFiles = (conversationId: string, id: string) => ({
    body: path.join(draftAttachmentDir(conversationId), `${id}.bin`),
    metadata: path.join(draftAttachmentDir(conversationId), `${id}.json`),
  });
  const readDraftAttachment = async (conversationId: string, id: string): Promise<DraftAttachmentDto | undefined> => {
    if (!draftAttachmentId.test(id)) return undefined;
    const files = draftAttachmentFiles(conversationId, id);
    try {
      const parsed = JSON.parse(await fs.readFile(files.metadata, "utf8")) as Omit<DraftAttachmentDto, "downloadUrl">;
      const stat = await fs.stat(files.body);
      if (!stat.isFile() || parsed.id !== id || parsed.conversationId !== conversationId || parsed.size !== stat.size) return undefined;
      return { ...parsed, downloadUrl: `/api/conversations/${encodeURIComponent(conversationId)}/draft-attachments/${encodeURIComponent(id)}` };
    } catch {
      return undefined;
    }
  };
  const hydrateDraft = async (conversationId: string) => {
    const draft = workspace.getDraft(conversationId);
    const attachments = (await Promise.all(draft.attachmentIds.map((id) => readDraftAttachment(conversationId, id))))
      .filter((item): item is DraftAttachmentDto => Boolean(item));
    return { ...draft, attachments };
  };
  const validDraftId = (draftId: string): boolean => {
    if (store.getConversation(draftId)) return true;
    const separator = draftId.indexOf(":");
    if (separator < 1) return false;
    const kind = draftId.slice(0, separator);
    const id = draftId.slice(separator + 1);
    if (!id || id.includes(":")) return false;
    if (kind === "collaboration") return Boolean(store.getConversation(id));
    if (kind === "agent") return Boolean(store.getAgent(id));
    return false;
  };
  const configuredBrowseRoots = (opts.allowedBrowseRoots ?? (process.env.PONDEROSA_BROWSE_ROOTS ?? "").split(path.delimiter))
    .map((root) => root.trim()).filter(Boolean).map((root) => path.resolve(root));

  async function browseRoots(): Promise<string[]> {
    await fs.mkdir(managedWorkspacesRoot, { recursive: true });
    const resolved: string[] = [await fs.realpath(managedWorkspacesRoot)];
    for (const root of configuredBrowseRoots) {
      try {
        const real = await fs.realpath(root);
        if ((await fs.stat(real)).isDirectory() && !resolved.includes(real)) resolved.push(real);
      } catch { /* invalid configured roots are not exposed */ }
    }
    return resolved;
  }

  function insideRoot(candidate: string, root: string): boolean {
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
  }

  async function validatedBrowsePath(input: string): Promise<{ candidate: string; root: string }> {
    const roots = await browseRoots();
    const candidate = await fs.realpath(path.resolve(input));
    const root = roots.find((allowed) => insideRoot(candidate, allowed));
    if (!root) throw new Error("path is outside configured browse roots");
    if (!(await fs.stat(candidate)).isDirectory()) throw new Error("path must be a directory");
    return { candidate, root };
  }
  const agentMessageCapabilities = new Map<string, AgentMessageCapability>();
  // An agent can request rollover while its capability is live. The reset is
  // applied only after the turn ends, so it never destroys an in-flight session.
  const scheduledSessionRollovers = new Map<string, string>();
  // Capability used only by this server's queue dispatcher. It prevents a client
  // from attaching arbitrary collaboration history to a direct agent request.
  // Prevent an internal dequeue from being appended to the tail if another
  // request claims the agent in the tiny dispatch race window.
  // Capability used by Project chat to invoke the same active-run send path as
  // Agent chat without allowing clients to forge canonical communication IDs.
  const v3DispatchKey = randomUUID();
  const subscribers = new Map<string, Set<Subscriber>>();
  const directReplyClaims = new Set<string>();
  const deletingAgentIds = new Set<string>();
  let closed = false;
  let assetSweep: NodeJS.Timeout | undefined;
  const recordCommunication = (event: CommunicationEvent): CommunicationEvent => {
    const stored = store.appendCommunicationEvent(event);
    if (!stored.replayed && stored.event.sender.kind === "agent") {
      const preference = workspace.getPreferences().notifications;
      const kind = notificationKindForCommunication(stored.event);
      // Team Chat is agent-only collaboration. Keep its structural kind for
      // policy tests/audit, but never materialize an operator notification.
      if (kind && stored.event.intent !== "collaboration" && notificationPreferenceMatches(preference, stored.event, kind)) {
        const cursor = workspace.cursor();
        const notification = workspace.createNotification({
          projectId: stored.event.projectId,
          ...(stored.event.conversationId ? { conversationId: stored.event.conversationId } : {}),
          communicationEventId: stored.event.eventId,
          kind,
          title: store.getAgent(stored.event.sender.agentId)?.title ?? "Agent response",
          body: stored.event.text.slice(0, 240),
        });
        publishWorkspaceSince(cursor);
        void deliverPush(notification);
      }
      if (stored.event.conversationId) appendWorkspace({ type: "conversation_changed", projectId: stored.event.projectId, conversationId: stored.event.conversationId, action: "message" });
    }
    return stored.event;
  };

  const generateConversationTitle = async (conversationId: string): Promise<{ title: string; generated: boolean }> => {
    const conversation = store.getConversation(conversationId);
    if (!conversation || !/^New Chat$/i.test(conversation.title)) return { title: conversation?.title ?? "New Chat", generated: false };
    const messages = store.getConversationMessages(conversationId, "main");
    const firstOperatorMessage = messages
      .find((message) => message.role === "user" && !message.authorAgentId);
    const firstAgentMessage = messages.find((message) => message.role === "assistant" && Boolean(message.authorAgentId));
    // A title is generated once the first exchange exists. This prevents a
    // premature title from being replaced by later turns and leaves manual
    // edits authoritative.
    const title = firstOperatorMessage && firstAgentMessage
      ? semanticConversationTitle(firstOperatorMessage.text, firstAgentMessage.text) ?? "Initial Conversation"
      : undefined;
    if (!title) return { title: conversation.title, generated: false };
    const latest = store.getConversation(conversationId);
    if (!latest || !/^New Chat$/i.test(latest.title)) return { title: latest?.title ?? conversation.title, generated: false };
    const updated = store.updateConversation(conversationId, { title });
    if (!updated) return { title: conversation.title, generated: false };
    appendWorkspace({ type: "conversation_changed", projectId: updated.projectId, conversationId, action: "updated" });
    return { title: updated.title, generated: true };
  };
  const executionLeaseMs = opts.executionLeaseScheduling?.leaseMs ?? 6 * 60 * 1000;
  const executionHeartbeatMs = opts.executionLeaseScheduling?.heartbeatMs ?? Math.max(1, Math.floor(executionLeaseMs / 3));
  const coordinationV3LeaseMs = opts.communicationV3?.leaseMs ?? executionLeaseMs;
  const executionLeaseNow = opts.executionLeaseScheduling?.now ?? Date.now;
  const setExecutionLeaseTimer = opts.executionLeaseScheduling?.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearExecutionLeaseTimer = opts.executionLeaseScheduling?.clearTimer ?? clearTimeout;
  const leaseExpiry = () => new Date(executionLeaseNow() + executionLeaseMs).toISOString();
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

  const ownsV3Run = (run: ActiveRun): boolean => {
    if (!run.v3SchedulerRunId || run.v3FencingToken === undefined) return false;
    try {
      return coordinationV3.ownsRun(run.v3SchedulerRunId, run.v3FencingToken, coordinationV3WorkerId);
    } catch {
      return false;
    }
  };

  const runAuthorization = (capability: AgentMessageCapability) => ({
    runId: capability.v3SchedulerRunId,
    agentId: capability.agentId,
    fencingToken: capability.v3FencingToken,
  });

  const capabilityOwnsAuthoritativeRun = (capability: AgentMessageCapability, run: ActiveRun | undefined): boolean => Boolean(
    run && run.runId === capability.runId && run.messageCapability &&
    run.v3SchedulerRunId === capability.v3SchedulerRunId &&
    run.v3FencingToken === capability.v3FencingToken &&
    coordinationV3.ownsRun(capability.v3SchedulerRunId, capability.v3FencingToken, coordinationV3WorkerId),
  );

  function ownsActiveRun(agentId: string, run: ActiveRun): boolean {
    return activeRuns.get(agentId) === run && ownsV3Run(run);
  }

  function linkPreviewOwned(registration: LinkPreviewRegistration): boolean {
    const project = store.getProject(registration.projectId);
    const agent = store.getAgent(registration.agentId);
    const active = agent ? activeRuns.get(agent.id) : undefined;
    if (!project || !agent || agent.archived || agent.projectId !== project.id || !active ||
      !ownsActiveRun(agent.id, active) || active.runId !== registration.runId || active.executionId !== registration.runId) return false;
    if (!registration.conversationId) return true;
    const conversation = store.getConversation(registration.conversationId);
    return Boolean(conversation && conversation.projectId === project.id && agent.conversationIds.includes(conversation.id));
  }

  function closeLinkPreviewPair(pair: LinkPreviewSocketPair, code = 1001, reason = "preview closed"): void {
    if (pair.closing) return;
    pair.closing = true;
    const sockets = [pair.client, pair.upstream];
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.CLOSED) continue;
      try { socket.close(code, reason.slice(0, 123)); } catch { socket.terminate(); }
    }
    const forceClose = setTimeout(() => {
      for (const socket of sockets) {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      }
    }, linkPreviewCloseGraceMs);
    forceClose.unref();
    for (const socket of sockets) {
      socket.once("close", () => {
        if (sockets.every((candidate) => candidate.readyState === WebSocket.CLOSED)) clearTimeout(forceClose);
      });
    }
  }

  function closeLinkPreviewRegistration(id: string, code = 1001, reason = "preview closed"): void {
    const registration = linkPreviews.get(id);
    if (!registration) return;
    linkPreviews.delete(id);
    for (const pair of registration.connections) closeLinkPreviewPair(pair, code, reason);
    registration.connections.clear();
    for (const controller of registration.httpConnections) controller.abort();
    registration.httpConnections.clear();
  }

  function closeLinkPreviewsForAgent(agentId: string, reason: string): void {
    for (const [id, registration] of linkPreviews) {
      if (registration.agentId === agentId) closeLinkPreviewRegistration(id, 1001, reason);
    }
  }

  function transitionRun(agentId: string, run: ActiveRun, state: RuntimeOwnershipState): boolean {
    if (!ownsV3Run(run)) return false;
    run.ownershipState = state;
    opts.runtimeEventFaults?.onOwnershipState?.({ agentId, runId: run.runId, generation: run.generation, state });
    return true;
  }

  function receiveRuntimeEvent(agentId: string, run: ActiveRun): boolean {
    if (!ownsActiveRun(agentId, run) || run.ownershipState === "cancelling") return false;
    const at = new Date().toISOString();
    run.lastEventReceivedAt = at;
    return true;
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
    closeLinkPreviewsForAgent(agentId, "run lease expired");
    clearRunLeaseTimer(run);
    clearRunLivenessTimer(run);
    agentMessageCapabilities.delete(run.messageCapability);
    scheduledSessionRollovers.delete(agentId);
    try {
      coordinationV3.failRun({
        runId: run.v3SchedulerRunId!,
        fencingToken: run.v3FencingToken!,
        workerId: coordinationV3WorkerId,
        sameRunResumable: Boolean(run.runtimeSession?.isAlive()),
      });
    } catch { /* the advanced fence already rejects late runtime output */ }
    const lifecycle = store.appendEvent(agentId, {
      type: "agent_lifecycle", status: "failed", reason: "execution_lease_expired", executionId: run.executionId,
    });
    publish(agentId, lifecycle);
    notifyManagerOfChildFailure(agentId, run.executionId, "execution lease expired");
    const persistentRuntime = runtimeSessions.get(agentId);
    if (persistentRuntime) {
      removePersistentRuntime(agentId, persistentRuntime);
      void persistentRuntime.session.close().catch(() => undefined);
    }
    run.controller.abort();
    coordinationV3Scheduler?.notify();
  }

  function renewExecutionLease(agentId: string, run: ActiveRun): boolean {
    if (!ownsActiveRun(agentId, run)) return false;
    clearRunLeaseTimer(run);
    run.leaseExpiresAt = leaseExpiry();
    run.leaseTimer = setExecutionLeaseTimer(() => expireExecutionLease(agentId, run), executionLeaseMs);
    run.leaseTimer.unref?.();
    if (run.v3SchedulerRunId && run.v3FencingToken !== undefined) {
      coordinationV3.renewLease(
        run.v3SchedulerRunId,
        run.v3FencingToken,
        coordinationV3WorkerId,
        coordinationV3LeaseMs,
      );
    }
    return true;
  }

  function claimActiveRun(agentId: string, run: ActiveRun): void {
    activeRuns.set(agentId, run);
    renewExecutionLease(agentId, run);
  }

  function releaseActiveRun(agentId: string, run: ActiveRun, state: "completed" | "failed" | "cancelled"): boolean {
    if (!ownsActiveRun(agentId, run)) return false;
    activeRuns.delete(agentId);
    closeLinkPreviewsForAgent(agentId, `run ${state}`);
    clearRunLeaseTimer(run);
    clearRunLivenessTimer(run);
    return true;
  }

  const rawDataBytes = (data: RawData): number => Array.isArray(data)
    ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
    : data.byteLength;

  const rejectLinkPreviewUpgrade = (socket: Socket, status: 400 | 401 | 403 | 404 | 409 | 429, message: string): void => {
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const label = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not Found"
      : status === 409 ? "Conflict" : status === 429 ? "Too Many Requests" : "Bad Request";
    socket.end(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`, () => socket.destroy());
  };

  const linkPreviewUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    const rawTarget = request.url ?? "";
    if (!rawTarget.startsWith("/")) {
      rejectLinkPreviewUpgrade(socket, 400, "absolute-form preview upgrades are forbidden");
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(rawTarget, "http://ponderosa.invalid");
      decodeURI(parsed.pathname);
      decodeURI(parsed.search);
    } catch {
      rejectLinkPreviewUpgrade(socket, 400, "malformed preview upgrade");
      return;
    }
    if (parsed.username || parsed.password || parsed.hash) {
      rejectLinkPreviewUpgrade(socket, 400, "credentialed preview upgrades are forbidden");
      return;
    }
    const match = /^\/api\/link-previews\/([a-f0-9-]{36})\/__ws(\/.*)?$/i.exec(parsed.pathname);
    if (!match) {
      if (parsed.pathname.startsWith("/api/link-previews/")) {
        rejectLinkPreviewUpgrade(socket, 404, "preview capability was not found");
      }
      return;
    }
    const id = match[1]!;
    const relativePath = match[2] || "/";
    const websocketKey = typeof request.headers["sec-websocket-key"] === "string"
      ? request.headers["sec-websocket-key"].trim()
      : "";
    const decodedKey = Buffer.from(websocketKey, "base64");
    if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket" ||
      !request.headers.connection?.toLowerCase().split(",").map((item) => item.trim()).includes("upgrade") ||
      request.headers["sec-websocket-version"] !== "13" || decodedKey.byteLength !== 16 ||
      decodedKey.toString("base64") !== websocketKey || request.headers["content-length"] !== undefined ||
      request.headers["transfer-encoding"] !== undefined) {
      rejectLinkPreviewUpgrade(socket, 400, "malformed preview upgrade");
      return;
    }
    if (request.headers.origin !== "null") {
      rejectLinkPreviewUpgrade(socket, 403, "preview upgrades require the sandboxed preview origin");
      return;
    }
    const protocolHeader = request.headers["sec-websocket-protocol"];
    if (typeof protocolHeader !== "string") {
      rejectLinkPreviewUpgrade(socket, 400, "a Vite preview subprotocol is required");
      return;
    }
    const protocols = protocolHeader.split(",").map((item) => item.trim()).filter(Boolean);
    if (protocols.length !== 1 || (protocols[0] !== "vite-hmr" && protocols[0] !== "vite-ping")) {
      rejectLinkPreviewUpgrade(socket, 400, "unsupported preview WebSocket subprotocol");
      return;
    }
    const queryEntries = [...parsed.searchParams.entries()];
    if (queryEntries.length > 1 || (queryEntries.length === 1 &&
      (queryEntries[0]![0] !== "token" || !/^[A-Za-z0-9._~-]{1,256}$/.test(queryEntries[0]![1])))) {
      rejectLinkPreviewUpgrade(socket, 400, "unsupported preview WebSocket query");
      return;
    }
    if (Buffer.byteLength(relativePath + parsed.search) > linkPreviewMaxPathBytes || relativePath.includes("\\") || /[\r\n\0]/.test(relativePath + parsed.search)) {
      rejectLinkPreviewUpgrade(socket, 400, "preview WebSocket path is invalid or too large");
      return;
    }
    const registration = linkPreviews.get(id);
    if (!registration) {
      rejectLinkPreviewUpgrade(socket, 404, "preview capability was not found");
      return;
    }
    if (registration.expiresAt <= Date.now() || !linkPreviewOwned(registration)) {
      closeLinkPreviewRegistration(id, 1008, "preview capability expired");
      rejectLinkPreviewUpgrade(socket, 404, "preview capability expired");
      return;
    }
    const totalConnections = [...linkPreviews.values()].reduce((total, candidate) => total + candidate.connections.size, 0);
    if (registration.connections.size >= linkPreviewMaxPerRegistration || totalConnections >= linkPreviewMaxTotal) {
      rejectLinkPreviewUpgrade(socket, 429, "preview connection limit reached");
      return;
    }
    const now = Date.now();
    registration.reconnectAttempts = registration.reconnectAttempts.filter((attempt) => now - attempt < linkPreviewReconnectWindowMs);
    if (registration.reconnectAttempts.length >= linkPreviewMaxReconnectsPerWindow) {
      rejectLinkPreviewUpgrade(socket, 429, "preview reconnect limit reached");
      return;
    }
    registration.reconnectAttempts.push(now);
    const target = new URL(`${relativePath}${parsed.search}`, registration.origin);
    if (target.origin !== registration.origin || target.username || target.password) {
      rejectLinkPreviewUpgrade(socket, 403, "preview target is outside its registered origin");
      return;
    }
    target.protocol = "ws:";

    try {
      linkPreviewWss.handleUpgrade(request, socket, head, (client) => {
        const upstream = new WebSocket(target, protocols, {
          followRedirects: false,
          handshakeTimeout: linkPreviewHandshakeTimeoutMs,
          maxPayload: linkPreviewMaxPayload,
          perMessageDeflate: false,
          headers: {
            origin: registration.origin,
            "user-agent": "Ponderosa localhost preview",
          },
        });
        const pair: LinkPreviewSocketPair = {
          client,
          upstream,
          openedAt: Date.now(),
          lastActivityAt: Date.now(),
          clientAlive: true,
          upstreamAlive: true,
        };
        registration.connections.add(pair);
        const pendingClientFrames: Array<{ data: Buffer; isBinary: boolean }> = [];
        let pendingClientBytes = 0;
        const closeBoth = (code = 1001, reason = "preview connection closed") => {
          registration.connections.delete(pair);
          closeLinkPreviewPair(pair, code, reason);
        };
        const forward = (to: WebSocket, data: RawData, isBinary: boolean) => {
          if (!linkPreviewOwned(registration) || registration.expiresAt <= Date.now()) return closeBoth(1008, "preview ownership expired");
          const size = rawDataBytes(data);
          if (size > linkPreviewMaxPayload) return closeBoth(1009, "preview message too large");
          pair.lastActivityAt = Date.now();
          if (to === upstream && to.readyState === WebSocket.CONNECTING) {
            if (pendingClientFrames.length >= linkPreviewMaxPendingFrames || pendingClientBytes + size > linkPreviewMaxBuffered) {
              return closeBoth(1013, "preview handshake buffer limit reached");
            }
            const copy = Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(new Uint8Array(data));
            pendingClientFrames.push({ data: copy, isBinary });
            pendingClientBytes += copy.byteLength;
            return;
          }
          if (to.readyState !== WebSocket.OPEN || to.bufferedAmount + size > linkPreviewMaxBuffered) {
            return closeBoth(1013, "preview backpressure limit reached");
          }
          to.send(data, { binary: isBinary }, (error) => { if (error) closeBoth(1011, "preview forwarding failed"); });
        };
        client.on("message", (data, isBinary) => forward(upstream, data, isBinary));
        upstream.on("message", (data, isBinary) => forward(client, data, isBinary));
        upstream.on("open", () => {
          for (const frame of pendingClientFrames.splice(0)) {
            pendingClientBytes -= frame.data.byteLength;
            if (upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount + frame.data.byteLength > linkPreviewMaxBuffered) {
              closeBoth(1013, "preview backpressure limit reached");
              return;
            }
            upstream.send(frame.data, { binary: frame.isBinary }, (error) => { if (error) closeBoth(1011, "preview forwarding failed"); });
          }
        });
        client.on("pong", () => { pair.clientAlive = true; pair.lastActivityAt = Date.now(); });
        upstream.on("pong", () => { pair.upstreamAlive = true; pair.lastActivityAt = Date.now(); });
        client.on("close", (code) => closeBoth(code || 1001, "preview client closed"));
        upstream.on("close", (code) => closeBoth(code || 1001, "localhost preview server closed"));
        client.on("error", () => closeBoth(1011, "preview client failed"));
        upstream.on("error", () => closeBoth(1011, "localhost preview server unavailable"));
      });
    } catch {
      rejectLinkPreviewUpgrade(socket, 400, "malformed preview upgrade");
    }
  };
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
    return {
      ...detail,
      messages: withUserReactions(store.getProjectedAgentMessages(agentId)),
      coordinationV3: coordinationV3.agentSnapshot(agentId),
    };
  }

  function publishCoordinationV3Changed(agentId: string): void {
    if (closed || !store.getAgent(agentId)) return;
    const stored = store.appendEvent(agentId, {
      type: "coordination_v3_changed",
      coordination: coordinationV3.agentSnapshot(agentId),
    });
    publish(agentId, stored);
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
    return projectAgentHealth({
      scope,
      agents,
      activeRuns: ownership,
      compactingAgents: scheduledSessionRollovers,
      availability: (agentId) => coordinationV3.getAgentAvailability(agentId),
      events: (agentId) => store.readEvents(agentId),
    });
  }

  function teamDirectory(projectId: string, conversationId?: string, fallbackAgentId?: string): TeamDirectoryDto {
    const agents = store.listAgents(projectId).filter((agent) =>
      !agent.archived && (conversationId
        ? agent.conversationIds.includes(conversationId)
        : fallbackAgentId ? agent.id === fallbackAgentId : true));
    const health = agentHealth({ type: "project", id: projectId }, agents);
    const healthById = new Map(health.agents.map((agent) => [agent.agentId, agent]));
    return {
      projectId, generatedAt: health.generatedAt,
      agents: agents.map((agent) => {
        const profile = agentRoleProfile(agent);
        return {
          agentId: agent.id, displayName: agent.title,
          role: profile.role,
          description: profile.description,
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
  app.server.on("upgrade", linkPreviewUpgrade);
  const coordinationV3Scheduler = new CoordinationV3Scheduler(
    coordinationV3,
    async (lease, prompt) => {
      const activationPayloads = lease.activations
        .map((activation) => activation.payload)
        .filter((payload): payload is Record<string, unknown> => Boolean(payload) && typeof payload === "object");
      const communication = activationPayloads
        .map((payload) => payload.communication)
        .find((value): value is CommunicationEvent => value !== null && typeof value === "object" && "eventId" in value);
      const dispatch = activationPayloads
        .map((payload) => payload.dispatch)
        .find((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object");
      const recipientDispatch = Array.isArray(dispatch?.recipients)
        ? dispatch.recipients.find((value): value is Record<string, unknown> =>
            Boolean(value) && typeof value === "object" && value.agentId === lease.agentId)
        : undefined;
      const dispatchAttachments = Array.isArray(recipientDispatch?.attachments)
        ? recipientDispatch.attachments
        : Array.isArray(dispatch?.attachments) ? dispatch.attachments : [];
      const attachmentIds = dispatchAttachments
        .map((value) => value && typeof value === "object" && "id" in value ? value.id : undefined)
        .filter((value): value is string => typeof value === "string");
      const dispatchText = typeof dispatch?.text === "string" ? dispatch.text : prompt;
      const leaseConversationId = lease.scopeKey.startsWith("conversation:")
        ? lease.scopeKey.slice("conversation:".length)
        : undefined;
      const sourceConversationId = typeof dispatch?.sourceConversationId === "string"
        ? dispatch.sourceConversationId
        : typeof dispatch?.conversationId === "string" ? dispatch.conversationId : leaseConversationId;
      const sourceChannel = dispatch?.sourceChannel === "main" ? "main" : undefined;
      const response = await app.inject({
        method: "POST",
        url: `/api/agents/${encodeURIComponent(lease.agentId)}/messages`,
        headers: {
          ...(opts.authToken ? { authorization: `Bearer ${opts.authToken}` } : {}),
          "x-ponderosa-v3-dispatch": v3DispatchKey,
        },
        payload: {
          text: dispatchText,
          ...(typeof dispatch?.model === "string" ? { model: dispatch.model } : {}),
          ...(typeof dispatch?.effort === "string" ? { effort: dispatch.effort } : {}),
          ...(sourceConversationId ? { sourceConversationId } : {}),
          ...(sourceChannel ? { sourceChannel } : {}),
          ...(dispatch?.shareWithOrganization === true ? { shareWithOrganization: true } : {}),
          ...(typeof dispatch?.replyToMessageId === "string" ? { replyToMessageId: dispatch.replyToMessageId } : {}),
          ...(attachmentIds.length ? { attachmentIds } : {}),
          v3SchedulerRunId: lease.runId,
          v3FencingToken: lease.fencingToken,
          v3InjectionId: lease.injectionId,
          v3FreshProviderSession: coordinationV3.runStartsNewRecipientRequest(lease.runId, lease.agentId) ||
            coordinationV3.runChangesScope(lease.runId, lease.agentId),
          v3ActivationPrompt: prompt,
          ...(communication?.eventId ? { v3CommunicationEventId: communication.eventId } : {}),
        },
      });
      return {
        accepted: response.statusCode >= 200 && response.statusCode < 300,
        retryable: response.statusCode === 409 || response.statusCode === 429 || response.statusCode >= 500,
        ...(response.statusCode >= 200 && response.statusCode < 300 ? {} : { error: response.body }),
      };
    },
    {
      workerId: coordinationV3WorkerId,
      maxConcurrentRuns: opts.communicationV3?.maxConcurrentRuns,
      pollMs: opts.communicationV3?.pollMs,
      leaseMs: coordinationV3LeaseMs,
      dispatchSteering: async (lease, prompt) => {
        const run = activeRuns.get(lease.agentId);
        if (!run || run.v3SchedulerRunId !== lease.runId || run.v3FencingToken !== lease.fencingToken || !run.runtimeSession) {
          return { accepted: false, retryable: true, error: "authoritative run is not currently steerable" };
        }
        coordinationV3.markPromptSubmitted({
          injectionId: lease.injectionId,
          runId: lease.runId,
          fencingToken: lease.fencingToken,
          providerSessionId: run.runtimeSession.engineAgentId,
        });
        try {
          const result = await run.runtimeSession.steer({
            prompt,
            kind: "user_message",
            clientMessageId: lease.injectionId,
          });
          if (result.status !== "accepted") {
            return { accepted: false, retryable: true, error: result.reason ?? result.status };
          }
          coordinationV3.acknowledgePromptInjection({
            injectionId: lease.injectionId,
            runId: lease.runId,
            fencingToken: lease.fencingToken,
            providerTurnId: result.turnId,
            providerSessionId: run.runtimeSession.engineAgentId,
          });
          renewExecutionLease(lease.agentId, run);
          publishCoordinationV3Changed(lease.agentId);
          return { accepted: true };
        } catch (error) {
          return {
            accepted: false,
            outcomeUnknown: true,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      dispatchProviderOperation: async (operation) => {
        const entry = [...activeRuns.entries()].find(([, run]) => run.runId === operation.runId);
        if (!entry) return { accepted: true };
        const [agentId, run] = entry;
        activeRuns.delete(agentId);
        closeLinkPreviewsForAgent(agentId, "run cancelled");
        clearRunLeaseTimer(run);
        clearRunLivenessTimer(run);
        agentMessageCapabilities.delete(run.messageCapability);
        scheduledSessionRollovers.delete(agentId);
        run.controller.abort();
        const runtime = runtimeSessions.get(agentId);
        if (runtime) {
          removePersistentRuntime(agentId, runtime);
          await runtime.session.interrupt().catch(() => undefined);
          await runtime.session.close().catch(() => undefined);
        }
        return { accepted: true };
      },
    },
  );
  for (const mediaType of ["image/png", "image/jpeg", "image/webp", "application/pdf", "application/zip", "application/octet-stream"]) {
    app.addContentTypeParser(mediaType, { parseAs: "buffer", bodyLimit: ASSET_LIMITS.maxRequestBytes }, (_request, body, done) => done(null, body));
  }

  async function reconcileRuntimeCommunicationProjections(): Promise<number> {
    let projected = 0;
    for (const row of coordinationV3.runtimeCommunications()) {
      const payload = row.payload && typeof row.payload === "object"
        ? row.payload as Record<string, unknown>
        : undefined;
      const candidate = payload?.communication ?? row.payload;
      if (!candidate || typeof candidate !== "object") continue;
      let event = candidate as Partial<CommunicationEvent>;
      if (
        typeof event.eventId !== "string" ||
        typeof event.projectId !== "string" ||
        typeof event.text !== "string" ||
        typeof event.createdAt !== "string" ||
        event.projectId !== row.projectId
      ) continue;
      const communicationEventId = event.eventId;
      let recoveredAttachmentIds: string[] = [];
      let recoveredAttachmentAgentId: string | undefined;
      if (!event.text.trim() && !event.attachments?.length) {
        const audience = row.audience && typeof row.audience === "object"
          ? row.audience as Record<string, unknown>
          : undefined;
        const dispatch = payload?.dispatch && typeof payload.dispatch === "object"
          ? payload.dispatch as Record<string, unknown>
          : undefined;
        const rawAttachments = Array.isArray(dispatch?.attachments) ? dispatch.attachments : [];
        recoveredAttachmentAgentId = typeof audience?.agentId === "string" ? audience.agentId : undefined;
        if (recoveredAttachmentAgentId && rawAttachments.length) {
          const recovered: ImageAttachmentDto[] = [];
          for (const raw of rawAttachments) {
            if (!raw || typeof raw !== "object") continue;
            const expected = raw as Record<string, unknown>;
            if (typeof expected.id !== "string") continue;
            const metadata = await assetMetadata(recoveredAttachmentAgentId, expected.id);
            if (!metadata || metadata.name !== expected.name || metadata.mediaType !== expected.mediaType || metadata.size !== expected.size) continue;
            const {
              projectId: _projectId, originalFile: _originalFile, previewFile: _previewFile,
              associatedAt: _associatedAt, ...publicAsset
            } = metadata;
            recovered.push({ ...publicAsset, state: "associated" });
          }
          if (recovered.length === rawAttachments.length) {
            recoveredAttachmentIds = recovered.map((attachment) => attachment.id);
            event = { ...event, attachments: recovered };
          }
        }
      }
      if (!store.getCommunicationEvent(row.projectId, communicationEventId)) {
        try {
          recordCommunication(event as CommunicationEvent);
          if (recoveredAttachmentAgentId && recoveredAttachmentIds.length) {
            await assets.associate(row.projectId, recoveredAttachmentAgentId, recoveredAttachmentIds);
          }
          projected += 1;
        } catch (error) {
          app.log.error({
            err: error,
            runtimeCommunicationId: row.id,
            communicationEventId,
          }, "runtime communication projection recovery failed");
        }
      }
    }
    return projected;
  }

  app.addHook("onRequest", async (request, reply) => {
    const provided = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if ((request.url === "/api/agent-messages" || request.url === "/api/agent-coordinate" || request.url === "/api/agent-request-updates" || request.url.startsWith("/api/agent-documents/") || request.url === "/api/agent-directory" || request.url.startsWith("/api/agent-directory/") || request.url === "/api/agent-session/rollover") && provided && agentMessageCapabilities.has(provided)) return;
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

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://cdn.jsdelivr.net; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    if (request.url.startsWith("/api/link-previews/")) {
      // Local dev apps are untrusted content. A unique sandbox origin prevents
      // their scripts from inheriting the operator's authenticated API origin.
      reply.header("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-modals allow-downloads; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'");
    }
    return payload;
  });

  app.addHook("onReady", async () => {
    await reconcileRuntimeCommunicationProjections();
    coordinationV3.recoverOrphanedRuns(coordinationV3WorkerId);
    coordinationV3.expireDue();
    coordinationV3Scheduler.start();
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
    linkPreviewSweep = setInterval(() => {
      const now = Date.now();
      for (const [id, registration] of linkPreviews) {
        if (registration.expiresAt <= now || !linkPreviewOwned(registration)) {
          closeLinkPreviewRegistration(id, 1008, "preview ownership expired");
          continue;
        }
        for (const pair of registration.connections) {
          if (now - pair.openedAt >= linkPreviewMaxConnectionLifetimeMs || now - pair.lastActivityAt >= linkPreviewMaxIdleMs) {
            registration.connections.delete(pair);
            closeLinkPreviewPair(pair, 1001, "preview connection expired");
            continue;
          }
          const clientDead = pair.client.readyState === WebSocket.OPEN && !pair.clientAlive;
          const upstreamDead = pair.upstream.readyState === WebSocket.OPEN && !pair.upstreamAlive;
          if (clientDead || upstreamDead) {
            registration.connections.delete(pair);
            pair.client.terminate();
            pair.upstream.terminate();
            continue;
          }
          if (pair.client.readyState === WebSocket.OPEN) {
            pair.clientAlive = false;
            pair.client.ping();
          }
          if (pair.upstream.readyState === WebSocket.OPEN) {
            pair.upstreamAlive = false;
            pair.upstream.ping();
          }
        }
      }
    }, linkPreviewHeartbeatMs);
    linkPreviewSweep.unref();
  });

  app.addHook("preClose", async () => {
    app.server.off("upgrade", linkPreviewUpgrade);
    if (linkPreviewSweep) clearInterval(linkPreviewSweep);
    const shutdownPairs = [...linkPreviews.values()].flatMap((registration) => [...registration.connections]);
    for (const id of [...linkPreviews.keys()]) closeLinkPreviewRegistration(id, 1001, "Ponderosa server shutting down");
    if (shutdownPairs.length > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, linkPreviewCloseGraceMs));
      for (const pair of shutdownPairs) {
        if (pair.client.readyState !== WebSocket.CLOSED) pair.client.terminate();
        if (pair.upstream.readyState !== WebSocket.CLOSED) pair.upstream.terminate();
      }
    }
    linkPreviewWss.close();
    app.server.closeAllConnections();
  });

  app.addHook("onClose", async () => {
    closed = true;
    await coordinationV3Scheduler.stop();
    if (assetSweep) clearInterval(assetSweep);
    for (const [agentId, run] of activeRuns) {
      clearRunLeaseTimer(run);
      clearRunLivenessTimer(run);
      if (run.v3SchedulerRunId && run.v3FencingToken !== undefined) {
        try {
          coordinationV3.failRun({
            runId: run.v3SchedulerRunId,
            fencingToken: run.v3FencingToken,
            workerId: coordinationV3WorkerId,
            sameRunResumable: false,
          });
        } catch { /* an already advanced fence is terminal */ }
      }
      run.controller.abort();
    }
    activeRuns.clear();
    for (const runtime of runtimeSessions.values()) cancelRuntimeIdleClose(runtime);
    await Promise.allSettled([...runtimeSessions.values()].map(({ session }) => session.close()));
    runtimeSessions.clear();
    assets.close();
    store.close();
  });

  function publish(agentId: string, stored: StoredLogEvent): void {
    for (const subscriber of subscribers.get(agentId) ?? []) subscriber(stored);
    const agent = store.getAgent(agentId);
    if (!agent) return;
    const event = stored.event;
    const category = workspaceAgentEventCategory(event);
    if (event.type === "turn_done") {
      appendWorkspace({
        type: "usage_changed",
        projectId: agent.projectId,
        agentId,
        conversationIds: agent.conversationIds,
        seq: stored.seq,
        ...(("executionId" in event && typeof event.executionId === "string") ? { executionId: event.executionId } : {}),
      });
      return;
    }
    if (!category) return;
    appendWorkspace({
      type: "agent_event",
      projectId: agent.projectId,
      agentId,
      conversationIds: agent.conversationIds,
      seq: stored.seq,
      eventType: event.type,
      category,
      ...("executionId" in event && typeof event.executionId === "string" ? { executionId: event.executionId } : {}),
    });
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

  /** Materialize a canonical collaboration in an agent's audit surface without
   * copying it into runtime history. V3 activations carry the actionable prompt;
   * this projection keeps reconciliation and the UI complete without charging
   * the provider for the same handoff twice. */
  function projectCommunicationToAgentAudit(
    agentId: string,
    event: CommunicationEvent,
    renderedText: string,
    attachments?: ImageAttachmentDto[],
  ): void {
    if (store.readCommunicationProjections(event.projectId).some((projection) =>
      projection.eventId === event.eventId && projection.surface === "direct_agent_audit" &&
      projection.projectionKey === agentId && projection.message)) return;
    store.appendCommunicationProjection(event.projectId, {
      eventId: event.eventId,
      surface: "direct_agent_audit",
      projectionKey: agentId,
      projectedAt: event.createdAt,
      message: {
        messageId: `${event.eventId}:agent-audit:${agentId}`,
        role: event.sender.kind === "user" ? "user" : event.sender.kind === "system" ? "system" : "assistant",
        renderedText,
        createdAt: event.createdAt,
        ...(event.sender.kind === "agent" ? { authorAgentId: event.sender.agentId } : {}),
        ...(attachments?.length ? { attachments } : {}),
      },
    });
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
    const id = `managed-agent:${child.id}:${executionId}:failure`;
    const text = [
        "Internal managed-agent update (not a chat message).",
        `${child.title} (${child.id}) encountered a runtime failure during execution ${executionId}.`,
        `Failure: ${failure}`,
        "The agent remains in your organization and can be steered or retried.",
      ].join("\n");
    coordinationV3.recordRuntimeCommunication({
      id,
      projectId: child.projectId,
      sender: { kind: "system", component: "runtime-supervisor", childAgentId: child.id },
      intent: "managed_child_failure",
      audience: { agentId: manager.id },
      payload: { text, childAgentId: child.id, executionId, failure },
      activation: {
        agentId: manager.id,
        kind: "managed_child_failure",
        priority: 90,
        dispatchPolicy: "steer_or_run",
        promptClass: "blocker",
      },
      now: createdAt,
    });
    publishCoordinationV3Changed(manager.id);
    coordinationV3Scheduler.notify();
  }

  app.get("/api/agent-directory", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    const author = capability ? store.getAgent(capability.agentId) : undefined;
    if (!capability || !capabilityOwnsAuthoritativeRun(capability, active) || active!.messageCapability !== token || !author) {
      return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    }
    return teamDirectory(author.projectId, capability.conversationId, author.id);
  });

  app.get<{ Params: { agentId: string } }>("/api/agent-directory/:agentId", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    const author = capability ? store.getAgent(capability.agentId) : undefined;
    if (!capability || !capabilityOwnsAuthoritativeRun(capability, active) || active!.messageCapability !== token || !author) {
      return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    }
    const entry = teamDirectory(author.projectId, capability.conversationId, author.id).agents.find((agent) => agent.agentId === request.params.agentId);
    return entry ?? reply.code(404).send({ error: "agent not found in this Team Chat" });
  });

  app.post<{
    Body: {
      idempotencyKey?: string;
      requests?: Array<{ requestId?: string; recipientAgentId?: string; text?: string; lifetime?: RequestLifetime }>;
      join?: { id?: string; mode?: "all" | "any" | "quorum"; quorum?: number; deadlineAt?: string; satisfyingOutcomes?: CoordinationRequestState[]; requestIds?: string[] };
      inspectActivationIds?: string[];
    };
  }>("/api/agent-coordinate", async (request, reply) => {
    if (!coordinationV3) return reply.code(404).send({ error: "Communication V3 is not enabled" });
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    const author = capability ? store.getAgent(capability.agentId) : undefined;
    if (!capability || !capabilityOwnsAuthoritativeRun(capability, active) || active!.messageCapability !== token || !author) {
      return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    }
    const inspectActivationIds = request.body?.inspectActivationIds;
    if (inspectActivationIds !== undefined) {
      if (!Array.isArray(inspectActivationIds) || inspectActivationIds.length === 0 || inspectActivationIds.length > 20 ||
          new Set(inspectActivationIds).size !== inspectActivationIds.length || inspectActivationIds.some((id) => !id?.trim())) {
        return reply.code(400).send({ error: "inspectActivationIds must contain 1 to 20 unique IDs" });
      }
      const payloads = coordinationV3.activationPayloads(author.id, inspectActivationIds, capability.runId);
      if (payloads.length !== inspectActivationIds.length) {
        return reply.code(404).send({ error: "one or more activation references are not attached to this run" });
      }
      return { activations: payloads };
    }
    const idempotencyKey = request.body?.idempotencyKey?.trim();
    const requests = request.body?.requests ?? [];
    const existingJoinRequestIds = request.body?.join?.requestIds ?? [];
    if (!idempotencyKey || idempotencyKey.length > 200 || requests.length > 100 ||
        (requests.length === 0 && existingJoinRequestIds.length === 0)) {
      return reply.code(400).send({ error: "idempotencyKey and at least one new request or existing join request ID are required" });
    }
    if (!capability.conversationId || !author.conversationIds.includes(capability.conversationId)) {
      return reply.code(409).send({ error: "coordination requires an active Team Chat scope" });
    }
    const normalized: Array<{ requestId?: string; recipientAgentId: string; text: string; lifetime: RequestLifetime }> = [];
    for (const candidate of requests) {
      const recipientAgentId = candidate.recipientAgentId?.trim();
      const text = candidate.text?.trim();
      if (!recipientAgentId || recipientAgentId === author.id || !text || text.length > 4000 || !candidate.lifetime) {
        return reply.code(400).send({ error: "each request needs another recipient, text, and explicit lifetime" });
      }
      const recipient = store.getAgent(recipientAgentId);
      if (!recipient || recipient.archived || recipient.projectId !== author.projectId ||
          !recipient.conversationIds.includes(capability.conversationId)) {
        return reply.code(400).send({ error: "every recipient must be a different active agent in this Team Chat" });
      }
      normalized.push({
        ...(candidate.requestId?.trim() ? { requestId: candidate.requestId.trim() } : {}),
        recipientAgentId,
        text,
        lifetime: candidate.lifetime,
      });
    }
    if (request.body.join && !(request.body.join.mode === "all" || request.body.join.mode === "any" || request.body.join.mode === "quorum")) {
      return reply.code(400).send({ error: "join mode must be all, any, or quorum" });
    }
    if (existingJoinRequestIds.length > 100 || new Set(existingJoinRequestIds).size !== existingJoinRequestIds.length ||
        existingJoinRequestIds.some((requestId) => !requestId?.trim())) {
      return reply.code(400).send({ error: "join requestIds must contain 1 to 100 unique request IDs" });
    }
    let result;
    try {
      const continuationRequestIds = request.body.join
        ? coordinationV3.requestIdsAttachedToRun(capability.runId, author.id).filter((requestId) => {
            const attached = coordinationV3.getRequest(requestId);
            return attached?.recipientAgentId === author.id && !TERMINAL_REQUEST_STATES.has(attached.state);
          })
        : [];
      result = coordinationV3.coordinate({
        projectId: author.projectId,
        conversationId: capability.conversationId,
        requesterAgentId: author.id,
        actorScope: `agent:${author.id}:run:${capability.runId}`,
        idempotencyKey,
        runAuthorization: runAuthorization(capability),
        requests: normalized.map((candidate) => ({
          ...(candidate.requestId ? { requestId: candidate.requestId } : {}),
          recipientAgentId: candidate.recipientAgentId,
          lifetime: candidate.lifetime,
          payload: { text: candidate.text, requesterRunId: capability.runId },
        })),
        ...(request.body.join ? { join: {
          ...(request.body.join.id?.trim() ? { id: request.body.join.id.trim() } : {}),
          mode: request.body.join.mode!,
          ...(request.body.join.quorum !== undefined ? { quorum: request.body.join.quorum } : {}),
          ...(request.body.join.deadlineAt?.trim() ? { deadlineAt: request.body.join.deadlineAt.trim() } : {}),
          ...(request.body.join.satisfyingOutcomes ? { satisfyingOutcomes: request.body.join.satisfyingOutcomes } : {}),
          ...(existingJoinRequestIds.length ? { requestIds: existingJoinRequestIds.map((requestId) => requestId.trim()) } : {}),
          ...(continuationRequestIds.length ? { continuationRequestIds } : {}),
        } } : {}),
      });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "coordination failed" });
    }

    if (capability.conversationId) {
      for (let index = 0; index < normalized.length; index += 1) {
        const item = normalized[index]!;
        const requestId = result.requestIds[index]!;
        const eventId = `v3-request-${createHash("sha256").update(`${author.projectId}\0${requestId}`).digest("hex")}`;
        try {
          const routing = resolveExplicitCollaborationIntents(
            capability.conversationId, author.id, [item.recipientAgentId], item.text,
            capability.mentionDepth, capability.mentionTrail,
          );
          if (routing.error) throw new Error(routing.error);
          const communication = recordCommunication({
            eventId, schemaVersion: 2, projectId: author.projectId,
            conversationId: capability.conversationId,
            sender: { kind: "agent", agentId: author.id, executionId: capability.runId },
            intent: "collaboration", audience: { kind: "agents", agentIds: [item.recipientAgentId] },
            text: item.text, createdAt: new Date().toISOString(),
            idempotencyKey: `v3-request:${requestId}`,
          });
          const existing = store.getConversationMessages(capability.conversationId, "collaboration")
            .find((message) => message.communicationEventId === communication.eventId);
          if (!existing) store.appendConversationMessage(
            capability.conversationId, { role: "assistant", text: routing.text }, author.id,
            "collaboration", undefined, undefined, communication.eventId,
          );
          projectCommunicationToAgentAudit(author.id, communication, routing.text);
          projectCommunicationToAgentAudit(item.recipientAgentId, communication, routing.text);
          coordinationV3.attachRequestCommunication(requestId, communication.eventId, author.projectId);
        } catch (error) {
          app.log.warn({ err: error, requestId }, "V3 request audit projection will be repaired on idempotent retry");
        }
      }
    }
    publishCoordinationV3Changed(author.id);
    for (const item of normalized) publishCoordinationV3Changed(item.recipientAgentId);
    coordinationV3Scheduler?.notify();
    return {
      ...result,
      ...(result.joinId ? { executionDirective: "End this turn now unless independent work explicitly remains; Ponderosa will reactivate you when the durable join needs action." } : {}),
    };
  });

  app.post<{
    Body: { requestId?: string; updateId?: string; kind?: CoordinationRequestUpdateKind; text?: string; inReplyToUpdateId?: string };
  }>("/api/agent-request-updates", async (request, reply) => {
    if (!coordinationV3) return reply.code(404).send({ error: "Communication V3 is not enabled" });
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    if (!capability || !capabilityOwnsAuthoritativeRun(capability, active) || active!.messageCapability !== token) {
      return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    }
    const suppliedRequestId = request.body?.requestId?.trim();
    const attachedRequestIds = coordinationV3.requestIdsAttachedToRun(
      capability.v3SchedulerRunId,
      capability.agentId,
    );
    const requestId = suppliedRequestId ?? (attachedRequestIds.length === 1 ? attachedRequestIds[0] : undefined);
    const updateId = request.body?.updateId?.trim();
    const kind = request.body?.kind;
    if (!updateId || !kind) return reply.code(400).send({ error: "updateId and kind are required" });
    if (!requestId) return reply.code(400).send({
      error: attachedRequestIds.length === 0
        ? "requestId is required because the current run has no attached correlated request"
        : "requestId is required because the current run has multiple attached correlated requests",
      currentRequestIds: attachedRequestIds,
    });
    if (suppliedRequestId && !coordinationV3.getRequest(suppliedRequestId)) return reply.code(409).send({
      error: "request not found",
      currentRequestIds: attachedRequestIds,
      hint: attachedRequestIds.length === 1
        ? "Retry without requestId to target the current run's attached request"
        : "Retry with one exact currentRequestId",
    });
    try {
      const result = coordinationV3.updateRequest({
        requestId,
        updateId,
        kind,
        actor: { kind: "agent", id: capability.agentId },
        runAuthorization: runAuthorization(capability),
        ...(request.body.inReplyToUpdateId?.trim() ? { inReplyToUpdateId: request.body.inReplyToUpdateId.trim() } : {}),
        payload: { text: request.body.text?.trim() ?? "", executionId: capability.runId },
      });
      const changedRequest = coordinationV3.getRequest(requestId);
      if (changedRequest?.requesterAgentId) publishCoordinationV3Changed(changedRequest.requesterAgentId);
      if (changedRequest) publishCoordinationV3Changed(changedRequest.recipientAgentId);
      coordinationV3Scheduler?.notify();
      return result;
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "request update failed" });
    }
  });

  app.post<{
    Body: SendAgentMessageRequest;
  }>("/api/agent-messages", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    if (!capability) return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    const active = activeRuns.get(capability.agentId);
    if (!capabilityOwnsAuthoritativeRun(capability, active) || active!.messageCapability !== token) {
      return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    }
    const intent = request.body?.intent;
    const text = request.body?.text?.trim();
    const v3Urgency = (request.body as SendAgentMessageRequest & { urgency?: "ordinary" | "urgent" })?.urgency;
    if (!(["broadcast", "direct_to_user", "collaboration"] as const).includes(intent)) {
      return reply.code(400).send({
        error: 'ponderosa_message requires an intent property equal to "broadcast", "direct_to_user", or "collaboration"; do not use intent:"user_dm" or direct_to_user:true',
      });
    }
    if (v3Urgency !== undefined && v3Urgency !== "ordinary" && v3Urgency !== "urgent") {
      return reply.code(400).send({ error: "urgency must be ordinary or urgent" });
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
    let citations: VerifiedCitationDto[];
    try { citations = normalizeExternalCitations(request.body?.citations); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid citations" }); }
    const idempotencyKey = request.body?.idempotencyKey?.trim();
    if (idempotencyKey && idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 200 characters or fewer" });
    const receiptKey = idempotencyKey ? `${capability.runId}:${intent}:${idempotencyKey}` : undefined;
    const communicationEventId = receiptKey
      ? `runtime-${createHash("sha256").update(`${currentAuthor?.projectId ?? "unknown"}\0${receiptKey}`).digest("hex")}`
      : randomUUID();
    const replay = coordinationV3.runtimeCommunication(communicationEventId);
    const replayPayload = replay?.payload && typeof replay.payload === "object"
      ? replay.payload as { communication?: CommunicationEvent }
      : undefined;
    const replayCommunication = replayPayload?.communication ?? replay?.payload as CommunicationEvent | undefined;

    if (!currentAuthor || currentAuthor.archived) {
      return reply.code(409).send({ error: "agent is no longer available" });
    }
    const document = documentTitle && documentContent ? {
      id: replayCommunication?.document?.id ?? randomUUID(), title: documentTitle, mediaType: "text/markdown" as const,
      content: documentContent, byteLength: Buffer.byteLength(documentContent, "utf8"),
      authorAgentId: capability.agentId, executionId: capability.runId,
      createdAt: new Date().toISOString(),
    } : undefined;

    if (intent === "direct_to_user") {
      const proposedCommunication: CommunicationEvent = {
        eventId: communicationEventId,
        schemaVersion: 2,
        projectId: currentAuthor.projectId,
        ...(capability.conversationId ? { conversationId: capability.conversationId } : {}),
        sender: { kind: "agent", agentId: capability.agentId, executionId: capability.runId },
        intent: "user_dm",
        audience: { kind: "user_agent", userId: "local-operator", agentId: capability.agentId },
        text,
        ...(document ? { document } : {}),
        ...(citations.length ? { citations } : {}),
        createdAt: replay?.createdAt ?? new Date().toISOString(),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      };
      const intake = coordinationV3.recordRuntimeCommunication({
        id: proposedCommunication.eventId,
        projectId: currentAuthor.projectId,
        sender: proposedCommunication.sender,
        intent: proposedCommunication.intent,
        audience: proposedCommunication.audience,
        payload: proposedCommunication,
        scopeKey: capability.conversationId ? `conversation:${capability.conversationId}` : `agent:${capability.agentId}`,
        runAuthorization: runAuthorization(capability),
        now: proposedCommunication.createdAt,
      });
      if (intake.replayed) {
        const existing = store.readEvents(capability.agentId).find((item) =>
          item.event.type === "communication_projection" && item.event.communicationEventId === proposedCommunication.eventId);
        return { intent, eventId: proposedCommunication.eventId, messageId: existing ? `agent-event-${existing.seq}` : proposedCommunication.eventId, replayed: true };
      }
      const communication = recordCommunication(proposedCommunication);
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
    const correlatedRequesterIds = intent === "collaboration" && v3Urgency !== "urgent"
      ? new Set(coordinationV3.requesterIdsForRun(
        capability.v3SchedulerRunId,
        capability.agentId,
      ))
      : new Set<string>();
    const passiveRecipientAgentIds = new Set(routing.intents.flatMap((delivery) =>
      correlatedRequesterIds.has(delivery.targetAgentId) ? [delivery.targetAgentId] : []));
    const actionableRoutingIntents = routing.intents.filter(
      (delivery) => !passiveRecipientAgentIds.has(delivery.targetAgentId),
    );
    const channel = intent === "broadcast" ? "main" : "collaboration";
    const proposedCommunication: CommunicationEvent = intent === "broadcast" ? {
      eventId: communicationEventId,
      schemaVersion: 2,
      projectId: currentAuthor.projectId,
      conversationId: capability.conversationId,
      sender: { kind: "agent", agentId: capability.agentId, executionId: capability.runId },
      intent,
      audience: { kind: "organization", organizationId: currentAuthor.projectId },
      text: scopedText,
      ...(document ? { document } : {}),
      ...(citations.length ? { citations } : {}),
      createdAt: replay?.createdAt ?? new Date().toISOString(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    } : {
      eventId: communicationEventId,
      schemaVersion: 2,
      projectId: currentAuthor.projectId,
      conversationId: capability.conversationId,
      sender: { kind: "agent", agentId: capability.agentId, executionId: capability.runId },
      intent,
      audience: { kind: "agents", agentIds: routing.intents.map((item) => item.targetAgentId) as [string, ...string[]] },
      audienceSelector: routing.intents.some((item) => item.audience === "everyone") ? "everyone" : "mention",
      text,
      ...(document ? { document } : {}),
      ...(citations.length ? { citations } : {}),
      createdAt: replay?.createdAt ?? new Date().toISOString(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
    const intake = coordinationV3.recordRuntimeCommunication({
      id: proposedCommunication.eventId,
      projectId: currentAuthor.projectId,
      sender: proposedCommunication.sender,
      intent: proposedCommunication.intent,
      audience: proposedCommunication.audience,
      payload: proposedCommunication,
      scopeKey: capability.conversationId ? `conversation:${capability.conversationId}` : `agent:${capability.agentId}`,
      runAuthorization: runAuthorization(capability),
      ...(intent === "collaboration" ? {
        activations: actionableRoutingIntents.map((delivery, index) => ({
          agentId: delivery.targetAgentId,
          kind: v3Urgency === "urgent" ? "urgent_message" : "ordinary_message",
          priority: v3Urgency === "urgent" ? 90 : 50,
          dispatchPolicy: v3Urgency === "urgent" ? "steer_or_run" as const : "next_run" as const,
          promptClass: v3Urgency === "urgent" ? "blocker" as const : "ordinary" as const,
          dedupeKey: `communication:${proposedCommunication.eventId}:${delivery.targetAgentId}:${index}`,
        })),
      } : {}),
      now: proposedCommunication.createdAt,
    });
    if (intake.replayed) {
      const existing = store.getConversationMessages(capability.conversationId, channel)
        .find((candidate) => candidate.communicationEventId === proposedCommunication.eventId);
      return {
        intent,
        eventId: proposedCommunication.eventId,
        messageId: existing?.id ?? proposedCommunication.eventId,
        replayed: true,
        ...(passiveRecipientAgentIds.size ? { passiveRecipientAgentIds: [...passiveRecipientAgentIds].sort() } : {}),
      };
    }
    const communication = recordCommunication(proposedCommunication);
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
    if (intent === "collaboration") {
      for (const delivery of routing.intents) {
        if (communication?.intent === "collaboration") {
          projectCommunicationToAgentAudit(delivery.targetAgentId, communication, renderedText);
        }
        publishCoordinationV3Changed(delivery.targetAgentId);
      }
      coordinationV3Scheduler.notify();
      appendBlockedMentionWarnings(capability.conversationId, routing.blocked);
    }
    return {
      intent,
      eventId: communication?.eventId,
      messageId: message.id,
      replayed: false,
      ...(passiveRecipientAgentIds.size ? { passiveRecipientAgentIds: [...passiveRecipientAgentIds].sort() } : {}),
    };
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
    if (!capability || !capabilityOwnsAuthoritativeRun(capability, active) || active!.messageCapability !== token) {
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
    if (!capabilityOwnsAuthoritativeRun(capability, active) || active!.messageCapability !== token) {
      return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    }
    scheduledSessionRollovers.set(capability.agentId, new Date().toISOString());
    return { scheduled: true, afterRunId: capability.runId };
  });

  app.get("/api/health", async (): Promise<HealthDto> => ({
    status: "ok",
    service: "ponderosa",
    version: "0.0.0",
    revision: opts.buildRevision?.trim() || "development",
  }));

  app.get("/api/communication-v3/metrics", async (_request, reply) => {
    if (!coordinationV3 || !coordinationV3Scheduler) return reply.code(404).send({ error: "Communication V3 is not enabled" });
    return {
      enabled: true,
      storage: coordinationV3.schedulerMetrics(),
      scheduler: coordinationV3Scheduler.snapshotMetrics(),
      waitCycleWarnings: coordinationV3.waitGraphCycles(),
    };
  });

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

  app.get<{ Querystring: { url?: string } }>("/api/link-favicon", async (request, reply) => {
    const target = externalFaviconTarget(request.query.url ?? "");
    if (!target) return reply.code(400).send({ error: "favicon URL must be a public HTTPS hostname" });
    try {
      const favicon = await (opts.linkFaviconLoader ?? loadExternalFavicon)(target);
      reply.type(favicon.mediaType);
      reply.header("cache-control", "public, max-age=3600");
      return reply.send(favicon.body);
    } catch {
      return reply.code(404).send({ error: "favicon unavailable" });
    }
  });

  const loopbackPreviewTarget = (raw: string): URL | undefined => {
    let target: URL;
    try { target = new URL(raw); } catch { return undefined; }
    const hostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (target.protocol !== "http:" || target.username || target.password || !target.port) return undefined;
    if (!(hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1")) return undefined;
    const port = Number(target.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    target.hostname = "127.0.0.1";
    target.hash = "";
    return target;
  };

  app.post<{ Body: CreateLinkPreviewRequest }>("/api/link-previews", async (request, reply) => {
    const target = loopbackPreviewTarget(request.body?.url);
    if (!target) return reply.code(400).send({ error: "preview URL must be HTTP on an explicit localhost port" });
    const { projectId, agentId, runId, conversationId } = request.body ?? {};
    const project = typeof projectId === "string" ? store.getProject(projectId) : undefined;
    const agent = typeof agentId === "string" ? store.getAgent(agentId) : undefined;
    const active = agent ? activeRuns.get(agent.id) : undefined;
    if (!project || !agent || agent.projectId !== project.id || !active || !ownsActiveRun(agent.id, active) ||
      active.runId !== runId || active.executionId !== runId) {
      return reply.code(409).send({ error: "preview scope does not match an active agent run" });
    }
    if (conversationId !== undefined) {
      const conversation = store.getConversation(conversationId);
      if (!conversation || conversation.projectId !== project.id || !agent.conversationIds.includes(conversation.id)) {
        return reply.code(409).send({ error: "preview conversation is not owned by this agent and project" });
      }
    }
    for (const [key, registration] of linkPreviews) if (registration.expiresAt <= Date.now()) closeLinkPreviewRegistration(key, 1008, "preview expired");
    const id = randomUUID();
    const expiresAt = Date.now() + linkPreviewTtlMs;
    linkPreviews.set(id, {
      origin: target.origin,
      expiresAt,
      projectId,
      agentId,
      runId,
      ...(conversationId ? { conversationId } : {}),
      connections: new Set(),
      httpConnections: new Set(),
      reconnectAttempts: [],
    });
    const suffix = `${target.pathname}${target.search}`.replace(/^\//, "");
    return {
      id,
      openUrl: `/api/link-previews/${id}/${suffix}`,
      targetOrigin: target.origin,
      expiresAt: new Date(expiresAt).toISOString(),
    } satisfies LinkPreviewDto;
  });

  app.get<{ Params: { id: string; "*": string }; Querystring: Record<string, string> }>("/api/link-previews/:id/*", async (request, reply) => {
    const registration = linkPreviews.get(request.params.id);
    if (!registration || registration.expiresAt <= Date.now()) {
      closeLinkPreviewRegistration(request.params.id, 1008, "preview expired");
      return reply.code(404).send({ error: "preview expired or was not found" });
    }
    if (!linkPreviewOwned(registration)) {
      closeLinkPreviewRegistration(request.params.id, 1008, "preview run is no longer active");
      return reply.code(404).send({ error: "preview run is no longer active" });
    }
    const previewPath = request.params["*"] ?? "";
    if (previewPath === "__ws" || previewPath.startsWith("__ws/")) {
      return reply.code(426).header("upgrade", "websocket").send({ error: "this preview path requires a WebSocket upgrade" });
    }
    const relativePath = `/${previewPath}`;
    const target = new URL(relativePath, registration.origin);
    target.search = new URL(request.raw.url ?? "", "http://ponderosa.invalid").search;
    if (target.origin !== registration.origin) return reply.code(403).send({ error: "preview target is outside its registered origin" });
    if (registration.httpConnections.size >= linkPreviewMaxHttpPerRegistration) {
      return reply.code(429).send({ error: "preview HTTP connection limit reached" });
    }
    let upstream: Response;
    const upstreamController = new AbortController();
    registration.httpConnections.add(upstreamController);
    let httpReleased = false;
    const releaseHttp = (abort = false) => {
      if (httpReleased) return;
      httpReleased = true;
      registration.httpConnections.delete(upstreamController);
      if (abort) upstreamController.abort();
      reply.raw.off("close", onClientClose);
    };
    const onClientClose = () => releaseHttp(true);
    reply.raw.once("close", onClientClose);
    const handshakeTimer = setTimeout(() => upstreamController.abort(), 15_000);
    handshakeTimer.unref?.();
    try {
      upstream = await fetch(target, {
        redirect: "manual",
        headers: { accept: request.headers.accept ?? "*/*", "user-agent": "Ponderosa localhost preview" },
        signal: upstreamController.signal,
      });
    } catch {
      clearTimeout(handshakeTimer);
      releaseHttp();
      return reply.code(502).send({ error: "localhost app is unavailable" });
    }
    clearTimeout(handshakeTimer);
    const location = upstream.headers.get("location");
    if (location) {
      const redirected = new URL(location, target);
      if (redirected.origin !== registration.origin) {
        await upstream.body?.cancel().catch(() => undefined);
        releaseHttp();
        return reply.code(502).send({ error: "localhost app redirected outside its registered origin" });
      }
      reply.header("location", `/api/link-previews/${request.params.id}${redirected.pathname}${redirected.search}`);
    }
    reply.code(upstream.status);
    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    reply.type(contentType);
    reply.header("cache-control", "no-store");
    if (!upstream.body) {
      releaseHttp();
      return reply.send();
    }
    if (contentType.includes("text/html")) {
      const contentLength = Number(upstream.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > 5_000_000) {
        await upstream.body.cancel().catch(() => undefined);
        releaseHttp();
        return reply.code(413).send({ error: "preview document is too large" });
      }
      const reader = upstream.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > 5_000_000) {
            await reader.cancel().catch(() => undefined);
            releaseHttp();
            return reply.code(413).send({ error: "preview document is too large" });
          }
          chunks.push(value);
        }
      } catch {
        releaseHttp();
        return reply.code(502).send({ error: "localhost app closed the preview response" });
      }
      releaseHttp();
      const html = Buffer.concat(chunks).toString("utf8");
      const prefix = `/api/link-previews/${request.params.id}`;
      const base = `<base href="${prefix}${new URL(".", target).pathname}">`;
      const registrationOrigin = new URL(registration.origin);
      const bootstrap = `<script>(()=>{const N=window.WebSocket,A=new Set(["vite-hmr","vite-ping"]),H=${JSON.stringify(registrationOrigin.hostname)},P=${JSON.stringify(registrationOrigin.port)},X=${JSON.stringify(`${prefix}/__ws`)},Z=h=>h.replace(/^\\[|\\]$/g,""),C=Z(location.hostname),L=location.port||(location.protocol==="https:"?"443":"80");let W;W=new Proxy(N,{construct(T,a,n){try{const ps=typeof a[1]==="string"?[a[1]]:Array.isArray(a[1])?a[1]:[],u=new URL(String(a[0]),document.baseURI),h=Z(u.hostname),p=u.port||(u.protocol==="wss:"?"443":"80"),v=ps.length===1&&A.has(ps[0]),o=(h===H&&p===P)||(h===C&&p===L),x=u.pathname===X||u.pathname.startsWith(X+"/");if(v&&o&&!x&&!u.username&&!u.password&&!u.hash&&(u.protocol==="ws:"||u.protocol==="wss:"))a[0]=(location.protocol==="https:"?"wss:":"ws:")+"//"+location.host+X+u.pathname+u.search}catch{}return Reflect.construct(T,a,n===W?T:n)}});window.WebSocket=W})();</script>`;
      // Root-relative asset references otherwise escape the opaque proxy scope.
      const scopedHtml = html.replace(/\b(src|href|action)=(['"])\/(?!\/)/gi, `$1=$2${prefix}/`);
      return reply.send(/<head(?:\s[^>]*)?>/i.test(scopedHtml) ? scopedHtml.replace(/<head(\s[^>]*)?>/i, (head) => `${head}${base}${bootstrap}`) : `${base}${bootstrap}${scopedHtml}`);
    }
    const source = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream, { highWaterMark: 64 * 1024 });
    source.once("end", () => releaseHttp());
    source.once("close", () => releaseHttp());
    source.once("error", () => releaseHttp());
    if (contentType.includes("text/event-stream")) return reply.send(source);
    let streamedBytes = 0;
    const bounded = new Transform({
      highWaterMark: 64 * 1024,
      transform(chunk: Buffer, _encoding, callback) {
        streamedBytes += chunk.byteLength;
        if (streamedBytes > 50 * 1024 * 1024) {
          upstreamController.abort();
          callback(new Error("preview response exceeded 50 MiB"));
          return;
        }
        callback(null, chunk);
      },
    });
    return reply.send(source.pipe(bounded));
  });

  app.delete<{ Params: { id: string } }>("/api/link-previews/:id", async (request, reply) => {
    const registration = linkPreviews.get(request.params.id);
    if (!registration) return reply.code(404).send({ error: "preview was not found" });
    closeLinkPreviewRegistration(request.params.id, 1001, "preview explicitly closed");
    return { closed: true };
  });
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

  app.get<{ Querystring: { path?: string } }>("/api/project-folders/browse", async (request, reply): Promise<HostFolderBrowseDto | unknown> => {
    const roots = await browseRoots();
    const requested = request.query.path || roots[0]!;
    try {
      const { candidate, root } = await validatedBrowsePath(requested);
      const entries = await fs.readdir(candidate, { withFileTypes: true });
      const folders: HostFolderBrowseDto["folders"] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        try {
          const hostPath = await fs.realpath(path.join(candidate, entry.name));
          if (!insideRoot(hostPath, root) || !(await fs.stat(hostPath)).isDirectory()) continue;
          folders.push({ name: entry.name, hostPath });
        } catch { /* broken/inaccessible links are omitted */ }
      }
      const parent = path.dirname(candidate);
      return { path: candidate, root, ...(insideRoot(parent, root) ? { parentPath: parent } : {}), folders: folders.sort((a, b) => a.name.localeCompare(b.name)) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "folder is unavailable" });
    }
  });

  app.post<{ Body: CreateProjectRequest }>("/api/projects", async (request, reply) => {
    const label = request.body?.label?.trim();
    if (!label) return reply.code(400).send({ error: "label is required" });
    const defaultEngine = request.body?.defaultEngine;
    if (!defaultEngine || !engines.has(defaultEngine)) return reply.code(400).send({ error: "a configured default engine is required" });
    if (request.body.hostPath && request.body.createFolderName) return reply.code(400).send({ error: "choose an existing folder or create a new one, not both" });
    if (!request.body.hostPath && !request.body.createFolderName?.trim()) return reply.code(400).send({ error: "a validated host folder is required" });
    await fs.mkdir(managedWorkspacesRoot, { recursive: true });
    let hostPath: string;
    let createdManagedFolder = false;
    if (request.body.hostPath) {
      const candidate = path.resolve(request.body.hostPath);
      try {
        const stat = await fs.stat(candidate);
        if (!stat.isDirectory()) return reply.code(400).send({ error: "hostPath must be a directory" });
        const validated = await validatedBrowsePath(candidate);
        hostPath = validated.candidate;
      } catch {
        return reply.code(400).send({ error: "hostPath does not exist" });
      }
    } else {
      const requestedName = request.body.createFolderName?.trim();
      if (requestedName && (!/^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,79}$/u.test(requestedName) || requestedName === "." || requestedName === "..")) {
        return reply.code(400).send({ error: "folder name must be a single safe name" });
      }
      hostPath = path.join(managedWorkspacesRoot, requestedName!);
      try {
        await fs.mkdir(hostPath, { recursive: false });
        createdManagedFolder = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return reply.code(409).send({ error: "folder already exists" });
        throw error;
      }
    }
    let project;
    try {
      project = store.createProject({ label, hostPath, defaultEngine });
    } catch (error) {
      if (createdManagedFolder) await fs.rm(hostPath, { recursive: true, force: true });
      throw error;
    }
    appendWorkspace({ type: "project_changed", projectId: project.id, action: "created" });
    if (project.lastConversationId) appendWorkspace({ type: "conversation_changed", projectId: project.id, conversationId: project.lastConversationId, action: "created" });
    return project;
  });

  app.post<{ Params: { id: string }; Body: { conversationId?: string } }>("/api/projects/:id/use", async (request, reply) => {
    try {
      const project = store.markProjectUsed(request.params.id, request.body?.conversationId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      appendWorkspace({ type: "project_changed", projectId: project.id, action: "used" });
      if (request.body?.conversationId) appendWorkspace({ type: "conversation_changed", projectId: project.id, conversationId: request.body.conversationId, action: "used" });
      return project;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "project could not be selected" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const project = store.getProject(request.params.id);
    return project ?? reply.code(404).send({ error: "project not found" });
  });

  app.patch<{ Params: { id: string }; Body: UpdateProjectRequest }>("/api/projects/:id", async (request, reply) => {
    const label = request.body?.label?.trim();
    if (!label) return reply.code(400).send({ error: "label is required" });
    const project = store.updateProject(request.params.id, { label });
    if (!project) return reply.code(404).send({ error: "project not found" });
    appendWorkspace({ type: "project_changed", projectId: project.id, action: "updated" });
    return project;
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const project = store.getProject(request.params.id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const agents = store.listAgents(project.id);
    const agentIds = new Set(agents.map((agent) => agent.id));
    for (const agentId of agentIds) deletingAgentIds.add(agentId);
    // Fence scheduler ownership before touching provider processes. The later
    // project-store callback purges V3 in the same transaction as Project rows.
    coordinationV3.prepareProjectDeletion(project.id);
    for (const agentId of agentIds) {
      closeLinkPreviewsForAgent(agentId, "project deleted");
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
        await runtime.session.interrupt().catch(() => undefined);
        await runtime.session.close().catch(() => undefined);
      }
      subscribers.delete(agentId);
      scheduledSessionRollovers.delete(agentId);
    }
    userReactions.deleteProject(project.id);
    contextCursors.deleteAgents(agentIds);
    store.deleteProject(project.id, (projectId) => coordinationV3.purgeProject(projectId));
    appendWorkspace({ type: "project_changed", projectId: project.id, action: "deleted" });
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

  app.get<{ Querystring: { from?: string; to?: string } }>("/api/usage", async (request, reply) => {
    try { return projectedUsage({ type: "overall" }, parseTokenUsageRange(request.query)); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid usage range" }); }
  });

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>("/api/projects/:id/usage", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    try { return projectedUsage({ type: "project", id: request.params.id }, parseTokenUsageRange(request.query)); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid usage range" }); }
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
    const title = request.body?.title?.trim() || "New Chat";
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
    const conversation = store.createConversation(request.params.id, { ...request.body, title });
    appendWorkspace({ type: "conversation_changed", projectId: request.params.id, conversationId: conversation.id, action: "created" });
    appendWorkspace({ type: "project_changed", projectId: request.params.id, action: "used" });
    return conversation;
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const detail = conversationDetail(request.params.id);
    return detail ?? reply.code(404).send({ error: "conversation not found" });
  });

  app.post<{ Params: { id: string } }>("/api/conversations/:id/generate-title", async (request, reply) => {
    if (!store.getConversation(request.params.id)) return reply.code(404).send({ error: "conversation not found" });
    return generateConversationTitle(request.params.id);
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
    if (conversation) appendWorkspace({ type: "conversation_changed", projectId: conversation.projectId, conversationId: conversation.id, action: "updated" });
    return conversation;
  });

  app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const current = store.getConversation(request.params.id);
    if (current) {
      const active = store.listAgents(current.projectId).filter((agent) => agent.conversationIds.includes(current.id)).some((agent) => activeRuns.has(agent.id));
      if (active) return reply.code(409).send({ error: "stop active agents before deleting this Project chat" });
    }
    const deleted = store.deleteConversation(request.params.id);
    if (deleted && current) {
      const cursor = workspace.cursor();
      workspace.deleteDraft(current.id);
      workspace.deleteDraft(`collaboration:${current.id}`);
      await Promise.allSettled([
        fs.rm(draftAttachmentDir(current.id), { recursive: true, force: true }),
        fs.rm(draftAttachmentDir(`collaboration:${current.id}`), { recursive: true, force: true }),
      ]);
      workspace.append({ type: "conversation_changed", projectId: current.projectId, conversationId: current.id, action: "deleted" });
      publishWorkspaceSince(cursor);
    }
    return deleted ? { deleted: true } : reply.code(404).send({ error: "conversation not found" });
  });

  app.post<{
    Params: { id: string };
    Body: { role?: "user" | "assistant" | "system"; text: string; replyToMessageId?: string; directReplyToAuthorAgentId?: string; attachments?: AssetDto[]; idempotencyKey?: string };
  }>("/api/conversations/:id/messages", async (request, reply) => {
    const requestedText = request.body?.text?.trim();
    const text = requestedText ? stripLeadingScopeTag(requestedText, "broadcast") : "";
    if (!text) return reply.code(400).send({ error: "broadcast text is required after #broadcast" });
    if (request.body.directReplyToAuthorAgentId) return reply.code(400).send({ error: "use the idempotent direct-replies endpoint" });
    const idempotencyKey = request.body?.idempotencyKey?.trim();
    if (idempotencyKey && idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 200 characters or fewer" });
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
      schemaVersion: 2,
      projectId: master.projectId,
      conversationId: master.id,
      sender: { kind: "user", userId: "local-operator" },
      intent: "broadcast",
      audience: { kind: "organization", organizationId: master.projectId },
      text,
      ...(validatedAssets.length ? { attachments: validatedAssets } : {}),
      createdAt: new Date().toISOString(),
      ...(idempotencyKey ? { idempotencyKey: `broadcast:${master.id}:${idempotencyKey}` } : {}),
    });
    const replayedMessage = communication && idempotencyKey
      ? store.getConversationMessages(master.id).find((candidate) => candidate.communicationEventId === communication.eventId)
      : undefined;
    if (replayedMessage) return replayedMessage;
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
      const activeRunDelivery = request.body?.activeRunDelivery ?? "steer";
      if (activeRunDelivery !== "steer" && activeRunDelivery !== "queue") {
        return reply.code(400).send({ error: "activeRunDelivery must be steer or queue" });
      }
      if (!text || text.length > MAX_TEXT_LENGTH) return reply.code(400).send({ error: "text is required and must be 65536 characters or fewer" });
      if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
      if (!Array.isArray(recipients) || recipients.length === 0 || recipients.length > 100) {
        return reply.code(400).send({ error: "1 to 100 recipients are required" });
      }
      const agentIds = recipients.map((recipient) => recipient.agentId?.trim());
      if (agentIds.some((id) => !id) || new Set(agentIds).size !== agentIds.length) {
        return reply.code(400).send({ error: "recipient agent IDs must be unique" });
      }
      for (const recipient of recipients) {
        const ids = recipient.attachmentIds ?? [];
        if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS_PER_MESSAGE || new Set(ids).size !== ids.length) {
          return reply.code(400).send({ error: "each recipient supports at most 4 unique attachments" });
        }
      }
      const master = store.getConversation(request.params.id);
      if (!master || master.archived) return reply.code(404).send({ error: "conversation not found" });
      const targets = agentIds.map((agentId) => store.getAgent(agentId));
      if (targets.some((target) => !target || target.archived || !target.conversationIds.includes(master.id))) {
        return reply.code(404).send({ error: "direct message recipient not found" });
      }
      try {
        const attachmentsByAgent = await Promise.all(recipients.map(async (recipient) => {
          const attached = await Promise.all((recipient.attachmentIds ?? []).map((id) => assetMetadata(recipient.agentId, id)));
          if (attached.some((item) => !item || item.agentId !== recipient.agentId)) throw new AssetError(404, "direct message attachment not found");
          if (attached.reduce((sum, item) => sum + (item?.size ?? 0), 0) > ASSET_LIMITS.maxMessageBytes) {
            throw new AssetError(413, "message asset quota exceeded");
          }
          return (attached as NonNullable<(typeof attached)[number]>[]).map((item) => {
            const {
              projectId: _projectId, originalFile: _originalFile, previewFile: _previewFile,
              associatedAt: _associatedAt, ...publicAsset
            } = item;
            return { ...publicAsset, state: "associated" as const };
          }) as ImageAttachmentDto[];
        }));
        const receiptKey = `multi-direct:${master.id}:${idempotencyKey}`;
        const eventId = `user-dm-${createHash("sha256").update(receiptKey).digest("hex")}`;
        const existingRuntime = coordinationV3.runtimeCommunication(eventId);
        const createdAt = existingRuntime?.createdAt ?? new Date().toISOString();
        const communication: CommunicationEvent = {
          eventId, schemaVersion: 2, projectId: master.projectId, conversationId: master.id,
          sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
          audience: { kind: "user_agents", userId: "local-operator", agentIds: agentIds as [string, ...string[]] },
          text,
          ...(attachmentsByAgent.some((items) => items.length) ? { attachments: attachmentsByAgent.flat() } : {}),
          createdAt, idempotencyKey: receiptKey,
        };
        const intents: ConversationDeliveryIntent[] = recipients.map((recipient) => ({
          targetAgentId: recipient.agentId, relayDepth: 0, mentionTrail: [], kind: "direct",
          ...(recipient.attachmentIds?.length ? { attachmentIds: recipient.attachmentIds } : {}),
        }));
        const intake = coordinationV3.recordRuntimeCommunication({
          id: eventId,
          projectId: master.projectId,
          sender: communication.sender,
          intent: communication.intent,
          audience: communication.audience,
          payload: {
            communication,
            dispatch: {
              conversationId: master.id,
              text,
              replyToMessageId: replyToMessageId ?? null,
              recipients: recipients.map((recipient, index) => ({
                agentId: recipient.agentId,
                attachments: (attachmentsByAgent[index] ?? []).map((item) => ({
                  id: item.id, name: item.name, mediaType: item.mediaType, size: item.size,
                })),
              })),
            },
          },
          activations: recipients.map((recipient, index) => ({
            agentId: recipient.agentId,
            kind: "human_message",
            priority: 100,
            dispatchPolicy: activeRunDelivery === "steer" ? "steer_or_run" : "next_run",
            promptClass: "human",
            dedupeKey: `communication:${eventId}:${recipient.agentId}:${index}`,
          })),
          now: createdAt,
        });
        recordCommunication(communication);
        store.appendCommunicationProjection(master.projectId, {
          eventId, surface: "user_inbox", projectionKey: "local-operator", projectedAt: createdAt,
        });
        let message = store.getConversationMessageByReceiptKey(master.id, receiptKey);
        if (!message) {
          try {
            message = store.appendConversationMessage(
              master.id,
              { text, replyToMessageId, attachments: attachmentsByAgent[0] },
              undefined,
              "main",
              intents,
              receiptKey,
              eventId,
            );
          } catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid direct message" });
          }
        }
        if (!message) return reply.code(503).send({ error: "direct message projection could not be recorded; retry is safe" });
        if (!intake.replayed) {
          await Promise.all(recipients.map((recipient) => assets.associate(master.projectId, recipient.agentId, recipient.attachmentIds ?? [])));
          recipients.forEach((recipient, index) =>
            projectCommunicationToAgentAudit(recipient.agentId, communication, text, attachmentsByAgent[index]),
          );
        }
        for (const recipient of recipients) publishCoordinationV3Changed(recipient.agentId);
        coordinationV3Scheduler.notify();
        return {
          messageId: message.id,
          replayed: intake.replayed,
          recipients: recipients.map((recipient, index) => ({
            agentId: recipient.agentId,
            queued: true,
            deliveryId: intake.activationIds?.[index],
            state: "queued" as const,
          })),
        } satisfies MultiAgentDirectMessageResponse;
      } catch (error) {
        if (error instanceof AssetError) return reply.code(error.statusCode).send({ error: error.message });
        return reply.code(409).send({ error: error instanceof Error ? error.message : "direct message conflict" });
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
    if (!communication || communication.sender.kind !== "agent") return reply.code(404).send({ error: "agent-authored message not found" });
    const target = store.getAgent(communication.sender.agentId);
    if (!target || target.archived || target.projectId !== projectId) return reply.code(404).send({ error: "message author not found" });
    const id = `reaction-${createHash("sha256").update(`${projectId}\0${idempotencyKey}`).digest("hex")}`;
    const existing = coordinationV3.runtimeCommunication(id);
    const event = {
      id,
      idempotencyKey,
      projectId,
      communicationEventId,
      targetAuthorAgentId: target.id,
      emoji,
      replyTo: {
        messageId: communicationEventId,
        text: communication.text,
        role: "assistant" as const,
        authorAgentId: target.id,
      },
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    let intake;
    try {
      intake = coordinationV3.recordRuntimeCommunication({
        id,
        projectId,
        sender: { kind: "user", userId: "local-operator" },
        intent: "reaction",
        audience: { agentId: target.id },
        payload: {
          reaction: event,
          notification: { text: `the user reacted with ${emoji}`, reactedTo: event.replyTo },
        },
        activation: {
          agentId: target.id,
          kind: "user_reaction",
          priority: 100,
          dispatchPolicy: "steer_or_run",
          promptClass: "human",
        },
        now: event.createdAt,
      });
      userReactions.record(event);
      if (!intake.replayed) {
        const stored = store.appendEvent(target.id, {
          type: "user_message", text: `the user reacted with ${emoji}`, replyTo: event.replyTo,
        });
        publish(target.id, stored);
      }
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "reaction conflict" });
    }
    publishCoordinationV3Changed(target.id);
    coordinationV3Scheduler.notify();
    return {
      replayed: intake.replayed,
      queued: true,
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
      const activeRunDelivery = request.body?.activeRunDelivery ?? "steer";
      if (activeRunDelivery !== "steer" && activeRunDelivery !== "queue") return reply.code(400).send({ error: "activeRunDelivery must be steer or queue" });
      if (!text && attachmentIds.length === 0) return reply.code(400).send({ error: "text or an attachment is required" });
      if (text.length > MAX_TEXT_LENGTH) return reply.code(400).send({ error: "text must be 65536 characters or fewer" });
      if (!replyToMessageId || !targetAuthorAgentId) return reply.code(400).send({ error: "reply target and author are required" });
      if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
      if (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE || new Set(attachmentIds).size !== attachmentIds.length) {
        return reply.code(400).send({ error: "at most 4 unique attachments are allowed" });
      }
      const master = store.getConversation(request.params.id);
      if (!master || master.archived) return reply.code(404).send({ error: "conversation not found" });
      const target = store.getAgent(targetAuthorAgentId);
      if (!target || target.archived || !target.conversationIds.includes(master.id)) return reply.code(404).send({ error: "direct reply target not found" });
      const attached = await Promise.all(attachmentIds.map((id) => assetMetadata(target.id, id)));
      if (attached.some((item) => !item || item.agentId !== target.id)) return reply.code(404).send({ error: "direct reply attachment not found" });
      const attachments = attached as ImageAttachmentDto[];
      const receiptKey = `direct-reply:${master.id}:${idempotencyKey}`;
      const eventId = `direct-reply-${createHash("sha256").update(receiptKey).digest("hex")}`;
      const existingRuntime = coordinationV3.runtimeCommunication(eventId);
      const createdAt = existingRuntime?.createdAt ?? new Date().toISOString();
      const communication: CommunicationEvent = {
        eventId, schemaVersion: 2, projectId: master.projectId, conversationId: master.id,
        sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
        audience: { kind: "user_agent", userId: "local-operator", agentId: target.id },
        text, createdAt, idempotencyKey: receiptKey,
      };
      let intake;
      try {
        intake = coordinationV3.recordRuntimeCommunication({
          id: eventId,
          projectId: master.projectId,
          sender: communication.sender,
          intent: communication.intent,
          audience: communication.audience,
          payload: {
            communication,
            dispatch: {
              conversationId: master.id,
              text,
              replyToMessageId,
              targetAuthorAgentId,
              attachments: attachments.map((item) => ({
                id: item.id, name: item.name, mediaType: item.mediaType, size: item.size,
              })),
            },
          },
          activation: {
            agentId: target.id,
            kind: "human_message",
            priority: 100,
            dispatchPolicy: activeRunDelivery === "steer" ? "steer_or_run" : "next_run",
            promptClass: "human",
          },
          now: createdAt,
        });
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : "direct reply conflict" });
      }
      recordCommunication(communication);
      store.appendCommunicationProjection(master.projectId, {
        eventId, surface: "user_inbox", projectionKey: "local-operator", projectedAt: createdAt,
      });
      const renderedText = `#${agentMentionHandle(target.title)} ${text}`.trimEnd();
      let message = store.getConversationMessageByReceiptKey(master.id, receiptKey);
      if (!message) {
        try {
          message = store.appendConversationMessage(
            master.id,
            { text: renderedText, replyToMessageId, directReplyToAuthorAgentId: target.id, attachments },
            undefined,
            "main",
            [{ targetAgentId: target.id, relayDepth: 0, mentionTrail: [], kind: "direct" }],
            receiptKey,
            eventId,
          );
        } catch (error) {
          return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid direct reply" });
        }
      }
      if (!message) return reply.code(503).send({ error: "direct reply projection could not be recorded; retry is safe" });
      if (!intake.replayed) {
        await assets.associate(master.projectId, target.id, attachmentIds);
        projectCommunicationToAgentAudit(target.id, communication, text, attachments);
      }
      publishCoordinationV3Changed(target.id);
      coordinationV3Scheduler.notify();
      return {
        messageId: message.id,
        targetAuthorAgentId: target.id,
        replayed: intake.replayed,
        queued: true,
        deliveryId: intake.activationId,
        state: "queued",
      } satisfies DirectReplyResponse;
    },
  );


  app.get<{ Params: { id: string } }>("/api/conversations/:id/queued-messages", async (request, reply) => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation || conversation.archived) return reply.code(404).send({ error: "conversation not found" });
    const pending = coordinationV3.pendingActivations(conversation.projectId);
    const perAgentPosition = new Map<string, number>();
    return pending.flatMap((activation) => {
      const payload = activation.payload && typeof activation.payload === "object"
        ? activation.payload as { communication?: CommunicationEvent; dispatch?: { conversationId?: string; text?: string } }
        : undefined;
      const communication = payload?.communication;
      if (payload?.dispatch?.conversationId !== conversation.id ||
          communication?.sender.kind !== "user" || communication.sender.userId !== "local-operator") return [];
      const position = (perAgentPosition.get(activation.agentId) ?? 0) + 1;
      perAgentPosition.set(activation.agentId, position);
      const message = store.getConversationMessages(conversation.id, "main")
        .find((candidate) => candidate.communicationEventId === communication.eventId);
      return [{
        deliveryId: activation.id,
        messageId: message?.id ?? communication.eventId,
        conversationId: conversation.id,
        targetAgentId: activation.agentId,
        text: message?.text ?? payload.dispatch?.text ?? communication.text,
        position,
        createdAt: activation.createdAt,
        status: "queued",
      } satisfies QueuedConversationMessageDto];
    });
  });

  app.post<{
    Params: { id: string; deliveryId: string };
    Body: CancelQueuedMessageRequest;
  }>("/api/conversations/:id/queued-messages/:deliveryId/cancel", async (request, reply) => {
    const idempotencyKey = request.body?.idempotencyKey?.trim() ?? "";
    if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
    const conversation = store.getConversation(request.params.id);
    if (!conversation || conversation.archived) return reply.code(404).send({ error: "conversation not found" });
    const activation = coordinationV3.pendingActivations(conversation.projectId)
      .find((candidate) => candidate.id === request.params.deliveryId);
    if (!activation) {
      const result = coordinationV3.cancelPendingActivation({
        activationId: request.params.deliveryId,
        projectId: conversation.projectId,
        idempotencyKey,
      });
      return result.cancelled
        ? result satisfies CancelQueuedMessageResponse
        : reply.code(409).send(result satisfies CancelQueuedMessageResponse);
    }
    const payload = activation.payload && typeof activation.payload === "object"
      ? activation.payload as { communication?: CommunicationEvent; dispatch?: { conversationId?: string } }
      : undefined;
    if (payload?.dispatch?.conversationId !== conversation.id) return reply.code(404).send({ error: "queued message not found" });
    if (payload.communication?.sender.kind !== "user" || payload.communication.sender.userId !== "local-operator") {
      return reply.code(403).send({ error: "only your own queued messages can be cancelled" });
    }
    const result = coordinationV3.cancelPendingActivation({
      activationId: activation.id,
      projectId: conversation.projectId,
      idempotencyKey,
    });
    if (!result.cancelled) return reply.code(409).send(result satisfies CancelQueuedMessageResponse);
    appendWorkspace({ type: "queued_message_changed", conversationId: conversation.id, deliveryId: activation.id, action: "cancelled" });
    publishCoordinationV3Changed(activation.agentId);
    return result satisfies CancelQueuedMessageResponse;
  });


  app.post<{
    Params: { id: string; messageId: string };
    Body: CorrectConversationMessageRequest;
  }>("/api/conversations/:id/messages/:messageId/corrections", async (request, reply) => {
    const text = request.body?.text?.trim() ?? "";
    const idempotencyKey = request.body?.idempotencyKey?.trim() ?? "";
    if (!text || text.length > MAX_TEXT_LENGTH) return reply.code(400).send({ error: "correction text is required" });
    if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
    if (request.body?.activeRunDelivery && request.body.activeRunDelivery !== "queue") return reply.code(400).send({ error: "corrections always queue a new turn" });
    const conversation = store.getConversation(request.params.id);
    if (!conversation || conversation.archived) return reply.code(404).send({ error: "conversation not found" });
    const receiptKey = `correction:${conversation.id}:${idempotencyKey}`;
    const messages = store.getConversationMessages(conversation.id, "main");
    const latestOperatorMessage = messages.filter((message) => message.role === "user" && !message.authorAgentId).at(-1);
    const existingMessage = store.getConversationMessageByReceiptKey(conversation.id, receiptKey);
    if (!existingMessage && (!latestOperatorMessage || latestOperatorMessage.id !== request.params.messageId)) {
      return reply.code(409).send({ error: "only your latest sent message can be corrected" });
    }
    if (!existingMessage && latestOperatorMessage?.correctedByMessageId) return reply.code(409).send({ error: "this message already has an immutable correction" });
    const original = existingMessage
      ? messages.find((message) => message.id === existingMessage.correctionOfMessageId)
      : latestOperatorMessage;
    const originalEventId = original?.communicationEventId;
    const targets = originalEventId ? coordinationV3.communicationRecipientAgentIds(originalEventId) : [];
    if (targets.length !== 1) {
      return reply.code(409).send({ error: targets.length === 0 ? "message delivery has not been scheduled" : "messages sent to multiple agents cannot be corrected as one turn" });
    }
    const target = store.getAgent(targets[0]!);
    if (!target || target.archived || !target.conversationIds.includes(conversation.id)) return reply.code(409).send({ error: "the original recipient is no longer available" });
    const eventId = `correction-${createHash("sha256").update(receiptKey).digest("hex")}`;
    const existingRuntime = coordinationV3.runtimeCommunication(eventId);
    const createdAt = existingRuntime?.createdAt ?? new Date().toISOString();
    const communication: CommunicationEvent = {
      eventId, schemaVersion: 2, projectId: conversation.projectId, conversationId: conversation.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
      audience: { kind: "user_agent", userId: "local-operator", agentId: target.id }, text,
      createdAt, idempotencyKey: receiptKey, correctionOfEventId: originalEventId,
    };
    let intake;
    try {
      intake = coordinationV3.recordRuntimeCommunication({
        id: eventId,
        projectId: conversation.projectId,
        sender: communication.sender,
        intent: "correction",
        audience: communication.audience,
        payload: {
          communication,
          dispatch: {
            conversationId: conversation.id,
            text,
            correctionOfMessageId: request.params.messageId,
            correctionOfEventId: originalEventId,
          },
        },
        activation: {
          agentId: target.id,
          kind: "message_correction",
          priority: 100,
          dispatchPolicy: "next_run",
          promptClass: "human",
        },
        now: createdAt,
      });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "correction conflict" });
    }
    recordCommunication(communication);
    store.appendCommunicationProjection(conversation.projectId, {
      eventId, surface: "user_inbox", projectionKey: "local-operator", projectedAt: createdAt,
    });
    let message = existingMessage;
    if (!message) {
      message = store.appendConversationMessage(
        conversation.id,
        { text, replyToMessageId: request.params.messageId },
        undefined,
        "main",
        [{ targetAgentId: target.id, relayDepth: 0, mentionTrail: [], kind: "direct" }],
        receiptKey,
        eventId,
      );
    }
    if (!message) return reply.code(503).send({ error: "correction projection could not be recorded; retry is safe" });
    publishCoordinationV3Changed(target.id);
    coordinationV3Scheduler.notify();
    return {
      originalMessageId: request.params.messageId,
      correctionMessageId: message.id,
      replayed: intake.replayed,
      queued: true,
    } satisfies CorrectConversationMessageResponse;
  });


  app.get<{ Params: { id: string } }>("/api/conversations/:id/collaboration", async (request, reply) => {
    const detail = collaborationViewDetail(request.params.id);
    return detail ?? reply.code(404).send({ error: "conversation not found" });
  });

  app.post<{
    Params: { id: string };
    Body: { text: string; recipientAgentIds?: string[]; replyToMessageId?: string; directReplyToAuthorAgentId?: string; idempotencyKey?: string };
  }>("/api/conversations/:id/collaboration/messages", async (request, reply) => {
    const text = request.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: "text is required" });
    if (text.length > MAX_TEXT_LENGTH) return reply.code(400).send({ error: "text must be 65536 characters or fewer" });
    const idempotencyKey = request.body?.idempotencyKey?.trim();
    if (idempotencyKey && idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 200 characters or fewer" });
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
    const eventId = idempotencyKey
        ? `collaboration-${createHash("sha256").update(`${master.id}\0${idempotencyKey}`).digest("hex")}`
        : randomUUID();
    const existingRuntime = coordinationV3.runtimeCommunication(eventId);
    const communication: CommunicationEvent = {
      eventId,
      schemaVersion: 2, projectId: master.projectId, conversationId: master.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "collaboration",
      audience: { kind: "agents", agentIds: routing.intents.map((item) => item.targetAgentId) as [string, ...string[]] },
      audienceSelector: routing.intents.some((item) => item.audience === "everyone") ? "everyone" : "mention",
      text, createdAt: existingRuntime?.createdAt ?? new Date().toISOString(),
      ...(idempotencyKey ? { idempotencyKey: `collaboration:${master.id}:${idempotencyKey}` } : {}),
    };
    let intake;
    try {
      intake = coordinationV3.recordRuntimeCommunication({
        id: eventId,
        projectId: master.projectId,
        sender: communication.sender,
        intent: communication.intent,
        audience: communication.audience,
        payload: {
          communication,
          dispatch: { conversationId: master.id, text: renderedText, replyToMessageId: request.body.replyToMessageId ?? null },
        },
        activations: routing.intents.map((intent, index) => ({
          agentId: intent.targetAgentId,
          kind: "human_message",
          priority: 100,
          dispatchPolicy: "steer_or_run",
          promptClass: "human",
          dedupeKey: `communication:${eventId}:${intent.targetAgentId}:${index}`,
        })),
        now: communication.createdAt,
      });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "collaboration conflict" });
    }
    recordCommunication(communication);
    const replayedMessage = detail.messages.find((candidate) => candidate.communicationEventId === communication.eventId);
    if (replayedMessage && intake.replayed) {
      return {
        message: replayedMessage,
        audience: hasEveryoneMention(text) ? "everyone" : "mention",
        notifiedAgentIds: routing.intents.map((intent) => intent.targetAgentId),
      };
    }
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
    for (const intent of routing.intents) {
      store.appendCommunicationProjection(master.projectId, {
        eventId, surface: "agent_inbox", projectionKey: intent.targetAgentId, projectedAt: communication.createdAt,
      });
      projectCommunicationToAgentAudit(intent.targetAgentId, communication, renderedText);
      publishCoordinationV3Changed(intent.targetAgentId);
    }
    coordinationV3Scheduler.notify();
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
        const createdAt = new Date().toISOString();
        const eventId = `agent-opening:${agent.id}`;
        const managed = Boolean(agent.managerAgentId);
        const communication: CommunicationEvent = managed ? {
          eventId, schemaVersion: 2, projectId: agent.projectId,
          ...(agent.conversationId ? { conversationId: agent.conversationId } : {}),
          sender: { kind: "user", userId: "local-operator" }, intent: "collaboration",
          audience: { kind: "agents", agentIds: [agent.id] },
          text: initialMessage, createdAt,
          ...(request.body.replyToMessageId ? { causationId: request.body.replyToMessageId } : {}),
        } : {
          eventId, schemaVersion: 2, projectId: agent.projectId,
          ...(agent.conversationId ? { conversationId: agent.conversationId } : {}),
          sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
          audience: { kind: "user_agent", userId: "local-operator", agentId: agent.id },
          text: initialMessage, createdAt,
        };
        coordinationV3.recordRuntimeCommunication({
          id: eventId,
          projectId: agent.projectId,
          sender: communication.sender,
          intent: "managed_agent_opening",
          audience: communication.audience,
          payload: {
            communication,
            dispatch: {
              conversationId: agent.conversationId ?? null,
              text: initialMessage,
              replyToMessageId: request.body.replyToMessageId ?? null,
              model: request.body.model ?? null,
              effort: request.body.effort ?? null,
            },
          },
          activation: {
            agentId: agent.id,
            kind: "managed_agent_opening",
            priority: 100,
            dispatchPolicy: "steer_or_run",
            promptClass: "human",
          },
          now: createdAt,
        });
        recordCommunication(communication);
        if (communication.intent === "user_dm") {
          store.appendCommunicationProjection(agent.projectId, {
            eventId, surface: "user_inbox", projectionKey: "local-operator", projectedAt: createdAt,
          });
        }
        if (agent.conversationId) {
          store.appendConversationMessage(
            agent.conversationId,
            {
              role: "user",
              text: managed ? `#${agentMentionHandle(agent.title)} ${initialMessage}` : `#${agentMentionHandle(agent.title)} ${initialMessage}`,
              replyToMessageId: request.body.replyToMessageId,
            },
            undefined,
            managed ? "collaboration" : "main",
            managed ? [{ targetAgentId: agent.id, relayDepth: 0, mentionTrail: [], kind: "tag", audience: "mention" }] : undefined,
            undefined,
            eventId,
          );
        }
        const audit = store.appendEvent(agent.id, {
          type: "user_message", text: initialMessage, communicationEventId: eventId,
        });
        publish(agent.id, audit);
        publishCoordinationV3Changed(agent.id);
        coordinationV3Scheduler.notify();
      }

      return agent;
    },
  );

  app.get<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    const detail = agentDetail(request.params.id);
    return detail ?? reply.code(404).send({ error: "agent not found" });
  });

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>("/api/agents/:id/usage", async (request, reply) => {
    if (!store.getAgent(request.params.id)) return reply.code(404).send({ error: "agent not found" });
    try { return projectedUsage({ type: "agent", id: request.params.id }, parseTokenUsageRange(request.query)); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid usage range" }); }
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
      const agent = store.updateAgentConversationMemberships(request.params.id, request.body, (agentId, removedConversationIds) => {
        for (const conversationId of removedConversationIds) {
          coordinationV3.handleAgentConversationRemoval(agentId, conversationId);
        }
      });
      if (agent) coordinationV3Scheduler.notify();
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
    // SQLite cancellation advances the fence and settles steering before the
    // provider is interrupted. Late tool/output activity then fails closed.
    for (const agent of subtree) coordinationV3.cancelAgentRun({
      agentId: agent.id,
      idempotencyKey: `agent-delete:${agent.id}`,
    });
    for (const agent of subtree) {
      closeLinkPreviewsForAgent(agent.id, "agent deleted");
      const run = activeRuns.get(agent.id);
      if (run) {
        activeRuns.delete(agent.id);
        clearRunLeaseTimer(run);
        clearRunLivenessTimer(run);
        agentMessageCapabilities.delete(run.messageCapability);
        scheduledSessionRollovers.delete(agent.id);
        run.controller.abort();
      }
      const runtime = runtimeSessions.get(agent.id);
      if (runtime) {
        removePersistentRuntime(agent.id, runtime);
        await runtime.session.interrupt().catch(() => undefined);
        await runtime.session.close().catch(() => undefined);
      }
    }
    const deleted = store.deleteAgent(id, (agentId) => coordinationV3.handleAgentDeletion(agentId));
    if (!deleted) {
      for (const agent of subtree) deletingAgentIds.delete(agent.id);
      return reply.code(404).send({ error: "agent not found" });
    }
    const deletedAgentIds = new Set(subtree.map((agent) => agent.id));
    const workspaceCursor = workspace.cursor();
    for (const agentId of deletedAgentIds) {
      subscribers.delete(agentId);
      scheduledSessionRollovers.delete(agentId);
      workspace.deleteDraft(`agent:${agentId}`);
      await fs.rm(draftAttachmentDir(`agent:${agentId}`), { recursive: true, force: true });
    }
    contextCursors.deleteAgents(deletedAgentIds);
    publishWorkspaceSince(workspaceCursor);
    for (const agentId of deletedAgentIds) deletingAgentIds.delete(agentId);
    return { deleted: true, deletedAgentIds: subtree.map((agent) => agent.id) };
  });

  app.post("/api/agents/:id/switch-engine", async (_request, reply) =>
    reply.code(501).send({ error: "switch-engine is a v2 endpoint" }),
  );

  app.get("/api/agents/:id/search", async (_request, reply) =>
    reply.code(501).send({ error: "search is a v2 endpoint" }),
  );

  async function assetMetadata(agentId: string, id: string) {
    const agent = store.getAgent(agentId);
    if (!agent) return undefined;
    const metadata = await assets.read(agent.projectId, agent.id, id);
    return metadata && await assets.content(agent.projectId, agent.id, id, false) ? metadata : undefined;
  }

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
      sourceChannel?: "main";
      shareWithOrganization?: boolean;
      activeRunDelivery?: "steer" | "queue";
      sourceConversationId?: string;
      replyToMessageId?: string;
      attachmentIds?: string[];
      /** Server-only Communication V3 execution identity. */
      v3SchedulerRunId?: string;
      v3FencingToken?: number;
      v3InjectionId?: string;
      /** Server-only provider-cache disposition derived from durable V3 causes. */
      v3FreshProviderSession?: boolean;
      /** Server-only durable activation bundle assembled by the scheduler. */
      v3ActivationPrompt?: string;
      /** Server-only canonical authored communication referenced by the activation. */
      v3CommunicationEventId?: string;
    };
  }>(
    "/api/agents/:id/messages",
    async (request, reply) => {
      if (deletingAgentIds.has(request.params.id)) return reply.code(404).send({ error: "agent not found" });
      const agent = store.getAgent(request.params.id);
      if (!agent) return reply.code(404).send({ error: "agent not found" });
      const project = store.getProject(agent.projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      const allowedMessageFields = new Set([
        "text", "model", "effort", "agentMentionDepth", "agentMentionTrail", "sourceChannel",
        "shareWithOrganization", "activeRunDelivery", "sourceConversationId", "replyToMessageId",
        "attachmentIds", "v3SchedulerRunId", "v3FencingToken", "v3InjectionId",
        "v3FreshProviderSession", "v3ActivationPrompt", "v3CommunicationEventId",
      ]);
      if (Object.keys(request.body ?? {}).some((key) => !allowedMessageFields.has(key))) {
        return reply.code(400).send({ error: "unknown message field" });
      }
      const engine = engines.get(agent.activeEngine);
      if (!engine) return reply.code(400).send({ error: "unknown engine" });
      const text = request.body?.text?.trim() ?? "";
      const internalV3Dispatch = request.headers["x-ponderosa-v3-dispatch"] === v3DispatchKey;
      const v3SchedulerRunId = request.body.v3SchedulerRunId;
      const v3FencingToken = request.body.v3FencingToken;
      const v3InjectionId = request.body.v3InjectionId;
      const v3FreshProviderSession = request.body.v3FreshProviderSession;
      const v3ActivationPrompt = request.body.v3ActivationPrompt;
      const v3CommunicationEventId = request.body.v3CommunicationEventId;
      if ((v3SchedulerRunId !== undefined || v3FencingToken !== undefined || v3InjectionId !== undefined ||
          v3FreshProviderSession !== undefined || v3ActivationPrompt !== undefined ||
          v3CommunicationEventId !== undefined) && !internalV3Dispatch) {
        return reply.code(403).send({ error: "V3 scheduler identity is server-controlled" });
      }
      if (internalV3Dispatch && (!v3SchedulerRunId || !Number.isSafeInteger(v3FencingToken) || !v3InjectionId ||
          typeof v3FreshProviderSession !== "boolean" || !v3ActivationPrompt)) {
        return reply.code(400).send({ error: "V3 scheduler run, fencing token, injection ID, and provider-session disposition are required" });
      }
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
      if (shareWithOrganization && (request.body.sourceChannel !== "main" || !sourceConversationId)) {
        return reply.code(400).send({ error: "shared turns must originate from a Conversation" });
      }
      const directMessageConversationId = sourceConversationId ?? agent.conversationId;
      const directReplyTarget = request.body.replyToMessageId
        ? agentMessages(agent.id).find((message) => message.id === request.body.replyToMessageId)
        : undefined;
      const sourceMasterReply = request.body.replyToMessageId && directMessageConversationId
        ? store.getConversationMessages(directMessageConversationId, "main")
            .find((message) => message.id === request.body.replyToMessageId)
        : undefined;
      if (request.body.replyToMessageId && !directReplyTarget && !sourceMasterReply) {
        return reply.code(400).send({ error: "reply target was not found in this conversation" });
      }
      const proposedCommunication: CommunicationEvent | undefined = internalV3Dispatch
        ? undefined
        : shareWithOrganization ? {
            eventId: randomUUID(), schemaVersion: 2, projectId: project.id, conversationId: sourceConversationId!,
            sender: { kind: "user", userId: "local-operator" }, intent: "broadcast",
            audience: { kind: "organization", organizationId: project.id }, text,
            ...(messageAttachments.length ? { attachments: messageAttachments } : {}),
            createdAt: new Date().toISOString(),
          } : {
            eventId: randomUUID(), schemaVersion: 2, projectId: project.id,
            ...((sourceConversationId ?? agent.conversationId) ? { conversationId: sourceConversationId ?? agent.conversationId } : {}),
            sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
            audience: { kind: "user_agent", userId: "local-operator", agentId: agent.id }, text,
            ...(messageAttachments.length ? { attachments: messageAttachments } : {}),
            createdAt: new Date().toISOString(),
          };
      const intendedCommunicationEventId = proposedCommunication?.eventId;
      let v3Intake: ReturnType<CoordinationV3Store["recordRuntimeCommunication"]> | undefined;
      if (!internalV3Dispatch && intendedCommunicationEventId && proposedCommunication) {
        v3Intake = coordinationV3.recordRuntimeCommunication({
          id: `dispatch:${intendedCommunicationEventId}:${agent.id}`,
          projectId: project.id,
          sender: proposedCommunication.sender,
          intent: proposedCommunication.intent,
          audience: { agentId: agent.id },
          payload: {
            communication: proposedCommunication,
            dispatch: {
              text,
              communicationEventId: intendedCommunicationEventId,
              sourceConversationId: sourceConversationId ?? null,
              sourceChannel: request.body.sourceChannel ?? null,
              shareWithOrganization,
              replyToMessageId: request.body.replyToMessageId ?? null,
              attachments: messageAttachments.map((item) => ({
                id: item.id, name: item.name, mediaType: item.mediaType, size: item.size,
                localPath: path.join(attachmentsDir(opts.dataDir, agent.projectId, agent.id), `${item.id}.bin`),
              })),
              model: request.body.model ?? null,
              effort: request.body.effort ?? null,
            },
          },
          activation: {
            agentId: agent.id,
            kind: "human_message",
            priority: 100,
            dispatchPolicy: activeRunDelivery === "steer" ? "steer_or_run" : "next_run",
            promptClass: "human",
          },
          now: proposedCommunication?.createdAt,
        });
      }
      const communicationEventId = internalV3Dispatch
        ? v3CommunicationEventId
        : proposedCommunication ? recordCommunication(proposedCommunication).eventId : undefined;
      const communication = communicationEventId
        ? store.getCommunicationEvent(project.id, communicationEventId)
        : undefined;
      const sharedCommunication = communication?.intent === "broadcast" ? communication : undefined;
      const sharedTaskTurn = Boolean(sharedCommunication && shareWithOrganization);
      const directUserTaskTurn = Boolean(
        communication?.schemaVersion === 2 &&
        communication.intent === "user_dm" &&
        communication.sender.kind === "user" &&
        (communication.audience.kind === "user_agent"
          ? communication.audience.agentId === agent.id
          : communication.audience.agentIds.includes(agent.id)),
      );
      let sourceMasterMessage: ConversationMessageDto | undefined;
      if (communicationEventId) {
        if (communication?.schemaVersion === 2 && communication.intent === "user_dm") {
          store.appendCommunicationProjection(project.id, {
            eventId: communicationEventId,
            surface: "user_inbox",
            projectionKey: communication.audience.userId,
            projectedAt: communication.createdAt,
          });
        }
      }
      if (communicationEventId && directMessageConversationId) {
        if (internalV3Dispatch) {
          sourceMasterMessage = store.getConversationMessages(directMessageConversationId, "main")
            .find((message) => message.communicationEventId === communicationEventId);
        } else {
          sourceMasterMessage = store.appendConversationMessage(directMessageConversationId, {
            role: "user",
            text: sharedCommunication ? text : `#${agentMentionHandle(agent.title)} ${text}`,
            attachments: messageAttachments,
            replyToMessageId: sourceMasterReply?.id,
          }, undefined, "main", undefined, undefined, communicationEventId);
          if (sharedCommunication) projectBroadcastToAgentAudits(sharedCommunication, [agent.id], messageAttachments);
        }
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
        sourceChannel: request.body.sourceChannel === "main" ? "main" : undefined,
        replyToMessageId: request.body.replyToMessageId,
        replyTo: request.body.replyToMessageId
          ? (() => {
              const replyTarget = directReplyTarget ?? sourceMasterReply;
              return replyTarget ? { messageId: replyTarget.id, text: replyTarget.text, role: replyTarget.role } : undefined;
            })()
          : undefined,
      };
      const auditText = text;
      if (!internalV3Dispatch) {
        if (!v3Intake?.activationId) {
          return reply.code(500).send({ error: "actionable communication did not create an activation" });
        }
        if (!v3Intake.replayed) {
          await assets.associate(agent.projectId, agent.id, attachmentIds);
          if (!sharedCommunication) {
            const stored = store.appendEvent(agent.id, {
              type: "user_message", text: auditText, communicationEventId,
              replyTo: pendingTurn.replyTo, attachments: messageAttachments,
            });
            publish(agent.id, stored);
          }
        }
        const pendingForAgent = coordinationV3.pendingActivations(project.id)
          .filter((activation) => activation.agentId === agent.id);
        const pendingIndex = pendingForAgent.findIndex((activation) => activation.id === v3Intake.activationId);
        const position = pendingIndex >= 0 ? pendingIndex + 1 : 1;
        coordinationV3Scheduler.notify();
        publishCoordinationV3Changed(agent.id);
        return reply.code(202).send({
          queued: true,
          position,
          activationId: v3Intake.activationId,
          communicationEventId,
        });
      }
      const existingRun = activeRuns.get(agent.id);
      if (existingRun) {
        return reply.code(409).send({ error: "agent already has an active run", retryable: true });
      }

      const fullHistory: ChatMessage[] = agentMessages(agent.id)
        .filter((message) => {
          // The current authored message is already represented by the durable
          // Activation. Do not pay for it a second time in seeded history.
          if (communicationEventId && message.communicationEventId === communicationEventId) return false;
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
      const runId = v3SchedulerRunId ?? randomUUID();
      const controller = new AbortController();
      const requestContextRollover = Boolean(
        internalV3Dispatch && v3FreshProviderSession,
      );
      if (requestContextRollover) {
        // Provider sessions are resumable caches, not agent identity. A newly
        // created inbound request is an independent task context, while answer,
        // join, human, and steering activations continue their current context.
        // Close only the idle provider process; canonical agent state and all
        // durable coordination records remain intact.
        const staleRuntime = runtimeSessions.get(agent.id);
        if (staleRuntime) {
          removePersistentRuntime(agent.id, staleRuntime);
          await staleRuntime.session.close().catch(() => undefined);
        }
        scheduledSessionRollovers.delete(agent.id);
        store.clearResumeSession(agent.id, "request_context_rollover");
        organizationEnvelopeStates.delete(agent.id);
      }
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
      const sourceChannel: AgentMessageChannel = request.body.sourceChannel === "main"
          ? "main"
          : "individual";
      const contextAgents = conversation?.agents ?? [agent];
      const sourceAuthor = "Manager";
      const context = inboundContext(sourceChannel, sourceAuthor, text, contextAgents, agent.id);
      const cursorChannel = sourceChannel === "main" ? sourceChannel : undefined;
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
      const allRoomMessagesIncludingCurrent = conversation && sourceChannel === "main"
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
      const basePrompt = conversation && sourceChannel === "main"
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
      const directory = teamDirectory(agent.projectId, routingConversationId, agent.id);
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
      const fullSessionEnvelope = `${teamDirectoryPrompt(directoryForTurn)}\n\n${communicationV3Prompt().join("\n")}\n\n`;
      // A retained provider session already has this stable organization
      // envelope. Repeat it only for a new/rolled-over session, after a server
      // restart or warm eviction, or when roster/roles/reporting lines changed.
      // Live status remains available through PONDEROSA_AGENT_DIRECTORY_URL.
      const sessionEnvelope = resumeSessionId && previousOrganizationEnvelope?.sessionId === resumeSessionId &&
        previousOrganizationEnvelope.hash === organizationEnvelopeHash ? "" : fullSessionEnvelope;
      // Scheduler metadata restores the primary authored request above. A
      // single Activation therefore must not be serialized into the prompt a
      // second time. A coalesced Run still receives its remaining sources as
      // one bounded bundle. Steering uses the Activation prompt directly.
      const additionalActivationIndex = v3ActivationPrompt?.indexOf("\nActivation 2:") ?? -1;
      const coalescedActivationContext = internalV3Dispatch && additionalActivationIndex >= 0
        ? `\n\nAdditional coalesced Activations for this scheduler-owned Run:\n${v3ActivationPrompt!.slice(additionalActivationIndex + 1)}`
        : "";
      const promptTail = `${managerRelationshipPrompt(agent).join("\n")}\n\nThe live team directory and current activity are available from PONDEROSA_AGENT_DIRECTORY_URL when routing or discovery requires them.${initialBroadcastContext.length ? `\n\n${sharedBroadcastContextPrompt(initialBroadcastContext, conversation?.agents ?? [])}` : ""}\n\n${guidedPrompt}${completionContract ? `\n\n${completionContract}` : ""}${replyContext(pendingTurn.replyTo)}${attachmentContext}${coalescedActivationContext}`;
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
      let durableClaim: { generation: number };
      try {
        coordinationV3.markRunStarted(runId, v3FencingToken!);
        coordinationV3.setRunContextDisposition(
          runId,
          v3FencingToken!,
          requestContextRollover
            ? coordinationV3.runChangesScope(runId, agent.id) ? "reseeded" : "fresh_task"
            : resumeSessionId ? "continued_session" : "fresh_task",
        );
        publishCoordinationV3Changed(agent.id);
        durableClaim = { generation: v3FencingToken! };
      } catch {
        return reply.code(409).send({ error: "agent run ownership changed; retry safely", retryable: true });
      }
      const failUnstartedClaim = (cancelled = false): void => {
        if (cancelled) coordinationV3.cancelAgentRun({ agentId: agent.id, idempotencyKey: `unstarted:${runId}` });
        else coordinationV3.failRun({
          runId, fencingToken: v3FencingToken!, workerId: coordinationV3WorkerId,
          sameRunResumable: false, retryDelayMs: 0,
        });
      };
      await opts.messageLifecycleFaults?.afterRunClaim?.({
        agentId: agent.id,
        runId,
        generation: durableClaim.generation,
      });
      if (deletingAgentIds.has(agent.id) || !store.getAgent(agent.id)) {
        failUnstartedClaim(true);
        return reply.code(404).send({ error: "agent not found" });
      }

      try {
        await assets.associate(agent.projectId, agent.id, attachmentIds);
      } catch (error) {
        failUnstartedClaim();
        throw error;
      }
      if (deletingAgentIds.has(agent.id) || !store.getAgent(agent.id)) {
        failUnstartedClaim(true);
        return reply.code(404).send({ error: "agent not found" });
      }
      const startedAt = new Date().toISOString();
      const trackedV3FencingToken = internalV3Dispatch ? v3FencingToken : undefined;
      const runningLifecycle = store.appendEvent(agent.id, {
        type: "agent_lifecycle", status: "running", reason: "active_run", executionId: runId,
        wakeCause: sharedTaskTurn
          ? "project_request"
          : directUserTaskTurn
            ? "direct_message"
              : "collaboration",
        ...(effectiveModel ? { model: effectiveModel } : {}),
        ...(effectiveEffort ? { effort: effectiveEffort } : {}),
      });
      publish(agent.id, runningLifecycle);
      const activeRun: ActiveRun = {
        runId, startedAt, executionId: runId, leaseExpiresAt: leaseExpiry(), controller, messageCapability,
        ...(trackedV3FencingToken !== undefined
          ? { v3SchedulerRunId: runId, v3FencingToken: trackedV3FencingToken }
          : {}),
        generation: durableClaim.generation,
        ownershipState: "running",
      };
      claimActiveRun(agent.id, activeRun);
      agentMessageCapabilities.set(messageCapability, {
        agentId: agent.id,
        conversationId: routingConversationId,
        runId,
        v3SchedulerRunId: runId,
        v3FencingToken: trackedV3FencingToken!,
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
        let v3PromptInjected = false;
        try {
          const environment = {
            PONDEROSA_AGENT_MESSAGE_URL: agentMessageUrl,
            PONDEROSA_DOCUMENT_URL: agentMessageUrl.replace(/\/api\/agent-messages$/, "/api/agent-documents"),
            PONDEROSA_AGENT_DIRECTORY_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-directory`,
            PONDEROSA_AGENT_COORDINATE_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-coordinate`,
            PONDEROSA_AGENT_UPDATE_REQUEST_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-request-updates`,
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
              dynamicTools: [PONDEROSA_COORDINATE_TOOL, PONDEROSA_UPDATE_REQUEST_TOOL, PONDEROSA_MESSAGE_TOOL],
              handleDynamicToolCall: async (call) => {
                const url = call.name === PONDEROSA_COORDINATE_TOOL.name
                  ? "/api/agent-coordinate"
                  : call.name === PONDEROSA_UPDATE_REQUEST_TOOL.name
                    ? "/api/agent-request-updates"
                    : call.name === PONDEROSA_MESSAGE_TOOL.name
                      ? "/api/agent-messages"
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
                        kind: "collaboration",
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
                        kind: "collaboration",
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
          while (true) {
            const bufferedSessionEvents: AgentEvent[] = [];
            let retryFresh = false;
            if (activeRun.v3SchedulerRunId && activeRun.v3FencingToken !== undefined && !v3PromptInjected) {
              coordinationV3!.markPromptSubmitted({
                injectionId: v3InjectionId!,
                runId: activeRun.v3SchedulerRunId,
                fencingToken: activeRun.v3FencingToken,
                providerSessionId: sessionId ?? persistentRuntime?.session.engineAgentId,
              });
            }
            for await (const event of startStream(sessionId)) {
              if (activeRun.v3SchedulerRunId && activeRun.v3FencingToken !== undefined && !v3PromptInjected && event.type !== "error") {
                coordinationV3!.acknowledgePromptInjection({
                  injectionId: v3InjectionId!,
                  runId: activeRun.v3SchedulerRunId,
                  fencingToken: activeRun.v3FencingToken,
                  providerSessionId: sessionId ?? persistentRuntime?.session.engineAgentId,
                });
                v3PromptInjected = true;
              }
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
              for (const buffered of bufferedSessionEvents.splice(0)) {
                persistRuntimeEvent(agent.id, activeRun, buffered);
              }
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
          if (activeRun.v3SchedulerRunId && !v3PromptInjected && !runError) {
            runError = "provider ended before prompt injection could be confirmed";
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
          if (released && activeRun.v3SchedulerRunId && activeRun.v3FencingToken !== undefined) {
            try {
              if (controller.signal.aborted) coordinationV3!.cancelAgentRun({
                agentId: agent.id,
                idempotencyKey: `runtime-abort:${activeRun.v3SchedulerRunId}`,
              });
              else if (runError) coordinationV3!.failRun({
                runId: activeRun.v3SchedulerRunId,
                fencingToken: activeRun.v3FencingToken,
                workerId: coordinationV3WorkerId,
                sameRunResumable: false,
              });
              else coordinationV3!.completeRun(activeRun.v3SchedulerRunId, activeRun.v3FencingToken);
            } catch (error) {
              app.log.error({ err: error, runId }, "Communication V3 terminal transition failed");
            }
            coordinationV3Scheduler?.notify();
            publishCoordinationV3Changed(agent.id);
          }
          if (released) {
            agentMessageCapabilities.delete(messageCapability);
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
          if (released) coordinationV3Scheduler.notify();
        }
      })();

      return { queued: false, runId, mode, communicationEventId };
    },
  );

  app.get("/api/workspace/preferences", async () => workspace.getPreferences());

  app.patch<{ Body: UpdateWorkspacePreferencesRequest }>("/api/workspace/preferences", async (request, reply) => {
    const patch = request.body ?? {};
    if (patch.projectSort && !["last_used", "alphabetical", "custom"].includes(patch.projectSort)) return reply.code(400).send({ error: "invalid project sort" });
    if (patch.projectOrder && (patch.projectOrder.length > 10_000 || patch.projectOrder.some((id) => typeof id !== "string" || id.length > 200) || new Set(patch.projectOrder).size !== patch.projectOrder.length)) {
      return reply.code(400).send({ error: "invalid custom project order" });
    }
    if (patch.notifications !== undefined && (typeof patch.notifications !== "object" || patch.notifications === null || Object.entries(patch.notifications).some(([key, value]) => !["mentions", "directReplies", "projectChatMessages", "broadcasts", "allMessages"].includes(key) || typeof value !== "boolean"))) return reply.code(400).send({ error: "notification preferences must be independent toggles" });
    const cursor = workspace.cursor();
    const preferences = workspace.updatePreferences(patch);
    publishWorkspaceSince(cursor);
    return preferences;
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id/draft", async (request, reply) => {
    if (!validDraftId(request.params.id)) return reply.code(404).send({ error: "draft surface not found" });
    return hydrateDraft(request.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id/draft-conflicts", async (request, reply) => {
    if (!validDraftId(request.params.id)) return reply.code(404).send({ error: "draft surface not found" });
    return workspace.listDraftConflicts(request.params.id);
  });

  app.put<{ Params: { id: string }; Body: PutConversationDraftRequest }>("/api/conversations/:id/draft", async (request, reply) => {
    if (!validDraftId(request.params.id)) return reply.code(404).send({ error: "draft surface not found" });
    if (!request.body?.clientId || !Number.isSafeInteger(request.body.expectedRevision) || !Array.isArray(request.body.attachmentIds)) return reply.code(400).send({ error: "invalid draft update" });
    if (request.body.attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE || new Set(request.body.attachmentIds).size !== request.body.attachmentIds.length) return reply.code(400).send({ error: "at most 4 unique draft attachments are allowed" });
    const referenced = await Promise.all(request.body.attachmentIds.map((id) => readDraftAttachment(request.params.id, id)));
    if (referenced.some((item) => !item)) return reply.code(400).send({ error: "draft attachment is missing or belongs to another conversation" });
    const cursor = workspace.cursor();
    try {
      workspace.putDraft(request.params.id, request.body);
      publishWorkspaceSince(cursor);
      return hydrateDraft(request.params.id);
    } catch (error) {
      if ((error as { code?: string }).code === "DRAFT_CONFLICT") {
        return reply.code(409).send({
          current: await hydrateDraft(request.params.id),
          displaced: (error as { displaced: unknown }).displaced,
        });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string }; Body: Buffer }>("/api/conversations/:id/draft-attachments", async (request, reply) => {
    if (!validDraftId(request.params.id)) return reply.code(404).send({ error: "draft surface not found" });
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) return reply.code(400).send({ error: "attachment body is required" });
    if (request.body.length > ASSET_LIMITS.maxFileBytes) return reply.code(413).send({ error: "draft attachment exceeds 8 MiB" });
    const mediaType = String(request.headers["x-ponderosa-media-type"] ?? "").toLowerCase();
    if (!draftAttachmentTypes.has(mediaType)) return reply.code(415).send({ error: "unsupported draft attachment type" });
    const suppliedName = String(request.headers["x-ponderosa-filename"] ?? "attachment").replace(/[\u0000-\u001f\u007f]/g, "");
    const name = path.basename(suppliedName).slice(0, 240) || "attachment";
    const id = randomUUID();
    const directory = draftAttachmentDir(request.params.id);
    const files = draftAttachmentFiles(request.params.id, id);
    const createdAt = new Date().toISOString();
    const metadata: Omit<DraftAttachmentDto, "downloadUrl"> = { id, conversationId: request.params.id, name, mediaType, size: request.body.length, createdAt };
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = `${files.body}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, request.body, { mode: 0o600, flag: "wx" });
      await fs.rename(temp, files.body);
      await fs.writeFile(files.metadata, JSON.stringify(metadata), { mode: 0o600, flag: "wx" });
    } catch (error) {
      await Promise.allSettled([fs.rm(temp, { force: true }), fs.rm(files.body, { force: true }), fs.rm(files.metadata, { force: true })]);
      throw error;
    }
    return reply.code(201).send({ ...metadata, downloadUrl: `/api/conversations/${encodeURIComponent(request.params.id)}/draft-attachments/${encodeURIComponent(id)}` });
  });

  app.get<{ Params: { id: string; attachmentId: string } }>("/api/conversations/:id/draft-attachments/:attachmentId", async (request, reply) => {
    if (!validDraftId(request.params.id)) return reply.code(404).send({ error: "draft attachment not found" });
    const attachment = await readDraftAttachment(request.params.id, request.params.attachmentId);
    if (!attachment) return reply.code(404).send({ error: "draft attachment not found" });
    const body = await fs.readFile(draftAttachmentFiles(request.params.id, attachment.id).body);
    return reply.header("content-type", "application/octet-stream")
      .header("content-disposition", contentDisposition(attachment.name))
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .send(body);
  });

  app.delete<{ Params: { id: string; attachmentId: string } }>("/api/conversations/:id/draft-attachments/:attachmentId", async (request, reply) => {
    if (!validDraftId(request.params.id) || !await readDraftAttachment(request.params.id, request.params.attachmentId)) return reply.code(404).send({ error: "draft attachment not found" });
    const files = draftAttachmentFiles(request.params.id, request.params.attachmentId);
    await Promise.all([fs.rm(files.body, { force: true }), fs.rm(files.metadata, { force: true })]);
    return reply.code(204).send();
  });

  app.get("/api/notifications", async () => workspace.listNotifications());
  app.post<{ Params: { id: string } }>("/api/conversations/:id/notifications/read", async (request, reply) => {
    if (!store.getConversation(request.params.id)) return reply.code(404).send({ error: "conversation not found" });
    const cursor = workspace.cursor();
    workspace.readConversation(request.params.id);
    publishWorkspaceSince(cursor);
    return { read: true };
  });

  app.get("/api/push/status", async () => ({
    configured: webPushConfigured,
    ...(webPushConfigured ? { publicKey: vapid.publicKey } : {}),
  }));

  app.put<{ Params: { deviceId: string }; Body: WebPushSubscriptionDto }>("/api/push/subscriptions/:deviceId", async (request, reply) => {
    const deviceId = request.params.deviceId.trim();
    const subscription = request.body;
    if (!webPushConfigured) return reply.code(503).send({ error: "web push is not configured on this host" });
    if (!deviceId || deviceId.length > 200 || subscription?.deviceId !== deviceId) {
      return reply.code(400).send({ error: "device identity is invalid" });
    }
    let endpoint: URL;
    try {
      endpoint = new URL(subscription.endpoint);
    } catch {
      return reply.code(400).send({ error: "push endpoint is invalid" });
    }
    if (endpoint.protocol !== "https:" || !subscription.keys?.p256dh || !subscription.keys?.auth) {
      return reply.code(400).send({ error: "a secure push endpoint and encryption keys are required" });
    }
    const cursor = workspace.cursor();
    workspace.putPushSubscription({
      deviceId,
      endpoint: endpoint.toString(),
      expirationTime: subscription.expirationTime ?? null,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
    });
    publishWorkspaceSince(cursor);
    return reply.code(204).send();
  });

  app.delete<{ Params: { deviceId: string } }>("/api/push/subscriptions/:deviceId", async (request, reply) => {
    const cursor = workspace.cursor();
    workspace.deletePushSubscription(request.params.deviceId);
    publishWorkspaceSince(cursor);
    return reply.code(204).send();
  });

  app.get<{ Querystring: { lastEventId?: string } }>("/api/workspace/stream", async (request, reply) => {
    if (workspaceSubscribers.size >= MAX_SSE_SUBSCRIBERS_PER_STREAM) {
      return reply.code(429).send({ error: "too many stream subscribers" });
    }
    const lastEventId = request.headers["last-event-id"] ?? request.query.lastEventId ?? "0";
    const parsed = Number(Array.isArray(lastEventId) ? lastEventId[0] : lastEventId);
    const requestedCursor = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    const highWaterMark = workspace.cursor();
    const reset = requestedCursor > highWaterMark;
    const replayFrom = reset ? 0 : requestedCursor;
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    writeSse(reply.raw, "workspace_status", undefined, {
      instanceId: workspace.instanceId(),
      cursor: highWaterMark,
      reset,
    } satisfies import("@ponderosa/core").WorkspaceStreamStatusDto);
    writeSse(reply.raw, "heartbeat", undefined, { ts: new Date().toISOString() });
    let cursor = replayFrom;
    let replaying = true;
    const queued: WorkspaceEventEnvelope[] = [];
    const writeEvent = (event: WorkspaceEventEnvelope, replayed = false) => {
      if (event.id <= cursor) return;
      cursor = event.id;
      writeSse(reply.raw, "message", event.id, replayed ? { ...event, replayed: true } : event);
    };
    const subscriber = (event: WorkspaceEventEnvelope) => replaying ? queued.push(event) : writeEvent(event);
    workspaceSubscribers.add(subscriber);
    for (const event of workspace.readSince(replayFrom)) writeEvent(event, true);
    replaying = false;
    for (const event of queued) writeEvent(event);
    const heartbeat = setInterval(() => writeSse(reply.raw, "heartbeat", undefined, { ts: new Date().toISOString() }), 15_000);
    request.raw.on("close", () => { clearInterval(heartbeat); workspaceSubscribers.delete(subscriber); });
  });

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

  app.post<{ Params: { id: string }; Body?: CancelAgentRunRequest }>("/api/agents/:id/cancel", async (request, reply) => {
    const idempotencyKey = request.body?.idempotencyKey?.trim();
    const stopResponse = (cancelled: boolean, replayed: boolean): CancelAgentRunResponse | { cancelled: boolean } =>
      idempotencyKey ? { cancelled, replayed } : { cancelled };
    if (idempotencyKey && idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 200 characters or fewer" });
    const current = activeRuns.get(request.params.id);
    const result = coordinationV3.cancelAgentRun({
      agentId: request.params.id,
      idempotencyKey: idempotencyKey ?? `run:${current?.runId ?? "idle"}`,
    });
    if (result.cancelled && !result.replayed && store.getAgent(request.params.id)) {
      const lifecycle = store.appendEvent(request.params.id, {
        type: "agent_lifecycle", status: "cancelled", reason: "agent_cancelled",
        executionId: result.runId ?? current?.runId ?? "cancelled",
      });
      publish(request.params.id, lifecycle);
    }
    coordinationV3Scheduler.notify();
    publishCoordinationV3Changed(request.params.id);
    return stopResponse(result.cancelled, result.replayed);
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
