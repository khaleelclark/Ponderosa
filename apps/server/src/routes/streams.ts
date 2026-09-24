import type {
  AgentStore,
  StoredLogEvent,
  WorkspaceStore,
} from "@ponderosa/agents";
import type { WorkspaceEventEnvelope } from "@ponderosa/core";
import type { FastifyInstance } from "fastify";
import { performance } from "node:perf_hooks";
import { envelope, writeSse } from "../sse.js";
import type { ServerMetrics } from "../server-metrics.js";

const MAX_SSE_REPLAY_EVENTS = 5_000;
const MAX_SSE_QUEUED_EVENTS = 1_000;
const MAX_SSE_REPLAY_BYTES = 8 * 1024 * 1024;
const MAX_SSE_REPLAY_PREPARATION_MS = 2_000;
const MAX_SSE_QUEUED_BYTES = 2 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 1024 * 1024;

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

export function sseReplayWithinBudget(
  values: readonly unknown[],
  elapsedMs: number,
): boolean {
  if (elapsedMs > MAX_SSE_REPLAY_PREPARATION_MS) return false;
  let bytes = 0;
  for (const value of values) {
    bytes += encodedBytes(value);
    if (bytes > MAX_SSE_REPLAY_BYTES) return false;
  }
  return true;
}

interface StreamRoutesContext {
  store: Pick<AgentStore, "getAgent" | "lastSeqOf" | "readEventsSince">;
  workspace: Pick<WorkspaceStore, "cursor" | "instanceId" | "readSince">;
  serverClosed(): boolean;
  maxSubscribersPerStream: number;
  workspaceSubscribers: Set<(event: WorkspaceEventEnvelope) => void>;
  agentSubscriberCount(agentId: string): number;
  subscribe(agentId: string, listener: (event: StoredLogEvent) => void): () => void;
  liveSseClosures: Set<() => void>;
  serverMetrics: ServerMetrics;
}

