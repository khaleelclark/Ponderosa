import {
  canonicalizeProviderText,
  truncateUnicodeCodePoints,
  type DecisionDto,
} from "@ponderosa/core";
import type { AgentStore, CoordinationV3Store, WorkspaceStore } from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import type { ActiveRun, AgentMessageCapability } from "../app-contracts.js";
import { derivedRunActionKey } from "../security.js";

interface AgentDecisionRoutesContext {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  workspace: WorkspaceStore;
  agentMessageCapabilities: ReadonlyMap<string, AgentMessageCapability>;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  capabilityOwnsAuthoritativeRun(
    capability: AgentMessageCapability,
    run: ActiveRun | undefined,
  ): boolean;
  publishWorkspaceSince(cursor: number): void;
}

export function registerAgentDecisionRoutes(
  app: FastifyInstance,
  context: AgentDecisionRoutesContext,
): void {
  const {
    store,
    coordinationV3,
    workspace,
    agentMessageCapabilities,
    activeRuns,
    capabilityOwnsAuthoritativeRun,
    publishWorkspaceSince,
  } = context;

  app.post<{ Body: unknown }>("/api/agent-decisions", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    const agent = capability ? store.getAgent(capability.agentId) : undefined;
    if (!capability || !active || !agent || !capabilityOwnsAuthoritativeRun(capability, active) || active.messageCapability !== token) {
      return reply.code(401).send({ error: "Decision capability is not authorized for an active Run" });
    }
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
    const unknown = Object.keys(body).filter((key) => !["idempotencyKey", "mode", "question", "context", "options", "allowOther", "blocking"].includes(key));
    if (unknown.length) return reply.code(400).send({ error: `unknown Decision field(s): ${unknown.join(", ")}` });
    if (body.idempotencyKey !== undefined && (typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim() || body.idempotencyKey.trim().length > 200)) {
      return reply.code(400).send({ error: "Decision idempotencyKey must be a non-empty string of at most 200 characters" });
    }
    if (typeof body.question !== "string" || !body.question.trim()) {
      return reply.code(400).send({ error: "Decision requires question" });
    }
    const options = Array.isArray(body.options) ? body.options : [];
    const mode = body.mode === undefined ? (options.length ? "choice" : "text") : String(body.mode);
    if (!["approval", "choice", "text"].includes(mode)) return reply.code(400).send({ error: "Decision mode must be approval, choice, or text" });
    if (mode === "choice" && options.length === 0) return reply.code(400).send({ error: "choice Decisions require options" });
    if (mode === "approval" && options.length === 0) options.push({ id: "approve", label: "Approve" }, { id: "do_not_approve", label: "Do not approve" });
    if (mode === "approval" && !options.some((option) => (option as { id?: unknown })?.id === "approve")) return reply.code(400).send({ error: "approval Decisions require a canonical approve option" });
    if (mode === "text" && options.length) return reply.code(400).send({ error: "text Decisions do not use options" });
    if (options.length > 8 || options.some((option) => !option || typeof option !== "object" || typeof (option as { id?: unknown }).id !== "string" || typeof (option as { label?: unknown }).label !== "string")) {
      return reply.code(400).send({ error: "Decision options require id and label and are limited to 8" });
    }
    if (new Set(options.map((option) => (option as { id: string }).id)).size !== options.length) return reply.code(400).send({ error: "Decision option IDs must be unique" });
    const steeringInjectionIds = coordinationV3.steeringInjectionIds(capability.runId);
    const question = truncateUnicodeCodePoints(
      canonicalizeProviderText(body.question, steeringInjectionIds).trim(),
      1_000,
    );
    const decisionContext = typeof body.context === "string" && body.context.trim()
      ? canonicalizeProviderText(body.context, steeringInjectionIds).trim()
      : undefined;
    const normalizedOptions = options.map((option) => ({
      id: String((option as { id: string }).id).slice(0, 80),
      label: truncateUnicodeCodePoints(
        canonicalizeProviderText(String((option as { label: string }).label), steeringInjectionIds),
        120,
      ),
      ...(typeof (option as { description?: unknown }).description === "string"
        ? { description: truncateUnicodeCodePoints(
            canonicalizeProviderText(String((option as { description: string }).description), steeringInjectionIds),
            400,
          ) }
        : {}),
    }));
    const idempotencyKey = typeof body.idempotencyKey === "string"
      ? body.idempotencyKey.trim()
      : derivedRunActionKey(capability.runId, "ask", {
          mode, question, context: decisionContext ?? null, options: normalizedOptions,
          allowOther: true, blocking: body.blocking !== false,
        });
    const continuationRequestIds = body.blocking === false
      ? []
      : coordinationV3.outboundAwaitingQuestionRequestIdsAttachedToRun(
          capability.runId, agent.id,
        );
    const cursor = workspace.cursor();
    const decision = workspace.createDecision({
      idempotencyKey,
      projectId: agent.projectId,
      ...(active.conversationId ? { conversationId: active.conversationId } : {}),
      agentId: agent.id,
      runId: active.runId,
      coordinationRunId: capability.runId,
      mode: mode as "approval" | "choice" | "text",
      question,
      ...(decisionContext ? { context: decisionContext } : {}),
      options: normalizedOptions,
      allowOther: true,
      ...(continuationRequestIds.length ? { continuationRequestIds } : {}),
      blocking: body.blocking !== false,
    });
    if (decision.blocking && decision.continuationRequestIds?.length) coordinationV3.suspendQuestionsForDecision({
      runId: capability.runId,
      agentId: agent.id,
      decisionId: decision.id,
      requestIds: decision.continuationRequestIds,
    });
    workspace.createNotification({
      projectId: decision.projectId,
      conversationId: decision.conversationId,
      conversationIds: agent.conversationIds,
      agentId: decision.agentId,
      agentIds: [decision.agentId],
      kind: "decision",
      category: "decision",
      severity: decision.blocking ? "urgent" : "attention",
      status: "open",
      dedupeKey: `decision:${decision.id}`,
      action: { kind: "open_decision", targetId: decision.id },
      title: `${agent.title} needs a decision`,
      body: decision.question,
      decision: { id: decision.id, mode: decision.mode, options: decision.options, allowOther: decision.allowOther, status: decision.status },
    }, true);
    publishWorkspaceSince(cursor);
    return reply.code(201).send(decision);
  });
}
