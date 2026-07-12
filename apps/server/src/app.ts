import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { constants as fsConstants, existsSync, promises as fs } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type {
  Adapter,
  AgentDelegationRequest,
  AgentDelegationDispositionRequest,
  AgentMessageChannel,
  AgentEvent,
  CommunicationEvent,
  AgentHealthProjectionDto,
  ArtifactContentDto,
  ChatMessage,
  EngineAuthStatus,
  EngineDto,
  FilesResponse,
  HealthDto,
  ReadinessDto,
  MasterChatMessageDto,
  MasterChatDetailDto,
  CollaborationChatDetailDto,
  AssetDto,
  ImageAttachmentDto,
  CreateDirectReplyRequest,
  DirectReplyResponse,
  SseEventEnvelope,
  SendAgentMessageRequest,
  SubagentRunDto,
  ThreadDto,
  MessageReferenceDto,
  ReactionActor,
  SetMessageReactionRequest,
  SetMessageReactionResponse,
} from "@ponderosa/core";
import { artifactContentPath, attachmentPath, attachmentsDir, type LogEvent, type MasterChatDeliveryIntent, type StoredLogEvent, ThreadStore } from "@ponderosa/threads";
import { shouldRolloverEngineSession } from "@ponderosa/engines";
import { DelegationError, DelegationStore } from "./delegations.js";
import { ASSET_LIMITS, AssetError, AssetStore, contentDisposition } from "./assets.js";
import { ContextCursorStore } from "./context-cursors.js";
import { EngineAuthStatusCache } from "./engine-auth-cache.js";
import { projectAgentHealth } from "./agent-health.js";
import {
  CollaborationDeliveryStore,
  type CollaborationDelivery,
  type CollaborationDeliveryBatch,
} from "./handoffs.js";

export interface EngineRegistration {
  adapter: Adapter;
  authStatus?: () => Promise<EngineAuthStatus>;
}

export interface CreateServerOptions {
  dataDir: string;
  store?: ThreadStore;
  engines: EngineRegistration[];
  webDist?: string;
  authToken?: string;
  /** Host-local origin injected into runtime tools; agents run on this server host. */
  agentBaseUrl?: string;
  logger?: boolean;
  /** Emergency rollback: `off` preserves legacy logs/projections only. */
  communicationMode?: "off" | "shadow";
  communicationReadMode?: "legacy" | "shadow" | "authoritative";
  legacyRoutingMode?: "accept" | "reject";
  /** Independent context-plane rollback switch. */
  curatedContextEnabled?: boolean;
}

interface ActiveRun {
  runId: string;
  startedAt: string;
  executionId: string;
  leaseExpiresAt: string;
  controller: AbortController;
  messageCapability: string;
  delegatedRunId?: string;
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
  if (event.intent === "collaboration") return event.audience.agentIds.includes(recipientAgentId);
  return event.intent === "broadcast" && event.audience.organizationId === projectId;
}

function recipientCollaborationMessages(
  messages: MasterChatMessageDto[],
  events: CommunicationEvent[],
  projectId: string,
  recipientAgentId: string,
): MasterChatMessageDto[] {
  const eventsById = new Map(events.map((event) => [event.eventId, event]));
  return messages.filter((message) => {
    if (!message.communicationEventId) return false;
    return canonicalAudienceIncludes(eventsById.get(message.communicationEventId), projectId, recipientAgentId);
  });
}

/** A deferred user or agent turn.  Queues are per-thread and FIFO. */
interface PendingTurn {
  text: string;
  communicationEventId?: string;
  model?: string;
  effort?: string;
  agentMentionDepth: number;
  agentMentionTrail: string[];
  collaborationMasterChatId?: string;
  sourceChannel?: "main";
  sourceAuthorThreadId?: string;
  /** Set only by the server's persisted collaboration delivery dispatcher. */
  collaborationDeliveryId?: string;
  /** Fixed snapshot; deliveries queued after dispatch begins are excluded. */
  collaborationDeliveryIds?: string[];
  replyTo?: MessageReferenceDto;
  replyToMessageId?: string;
  attachmentIds?: string[];
}

interface AgentMessageCapability {
  threadId: string;
  masterChatId?: string;
  runId: string;
  mentionDepth: number;
  mentionTrail: string[];
}

interface DelegationCapability {
  parentRunId: string;
  threadId: string;
  masterChatId: string;
  controller: AbortController;
}

interface InboundMessageContext {
  channel: AgentMessageChannel;
  author: string;
  mentionedAgents: string[];
  addressedToCurrentAgent: boolean;
}

type Subscriber = (stored: StoredLogEvent) => void;

const MAX_AGENT_MENTION_RELAYS = 12;
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

function isAgentEvent(event: StoredLogEvent["event"]): event is AgentEvent {
  return event.type !== "user_message";
}

/**
 * The agent's final human-facing message for a turn, trimmed and length-capped for
 * the group chat. Keeps the tail (final answer / PR link usually ends the message).
 * Returns undefined when the turn produced no text (e.g. pure tool work).
 */
function summarizeFinalMessage(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const cap = 4000;
  return trimmed.length <= cap ? trimmed : `…${trimmed.slice(-cap)}`;
}

function agentMentionHandle(title: string): string {
  return title
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "");
}

function mentionRelayFingerprint(authorThreadId: string, targetThreadId: string, text: string): string {
  return createHash("sha256")
    .update(authorThreadId)
    .update("\0")
    .update(targetThreadId)
    .update("\0")
    .update(text.trim().replace(/\s+/g, " ").toLocaleLowerCase())
    .digest("hex");
}

function mentionedAgentThreads(text: string, threads: ThreadDto[], authorThreadId: string): ThreadDto[] {
  const byHandle = new Map(
    threads.map((thread) => [agentMentionHandle(thread.title).toLocaleLowerCase(), thread]),
  );
  const mentioned = new Map<string, ThreadDto>();
  for (const match of text.matchAll(/(?:^|\s)@([\p{L}\p{N}_-]+)/gu)) {
    const thread = byHandle.get(match[1]!.toLocaleLowerCase());
    if (thread && thread.id !== authorThreadId) mentioned.set(thread.id, thread);
  }
  return [...mentioned.values()];
}

function hasEveryoneMention(text: string): boolean {
  return /(?:^|\s)@everyone(?=$|\s|[.,!?;:])/iu.test(text);
}

