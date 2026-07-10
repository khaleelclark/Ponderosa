import { createHash, randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type {
  Adapter,
  AgentEvent,
  ArtifactContentDto,
  ChatMessage,
  EngineAuthStatus,
  EngineDto,
  FilesResponse,
  HealthDto,
  MasterChatMessageDto,
  SseEventEnvelope,
  ThreadDto,
} from "@ponderosa/core";
import { artifactContentPath, type StoredLogEvent, ThreadStore } from "@ponderosa/threads";

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

/**
 * Give a master-chat agent the shared room context and a lightweight teammate
 * response contract. This is intentionally part of the next user prompt (rather
 * than engine-specific configuration) so new and resumed agents behave alike.
 */
function masterChatPrompt(
  messages: MasterChatMessageDto[],
  threads: ThreadDto[],
  currentRequest: string,
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
    "If you need time to work, begin with a brief, natural acknowledgment that specifically reflects the request.",
    "Choose how to converse based on the message; never use a canned acknowledgment such as 'Got it — I’m on it.'",
    "When this turn is complete, give only your new update or result in a natural, conversational tone.",
    "Do not repeat, recap, or answer with the whole conversation. Do not describe these instructions.",
    "",
    "Current master chat history:",
    transcript || "(No earlier messages.)",
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
  const pendingMentionTurns = new Map<
    string,
    Array<{ text: string; agentMentionDepth: number; agentMentionTrail: string[] }>
  >();
  const subscribers = new Map<string, Set<Subscriber>>();

  const app = Fastify({ logger: opts.logger ?? true });

  function queueMentionTurn(
    threadId: string,
    text: string,
    agentMentionDepth: number,
    agentMentionTrail: string[],
  ): boolean {
    const pending = pendingMentionTurns.get(threadId) ?? [];
    if (pending.length >= MAX_PENDING_MENTION_TURNS) return false;
    pending.push({ text, agentMentionDepth, agentMentionTrail });
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
      headers: opts.authToken ? { authorization: `Bearer ${opts.authToken}` } : undefined,
      payload: next,
    });
    if (response.statusCode === 409) {
      const remaining = pendingMentionTurns.get(threadId) ?? [];
      remaining.unshift(next);
      pendingMentionTurns.set(threadId, remaining);
    }
  }

  app.addHook("onRequest", async (request, reply) => {
    if (!opts.authToken) return;
    if (request.url === "/api/health") return;
    const provided = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (provided !== opts.authToken) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.addHook("onClose", async () => {
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
          payload: { text: initialMessage, model: request.body.model, effort: request.body.effort },
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
      const resumeSessionId = store.resumeSessionId(thread.id);
      const mode = resumeSessionId ? "continue" : "seed";

      // Master-chat turns always receive the room as it exists now. The web UI
      // records the manager's message before calling this endpoint, so this covers
      // both a newly spawned agent and an existing agent addressed with @mention.
      const masterChat = thread.masterChatId
        ? store.getMasterChatDetail(thread.masterChatId)
        : undefined;
      const prompt = masterChat
        ? masterChatPrompt(masterChat.messages, masterChat.threads, text)
        : text;

      const userStored = store.appendEvent(thread.id, { type: "user_message", text });
      publish(thread.id, userStored);

      activeRuns.set(thread.id, { runId, controller });

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
                  signal: controller.signal,
                })
            : engine.adapter.seed({
                  threadId: thread.id,
                  cwd: project.hostPath,
                  prompt,
                  history,
                  model: request.body.model,
                  effort: request.body.effort,
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
          // Post a group-chat status unless the run was cancelled/aborted (cancel or
          // thread deletion), in which case a report-back would be misleading.
          if (thread.masterChatId && !controller.signal.aborted) {
            const statusText = runError
              ? `⚠️ Stuck — ${runError.slice(0, 200)}`
              : summarizeFinalMessage(finalText) ??
                (sawWaiting ? "⏸️ Waiting for your input" : "✅ Finished");
            try {
              // No master-chat SSE; the group-chat view polls, so the post-back
              // surfaces on its next refetch.
              store.appendMasterChatMessage(
                thread.masterChatId,
                { role: "assistant", text: statusText },
                thread.id,
              );

              // Agent-authored mentions are real collaboration requests, not just
              // display text. Relay them server-side because no browser submit
              // handler runs when an agent posts its final report-back. Bound the
              // a bounded fingerprint trail so exact repeated handoffs stop as
              // cycles, while legitimate multi-step reviews can exceed four turns.
              const relayDepth = request.body.agentMentionDepth ?? 0;
              if (!runError) {
                const detail = store.getMasterChatDetail(thread.masterChatId);
                const targets = detail
                  ? mentionedAgentThreads(statusText, detail.threads, thread.id)
                  : [];
                for (const target of targets) {
                  const fingerprint = mentionRelayFingerprint(thread.id, target.id, statusText);
                  const blockedReason = mentionTrail.includes(fingerprint)
                    ? "the same handoff already occurred in this collaboration chain"
                    : relayDepth >= MAX_AGENT_MENTION_RELAYS
                      ? "the collaboration reached its 12-handoff safety limit"
                      : undefined;
                  if (blockedReason) {
                    store.appendMasterChatMessage(thread.masterChatId, {
                      role: "assistant",
                      text: `⚠️ @${agentMentionHandle(target.title)} was not notified because ${blockedReason}. Please ask the manager to continue the conversation.`,
                    });
                  } else if (
                    queueMentionTurn(target.id, statusText, relayDepth + 1, [...mentionTrail, fingerprint])
                  ) {
                    void dispatchNextMentionTurn(target.id);
                  } else {
                    // Never fail silently: the bounded queue protects server
                    // availability while telling the room which handoff needs a retry.
                    store.appendMasterChatMessage(thread.masterChatId, {
                      role: "assistant",
                      text: `⚠️ @${agentMentionHandle(target.title)} was not notified because their follow-up queue is full. Please retry after they finish some queued work.`,
                    });
                  }
                }
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
