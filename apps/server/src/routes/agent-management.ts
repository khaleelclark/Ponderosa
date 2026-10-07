import { createHash, randomUUID } from "node:crypto";
import { canonicalizeProviderText, type CommitAgentDeletionResponse, type ModelOption } from "@ponderosa/core";
import { stableJson, type AgentManagementAuthorization, type AgentStore, type CoordinationV3Store, type WorkspaceStore } from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import type { ActiveRun, AgentMessageCapability, EngineRegistration, ManagementOperation, ManagementPlan } from "../app-contracts.js";
import { runtimeSelectionError } from "../runtime-selection.js";

interface AgentManagementRoutesContext {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  workspace: WorkspaceStore;
  engines: ReadonlyMap<string, EngineRegistration>;
  managementPlans: Map<string, ManagementPlan>;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  agentMessageCapabilities: ReadonlyMap<string, AgentMessageCapability>;
  deletingAgentIds: Set<string>;
  cachedModelOptions(adapter: EngineRegistration["adapter"], projectId?: string): ModelOption[];
  capabilityOwnsAuthoritativeRun(capability: AgentMessageCapability, run: ActiveRun | undefined): boolean;
  managedAgentCreationRestricted?(agentId: string, runId: string): boolean;
  publicManagementOperations(operations: ManagementOperation[]): ManagementOperation[];
  commitAgentDeletion(rootAgentIds: string[], previewHash: string, authorization?: AgentManagementAuthorization): Promise<CommitAgentDeletionResponse>;
  appendWorkspace(event: Parameters<WorkspaceStore["append"]>[0]): unknown;
  publishWorkspaceSince(cursor: number): void;
  notifyScheduler(): void;
  authToken?: string;
}

const ACTION_FIELDS = {
  describe: new Set(["action"]),
  plan: new Set(["action", "idempotencyKey", "operations"]),
  apply: new Set(["action", "planId"]),
} as const;
const OPERATION_FIELDS: Record<ManagementOperation["kind"], ReadonlySet<string>> = {
  create_agent: new Set(["kind", "ref", "title", "parentRef", "engine", "model", "effort", "instructions"]),
  rename_agent: new Set(["kind", "targetAgentId", "title"]),
  stop_agent: new Set(["kind", "targetAgentId"]),
  delete_agent: new Set(["kind", "targetAgentId"]),
  set_manager: new Set(["kind", "targetAgentId", "managerAgentId"]),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function hasOnlyFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}
function requiredText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}
function optionalText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function parseOperations(value: unknown, injectionIds: readonly string[]): { operations?: ManagementOperation[]; error?: string } {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) return { error: "plan requires 1 to 100 operations" };
  const operations: ManagementOperation[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.kind !== "string" || !(raw.kind in OPERATION_FIELDS)) return { error: "unknown management operation" };
    const kind = raw.kind as ManagementOperation["kind"];
    if (!hasOnlyFields(raw, OPERATION_FIELDS[kind])) return { error: "management operation contains an unknown field" };
    if (kind === "create_agent") {
      const ref = requiredText(raw.ref);
      const title = requiredText(raw.title);
      if (!ref || !title) return { error: "create_agent requires string ref and title" };
      const optional: Record<string, string> = {};
      for (const field of ["parentRef", "engine", "model", "effort", "instructions"] as const) {
        const text = optionalText(raw[field]);
        if (text === null) return { error: `create_agent ${field} must be a non-empty string` };
        if (text !== undefined) optional[field] = text;
      }
      operations.push({
        kind, ref,
        title: canonicalizeProviderText(title, injectionIds),
        ...optional,
        ...(optional.instructions ? { instructions: canonicalizeProviderText(optional.instructions, injectionIds) } : {}),
      });
      continue;
    }
    const targetAgentId = requiredText(raw.targetAgentId);
    if (!targetAgentId) return { error: `${kind} requires string targetAgentId` };
    if (kind === "rename_agent") {
      const title = requiredText(raw.title);
      if (!title) return { error: "rename_agent requires string title" };
      operations.push({ kind, targetAgentId, title: canonicalizeProviderText(title, injectionIds) });
    } else if (kind === "set_manager") {
      const managerAgentId = requiredText(raw.managerAgentId);
      if (!managerAgentId) return { error: "set_manager requires string managerAgentId" };
      operations.push({ kind, targetAgentId, managerAgentId });
    } else operations.push({ kind, targetAgentId });
  }
  return { operations };
}

