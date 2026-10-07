import {
  decisionInProduct,
  notificationInProduct,
  productPreferences,
  projectInProduct,
  requestProduct,
  resourceInProduct,
  type ProductScope,
} from '../product-scope.js';
import type {
  AgentStore,
  StoredLogEvent,
  WorkspaceStore,
} from "@ponderosa/agents";
import type { WorkspaceEvent, WorkspaceEventEnvelope } from "@ponderosa/core";
import type { FastifyInstance } from "fastify";
import { performance } from "node:perf_hooks";
import { BoundedSseWriter, envelope } from "../sse.js";
import type { ServerMetrics } from "../server-metrics.js";

const MAX_SSE_REPLAY_EVENTS = 5_000;
const MAX_SSE_QUEUED_EVENTS = 1_000;
const MAX_SSE_REPLAY_BYTES = 8 * 1024 * 1024;
const MAX_SSE_REPLAY_PREPARATION_MS = 2_000;
const MAX_SSE_QUEUED_BYTES = 2 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 1024 * 1024;
// Keep idle streams alive through reverse proxies with a 10-second idle limit.
// Heartbeats are frames on the existing connection, not additional requests.
const SSE_HEARTBEAT_MS = 5_000;

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
    const eventBytes = encodedBytes(value);
    if (eventBytes > MAX_SSE_EVENT_BYTES) return false;
    bytes += eventBytes;
    if (bytes > MAX_SSE_REPLAY_BYTES) return false;
  }
  return true;
}

export function workspaceEventInProduct(
  store: StreamRoutesContext["store"],
  workspace: StreamRoutesContext["workspace"],
  event: WorkspaceEvent,
  product: ProductScope,
): boolean {
  const conversationsInProduct = (ids: string[]): boolean =>
    ids.length > 0 && ids.every(id => resourceInProduct(store, "conversation", id, product));
  const agentsInProduct = (ids: string[]): boolean =>
    ids.length > 0 && ids.every(id => resourceInProduct(store, "agent", id, product));
  switch (event.type) {
    case "branch_checkpoint":
      // Legacy Branches do not have a Chat. Resolve the checkpoint's canonical
      // execution and owner instead of trusting the event's optional Chat ID.
      return product === "branches" && Boolean(store.sqlite.prepare(`SELECT 1 FROM branch_checkpoints c
        JOIN branch_executions e ON e.id=c.execution_id
        JOIN branches b ON b.id=e.branch_id
        WHERE c.id=? AND e.id=? AND b.id=?`).get(event.checkpointId,event.executionId,event.branchId));
    case "preferences_updated":
    case "push_subscription_changed":
    case "provider_status_changed":
      return true;
    case "resource_used":
      return resourceInProduct(store, event.kind, event.resourceId, product);
    case "project_changed": {
      if (event.action === "deleted") {
        return store.getProjectDeletionReceipt(event.projectId)?.productScope === product;
      }
      return projectInProduct(store, event.projectId, product);
    }
    case "runtime_capabilities_changed":
      return projectInProduct(store, event.projectId, product);
    case "conversation_changed": {
      if (event.action === "deleted") {
        const receipt = store.getConversationDeletionReceipt(event.conversationId);
        return Boolean(receipt) && (receipt!.branchId ? product === "branches" : product === "dev");
      }
      return resourceInProduct(store, "conversation", event.conversationId, product);
    }
    case "draft_changed":
    case "draft_conflict":
    case "queued_message_changed":
      return resourceInProduct(store, "conversation", event.conversationId, product);
    case "notification_changed": {
      if (event.notificationId) {
        const notification = workspace.getNotification(event.notificationId);
        return Boolean(notification && notificationInProduct(store, notification, product));
      }
      if (event.decisionId) {
        const decision = workspace.getDecision(event.decisionId);
        return Boolean(decision && decisionInProduct(store, decision, product));
      }
      if (event.conversationId) return resourceInProduct(store, "conversation", event.conversationId, product);
      // Ownerless batch events contain no resource identifiers. Both products
      // may safely receive the invalidation and refetch their scoped projection.
      return true;
    }
    case "message_delivery_changed":
    case "coordination_changed":
    case "usage_changed":
    case "agent_event":
      return agentsInProduct([event.agentId]) &&
        (!(event.conversationIds?.length) || conversationsInProduct(event.conversationIds));
    case "trigger_changed":
      return resourceInProduct(store, "trigger", event.triggerId, product) ||
        Boolean(event.agentId && resourceInProduct(store, "agent", event.agentId, product));
    case "push_delivery_changed": {
      const notification = workspace.getNotification(event.notificationId);
      return Boolean(notification && notificationInProduct(store, notification, product));
    }
  }
  const _exhaustive: never = event;
  return _exhaustive;
}

