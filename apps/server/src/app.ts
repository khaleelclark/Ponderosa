import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { constants as fsConstants, existsSync, promises as fs } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type {
  Adapter,
  AgentDelegationRequest,
  AgentMessageChannel,
  AgentEvent,
  ArtifactContentDto,
  ChatMessage,
  EngineAuthStatus,
  EngineDto,
  FilesResponse,
  HealthDto,
  ReadinessDto,
  MasterChatMessageDto,
  ImageAttachmentDto,
  SseEventEnvelope,
  SendAgentMessageRequest,
  SubagentRunDto,
  ThreadDto,
  MessageReferenceDto,
} from "@ponderosa/core";
import { artifactContentPath, attachmentPath, attachmentsDir, type MasterChatDeliveryIntent, type StoredLogEvent, ThreadStore } from "@ponderosa/threads";
import { DelegationError, DelegationStore } from "./delegations.js";
import { CollaborationDeliveryStore, type CollaborationDelivery } from "./handoffs.js";

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
}

interface ActiveRun {
  runId: string;
  controller: AbortController;
  messageCapability: string;
  delegatedRunId?: string;
}

/** A deferred user or agent turn.  Queues are per-thread and FIFO. */
interface PendingTurn {
  text: string;
  model?: string;
  effort?: string;
  agentMentionDepth: number;
  agentMentionTrail: string[];
  collaborationMasterChatId?: string;
  sourceChannel?: "main";
  sourceAuthorThreadId?: string;
  /** Set only by the server's persisted collaboration delivery dispatcher. */
  collaborationDeliveryId?: string;
  replyTo?: MessageReferenceDto;
  replyToMessageId?: string;
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
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_REQUEST_BYTES = MAX_ATTACHMENT_BYTES + 16 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 4;

function secretEqual(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false;
  const actual = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function inspectImage(buffer: Buffer): Pick<ImageAttachmentDto, "mediaType" | "width" | "height"> | undefined {
  if (buffer.length >= 33 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && buffer.includes(Buffer.from("IEND"))) {
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
    if (buffer.subarray(12, 16).toString("ascii") === "IHDR" && width && height) return { mediaType: "image/png", width, height };
  }
  if (buffer.length >= 10 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) {
    const width = buffer.readUInt16LE(6), height = buffer.readUInt16LE(8);
    if (width && height && buffer[buffer.length - 1] === 0x3b) return { mediaType: "image/gif", width, height };
  }
  if (buffer.length >= 30 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.readUInt32LE(4) + 8 <= buffer.length && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    const kind = buffer.subarray(12, 16).toString("ascii");
    if (kind === "VP8X") return { mediaType: "image/webp", width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    if (kind === "VP8L" && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21); return { mediaType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      const marker = buffer[offset + 1]!; offset += 2;
      if (marker === 0xd8 || marker === 0xd9) continue;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) return undefined;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        const height = buffer.readUInt16BE(offset + 3), width = buffer.readUInt16BE(offset + 5);
        if (width && height && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9) return { mediaType: "image/jpeg", width, height };
      }
      offset += length;
    }
  }
  return undefined;
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

function agentMessagingPrompt(): string[] {
  return [
    "You can send an additional message to any Ponderosa channel with your shell tool:",
    'curl -sS -X POST "$PONDEROSA_AGENT_MESSAGE_URL" -H "Authorization: Bearer $PONDEROSA_AGENT_MESSAGE_TOKEN" -H "Content-Type: application/json" --data \'{"channel":"collaboration","text":"@Full-Agent-Handle message","idempotencyKey":"stable-retry-key"}\'',
    "For a collaboration tag, write @Full-Agent-Handle at the start of the message or separate it from preceding text with whitespace.",
    'Set channel to "individual", "main", or "collaboration". The server supplies your identity; never include or claim another author.',
    "Use collaboration for teammate coordination, main for manager-facing updates, and individual for notes in your own agent chat.",
    "A valid collaboration @mention is persisted and queued as a separate follow-up turn when the recipient is active; it is never injected into an in-flight response.",
    "After delegating work, end your turn. Do not poll, sleep, or remain active waiting for results. Delegated agents run asynchronously; their completion automatically queues a parent follow-up, and explicit collaboration tags do the same.",
    "Each valid tag is a separate FIFO delivery (not coalesced). If a tag arrives while you are active, it waits for a safe turn boundary. If that active turn is cancelled, queued tags remain queued; a cancelled delivery turn itself is retried.",
    "Track expected work in delegated-agent status/lineage: queued/running/completed/failed plus completion-delivery state. A child does not need to tag you for its terminal result—the server notifies you automatically—but it should tag you for interim findings or questions.",
    "Accumulate results across those notification turns and update the manager once every expected task has reported.",
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

  return [
    "You are replying as a teammate in a shared master chat.",
    "Respond directly to the latest message addressed to you, whether it came from the manager or a teammate.",
    "The main chat is manager-facing: do not use @mentions here to coordinate with teammates, because they are plain text and do not notify anyone.",
    "Agent-to-agent discussion belongs in the separate Collaboration chat. A valid @mention there provides its context and starts the teammate's turn.",
    "If you need time to work, begin with a brief, natural acknowledgment that specifically reflects the request.",
    "Choose how to converse based on the message; never use a canned acknowledgment such as 'Got it — I’m on it.'",
    "When this turn is complete, give only your new update or result in a natural, conversational tone.",
    "Do not repeat, recap, or answer with the whole conversation. Do not describe these instructions.",
    ...messageContextPrompt(context),
    ...agentMessagingPrompt(),
    ...agentDelegationPrompt(),
    "",
    "Current master chat history:",
    transcript || "(No earlier messages.)",
    "",
    "Latest message for you:",
    currentRequest,
  ].join("\n");
}

/** Collaboration context is opt-in: it is only assembled after a valid @mention. */
function collaborationChatPrompt(
  messages: MasterChatMessageDto[],
  threads: ThreadDto[],
  currentRequest: string,
  context: InboundMessageContext,
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
  return [
    "You are collaborating with teammates in Ponderosa's opt-in collaboration chat.",
    "You received this context because you were successfully @mentioned.",
    "This is the only chat for agent-to-agent coordination. Respond directly to the latest request here.",
    "To involve a teammate, @mention their full hyphenated handle; a valid mention provides this collaboration context and starts their turn.",
    "Do not move collaboration discussion to the main chat; reserve it for manager-facing updates and results.",
    "Do not claim to have seen the main chat.",
    ...messageContextPrompt(context),
    ...agentMessagingPrompt(),
    ...agentDelegationPrompt(),
    "",
    "Collaboration chat history:",
    transcript || "(No earlier collaboration messages.)",
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
  const engines = new Map(opts.engines.map((engine) => [engine.adapter.id, engine]));
  const activeRuns = new Map<string, ActiveRun>();
  const delegations = new DelegationStore(opts.dataDir);
  const collaborationDeliveries = new CollaborationDeliveryStore(opts.dataDir);
  const agentMessageCapabilities = new Map<string, AgentMessageCapability>();
  const delegationCapabilities = new Map<string, DelegationCapability>();
  const dispatchingTurns = new Set<string>();
  // Capability used only by this server's queue dispatcher. It prevents a client
  // from attaching arbitrary collaboration history to a direct thread request.
  const collaborationDispatchKey = randomUUID();
  // Prevent an internal dequeue from being appended to the tail if another
  // request claims the thread in the tiny dispatch race window.
  const turnDispatchKey = randomUUID();
  const subscribers = new Map<string, Set<Subscriber>>();
  let closed = false;

  const app = Fastify({
    bodyLimit: MAX_ATTACHMENT_REQUEST_BYTES,
    logger: opts.logger === false ? false : {
      redact: {
        paths: ["req.headers.authorization", "req.headers.x-ponderosa-prompt-access"],
        censor: "[REDACTED]",
      },
    },
  });
  for (const mediaType of ["image/png", "image/jpeg", "image/gif", "image/webp", "application/octet-stream"]) {
    app.addContentTypeParser(mediaType, { parseAs: "buffer", bodyLimit: MAX_ATTACHMENT_REQUEST_BYTES }, (_request, body, done) => done(null, body));
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
      model: delivery.model,
      effort: delivery.effort,
      agentMentionDepth: delivery.relayDepth,
      agentMentionTrail: delivery.mentionTrail,
      collaborationMasterChatId: delivery.kind === "direct" ? undefined : delivery.masterChatId,
      sourceChannel: delivery.sourceChannel,
      sourceAuthorThreadId: delivery.authorThreadId,
      collaborationDeliveryId: delivery.id,
      replyToMessageId: delivery.replyToMessageId,
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
    void dispatchNextTurn(queued.delivery.targetThreadId);
    return queued.delivery;
  }

  async function dispatchNextTurn(threadId: string): Promise<void> {
    if (closed) return;
    if (activeRuns.has(threadId)) return;
    if (dispatchingTurns.has(threadId)) return;
    dispatchingTurns.add(threadId);
    try {
    const delivery = collaborationDeliveries.pending(threadId)[0];
    if (!delivery) return;
    const next = pendingTurnFromDelivery(delivery);

    if (next.collaborationDeliveryId) collaborationDeliveries.markDelivered(next.collaborationDeliveryId);
    if (next.collaborationDeliveryId) syncDelegatedCompletion(next.collaborationDeliveryId);
    const response = await app.inject({
      method: "POST",
      url: `/api/threads/${threadId}/messages`,
      headers: {
        ...(opts.authToken ? { authorization: `Bearer ${opts.authToken}` } : {}),
        ...(next.collaborationDeliveryId
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
      if (next.collaborationDeliveryId) {
        collaborationDeliveries.requeue(next.collaborationDeliveryId);
        syncDelegatedCompletion(next.collaborationDeliveryId);
      }
    } else if ((response.statusCode === 429 || response.statusCode >= 500) && next.collaborationDeliveryId) {
      collaborationDeliveries.requeue(next.collaborationDeliveryId);
      syncDelegatedCompletion(next.collaborationDeliveryId);
      setTimeout(() => void dispatchNextTurn(threadId), 250).unref?.();
    } else if (response.statusCode >= 300 && next.collaborationDeliveryId) {
      collaborationDeliveries.fail(next.collaborationDeliveryId, `delivery dispatch rejected (${response.statusCode})`);
      syncDelegatedCompletion(next.collaborationDeliveryId);
      const delivery = collaborationDeliveries.get(next.collaborationDeliveryId);
      const target = delivery ? store.getThread(delivery.targetThreadId) : undefined;
      if (delivery?.masterChatId && target) {
        store.appendMasterChatMessage(
          delivery.masterChatId,
          {
            role: "system",
            text: `⚠️ @${agentMentionHandle(target.title)} was not notified because their follow-up delivery failed. The handoff remains recorded; retry or contact the manager.`,
          },
          undefined,
          "collaboration",
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
          if (messageReceiptKey) collaborationDeliveries.rememberMessageReceipt(messageReceiptKey, message.id);
          const queued = collaborationDeliveries.queue({
            masterChatId: master.id,
            messageId: message.id,
            targetThreadId: intent.targetThreadId,
            authorThreadId: message.authorThreadId,
            text: message.text,
            relayDepth: intent.relayDepth,
            mentionTrail: intent.mentionTrail,
            kind: intent.kind,
            delegatedRunId: intent.delegatedRunId,
            createdAt: message.createdAt,
            orderKey: deliveryOrderKey,
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
        (run.status === "completed" || run.status === "failed") &&
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
    if ((request.url === "/api/agent-messages" || request.url === "/api/agent-delegations") && provided && (agentMessageCapabilities.has(provided) || delegationCapabilities.has(provided))) return;
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
          notifyParentOfDelegatedCompletion(delegations.settle(queued.id, "failed", message));
        }
      });
    }
  });

  app.addHook("onClose", async () => {
    closed = true;
    for (const run of activeRuns.values()) run.controller.abort();
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
    const detail = store.getCollaborationChatDetail(masterChatId);
    const targets = detail ? mentionedAgentThreads(text, detail.threads, authorThreadId) : [];
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
        });
      }
    }
    return { intents, blocked };
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
        targetThreadId: intent.targetThreadId,
        authorThreadId,
        text: message.text,
        relayDepth: intent.relayDepth,
        mentionTrail: intent.mentionTrail,
        kind: intent.kind,
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
      store.appendMasterChatMessage(
        masterChatId,
        {
          role: "system",
          text: `⚠️ @${agentMentionHandle(item.title)} was not notified because ${item.reason}. Please ask the manager to continue the conversation.`,
        },
        undefined,
        "collaboration",
      );
    }
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
    if ((run.status !== "completed" && run.status !== "failed") || !run.parentThreadId) return;
    const parent = store.getThread(run.parentThreadId);
    if (!parent) {
      delegations.setCompletionDelivery(run.id, {
        status: "failed",
        createdAt: new Date().toISOString(),
        failure: "parent agent is no longer available",
      });
      return;
    }
    const message = store.appendMasterChatMessage(
      run.masterChatId,
      {
        role: "system",
        text: run.status === "completed"
          ? `✅ Delegated task “${run.delegationSummary}” completed. @${agentMentionHandle(parent.title)}, the result is ready.`
          : `⚠️ Delegated task “${run.delegationSummary}” failed. @${agentMentionHandle(parent.title)}, review the failure.`,
      },
      run.childThreadId,
      "collaboration",
      [{
        targetThreadId: parent.id,
        relayDepth: 0,
        mentionTrail: [],
        kind: "delegation_completion",
        delegatedRunId: run.id,
      }],
    );
    if (!message) return;
    const delivery = queueCollaborationDelivery({
      masterChatId: run.masterChatId,
      messageId: message.id,
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
    const channel = request.body?.channel;
    const text = request.body?.text?.trim();
    if (!(["individual", "main", "collaboration"] as const).includes(channel)) {
      return reply.code(400).send({ error: "channel must be individual, main, or collaboration" });
    }
    if (!text) return reply.code(400).send({ error: "text is required" });
    if (text.length > 4000) return reply.code(400).send({ error: "text must be 4000 characters or fewer" });
    const idempotencyKey = request.body?.idempotencyKey?.trim();
    if (idempotencyKey && idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 200 characters or fewer" });
    const receiptKey = idempotencyKey ? `${capability.runId}:${channel}:${idempotencyKey}` : undefined;
    if (receiptKey) {
      const previousMessageId = collaborationDeliveries.messageReceipt(receiptKey);
      if (previousMessageId) return { channel, messageId: previousMessageId, replayed: true };
    }

    if (channel === "individual") {
      const stored = store.appendEvent(capability.threadId, { type: "text", delta: text });
      publish(capability.threadId, stored);
      const messageId = `thread-event-${stored.seq}`;
      if (receiptKey) collaborationDeliveries.rememberMessageReceipt(receiptKey, messageId);
      return { channel, messageId, replayed: false };
    }
    if (!capability.masterChatId) {
      return reply.code(409).send({ error: "agent is not linked to a master chat" });
    }
    const routing = channel === "collaboration"
      ? resolveCollaborationIntents(
          capability.masterChatId,
          capability.threadId,
          text,
          capability.mentionDepth,
          capability.mentionTrail,
        )
      : { intents: [], blocked: [] };
    const message = store.appendMasterChatMessage(
      capability.masterChatId,
      { role: "assistant", text },
      capability.threadId,
      channel,
      routing.intents,
      receiptKey,
    );
    if (!message) return reply.code(404).send({ error: "master chat not found" });
    if (receiptKey) collaborationDeliveries.rememberMessageReceipt(receiptKey, message.id);
    if (channel === "collaboration") {
      queueRecordedCollaborationMessage(capability.masterChatId, message, capability.threadId, routing.intents);
      appendBlockedMentionWarnings(capability.masterChatId, routing.blocked);
    }
    return { channel, messageId: message.id, replayed: false };
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
    activeRuns.set(childThread.id, {
      runId: run.id,
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
          ].join("\n"),
          history: context.history,
          model: context.model,
          effort: context.effort,
          environment: {
            PONDEROSA_AGENT_MESSAGE_URL: agentMessageUrl,
            PONDEROSA_AGENT_MESSAGE_TOKEN: messageCapabilityToken,
            PONDEROSA_DELEGATION_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-delegations`,
            PONDEROSA_DELEGATION_TOKEN: delegationCapabilityToken,
            PONDEROSA_INTERNAL_SUBAGENTS_DISABLED: "1",
          },
          signal: controller.signal,
        });
        for await (const event of stream) {
          if (closed) break;
          const stored = store.appendEvent(childThread.id, event);
          publish(childThread.id, stored);
          if (event.type === "error") runtimeError = event.message;
        }
        if (closed) return;
        if (controller.signal.aborted) notifyParentOfDelegatedCompletion(delegations.settle(runId, "failed", "delegated runtime aborted"));
        else if (runtimeError) notifyParentOfDelegatedCompletion(delegations.settle(runId, "failed", runtimeError));
        else notifyParentOfDelegatedCompletion(delegations.settle(runId, "completed"));
      } catch (error) {
        if (closed) return;
        runtimeError = error instanceof Error ? error.message : String(error);
        notifyParentOfDelegatedCompletion(delegations.settle(runId, "failed", runtimeError));
      } finally {
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
        const context = store.getCollaborationChatDetail(capability.masterChatId);
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
          const initial = store.appendEvent(child.id, {
            type: "user_message",
            text: `Delegated task: ${spawned.run.delegationSummary}`,
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
            notifyParentOfDelegatedCompletion(delegations.settle(spawned.run.id, "failed", message));
            throw error;
          }
        }
        return reply.code(202).send({ run: delegations.get(spawned.run.id), accepted: true, replayed: spawned.replayed });
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
          ? await registration.authStatus()
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
    const detail = store.getMasterChatDetail(request.params.id);
    return detail ?? reply.code(404).send({ error: "master chat not found" });
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
    Body: { role?: "user" | "assistant" | "system"; text: string; replyToMessageId?: string };
  }>("/api/master-chats/:id/messages", async (request, reply) => {
    const text = request.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: "text is required" });
    if (text.length > MAX_TEXT_LENGTH) return reply.code(400).send({ error: "text must be 65536 characters or fewer" });
    let message;
    try {
      message = store.appendMasterChatMessage(request.params.id, {
        role: request.body.role,
        text,
        replyToMessageId: request.body.replyToMessageId,
      });
    } catch {
      return reply.code(400).send({ error: "reply target was not found in this conversation" });
    }
    return message ?? reply.code(404).send({ error: "master chat not found" });
  });

  app.get<{ Params: { id: string } }>("/api/master-chats/:id/collaboration", async (request, reply) => {
    const detail = store.getCollaborationChatDetail(request.params.id);
    return detail ?? reply.code(404).send({ error: "master chat not found" });
  });

  app.post<{
    Params: { id: string };
    Body: { text: string; replyToMessageId?: string };
  }>("/api/master-chats/:id/collaboration/messages", async (request, reply) => {
    const text = request.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: "text is required" });
    if (text.length > MAX_TEXT_LENGTH) return reply.code(400).send({ error: "text must be 65536 characters or fewer" });
    const detail = store.getCollaborationChatDetail(request.params.id);
    if (!detail) return reply.code(404).send({ error: "master chat not found" });

    const routing = resolveCollaborationIntents(request.params.id, "", text, 0, []);
    let message;
    try { message = store.appendMasterChatMessage(
      request.params.id,
      { role: "user", text, replyToMessageId: request.body.replyToMessageId },
      undefined,
      "collaboration",
      routing.intents,
    ); } catch { return reply.code(400).send({ error: "reply target was not found in this conversation" }); }
    const notifiedAgentIds: string[] = [];
    queueRecordedCollaborationMessage(request.params.id, message!, undefined, routing.intents);
    notifiedAgentIds.push(...routing.intents.map((intent) => intent.targetThreadId));
    return { message, notifiedAgentIds };
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
        if (thread.masterChatId) {
          store.appendMasterChatMessage(thread.masterChatId, { text: initialMessage, replyToMessageId: request.body.replyToMessageId });
        }
        const turn = await app.inject({
          method: "POST",
          url: `/api/threads/${thread.id}/messages`,
          headers: opts.authToken ? { authorization: `Bearer ${opts.authToken}` } : undefined,
          payload: {
            text: initialMessage,
            model: request.body.model,
            effort: request.body.effort,
            sourceChannel: "main",
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
    const detail = store.getThreadDetail(request.params.id);
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
    if (delegated && (delegated.status === "queued" || delegated.status === "running")) {
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

  const attachmentMetadata = async (threadId: string, id: string): Promise<ImageAttachmentDto | undefined> => {
    if (!/^[a-f0-9-]{36}$/.test(id)) return undefined;
    const thread = store.getThread(threadId);
    if (!thread) return undefined;
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(attachmentsDir(opts.dataDir, thread.projectId, threadId), `${id}.json`), "utf8")) as ImageAttachmentDto;
      return metadata.id === id && metadata.threadId === threadId && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(metadata.mediaType) ? metadata : undefined;
    } catch { return undefined; }
  };

  app.get("/api/attachment-limits", async () => ({
    maxFileBytes: MAX_ATTACHMENT_BYTES,
    maxRequestBytes: MAX_ATTACHMENT_REQUEST_BYTES,
    maxAttachmentsPerMessage: MAX_ATTACHMENTS_PER_MESSAGE,
    acceptedMediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
  }));

  app.post<{ Params: { id: string }; Body: Buffer }>("/api/threads/:id/attachments", async (request, reply) => {
    const thread = store.getThread(request.params.id);
    if (!thread) return reply.code(404).send({ error: "thread not found" });
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: "image body is required" });
    if (body.length > MAX_ATTACHMENT_BYTES) return reply.code(413).send({ error: "image exceeds 8 MiB limit" });
    const inspected = inspectImage(body);
    if (!inspected) return reply.code(415).send({ error: "malformed or unsupported image; use PNG, JPEG, GIF, or WebP" });
    const id = randomUUID();
    const extension = inspected.mediaType === "image/jpeg" ? "jpg" : inspected.mediaType.slice(6);
    const filename = `${id}.${extension}`;
    const suppliedName = String(request.headers["x-ponderosa-filename"] ?? "image");
    const name = path.basename(suppliedName).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160) || "image";
    const metadata: ImageAttachmentDto = {
      id, threadId: thread.id, name, ...inspected, size: body.length,
      url: `/api/threads/${encodeURIComponent(thread.id)}/attachments/${id}`,
    };
    await fs.mkdir(attachmentsDir(opts.dataDir, thread.projectId, thread.id), { recursive: true });
    await fs.writeFile(attachmentPath(opts.dataDir, thread.projectId, thread.id, filename), body, { flag: "wx", mode: 0o600 });
    await fs.writeFile(path.join(attachmentsDir(opts.dataDir, thread.projectId, thread.id), `${id}.json`), JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
    return reply.code(201).send(metadata);
  });

  app.get<{ Params: { id: string; attachmentId: string } }>("/api/threads/:id/attachments/:attachmentId", async (request, reply) => {
    const metadata = await attachmentMetadata(request.params.id, request.params.attachmentId);
    const thread = store.getThread(request.params.id);
    if (!metadata || !thread || metadata.threadId !== thread.id) return reply.code(404).send({ error: "attachment not found" });
    const extension = metadata.mediaType === "image/jpeg" ? "jpg" : metadata.mediaType.slice(6);
    try {
      const content = await fs.readFile(attachmentPath(opts.dataDir, thread.projectId, thread.id, `${metadata.id}.${extension}`));
      return reply.header("content-type", metadata.mediaType).header("content-disposition", "inline").header("x-content-type-options", "nosniff").send(content);
    } catch { return reply.code(410).send({ error: "attachment file is unavailable" }); }
  });

  app.delete<{ Params: { id: string; attachmentId: string } }>("/api/threads/:id/attachments/:attachmentId", async (request, reply) => {
    const metadata = await attachmentMetadata(request.params.id, request.params.attachmentId);
    const thread = store.getThread(request.params.id);
    if (!metadata || !thread || metadata.threadId !== thread.id) return reply.code(404).send({ error: "attachment not found" });
    const referenced = store.getMessages(thread.id).some((message) => message.attachments?.some((item) => item.id === metadata.id));
    if (referenced) return reply.code(409).send({ error: "sent attachments cannot be deleted" });
    const extension = metadata.mediaType === "image/jpeg" ? "jpg" : metadata.mediaType.slice(6);
    await Promise.allSettled([
      fs.unlink(attachmentPath(opts.dataDir, thread.projectId, thread.id, `${metadata.id}.${extension}`)),
      fs.unlink(path.join(attachmentsDir(opts.dataDir, thread.projectId, thread.id), `${metadata.id}.json`)),
    ]);
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
      sourceChannel?: "main";
      sourceMasterChatId?: string;
      sourceAuthorThreadId?: string;
      replyToMessageId?: string;
      attachmentIds?: string[];
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
      const attached = (await Promise.all(attachmentIds.map((id) => attachmentMetadata(thread.id, id))));
      if (attached.some((item) => !item || item.threadId !== thread.id)) return reply.code(400).send({ error: "attachment does not belong to thread" });
      const messageAttachments = attached as ImageAttachmentDto[];
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
        return reply.code(403).send({ error: "collaboration context must be delivered by a successful @mention" });
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
      const inboxDelivery = collaborationDeliveryId
        ? collaborationDeliveries.get(collaborationDeliveryId)
        : undefined;
      if (
        collaborationDeliveryId !== undefined &&
        (request.headers["x-ponderosa-collaboration-dispatch"] !== collaborationDispatchKey ||
          inboxDelivery?.targetThreadId !== thread.id ||
          (inboxDelivery.kind !== "direct" && !collaborationMasterChatId))
      ) {
        return reply.code(403).send({ error: "collaboration delivery must be dispatched by the server" });
      }
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
        model: request.body.model,
        effort: request.body.effort,
        agentMentionDepth: mentionDepth ?? 0,
        agentMentionTrail: mentionTrail,
        collaborationMasterChatId,
        collaborationDeliveryId,
        sourceChannel: request.body.sourceChannel === "main" ? "main" : undefined,
        sourceAuthorThreadId: request.body.sourceAuthorThreadId,
        replyToMessageId: request.body.replyToMessageId,
        replyTo: request.body.replyToMessageId
          ? (() => {
              const target = store.getMessages(thread.id).find((message) => message.id === request.body.replyToMessageId);
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
        return reply.code(202).send({ queued: true, position });
      }

      const history: ChatMessage[] = store.getMessages(thread.id).map((message) => ({
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        attachments: message.attachments?.map((item) => ({
          name: item.name,
          mediaType: item.mediaType,
          size: item.size,
          localPath: attachmentPath(opts.dataDir, thread.projectId, thread.id, `${item.id}.${item.mediaType === "image/jpeg" ? "jpg" : item.mediaType.slice(6)}`),
          available: existsSync(attachmentPath(opts.dataDir, thread.projectId, thread.id, `${item.id}.${item.mediaType === "image/jpeg" ? "jpg" : item.mediaType.slice(6)}`)),
        })),
      }));
      const runId = randomUUID();
      const controller = new AbortController();
      const messageCapability = randomUUID();
      const delegationCapability = randomUUID();
      const resumeSessionId = store.resumeSessionId(thread.id);
      const mode = resumeSessionId ? "continue" : "seed";

      // Main-chat turns receive the manager-facing room. Collaboration context is
      // assembled only after the collaboration endpoint successfully tagged this
      // particular linked agent.
      const routingMasterChatId = sourceMasterChatId ?? thread.masterChatId;
      const masterChat = routingMasterChatId
        ? store.getMasterChatDetail(routingMasterChatId)
        : undefined;
      const collaboration = collaborationMasterChatId
        ? store.getCollaborationChatDetail(collaborationMasterChatId)
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
      const basePrompt = collaboration
        ? collaborationChatPrompt(collaboration.messages, collaboration.threads, text, context)
        : masterChat && sourceChannel === "main"
          ? masterChatPrompt(masterChat.messages, masterChat.threads, text, context)
          : individualChatPrompt(text, context);
      const guidedPrompt = thread.presetSnapshot?.guidance
        ? `Agent preset snapshot (${thread.presetSnapshot.name}):\n${thread.presetSnapshot.guidance}\n\n${basePrompt}`
        : basePrompt;
      const attachmentContext = messageAttachments.length ? `\n\nAttached images (validated local files scoped to this thread):\n${messageAttachments.map((item) => `- ${item.name} (${item.mediaType}, ${item.width}x${item.height}, ${item.size} bytes): ${attachmentPath(opts.dataDir, thread.projectId, thread.id, `${item.id}.${item.mediaType === "image/jpeg" ? "jpg" : item.mediaType.slice(6)}`)}`).join("\n")}` : "";
      const prompt = `${guidedPrompt}${replyContext(pendingTurn.replyTo)}${attachmentContext}`;
      const agentMessageUrl = agentMessageEndpoint(request, opts.agentBaseUrl);

      const userStored = store.appendEvent(thread.id, { type: "user_message", text, replyTo: pendingTurn.replyTo, attachments: messageAttachments });
      publish(thread.id, userStored);

      activeRuns.set(thread.id, { runId, controller, messageCapability });
      agentMessageCapabilities.set(messageCapability, {
        threadId: thread.id,
        masterChatId: thread.masterChatId,
        runId,
        mentionDepth: mentionDepth ?? 0,
        mentionTrail,
      });
      if (thread.masterChatId) {
        delegationCapabilities.set(delegationCapability, {
          parentRunId: runId,
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
        try {
          const stream = resumeSessionId
            ? engine.adapter.continue({
                  threadId: thread.id,
                  cwd: project.hostPath,
                  prompt,
                  resumeSessionId,
                  model: request.body.model,
                  effort: request.body.effort,
                  environment: {
                    PONDEROSA_AGENT_MESSAGE_URL: agentMessageUrl,
                    PONDEROSA_AGENT_MESSAGE_TOKEN: messageCapability,
                    PONDEROSA_DELEGATION_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-delegations`,
                    PONDEROSA_DELEGATION_TOKEN: delegationCapability,
                    PONDEROSA_INTERNAL_SUBAGENTS_DISABLED: "1",
                  },
                  signal: controller.signal,
                })
            : engine.adapter.seed({
                  threadId: thread.id,
                  cwd: project.hostPath,
                  prompt,
                  history,
                  model: request.body.model,
                  effort: request.body.effort,
                  environment: {
                    PONDEROSA_AGENT_MESSAGE_URL: agentMessageUrl,
                    PONDEROSA_AGENT_MESSAGE_TOKEN: messageCapability,
                    PONDEROSA_DELEGATION_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-delegations`,
                    PONDEROSA_DELEGATION_TOKEN: delegationCapability,
                    PONDEROSA_INTERNAL_SUBAGENTS_DISABLED: "1",
                  },
                  signal: controller.signal,
                });

          for await (const event of stream) {
            if (closed) break;
            const stored = store.appendEvent(thread.id, event);
            publish(thread.id, stored);
            if (event.type === "text") finalText += event.delta;
            if (event.type === "error") runError = event.message;
            if (event.type === "task_update" && event.status === "waiting_approval") sawWaiting = true;
          }
        } catch (err) {
          if (closed) return;
          const message = err instanceof Error ? err.message : String(err);
          const stored = store.appendEvent(thread.id, { type: "error", message });
          publish(thread.id, stored);
          runError = message;
        } finally {
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
              const routing = !runError && collaborationMasterChatId
                ? resolveCollaborationIntents(
                    collaborationMasterChatId,
                    thread.id,
                    statusText,
                    mentionDepth ?? 0,
                    mentionTrail,
                  )
                : { intents: [], blocked: [] };
              // The main chat is manager-facing. Agent-to-agent handoffs are
              // emitted only from the separate collaboration chat.
              const report = store.appendMasterChatMessage(
                routingMasterChatId,
                { role: "assistant", text: statusText },
                thread.id,
                sourceChannel,
                routing.intents,
              );

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
          if (!closed && collaborationDeliveryId) {
            // A cancelled delivery turn is not an acknowledgement. Put it back
            // into the durable queue; ordinary pending deliveries remain queued.
            if (controller.signal.aborted) collaborationDeliveries.requeue(collaborationDeliveryId);
            else if (runError) collaborationDeliveries.retryFailedTurn(collaborationDeliveryId, runError);
            else collaborationDeliveries.acknowledge(collaborationDeliveryId);
            syncDelegatedCompletion(collaborationDeliveryId);
          }
          // Mentions received while this agent was working are never dropped.
          // Start the oldest queued follow-up as soon as its current turn closes.
          void dispatchNextTurn(thread.id);
        }
      })();

      return { queued: false, runId, mode };
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
    if (run.delegatedRunId) {
      delegations.cancel(run.delegatedRunId, `thread-cancel-${randomUUID()}`);
    }
    return { cancelled: true };
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
          status = authStatus ? await authStatus() : { authenticated: false };
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