export function registerAgentManagementRoutes(app: FastifyInstance, context: AgentManagementRoutesContext): void {
  const { store, coordinationV3, workspace, engines, managementPlans, activeRuns,
    agentMessageCapabilities, deletingAgentIds, cachedModelOptions,
    capabilityOwnsAuthoritativeRun, managedAgentCreationRestricted = () => false,
    publicManagementOperations, commitAgentDeletion,
    appendWorkspace, publishWorkspaceSince, notifyScheduler, authToken } = context;
  const durableStore = store as AgentStore & Partial<Pick<AgentStore,
    "getAgentManagementPlan" | "findAgentManagementPlan" | "createAgentManagementPlan" | "updateAgentManagementPlan">>;
  const loadPlan = (id: string) => durableStore.getAgentManagementPlan?.(id) ?? managementPlans.get(id);
  const findPlan = (agentId: string, runId: string, key: string) =>
    durableStore.findAgentManagementPlan?.(agentId, runId, key) ??
    [...managementPlans.values()].find((plan) => plan.agentId === agentId && plan.runId === runId && plan.idempotencyKey === key);
  const savePlan = (plan: ManagementPlan) => {
    const saved = durableStore.createAgentManagementPlan?.(plan) ?? { plan, replayed: false };
    managementPlans.set(saved.plan.id, saved.plan);
    return saved;
  };
  const updatePlan = (id: string, patch: Parameters<AgentStore["updateAgentManagementPlan"]>[1]): ManagementPlan => {
    const current = loadPlan(id);
    if (!current) throw new Error("management plan not found");
    const updated = durableStore.updateAgentManagementPlan?.(id, patch) ?? Object.assign(current, patch);
    managementPlans.set(id, updated);
    return updated;
  };
  const publishChange = (projectId: string): void => {
    try { notifyScheduler(); } catch { /* committed state stays authoritative */ }
    try { appendWorkspace({ type: "project_changed", projectId, action: "updated" }); } catch { /* refresh reconciles */ }
  };

  app.post<{ Body: unknown }>("/api/agent-management", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    const owner = capability ? store.getAgent(capability.agentId) : undefined;
    if (!capability || !active || !owner || !capabilityOwnsAuthoritativeRun(capability, active) || active.messageCapability !== token) {
      return reply.code(401).send({ error: "management capability is not authorized for an active Run" });
    }
    if (deletingAgentIds.has(owner.id)) return reply.code(409).send({ error: "Agent deletion is already in progress" });
    if (!capability.conversationId || owner.conversationId !== capability.conversationId) {
      return reply.code(409).send({ error: "organization management requires an active Team Chat scope" });
    }
    if (!isRecord(request.body)) return reply.code(400).send({ error: "management request must be an object" });
    const body = request.body;
    if (typeof body.action !== "string" || !(body.action in ACTION_FIELDS)) {
      return reply.code(400).send({ error: "action must be describe, plan, or apply" });
    }
    const action = body.action as keyof typeof ACTION_FIELDS;
    if (!hasOnlyFields(body, ACTION_FIELDS[action])) return reply.code(400).send({ error: `${action} request contains an unknown field` });
    const creationRestricted = managedAgentCreationRestricted(owner.id, active.runId);

    if (action === "describe") {
      const descendants = store.listAgentSubtree(owner.id).slice(1);
      return {
        owner: { agentId: owner.id, title: owner.title }, conversationId: capability.conversationId,
        descendants: descendants.map((agent) => ({ agentId: agent.id, title: agent.title,
          managerAgentId: agent.managerAgentId, engine: agent.activeEngine, state: agent.state })),
        permissions: {
          autonomous: [...(!creationRestricted ? ["create_agent"] : []), "rename_agent", "stop_agent",
            ...(owner.managementPermissions.allowAutomaticDescendantDeletion ? ["delete_agent"] : []),
            ...(owner.managementPermissions.allowAutomaticDescendantReorganization ? ["set_manager"] : [])],
          requiresApprovalDecision: [
            ...(!owner.managementPermissions.allowAutomaticDescendantDeletion ? ["delete_agent"] : []),
            ...(!owner.managementPermissions.allowAutomaticDescendantReorganization ? ["set_manager"] : [])],
          bounds: { deleteAgent: "descendant roots and their full subtrees; active work is cancelled",
            setManager: "rearrange descendants within this subtree only; detaching and promotion are unavailable" },
        },
      };
    }

    if (action === "apply") {
      const planId = requiredText(body.planId);
      if (!planId || planId.length > 200) return reply.code(400).send({ error: "apply requires string planId" });
      const loadedPlan = loadPlan(planId);
      if (!loadedPlan || loadedPlan.agentId !== owner.id || loadedPlan.conversationId !== capability.conversationId) {
        return reply.code(404).send({ error: "management plan is absent or does not belong to this Agent" });
      }
      let plan: ManagementPlan = loadedPlan;
      if (plan.status === "completed" || plan.appliedAt) return { planId: plan.id, replayed: true, result: plan.result };
      if (creationRestricted && plan.operations.some((operation) => operation.kind === "create_agent")) {
        return reply.code(403).send({ error: "managed Agent creation is restricted for this Run" });
      }
      if (plan.approvalRequired && !plan.approvalDecisionId) {
        return reply.code(409).send({ error: "this exact management plan still requires the user's approval" });
      }
      if (plan.approvalDecisionId) {
        const decision = workspace.getDecision(plan.approvalDecisionId);
        const kinds = [...new Set(plan.operations.flatMap((op) => op.kind === "delete_agent" || op.kind === "set_manager" ? [op.kind] : []))];
        const targets = [...new Set(plan.operations.flatMap((op) => op.kind === "delete_agent" || op.kind === "set_manager" ? [op.targetAgentId!] : []))].sort();
        if (!decision || decision.agentId !== owner.id || decision.runId !== plan.runId ||
          decision.projectId !== plan.projectId || decision.conversationId !== plan.conversationId ||
          decision.mode !== "approval" || decision.status !== "resolved" || decision.response?.optionId !== "approve" ||
          decision.approvalScope?.kind !== "agent_management" || decision.approvalScope.planId !== plan.id ||
          decision.approvalScope.scopeHash !== plan.scopeHash || stableJson(decision.approvalScope.operationKinds) !== stableJson(kinds) ||
          stableJson(decision.approvalScope.targetAgentIds) !== stableJson(targets) ||
          decision.approvalScope.previewHash !== plan.deletionPreview?.previewHash) {
          return reply.code(409).send({ error: "this exact management plan still requires the user's approval" });
        }
      }
      if (plan.status === "planned") plan = updatePlan(plan.id, { status: "applying" });
      const descendantIds = new Set(store.listAgentSubtree(owner.id).slice(1).map((agent) => agent.id));
      const refs = new Map(Object.entries(plan.refs));
      const changed = new Set(plan.changedAgentIds);
      const progress = new Map(plan.operationProgress.map((item) => [item.index, item]));
      const resolveRef = (value?: string | null) => value === null ? null : value ? refs.get(value) ?? value : undefined;
      const record = (index: number, operation: ManagementOperation, receipt: Record<string, unknown>) => {
        const prior = progress.get(index);
        if (prior && (prior.kind !== operation.kind || stableJson(prior.receipt) !== stableJson(receipt))) {
          throw new Error("management operation progress conflicts with its frozen plan");
        }
        if (prior) return;
        const operationProgress = [...plan.operationProgress, { index, kind: operation.kind, receipt }];
        plan = updatePlan(plan.id, { operationProgress, refs: Object.fromEntries(refs), changedAgentIds: [...changed] });
        progress.set(index, operationProgress.at(-1)!);
      };
      try {
        if (plan.deletionPreview) {
          const deletion = await commitAgentDeletion(plan.deletionPreview.rootAgentIds, plan.deletionPreview.previewHash, {
            planId: plan.id, projectId: plan.projectId, conversationId: plan.conversationId,
            ownerAgentId: owner.id, runId: plan.runId, scopeHash: plan.scopeHash, permission: "deletion",
            ...(plan.approvalDecisionId ? { approvalDecisionId: plan.approvalDecisionId } : {}),
          });
          deletion.deletedAgentIds.forEach((id) => changed.add(id));
          const result = { changedAgentIds: [...changed], deletedAgentIds: deletion.deletedAgentIds, refs: {} };
          plan = updatePlan(plan.id, { status: "completed", appliedAt: new Date().toISOString(), result, changedAgentIds: [...changed] });
          return { planId: plan.id, replayed: false, result: plan.result };
        }
        const reorg = plan.operations.filter((op) => op.kind === "set_manager");
        if (reorg.length) {
          const authorization: AgentManagementAuthorization = {
            planId: plan.id, projectId: plan.projectId, conversationId: plan.conversationId,
            ownerAgentId: owner.id, runId: plan.runId, scopeHash: plan.scopeHash, permission: "reorganization",
            ...(plan.approvalDecisionId ? { approvalDecisionId: plan.approvalDecisionId } : {}),
          };
          const operations = reorg.map((op) => ({ targetAgentId: op.targetAgentId!, managerAgentId: op.managerAgentId! }));
          const atomic = (store as AgentStore & Partial<Pick<AgentStore, "applyAuthorizedAgentReorganizationAndCompletePlan">>)
            .applyAuthorizedAgentReorganizationAndCompletePlan?.(authorization, operations, new Date().toISOString());
          if (atomic) {
            plan = atomic.plan;
            managementPlans.set(plan.id, plan);
          } else {
            const ids = store.applyAuthorizedAgentReorganization(authorization, operations);
            ids.forEach((id) => changed.add(id));
            const result = { changedAgentIds: [...changed], refs: {} };
            plan = updatePlan(plan.id, { status: "completed", appliedAt: new Date().toISOString(), result, changedAgentIds: [...changed] });
          }
          publishChange(owner.projectId);
          return { planId: plan.id, replayed: false, result: plan.result };
        }
        for (const [index, operation] of plan.operations.entries()) {
          const done = progress.get(index);
          if (done) {
            if (done.kind !== operation.kind) throw new Error("management progress no longer matches its frozen plan");
            const agentId = requiredText(done.receipt.agentId);
            if (operation.kind === "create_agent") {
              if (!agentId || !store.getAgent(agentId)) throw new Error("managed Agent creation receipt is not recoverable");
              if (operation.ref) refs.set(operation.ref, agentId);
            }
            if (agentId) changed.add(agentId);
            continue;
          }
          if (operation.kind === "create_agent") {
            const operationKey = `${plan.id}:${index}`;
            const actorScope = `agent:${owner.id}:run:${plan.runId}`;
            const prior = store.findAgentCreationOperation({ projectId: plan.projectId, actorScope, kind: "managed", idempotencyKey: operationKey });
            if (prior?.status === "completed") {
              const agentId = isRecord(prior.result) ? requiredText(prior.result.agentId) : undefined;
              if (!agentId || !store.getAgent(agentId)) throw new Error("managed Agent creation committed without a recoverable Agent");
              if (operation.ref) refs.set(operation.ref, agentId);
              changed.add(agentId); record(index, operation, { agentId }); continue;
            }
            const parentId = resolveRef(operation.parentRef) ?? owner.id;
            if (parentId !== owner.id && !descendantIds.has(parentId) && ![...refs.values()].includes(parentId)) throw new Error("create parent escaped the managed subtree");
            if (deletingAgentIds.has(parentId)) throw new Error("create parent is being deleted");
            const engineId = operation.engine ?? owner.activeEngine;
            const engine = engines.get(engineId);
            if (!engine) throw new Error(`unknown engine: ${engineId}`);
            const selectionError = runtimeSelectionError(engine.adapter, operation.model, operation.effort, cachedModelOptions(engine.adapter, owner.projectId));
            if (selectionError) throw new Error(selectionError);
            const createInput = { title: operation.title!.slice(0, 80), engine: engineId,
              conversationId: plan.conversationId, managerAgentId: parentId,
              ...(operation.model ? { model: operation.model } : {}), ...(operation.effort ? { effort: operation.effort } : {}) };
            const creation = store.beginAgentCreationOperation({ projectId: plan.projectId, actorScope, kind: "managed",
              idempotencyKey: operationKey, payloadHash: createHash("sha256").update(stableJson({ createInput, instructions: operation.instructions ?? null })).digest("hex") }).operation;
            const replayedId = creation.status === "completed" && isRecord(creation.result) ? requiredText(creation.result.agentId) : undefined;
            let created = replayedId ? store.getAgent(replayedId) : undefined;
            if (creation.status === "completed" && !created) throw new Error("managed Agent creation committed without a recoverable Agent");
            if (!created) {
              if (creation.agentIds.length) throw new Error("managed Agent creation is still being recovered");
              const createdId = randomUUID(); store.addAgentCreationOperationMember(creation.id, createdId, 0); deletingAgentIds.add(createdId);
              try {
                created = store.createAgent(plan.projectId, createInput, { agentId: owner.id, executionId: plan.runId,
                  idempotencyKey: operationKey, prompt: operation.instructions }, createdId);
                if (operation.instructions) store.setImportedHistory(created.id, `${owner.title} management plan`, [{ role: "system", text: operation.instructions, createdAt: plan.createdAt }]);
                store.updateAgentCreationOperation(creation.id, { status: "completed", result: { agentId: created.id }, lastError: null });
                deletingAgentIds.delete(created.id);
              } catch (error) {
                let absent = !store.getAgent(createdId);
                if (!absent) { try { store.deleteAgent(createdId, (id) => coordinationV3.handleAgentDeletion(id)); } catch {} absent = !store.getAgent(createdId); }
                store.updateAgentCreationOperation(creation.id, { status: absent ? "rolled_back" : "rolling_back", lastError: error instanceof Error ? error.message : "managed Agent creation failed" });
                if (absent) deletingAgentIds.delete(createdId); throw error;
              }
            }
            if (operation.ref) refs.set(operation.ref, created.id); changed.add(created.id); record(index, operation, { agentId: created.id }); continue;
          }
          const targetId = resolveRef(operation.targetAgentId);
          if (!targetId || (!descendantIds.has(targetId) && ![...refs.values()].includes(targetId))) throw new Error("operation target escaped the managed subtree");
          if (deletingAgentIds.has(targetId)) throw new Error("operation target is being deleted");
          if (operation.kind === "rename_agent") {
            const title = operation.title!.slice(0, 80); store.updateAgent(targetId, { title }); changed.add(targetId); record(index, operation, { agentId: targetId, title });
          } else if (operation.kind === "stop_agent") {
            const targetRunId = operation.targetRunId; const cancellationKey = `${plan.id}:${index}`;
            const prior = coordinationV3.cancellationReceipt(targetId, cancellationKey);
            if (prior) {
              if (!targetRunId || !prior.cancelled || prior.runId !== targetRunId) throw new Error("the prior stop_agent receipt does not match this plan");
              changed.add(targetId); record(index, operation, { agentId: targetId, targetRunId, cancellationKey }); continue;
            }
            if (!targetRunId || coordinationV3.agentSnapshot(targetId).activeRun?.id !== targetRunId) throw new Error("the exact Run bound to this stop_agent plan is no longer active");
            const response = await app.inject({ method: "POST", url: `/api/agents/${encodeURIComponent(targetId)}/cancel`,
              headers: authToken ? { authorization: `Bearer ${authToken}` } : undefined,
              payload: { targetRunId, idempotencyKey: cancellationKey } });
            if (response.statusCode >= 400) throw new Error(response.json().error ?? "Agent stop failed");
            const receipt = coordinationV3.cancellationReceipt(targetId, cancellationKey);
            if (!receipt?.cancelled || receipt.runId !== targetRunId) throw new Error("Agent stop did not produce its exact durable receipt");
            changed.add(targetId); record(index, operation, { agentId: targetId, targetRunId, cancellationKey });
          }
        }
        const result = { changedAgentIds: [...changed], refs: Object.fromEntries(refs) };
        plan = updatePlan(plan.id, { status: "completed", appliedAt: new Date().toISOString(), result,
          refs: Object.fromEntries(refs), changedAgentIds: [...changed] });
        publishChange(owner.projectId);
        return { planId: plan.id, replayed: false, result: plan.result };
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : "management plan failed", partialChangesPossible: !plan.deletionPreview });
      }
    }

    const idempotencyKey = requiredText(body.idempotencyKey);
    if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "plan requires string idempotencyKey" });
    const validated = parseOperations(body.operations, []);
    if (!validated.operations) return reply.code(400).send({ error: validated.error });
    const parsed = parseOperations(body.operations, coordinationV3.steeringInjectionIds(capability.runId));
    if (!parsed.operations) return reply.code(400).send({ error: parsed.error });
    const operations = parsed.operations;
    if (creationRestricted && operations.some((operation) => operation.kind === "create_agent")) {
      return reply.code(403).send({ error: "managed Agent creation is restricted for this Run" });
    }
    const requestHash = createHash("sha256").update(stableJson({ operations })).digest("hex");
    const ensureApproval = (candidate: ManagementPlan): ManagementPlan => {
      if (!candidate.approvalRequired || candidate.approvalDecisionId) return candidate;
      const operationKinds = [...new Set(candidate.operations.flatMap((op) =>
        op.kind === "delete_agent" || op.kind === "set_manager" ? [op.kind] : [],
      ))] as Array<"delete_agent" | "set_manager">;
      const targetAgentIds = [...new Set(candidate.operations.flatMap((op) =>
        op.kind === "delete_agent" || op.kind === "set_manager" ? [op.targetAgentId!] : [],
      ))].sort();
      const affected = candidate.deletionPreview?.affectedAgents ?? targetAgentIds.map((id) => {
        const target = store.getAgent(id);
        return { id, title: target?.title ?? id };
      });
      const cursor = workspace.cursor();
      const decision = workspace.createDecision({
        idempotencyKey: `management-approval:${candidate.id}`,
        projectId: candidate.projectId, conversationId: candidate.conversationId,
        agentId: owner.id, runId: candidate.runId, mode: "approval",
        question: `Allow ${owner.title} to ${candidate.deletionPreview ? "permanently delete" : "reorganize"} this exact Agent plan?`,
        context: `${affected.length} affected Agent${affected.length === 1 ? "" : "s"}: ${affected.slice(0, 20).map((agent) => agent.title).join(", ")}${affected.length > 20 ? `, and ${affected.length - 20} more` : ""}. This approval can be used once and only for this plan.`,
        options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }],
        allowOther: true, blocking: true,
        approvalScope: { kind: "agent_management", planId: candidate.id, operationKinds, targetAgentIds,
          ...(candidate.deletionPreview ? { previewHash: candidate.deletionPreview.previewHash } : {}),
          scopeHash: candidate.scopeHash },
      });
      store.createAgentManagementApproval({ decisionId: decision.id, planId: candidate.id,
        projectId: candidate.projectId, conversationId: candidate.conversationId,
        ownerAgentId: owner.id, runId: candidate.runId, scopeHash: candidate.scopeHash });
      const updated = updatePlan(candidate.id, { approvalDecisionId: decision.id });
      try {
        workspace.createNotification({ projectId: decision.projectId, conversationId: decision.conversationId,
          conversationIds: [owner.conversationId], agentId: decision.agentId, agentIds: [decision.agentId], kind: "decision",
          category: "decision", severity: "urgent", status: "open", dedupeKey: `decision:${decision.id}`,
          action: { kind: "open_decision", targetId: decision.id }, title: `${owner.title} needs a destructive-operation decision`,
          body: decision.question, decision: { id: decision.id, mode: decision.mode, options: decision.options,
            allowOther: decision.allowOther, status: decision.status } }, true);
        publishWorkspaceSince(cursor);
      } catch { /* durable plan and decision replay */ }
      return updated;
    };
    const replay = findPlan(owner.id, active.runId, idempotencyKey);
    if (replay) {
      if (replay.requestHash !== requestHash) return reply.code(409).send({ error: "management plan idempotency key was reused with different input" });
      let recovered = replay;
      try { recovered = ensureApproval(replay); } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : "could not recover scoped management approval" });
      }
      return { planId: recovered.id, replayed: true, operations: publicManagementOperations(recovered.operations),
        ...(recovered.approvalDecisionId ? { approvalDecisionId: recovered.approvalDecisionId,
          approvalStatus: workspace.getDecision(recovered.approvalDecisionId)?.status ?? "pending" } : {}) };
    }
    const descendantIds = new Set(store.listAgentSubtree(owner.id).slice(1).map((agent) => agent.id));
    const refs = new Set<string>(); let reachedDelete = false;
    for (const operation of operations) {
      if (operation.kind === "delete_agent") reachedDelete = true;
      else if (reachedDelete) return reply.code(400).send({ error: "delete_agent operations must be last" });
      if (operation.kind === "create_agent") {
        if (refs.has(operation.ref!)) return reply.code(400).send({ error: "create_agent requires a unique ref" });
        if (operation.parentRef && operation.parentRef !== owner.id && !descendantIds.has(operation.parentRef) && !refs.has(operation.parentRef)) return reply.code(403).send({ error: "create parent is outside the managed subtree" });
        refs.add(operation.ref!); continue;
      }
      if (!descendantIds.has(operation.targetAgentId!) && !refs.has(operation.targetAgentId!)) return reply.code(403).send({ error: "management target is outside the descendant subtree" });
      if (operation.kind === "stop_agent" && !coordinationV3.agentSnapshot(operation.targetAgentId!).activeRun?.id) return reply.code(409).send({ error: "stop_agent target does not have an active Run to bind" });
      if (operation.kind === "set_manager" && operation.managerAgentId !== owner.id && !descendantIds.has(operation.managerAgentId!) && !refs.has(operation.managerAgentId!)) return reply.code(403).send({ error: "new manager is outside the managed subtree" });
    }
    const deletions = operations.filter((op) => op.kind === "delete_agent");
    if (deletions.length && deletions.length !== operations.length) return reply.code(400).send({ error: "delete_agent plans may contain only delete_agent operations" });
    const reorg = operations.filter((op) => op.kind === "set_manager");
    if (reorg.length && reorg.length !== operations.length) return reply.code(400).send({ error: "set_manager plans may contain only set_manager operations" });
    const deletionPreview = deletions.length ? store.previewAgentDeletion(deletions.map((op) => op.targetAgentId!)) : undefined;
    if (deletionPreview?.affectedAgents.some((agent) => !descendantIds.has(agent.id))) return reply.code(403).send({ error: "deletion cascade escaped the descendant subtree" });
    const planId = `management-${createHash("sha256").update(`${owner.id}\0${active.runId}\0${idempotencyKey}`).digest("hex")}`;
    const planned = operations.map((op) => op.kind === "stop_agent" ? { ...op, targetRunId: coordinationV3.agentSnapshot(op.targetAgentId!).activeRun!.id } : op);
    const scopeHash = createHash("sha256").update(stableJson({ planId, projectId: owner.projectId,
      conversationId: capability.conversationId, ownerAgentId: owner.id, runId: active.runId,
      operations: planned.map((op) => ({ kind: op.kind, targetAgentId: op.targetAgentId ?? null,
        targetRunId: op.targetRunId ?? null, managerAgentId: op.managerAgentId ?? null })),
      previewHash: deletionPreview?.previewHash ?? null })).digest("hex");
    const requiresApproval = deletions.length ? !owner.managementPermissions.allowAutomaticDescendantDeletion
      : reorg.length ? !owner.managementPermissions.allowAutomaticDescendantReorganization : false;
    let plan: ManagementPlan = { id: planId, agentId: owner.id, runId: active.runId,
      conversationId: capability.conversationId, projectId: owner.projectId, idempotencyKey, requestHash,
      operations: structuredClone(planned), ...(deletionPreview ? { deletionPreview } : {}), scopeHash,
      approvalRequired: requiresApproval, status: "planned", operationProgress: [], refs: {}, changedAgentIds: [],
      createdAt: new Date().toISOString() };
    try { plan = savePlan(plan).plan; } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "could not persist management plan" });
    }
    if (requiresApproval && !plan.approvalDecisionId) {
      try { plan = ensureApproval(plan); } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : "could not create scoped management approval" });
      }
    }
    return { planId: plan.id, replayed: false, operations: publicManagementOperations(plan.operations),
      ...(plan.approvalDecisionId ? { approvalDecisionId: plan.approvalDecisionId, approvalStatus: "pending" } : {}),
      instruction: plan.approvalDecisionId ? "Ponderosa asked the user to approve this exact plan. Do not call apply until the Decision response resumes this Run." : "Review the exact plan, then call apply with planId." };
  });
}