interface StreamRoutesContext {
  store: Pick<AgentStore, "sqlite" | "getConversation" | "getAgent" | "getConversationDeletionReceipt" | "getProjectDeletionReceipt" | "lastSeqOf" | "readEventsSince">;
  workspace: Pick<WorkspaceStore, "cursor" | "instanceId" | "readSince" | "getNotification" | "getDecision">;
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
      let snapshot = request.query.bootstrap === "true" && (requestedCursor === 0 || reset);
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
        snapshot = true;
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
      let cursor = replayFrom;
      let replaying = true;
      const queued: WorkspaceEventEnvelope[] = [];
      let queuedBytes = 0;
      let streamClosed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let subscriber: ((event: WorkspaceEventEnvelope) => void) | undefined;
      const writer = new BoundedSseWriter(reply.raw, () => {
        serverMetrics.sseBackpressure();
        closeStream();
      });
      const cleanup = (): void => {
        if (streamClosed) return;
        streamClosed = true;
        writer.dispose();
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
      if (!writer.write("workspace_status", undefined, {
        instanceId: workspace.instanceId(),
        cursor: highWaterMark,
        reset,
        ...(snapshot ? { snapshot: true } : {}),
      } satisfies import("@ponderosa/core").WorkspaceStreamStatusDto) ||
          !writer.write("heartbeat", undefined, { ts: new Date().toISOString() })) {
        serverMetrics.sseBackpressure();
        closeStream();
        return;
      }
      const writeEvent = (event: WorkspaceEventEnvelope, replayed = false) => {
        if (event.id <= cursor) return;
        const product = requestProduct(request);
        if (!workspaceEventInProduct(store, workspace, event.event, product)) {
          cursor = event.id;
          return;
        }
        const scoped = event.event.type === "preferences_updated"
          ? { ...event, event: { ...event.event, preferences: productPreferences(store, event.event.preferences, product) } }
          : event;
        if (encodedBytes(scoped) > MAX_SSE_EVENT_BYTES) {
          // Advance explicitly through canonical reconciliation, never loop
          // over an event that cannot fit on this bounded transport.
          cursor = event.id;
          if (!writer.write("workspace_status", event.id, {
            instanceId: workspace.instanceId(), cursor, reset: true, snapshot: true,
          } satisfies import("@ponderosa/core").WorkspaceStreamStatusDto)) {
            serverMetrics.sseBackpressure();
            closeStream();
          }
          return;
        }
        const accepted = writer.write(
          "message",
          event.id,
          replayed ? { ...scoped, replayed: true } : scoped,
        );
        cursor = event.id;
        if (!accepted) {
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
      if (streamClosed) return;
      heartbeat = setInterval(() => {
        if (!writer.write("heartbeat", undefined, { ts: new Date().toISOString() })) {
          serverMetrics.sseBackpressure();
          closeStream();
        }
      }, SSE_HEARTBEAT_MS);
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
      let snapshot = false;
      if (!sseReplayWithinBudget(replayEvents, performance.now() - replayStartedAt)) {
        reset = true;
        snapshot = true;
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
      let lastWrittenSeq = replayFrom;
      let replaying = true;
      const queued: StoredLogEvent[] = [];
      let queuedBytes = 0;
      let streamClosed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let unsubscribe = (): void => {};
      const writer = new BoundedSseWriter(reply.raw, () => {
        serverMetrics.sseBackpressure();
        closeStream();
      });
      const cleanup = (): void => {
        if (streamClosed) return;
        streamClosed = true;
        writer.dispose();
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
      if (!writer.write("agent_status", undefined, {
        agentId: request.params.id,
        instanceId: workspace.instanceId(),
        cursor: highWaterMark,
        reset,
        ...(snapshot ? { snapshot: true } : {}),
      } satisfies import("@ponderosa/core").AgentStreamStatusDto) ||
          !writer.write("heartbeat", undefined, { ts: new Date().toISOString() })) {
        serverMetrics.sseBackpressure();
        closeStream();
        return;
      }
      const writeStored = (stored: StoredLogEvent, replayed = false): void => {
        if (stored.seq <= lastWrittenSeq) return;
        if (encodedBytes(stored) > MAX_SSE_EVENT_BYTES) {
          // Full bytes remain canonical. The client refreshes bounded views
          // and checkpoints beyond this event without breaking the stream.
          lastWrittenSeq = stored.seq;
          if (!writer.write("agent_status", stored.seq, {
            agentId: request.params.id, instanceId: workspace.instanceId(),
            cursor: stored.seq, reset: true, snapshot: true,
          } satisfies import("@ponderosa/core").AgentStreamStatusDto)) {
            serverMetrics.sseBackpressure();
            closeStream();
          }
          return;
        }
        const event = envelope(request.params.id, stored, replayed);
        lastWrittenSeq = stored.seq;
        if (event && !writer.write("message", stored.seq, event)) {
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
      if (streamClosed) return;

      heartbeat = setInterval(() => {
        if (!writer.write("heartbeat", undefined, { ts: new Date().toISOString() })) {
          serverMetrics.sseBackpressure();
          closeStream();
        }
      }, SSE_HEARTBEAT_MS);
      request.raw.on("close", cleanup);
    },
  );
}
