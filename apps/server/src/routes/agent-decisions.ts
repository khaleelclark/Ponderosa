import {
  PONDEROSA_DECISION_TOOL,
  canonicalizeProviderText,
  DECISION_QUESTION_MAX_CODE_POINTS,
  DECISION_MAX_QUESTIONS,
  unicodeCodePointLength,
  type DecisionDto,
  type DecisionQuestionDto,
  truncateUnicodeCodePoints,
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
    if (!capability.availableToolNames?.includes(PONDEROSA_DECISION_TOOL.name)) {
      return reply.code(403).send({ error: "Decision tool is not authorized for this Run" });
    }
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
    const unknown = Object.keys(body).filter((key) => !["idempotencyKey", "mode", "question", "questions", "context", "options", "allowOther", "blocking"].includes(key));
    if (unknown.length) return reply.code(400).send({ error: `unknown Decision field(s): ${unknown.join(", ")}` });
    if (body.idempotencyKey !== undefined && (typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim() || body.idempotencyKey.trim().length > 200)) {
      return reply.code(400).send({ error: "Decision idempotencyKey must be a non-empty string of at most 200 characters" });
    }
    const steeringInjectionIds = coordinationV3.steeringInjectionIds(capability.runId);
    const normalizeQuestion = (item: Record<string, unknown>, grouped: boolean) => {
      if (typeof item.question !== "string" || !item.question.trim()) throw new Error("Decision requires question");
      const question = canonicalizeProviderText(item.question, steeringInjectionIds).trim();
      if (!question) throw new Error("Decision requires question");
      if (unicodeCodePointLength(question) > DECISION_QUESTION_MAX_CODE_POINTS) throw new Error(`Decision question exceeds ${DECISION_QUESTION_MAX_CODE_POINTS} Unicode code points`);
      if (item.context !== undefined && typeof item.context !== "string") throw new Error("Decision context must be text");
      const options = Array.isArray(item.options) ? [...item.options] : [];
      const mode = item.mode === undefined ? (options.length ? "choice" : "text") : item.mode;
      if (!(grouped ? ["choice", "text"] : ["approval", "choice", "text"]).includes(String(mode))) throw new Error(grouped ? "Grouped questions support text or choice; approvals remain separate" : "Decision mode must be approval, choice, or text");
      if (mode === "choice" && !options.length) throw new Error("choice Decisions require options");
      if (mode === "approval" && !options.length) options.push({ id: "approve", label: "Approve" }, { id: "do_not_approve", label: "Do not approve" });
      if (mode === "approval" && !options.some(option => option?.id === "approve")) throw new Error("approval Decisions require a canonical approve option");
      if (mode === "text" && options.length) throw new Error("text Decisions do not use options");
      if (options.length > 8 || options.some(option => !option || typeof option !== "object" || typeof option.id !== "string" || typeof option.label !== "string")) throw new Error("Decision options require id and label and are limited to 8");
      const normalizedOptions = options.map(option => ({ id: truncateUnicodeCodePoints(option.id, 80),
        label: truncateUnicodeCodePoints(canonicalizeProviderText(option.label, steeringInjectionIds), 120),
        ...(typeof option.description === "string" ? { description: truncateUnicodeCodePoints(canonicalizeProviderText(option.description, steeringInjectionIds), 400) } : {}) }));
      if (new Set(normalizedOptions.map(option => option.id)).size !== normalizedOptions.length) throw new Error("Decision option IDs must be unique after normalization");
      return { mode: mode as DecisionDto["mode"], question,
        ...(typeof item.context === "string" && item.context.trim() ? { context: canonicalizeProviderText(item.context, steeringInjectionIds).trim() } : {}),
        options: normalizedOptions, allowOther: true };
    };
    let questions: DecisionQuestionDto[] | undefined;
    let normalized: ReturnType<typeof normalizeQuestion>;
    try {
      if (body.questions !== undefined) {
        if (Object.keys(body).some(key => !["idempotencyKey", "blocking", "questions"].includes(key))) throw new Error("Use question or structured questions, not both");
        if (!Array.isArray(body.questions) || !body.questions.length || body.questions.length > DECISION_MAX_QUESTIONS) throw new Error("A Decision requires one to three questions");
        questions = body.questions.map(item => {
          if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !["id", "question", "context", "mode", "options", "allowOther"].includes(key)) ||
              typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(item.id)) throw new Error("Each question requires a stable ID of at most 80 letters, numbers, underscores or hyphens");
          return { ...normalizeQuestion(item, true), id: item.id } as DecisionQuestionDto;
        });
        if (new Set(questions.map(q => q.id)).size !== questions.length) throw new Error("Question IDs must be unique");
        normalized = { mode: "text", question: questions[0]!.question, options: [], allowOther: true };
      } else normalized = normalizeQuestion(body, false);
    } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    const { mode, question, context: decisionContext, options: normalizedOptions } = normalized;
    const idempotencyKey = typeof body.idempotencyKey === "string"
      ? body.idempotencyKey.trim()
      : derivedRunActionKey(capability.runId, "ask", {
          mode, question, ...(questions ? { questions } : {}), context: decisionContext ?? null, options: normalizedOptions,
          allowOther: true, blocking: body.blocking !== false,
        });
    const continuationRequestIds = body.blocking === false
      ? []
      : coordinationV3.outboundAwaitingQuestionRequestIdsAttachedToRun(
          capability.runId, agent.id,
        );
    const taskReplyRoots = coordinationV3.requiredReplyObligationsForRun(capability.v3SchedulerRunId)
      .filter(o => ['broadcast','direct_to_user'].includes(o.replyAuthority.intent) &&
        (o.state === 'pending' || (o.deliveryPhase === 'initial' && o.state === 'satisfied')));
    if (body.blocking !== false && taskReplyRoots.length) {
      const replay = workspace.decisionForIdempotency(agent.id, idempotencyKey);
      const origins = new Set(coordinationV3.taskOriginRunIds(capability.v3SchedulerRunId));
      const blockers = workspace.decisionsForRuns(origins).filter(d => d.blocking && d.status === 'pending' &&
        d.agentId === agent.id && d.projectId === agent.projectId && d.conversationId === active.conversationId);
      if (blockers.some(d => d.id !== replay?.id) || taskReplyRoots
        .some(o => o.blockingDecisionId && o.blockingDecisionId !== replay?.id)) {
        return reply.code(409).send({ error: 'task_decision_already_pending: answer the existing exact blocking Decision first' });
      }
    }
    const cursor = workspace.cursor();
    let decision;
    try {
      decision = workspace.createDecision({
        idempotencyKey,
        projectId: agent.projectId,
        ...(active.conversationId ? { conversationId: active.conversationId } : {}),
        agentId: agent.id,
        runId: active.runId,
        coordinationRunId: capability.runId,
        mode: mode as "approval" | "choice" | "text",
        question,
        ...(questions ? { questions } : {}),
        ...(decisionContext ? { context: decisionContext } : {}),
        options: normalizedOptions,
        allowOther: true,
        ...(continuationRequestIds.length ? { continuationRequestIds } : {}),
        blocking: body.blocking !== false,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Decision idempotency key was reused with different input") {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
    if (decision.blocking && decision.status === 'pending') coordinationV3.waitForTaskDecision({
      runAuthorization: { runId: capability.v3SchedulerRunId, agentId: capability.agentId, fencingToken: capability.v3FencingToken },
      decisionId: decision.id,
      scopeKey: active.conversationId ? `conversation:${active.conversationId}` : `agent:${agent.id}`,
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
      conversationIds: [agent.conversationId],
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
      decision: { ...(decision.questions ? { questionCount: decision.questions.length } : {}), id: decision.id, mode: decision.mode, options: decision.options, allowOther: decision.allowOther, status: decision.status },
    }, true);
    publishWorkspaceSince(cursor);
    return reply.code(201).send(decision);
  });
}
