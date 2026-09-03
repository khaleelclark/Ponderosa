import { createHash, randomUUID } from "node:crypto";
import {
  TERMINAL_REQUEST_STATES,
  canonicalizeProviderText,
  unicodeCodePointLength,
  type AgentDto,
  type CommunicationEvent,
  type CoordinationRequestState,
  type AssetDto,
  type ModelOption,
  type RequestLifetime,
} from "@ponderosa/core";
import type {
  AgentStore,
  ConversationDeliveryIntent,
  CoordinationV3Store,
} from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import type {
  ActiveRun,
  AgentMessageCapability,
  EngineRegistration,
} from "../app-contracts.js";
import { runtimeSelectionError } from "../runtime-selection.js";
import { derivedRunActionKey } from "../security.js";
import { leaseConversationDelivery } from "../delivery-leases.js";

interface AgentCoordinationRoutesContext {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  engines: ReadonlyMap<string, EngineRegistration>;
  deletingAgentIds: Set<string>;
  deletingProjectIds: ReadonlySet<string>;
  deletingConversationIds: ReadonlySet<string>;
  conversationDeliveryLeases: Map<string, number>;
  agentDeliveryLeases: Map<string, number>;
  agentMessageCapabilities: ReadonlyMap<string, AgentMessageCapability>;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  cachedModelOptions(adapter: EngineRegistration["adapter"], projectId?: string): ModelOption[];
  capabilityOwnsAuthoritativeRun(
    capability: AgentMessageCapability,
    run: ActiveRun | undefined,
  ): boolean;
  recordCommunication(event: CommunicationEvent): CommunicationEvent;
  projectCommunicationToAgentAudit(
    agentId: string,
    event: CommunicationEvent,
    renderedText: string,
    attachments?: AssetDto[],
  ): void;
  publishCoordinationV3Changed(
    agentId: string,
    options?: { conversationIds?: string[] },
  ): void;
  notifyScheduler(): void;
  runAuthorization(capability: AgentMessageCapability): {
    runId: string;
    agentId: string;
    fencingToken: number;
  };
  resolveExplicitCollaborationIntents(
    conversationId: string,
    authorAgentId: string,
    recipientAgentIds: string[],
    text: string,
    relayDepth: number,
    mentionTrail: string[],
  ): { text: string; intents: ConversationDeliveryIntent[]; error?: string };
  logWarn(meta: Record<string, unknown>, message: string): void;
  reconcileRuntimeCommunicationProjections(filter?: {
    projectId?: string;
    communicationEventId?: string;
    allowQuarantinedAgentIds?: ReadonlySet<string>;
  }): Promise<number>;
}