function inboundContext(
  channel: AgentMessageChannel,
  author: string,
  text: string,
  threads: ThreadDto[],
  currentThreadId: string,
): InboundMessageContext {
  const mentioned = mentionedAgentThreads(text, threads, "");
  return {
    channel,
    author,
    mentionedAgents: mentioned.map((thread) => `@${agentMentionHandle(thread.title)}`),
    addressedToCurrentAgent: mentioned.some((thread) => thread.id === currentThreadId),
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

function organizationalKnowledgePrompt(promotions: import("@ponderosa/core").KnowledgePromotion[]): string {
  if (promotions.length === 0) return "";
  return [
    "Curated organizational knowledge (operator-promoted; summaries retain canonical provenance):",
    ...promotions.map((promotion) => `- [source ${promotion.sourceEventId}] ${promotion.summary}`),
    "",
  ].join("\n");
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

function agentMessagingPrompt(): string[] {
  return [
    "You can send an additional message to any Ponderosa channel with your shell tool:",
    'curl -sS -X POST "$PONDEROSA_AGENT_MESSAGE_URL" -H "Authorization: Bearer $PONDEROSA_AGENT_MESSAGE_TOKEN" -H "Content-Type: application/json" --data \'{"intent":"collaboration","recipientAgentIds":["stable-agent-id"],"text":"Please review this","idempotencyKey":"stable-retry-key"}\'',
    'Set intent to "broadcast", "direct_to_user", or "collaboration". The server owns routing and renders recipient names; never write routing @mentions into message text.',
    "Collaboration requires a non-empty recipientAgentIds array containing stable IDs from the visible-agent metadata.",
    "Use collaboration for teammate coordination, broadcast for durable shared organizational knowledge, and direct_to_user for notes in your own agent audit chat.",
    "A valid collaboration intent is persisted and queued as a separate follow-up turn when the recipient is active; it is never injected into an in-flight response.",
    "After delegating work, end your turn. Do not poll, sleep, or remain active waiting for results. Delegated agents run asynchronously; their completion automatically queues a parent follow-up, and explicit collaboration tags do the same.",
    "Each collaboration intent is a separate FIFO delivery (not coalesced). If one arrives while you are active, it waits for a safe turn boundary. If that active turn is cancelled, queued deliveries remain queued; a cancelled delivery turn itself is retried.",
    "Track expected work in delegated-agent status/lineage: queued/running/awaiting_disposition/completed/blocked/failed/cancelled plus terminal-delivery state. A child does not need to tag you for its declared terminal result; it should tag you only for interim findings or questions.",
    "Accumulate results across those notification turns and update the manager once every expected task has reported.",
    'If your runtime context is becoming unwieldy, request a fresh session after this turn with: curl -sS -X POST "$PONDEROSA_AGENT_ROLLOVER_URL" -H "Authorization: Bearer $PONDEROSA_AGENT_MESSAGE_TOKEN"',
  ];
}

function agentDelegationPrompt(): string[] {
  return [
    "When delegating work under Ponderosa, never use an engine's internal spawn_agent, Task, or subagent mechanism; those children are untracked and forbidden.",
    "Use only Ponderosa's delegation bridge:",
    'curl -sS -X POST "$PONDEROSA_DELEGATION_URL" -H "Authorization: Bearer $PONDEROSA_DELEGATION_TOKEN" -H "Content-Type: application/json" --data \'{"displayLabel":"Safe short summary","delegationPrompt":"Full private task","runtime":"codex","idempotencyKey":"stable-key"}\'',
    "Do not send parentRunId, threadId, masterChatId, rootRunId, or registration credentials. Ponderosa binds ownership and launches the child server-side.",
    "If delegation fails, report the error; never fall back to an internal spawning tool.",
  ];
}

function delegatedOutcomePrompt(): string[] {
  return [
    "Before ending a delegated objective, declare its truthful outcome directly (this replaces any extra summarization/model call):",
    'curl -sS -X POST "$PONDEROSA_DELEGATION_OUTCOME_URL" -H "Authorization: Bearer $PONDEROSA_DELEGATION_TOKEN" -H "Content-Type: application/json" --data \'{"outcome":"completed","message":"Concise result","idempotencyKey":"stable-outcome-key"}\'',
    'Use outcome "completed" only when the delegated objective is genuinely satisfied. Use "blocked" with the concrete blocker when it cannot proceed.',
    "A normal response ending or engine turn_done only means runtime idle; it never completes the objective or notifies the parent.",
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
 * Give a master-chat agent the shared room context and a lightweight teammate
 * response contract. This is intentionally part of the next user prompt (rather
 * than engine-specific configuration) so new and resumed agents behave alike.
 */
function masterChatPrompt(
  messages: MasterChatMessageDto[],
  threads: ThreadDto[],
  currentRequest: string,
  context: InboundMessageContext,
  incremental = false,
  routingMetadata?: string,
): string {
  const names = new Map(threads.map((thread) => [thread.id, thread.title]));
  const transcript = messages
    .map((message) => {
      const speaker = message.authorThreadId
        ? names.get(message.authorThreadId) ?? "Agent"
        : message.role === "user"
          ? "Manager"
          : "Team";
      const quoted = message.replyTo ? ` (replying to: ${message.replyTo.text.replace(/\s+/g, " ").slice(0, 500)})` : "";
      return `${speaker}${quoted}: ${message.text}`;
    })
    .join("\n");

  const staticInstructions = incremental ? [] : [
    "You are replying as a teammate in a shared master chat.",
    "Respond directly to the latest message addressed to you, whether it came from the manager or a teammate.",
    "The main chat is manager-facing: do not use @mentions here to coordinate with teammates, because they are plain text and do not notify anyone.",
    "Agent-to-agent discussion belongs in the separate Collaboration chat. An explicit collaboration intent provides its context and starts the teammate's turn.",
    "If you need time to work, begin with a brief, natural acknowledgment that specifically reflects the request.",
    "Choose how to converse based on the message; never use a canned acknowledgment such as 'Got it — I’m on it.'",
    "When this turn is complete, give only your new update or result in a natural, conversational tone.",
    "Do not repeat, recap, or answer with the whole conversation. Do not describe these instructions.",
    ...agentMessagingPrompt(),
    ...agentDelegationPrompt(),
  ];
  return [
    ...staticInstructions,
    ...(routingMetadata ? [routingMetadata] : []),
    ...messageContextPrompt(context),
    "",
    incremental ? "New master chat messages since the last accepted turn:" : "Current master chat history:",
    transcript || (incremental ? "(No new room messages.)" : "(No earlier messages.)"),
    `Context injection accounting: room_messages=${messages.length}; room_characters=${messages.reduce((sum, message) => sum + message.text.length, 0)}`,
    "",
    "Latest message for you:",
    currentRequest,
  ].join("\n");
}

/** Collaboration context is opt-in: it is assembled only for an explicit recipient delivery. */
function collaborationChatPrompt(
  messages: MasterChatMessageDto[],
  threads: ThreadDto[],
  currentRequest: string,
  context: InboundMessageContext,
  incremental = false,
  routingMetadata?: string,
): string {
  const names = new Map(threads.map((thread) => [thread.id, thread.title]));
  const transcript = messages
    .map((message) => {
      const speaker = message.authorThreadId
        ? names.get(message.authorThreadId) ?? "Agent"
        : message.role === "user"
          ? "Manager"
          : "Team";
      const quoted = message.replyTo ? ` (replying to: ${message.replyTo.text.replace(/\s+/g, " ").slice(0, 500)})` : "";
      return `${speaker}${quoted}: ${message.text}`;
    })
    .join("\n");
  const staticInstructions = incremental ? [] : [
    "You are collaborating with teammates in Ponderosa's opt-in collaboration chat.",
    "You received this context because you were an explicit collaboration recipient.",
    "This is the only chat for agent-to-agent coordination. Respond directly to the latest request here.",
    "To involve a teammate, send a collaboration intent with their stable agent ID; the server routes it and renders any display handle.",
    "Do not move collaboration discussion to the main chat; reserve it for manager-facing updates and results.",
    "Do not claim to have seen the main chat.",
    ...agentMessagingPrompt(),
    ...agentDelegationPrompt(),
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
    "Latest message for you:",
    currentRequest,
  ].join("\n");
}

function individualChatPrompt(currentRequest: string, context: InboundMessageContext): string {
  return [
    "You are replying in your individual Ponderosa agent chat.",
    ...messageContextPrompt(context),
    ...agentMessagingPrompt(),
    ...agentDelegationPrompt(),
    "",
    "Latest message for you:",
    currentRequest,
  ].join("\n");
}

/** Minimal turn prompt for a session that already received the full protocol. */
function continuationPrompt(currentRequest: string, context: InboundMessageContext): string {
  const channelRule = context.channel === "collaboration"
    ? "Reply in Collaboration; use a full @handle only when another agent must act."
    : context.channel === "main"
      ? "Reply with only the new manager-facing update or result."
      : "Reply in your individual agent chat.";
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

function envelope(threadId: string, stored: StoredLogEvent): SseEventEnvelope | undefined {
  if (!isAgentEvent(stored.event)) return undefined;
  return { threadId, seq: stored.seq, ts: stored.ts, event: stored.event };
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

async function readScopedPath(root: string, relInput: string | undefined): Promise<FilesResponse> {
  const rel = safeRelativePath(relInput);
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
        .filter((entry) => entry.isDirectory() || entry.isFile())
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

export function createServer(opts: CreateServerOptions): FastifyInstance {
  const store = opts.store ?? new ThreadStore(opts.dataDir);
  store.recoverInterruptedExecutions();
  const assets = new AssetStore(opts.dataDir);
  const engines = new Map(opts.engines.map((engine) => [engine.adapter.id, engine]));
  const activeRuns = new Map<string, ActiveRun>();
  const delegations = new DelegationStore(opts.dataDir);
  const collaborationDeliveries = new CollaborationDeliveryStore(opts.dataDir);
  const engineAuthStatuses = new EngineAuthStatusCache();
  const contextCursors = new ContextCursorStore(opts.dataDir);
  const agentMessageCapabilities = new Map<string, AgentMessageCapability>();
  // An agent can request rollover while its capability is live. The reset is
  // applied only after the turn ends, so it never destroys an in-flight session.
  const scheduledSessionRollovers = new Map<string, string>();
  const delegationCapabilities = new Map<string, DelegationCapability>();
  const dispatchingTurns = new Set<string>();
  // Capability used only by this server's queue dispatcher. It prevents a client
  // from attaching arbitrary collaboration history to a direct thread request.
  const collaborationDispatchKey = randomUUID();
  // Prevent an internal dequeue from being appended to the tail if another
  // request claims the thread in the tiny dispatch race window.
  const turnDispatchKey = randomUUID();
  const subscribers = new Map<string, Set<Subscriber>>();
  const directReplyClaims = new Set<string>();
  let closed = false;
  let assetSweep: NodeJS.Timeout | undefined;
  const communicationMode = opts.communicationMode ?? "shadow";
  const communicationReadMode = opts.communicationReadMode ?? "shadow";
  // Embedders can opt into the compatibility window; the production config
  // defaults to reject so newly deployed agents never depend on routing syntax.
  const legacyRoutingMode = opts.legacyRoutingMode ?? "accept";
  const curatedContextEnabled = opts.curatedContextEnabled ?? true;
  const recordCommunication = (event: CommunicationEvent): CommunicationEvent | undefined =>
    communicationMode === "off" ? undefined : store.appendCommunicationEvent(event).event;
  const executionLeaseMs = 6 * 60 * 1000;
  const leaseExpiry = () => new Date(Date.now() + executionLeaseMs).toISOString();
  const renewExecutionLease = (threadId: string) => {
    const active = activeRuns.get(threadId);
    if (active) active.leaseExpiresAt = leaseExpiry();
  };

  function masterChatDetail(masterChatId: string): MasterChatDetailDto | undefined {
    const detail = store.getMasterChatDetail(masterChatId);
    if (!detail || communicationReadMode !== "authoritative") return detail;
    return { ...detail, messages: store.getProjectedMasterChatMessages(masterChatId, "main") };
  }

  function collaborationChatDetail(masterChatId: string): CollaborationChatDetailDto | undefined {
    const detail = store.getCollaborationChatDetail(masterChatId);
    if (!detail || communicationReadMode !== "authoritative") return detail;
    return { ...detail, messages: store.getProjectedMasterChatMessages(masterChatId, "collaboration") };
  }

  function threadDetail(threadId: string): import("@ponderosa/core").ThreadDetailDto | undefined {
    const detail = store.getThreadDetail(threadId);
    if (!detail || communicationReadMode !== "authoritative") return detail;
    return { ...detail, messages: store.getProjectedThreadMessages(threadId) };
  }

  const threadMessages = (threadId: string) => communicationReadMode === "authoritative"
    ? store.getProjectedThreadMessages(threadId)
    : store.getMessages(threadId);

  function agentHealth(scope: AgentHealthProjectionDto["scope"], threads: ThreadDto[], scopedDelegations: SubagentRunDto[]): AgentHealthProjectionDto {
    return projectAgentHealth({
      scope,
      threads,
      delegations: scopedDelegations,
      activeRuns,
      compactingAgents: scheduledSessionRollovers,
      queuedDeliveries: (threadId) => collaborationDeliveries.pending(threadId),
      events: (threadId) => store.readEvents(threadId),
    });
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

  function delegationFailure(error: unknown, reply: FastifyReply) {
    if (error instanceof DelegationError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, retryable: error.retryable },
      });
    }
    throw error;
  }

  function pendingTurnFromDelivery(delivery: CollaborationDelivery): PendingTurn {
    return {
      text: delivery.text,
      communicationEventId: delivery.communicationEventId,
      model: delivery.model,
      effort: delivery.effort,
      agentMentionDepth: delivery.relayDepth,
      agentMentionTrail: delivery.mentionTrail,
      collaborationMasterChatId: delivery.kind === "direct" ? undefined : delivery.masterChatId,
      sourceChannel: delivery.sourceChannel,
      sourceAuthorThreadId: delivery.authorThreadId,
      collaborationDeliveryId: delivery.id,
      replyToMessageId: delivery.replyToMessageId,
      attachmentIds: delivery.attachmentIds,
    };
  }

  function canShareCollaborationBatch(first: CollaborationDelivery, candidate: CollaborationDelivery): boolean {
    return first.kind !== "direct" && candidate.kind !== "direct";
  }

  function formatDeliveryBatch(batch: CollaborationDeliveryBatch): string {
    const entries = batch.deliveries.map((delivery, index) => {
      const authorThread = delivery.authorThreadId ? store.getThread(delivery.authorThreadId) : undefined;
      const author = authorThread
        ? `${authorThread.title} (@${agentMentionHandle(authorThread.title)}, thread ${authorThread.id})`
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
    return {
      ...pendingTurnFromDelivery(first),
      text: formatDeliveryBatch({ deliveries }),
      communicationEventId: undefined,
      sourceAuthorThreadId: undefined,
      collaborationDeliveryId: undefined,
      collaborationDeliveryIds: deliveries.map((delivery) => delivery.id),
    };
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
      const target = store.getThread(queued.delivery.targetThreadId);
      if (target) {
        store.appendCommunicationProjection(target.projectId, {
          eventId: queued.delivery.communicationEventId,
          surface: "agent_inbox",
          projectionKey: target.id,
          projectedAt: queued.delivery.createdAt,
        });
      }
    }
    void dispatchNextTurn(queued.delivery.targetThreadId);
    return queued.delivery;
  }

  async function dispatchNextTurn(threadId: string): Promise<void> {
    if (closed) return;
    if (activeRuns.has(threadId)) return;
    if (dispatchingTurns.has(threadId)) return;
    dispatchingTurns.add(threadId);
    try {
    const pending = collaborationDeliveries.pending(threadId);
    const delivery = pending[0];
    if (!delivery) return;
    // Direct follow-ups retain their exact existing behavior and remain FIFO
    // barriers. Every consecutive collaboration delivery for this recipient is
    // one fixed snapshot, regardless of author or relay metadata.
    const boundary = pending.findIndex((item) => !canShareCollaborationBatch(delivery, item));
    const batch = delivery.kind === "direct"
      ? [delivery]
      : pending.slice(0, boundary < 0 ? pending.length : boundary);
    const next = batch.length > 1 ? pendingTurnFromBatch(batch) : pendingTurnFromDelivery(delivery);
    const deliveryIds = batch.map((item) => item.id);

    collaborationDeliveries.markBatchDelivered(deliveryIds);
    for (const id of deliveryIds) syncDelegatedCompletion(id);
    const response = await app.inject({
      method: "POST",
      url: `/api/threads/${threadId}/messages`,
      headers: {
        ...(opts.authToken ? { authorization: `Bearer ${opts.authToken}` } : {}),
        ...(deliveryIds.length
          ? { "x-ponderosa-collaboration-dispatch": collaborationDispatchKey }
          : {}),
        "x-ponderosa-turn-dispatch": turnDispatchKey,
      },
      payload: next,
    });
    // `app.close()` may have run while the internal injection was in flight.
    // Never mutate a delivery ledger after shutdown has revoked its data dir.
    if (closed) return;
    // Another request may have claimed the agent between our check and the
    // injected request. Put this turn back at the head without changing order.
    if (response.statusCode === 409) {
      collaborationDeliveries.requeueBatch(deliveryIds);
      for (const id of deliveryIds) syncDelegatedCompletion(id);
    } else if (response.statusCode === 429 || response.statusCode >= 500) {
      collaborationDeliveries.requeueBatch(deliveryIds);
      for (const id of deliveryIds) syncDelegatedCompletion(id);
      setTimeout(() => void dispatchNextTurn(threadId), 250).unref?.();
    } else if (response.statusCode >= 300) {
      collaborationDeliveries.failBatch(deliveryIds, `delivery dispatch rejected (${response.statusCode})`);
      for (const id of deliveryIds) syncDelegatedCompletion(id);
      const delivery = collaborationDeliveries.get(deliveryIds[0]!);
      const target = delivery ? store.getThread(delivery.targetThreadId) : undefined;
      if (delivery?.masterChatId && target) {
        appendCollaborationSystemNotice(
          delivery.masterChatId,
          `⚠️ @${agentMentionHandle(target.title)} was not notified because their follow-up delivery failed. The handoff remains recorded; retry or contact the manager.`,
          `delivery-failure:${delivery.id}`,
        );
      }
    }
    } finally {
      dispatchingTurns.delete(threadId);
      if (!closed && !activeRuns.has(threadId) && collaborationDeliveries.pendingCount(threadId) > 0) {
        setImmediate(() => void dispatchNextTurn(threadId));
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
    const completionMessages = new Set<string>();
    for (const project of store.listProjects()) {
      for (const master of store.listMasterChats(project.id)) {
        for (const { message, intent, messageReceiptKey, deliveryOrderKey } of store.getMasterChatDeliveryIntents(master.id)) {
          if (message.createdAt < boundary) continue;
          const target = store.getThread(intent.targetThreadId);
          if (!target || target.archived || !target.masterChatIds.includes(master.id)) continue;
          if (messageReceiptKey) collaborationDeliveries.rememberMessageReceipt(messageReceiptKey, message.id);
          const queued = collaborationDeliveries.queue({
            masterChatId: master.id,
            messageId: message.id,
            communicationEventId: message.communicationEventId,
            targetThreadId: intent.targetThreadId,
            authorThreadId: message.authorThreadId,
            text: message.text,
            relayDepth: intent.relayDepth,
            mentionTrail: intent.mentionTrail,
            kind: intent.kind,
            audience: intent.audience,
            delegatedRunId: intent.delegatedRunId,
            createdAt: message.createdAt,
            orderKey: deliveryOrderKey,
            sourceChannel: intent.kind === "direct" ? "main" : undefined,
            attachmentIds: intent.kind === "direct" ? message.attachments?.map((item) => item.id) : undefined,
          });
          recipients.add(intent.targetThreadId);
          if (intent.delegatedRunId) {
            completionMessages.add(intent.delegatedRunId);
            syncDelegatedCompletion(queued.delivery.id);
          }
        }
      }
    }
    for (const run of delegations.all()) {
      if (
        (run.status === "completed" || run.status === "blocked" || run.status === "failed") &&
        !run.completionDelivery &&
        !completionMessages.has(run.id) &&
        run.finishedAt && run.finishedAt >= boundary
      ) {
        notifyParentOfDelegatedCompletion(run);
      }
    }
    return [...recipients];
  }

  app.addHook("onRequest", async (request, reply) => {
    const provided = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if ((request.url === "/api/agent-messages" || request.url === "/api/agent-reactions" || request.url === "/api/agent-delegations" || request.url === "/api/agent-delegation-outcomes" || request.url === "/api/agent-session/rollover") && provided && (agentMessageCapabilities.has(provided) || delegationCapabilities.has(provided))) return;
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
    const recipients = new Set(collaborationDeliveries.recoverUnacknowledged());
    for (const threadId of reconcileCanonicalInbox()) recipients.add(threadId);
    for (const threadId of recipients) {
      setImmediate(() => void dispatchNextTurn(threadId));
    }
    for (const interrupted of delegations.reconcileInterrupted()) {
      notifyParentOfDelegatedCompletion(interrupted);
    }
    const callbackBase = (opts.agentBaseUrl ?? "http://127.0.0.1:8787").replace(/\/$/, "");
    for (const queued of delegations.queued()) {
      setImmediate(() => {
        try {
          launchDelegatedRun(queued.id, `${callbackBase}/api/agent-messages`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          notifyParentOfDelegatedCompletion(delegations.finishRuntime(queued.id, message));
        }
      });
    }
    const reconcileAssets = async () => {
      for (const project of store.listProjects()) {
        for (const thread of store.listThreads(project.id)) {
          const associated = new Set(store.getMessages(thread.id).flatMap((message) => message.attachments?.map((item) => item.id) ?? []));
          await assets.reconcile(project.id, thread.id, associated);
        }
      }
    };
    await reconcileAssets();
    assetSweep = setInterval(() => { if (!closed) void reconcileAssets(); }, 60 * 60 * 1000);
    assetSweep.unref();
  });

  app.addHook("onClose", async () => {
    closed = true;
    if (assetSweep) clearInterval(assetSweep);
    for (const run of activeRuns.values()) run.controller.abort();
    assets.close();
    store.close();
  });

  function publish(threadId: string, stored: StoredLogEvent): void {
    for (const subscriber of subscribers.get(threadId) ?? []) subscriber(stored);
  }

  function subscribe(threadId: string, subscriber: Subscriber): () => void {
    let set = subscribers.get(threadId);
    if (!set) {
      set = new Set();
      subscribers.set(threadId, set);
    }
    set.add(subscriber);
    return () => {
      set?.delete(subscriber);
      if (set?.size === 0) subscribers.delete(threadId);
    };
  }

  function resolveCollaborationIntents(
    masterChatId: string,
    authorThreadId: string,
    text: string,
    relayDepth: number,
    mentionTrail: string[],
  ): { intents: MasterChatDeliveryIntent[]; blocked: Array<{ title: string; reason: string }> } {
    const detail = collaborationChatDetail(masterChatId);
    const eligible = detail?.threads.filter((thread) => !thread.archived && thread.id !== authorThreadId) ?? [];
    const targetsById = new Map(
      mentionedAgentThreads(text, eligible, authorThreadId).map((thread) => [thread.id, thread]),
    );
    if (hasEveryoneMention(text)) {
      for (const thread of eligible) targetsById.set(thread.id, thread);
    }
    const targets = [...targetsById.values()];
    const intents: MasterChatDeliveryIntent[] = [];
    const blocked: Array<{ title: string; reason: string }> = [];
    for (const target of targets) {
      const fingerprint = mentionRelayFingerprint(authorThreadId, target.id, text);
      const blockedReason = authorThreadId && mentionTrail.includes(fingerprint)
        ? "the same handoff already occurred in this collaboration chain"
        : authorThreadId && relayDepth >= MAX_AGENT_MENTION_RELAYS
          ? "the collaboration reached its 12-handoff safety limit"
          : undefined;
      if (blockedReason) {
        blocked.push({ title: target.title, reason: blockedReason });
      } else {
        intents.push({
          targetThreadId: target.id,
          relayDepth: authorThreadId ? relayDepth + 1 : 0,
          mentionTrail: authorThreadId ? [...mentionTrail, fingerprint] : [],
          kind: "tag",
          audience: hasEveryoneMention(text) ? "everyone" : "mention",
        });
      }
    }
    return { intents, blocked };
  }

  function resolveExplicitCollaborationIntents(
    masterChatId: string,
    authorThreadId: string,
    recipientAgentIds: string[],
    text: string,
    relayDepth: number,
    mentionTrail: string[],
  ): { text: string; intents: MasterChatDeliveryIntent[]; error?: string } {
    const detail = store.getCollaborationChatDetail(masterChatId);
    const members = new Map((detail?.threads ?? []).map((thread) => [thread.id, thread]));
    const targetIds = [...new Set(recipientAgentIds)];
    const targets = targetIds.map((id) => members.get(id));
    if (targets.some((target) => !target || target.archived || target.id === authorThreadId)) {
      return { text, intents: [], error: "every collaboration recipient must be a different active agent in this master chat" };
    }
    const renderedText = `${targets.map((target) => `@${agentMentionHandle(target!.title)}`).join(" ")} ${text}`;
    const intents: MasterChatDeliveryIntent[] = [];
    for (const target of targets) {
      const fingerprint = mentionRelayFingerprint(authorThreadId, target!.id, renderedText);
      if (mentionTrail.includes(fingerprint)) {
        return { text, intents: [], error: "the same collaboration handoff already occurred in this delivery chain" };
      }
      if (relayDepth >= MAX_AGENT_MENTION_RELAYS) {
        return { text, intents: [], error: "the collaboration reached its 12-handoff safety limit" };
      }
      intents.push({
        targetThreadId: target!.id,
        relayDepth: relayDepth + 1,
        mentionTrail: [...mentionTrail, fingerprint],
        kind: "tag",
        audience: "mention",
      });
    }
    return { text: renderedText, intents };
  }

  function queueRecordedCollaborationMessage(
    masterChatId: string,
    message: MasterChatMessageDto,
    authorThreadId: string | undefined,
    intents: MasterChatDeliveryIntent[],
  ): void {
    const orderKey = store.getMasterChatMessageDeliveryOrderKey(masterChatId, message.id);
    for (const intent of intents) {
      queueCollaborationDelivery({
        masterChatId,
        messageId: message.id,
        communicationEventId: message.communicationEventId,
        targetThreadId: intent.targetThreadId,
        authorThreadId,
        text: message.text,
        relayDepth: intent.relayDepth,
        mentionTrail: intent.mentionTrail,
        kind: intent.kind,
        audience: intent.audience,
        delegatedRunId: intent.delegatedRunId,
        createdAt: message.createdAt,
        orderKey,
      });
    }
  }

  function appendBlockedMentionWarnings(
    masterChatId: string,
    blocked: Array<{ title: string; reason: string }>,
  ): void {
    for (const item of blocked) {
      appendCollaborationSystemNotice(
        masterChatId,
        `⚠️ @${agentMentionHandle(item.title)} was not notified because ${item.reason}. Please ask the manager to continue the conversation.`,
      );
    }
  }

  function appendCollaborationSystemNotice(
    masterChatId: string,
    text: string,
    idempotencyKey?: string,
  ): MasterChatMessageDto | undefined {
    const master = store.getMasterChat(masterChatId);
    if (!master) return undefined;
    const communication = recordCommunication({
      eventId: randomUUID(), schemaVersion: 1, projectId: master.projectId, masterChatId,
      sender: { kind: "system", component: "collaboration-supervision" },
      intent: "direct_to_user", audience: { kind: "user", userId: "local-operator" },
      text, createdAt: new Date().toISOString(), ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    const existing = communication
      ? store.getMasterChatMessages(masterChatId, "collaboration").find((message) => message.communicationEventId === communication.eventId)
      : undefined;
    if (existing) return existing;
    return store.appendMasterChatMessage(
      masterChatId, { role: "system", text }, undefined, "collaboration", undefined, undefined, communication?.eventId,
    );
  }

  function syncDelegatedCompletion(deliveryId: string): void {
    const delivery = collaborationDeliveries.get(deliveryId);
    if (!delivery?.delegatedRunId) return;
    const completionDelivery = {
      status: delivery.status,
      createdAt: delivery.createdAt,
      ...(delivery.deliveredAt ? { deliveredAt: delivery.deliveredAt } : {}),
      ...(delivery.acknowledgedAt ? { acknowledgedAt: delivery.acknowledgedAt } : {}),
      ...(delivery.failure ? { failure: delivery.failure } : {}),
    } as NonNullable<SubagentRunDto["completionDelivery"]>;
    try {
      delegations.setCompletionDelivery(delivery.delegatedRunId, completionDelivery);
    } catch {
      // A deleted delegation cannot retain a delivery record; no retry target remains.
    }
  }

  /** Completion is first-class: it is recorded and delivered even if a child never tags its parent. */
  function notifyParentOfDelegatedCompletion(run: SubagentRunDto): void {
    if (closed) return;
    if ((run.status !== "completed" && run.status !== "blocked" && run.status !== "failed") || !run.parentThreadId || run.completionDelivery) return;
    const parent = store.getThread(run.parentThreadId);
    if (!parent) {
      delegations.setCompletionDelivery(run.id, {
        status: "failed",
        createdAt: new Date().toISOString(),
        failure: "parent agent is no longer available",
      });
      return;
    }
    const completionText = run.status === "completed"
      ? `✅ Delegated task “${run.delegationSummary}” completed. @${agentMentionHandle(parent.title)}, the result is ready.${run.disposition?.message ? ` ${run.disposition.message}` : ""}`
      : run.status === "blocked"
        ? `⏸️ Delegated task “${run.delegationSummary}” is blocked. @${agentMentionHandle(parent.title)}, review the blocker.${run.disposition?.message ? ` ${run.disposition.message}` : ""}`
        : `⚠️ Delegated task “${run.delegationSummary}” failed at runtime. @${agentMentionHandle(parent.title)}, review the failure.`;
    const master = store.getMasterChat(run.masterChatId);
    if (!master) return;
    const communication = recordCommunication({
      eventId: randomUUID(), schemaVersion: 1, projectId: master.projectId, masterChatId: master.id,
      sender: run.childThreadId
        ? { kind: "agent", agentId: run.childThreadId, executionId: run.id }
        : { kind: "system", component: "delegation-supervision" },
      intent: "collaboration", audience: { kind: "agents", agentIds: [parent.id] },
      text: completionText, createdAt: new Date().toISOString(), idempotencyKey: `delegation-completion:${run.id}`,
    });
    const existing = communication
      ? store.getMasterChatMessages(run.masterChatId, "collaboration").find((message) => message.communicationEventId === communication.eventId)
      : undefined;
    const message = existing ?? store.appendMasterChatMessage(
      run.masterChatId,
      { role: "system", text: completionText },
      run.childThreadId,
      "collaboration",
      [{
        targetThreadId: parent.id,
        relayDepth: 0,
        mentionTrail: [],
        kind: "delegation_completion",
        delegatedRunId: run.id,
      }],
      undefined,
      communication?.eventId,
    );
    if (!message) return;
    const delivery = queueCollaborationDelivery({
      masterChatId: run.masterChatId,
            messageId: message.id,
            communicationEventId: message.communicationEventId,
      targetThreadId: parent.id,
      authorThreadId: run.childThreadId,
      text: message.text,
      relayDepth: 0,
      mentionTrail: [],
      kind: "delegation_completion",
      delegatedRunId: run.id,
      createdAt: message.createdAt,
      orderKey: store.getMasterChatMessageDeliveryOrderKey(run.masterChatId, message.id),
    });
    if (!delivery) return;
    syncDelegatedCompletion(delivery.id);
  }

  app.post<{
    Body: SendAgentMessageRequest;
  }>("/api/agent-messages", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    if (!capability) return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    const active = activeRuns.get(capability.threadId);
    if (!active || active.runId !== capability.runId || active.messageCapability !== token) {
      return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    }
    // Active runtime sessions may retain the pre-intent prompt until they roll
    // over. Accept that wire shape during migration, but never advertise it to
    // newly seeded sessions.
    const legacyBody = request.body as unknown as { channel?: AgentMessageChannel; text?: string; idempotencyKey?: string };
    const legacyChannel = legacyBody?.channel;
    if (legacyChannel && legacyRoutingMode === "reject") {
      return reply.code(410).send({ error: "legacy channel routing is retired; send an explicit communication intent" });
    }
    const intent = request.body?.intent ?? (legacyChannel === "individual"
      ? "direct_to_user"
      : legacyChannel === "main"
        ? "broadcast"
        : legacyChannel === "collaboration"
          ? "collaboration"
          : undefined);
    const text = request.body?.text?.trim();
    if (!(["broadcast", "direct_to_user", "collaboration"] as const).includes(intent)) {
      return reply.code(400).send({ error: "intent must be broadcast, direct_to_user, or collaboration" });
    }
    if (!text) return reply.code(400).send({ error: "text is required" });
    if (text.length > 4000) return reply.code(400).send({ error: "text must be 4000 characters or fewer" });
    const idempotencyKey = request.body?.idempotencyKey?.trim();
    if (idempotencyKey && idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 200 characters or fewer" });
    const receiptKey = idempotencyKey ? `${capability.runId}:${intent}:${idempotencyKey}` : undefined;
    if (receiptKey) {
      const previousMessageId = collaborationDeliveries.messageReceipt(receiptKey);
      if (previousMessageId) return { intent, messageId: previousMessageId, replayed: true };
    }

    const currentAuthor = store.getThread(capability.threadId);
    if (!currentAuthor || currentAuthor.archived) {
      return reply.code(409).send({ error: "agent is no longer available" });
    }

    if (intent === "direct_to_user") {
      const communication = recordCommunication({
        eventId: randomUUID(),
        schemaVersion: 1,
        projectId: currentAuthor.projectId,
        sender: { kind: "agent", agentId: capability.threadId, executionId: capability.runId },
        intent,
        audience: { kind: "user", userId: "local-operator" },
        text,
        createdAt: new Date().toISOString(),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      if (communication) store.appendCommunicationProjection(currentAuthor.projectId, {
        eventId: communication.eventId,
        surface: "user_inbox",
        projectionKey: "local-operator",
        projectedAt: communication.createdAt,
      });
      const stored = store.appendEvent(capability.threadId, communication ? {
        type: "communication_projection", communicationEventId: communication.eventId, text,
      } : { type: "text", delta: text });
      publish(capability.threadId, stored);
      const messageId = `thread-event-${stored.seq}`;
      if (receiptKey) collaborationDeliveries.rememberMessageReceipt(receiptKey, messageId);
      return { intent, eventId: communication?.eventId, messageId, replayed: false };
    }
    if (!capability.masterChatId) {
      return reply.code(409).send({ error: "agent is not linked to a master chat" });
    }
    if (!currentAuthor.masterChatIds.includes(capability.masterChatId)) {
      return reply.code(409).send({ error: "agent is no longer an active member of this master chat" });
    }
    let renderedText = text;
    let routing: { intents: MasterChatDeliveryIntent[]; blocked: Array<{ title: string; reason: string }> } = { intents: [], blocked: [] };
    if (intent === "collaboration" && !legacyChannel) {
      const recipientAgentIds = request.body.recipientAgentIds;
      if (!Array.isArray(recipientAgentIds) || recipientAgentIds.length === 0) {
        return reply.code(400).send({ error: "collaboration requires at least one recipientAgentId" });
      }
      if (recipientAgentIds.length > 100) return reply.code(400).send({ error: "collaboration supports at most 100 recipients" });
      const resolved = resolveExplicitCollaborationIntents(
        capability.masterChatId,
        capability.threadId,
        recipientAgentIds,
        text,
        capability.mentionDepth,
        capability.mentionTrail,
      );
      if (resolved.error) return reply.code(400).send({ error: resolved.error });
      renderedText = resolved.text;
      routing = { intents: resolved.intents, blocked: [] };
    } else if (intent === "collaboration") {
      routing = resolveCollaborationIntents(
        capability.masterChatId,
        capability.threadId,
        text,
        capability.mentionDepth,
        capability.mentionTrail,
      );
    }
    const channel = intent === "broadcast" ? "main" : "collaboration";
    const communication = recordCommunication(intent === "broadcast" ? {
      eventId: randomUUID(),
      schemaVersion: 1,
      projectId: currentAuthor.projectId,
      masterChatId: capability.masterChatId,
      sender: { kind: "agent", agentId: capability.threadId, executionId: capability.runId },
      intent,
      audience: { kind: "organization", organizationId: currentAuthor.projectId },
      text,
      createdAt: new Date().toISOString(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    } : {
      eventId: randomUUID(),
      schemaVersion: 1,
      projectId: currentAuthor.projectId,
      masterChatId: capability.masterChatId,
      sender: { kind: "agent", agentId: capability.threadId, executionId: capability.runId },
      intent,
      audience: { kind: "agents", agentIds: routing.intents.map((item) => item.targetThreadId) as [string, ...string[]] },
      text,
      createdAt: new Date().toISOString(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    const message = store.appendMasterChatMessage(
      capability.masterChatId,
      { role: "assistant", text: renderedText },
      capability.threadId,
      channel,
      routing.intents,
      receiptKey,
      communication?.eventId,
    );
    if (!message) return reply.code(404).send({ error: "master chat not found" });
    if (receiptKey) collaborationDeliveries.rememberMessageReceipt(receiptKey, message.id);
    if (intent === "collaboration") {
      queueRecordedCollaborationMessage(capability.masterChatId, message, capability.threadId, routing.intents);
      appendBlockedMentionWarnings(capability.masterChatId, routing.blocked);
    }
    return { intent, eventId: communication?.eventId, messageId: message.id, replayed: false };
  });

  app.post("/api/agent-session/rollover", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    if (!capability) return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    const active = activeRuns.get(capability.threadId);
    if (!active || active.runId !== capability.runId || active.messageCapability !== token) {
      return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    }
    scheduledSessionRollovers.set(capability.threadId, new Date().toISOString());
    return { scheduled: true, afterRunId: capability.runId };
  });

  /**
   * The sole delegated launch path. Ownership has already been derived from the
   * active run capability; no HTTP caller can provide or replay launch proofs.
   */
  function launchDelegatedRun(runId: string, agentMessageUrl: string): SubagentRunDto {
    const context = delegations.launchContext(runId);
    const queued = delegations.get(runId);
    if (!context || !queued) throw new DelegationError("subagent_not_found", "subagent was not found", 404);
    const engine = engines.get(context.runtime);
    const masterChat = store.getMasterChat(queued.masterChatId);
    const project = masterChat ? store.getProject(masterChat.projectId) : undefined;
    const childThread = queued.childThreadId ? store.getThread(queued.childThreadId) : undefined;
    const parentThread = queued.parentThreadId ? store.getThread(queued.parentThreadId) : undefined;
    if (!engine || !project || !childThread) {
      throw new DelegationError("forbidden", "delegated runtime context is unavailable", 409);
    }
    if (activeRuns.has(childThread.id)) {
      throw new DelegationError("concurrency_limit_exceeded", "delegated child already has an active run", 409, true);
    }

    const controller = new AbortController();
    const messageCapabilityToken = randomUUID();
    const delegationCapabilityToken = randomUUID();
    const run = delegations.claim(runId);
    const startedAt = new Date().toISOString();
    const lifecycle = store.appendEvent(childThread.id, {
      type: "agent_lifecycle", status: "running", reason: "active_run", executionId: run.id,
    });
    publish(childThread.id, lifecycle);
    activeRuns.set(childThread.id, {
      runId: run.id,
      startedAt,
      executionId: run.id,
      leaseExpiresAt: leaseExpiry(),
      controller,
      messageCapability: messageCapabilityToken,
      delegatedRunId: run.id,
    });
    agentMessageCapabilities.set(messageCapabilityToken, {
      threadId: childThread.id,
      masterChatId: run.masterChatId,
      runId: run.id,
      mentionDepth: 0,
      mentionTrail: [],
    });
    delegationCapabilities.set(delegationCapabilityToken, {
      parentRunId: run.id,
      threadId: childThread.id,
      masterChatId: run.masterChatId,
      controller,
    });

    void (async () => {
      let runtimeError: string | undefined;
      try {
        const stream = engine.adapter.seed({
          threadId: childThread.id,
          cwd: project.hostPath,
          prompt: [
            context.prompt,
            "",
            `You are a first-class delegated Ponderosa agent${parentThread ? ` created by @${agentMentionHandle(parentThread.title)}` : ""}.`,
            "Use the Collaboration chat to coordinate with your parent or other agents; use your individual chat for manager follow-ups.",
            ...agentMessagingPrompt(),
            ...agentDelegationPrompt(),
            ...delegatedOutcomePrompt(),
          ].join("\n"),
          history: context.history,
          model: context.model,
          effort: context.effort,
          environment: {
            PONDEROSA_AGENT_MESSAGE_URL: agentMessageUrl,
            PONDEROSA_AGENT_MESSAGE_TOKEN: messageCapabilityToken,
            PONDEROSA_AGENT_ROLLOVER_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-session/rollover`,
            PONDEROSA_DELEGATION_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-delegations`,
            PONDEROSA_DELEGATION_OUTCOME_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-delegation-outcomes`,
            PONDEROSA_DELEGATION_TOKEN: delegationCapabilityToken,
            PONDEROSA_INTERNAL_SUBAGENTS_DISABLED: "1",
          },
          signal: controller.signal,
        });
        for await (const event of stream) {
          if (closed) break;
          renewExecutionLease(childThread.id);
          let logEvent: LogEvent = event;
          if (event.type === "text" && event.delta.trim()) {
            const communication = recordCommunication({
              eventId: randomUUID(), schemaVersion: 1, projectId: project.id, masterChatId: run.masterChatId,
              sender: { kind: "agent", agentId: childThread.id, executionId: run.id },
              intent: "direct_to_user", audience: { kind: "user", userId: "local-operator" },
              text: event.delta, createdAt: new Date().toISOString(),
            });
            if (communication) {
              store.appendCommunicationProjection(project.id, {
                eventId: communication.eventId, surface: "user_inbox", projectionKey: "local-operator",
                projectedAt: communication.createdAt,
              });
              logEvent = { ...event, communicationEventId: communication.eventId };
            }
          }
          const stored = store.appendEvent(childThread.id, logEvent);
          publish(childThread.id, stored);
          if (event.type === "error") runtimeError = event.message;
        }
        if (closed) return;
        if (controller.signal.aborted) return;
        if (runtimeError) notifyParentOfDelegatedCompletion(delegations.finishRuntime(runId, runtimeError));
        else delegations.finishRuntime(runId);
      } catch (error) {
        if (closed) return;
        runtimeError = error instanceof Error ? error.message : String(error);
        notifyParentOfDelegatedCompletion(delegations.finishRuntime(runId, runtimeError));
      } finally {
        if (scheduledSessionRollovers.delete(childThread.id)) {
          store.clearResumeSession(childThread.id, "explicit_compaction");
        }
        if (!closed && !controller.signal.aborted) {
          const terminal = store.appendEvent(childThread.id, {
            type: "agent_lifecycle",
            status: runtimeError ? "failed" : "completed",
            reason: runtimeError ? "runtime_error" : "turn_completed",
            executionId: run.id,
          });
          publish(childThread.id, terminal);
        }
        if (activeRuns.get(childThread.id)?.controller === controller) activeRuns.delete(childThread.id);
        agentMessageCapabilities.delete(messageCapabilityToken);
        delegationCapabilities.delete(delegationCapabilityToken);
        void dispatchNextTurn(childThread.id);
      }
    })();

    return run;
  }

  app.post<{ Body: AgentDelegationRequest & Record<string, unknown> }>(
    "/api/agent-delegations",
    async (request, reply) => {
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
      const capability = token ? delegationCapabilities.get(token) : undefined;
      if (!capability || capability.controller.signal.aborted) {
        return reply.code(401).send({ error: { code: "forbidden", message: "invalid or expired delegation capability", retryable: false } });
      }
      const forbiddenOwnership = ["parentRunId", "parentThreadId", "childThreadId", "threadId", "masterChatId", "rootRunId", "registrationId", "credential"]
        .find((field) => request.body && field in request.body);
      if (forbiddenOwnership) {
        return reply.code(403).send({ error: { code: "unauthorized_parent", message: `ownership field ${forbiddenOwnership} is server-controlled`, retryable: false } });
      }
      const input = request.body;
      if (!input?.displayLabel?.trim() || !input.delegationPrompt?.trim() || (!input.runtime?.trim() && !input.presetId) || !input.idempotencyKey?.trim()) {
        return reply.code(400).send({ error: { code: "forbidden", message: "displayLabel, delegationPrompt, runtime or presetId, and idempotencyKey are required", retryable: false } });
      }
      const parent = store.getThread(capability.threadId);
      const preset = input.presetId ? store.getAgentPreset(input.presetId) : undefined;
      if (input.presetId && (!parent || !preset || preset.projectId !== parent.projectId || !preset.enabled)) {
        return reply.code(400).send({ error: { code: "forbidden", message: "preset is unavailable for this project", retryable: false } });
      }
      const runtime = preset?.engine ?? input.runtime!;
      const model = preset?.model ?? input.model;
      const effort = preset?.effort ?? input.effort;
      const delegationPrompt = preset ? `Agent preset snapshot (${preset.name}):\n${preset.guidance}\n\n${input.delegationPrompt}` : input.delegationPrompt;
      if (!engines.has(runtime)) {
        return reply.code(400).send({ error: { code: "forbidden", message: "runtime is not configured", retryable: false } });
      }
      if (input.displayLabel.length > 100 || input.delegationPrompt.length > MAX_TEXT_LENGTH || input.idempotencyKey.length > 200 || (input.model?.length ?? 0) > 200) {
        return reply.code(400).send({ error: { code: "forbidden", message: "delegation fields exceed their size limits", retryable: false } });
      }
      try {
        const context = collaborationChatDetail(capability.masterChatId);
        if (!context) throw new DelegationError("forbidden", "bound master chat is unavailable", 409);
        const contextMessages = context.messages.map(({ id, role, text, authorThreadId }) => ({ id, role, text, ...(authorThreadId ? { authorThreadId } : {}) }));
        let spawned = delegations.spawn(capability.masterChatId, {
          parentRunId: capability.parentRunId,
          displayLabel: input.displayLabel,
          delegationPrompt,
          runtime,
          model,
          effort,
          idempotencyKey: input.idempotencyKey,
        }, true, contextMessages, capability.threadId);
        if (!spawned.run.childThreadId) {
          const masterChat = store.getMasterChat(capability.masterChatId);
          if (!masterChat) throw new DelegationError("forbidden", "bound master chat is unavailable", 409);
          const child = store.createThread(masterChat.projectId, {
            title: spawned.run.displayLabel,
            engine: runtime,
            masterChatId: capability.masterChatId,
            model,
            effort,
            presetId: preset?.id,
          });
          const initialText = `Delegated task: ${spawned.run.delegationSummary}`;
          const communication = recordCommunication({
            eventId: randomUUID(), schemaVersion: 1, projectId: masterChat.projectId, masterChatId: masterChat.id,
            sender: { kind: "agent", agentId: capability.threadId, executionId: capability.parentRunId },
            intent: "collaboration", audience: { kind: "agents", agentIds: [child.id] },
            text: initialText, createdAt: new Date().toISOString(), idempotencyKey: `delegation-objective:${spawned.run.id}`,
          });
          if (communication) store.appendCommunicationProjection(masterChat.projectId, {
            eventId: communication.eventId, surface: "agent_inbox", projectionKey: child.id,
            projectedAt: communication.createdAt,
          });
          const initial = store.appendEvent(child.id, {
            type: "user_message",
            text: initialText,
            ...(communication ? { communicationEventId: communication.eventId } : {}),
          });
          publish(child.id, initial);
          const run = delegations.bindChildThread(spawned.run.id, child.id);
          spawned = { ...spawned, run };
        }
        if (spawned.run.status === "queued") {
          try {
            launchDelegatedRun(spawned.run.id, agentMessageEndpoint(request, opts.agentBaseUrl));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            notifyParentOfDelegatedCompletion(delegations.finishRuntime(spawned.run.id, message));
            throw error;
          }
        }
        return reply.code(202).send({ run: delegations.get(spawned.run.id), accepted: true, replayed: spawned.replayed });
      } catch (error) {
        return delegationFailure(error, reply);
      }
    },
  );

  app.post<{ Body: AgentDelegationDispositionRequest & Record<string, unknown> }>(
    "/api/agent-delegation-outcomes",
    async (request, reply) => {
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
      const capability = token ? delegationCapabilities.get(token) : undefined;
      if (!capability || capability.controller.signal.aborted) {
        return reply.code(401).send({ error: { code: "forbidden", message: "invalid or expired delegation capability", retryable: false } });
      }
      const input = request.body;
      if ((input?.outcome !== "completed" && input?.outcome !== "blocked") || !input.idempotencyKey?.trim() || (input.message?.length ?? 0) > MAX_TEXT_LENGTH || input.idempotencyKey.length > 200) {
        return reply.code(400).send({ error: { code: "invalid_disposition", message: "outcome, bounded message, and idempotencyKey are required", retryable: false } });
      }
      try {
        const run = delegations.declareDisposition(capability.parentRunId, input);
        notifyParentOfDelegatedCompletion(run);
        return reply.send({ run });
      } catch (error) {
        return delegationFailure(error, reply);
      }
    },
  );

  app.get("/api/health", async (): Promise<HealthDto> => ({
    status: "ok",
    service: "ponderosa",
    version: "0.0.0",
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
    const communicationReports = communicationMode === "off"
      ? []
      : store.listProjects().map((project) => store.reconcileCommunicationEvents(project.id));
    const communicationParity = communicationReports.every((report) => report.ok);
    const authoritativeSourceAvailable = communicationMode !== "off";
    const communicationMigration = {
      ok: communicationReadMode !== "authoritative" || (authoritativeSourceAvailable && communicationParity),
      detail: `communication=${communicationMode}; reads=${communicationReadMode}; legacy_routing=${legacyRoutingMode}; curated_context=${curatedContextEnabled ? "on" : "off"}; parity=${authoritativeSourceAvailable ? (communicationParity ? "ok" : "drift") : "disabled"}`,
    };
    const canAcceptWork = !closed && dataDirectory.ok && projections.ok && runtimes.ok && communicationMigration.ok;
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
  app.post<{ Body: { label: string; hostPath: string } }>("/api/projects", async (request, reply) => {
    if (!request.body?.label || !request.body?.hostPath) {
      return reply.code(400).send({ error: "label and hostPath are required" });
    }
    if (!(await pathExists(request.body.hostPath))) {
      return reply.code(400).send({ error: "hostPath does not exist" });
    }
    return store.createProject(request.body);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const project = store.getProject(request.params.id);
    return project ?? reply.code(404).send({ error: "project not found" });
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/communication-reconciliation", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    const report = store.reconcileCommunicationEvents(request.params.id);
    if (!report.ok) reply.code(409);
    return report;
  });

  app.post<{
    Params: { id: string };
    Body: import("@ponderosa/core").LegacyCommunicationBackfillRequest;
  }>("/api/projects/:id/communication-backfill", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    const body = request.body ?? {};
    if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
      return reply.code(400).send({ error: "dryRun must be boolean" });
    }
    const overrides = body.collaborationRecipientsByMessageId;
    if (overrides && (typeof overrides !== "object" || Array.isArray(overrides) || Object.keys(overrides).length > 10_000 ||
      Object.values(overrides).some((ids) => !Array.isArray(ids) || ids.length === 0 || ids.length > 100 || ids.some((id) => typeof id !== "string")))) {
      return reply.code(400).send({ error: "collaboration recipient overrides must contain 1 to 100 stable agent IDs per message" });
    }
    return store.backfillLegacyCommunications(request.params.id, body);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/knowledge-promotions", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    return store.readKnowledgePromotions(request.params.id);
  });

  app.post<{
    Params: { id: string };
    Body: import("@ponderosa/core").CreateKnowledgePromotionRequest;
  }>("/api/projects/:id/knowledge-promotions", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    const { sourceEventId, summary, idempotencyKey, expiresAt } = request.body ?? {};
    if (!sourceEventId?.trim() || !summary?.trim() || !idempotencyKey?.trim()) {
      return reply.code(400).send({ error: "sourceEventId, summary, and idempotencyKey are required" });
    }
    if (summary.length > 4000 || idempotencyKey.length > 200) {
      return reply.code(400).send({ error: "promotion fields exceed their limits" });
    }
    try {
      const result = store.promoteKnowledge({
        promotionId: randomUUID(),
        sourceEventId,
        organizationId: request.params.id,
        summary: summary.trim(),
        promotedBy: { kind: "user", userId: "local-operator" },
        promotedAt: new Date().toISOString(),
        idempotencyKey: idempotencyKey.trim(),
        ...(expiresAt ? { expiresAt } : {}),
      });
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "knowledge promotion failed" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/agent-health", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    const masterIds = new Set(store.listMasterChats(request.params.id).map((master) => master.id));
    return agentHealth(
      { type: "project", id: request.params.id },
      store.listThreads(request.params.id),
      delegations.all().filter((run) => masterIds.has(run.masterChatId)),
    );
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/master-chats", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    return store.listMasterChats(request.params.id);
  });

  app.post<{
    Params: { id: string };
    Body: { title: string; defaultEngine?: string; defaultModel?: string; defaultEffort?: string };
  }>("/api/projects/:id/master-chats", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    if (!request.body?.title) return reply.code(400).send({ error: "title is required" });
    if (request.body.defaultEngine && !engines.has(request.body.defaultEngine)) {
      return reply.code(400).send({ error: "unknown engine" });
    }
    return store.createMasterChat(request.params.id, request.body);
  });

  app.get<{ Params: { id: string } }>("/api/master-chats/:id", async (request, reply) => {
    const detail = masterChatDetail(request.params.id);
    return detail ?? reply.code(404).send({ error: "master chat not found" });
  });

  app.get<{ Params: { id: string } }>("/api/master-chats/:id/agent-health", async (request, reply) => {
    const master = store.getMasterChat(request.params.id);
    if (!master) return reply.code(404).send({ error: "master chat not found" });
    const threads = store.listThreads(master.projectId).filter((thread) => thread.masterChatIds.includes(master.id));
    return agentHealth({ type: "master_chat", id: master.id }, threads, delegations.list(master.id));
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
  }>("/api/master-chats/:id", async (request, reply) => {
    if (request.body?.defaultEngine && !engines.has(request.body.defaultEngine)) {
      return reply.code(400).send({ error: "unknown engine" });
    }
    const masterChat = store.updateMasterChat(request.params.id, request.body ?? {});
    return masterChat ?? reply.code(404).send({ error: "master chat not found" });
  });

  app.delete<{ Params: { id: string } }>("/api/master-chats/:id", async (request, reply) => {
    const deleted = store.deleteMasterChat(request.params.id);
    return deleted ? reply.code(204).send() : reply.code(404).send({ error: "master chat not found" });
  });

  app.post<{
    Params: { id: string };
    Body: { role?: "user" | "assistant" | "system"; text: string; replyToMessageId?: string; directReplyToAuthorThreadId?: string; attachments?: AssetDto[] };
  }>("/api/master-chats/:id/messages", async (request, reply) => {
    const text = request.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: "text is required" });
    if (request.body.directReplyToAuthorThreadId) return reply.code(400).send({ error: "use the idempotent direct-replies endpoint" });
    if (text.length > MAX_TEXT_LENGTH) return reply.code(400).send({ error: "text must be 65536 characters or fewer" });
    const master = store.getMasterChat(request.params.id);
    if (!master) return reply.code(404).send({ error: "master chat not found" });
    const requestedAssets = request.body.attachments ?? [];
    if (!Array.isArray(requestedAssets) || requestedAssets.length > MAX_ATTACHMENTS_PER_MESSAGE) return reply.code(400).send({ error: "at most 4 assets are allowed" });
    const validatedAssets: AssetDto[] = [];
    for (const requested of requestedAssets) {
      const owner = store.getThread(requested.threadId);
      const stored = owner?.projectId === master.projectId && owner.masterChatIds.includes(master.id)
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
      masterChatId: master.id,
      sender: { kind: "user", userId: "local-operator" },
      intent: "broadcast",
      audience: { kind: "organization", organizationId: master.projectId },
      text,
      createdAt: new Date().toISOString(),
    });
    let message;
    try {
      message = store.appendMasterChatMessage(request.params.id, {
        role: request.body.role,
        text,
        replyToMessageId: request.body.replyToMessageId,
        attachments: validatedAssets,
      }, undefined, "main", undefined, undefined, communication?.eventId);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "reply target was not found in this conversation" });
    }
    await Promise.all(validatedAssets.map((asset) => {
      const owner = store.getThread(asset.threadId)!;
      return assets.associate(owner.projectId, owner.id, [asset.id]);
    }));
    return message ?? reply.code(404).send({ error: "master chat not found" });
  });

  const recordReaction = (input: {
    masterChatId: string; channel: "main" | "collaboration"; messageId: string;
    actor: ReactionActor; body: SetMessageReactionRequest;
  }): SetMessageReactionResponse => {
    const result = store.setMasterChatReaction({ ...input, ...input.body });
    return {
      occurrenceId: result.event.occurrenceId,
      replayed: result.replayed,
      persistence: "recorded",
      notification: result.notification === "pending" ? "queued" : result.notification,
      reactions: result.reactions,
    };
  };

  app.put<{ Params: { id: string; channel: "main" | "collaboration"; messageId: string }; Body: SetMessageReactionRequest }>(
    "/api/master-chats/:id/:channel/messages/:messageId/reaction",
    async (request, reply) => {
      if (request.params.channel !== "main" && request.params.channel !== "collaboration") return reply.code(400).send({ error: "invalid conversation" });
      try {
        return recordReaction({ masterChatId: request.params.id, channel: request.params.channel, messageId: request.params.messageId, actor: { kind: "manager" }, body: request.body });
      } catch (error) {
        const message = error instanceof Error ? error.message : "reaction failed";
        return reply.code(message.includes("cooldown") || message.includes("idempotency") ? 409 : message.includes("not found") ? 404 : 400).send({ error: message });
      }
    },
  );

  app.post<{ Body: SetMessageReactionRequest & { masterChatId: string; channel: "main" | "collaboration"; messageId: string } }>(
    "/api/agent-reactions",
    async (request, reply) => {
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
      const capability = token ? agentMessageCapabilities.get(token) : undefined;
      const active = capability ? activeRuns.get(capability.threadId) : undefined;
      if (!capability || !active || active.runId !== capability.runId || active.messageCapability !== token) return reply.code(401).send({ error: "invalid or expired agent capability" });
      try {
        return recordReaction({ masterChatId: request.body.masterChatId, channel: request.body.channel, messageId: request.body.messageId, actor: { kind: "agent", threadId: capability.threadId }, body: request.body });
      } catch (error) {
        const message = error instanceof Error ? error.message : "reaction failed";
        return reply.code(message.includes("member") ? 403 : message.includes("cooldown") || message.includes("idempotency") ? 409 : message.includes("not found") ? 404 : 400).send({ error: message });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: CreateDirectReplyRequest }>(
    "/api/master-chats/:id/direct-replies",
    async (request, reply) => {
      const text = request.body?.text?.trim() ?? "";
      const replyToMessageId = request.body?.replyToMessageId?.trim() ?? "";
      const targetAuthorThreadId = request.body?.targetAuthorThreadId?.trim() ?? "";
      const idempotencyKey = request.body?.idempotencyKey?.trim() ?? "";
      const attachmentIds = request.body?.attachmentIds ?? [];
      if (!text && attachmentIds.length === 0) return reply.code(400).send({ error: "text or an attachment is required" });
      if (text.length > MAX_TEXT_LENGTH) return reply.code(400).send({ error: "text must be 65536 characters or fewer" });
      if (!replyToMessageId || !targetAuthorThreadId) return reply.code(400).send({ error: "reply target and author are required" });
      if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
      if (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE || new Set(attachmentIds).size !== attachmentIds.length) {
        return reply.code(400).send({ error: "at most 4 unique attachments are allowed" });
      }
      const master = store.getMasterChat(request.params.id);
      if (!master || master.archived) return reply.code(404).send({ error: "master chat not found" });
      const receiptKey = `direct-reply:${master.id}:${idempotencyKey}`;
      const existingMessageId = collaborationDeliveries.messageReceipt(receiptKey);
      const existing = existingMessageId
        ? store.getMasterChatMessages(master.id).find((message) => message.id === existingMessageId)
        : store.getMasterChatMessageByReceiptKey(master.id, receiptKey);
      if (existing) {
        const sameRequest = existing.text === text && existing.replyTo?.messageId === replyToMessageId &&
          existing.replyTo.authorThreadId === targetAuthorThreadId &&
          JSON.stringify(existing.attachments?.map((item) => item.id) ?? []) === JSON.stringify(attachmentIds);
        if (!sameRequest) return reply.code(409).send({ error: "idempotency key was used with another direct reply" });
        collaborationDeliveries.rememberMessageReceipt(receiptKey, existing.id);
        let delivery = collaborationDeliveries.getForMessageTarget(existing.id, targetAuthorThreadId);
        if (!delivery) {
          const persisted = store.getMasterChatDeliveryIntents(master.id).find(({ message, intent, messageReceiptKey }) =>
            message.id === existing.id && messageReceiptKey === receiptKey &&
            intent.kind === "direct" && intent.targetThreadId === targetAuthorThreadId,
          );
          if (!persisted) {
            return reply.code(503).send({
              error: "direct reply delivery intent is unavailable; retry after recovery",
              retryable: true,
            });
          }
          try {
            delivery = queueCollaborationDelivery({
              masterChatId: master.id,
              messageId: existing.id,
              communicationEventId: existing.communicationEventId,
              targetThreadId: persisted.intent.targetThreadId,
              text: existing.text,
              relayDepth: persisted.intent.relayDepth,
              mentionTrail: persisted.intent.mentionTrail,
              kind: "direct",
              createdAt: existing.createdAt,
              orderKey: persisted.deliveryOrderKey,
              sourceChannel: "main",
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
          targetAuthorThreadId,
          replayed: true,
          queued: delivery?.status === "queued",
        } satisfies DirectReplyResponse;
      }
      if (directReplyClaims.has(receiptKey)) {
        return reply.code(409).send({ error: "direct reply with this idempotency key is in progress", retryable: true });
      }
      directReplyClaims.add(receiptKey);
      try {
      const target = store.getThread(targetAuthorThreadId);
      if (!target || target.archived || !target.masterChatIds.includes(master.id)) return reply.code(404).send({ error: "direct reply target not found" });
      const attached = await Promise.all(attachmentIds.map((id) => assetMetadata(target.id, id)));
      if (attached.some((item) => !item || item.threadId !== target.id)) return reply.code(404).send({ error: "direct reply attachment not found" });
      const attachments = attached as ImageAttachmentDto[];
      const intent: MasterChatDeliveryIntent = {
        targetThreadId: target.id,
        relayDepth: 0,
        mentionTrail: [],
        kind: "direct",
      };
      const communication = recordCommunication({
        eventId: randomUUID(),
        schemaVersion: 1,
        projectId: master.projectId,
        masterChatId: master.id,
        sender: { kind: "user", userId: "local-operator" },
        intent: "collaboration",
        audience: { kind: "agents", agentIds: [target.id] },
        text,
        createdAt: new Date().toISOString(),
        idempotencyKey: receiptKey,
      });
      let message: MasterChatMessageDto | undefined;
      try {
        message = store.appendMasterChatMessage(
          master.id,
          { text, replyToMessageId, directReplyToAuthorThreadId: target.id, attachments },
          undefined,
          "main",
          [intent],
          receiptKey,
          communication?.eventId,
        );
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid direct reply" });
      }
      if (!message) return reply.code(404).send({ error: "master chat not found" });
      collaborationDeliveries.rememberMessageReceipt(receiptKey, message.id);
      const wasBusy = activeRuns.has(target.id);
      const delivery = queueCollaborationDelivery({
        masterChatId: master.id,
        messageId: message.id,
        communicationEventId: message.communicationEventId,
        targetThreadId: target.id,
        text,
        relayDepth: 0,
        mentionTrail: [],
        kind: "direct",
        createdAt: message.createdAt,
        orderKey: store.getMasterChatMessageDeliveryOrderKey(master.id, message.id),
        sourceChannel: "main",
        attachmentIds,
      });
      if (!delivery) return reply.code(503).send({ error: "direct reply delivery could not be persisted" });
      return {
        messageId: message.id,
        targetAuthorThreadId: target.id,
        replayed: false,
        queued: wasBusy,
      } satisfies DirectReplyResponse;
      } finally {
        directReplyClaims.delete(receiptKey);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/master-chats/:id/collaboration", async (request, reply) => {
    const detail = collaborationChatDetail(request.params.id);
    return detail ?? reply.code(404).send({ error: "master chat not found" });
  });

  app.post<{
    Params: { id: string };
    Body: { text: string; recipientAgentIds?: string[]; replyToMessageId?: string; directReplyToAuthorThreadId?: string };
  }>("/api/master-chats/:id/collaboration/messages", async (request, reply) => {
    const text = request.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: "text is required" });
    if (text.length > MAX_TEXT_LENGTH) return reply.code(400).send({ error: "text must be 65536 characters or fewer" });
    if (request.body.directReplyToAuthorThreadId) return reply.code(400).send({ error: "Reply Directly is available only in main chat" });
    const detail = collaborationChatDetail(request.params.id);
    if (!detail) return reply.code(404).send({ error: "master chat not found" });

    let renderedText = text;
    let routing: { intents: MasterChatDeliveryIntent[]; blocked: Array<{ title: string; reason: string }> };
    if (request.body.recipientAgentIds !== undefined) {
      const ids = request.body.recipientAgentIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) {
        return reply.code(400).send({ error: "collaboration requires 1 to 100 recipientAgentIds" });
      }
      const uniqueIds = [...new Set(ids)];
      const members = new Map(detail.threads.map((thread) => [thread.id, thread]));
      const targets = uniqueIds.map((id) => members.get(id));
      if (targets.some((target) => !target || target.archived)) {
        return reply.code(400).send({ error: "every collaboration recipient must be an active agent in this master chat" });
      }
      renderedText = `${targets.map((target) => `@${agentMentionHandle(target!.title)}`).join(" ")} ${text}`;
      routing = {
        intents: targets.map((target) => ({
          targetThreadId: target!.id, relayDepth: 0, mentionTrail: [], kind: "tag", audience: "mention",
        })),
        blocked: [],
      };
    } else {
      // Compatibility for clients loaded before the recipient-picker contract.
      if (legacyRoutingMode === "reject") {
        return reply.code(400).send({ error: "collaboration requires explicit recipientAgentIds; mention routing is retired" });
      }
      routing = resolveCollaborationIntents(request.params.id, "", text, 0, []);
    }
    if (routing.intents.length === 0) {
      return reply.code(400).send({ error: "collaboration requires at least one explicit recipient" });
    }
    const master = store.getMasterChat(request.params.id)!;
    if (request.body.replyToMessageId) {
      const replyTarget = detail.messages.find((message) => message.id === request.body.replyToMessageId);
      const replyEvent = replyTarget?.communicationEventId
        ? store.getCommunicationEvent(master.projectId, replyTarget.communicationEventId)
        : undefined;
      if (!replyTarget || routing.intents.some((intent) =>
        !canonicalAudienceIncludes(replyEvent, master.projectId, intent.targetThreadId))) {
        return reply.code(400).send({ error: "reply target is not visible to every collaboration recipient" });
      }
    }
    const communication = recordCommunication({
      eventId: randomUUID(), schemaVersion: 1, projectId: master.projectId, masterChatId: master.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "collaboration",
      audience: { kind: "agents", agentIds: routing.intents.map((item) => item.targetThreadId) as [string, ...string[]] },
      text, createdAt: new Date().toISOString(),
    });
    let message;
    try { message = store.appendMasterChatMessage(
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
    notifiedAgentIds.push(...routing.intents.map((intent) => intent.targetThreadId));
    return {
      message,
      audience: hasEveryoneMention(text) ? "everyone" : "mention",
      notifiedAgentIds,
    };
  });

  app.get<{ Params: { id: string } }>("/api/master-chats/:id/subagents", async (request, reply) => {
    if (!store.getMasterChat(request.params.id)) return reply.code(404).send({ error: "master chat not found" });
    return delegations.list(request.params.id);
  });

  app.get<{ Params: { id: string }; Querystring: { lastEventId?: string } }>(
    "/api/master-chats/:id/subagents/stream",
    async (request, reply) => {
      if (!store.getMasterChat(request.params.id)) return reply.code(404).send({ error: "master chat not found" });
      if ((subscribers.get(`subagents:${request.params.id}`)?.size ?? 0) >= MAX_SSE_SUBSCRIBERS_PER_STREAM) {
        return reply.code(429).send({ error: "too many stream subscribers" });
      }
      const raw = request.headers["last-event-id"] ?? request.query.lastEventId ?? "0";
      let lastSeq = Number(Array.isArray(raw) ? raw[0] : raw) || 0;
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
      for (const envelope of delegations.eventsSince(request.params.id, lastSeq)) {
        writeSse(reply.raw, "message", envelope.seq, envelope);
        lastSeq = envelope.seq;
      }
      const unsubscribe = delegations.subscribe((envelope) => {
        if (envelope.masterChatId === request.params.id && envelope.seq > lastSeq) {
          writeSse(reply.raw, "message", envelope.seq, envelope);
          lastSeq = envelope.seq;
        }
      });
      const subagentKey = `subagents:${request.params.id}`;
      const marker: Subscriber = () => {};
      let subagentSet = subscribers.get(subagentKey);
      if (!subagentSet) subscribers.set(subagentKey, subagentSet = new Set());
      subagentSet.add(marker);
      const heartbeat = setInterval(() => writeSse(reply.raw, "heartbeat", undefined, { ts: new Date().toISOString() }), 15_000);
      request.raw.on("close", () => { clearInterval(heartbeat); unsubscribe(); subagentSet?.delete(marker); });
    },
  );

  app.post<{ Params: { runId: string }; Body: { scope: "branch"; idempotencyKey: string } }>(
    "/api/subagents/:runId/cancel",
    async (request, reply) => {
      if (request.body?.scope !== "branch" || !request.body.idempotencyKey?.trim()) {
        return reply.code(400).send({ error: { code: "forbidden", message: "branch scope and idempotencyKey are required", retryable: false } });
      }
      try {
        const result = delegations.cancel(request.params.runId, request.body.idempotencyKey);
        for (const affected of result.affected) {
          const childThreadId = delegations.get(affected.runId)?.childThreadId;
          const active = childThreadId ? activeRuns.get(childThreadId) : undefined;
          if (active?.delegatedRunId === affected.runId) active.controller.abort();
        }
        return result;
      } catch (error) {
        return delegationFailure(error, reply);
      }
    },
  );

  app.get<{ Params: { runId: string } }>("/api/subagents/:runId/prompt", async (request, reply) => {
    // Raw prompts may contain secrets. They are never part of list/detail DTOs and
    // require the configured operator credential even on otherwise open installs.
    const promptAccess = request.headers["x-ponderosa-prompt-access"];
    if (!opts.authToken || typeof promptAccess !== "string" || !secretEqual(promptAccess, opts.authToken)) {
      return reply.code(403).send({ error: { code: "forbidden", message: "full prompt access is forbidden", retryable: false } });
    }
    const prompt = delegations.rawPrompt(request.params.runId);
    return prompt === undefined
      ? reply.code(404).send({ error: { code: "subagent_not_found", message: "subagent was not found", retryable: false } })
      : { prompt };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/threads", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    return store.listThreads(request.params.id);
  });

  const validatePreset = (input: { name?: string; description?: string; guidance?: string; engine?: string; model?: string | null; effort?: string | null }, partial = false): string | undefined => {
    if (!partial && (!input.name?.trim() || !input.description?.trim() || !input.guidance?.trim() || !input.engine)) return "name, description, guidance, and engine are required";
    if (input.name !== undefined && (input.name.trim().length < 2 || input.name.trim().length > 60)) return "name must be 2-60 characters";
    if (input.description !== undefined && input.description.trim().length > 240) return "description must be at most 240 characters";
    if (input.guidance !== undefined && (input.guidance.trim().length < 10 || input.guidance.trim().length > 8000)) return "guidance must be 10-8000 characters";
    if (input.engine) {
      const configured = engines.get(input.engine); if (!configured) return "unknown engine";
      if (input.model && !configured.adapter.listModels().some((x) => x.id === input.model)) return "model is not available for engine";
      if (input.effort && !configured.adapter.listEfforts().some((x) => x.id === input.effort)) return "effort is not available for engine";
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
    Body: { title: string; engine: string; masterChatId?: string; model?: string; effort?: string; initialMessage?: string; replyToMessageId?: string; presetId?: string };
  }>(
    "/api/projects/:id/threads",
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
      if (request.body.masterChatId) {
        const masterChat = store.getMasterChat(request.body.masterChatId);
        if (!masterChat || masterChat.projectId !== request.params.id) {
          return reply.code(400).send({ error: "master chat does not belong to project" });
        }
        if (request.body.replyToMessageId && !store.getMasterChatMessages(request.body.masterChatId, "main").some((message) => message.id === request.body.replyToMessageId)) {
          return reply.code(400).send({ error: "reply target was not found in this conversation" });
        }
      }
      const initialMessage = request.body.initialMessage?.trim();
      let thread; try { thread = store.createThread(request.params.id, request.body); } catch { return reply.code(400).send({ error: "preset is unavailable for this project" }); }
      if (initialMessage) {
        let initialCommunicationEventId: string | undefined;
        if (thread.masterChatId) {
          const communication = recordCommunication({
            eventId: randomUUID(), schemaVersion: 1, projectId: thread.projectId, masterChatId: thread.masterChatId,
            sender: { kind: "user", userId: "local-operator" }, intent: "broadcast",
            audience: { kind: "organization", organizationId: thread.projectId }, text: initialMessage,
            createdAt: new Date().toISOString(),
          });
          initialCommunicationEventId = communication?.eventId;
          store.appendMasterChatMessage(
            thread.masterChatId,
            { text: initialMessage, replyToMessageId: request.body.replyToMessageId },
            undefined, "main", undefined, undefined, initialCommunicationEventId,
          );
        }
        const turn = await app.inject({
          method: "POST",
          url: `/api/threads/${thread.id}/messages`,
          headers: {
            ...(opts.authToken ? { authorization: `Bearer ${opts.authToken}` } : {}),
            ...(initialCommunicationEventId ? { "x-ponderosa-turn-dispatch": turnDispatchKey } : {}),
          },
          payload: {
            text: initialMessage,
            model: request.body.model,
            effort: request.body.effort,
            sourceChannel: "main",
            ...(thread.masterChatId ? { sourceMasterChatId: thread.masterChatId } : {}),
            ...(initialCommunicationEventId ? { communicationEventId: initialCommunicationEventId } : {}),
          },
        });
        if (turn.statusCode >= 400) {
          store.deleteThread(thread.id);
          return reply.code(turn.statusCode).send(turn.json());
        }
      }
      return thread;
    },
  );

  app.get<{ Params: { id: string } }>("/api/threads/:id", async (request, reply) => {
    const detail = threadDetail(request.params.id);
    return detail ?? reply.code(404).send({ error: "thread not found" });
  });

  app.patch<{ Params: { id: string }; Body: { title?: string; archived?: boolean } }>(
    "/api/threads/:id",
    async (request, reply) => {
      const thread = store.updateThread(request.params.id, request.body ?? {});
      return thread ?? reply.code(404).send({ error: "thread not found" });
    },
  );

  app.put<{
    Params: { id: string };
    Body: { masterChatIds: string[]; primaryMasterChatId?: string };
  }>("/api/threads/:id/master-chat-memberships", async (request, reply) => {
    if (!Array.isArray(request.body?.masterChatIds)) {
      return reply.code(400).send({ error: "masterChatIds is required" });
    }
    try {
      const thread = store.updateThreadMasterChatMemberships(request.params.id, request.body);
      return thread ?? reply.code(404).send({ error: "thread not found" });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid membership" });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/threads/:id", async (request, reply) => {
    const { id } = request.params;
    // Abort any in-flight run so its process is killed before we remove the log.
    const run = activeRuns.get(id);
    if (run) {
      run.controller.abort();
      activeRuns.delete(id);
    }
    const delegated = delegations.findByChildThread(id);
    if (delegated && (delegated.status === "queued" || delegated.status === "running" || delegated.status === "awaiting_disposition")) {
      const cancelled = delegations.cancel(delegated.id, `thread-delete-${randomUUID()}`);
      for (const affected of cancelled.affected) {
        const childThreadId = delegations.get(affected.runId)?.childThreadId;
        const active = childThreadId ? activeRuns.get(childThreadId) : undefined;
        if (active?.delegatedRunId === affected.runId) active.controller.abort();
      }
    }
    const deleted = store.deleteThread(id);
    if (!deleted) return reply.code(404).send({ error: "thread not found" });
    return { deleted: true };
  });

  app.post("/api/threads/:id/switch-engine", async (_request, reply) =>
    reply.code(501).send({ error: "switch-engine is a v2 endpoint" }),
  );

  app.get("/api/threads/:id/search", async (_request, reply) =>
    reply.code(501).send({ error: "search is a v2 endpoint" }),
  );

  const assetMetadata = async (threadId: string, id: string) => {
    const thread = store.getThread(threadId);
    if (!thread) return undefined;
    const metadata = await assets.read(thread.projectId, thread.id, id);
    return metadata && await assets.content(thread.projectId, thread.id, id, false) ? metadata : undefined;
  };

  const limits = { ...ASSET_LIMITS, maxAttachmentsPerMessage: ASSET_LIMITS.maxAssetsPerMessage };
  app.get("/api/attachment-limits", async () => limits);
  app.get("/api/asset-limits", async () => ASSET_LIMITS);

  app.post<{ Params: { id: string }; Body: Buffer }>("/api/threads/:id/attachments", async (request, reply) => {
    const thread = store.getThread(request.params.id);
    if (!thread) return reply.code(404).send({ error: "thread not found" });
    const body = request.body;
    try {
      const asset = await assets.stage({ projectId: thread.projectId, threadId: thread.id, body,
        name: request.headers["x-ponderosa-filename"], declaredType: String(request.headers["x-ponderosa-media-type"] ?? request.headers["content-type"] ?? "") });
      return reply.code(201).send(asset);
    } catch (error) {
      if (error instanceof AssetError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.get<{ Params: { id: string; attachmentId: string } }>("/api/threads/:id/attachments/:attachmentId", async (request, reply) => {
    const thread = store.getThread(request.params.id);
    if (!thread) return reply.code(404).send({ error: "asset not found" });
    const content = await assets.content(thread.projectId, thread.id, request.params.attachmentId, true);
    if (!content) return reply.code(404).send({ error: "asset not found" });
    return reply.header("content-type", "image/png").header("content-disposition", "inline")
      .header("cache-control", "private, no-store").header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox").send(content.body);
  });

  app.get<{ Params: { id: string; assetId: string } }>("/api/threads/:id/assets/:assetId/preview", async (request, reply) => {
    const thread = store.getThread(request.params.id);
    if (!thread) return reply.code(404).send({ error: "asset not found" });
    const content = await assets.content(thread.projectId, thread.id, request.params.assetId, true);
    if (!content) return reply.code(404).send({ error: "asset not found" });
    return reply.header("content-type", "image/png").header("content-disposition", "inline")
      .header("cache-control", "private, no-store").header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox").send(content.body);
  });

  app.get<{ Params: { id: string; assetId: string } }>("/api/threads/:id/assets/:assetId/download", async (request, reply) => {
    if (request.headers.range) return reply.code(416).header("accept-ranges", "none").send({ error: "range requests are not supported" });
    const thread = store.getThread(request.params.id);
    if (!thread) return reply.code(404).send({ error: "asset not found" });
    const content = await assets.content(thread.projectId, thread.id, request.params.assetId, false);
    if (!content) return reply.code(404).send({ error: "asset not found" });
    return reply.header("content-type", "application/octet-stream")
      .header("content-disposition", contentDisposition(content.asset.name))
      .header("cache-control", "private, no-store").header("x-content-type-options", "nosniff")
      .header("accept-ranges", "none").send(content.body);
  });

  app.delete<{ Params: { id: string; attachmentId: string } }>("/api/threads/:id/attachments/:attachmentId", async (request, reply) => {
    const thread = store.getThread(request.params.id);
    if (!thread) return reply.code(404).send({ error: "asset not found" });
    const asset = await assets.read(thread.projectId, thread.id, request.params.attachmentId);
    if (!asset) return reply.code(404).send({ error: "asset not found" });
    if (asset.state === "associated") return reply.code(409).send({ error: "sent assets cannot be deleted" });
    if (!await assets.remove(thread.projectId, thread.id, request.params.attachmentId)) return reply.code(404).send({ error: "asset not found" });
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
      collaborationMasterChatId?: string;
      collaborationDeliveryId?: string;
      collaborationDeliveryIds?: string[];
      sourceChannel?: "main";
      sourceMasterChatId?: string;
      sourceAuthorThreadId?: string;
      replyToMessageId?: string;
      attachmentIds?: string[];
      /** Server-only link used when one action projects into room and audit timelines. */
      communicationEventId?: string;
    };
  }>(
    "/api/threads/:id/messages",
    async (request, reply) => {
      const thread = store.getThread(request.params.id);
      if (!thread) return reply.code(404).send({ error: "thread not found" });
      const project = store.getProject(thread.projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      const engine = engines.get(thread.activeEngine);
      if (!engine) return reply.code(400).send({ error: "unknown engine" });
      const text = request.body?.text?.trim() ?? "";
      const attachmentIds = request.body?.attachmentIds ?? [];
      if (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE || new Set(attachmentIds).size !== attachmentIds.length) return reply.code(400).send({ error: "at most 4 unique attachments are allowed" });
      const attached = (await Promise.all(attachmentIds.map((id) => assetMetadata(thread.id, id))));
      if (attached.some((item) => !item || item.threadId !== thread.id)) return reply.code(404).send({ error: "asset not found" });
      const messageAttachments = (attached as NonNullable<(typeof attached)[number]>[]).map(({ projectId: _projectId, originalFile: _originalFile, previewFile: _previewFile, associatedAt: _associatedAt, ...item }) => ({ ...item, state: "associated" as const })) as AssetDto[];
      if (messageAttachments.reduce((sum, item) => sum + item.size, 0) > ASSET_LIMITS.maxMessageBytes) return reply.code(413).send({ error: "message asset quota exceeded" });
      if (!text && messageAttachments.length === 0) return reply.code(400).send({ error: "text or an attachment is required" });
      if (text.length > MAX_TEXT_LENGTH) return reply.code(400).send({ error: "text must be 65536 characters or fewer" });
      const collaborationMasterChatId = request.body.collaborationMasterChatId;
      if (collaborationMasterChatId !== undefined && collaborationMasterChatId !== thread.masterChatId) {
        return reply.code(400).send({ error: "collaboration chat does not belong to thread" });
      }
      if (
        collaborationMasterChatId !== undefined &&
        request.headers["x-ponderosa-collaboration-dispatch"] !== collaborationDispatchKey
      ) {
        return reply.code(403).send({ error: "collaboration context must be delivered by an explicit recipient event" });
      }
      const sourceMasterChatId = request.body.sourceMasterChatId;
      if (sourceMasterChatId !== undefined && !thread.masterChatIds.includes(sourceMasterChatId)) {
        return reply.code(400).send({ error: "master chat does not belong to thread" });
      }
      if (request.body.sourceChannel === "main" && sourceMasterChatId) {
        const sourceMaster = store.getMasterChat(sourceMasterChatId);
        if (!sourceMaster || sourceMaster.archived) {
          return reply.code(400).send({ error: "archived master chats cannot route new turns" });
        }
      }
      const collaborationDeliveryId = request.body.collaborationDeliveryId;
      const collaborationDeliveryIds = request.body.collaborationDeliveryIds;
      const requestedDeliveryIds = collaborationDeliveryIds ?? (collaborationDeliveryId ? [collaborationDeliveryId] : []);
      const inboxDeliveries = requestedDeliveryIds.map((id) => collaborationDeliveries.get(id));
      const inboxDelivery = inboxDeliveries[0];
      if (
        requestedDeliveryIds.length > 0 &&
        (request.headers["x-ponderosa-collaboration-dispatch"] !== collaborationDispatchKey ||
          inboxDeliveries.some((delivery) => delivery?.targetThreadId !== thread.id || delivery.status !== "delivered") ||
          (inboxDelivery?.kind !== "direct" && !collaborationMasterChatId))
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
        ? recordCommunication({
            eventId: randomUUID(), schemaVersion: 1, projectId: project.id,
            ...(sourceMasterChatId ? { masterChatId: sourceMasterChatId } : {}),
            sender: { kind: "user", userId: "local-operator" }, intent: "collaboration",
            audience: { kind: "agents", agentIds: [thread.id] }, text,
            createdAt: new Date().toISOString(),
          })?.eventId
        : inheritedCommunicationEventId);
      const mentionDepth = request.body.agentMentionDepth;
      if (
        mentionDepth !== undefined &&
        (!Number.isInteger(mentionDepth) || mentionDepth < 0 || mentionDepth > MAX_AGENT_MENTION_RELAYS)
      ) {
        return reply.code(400).send({ error: "agentMentionDepth must be an integer from 0 to 12" });
      }
      const mentionTrail = request.body.agentMentionTrail ?? [];
      if (
        !Array.isArray(mentionTrail) ||
        mentionTrail.length > MAX_AGENT_MENTION_RELAYS ||
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
        collaborationMasterChatId,
        collaborationDeliveryId,
        collaborationDeliveryIds,
        sourceChannel: request.body.sourceChannel === "main" ? "main" : undefined,
        sourceAuthorThreadId: request.body.sourceAuthorThreadId,
        replyToMessageId: request.body.replyToMessageId,
        replyTo: request.body.replyToMessageId
          ? (() => {
              const target = threadMessages(thread.id).find((message) => message.id === request.body.replyToMessageId);
              return target ? { messageId: target.id, text: target.text, role: target.role } : undefined;
            })()
          : undefined,
      };
      if (request.body.replyToMessageId && !pendingTurn.replyTo) {
        return reply.code(400).send({ error: "reply target was not found in this conversation" });
      }
      if (activeRuns.has(thread.id)) {
        if (messageAttachments.length) return reply.code(409).send({ error: "wait for the active turn before sending attachments", retryable: true });
        // A dispatcher that lost the claim race needs to restore the dequeued
        // item at the head itself; ordinary manager and agent messages join the
        // FIFO queue and receive an explicit acknowledgement.
        if (request.headers["x-ponderosa-turn-dispatch"] === turnDispatchKey) {
          return reply.code(409).send({ error: "thread already has an active run" });
        }
        const createdAt = new Date().toISOString();
        const delivery = queueCollaborationDelivery({
          masterChatId: thread.masterChatId,
          messageId: `direct-${randomUUID()}`,
          communicationEventId,
          targetThreadId: thread.id,
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
        const position = collaborationDeliveries.pendingCount(thread.id);
        return reply.code(202).send({ queued: true, position, communicationEventId });
      }

      const fullHistory: ChatMessage[] = threadMessages(thread.id).map((message) => ({
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        attachments: message.attachments?.map((item) => ({
          name: item.name,
          mediaType: item.mediaType,
          size: item.size,
          localPath: path.join(attachmentsDir(opts.dataDir, thread.projectId, thread.id), `${item.id}.bin`),
          available: existsSync(path.join(attachmentsDir(opts.dataDir, thread.projectId, thread.id), `${item.id}.bin`)),
        })),
      }));
      const runId = randomUUID();
      const controller = new AbortController();
      const messageCapability = randomUUID();
      const delegationCapability = randomUUID();
      const delegatedObjective = delegations.findByChildThread(thread.id);
      const resumeSessionId = store.resumeSessionId(thread.id);
      const mode = resumeSessionId ? "continue" : "seed";
      const history = boundedSeedHistory(fullHistory);

      // Main-chat turns receive the manager-facing room. Collaboration context is
      // assembled only after the collaboration endpoint successfully tagged this
      // particular linked agent.
      const routingMasterChatId = sourceMasterChatId ?? thread.masterChatId;
      const masterChat = routingMasterChatId
        ? masterChatDetail(routingMasterChatId)
        : undefined;
      const collaboration = collaborationMasterChatId
        ? collaborationChatDetail(collaborationMasterChatId)
        : undefined;
      const sourceChannel: AgentMessageChannel = collaboration
        ? "collaboration"
        : request.body.sourceChannel === "main"
          ? "main"
          : "individual";
      const contextThreads = collaboration?.threads ?? masterChat?.threads ?? [thread];
      const sourceAuthor = collaboration && request.body.sourceAuthorThreadId
        ? contextThreads.find((candidate) => candidate.id === request.body.sourceAuthorThreadId)?.title ?? "Agent"
        : "Manager";
      const context = inboundContext(sourceChannel, sourceAuthor, text, contextThreads, thread.id);
      const cursorChannel = sourceChannel === "main" || sourceChannel === "collaboration" ? sourceChannel : undefined;
      const cursorMasterChatId = cursorChannel ? routingMasterChatId : undefined;
      const cursorModel = request.body.model ?? "(default)";
      const routingMetadata = cursorMasterChatId && cursorChannel
        ? [
            "Current room routing and membership:",
            `- room: ${cursorMasterChatId}`,
            `- channel: ${cursorChannel}`,
            `- primary room: ${thread.masterChatId ?? "none"}`,
            `- room memberships: ${thread.masterChatIds.join(", ") || "none"}`,
            `- visible agents: ${contextThreads.map((candidate) => `${candidate.title} (${candidate.id})`).join(", ") || "none"}`,
          ].join("\n")
        : undefined;
      const routingHash = createHash("sha256").update(routingMetadata ?? "").digest("hex");
      const cursorScope = resumeSessionId && cursorMasterChatId && cursorChannel
        ? {
            threadId: thread.id,
            engine: thread.activeEngine,
            model: cursorModel,
            sessionId: resumeSessionId,
            masterChatId: cursorMasterChatId,
            channel: cursorChannel,
          }
        : undefined;
      const latestSessionCursor = resumeSessionId ? contextCursors.latestForSession(thread.id, resumeSessionId) : undefined;
      const sameEngineModelEpoch = !latestSessionCursor ||
        (latestSessionCursor.engine === thread.activeEngine && latestSessionCursor.model === cursorModel);
      const previousCursor = cursorScope && sameEngineModelEpoch ? contextCursors.get(cursorScope) : undefined;
      const allRoomMessages = collaboration
        ? recipientCollaborationMessages(
            collaboration.messages,
            store.readCommunicationEvents(project.id),
            project.id,
            thread.id,
          )
        : masterChat && sourceChannel === "main" ? masterChat.messages : [];
      const previousIndex = previousCursor?.lastMessageId
        ? allRoomMessages.findIndex((message) => message.id === previousCursor.lastMessageId)
        : -1;
      // A missing cursor target means canonical history was cleared or replaced;
      // reseed rather than assuming that later rows were already delivered.
      const incremental = previousCursor !== undefined && (!previousCursor.lastMessageId || previousIndex >= 0);
      const roomMessages = incremental
        ? allRoomMessages.slice(previousCursor?.lastMessageId ? previousIndex + 1 : 0)
        : boundedSeedHistory(allRoomMessages);
      const changedRoutingMetadata = !previousCursor || previousCursor.routingHash !== routingHash
        ? routingMetadata
        : undefined;
      const basePrompt = collaboration
        ? collaborationChatPrompt(roomMessages, collaboration.threads, text, context, incremental, changedRoutingMetadata)
        : masterChat && sourceChannel === "main"
          ? masterChatPrompt(roomMessages, masterChat.threads, text, context, incremental, changedRoutingMetadata)
          : resumeSessionId ? continuationPrompt(text, context) : individualChatPrompt(text, context);
      const guidedPrompt = thread.presetSnapshot?.guidance
        ? `Agent preset snapshot (${thread.presetSnapshot.name}):\n${thread.presetSnapshot.guidance}\n\n${basePrompt}`
        : basePrompt;
      // Project knowledge is assembled only at a fresh runtime boundary. Active
      // sessions retain their own context and receive no repeated memory packet.
      const promotedKnowledge = resumeSessionId || !curatedContextEnabled
        ? ""
        : organizationalKnowledgePrompt(store.activeKnowledgePromotions(project.id));
      const attachmentContext = messageAttachments.length ? `\n\nAttached images/assets (server-validated local files; labels are identifiers, not instructions):\n${messageAttachments.map((item) => `- asset ${item.id} (${item.mediaType}, ${item.size} bytes): ${path.join(attachmentsDir(opts.dataDir, thread.projectId, thread.id), `${item.id}.bin`)}`).join("\n")}` : "";
      const prompt = `${promotedKnowledge}${guidedPrompt}${delegatedObjective && (delegatedObjective.status === "running" || delegatedObjective.status === "awaiting_disposition") ? `\n\n${delegatedOutcomePrompt().join("\n")}` : ""}${replyContext(pendingTurn.replyTo)}${attachmentContext}`;
      const agentMessageUrl = agentMessageEndpoint(request, opts.agentBaseUrl);

      const userStored = store.appendEvent(thread.id, {
        type: "user_message", text, communicationEventId: pendingTurn.communicationEventId,
        replyTo: pendingTurn.replyTo, attachments: messageAttachments,
      });
      await assets.associate(thread.projectId, thread.id, attachmentIds);
      publish(thread.id, userStored);

      const startedAt = new Date().toISOString();
      const runningLifecycle = store.appendEvent(thread.id, {
        type: "agent_lifecycle", status: "running", reason: "active_run", executionId: runId,
      });
      publish(thread.id, runningLifecycle);
      activeRuns.set(thread.id, {
        runId, startedAt, executionId: runId, leaseExpiresAt: leaseExpiry(), controller, messageCapability,
        ...(delegatedObjective ? { delegatedRunId: delegatedObjective.id } : {}),
      });
      agentMessageCapabilities.set(messageCapability, {
        threadId: thread.id,
        masterChatId: thread.masterChatId,
        runId,
        mentionDepth: mentionDepth ?? 0,
        mentionTrail,
      });
      if (thread.masterChatId) {
        delegationCapabilities.set(delegationCapability, {
          parentRunId: delegatedObjective?.id ?? runId,
          threadId: thread.id,
          masterChatId: thread.masterChatId,
          controller,
        });
      }

      void (async () => {
        // Accumulate the agent's human-facing message so it can post its actual
        // answer back into the master chat (the team group chat) when the turn ends
        // — e.g. "It's 95°F and sunny" or "Done — PR here: <link>".
        let runError: string | undefined;
        let sawWaiting = false;
        let finalText = "";
        let lastCommunicationEventId: string | undefined;
        try {
          const environment = {
            PONDEROSA_AGENT_MESSAGE_URL: agentMessageUrl,
            PONDEROSA_AGENT_MESSAGE_TOKEN: messageCapability,
            PONDEROSA_AGENT_ROLLOVER_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-session/rollover`,
            PONDEROSA_DELEGATION_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-delegations`,
            PONDEROSA_DELEGATION_OUTCOME_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-delegation-outcomes`,
            PONDEROSA_DELEGATION_TOKEN: delegationCapability,
            PONDEROSA_INTERNAL_SUBAGENTS_DISABLED: "1",
          };
          const startStream = (sessionId?: string): AsyncIterable<AgentEvent> => sessionId
            ? engine.adapter.continue({
                  threadId: thread.id,
                  cwd: project.hostPath,
                  prompt,
                  resumeSessionId: sessionId,
                  model: request.body.model,
                  effort: request.body.effort,
                  environment,
                  signal: controller.signal,
                })
            : engine.adapter.seed({
                  threadId: thread.id,
                  cwd: project.hostPath,
                  prompt,
                  history,
                  model: request.body.model,
                  effort: request.body.effort,
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
              if (closed || controller.signal.aborted) break;
              renewExecutionLease(thread.id);
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
                store.clearResumeSession(thread.id, "resume_compaction_failed");
                sessionId = undefined;
                rolloverAttempted = true;
                retryFresh = true;
                break;
              }

              for (const buffered of bufferedSessionEvents.splice(0)) {
                const stored = store.appendEvent(thread.id, buffered);
                publish(thread.id, stored);
              }
              if (event.type !== "error") sawMaterialRuntimeEvent = true;
              let logEvent: LogEvent = event;
              if (event.type === "text" && event.delta.trim()) {
                const communication = recordCommunication({
                  eventId: randomUUID(), schemaVersion: 1, projectId: project.id,
                  ...(routingMasterChatId ? { masterChatId: routingMasterChatId } : {}),
                  sender: { kind: "agent", agentId: thread.id, executionId: runId },
                  intent: "direct_to_user",
                  audience: { kind: "user", userId: "local-operator" },
                  text: event.delta,
                  createdAt: new Date().toISOString(),
                  ...(pendingTurn.communicationEventId ? { causationId: pendingTurn.communicationEventId } : {}),
                });
                if (communication) store.appendCommunicationProjection(project.id, {
                  eventId: communication.eventId,
                  surface: "user_inbox",
                  projectionKey: "local-operator",
                  projectedAt: communication.createdAt,
                });
                lastCommunicationEventId = communication?.eventId;
                if (communication) logEvent = { ...event, communicationEventId: communication.eventId };
              }
              const stored = store.appendEvent(thread.id, logEvent);
              publish(thread.id, stored);
              if (event.type === "text") finalText += event.delta;
              if (event.type === "error") runError = event.message;
              if (event.type === "task_update" && event.status === "waiting_approval") sawWaiting = true;
            }
            if (!retryFresh) break;
          }
        } catch (err) {
          if (closed || controller.signal.aborted) return;
          const message = err instanceof Error ? err.message : String(err);
          const stored = store.appendEvent(thread.id, { type: "error", message });
          publish(thread.id, stored);
          runError = message;
        } finally {
          if (scheduledSessionRollovers.delete(thread.id)) {
            store.clearResumeSession(thread.id, "explicit_compaction");
          }
          if (delegatedObjective && !controller.signal.aborted) {
            const settled = delegations.finishRuntime(delegatedObjective.id, runError);
            if (settled.status === "failed") notifyParentOfDelegatedCompletion(settled);
          }
          if (!closed && !controller.signal.aborted) {
            const terminal = store.appendEvent(thread.id, {
              type: "agent_lifecycle",
              status: runError ? "failed" : "completed",
              reason: runError ? "runtime_error" : "turn_completed",
              executionId: runId,
            });
            publish(thread.id, terminal);
          }
          if (activeRuns.get(thread.id)?.controller === controller) activeRuns.delete(thread.id);
          agentMessageCapabilities.delete(messageCapability);
          delegationCapabilities.delete(delegationCapability);
          // Post a group-chat status unless the run was cancelled/aborted (cancel or
          // thread deletion), in which case a report-back would be misleading.
          if (routingMasterChatId && sourceChannel !== "individual" && !controller.signal.aborted) {
            const statusText = runError
              ? `⚠️ Stuck — ${runError.slice(0, 200)}`
              : summarizeFinalMessage(finalText) ??
                (sawWaiting ? "⏸️ Waiting for your input" : "✅ Finished");
            try {
              const routing = !runError && collaborationMasterChatId && legacyRoutingMode === "accept"
                ? resolveCollaborationIntents(
                    collaborationMasterChatId,
                    thread.id,
                    statusText,
                    mentionDepth ?? 0,
                    mentionTrail,
                  )
                : { intents: [], blocked: [] };
              const reportCommunication = sourceChannel === "main"
                ? recordCommunication({
                    eventId: randomUUID(), schemaVersion: 1, projectId: project.id,
                    masterChatId: routingMasterChatId,
                    sender: { kind: "agent", agentId: thread.id, executionId: runId },
                    intent: "broadcast", audience: { kind: "organization", organizationId: project.id },
                    text: statusText, createdAt: new Date().toISOString(),
                    ...(lastCommunicationEventId ? { causationId: lastCommunicationEventId } : {}),
                  })
                : routing.intents.length
                  ? recordCommunication({
                      eventId: randomUUID(), schemaVersion: 1, projectId: project.id,
                      masterChatId: routingMasterChatId,
                      sender: { kind: "agent", agentId: thread.id, executionId: runId },
                      intent: "collaboration",
                      audience: { kind: "agents", agentIds: routing.intents.map((item) => item.targetThreadId) as [string, ...string[]] },
                      text: statusText, createdAt: new Date().toISOString(),
                      ...(lastCommunicationEventId ? { causationId: lastCommunicationEventId } : {}),
                    })
                  : recordCommunication({
                      eventId: randomUUID(), schemaVersion: 1, projectId: project.id,
                      masterChatId: routingMasterChatId,
                      sender: { kind: "agent", agentId: thread.id, executionId: runId },
                      intent: "direct_to_user", audience: { kind: "user", userId: "local-operator" },
                      text: statusText, createdAt: new Date().toISOString(),
                      ...(lastCommunicationEventId ? { causationId: lastCommunicationEventId } : {}),
                    });
              // The main chat is manager-facing. Agent-to-agent handoffs are
              // emitted only from the separate collaboration chat.
              const report = store.appendMasterChatMessage(
                routingMasterChatId,
                { role: "assistant", text: statusText },
                thread.id,
                sourceChannel,
                routing.intents,
                undefined,
                reportCommunication?.eventId,
              );
              if (reportCommunication?.intent === "direct_to_user") {
                store.appendCommunicationProjection(project.id, {
                  eventId: reportCommunication.eventId,
                  surface: "user_inbox",
                  projectionKey: "local-operator",
                  projectedAt: reportCommunication.createdAt,
                });
              }

              // A tag in a main-chat report is ordinary text. A tag in the
              // collaboration chat is an opt-in handoff and can start a turn.
              if (!runError && collaborationMasterChatId && report) {
                queueRecordedCollaborationMessage(collaborationMasterChatId, report, thread.id, routing.intents);
                appendBlockedMentionWarnings(collaborationMasterChatId, routing.blocked);
              }
            } catch {
              // Master chat may have been deleted mid-run; ignore.
            }
          }
          if (!closed && requestedDeliveryIds.length) {
            // A cancelled delivery turn is not an acknowledgement. Put it back
            // into the durable queue; ordinary pending deliveries remain queued.
            if (controller.signal.aborted) collaborationDeliveries.requeueBatch(requestedDeliveryIds);
            else if (runError) {
              for (const id of requestedDeliveryIds) collaborationDeliveries.retryFailedTurn(id, runError);
            }
            else collaborationDeliveries.acknowledgeBatch(requestedDeliveryIds);
            for (const id of requestedDeliveryIds) syncDelegatedCompletion(id);
          }
          if (!closed && !controller.signal.aborted && !runError && cursorMasterChatId && cursorChannel) {
            const acceptedSessionId = store.resumeSessionId(thread.id);
            if (acceptedSessionId) {
              contextCursors.commit({
                threadId: thread.id,
                engine: thread.activeEngine,
                model: cursorModel,
                sessionId: acceptedSessionId,
                masterChatId: cursorMasterChatId,
                channel: cursorChannel,
                lastMessageId: allRoomMessages.at(-1)?.id,
                routingHash,
              });
            }
          }
          // Mentions received while this agent was working are never dropped.
          // Start the oldest queued follow-up as soon as its current turn closes.
          void dispatchNextTurn(thread.id);
        }
      })();

      return { queued: false, runId, mode, communicationEventId };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { lastEventId?: string } }>(
    "/api/threads/:id/stream",
    async (request, reply) => {
      if (!store.getThread(request.params.id)) return reply.code(404).send({ error: "thread not found" });
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
      const writeStored = (stored: StoredLogEvent): void => {
        if (stored.seq <= lastWrittenSeq) return;
        const env = envelope(request.params.id, stored);
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
        writeStored(stored);
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

  app.post<{ Params: { id: string } }>("/api/threads/:id/cancel", async (request) => {
    const run = activeRuns.get(request.params.id);
    if (!run) return { cancelled: false };
    run.controller.abort();
    const lifecycle = store.appendEvent(request.params.id, {
      type: "agent_lifecycle", status: "cancelled", reason: "thread_cancelled",
    });
    publish(request.params.id, lifecycle);
    if (run.delegatedRunId) {
      delegations.cancel(run.delegatedRunId, `thread-cancel-${randomUUID()}`);
    }
    return { cancelled: true };
  });

  app.post<{ Params: { id: string } }>("/api/threads/:id/compact", async (request, reply) => {
    if (!store.getThread(request.params.id)) return reply.code(404).send({ error: "thread not found" });
    if (activeRuns.has(request.params.id)) {
      return reply.code(409).send({ error: "cannot compact a thread with an active run", retryable: true });
    }
    return { compacted: store.clearResumeSession(request.params.id, "explicit_compaction") };
  });

  app.get<{ Params: { id: string } }>("/api/threads/:id/tasks", async (request, reply) => {
    if (!store.getThread(request.params.id)) return reply.code(404).send({ error: "thread not found" });
    return store.getTasks(request.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/threads/:id/artifacts", async (request, reply) => {
    if (!store.getThread(request.params.id)) return reply.code(404).send({ error: "thread not found" });
    return store.getArtifacts(request.params.id);
  });

  app.get<{ Params: { id: string; aid: string } }>(
    "/api/threads/:id/artifacts/:aid",
    async (request, reply) => {
      const thread = store.getThread(request.params.id);
      if (!thread) return reply.code(404).send({ error: "thread not found" });
      const artifact = store.getArtifact(thread.id, request.params.aid);
      if (!artifact) return reply.code(404).send({ error: "artifact not found" });
      const file = artifactContentPath(opts.dataDir, thread.projectId, thread.id, artifact.path);
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
        return {
          id: adapter.id,
          displayName: adapter.displayName,
          models: adapter.listModels(),
          efforts: adapter.listEfforts(),
          authenticated: status.authenticated,
          authDetail: status.detail,
        };
      }),
    );
  });

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
