import type {
  AgentStore,
  StoredLogEvent,
  WorkspaceStore,
} from "@ponderosa/agents";
import type { WorkspaceEventEnvelope } from "@ponderosa/core";
import type { FastifyInstance } from "fastify";
import { envelope, writeSse } from "../sse.js";

interface StreamRoutesContext {
  store: Pick<AgentStore, "getAgent" | "lastSeqOf" | "readEventsSince">;
  workspace: Pick<WorkspaceStore, "cursor" | "instanceId" | "readSince">;
  serverClosed(): boolean;
  maxSubscribersPerStream: number;
  workspaceSubscribers: Set<(event: WorkspaceEventEnvelope) => void>;
  agentSubscriberCount(agentId: string): number;
  subscribe(agentId: string, listener: (event: StoredLogEvent) => void): () => void;
  liveSseClosures: Set<() => void>;
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
  } = context;

  app.get<{ Querystring: { lastEventId?: string } }>(
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
      const reset = requestedCursor > highWaterMark;
      const replayFrom = reset ? 0 : requestedCursor;
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
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
        writeSse(
          reply.raw,
          "message",
          event.id,
          replayed ? { ...event, replayed: true } : event,
        );
        cursor = event.id;
      };
      const subscriber = (event: WorkspaceEventEnvelope) => {
        if (replaying) queued.push(event);
        else writeEvent(event);
      };
      workspaceSubscribers.add(subscriber);
      for (const event of workspace.readSince(replayFrom)) writeEvent(event, true);
      replaying = false;
      for (const event of queued) writeEvent(event);
      const heartbeat = setInterval(() => {
        writeSse(reply.raw, "heartbeat", undefined, { ts: new Date().toISOString() });
      }, 15_000);
      let streamClosed = false;
      const cleanup = (): void => {
        if (streamClosed) return;
        streamClosed = true;
        clearInterval(heartbeat);
        workspaceSubscribers.delete(subscriber);
        liveSseClosures.delete(closeStream);
      };
      const closeStream = (): void => {
        cleanup();
        if (!reply.raw.writableEnded) reply.raw.end();
        if (!reply.raw.destroyed) reply.raw.destroy();
      };
      liveSseClosures.add(closeStream);
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
      const reset = requestedCursor > highWaterMark;
      const replayFrom = reset ? 0 : requestedCursor;

      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      writeSse(reply.raw, "agent_status", undefined, {
        agentId: request.params.id,
        instanceId: workspace.instanceId(),
        cursor: highWaterMark,
        reset,
      } satisfies import("@ponderosa/core").AgentStreamStatusDto);
      writeSse(reply.raw, "heartbeat", undefined, { ts: new Date().toISOString() });

      let lastWrittenSeq = replayFrom;
      let replaying = true;
      const queued: StoredLogEvent[] = [];
      const writeStored = (stored: StoredLogEvent, replayed = false): void => {
        if (stored.seq <= lastWrittenSeq) return;
        const event = envelope(request.params.id, stored, replayed);
        lastWrittenSeq = stored.seq;
        if (event) writeSse(reply.raw, "message", stored.seq, event);
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
      }, 15_000);
      let streamClosed = false;
      const cleanup = (): void => {
        if (streamClosed) return;
        streamClosed = true;
        clearInterval(heartbeat);
        unsubscribe();
        liveSseClosures.delete(closeStream);
      };
      const closeStream = (): void => {
        cleanup();
        if (!reply.raw.writableEnded) reply.raw.end();
        if (!reply.raw.destroyed) reply.raw.destroy();
      };
      liveSseClosures.add(closeStream);
      request.raw.on("close", cleanup);
    },
  );
}