export function registerAgentCoordinationRoutes(
  app: FastifyInstance,
  context: AgentCoordinationRoutesContext,
): void {
  const {
    store,
    coordinationV3,
    engines,
    deletingAgentIds,
    deletingProjectIds,
    deletingConversationIds,
    conversationDeliveryLeases,
    agentDeliveryLeases,
    agentMessageCapabilities,
    activeRuns,
    cachedModelOptions,
    capabilityOwnsAuthoritativeRun,
    recordCommunication,
    projectCommunicationToAgentAudit,
    publishCoordinationV3Changed,
    notifyScheduler,
    runAuthorization,
    resolveExplicitCollaborationIntents,
    logWarn,
    reconcileRuntimeCommunicationProjections,
  } = context;

  app.post<{
    Body: { idempotencyKey?: string; title?: string; engine?: string; model?: string; effort?: string; text?: string; lifetime?: RequestLifetime; awaitResult?: boolean };
  }>("/api/agent-spawn", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    const manager = capability ? store.getAgent(capability.agentId) : undefined;
    if (!capability || !capabilityOwnsAuthoritativeRun(capability, active) || active!.messageCapability !== token || !manager) {
      return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    }
    const body = request.body as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply.code(400).send({ error: "spawn body must be an object" });
    }
    const candidate = body as Record<string, unknown>;
    const unknownFields = Object.keys(candidate).filter((key) =>
      !["idempotencyKey", "title", "engine", "model", "effort", "text", "lifetime", "awaitResult"].includes(key));
    if (unknownFields.length) {
      return reply.code(400).send({ error: `unknown spawn field(s): ${unknownFields.join(", ")}` });
    }
    for (const key of ["idempotencyKey", "title", "engine", "model", "effort", "text"] as const) {
      if (candidate[key] !== undefined && typeof candidate[key] !== "string") {
        return reply.code(400).send({ error: `${key} must be a string` });
      }
    }
    if (candidate.awaitResult !== undefined && typeof candidate.awaitResult !== "boolean") {
      return reply.code(400).send({ error: "awaitResult must be a boolean" });
    }
    if (!candidate.lifetime || typeof candidate.lifetime !== "object" || Array.isArray(candidate.lifetime)) {
      return reply.code(400).send({ error: "lifetime must be indefinite or a deadline" });
    }
    const lifetime = candidate.lifetime as Record<string, unknown>;
    const allowedLifetimeFields = lifetime.kind === "deadline" ? ["kind", "at"] : ["kind"];
    if ((lifetime.kind !== "deadline" && lifetime.kind !== "indefinite") ||
        (lifetime.kind === "deadline" && (typeof lifetime.at !== "string" || !lifetime.at.trim() ||
          !Number.isFinite(Date.parse(lifetime.at)))) ||
        Object.keys(lifetime).some((key) => !allowedLifetimeFields.includes(key))) {
      return reply.code(400).send({ error: "lifetime must be indefinite or a deadline with an ISO at timestamp" });
    }
    const idempotencyKey = request.body?.idempotencyKey?.trim();
    const steeringInjectionIds = coordinationV3.steeringInjectionIds(capability.runId);
    const title = request.body?.title === undefined
      ? undefined
      : canonicalizeProviderText(request.body.title, steeringInjectionIds).trim();
    const text = request.body?.text === undefined
      ? undefined
      : canonicalizeProviderText(request.body.text, steeringInjectionIds).trim();
    const engineId = request.body?.engine?.trim();
    if (!idempotencyKey || idempotencyKey.length > 200 || !title || unicodeCodePointLength(title) < 2 || unicodeCodePointLength(title) > 60 || !text || !engineId || !request.body.lifetime) {
      return reply.code(400).send({ error: "idempotencyKey, title, engine, text, and explicit lifetime are required" });
    }
    const payloadHash = createHash("sha256").update(JSON.stringify({
      managerAgentId: manager.id,
      runId: capability.runId,
      title,
      engine: engineId,
      model: request.body.model ?? null,
      effort: request.body.effort ?? null,
      text,
      lifetime: request.body.lifetime,
      awaitResult: request.body.awaitResult ?? null,
    })).digest("hex");
    let creationOperation;
    try {
      creationOperation = store.beginAgentCreationOperation({
        projectId: manager.projectId,
        actorScope: `agent:${manager.id}:run:${capability.runId}`,
        kind: "managed",
        idempotencyKey,
        payloadHash,
      }).operation;
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "managed Agent replay conflict" });
    }
    if (creationOperation.status === "completed" && creationOperation.result) {
      return { ...(creationOperation.result as Record<string, unknown>), replayed: true };
    }
    if (creationOperation.status === "completed" && !creationOperation.result) {
      return reply.code(503).send({
        error: "managed Agent creation committed without a recoverable result",
        operationId: creationOperation.id,
      });
    }
    if (creationOperation.status === "canonical_committed" && creationOperation.communicationEventId) {
      if (!creationOperation.result) {
        return reply.code(503).send({
          error: "managed Agent creation is committed but its result is still being recovered",
          operationId: creationOperation.id,
        });
      }
      try {
        await reconcileRuntimeCommunicationProjections({
          projectId: manager.projectId,
          communicationEventId: creationOperation.communicationEventId,
          allowQuarantinedAgentIds: new Set(creationOperation.agentIds),
        });
        store.updateAgentCreationOperation(creationOperation.id, { status: "completed", lastError: null });
        for (const agentId of creationOperation.agentIds) deletingAgentIds.delete(agentId);
        return { ...(creationOperation.result as Record<string, unknown>), replayed: true };
      } catch (error) {
        return reply.code(202).send({
          committed: true,
          recovering: true,
          operationId: creationOperation.id,
          ...(creationOperation.result as Record<string, unknown>),
        });
      }
    }
    if (creationOperation.agentIds.length) {
      return reply.code(409).send({
        error: "managed Agent creation is still being recovered; retry with the same idempotency key",
        operationId: creationOperation.id,
        agentIds: creationOperation.agentIds,
      });
    }
    const abandonMutationFreeOperation = (statusCode: 400 | 409, error: string) => {
      store.updateAgentCreationOperation(creationOperation.id, {
        status: "rolled_back",
        lastError: error,
      });
      return reply.code(statusCode).send({ error });
    };
    if (deletingAgentIds.has(manager.id)) {
      return abandonMutationFreeOperation(409, "Agent deletion is already in progress");
    }
    if (!capability.conversationId || manager.conversationId !== capability.conversationId) {
      return abandonMutationFreeOperation(409, "visible managed Agents require an active Team Chat scope");
    }
    const engine = engines.get(engineId);
    if (!engine) return abandonMutationFreeOperation(400, "unknown engine");
    const selectionError = runtimeSelectionError(
      engine.adapter,
      request.body.model,
      request.body.effort,
      cachedModelOptions(engine.adapter, manager.projectId),
    );
    if (selectionError) return abandonMutationFreeOperation(400, selectionError);
    const legacyReplay = store.findAgentSpawn(manager.id, capability.runId, idempotencyKey);
    if (legacyReplay) {
      store.updateAgentCreationOperation(creationOperation.id, {
        status: "completed",
        result: { agent: legacyReplay },
        lastError: null,
      });
      return { agent: legacyReplay, replayed: true };
    }
    let child: AgentDto | undefined;
    let coordinated: { requestIds: string[]; joinId?: string; replayed: boolean } | undefined;
    let openingCommunication: CommunicationEvent | undefined;
    let durableCommitted = false;
    const childId = randomUUID();
    const releaseManagedCreationLease = leaseConversationDelivery(
      conversationDeliveryLeases,
      agentDeliveryLeases,
      capability.conversationId,
      [manager.id, childId],
    );
    try {
    try {
      store.addAgentCreationOperationMember(creationOperation.id, childId, 0);
      deletingAgentIds.add(childId);
      child = store.createAgent(manager.projectId, {
        title, engine: engineId, conversationId: capability.conversationId,
        model: request.body.model?.trim() || undefined, effort: request.body.effort?.trim() || undefined,
        managerAgentId: manager.id,
      }, { agentId: manager.id, executionId: capability.runId, idempotencyKey, prompt: text }, childId);
      const createdChild = child;
      store.sqlite.transaction(() => {
        const requestId = `managed:${createdChild.id}:opening`;
        const openingEventId = `managed-opening:${createdChild.id}`;
        coordinated = coordinationV3.coordinate({
          projectId: manager!.projectId, conversationId: capability!.conversationId,
          requesterAgentId: manager!.id, actorScope: `agent:${manager!.id}:run:${capability!.runId}`,
          idempotencyKey: `managed-agent:${idempotencyKey}`,
          runAuthorization: runAuthorization(capability!),
          requests: [{ requestId, recipientAgentId: createdChild.id, lifetime: request.body.lifetime!, communicationEventId: openingEventId, payload: {
            text, requesterRunId: capability!.runId, managedAgentOpening: true,
          }, ...(capability!.defaultReply ? { replyAuthority: capability!.defaultReply } : {}) }],
          ...(request.body.awaitResult === false ? {} : { join: {
            id: `managed:${createdChild.id}:join`, mode: "all" as const,
            continuationRequestIds: coordinationV3.requestIdsAttachedToRun(capability!.runId, manager!.id)
              .filter((candidate) => !TERMINAL_REQUEST_STATES.has(coordinationV3.getRequest(candidate)?.state ?? "completed")),
          } }),
        });
        openingCommunication = {
          eventId: openingEventId, schemaVersion: 2, projectId: manager!.projectId,
          conversationId: capability!.conversationId!,
          sender: { kind: "agent", agentId: manager!.id, executionId: capability!.runId },
          intent: "collaboration", audience: { kind: "agents", agentIds: [createdChild.id] },
          text: text!, createdAt: new Date().toISOString(), idempotencyKey: `managed-agent:${idempotencyKey}`,
        };
        coordinationV3.recordRuntimeCommunication({
          id: openingEventId,
          projectId: manager!.projectId,
          sender: openingCommunication.sender,
          intent: openingCommunication.intent,
          audience: openingCommunication.audience,
          payload: {
            communication: openingCommunication,
            dispatch: {
              conversationId: capability!.conversationId!,
              text: text!,
              attachments: [],
            },
          },
          now: openingCommunication.createdAt,
        });
        store.updateAgentCreationOperation(creationOperation.id, {
          status: "canonical_committed",
          communicationEventId: openingEventId,
          result: {
            agent: createdChild,
            requestId: coordinated.requestIds[0],
            joinId: coordinated.joinId,
          },
          lastError: null,
        });
      })();
      durableCommitted = true;
    } catch (error) {
      if (durableCommitted) {
        return reply.code(202).send({
          committed: true,
          recovering: true,
          operationId: creationOperation.id,
          ...(store.getAgentCreationOperation(creationOperation.id)?.result as Record<string, unknown>),
        });
      }
      if (child) {
        try {
          const absent = store.deleteAgent(child.id, (agentId) => coordinationV3.handleAgentDeletion(agentId))
            && !store.getAgent(child.id);
          if (absent) {
            deletingAgentIds.delete(child.id);
            store.updateAgentCreationOperation(creationOperation.id, {
              status: "rolled_back",
              lastError: error instanceof Error ? error.message : "managed Agent creation failed",
            });
          } else {
            store.updateAgentCreationOperation(creationOperation.id, {
              status: "rolling_back",
              lastError: error instanceof Error ? error.message : "managed Agent rollback failed",
            });
          }
        } catch (rollbackError) {
          store.updateAgentCreationOperation(creationOperation.id, {
            status: "rolling_back",
            lastError: rollbackError instanceof Error ? rollbackError.message : "managed Agent rollback failed",
          });
        }
      } else {
        let absent = !store.getAgent(childId);
        if (!absent) {
          try {
            store.deleteAgent(childId, (id) => coordinationV3.handleAgentDeletion(id));
          } catch { /* startup recovery retains the quarantine */ }
          absent = !store.getAgent(childId);
        }
        store.updateAgentCreationOperation(creationOperation.id, {
          status: absent ? "rolled_back" : "rolling_back",
          lastError: error instanceof Error ? error.message : "managed Agent creation failed",
        });
        if (absent) deletingAgentIds.delete(childId);
      }
      return reply.code(409).send({ error: error instanceof Error ? error.message : "managed Agent creation failed" });
    }
    try {
      await reconcileRuntimeCommunicationProjections({
        projectId: manager.projectId,
        communicationEventId: openingCommunication!.eventId,
        allowQuarantinedAgentIds: new Set([child!.id]),
      });
      store.updateAgentCreationOperation(creationOperation.id, { status: "completed", lastError: null });
      deletingAgentIds.delete(child!.id);
    } catch (error) {
      store.updateAgentCreationOperation(creationOperation.id, {
        lastError: error instanceof Error ? error.message : "managed Agent projection recovery failed",
      });
      return reply.code(202).send({
        committed: true,
        recovering: true,
        operationId: creationOperation.id,
        ...(store.getAgentCreationOperation(creationOperation.id)?.result as Record<string, unknown>),
      });
    }
    let openingRequest;
    try {
      openingRequest = coordinationV3.getRequest(coordinated!.requestIds[0]!);
    } catch {
      // Request projection is advisory; the committed result contains its ID.
    }
    const conversationIds = openingRequest?.conversationId
      ? [openingRequest.conversationId]
      : [];
    try {
      publishCoordinationV3Changed(manager.id, { conversationIds });
      publishCoordinationV3Changed(child!.id, { conversationIds });
      notifyScheduler();
    } catch { /* durable managed creation remains authoritative */ }
    return {
      agent: child!, requestId: coordinated!.requestIds[0], joinId: coordinated!.joinId, replayed: false,
      executionDirective: coordinated!.joinId ? "The visible managed Agent and tracked opening assignment now exist. End this turn unless independent work remains; the Join will reactivate you." : undefined,
    };
    } finally {
      releaseManagedCreationLease();
    }
  });

  app.post<{
    Body: {
      idempotencyKey?: string;
      recipientAgentId?: string;
      text?: string;
      delegations?: Array<{ recipientAgentId?: string; text?: string }>;
      completionMode?: "join" | "callback" | "record";
      wakePolicy?: "each_result" | "final_only";
      lifetime?: RequestLifetime;
      requests?: Array<{ requestId?: string; recoveryOfRequestId?: string; recipientAgentId?: string; text?: string; lifetime?: RequestLifetime }>;
      join?: { id?: string; mode?: "all" | "any" | "quorum"; quorum?: number; deadlineAt?: string; satisfyingOutcomes?: CoordinationRequestState[]; requestIds?: string[]; wakePolicy?: "each_result" | "final_only" };
    };
  }>("/api/agent-coordinate", async (request, reply) => {
    if (!coordinationV3) return reply.code(404).send({ error: "Communication V3 is not enabled" });
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    const author = capability ? store.getAgent(capability.agentId) : undefined;
    if (!capability || !capabilityOwnsAuthoritativeRun(capability, active) || active!.messageCapability !== token || !author) {
      return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    }
    const steeringInjectionIds = coordinationV3.steeringInjectionIds(capability.runId);
    const body = request.body ?? {};
    const unknownTopLevel = Object.keys(body).filter((key) =>
      !["idempotencyKey", "recipientAgentId", "text", "delegations", "completionMode", "wakePolicy", "lifetime", "requests", "join"].includes(key));
    if (unknownTopLevel.length) {
      return reply.code(400).send({ error: `unknown coordinate field(s): ${unknownTopLevel.join(", ")}` });
    }
    if (body.requests !== undefined && !Array.isArray(body.requests)) {
      return reply.code(400).send({ error: "requests must be an array" });
    }
    if (body.delegations !== undefined && !Array.isArray(body.delegations)) {
      return reply.code(400).send({ error: "delegations must be an array" });
    }
    if (body.idempotencyKey !== undefined && typeof body.idempotencyKey !== "string") {
      return reply.code(400).send({ error: "idempotencyKey must be a string" });
    }
    const shorthand = body.recipientAgentId !== undefined || body.text !== undefined || body.delegations !== undefined ||
      body.completionMode !== undefined || body.wakePolicy !== undefined ||
      body.lifetime !== undefined;
    if (shorthand && (body.requests !== undefined || body.join !== undefined)) {
      return reply.code(400).send({ error: "common delegation fields cannot be combined with requests or join" });
    }
    const hasSingleDelegation = body.recipientAgentId !== undefined || body.text !== undefined;
    if (body.delegations !== undefined && hasSingleDelegation) {
      return reply.code(400).send({ error: "delegations cannot be combined with recipientAgentId or text" });
    }
    if (hasSingleDelegation && (typeof body.recipientAgentId !== "string" || typeof body.text !== "string")) {
      return reply.code(400).send({ error: "coordinate shorthand requires string recipientAgentId and text" });
    }
    if (body.delegations !== undefined) {
      if (body.delegations.length === 0 || body.delegations.length > 100 || body.delegations.some((item) =>
        !item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).some((key) => !["recipientAgentId", "text"].includes(key)) ||
        typeof item.recipientAgentId !== "string" || typeof item.text !== "string")) {
        return reply.code(400).send({ error: "delegations must contain 1 to 100 recipientAgentId/text objects" });
      }
    }
    if (body.completionMode !== undefined && !["join", "callback", "record"].includes(body.completionMode)) {
      return reply.code(400).send({ error: "completionMode must be join, callback, or record" });
    }
    if (body.wakePolicy !== undefined && !["each_result", "final_only"].includes(body.wakePolicy)) {
      return reply.code(400).send({ error: "wakePolicy must be each_result or final_only" });
    }
    if (body.lifetime !== undefined) {
      if (!body.lifetime || typeof body.lifetime !== "object" || Array.isArray(body.lifetime) ||
          (body.lifetime.kind !== "deadline" && body.lifetime.kind !== "indefinite") ||
          (body.lifetime.kind === "deadline" && (typeof body.lifetime.at !== "string" || !body.lifetime.at.trim() ||
            !Number.isFinite(Date.parse(body.lifetime.at))))) {
        return reply.code(400).send({ error: "lifetime must be indefinite or a deadline with an ISO at timestamp" });
      }
      const allowedLifetime = body.lifetime.kind === "deadline" ? ["kind", "at"] : ["kind"];
      const unknownLifetime = Object.keys(body.lifetime).filter((key) => !allowedLifetime.includes(key));
      if (unknownLifetime.length) {
        return reply.code(400).send({ error: `unknown common lifetime field(s): ${unknownLifetime.join(", ")}` });
      }
    }
    for (const candidate of body.requests ?? []) {
      if (!candidate || typeof candidate !== "object") {
        return reply.code(400).send({ error: "each request must be an object" });
      }
      const unknownRequest = Object.keys(candidate).filter((key) =>
        !["requestId", "recoveryOfRequestId", "recipientAgentId", "text", "lifetime"].includes(key));
      if (unknownRequest.length) {
        return reply.code(400).send({ error: `unknown request field(s): ${unknownRequest.join(", ")}` });
      }
      if ((candidate.requestId !== undefined && typeof candidate.requestId !== "string") ||
          (candidate.recoveryOfRequestId !== undefined && typeof candidate.recoveryOfRequestId !== "string") ||
          typeof candidate.recipientAgentId !== "string" || typeof candidate.text !== "string") {
        return reply.code(400).send({ error: "request identifiers and text must be strings" });
      }
      if (candidate.recoveryOfRequestId !== undefined && (
        !candidate.recoveryOfRequestId.trim() ||
        candidate.recoveryOfRequestId.length > 200
      )) {
        return reply.code(400).send({ error: "recoveryOfRequestId must contain 1 to 200 characters" });
      }
      if (!candidate.lifetime || typeof candidate.lifetime !== "object" || Array.isArray(candidate.lifetime)) {
        return reply.code(400).send({ error: "each request requires an explicit lifetime object" });
      }
      const lifetime = candidate.lifetime as RequestLifetime & Record<string, unknown>;
      if (lifetime.kind !== "deadline" && lifetime.kind !== "indefinite") {
        return reply.code(400).send({ error: "request lifetime kind must be deadline or indefinite" });
      }
      if (lifetime.kind === "deadline" && (typeof lifetime.at !== "string" || !lifetime.at.trim() ||
          !Number.isFinite(Date.parse(lifetime.at)))) {
        return reply.code(400).send({ error: "deadline request lifetime requires at" });
      }
      const allowedLifetime = lifetime.kind === "deadline" ? ["kind", "at"] : ["kind"];
      const unknownLifetime = Object.keys(lifetime).filter((key) => !allowedLifetime.includes(key));
      if (unknownLifetime.length) {
        return reply.code(400).send({ error: `unknown request lifetime field(s): ${unknownLifetime.join(", ")}` });
      }
    }
    if (body.join !== undefined) {
      if (!body.join || typeof body.join !== "object" || Array.isArray(body.join)) {
        return reply.code(400).send({ error: "join must be an object" });
      }
      const unknownJoin = Object.keys(body.join).filter((key) =>
        !["id", "mode", "quorum", "deadlineAt", "satisfyingOutcomes", "requestIds", "wakePolicy"].includes(key));
      if (unknownJoin.length) {
        const hint = unknownJoin.includes("deadline") ? "; use deadlineAt" : "";
        return reply.code(400).send({ error: `unknown join field(s): ${unknownJoin.join(", ")}${hint}` });
      }
      if ((body.join.id !== undefined && typeof body.join.id !== "string") ||
          (body.join.deadlineAt !== undefined && (typeof body.join.deadlineAt !== "string" ||
            !body.join.deadlineAt.trim() || !Number.isFinite(Date.parse(body.join.deadlineAt)))) ||
          (body.join.quorum !== undefined && typeof body.join.quorum !== "number") ||
          (body.join.wakePolicy !== undefined && !["each_result", "final_only"].includes(body.join.wakePolicy)) ||
          (body.join.requestIds !== undefined && !Array.isArray(body.join.requestIds)) ||
          (body.join.satisfyingOutcomes !== undefined && !Array.isArray(body.join.satisfyingOutcomes))) {
        return reply.code(400).send({ error: "join fields do not match the published coordinate schema" });
      }
      if (body.join.mode !== undefined && !["all", "any", "quorum"].includes(body.join.mode)) {
        return reply.code(400).send({ error: "join mode must be all, any, or quorum" });
      }
      if (body.join.requestIds?.some((id) => typeof id !== "string") ||
          body.join.satisfyingOutcomes?.some((state) => typeof state !== "string" || ![
            "open", "in_progress", "waiting_dependency", "awaiting_answer", "completed", "blocked",
            "failed", "cancelled", "superseded", "recipient_unavailable", "outcome_unknown", "expired",
          ].includes(state))) {
        return reply.code(400).send({ error: "join requestIds and satisfyingOutcomes contain invalid values" });
      }
    }
    const commonDelegations = (body.delegations ?? (hasSingleDelegation ? [{
      recipientAgentId: body.recipientAgentId,
      text: body.text,
    }] : [])).map((delegation) => ({
      ...delegation,
      text: typeof delegation.text === "string"
        ? canonicalizeProviderText(delegation.text, steeringInjectionIds)
        : delegation.text,
    }));
    const completionMode = shorthand ? body.completionMode ?? "join" : undefined;
    if (shorthand && completionMode !== "join" && body.wakePolicy !== undefined) {
      return reply.code(400).send({ error: "wakePolicy is only valid when completionMode is join" });
    }
    const commonLifetime = body.lifetime?.kind === "deadline"
      ? { kind: "deadline" as const, at: body.lifetime.at.trim() }
      : body.lifetime ?? { kind: "indefinite" as const };
    const requests: Array<{ requestId?: string; recoveryOfRequestId?: string; recipientAgentId?: string; text?: string; lifetime?: RequestLifetime }> = shorthand ? commonDelegations.map((delegation) => ({
      recipientAgentId: delegation.recipientAgentId,
      text: delegation.text,
      lifetime: commonLifetime,
    })) : body.requests ?? [];
    const join = shorthand
      ? (completionMode === "join" ? { mode: "all" as const, wakePolicy: body.wakePolicy ?? "each_result" as const } : undefined)
      : body.join;
    const existingJoinRequestIds = join?.requestIds ?? [];
    const idempotencyKey = body.idempotencyKey?.trim() || (shorthand
      ? derivedRunActionKey(capability.runId, "delegate", {
          delegations: commonDelegations.map((delegation) => ({
            recipientAgentId: delegation.recipientAgentId?.trim(),
            text: delegation.text?.trim(),
          })),
          completionMode,
          wakePolicy: join?.wakePolicy ?? null,
          lifetime: commonLifetime,
        })
      : undefined);
    if (!idempotencyKey || idempotencyKey.length > 200 || requests.length > 100 ||
        (requests.length === 0 && existingJoinRequestIds.length === 0)) {
      return reply.code(400).send({ error: "idempotencyKey and at least one new request or existing join request ID are required" });
    }
    const normalized: Array<{ requestId: string; recoveryOfRequestId?: string; recipientAgentId: string; text: string; lifetime: RequestLifetime }> = [];
    for (let requestIndex = 0; requestIndex < requests.length; requestIndex += 1) {
      const candidate = requests[requestIndex]!;
      const recipientAgentId = candidate.recipientAgentId?.trim();
      const text = candidate.text === undefined
        ? undefined
        : canonicalizeProviderText(candidate.text, steeringInjectionIds).trim();
      if (!recipientAgentId || recipientAgentId === author.id || !text || !candidate.lifetime) {
        return reply.code(400).send({ error: "each request needs another recipient, text, and explicit lifetime" });
      }
      normalized.push({
        requestId: candidate.requestId?.trim() || `v3-request-${createHash("sha256")
          .update(`${author.projectId}\0${capability.runId}\0${idempotencyKey}\0${requestIndex}`)
          .digest("hex")}`,
        recipientAgentId,
        text,
        lifetime: candidate.lifetime,
        ...(candidate.recoveryOfRequestId?.trim()
          ? { recoveryOfRequestId: candidate.recoveryOfRequestId.trim() }
          : {}),
      });
    }
    if (join && !(join.mode === "all" || join.mode === "any" || join.mode === "quorum")) {
      return reply.code(400).send({ error: "join mode must be all, any, or quorum" });
    }
    if (existingJoinRequestIds.length > 100 || new Set(existingJoinRequestIds).size !== existingJoinRequestIds.length ||
        existingJoinRequestIds.some((requestId) => typeof requestId !== "string" || !requestId.trim())) {
      return reply.code(400).send({ error: "join requestIds must contain 1 to 100 unique request IDs" });
    }
    const coordinateInput = (continuationRequestIds: string[] = []) => ({
      projectId: author.projectId,
      ...(capability.conversationId ? { conversationId: capability.conversationId } : {}),
      requesterAgentId: author.id,
      actorScope: `agent:${author.id}:run:${capability.runId}`,
      idempotencyKey,
      runAuthorization: runAuthorization(capability),
      requests: normalized.map((candidate) => ({
        requestId: candidate.requestId,
        recipientAgentId: candidate.recipientAgentId,
        lifetime: candidate.lifetime,
        communicationEventId: `v3-request-${createHash("sha256")
          .update(`${author.projectId}\0${candidate.requestId}`)
          .digest("hex")}`,
        payload: { text: candidate.text, requesterRunId: capability.runId, ...(completionMode ? { completionMode } : {}) },
        ...(candidate.recoveryOfRequestId
          ? { recoveryOfRequestId: candidate.recoveryOfRequestId }
          : {}),
        ...(capability.defaultReply ? { replyAuthority: capability.defaultReply } : {}),
      })),
      ...(join ? { join: {
        ...(join.id?.trim() ? { id: join.id.trim() } : {}),
        mode: join.mode!,
        ...(join.wakePolicy ? { wakePolicy: join.wakePolicy } : {}),
        ...(join.quorum !== undefined ? { quorum: join.quorum } : {}),
        ...(join.deadlineAt?.trim() ? { deadlineAt: join.deadlineAt.trim() } : {}),
        ...(join.satisfyingOutcomes ? { satisfyingOutcomes: join.satisfyingOutcomes } : {}),
        ...(existingJoinRequestIds.length ? { requestIds: existingJoinRequestIds.map((requestId) => requestId.trim()) } : {}),
        ...(continuationRequestIds.length ? { continuationRequestIds } : {}),
      } } : {}),
    });
    let result;
    try {
      result = coordinationV3.replayCoordinate(coordinateInput());
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "coordination replay failed" });
    }
    if (!result) {
      if (!capability.conversationId || author.conversationId !== capability.conversationId) {
        return reply.code(409).send({ error: "coordination requires an active Team Chat scope" });
      }
      if (deletingProjectIds.has(author.projectId) || deletingConversationIds.has(capability.conversationId) ||
          deletingAgentIds.has(author.id)) {
        return reply.code(409).send({ error: "coordination participants are being deleted" });
      }
      const recipients = normalized.map((item) => store.getAgent(item.recipientAgentId));
      if (recipients.some((recipient) => !recipient || recipient.archived || recipient.projectId !== author.projectId ||
          recipient.conversationId !== capability.conversationId)) {
        return reply.code(400).send({ error: "every recipient must be a different active agent in this Team Chat" });
      }
      const leasedAgentIds = [...new Set([author.id, ...normalized.map((item) => item.recipientAgentId)])];
      const releaseDeliveryLease = leaseConversationDelivery(
        conversationDeliveryLeases,
        agentDeliveryLeases,
        capability.conversationId,
        leasedAgentIds,
      );
      try {
        const currentConversation = store.getConversation(capability.conversationId);
        const currentParticipants = leasedAgentIds.map((agentId) => store.getAgent(agentId));
        if (deletingProjectIds.has(author.projectId) || deletingConversationIds.has(capability.conversationId) ||
            leasedAgentIds.some((agentId) => deletingAgentIds.has(agentId)) ||
            !currentConversation || currentConversation.archived || currentConversation.projectId !== author.projectId ||
            currentParticipants.some((agent) => !agent || agent.archived || agent.projectId !== author.projectId ||
              agent.conversationId !== capability.conversationId)) {
          return reply.code(409).send({ error: "coordination participants are no longer available" });
        }
        const continuationRequestIds = join
          ? coordinationV3.requestIdsAttachedToRun(capability.runId, author.id).filter((requestId) => {
              const attached = coordinationV3.getRequest(requestId);
              return (
                attached?.recipientAgentId === author.id
                && !TERMINAL_REQUEST_STATES.has(attached.state)
              ) || (
                attached?.requesterAgentId === author.id
                && attached.state === "awaiting_answer"
              );
            })
          : [];
        result = coordinationV3.coordinate(coordinateInput(continuationRequestIds));
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : "coordination failed" });
      } finally {
        releaseDeliveryLease();
      }
    }

    try {
    if (capability.conversationId) {
      for (let index = 0; index < normalized.length; index += 1) {
        const item = normalized[index]!;
        const requestId = result.requestIds[index]!;
        const eventId = `v3-request-${createHash("sha256").update(`${author.projectId}\0${requestId}`).digest("hex")}`;
        try {
          const routing = resolveExplicitCollaborationIntents(
            capability.conversationId, author.id, [item.recipientAgentId], item.text,
            capability.mentionDepth, capability.mentionTrail,
          );
          if (routing.error) throw new Error(routing.error);
          const communication = recordCommunication({
            eventId, schemaVersion: 2, projectId: author.projectId,
            conversationId: capability.conversationId,
            sender: { kind: "agent", agentId: author.id, executionId: capability.runId },
            intent: "collaboration", audience: { kind: "agents", agentIds: [item.recipientAgentId] },
            text: item.text, createdAt: new Date().toISOString(),
            idempotencyKey: `v3-request:${requestId}`,
          });
          const existing = store.getConversationMessages(capability.conversationId, "collaboration")
            .find((message) => message.communicationEventId === communication.eventId);
          if (!existing) store.appendConversationMessage(
            capability.conversationId, { role: "assistant", text: routing.text }, author.id,
            "collaboration", undefined, undefined, communication.eventId,
          );
          projectCommunicationToAgentAudit(author.id, communication, routing.text);
          projectCommunicationToAgentAudit(item.recipientAgentId, communication, routing.text);
        } catch (error) {
          logWarn({ err: error, requestId }, "V3 request audit projection will be repaired on idempotent retry");
        }
      }
    }
    const conversationIds = [...new Set(result.requestIds.flatMap((requestId) => {
      const changedRequest = coordinationV3.getRequest(requestId);
      return changedRequest?.conversationId ? [changedRequest.conversationId] : [];
    }))];
    try {
      publishCoordinationV3Changed(author.id, { conversationIds });
      for (const item of normalized) {
        publishCoordinationV3Changed(item.recipientAgentId, { conversationIds });
      }
      notifyScheduler();
    } catch { /* durable Requests and Join remain authoritative */ }
    const requestDeliveries = result.requestIds.flatMap((requestId) => {
      const delivery = coordinationV3.requestDelivery(requestId);
      return delivery ? [delivery] : [];
    });
    const queueDirective = normalized.length === 0
      ? "No new Requests were created; this operation only grouped existing Requests."
      : "See requestDeliveries for each new Request's current delivery state. Ordinary Requests never interrupt active work; queued_behind_active_run means the recipient has not received that Request yet.";
    return {
      ...result,
      requestDeliveries,
      ...(result.joinId ? {
        executionDirective: join?.wakePolicy === "each_result"
          ? `${queueDirective} Durable wake source created. End this turn unless independent work remains. Ponderosa will reactivate you as new results arrive and keep the aggregate Join open until its final condition is satisfied. You may truthfully tell the user that you will resume when those tracked results arrive.`
          : `${queueDirective} Durable wake source created. End this turn unless independent work remains. Ponderosa will reactivate you when the aggregate Join reaches its final condition. You may truthfully tell the user that you will resume when that tracked result is ready.`,
      } : completionMode === "record" ? {
        executionDirective: `${queueDirective} No durable wake source was created. The Request is tracked and its result will remain visible, but it will not wake you into another provider Run. Do not promise the user that you will follow up later based on this Request.`,
      } : completionMode === "callback" ? {
        executionDirective: `${queueDirective} Durable wake source created. The Request is tracked without a Join; its terminal result will wake you as an individual callback. You may truthfully tell the user that you will resume when that tracked result is ready.`,
      } : {}),
    };
    } catch {
      try { notifyScheduler(); } catch { /* the durable coordination remains recoverable */ }
      return reply.code(202).send({
        ...result,
        committed: true,
        recovering: true,
      });
    }
  });
}