export function registerStreamRoutes(
  app: FastifyInstance,
  context: StreamRoutesContext,
): void {
  const {
    store,
    workspace,
    serverClosed,
    maxSubscribersPerStream,
    workspaceSubscribers,
    agentSubscriberCount,
    subscribe,
    liveSseClosures,
    serverMetrics,
  } = context;

  // EventSource cannot expose a 429 Retry-After header. Its bounded probe
  // uses the same admission class, without opening another subscriber.
  app.get("/api/streams/probe", async (_request, reply) =>
    serverClosed() ? reply.code(503).send({ error: "server is shutting down" }) : { ok: true });

  app.get<{ Querystring: { lastEventId?: string; bootstrap?: string } }>(
    "/api/workspace/stream",
    async (request, reply) => {
      if (serverClosed()) return reply.code(503).send({ error: "server is shutting down" });
      if (workspaceSubscribers.size >= maxSubscribersPerStream) {
        return reply.code(429).send({ error: "too many stream subscribers" });
      }
      const lastEventId = request.headers["last-event-id"] ?? request.query.lastEventId ?? "0";
      const parsed = Number(Array.isArray(lastEventId) ? lastEventId[0] : lastEventId);
      const requestedCursor = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
      const highWaterMark = workspace.cursor();
      const freshBootstrap = request.query.bootstrap === "true" && requestedCursor === 0;
      let reset = requestedCursor > highWaterMark ||
        (!freshBootstrap && highWaterMark - requestedCursor > MAX_SSE_REPLAY_EVENTS);
      const snapshot = request.query.bootstrap === "true" && (requestedCursor === 0 || reset);
      const closeMetrics = serverMetrics.openSse(reset);
      let replayFrom = snapshot
        ? highWaterMark
        : reset
          ? Math.max(0, highWaterMark - MAX_SSE_REPLAY_EVENTS)
          : requestedCursor;
      const replayStartedAt = performance.now();
      let replayEvents = snapshot
        ? []
        : workspace.readSince(replayFrom, MAX_SSE_REPLAY_EVENTS);
      if (!sseReplayWithinBudget(replayEvents, performance.now() - replayStartedAt)) {
        reset = true;
        replayFrom = highWaterMark;
        replayEvents = [];
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      if (writeSse(reply.raw, "workspace_status", undefined, {
        instanceId: workspace.instanceId(),
        cursor: highWaterMark,
        reset,
        ...(snapshot ? { snapshot: true } : {}),
      } satisfies import("@ponderosa/core").WorkspaceStreamStatusDto) === false ||
          writeSse(reply.raw, "heartbeat", undefined, { ts: new Date().toISOString() }) === false) {
        reply.raw.destroy();
        serverMetrics.sseBackpressure();
        closeMetrics();
        return;
      }
      let cursor = replayFrom;
      let replaying = true;
      const queued: WorkspaceEventEnvelope[] = [];
      let queuedBytes = 0;
      let streamClosed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let subscriber: ((event: WorkspaceEventEnvelope) => void) | undefined;
      const cleanup = (): void => {
        if (streamClosed) return;
        streamClosed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (subscriber) workspaceSubscribers.delete(subscriber);
        liveSseClosures.delete(closeStream);
        closeMetrics();
      };
      const closeStream = (): void => {
        cleanup();
        if (!reply.raw.writableEnded) reply.raw.end();
        if (!reply.raw.destroyed) reply.raw.destroy();
      };
      const writeEvent = (event: WorkspaceEventEnvelope, replayed = false) => {
        if (event.id <= cursor) return;
        if (encodedBytes(event) > MAX_SSE_EVENT_BYTES) {
          serverMetrics.sseBackpressure();
          closeStream();
          return;
        }
        const writable = writeSse(
          reply.raw,
          "message",
          event.id,
          replayed ? { ...event, replayed: true } : event,
        );
        cursor = event.id;
        if (writable === false) {
          serverMetrics.sseBackpressure();
          closeStream();
        }
      };
      subscriber = (event: WorkspaceEventEnvelope) => {
        if (replaying) {
          const eventBytes = encodedBytes(event);
          if (queued.length >= MAX_SSE_QUEUED_EVENTS ||
              queuedBytes + eventBytes > MAX_SSE_QUEUED_BYTES) {
            serverMetrics.sseBackpressure();
            return closeStream();
          }
          queued.push(event);
          queuedBytes += eventBytes;
        }
        else writeEvent(event);
      };
      workspaceSubscribers.add(subscriber);
      liveSseClosures.add(closeStream);
      if (!snapshot) {
        for (const event of replayEvents) {
          if (streamClosed) break;
          writeEvent(event, true);
        }
      }
      replaying = false;
      for (const event of queued) {
        if (streamClosed) break;
        writeEvent(event);
      }
      heartbeat = setInterval(() => {
        if (writeSse(reply.raw, "heartbeat", undefined, { ts: new Date().toISOString() }) === false) {
          serverMetrics.sseBackpressure();
          closeStream();
        }
      }, 15_000);
      request.raw.on("close", cleanup);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { lastEventId?: string } }>(
    "/api/agents/:id/stream",
    async (request, reply) => {
      if (serverClosed()) return reply.code(503).send({ error: "server is shutting down" });
      if (!store.getAgent(request.params.id)) {
        return reply.code(404).send({ error: "agent not found" });
      }
      if (agentSubscriberCount(request.params.id) >= maxSubscribersPerStream) {
        return reply.code(429).send({ error: "too many stream subscribers" });
      }
      const lastEventId = request.headers["last-event-id"] ?? request.query.lastEventId ?? "0";
      const sinceSeq = Number(Array.isArray(lastEventId) ? lastEventId[0] : lastEventId);
      const requestedCursor = Number.isSafeInteger(sinceSeq) && sinceSeq >= 0 ? sinceSeq : 0;
      const highWaterMark = store.lastSeqOf(request.params.id);
      let reset = requestedCursor > highWaterMark ||
        highWaterMark - requestedCursor > MAX_SSE_REPLAY_EVENTS;
      let replayFrom = reset
        ? Math.max(0, highWaterMark - MAX_SSE_REPLAY_EVENTS)
        : requestedCursor;
      const replayStartedAt = performance.now();
      let replayEvents = store.readEventsSince(
        request.params.id,
        replayFrom,
        MAX_SSE_REPLAY_EVENTS,
      );
      if (!sseReplayWithinBudget(replayEvents, performance.now() - replayStartedAt)) {
        reset = true;
        replayFrom = highWaterMark;
        replayEvents = [];
      }
      const closeMetrics = serverMetrics.openSse(reset);

      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      if (writeSse(reply.raw, "agent_status", undefined, {
        agentId: request.params.id,
        instanceId: workspace.instanceId(),
        cursor: highWaterMark,
        reset,
      } satisfies import("@ponderosa/core").AgentStreamStatusDto) === false ||
          writeSse(reply.raw, "heartbeat", undefined, { ts: new Date().toISOString() }) === false) {
        reply.raw.destroy();
        serverMetrics.sseBackpressure();
        closeMetrics();
        return;
      }

      let lastWrittenSeq = replayFrom;
      let replaying = true;
      const queued: StoredLogEvent[] = [];
      let queuedBytes = 0;
      let streamClosed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let unsubscribe = (): void => {};
      const cleanup = (): void => {
        if (streamClosed) return;
        streamClosed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        liveSseClosures.delete(closeStream);
        closeMetrics();
      };
      const closeStream = (): void => {
        cleanup();
        if (!reply.raw.writableEnded) reply.raw.end();
        if (!reply.raw.destroyed) reply.raw.destroy();
      };
      const writeStored = (stored: StoredLogEvent, replayed = false): void => {
        if (stored.seq <= lastWrittenSeq) return;
        if (encodedBytes(stored) > MAX_SSE_EVENT_BYTES) {
          serverMetrics.sseBackpressure();
          closeStream();
          return;
        }
        const event = envelope(request.params.id, stored, replayed);
        lastWrittenSeq = stored.seq;
        if (event && writeSse(reply.raw, "message", stored.seq, event) === false) {
          serverMetrics.sseBackpressure();
          closeStream();
        }
      };
      unsubscribe = subscribe(request.params.id, (stored) => {
        if (replaying) {
          const eventBytes = encodedBytes(stored);
          if (queued.length >= MAX_SSE_QUEUED_EVENTS ||
              queuedBytes + eventBytes > MAX_SSE_QUEUED_BYTES) {
            serverMetrics.sseBackpressure();
            return closeStream();
          }
          queued.push(stored);
          queuedBytes += eventBytes;
          return;
        }
        writeStored(stored);
      });
      liveSseClosures.add(closeStream);

      for (const stored of replayEvents) {
        if (streamClosed) break;
        writeStored(stored, true);
      }
      replaying = false;
      for (const stored of queued) {
        if (streamClosed) break;
        writeStored(stored);
      }

      heartbeat = setInterval(() => {
        if (writeSse(reply.raw, "heartbeat", undefined, { ts: new Date().toISOString() }) === false) {
          serverMetrics.sseBackpressure();
          closeStream();
        }
      }, 15_000);
      request.raw.on("close", cleanup);
    },
  );
}
