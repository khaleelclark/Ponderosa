import { createHash, randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type {
  Adapter,
  AgentMessageChannel,
  AgentEvent,
  ArtifactContentDto,
  ChatMessage,
  ClaimSubagentRegistrationRequest,
  EngineAuthStatus,
  EngineDto,
  FilesResponse,
  HealthDto,
  MasterChatMessageDto,
  SseEventEnvelope,
  SendAgentMessageRequest,
  SpawnSubagentRequest,
  ThreadDto,
} from "@ponderosa/core";
import { artifactContentPath, type StoredLogEvent, ThreadStore } from "@ponderosa/threads";
import { DelegationError, DelegationStore } from "./delegations.js";

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
  logger?: boolean;
}

interface ActiveRun {
  runId: string;
  controller: AbortController;
  messageCapability: string;
}

interface PendingMentionTurn {
  text: string;
  agentMentionDepth: number;
  agentMentionTrail: string[];
  collaborationMasterChatId: string;
  sourceAuthorThreadId?: string;
}

interface AgentMessageCapability {
  threadId: string;
  masterChatId?: string;
  runId: string;
  mentionDepth: number;
  mentionTrail: string[];
}

interface InboundMessageContext {
  channel: AgentMessageChannel;
  author: string;
  mentionedAgents: string[];
  addressedToCurrentAgent: boolean;
}

type Subscriber = (stored: StoredLogEvent) => void;

const MAX_PENDING_MENTION_TURNS = 50;
const MAX_AGENT_MENTION_RELAYS = 12;

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
  return title.trim().replace(/\s+/g, "-");
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
    'curl -sS -X POST "$PONDEROSA_AGENT_MESSAGE_URL" -H "Authorization: Bearer $PONDEROSA_AGENT_MESSAGE_TOKEN" -H "Content-Type: application/json" --data \'{"channel":"collaboration","text":"@Full-Agent-Handle message"}\'',
    'Set channel to "individual", "main", or "collaboration". The server supplies your identity; never include or claim another author.',
    "Use collaboration for teammate coordination, main for manager-facing updates, and individual for notes in your own agent chat.",
  ];
}

function agentMessageEndpoint(request: { protocol: string; headers: Record<string, unknown> }): string {
  const forwarded = request.headers["x-forwarded-proto"];
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const forwardedProtocol = typeof forwardedValue === "string"
    ? forwardedValue.split(",", 1)[0]?.trim().toLowerCase()
    : undefined;
  const protocol = forwardedProtocol === "https" || forwardedProtocol === "http"
    ? forwardedProtocol
    : request.protocol;
  const host = typeof request.headers.host === "string" ? request.headers.host : "127.0.0.1";
  return `${protocol}://${host}/api/agent-messages`;
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
      return `${speaker}: ${message.text}`;
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
      return `${speaker}: ${message.text}`;
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
    "",
    "Latest message for you:",
    currentRequest,
  ].join("\n");
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

  const buffer = await fs.readFile(targetReal);
  try {
    return { kind: "file", path: rel, content: buffer.toString("utf8"), encoding: "utf-8" };
  } catch {
    return { kind: "file", path: rel, content: buffer.toString("base64"), encoding: "base64" };
  }
}

