import type { AgentTelemetryStream } from "@ponderosa/core";
import type { FastifyInstance } from "fastify";
import {
  RESULT_PAGE_MIN_BYTES,
  RESULT_PAGE_DEFAULT_BYTES,
  RESULT_PAGE_MAX_BYTES,
  encodeActivityOutputCursor,
  decodeActivityOutputCursor,
} from "../cursors.js";
import type { ServerContext } from "../server-context.js";

export function registerAgentAuditRoutes(
  app: FastifyInstance,
  { agentDetail, store }: ServerContext,
): void {
  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string; focusId?: string } }>("/api/agents/:id", async (request, reply) => {
    if (store.agentCreationPending(request.params.id)) return reply.code(404).send({ error: "agent not found" });
    const limit = Math.min(1_000, Math.max(1, Number(request.query.limit ?? 100) || 100));
    try {
      const detail = agentDetail(request.params.id, { limit, cursor: request.query.cursor, focusId: request.query.focusId });
      return detail ?? reply.code(404).send({ error: "agent not found" });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid history cursor" });
    }
  });

  app.get<{
    Params: { id: string; stream: AgentTelemetryStream };
    Querystring: { limit?: string; cursor?: string; focusId?: string };
  }>("/api/agents/:id/history/:stream", async (request, reply) => {
    if (!store.getAgent(request.params.id) || store.agentCreationPending(request.params.id)) return reply.code(404).send({ error: "agent not found" });
    const limit = Math.min(500, Math.max(1, Number(request.query.limit ?? 100) || 100));
    const streams = new Set<AgentTelemetryStream>(["runOutput", "activity", "changedFiles", "runs", "workItems", "artifacts"]);
    if (!streams.has(request.params.stream)) return reply.code(404).send({ error: "history stream not found" });
    try {
      const input = { limit, cursor: request.query.cursor, focusId: request.query.focusId };
      switch (request.params.stream) {
        case "runOutput": return { stream: "runOutput" as const, ...store.getRunOutputPage(request.params.id, input) };
        case "activity": return { stream: "activity" as const, ...store.getActivityPage(request.params.id, input) };
        case "changedFiles": return { stream: "changedFiles" as const, ...store.getChangedFilePage(request.params.id, input) };
        case "runs": return { stream: "runs" as const, ...store.getRunPage(request.params.id, input) };
        case "workItems": return { stream: "workItems" as const, ...store.getWorkItemPage(request.params.id, input) };
        case "artifacts": return { stream: "artifacts" as const, ...store.getArtifactPage(request.params.id, input) };
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid history cursor" });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/agents/:id/changed-file",
    async (request, reply) => {
      if (!store.getAgent(request.params.id) || store.agentCreationPending(request.params.id)) return reply.code(404).send({ error: "agent not found" });
      const path = request.query.path;
      if (!path || path.length > 4_096 || path.includes("\0")) return reply.code(400).send({ error: "valid path is required" });
      return store.getChangedFileDetail(request.params.id, path)
        ?? reply.code(404).send({ error: "changed file not found" });
    },
  );

  app.get<{
    Params: { id: string; seq: string };
    Querystring: { cursor?: string; maxBytes?: string };
  }>("/api/agents/:id/activity/:seq/output", async (request, reply) => {
    if (!store.getAgent(request.params.id) || store.agentCreationPending(request.params.id)) return reply.code(404).send({ error: "agent not found" });
    const seq = Number(request.params.seq);
    if (!Number.isSafeInteger(seq) || seq < 1) return reply.code(400).send({ error: "invalid activity sequence" });
    try {
      const cursor = request.query.cursor
        ? decodeActivityOutputCursor(request.query.cursor, request.params.id, seq)
        : undefined;
      const requestedBytes = Number(request.query.maxBytes ?? RESULT_PAGE_DEFAULT_BYTES);
      const maxBytes = Math.min(
        RESULT_PAGE_MAX_BYTES,
        Math.max(RESULT_PAGE_MIN_BYTES, Number.isFinite(requestedBytes) ? Math.floor(requestedBytes) : RESULT_PAGE_DEFAULT_BYTES),
      );
      const startUtf8Byte = cursor?.byteOffset ?? 0;
      const page = store.getActivityOutputPage(request.params.id, seq, startUtf8Byte, maxBytes);
      if (!page) return reply.code(404).send({ error: "tool output not found" });
      if (cursor && cursor.sha256 !== page.sha256) throw new Error("activity output changed after the cursor was issued");
      const endUtf8Byte = startUtf8Byte + page.pageUtf8Bytes;
      return {
        agentId: page.agentId,
        activityId: page.activityId,
        seq: page.seq,
        output: page.output,
        pageUtf8Bytes: page.pageUtf8Bytes,
        startUtf8Byte,
        endUtf8Byte,
        totalUtf8Bytes: page.totalUtf8Bytes,
        sha256: page.sha256,
        ...(endUtf8Byte < page.totalUtf8Bytes ? {
          nextCursor: encodeActivityOutputCursor({
            agentId: page.agentId,
            seq: page.seq,
            sha256: page.sha256,
            byteOffset: endUtf8Byte,
          }),
        } : {}),
      };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid activity output cursor" });
    }
  });
}

export function registerAgentRunHistoryRoute(
  app: FastifyInstance,
  { store }: ServerContext,
): void {
  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>("/api/agents/:id/runs", async (request, reply) => {
    if (!store.getAgent(request.params.id) || store.agentCreationPending(request.params.id)) return reply.code(404).send({ error: "agent not found" });
    const limit = Math.min(500, Math.max(1, Number(request.query.limit ?? 100) || 100));
    try { return store.getRunPage(request.params.id, { limit, cursor: request.query.cursor }); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid history cursor" }); }
  });
}
