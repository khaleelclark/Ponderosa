import { createHash } from "node:crypto";
import type { AgentStore } from "@ponderosa/agents";
import {
  CompactionHistoryQueryError,
  normalizeCompactionHistoryQuery,
} from "@ponderosa/agents";
import { PONDEROSA_HISTORY_TOOL } from "@ponderosa/core";
import type { FastifyInstance } from "fastify";
import {
  BrowserSessionError,
  type BrowserSessionManager,
  type BrowserScope,
} from "../browser-session-manager.js";
import type {
  ActiveRun,
  AgentMessageCapability,
} from "../app-contracts.js";

interface AgentRuntimeToolRoutesContext {
  store: AgentStore;
  agentMessageCapabilities: ReadonlyMap<string, AgentMessageCapability>;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  browserSessions: BrowserSessionManager;
  projectBrowserSessions: BrowserSessionManager;
  projectBrowserGrants: Map<string, { agentId: string; runId: string }>;
  projectBrowserScope(projectId: string, grant?: { agentId: string; runId: string }): BrowserScope;
  capabilityOwnsAuthoritativeRun(
    capability: AgentMessageCapability,
    run: ActiveRun | undefined,
  ): boolean;
}

export function registerAgentRuntimeToolRoutes(
  app: FastifyInstance,
  context: AgentRuntimeToolRoutesContext,
): void {
  const {
    store,
    agentMessageCapabilities,
    activeRuns,
    browserSessions,
    projectBrowserSessions,
    projectBrowserGrants,
    projectBrowserScope,
    capabilityOwnsAuthoritativeRun,
  } = context;

  app.post<{
    Body: {
      action?: unknown;
      query?: unknown;
      communicationEventId?: unknown;
      limit?: unknown;
      before?: unknown;
      after?: unknown;
    };
  }>("/api/agent-history", async (request, reply) => {
    const startedAt = performance.now();
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    const agent = capability ? store.getAgent(capability.agentId) : undefined;
    if (!capability || !active || !agent || !capabilityOwnsAuthoritativeRun(capability, active) ||
        active.messageCapability !== token || !capability.historyRetrievalBoundary ||
        !capability.availableToolNames.includes(PONDEROSA_HISTORY_TOOL.name)) {
      return reply.code(401).send({ error: "history capability is not authorized for an active compacted run" });
    }
    const historyBoundary = capability.historyRetrievalBoundary;
    const requestedAction = request.body?.action;
    const action = requestedAction === "read" ? "read" as const : "search" as const;
    const rawQuery = typeof request.body?.query === "string" ? request.body.query : "";
    const rawCommunicationEventId = typeof request.body?.communicationEventId === "string"
      ? request.body.communicationEventId : "";
    const rawLimit = request.body?.limit;
    const rawBefore = request.body?.before;
    const rawAfter = request.body?.after;
    const strategy = "lexical" as const;
    const appendAudit = (input: {
      normalizedQuery?: string;
      outcome: "results" | "no_match" | "rejected";
      reason?: string;
      eligibleMessages?: number;
      matchedMessages?: number;
      selected?: Array<{
        communicationEventId: string;
        contentSha256: string;
        matchBasis?: "lexical";
      }>;
      excludedCurrentContextEventIds?: string[];
      responseUtf8Bytes?: number;
      hasMore?: boolean;
    }) => store.appendEvent(agent.id, {
      type: "compaction_history_retrieval",
      executionId: active.executionId,
      runId: active.runId,
      action,
      ...(action === "search" ? { query: rawQuery.trim().slice(0, 200), strategy } : {
        communicationEventId: rawCommunicationEventId.trim().slice(0, 200),
      }),
      ...(input.normalizedQuery ? { normalizedQuery: input.normalizedQuery } : {}),
      querySha256: createHash("sha256").update(
        action === "search" ? rawQuery.trim() : `read:${rawCommunicationEventId.trim()}`,
      ).digest("hex"),
      ...(action === "search" ? { strategy } : {}),
      compactionCutoffOrdinal: historyBoundary.canonicalOrdinal,
      outcome: input.outcome,
      ...(input.reason ? { reason: input.reason } : {}),
      scannedMessages: input.eligibleMessages ?? 0,
      eligibleMessages: input.eligibleMessages ?? 0,
      matchedMessages: input.matchedMessages ?? 0,
      selected: input.selected ?? [],
      excludedCurrentContextEventIds: input.excludedCurrentContextEventIds ?? [],
      responseUtf8Bytes: input.responseUtf8Bytes ?? 0,
      hasMore: input.hasMore ?? false,
      durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
    });
    try {
      const allowedKeys = new Set(["action", "query", "communicationEventId", "limit", "before", "after"]);
      if (request.body && Object.keys(request.body).some((key) => !allowedKeys.has(key))) {
        throw new CompactionHistoryQueryError("history request contains an unsupported field");
      }
      if (requestedAction !== "search" && requestedAction !== "read") {
        throw new CompactionHistoryQueryError("action must be search or read");
      }
      const common = {
        agentId: agent.id,
        ...(capability.conversationId ? { currentConversationId: capability.conversationId } : {}),
        boundary: historyBoundary,
        excludedCommunicationEventIds: new Set(
          capability.historyRetrievalExcludedCommunicationEventIds,
        ),
      };
      if (action === "read") {
        if (rawBefore !== undefined && (!Number.isSafeInteger(rawBefore) || Number(rawBefore) < 0 || Number(rawBefore) > 2) ||
            rawAfter !== undefined && (!Number.isSafeInteger(rawAfter) || Number(rawAfter) < 0 || Number(rawAfter) > 2)) {
          throw new CompactionHistoryQueryError("before and after must be integers from 0 to 2");
        }
        const { response, audit } = store.readCompactionHistory({
          ...common,
          communicationEventId: rawCommunicationEventId,
          ...(rawBefore !== undefined ? { before: Number(rawBefore) } : {}),
          ...(rawAfter !== undefined ? { after: Number(rawAfter) } : {}),
        });
        appendAudit({
          outcome: "results",
          eligibleMessages: audit.eligibleMessages,
          matchedMessages: response.messages.length,
          selected: audit.selected,
          excludedCurrentContextEventIds: audit.excludedRecentTailEventIds,
          responseUtf8Bytes: response.utf8Bytes,
        });
        return response;
      }
      const normalized = normalizeCompactionHistoryQuery(rawQuery);
      if (rawLimit !== undefined && (!Number.isSafeInteger(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 8)) {
        throw new CompactionHistoryQueryError("limit must be an integer from 1 to 8");
      }
      const { response, audit } = store.searchCompactionHistory({
        ...common,
        query: rawQuery,
        ...(rawLimit !== undefined ? { limit: Number(rawLimit) } : {}),
      });
      appendAudit({
        normalizedQuery: normalized.normalizedQuery,
        outcome: response.noMatch ? "no_match" : "results",
        eligibleMessages: response.eligibleMessages,
        matchedMessages: response.hits.length,
        selected: audit.selected,
        excludedCurrentContextEventIds: audit.excludedRecentTailEventIds,
        responseUtf8Bytes: response.utf8Bytes,
        hasMore: response.hasMore,
      });
      return response;
    } catch (error) {
      if (!(error instanceof CompactionHistoryQueryError)) throw error;
      let normalizedQuery: string | undefined;
      if (action === "search") {
        try { normalizedQuery = normalizeCompactionHistoryQuery(rawQuery).normalizedQuery; } catch { /* rejected */ }
      }
      appendAudit({ normalizedQuery, outcome: "rejected", reason: error.message });
      return reply.code(400).send({ error: error.message });
    }
  });

  app.post<{
    Body: {
      operation?: "open" | "navigate" | "inspect" | "act" | "screenshot" | "take_control" | "close";
      url?: string;
      action?: unknown;
      selector?: unknown;
      text?: unknown;
      key?: unknown;
    };
  }>("/api/agent-browser", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    const agent = capability ? store.getAgent(capability.agentId) : undefined;
    if (!capability || !active || !agent || !capabilityOwnsAuthoritativeRun(capability, active) || active.messageCapability !== token) {
      return reply.code(401).send({ error: "browser capability is not authorized for an active run" });
    }
    const projectGrant = projectBrowserGrants.get(agent.projectId);
    const borrowingProjectBrowser = projectGrant?.agentId === agent.id && projectGrant.runId === active.runId;
    const sessionManager = borrowingProjectBrowser ? projectBrowserSessions : browserSessions;
    const scope: BrowserScope = borrowingProjectBrowser
      ? projectBrowserScope(agent.projectId, projectGrant)
      : {
          projectId: agent.projectId,
          agentId: agent.id,
          runId: active.runId,
          ...(active.conversationId ? { conversationId: active.conversationId } : {}),
        };
    try {
      switch (request.body?.operation) {
        case "open": {
          const session = await sessionManager.open(scope, request.body.url);
          return { session, snapshot: await sessionManager.inspect(scope) };
        }
        case "navigate": {
          if (typeof request.body.url !== "string") throw new BrowserSessionError("url is required");
          const session = await sessionManager.navigate(scope, request.body.url, "agent");
          return { session, snapshot: await sessionManager.inspect(scope) };
        }
        case "inspect":
          return { session: sessionManager.get(scope.agentId), snapshot: await sessionManager.inspect(scope) };
        case "act": {
          const session = await sessionManager.act(scope, request.body);
          return { session, snapshot: await sessionManager.inspect(scope) };
        }
        case "screenshot":
          return { session: sessionManager.get(scope.agentId), artifact: await sessionManager.captureArtifact(scope) };
        case "take_control":
          return { session: await sessionManager.setControl(scope, "agent") };
        case "close": {
          if (borrowingProjectBrowser) {
            const session = sessionManager.get(scope.agentId);
            if (!session) throw new BrowserSessionError("project browser session is unavailable", 404);
            projectBrowserGrants.delete(agent.projectId);
            return { session: await sessionManager.setControl(scope, "operator", session.controlEpoch) };
          }
          return { session: await sessionManager.close(scope, "agent_closed") };
        }
        default:
          return reply.code(400).send({ error: "unknown browser operation" });
      }
    } catch (error) {
      if (error instanceof BrowserSessionError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
}