export function createServer(opts: CreateServerOptions): FastifyInstance {
  const store = opts.store ?? new ThreadStore(opts.dataDir);
  const engines = new Map(opts.engines.map((engine) => [engine.adapter.id, engine]));
  const activeRuns = new Map<string, ActiveRun>();
  const delegations = new DelegationStore(opts.dataDir);
  const subagentControllers = new Map<string, AbortController>();
  const agentMessageCapabilities = new Map<string, AgentMessageCapability>();
  const pendingMentionTurns = new Map<string, PendingMentionTurn[]>();
  // Capability used only by this server's queue dispatcher. It prevents a client
  // from attaching arbitrary collaboration history to a direct thread request.
  const collaborationDispatchKey = randomUUID();
  const subscribers = new Map<string, Set<Subscriber>>();

  const app = Fastify({ logger: opts.logger ?? true });

  function delegationFailure(error: unknown, reply: FastifyReply) {
    if (error instanceof DelegationError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, retryable: error.retryable },
      });
    }
    throw error;
  }

  function queueMentionTurn(
    threadId: string,
    text: string,
    agentMentionDepth: number,
    agentMentionTrail: string[],
    collaborationMasterChatId: string,
    sourceAuthorThreadId?: string,
  ): boolean {
    const pending = pendingMentionTurns.get(threadId) ?? [];
    if (pending.length >= MAX_PENDING_MENTION_TURNS) return false;
    pending.push({ text, agentMentionDepth, agentMentionTrail, collaborationMasterChatId, sourceAuthorThreadId });
    pendingMentionTurns.set(threadId, pending);
    return true;
  }

  async function dispatchNextMentionTurn(threadId: string): Promise<void> {
    if (activeRuns.has(threadId)) return;
    const pending = pendingMentionTurns.get(threadId);
    const next = pending?.[0];
    if (!pending || !next) return;
    pending.shift();
    if (pending.length === 0) pendingMentionTurns.delete(threadId);

    const response = await app.inject({
      method: "POST",
      url: `/api/threads/${threadId}/messages`,
      headers: {
        ...(opts.authToken ? { authorization: `Bearer ${opts.authToken}` } : {}),
        "x-ponderosa-collaboration-dispatch": collaborationDispatchKey,
      },
      payload: next,
    });
    if (response.statusCode === 409) {
      const remaining = pendingMentionTurns.get(threadId) ?? [];
      remaining.unshift(next);
      pendingMentionTurns.set(threadId, remaining);
    }
  }

  app.addHook("onRequest", async (request, reply) => {
    const provided = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (request.url === "/api/agent-messages" && provided && agentMessageCapabilities.has(provided)) return;
    if (!opts.authToken) return;
    if (request.url === "/api/health") return;
    if (provided !== opts.authToken) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.addHook("onClose", async () => {
    for (const run of activeRuns.values()) run.controller.abort();
    for (const controller of subagentControllers.values()) controller.abort();
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

  function dispatchCollaborationMentions(
    masterChatId: string,
    authorThreadId: string,
    text: string,
    relayDepth: number,
    mentionTrail: string[],
  ): void {
    const detail = store.getCollaborationChatDetail(masterChatId);
    const targets = detail ? mentionedAgentThreads(text, detail.threads, authorThreadId) : [];
    for (const target of targets) {
      const fingerprint = mentionRelayFingerprint(authorThreadId, target.id, text);
      const blockedReason = mentionTrail.includes(fingerprint)
        ? "the same handoff already occurred in this collaboration chain"
        : relayDepth >= MAX_AGENT_MENTION_RELAYS
          ? "the collaboration reached its 12-handoff safety limit"
          : undefined;
      if (blockedReason) {
        store.appendMasterChatMessage(
          masterChatId,
          {
            role: "system",
            text: `⚠️ @${agentMentionHandle(target.title)} was not notified because ${blockedReason}. Please ask the manager to continue the conversation.`,
          },
          undefined,
          "collaboration",
        );
      } else if (
        queueMentionTurn(
          target.id,
          text,
          relayDepth + 1,
          [...mentionTrail, fingerprint],
          masterChatId,
          authorThreadId,
        )
      ) {
        void dispatchNextMentionTurn(target.id);
      } else {
        store.appendMasterChatMessage(
          masterChatId,
          {
            role: "system",
            text: `⚠️ @${agentMentionHandle(target.title)} was not notified because their follow-up queue is full. Please retry after they finish some queued work.`,
          },
          undefined,
          "collaboration",
        );
      }
    }
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

    if (channel === "individual") {
      const stored = store.appendEvent(capability.threadId, { type: "text", delta: text });
      publish(capability.threadId, stored);
      return { channel, messageId: `thread-event-${stored.seq}` };
    }
    if (!capability.masterChatId) {
      return reply.code(409).send({ error: "agent is not linked to a master chat" });
    }
    const message = store.appendMasterChatMessage(
      capability.masterChatId,
      { role: "assistant", text },
      capability.threadId,
      channel,
    );
    if (!message) return reply.code(404).send({ error: "master chat not found" });
    if (channel === "collaboration") {
      dispatchCollaborationMentions(
        capability.masterChatId,
        capability.threadId,
        text,
        capability.mentionDepth,
        capability.mentionTrail,
      );
    }
    return { channel, messageId: message.id };
  });

  app.get("/api/health", async (): Promise<HealthDto> => ({
    status: "ok",
    service: "ponderosa",
    version: "0.0.0",
  }));

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
    Body: { role?: "user" | "assistant" | "system"; text: string };
  }>("/api/master-chats/:id/messages", async (request, reply) => {
    const text = request.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: "text is required" });
    const message = store.appendMasterChatMessage(request.params.id, {
      role: request.body.role,
      text,
    });
    return message ?? reply.code(404).send({ error: "master chat not found" });
  });

  app.get<{ Params: { id: string } }>("/api/master-chats/:id/collaboration", async (request, reply) => {
    const detail = store.getCollaborationChatDetail(request.params.id);
    return detail ?? reply.code(404).send({ error: "master chat not found" });
  });

  app.post<{
    Params: { id: string };
    Body: { text: string };
  }>("/api/master-chats/:id/collaboration/messages", async (request, reply) => {
    const text = request.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: "text is required" });
    const detail = store.getCollaborationChatDetail(request.params.id);
    if (!detail) return reply.code(404).send({ error: "master chat not found" });

    const message = store.appendMasterChatMessage(
      request.params.id,
      { role: "user", text },
      undefined,
      "collaboration",
    );
    const notifiedAgentIds: string[] = [];
    for (const target of mentionedAgentThreads(text, detail.threads, "")) {
      if (queueMentionTurn(target.id, text, 0, [], request.params.id)) {
        notifiedAgentIds.push(target.id);
        void dispatchNextMentionTurn(target.id);
      } else {
        store.appendMasterChatMessage(
          request.params.id,
          {
            role: "system",
            text: `⚠️ @${agentMentionHandle(target.title)} was not notified because their follow-up queue is full. Please retry after they finish some queued work.`,
          },
          undefined,
          "collaboration",
        );
      }
    }
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
      const heartbeat = setInterval(() => writeSse(reply.raw, "heartbeat", undefined, { ts: new Date().toISOString() }), 15_000);
      request.raw.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
    },
  );

  app.post<{ Params: { id: string }; Body: SpawnSubagentRequest }>(
    "/api/master-chats/:id/subagents",
    async (request, reply) => {
      if (!store.getMasterChat(request.params.id)) return reply.code(404).send({ error: "master chat not found" });
      const input = request.body;
      if (!input?.parentRunId || !input.displayLabel?.trim() || !input.delegationPrompt?.trim() || !input.runtime?.trim() || !input.idempotencyKey?.trim()) {
        return reply.code(400).send({
          error: { code: "forbidden", message: "parentRunId, displayLabel, delegationPrompt, runtime, and idempotencyKey are required", retryable: false },
        });
      }
      if (!engines.has(input.runtime)) {
        return reply.code(400).send({
          error: { code: "forbidden", message: "runtime is not configured", retryable: false },
        });
      }
      const parentIsRunning = [...activeRuns.values()].some((run) => run.runId === input.parentRunId);
      try {
        const context = store.getCollaborationChatDetail(request.params.id)!;
        const contextMessages = context.messages.map(({ id, role, text, authorThreadId }) => ({
          id,
          role,
          text,
          ...(authorThreadId ? { authorThreadId } : {}),
        }));
        return reply.code(201).send(delegations.spawn(request.params.id, input, parentIsRunning, contextMessages));
      } catch (error) {
        return delegationFailure(error, reply);
      }
    },
  );

  app.post<{ Params: { runId: string }; Body: ClaimSubagentRegistrationRequest }>(
    "/api/internal/subagents/:runId/registration/claim",
    async (request, reply) => {
      const input = request.body;
      if (!input?.registrationId || !input.credential) {
        return reply.code(401).send({ error: { code: "registration_required", message: "registration proof is required", retryable: false } });
      }
      try {
        const run = delegations.claim(request.params.runId, input);
        // Claim and controller publication are synchronous in the single-daemon
        // launch transition, so cancellation cannot observe running without a target.
        subagentControllers.set(run.id, new AbortController());
        return { run, claimedAt: run.startedAt! };
      } catch (error) {
        return delegationFailure(error, reply);
      }
    },
  );

  app.post<{ Params: { runId: string }; Body: ClaimSubagentRegistrationRequest }>(
    "/api/internal/subagents/:runId/launch",
    async (request, reply) => {
      const input = request.body;
      if (!input?.registrationId || !input.credential) {
        return reply.code(401).send({ error: { code: "registration_required", message: "registration proof is required", retryable: false } });
      }
      const context = delegations.launchContext(request.params.runId);
      if (!context) return reply.code(404).send({ error: { code: "subagent_not_found", message: "subagent was not found", retryable: false } });
      const engine = engines.get(context.runtime);
      const masterChat = store.getMasterChat(input.masterChatId);
      const project = masterChat ? store.getProject(masterChat.projectId) : undefined;
      if (!engine || !project) {
        return reply.code(400).send({ error: { code: "forbidden", message: "delegated runtime context is unavailable", retryable: false } });
      }

      const controller = new AbortController();
      void (async () => {
        let runtimeError: string | undefined;
        try {
          const stream = engine.adapter.seed({
            threadId: request.params.runId,
            cwd: project.hostPath,
            prompt: context.prompt,
            history: context.history,
            signal: controller.signal,
            authorizeLaunch: async (signal) => {
              if (signal.aborted) throw new Error("delegated launch cancelled");
              const run = delegations.claim(request.params.runId, input);
              subagentControllers.set(run.id, controller);
              if (signal.aborted) {
                subagentControllers.delete(run.id);
                throw new Error("delegated launch cancelled");
              }
            },
          });
          for await (const event of stream) {
            if (event.type === "text" && event.delta) delegations.appendOutput(request.params.runId, event.delta);
            if (event.type === "error") runtimeError = event.message;
          }
          if (controller.signal.aborted) delegations.settle(request.params.runId, "failed", "delegated runtime aborted");
          else if (runtimeError) delegations.settle(request.params.runId, "failed", runtimeError);
          else delegations.settle(request.params.runId, "completed");
        } catch (error) {
          runtimeError = error instanceof Error ? error.message : String(error);
          delegations.settle(request.params.runId, "failed", runtimeError);
        } finally {
          subagentControllers.delete(request.params.runId);
        }
      })();
      return reply.code(202).send({ runId: request.params.runId, accepted: true });
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
          subagentControllers.get(affected.runId)?.abort();
          subagentControllers.delete(affected.runId);
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
    if (!opts.authToken || request.headers["x-ponderosa-prompt-access"] !== opts.authToken) {
      return reply.code(403).send({ error: { code: "forbidden", message: "full prompt access is forbidden", retryable: false } });
    }
    const prompt = delegations.rawPrompt(request.params.runId);
    return prompt === undefined
      ? reply.code(404).send({ error: { code: "subagent_not_found", message: "subagent was not found", retryable: false } })
      : { prompt };
  });

  app.get<{ Params: { runId: string }; Querystring: { after?: string; limit?: string } }>(
    "/api/subagents/:runId/transcript",
    async (request, reply) => {
      try {
        const limit = Math.min(200, Math.max(1, Number(request.query.limit) || 100));
        return delegations.transcript(request.params.runId, request.query.after, limit);
      } catch (error) {
        return delegationFailure(error, reply);
      }
    },
  );

  app.post<{ Params: { runId: string }; Body: { text: string } }>(
    "/api/internal/subagents/:runId/output",
    async (request, reply) => {
      if (!request.body?.text) return reply.code(400).send({ error: { code: "forbidden", message: "text is required", retryable: false } });
      try { return delegations.appendOutput(request.params.runId, request.body.text); }
      catch (error) { return delegationFailure(error, reply); }
    },
  );

  app.get<{ Params: { id: string } }>("/api/projects/:id/threads", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    return store.listThreads(request.params.id);
  });

  app.post<{
    Params: { id: string };
    Body: { title: string; engine: string; masterChatId?: string; model?: string; effort?: string; initialMessage?: string };
  }>(
    "/api/projects/:id/threads",
    async (request, reply) => {
      if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
      if (!request.body?.title || !request.body?.engine) {
        return reply.code(400).send({ error: "title and engine are required" });
      }
      if (!engines.has(request.body.engine)) return reply.code(400).send({ error: "unknown engine" });
      if (request.body.masterChatId) {
        const masterChat = store.getMasterChat(request.body.masterChatId);
        if (!masterChat || masterChat.projectId !== request.params.id) {
          return reply.code(400).send({ error: "master chat does not belong to project" });
        }
      }
      const initialMessage = request.body.initialMessage?.trim();
      const thread = store.createThread(request.params.id, request.body);
      if (initialMessage) {
        if (thread.masterChatId) {
          store.appendMasterChatMessage(thread.masterChatId, { text: initialMessage });
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

  app.delete<{ Params: { id: string } }>("/api/threads/:id", async (request, reply) => {
    const { id } = request.params;
    // Abort any in-flight run so its process is killed before we remove the log.
    const run = activeRuns.get(id);
    if (run) {
      run.controller.abort();
      activeRuns.delete(id);
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

  app.post<{
    Params: { id: string };
    Body: {
      text: string;
      model?: string;
      effort?: string;
      agentMentionDepth?: number;
      agentMentionTrail?: string[];
      collaborationMasterChatId?: string;
      sourceChannel?: "main";
      sourceAuthorThreadId?: string;
    };
  }>(
    "/api/threads/:id/messages",
    async (request, reply) => {
      const thread = store.getThread(request.params.id);
      if (!thread) return reply.code(404).send({ error: "thread not found" });
      if (activeRuns.has(thread.id)) return reply.code(409).send({ error: "thread already has an active run" });
      const project = store.getProject(thread.projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      const engine = engines.get(thread.activeEngine);
      if (!engine) return reply.code(400).send({ error: "unknown engine" });
      const text = request.body?.text?.trim();
      if (!text) return reply.code(400).send({ error: "text is required" });
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

      const history: ChatMessage[] = store.getMessages(thread.id).map((message) => ({
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
      }));
      const runId = randomUUID();
      const controller = new AbortController();
      const messageCapability = randomUUID();
      const resumeSessionId = store.resumeSessionId(thread.id);
      const mode = resumeSessionId ? "continue" : "seed";

      // Main-chat turns receive the manager-facing room. Collaboration context is
      // assembled only after the collaboration endpoint successfully tagged this
      // particular linked agent.
      const masterChat = thread.masterChatId
        ? store.getMasterChatDetail(thread.masterChatId)
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
      const prompt = collaboration
        ? collaborationChatPrompt(collaboration.messages, collaboration.threads, text, context)
        : masterChat && sourceChannel === "main"
          ? masterChatPrompt(masterChat.messages, masterChat.threads, text, context)
          : individualChatPrompt(text, context);
      const agentMessageUrl = agentMessageEndpoint(request);

      const userStored = store.appendEvent(thread.id, { type: "user_message", text });
      publish(thread.id, userStored);

      activeRuns.set(thread.id, { runId, controller, messageCapability });
      agentMessageCapabilities.set(messageCapability, {
        threadId: thread.id,
        masterChatId: thread.masterChatId,
        runId,
        mentionDepth: mentionDepth ?? 0,
        mentionTrail,
      });

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
                  },
                  signal: controller.signal,
                });

          for await (const event of stream) {
            const stored = store.appendEvent(thread.id, event);
            publish(thread.id, stored);
            if (event.type === "text") finalText += event.delta;
            if (event.type === "error") runError = event.message;
            if (event.type === "task_update" && event.status === "waiting_approval") sawWaiting = true;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const stored = store.appendEvent(thread.id, { type: "error", message });
          publish(thread.id, stored);
          runError = message;
        } finally {
          activeRuns.delete(thread.id);
          agentMessageCapabilities.delete(messageCapability);
          // Post a group-chat status unless the run was cancelled/aborted (cancel or
          // thread deletion), in which case a report-back would be misleading.
          if (thread.masterChatId && sourceChannel !== "individual" && !controller.signal.aborted) {
            const statusText = runError
              ? `⚠️ Stuck — ${runError.slice(0, 200)}`
              : summarizeFinalMessage(finalText) ??
                (sawWaiting ? "⏸️ Waiting for your input" : "✅ Finished");
            try {
              // The main chat is manager-facing. Agent-to-agent handoffs are
              // emitted only from the separate collaboration chat.
              store.appendMasterChatMessage(
                thread.masterChatId,
                { role: "assistant", text: statusText },
                thread.id,
                sourceChannel,
              );

              // A tag in a main-chat report is ordinary text. A tag in the
              // collaboration chat is an opt-in handoff and can start a turn.
              if (!runError && collaborationMasterChatId) {
                dispatchCollaborationMentions(
                  collaborationMasterChatId,
                  thread.id,
                  statusText,
                  mentionDepth ?? 0,
                  mentionTrail,
                );
              }
            } catch {
              // Master chat may have been deleted mid-run; ignore.
            }
          }
          // Mentions received while this agent was working are never dropped.
          // Start the oldest queued follow-up as soon as its current turn closes.
          void dispatchNextMentionTurn(thread.id);
        }
      })();

      return { runId, mode };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { lastEventId?: string } }>(
    "/api/threads/:id/stream",
    async (request, reply) => {
      if (!store.getThread(request.params.id)) return reply.code(404).send({ error: "thread not found" });
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
