import { createHash } from "node:crypto";
import {
  canonicalizeProviderText,
  type CommitAgentDeletionResponse,
  type ModelOption,
} from "@ponderosa/core";
import type {
  AgentManagementAuthorization,
  AgentStore,
  CoordinationV3Store,
  WorkspaceStore,
} from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import type {
  ActiveRun,
  AgentMessageCapability,
  EngineRegistration,
  ManagementOperation,
  ManagementPlan,
} from "../app-contracts.js";
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
  capabilityOwnsAuthoritativeRun(
    capability: AgentMessageCapability,
    run: ActiveRun | undefined,
  ): boolean;
  publicManagementOperations(operations: ManagementOperation[]): ManagementOperation[];
  commitAgentDeletion(
    rootAgentIds: string[],
    previewHash: string,
    authorization?: AgentManagementAuthorization,
  ): Promise<CommitAgentDeletionResponse>;
  appendWorkspace(event: Parameters<WorkspaceStore["append"]>[0]): unknown;
  publishWorkspaceSince(cursor: number): void;
  notifyScheduler(): void;
  authToken?: string;
}

export function registerAgentManagementRoutes(
  app: FastifyInstance,
  context: AgentManagementRoutesContext,
): void {
  const {
    store,
    coordinationV3,
    workspace,
    engines,
    managementPlans,
    activeRuns,
    agentMessageCapabilities,
    deletingAgentIds,
    cachedModelOptions,
    capabilityOwnsAuthoritativeRun,
    publicManagementOperations,
    commitAgentDeletion,
    appendWorkspace,
    publishWorkspaceSince,
    notifyScheduler,
    authToken,
  } = context;

  app.post<{ Body: unknown }>("/api/agent-management", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    const owner = capability ? store.getAgent(capability.agentId) : undefined;
    if (!capability || !active || !owner || !capabilityOwnsAuthoritativeRun(capability, active) || active.messageCapability !== token) {
      return reply.code(401).send({ error: "management capability is not authorized for an active Run" });
    }
    if (deletingAgentIds.has(owner.id)) {
      return reply.code(409).send({ error: "Agent deletion is already in progress" });
    }
    if (!capability.conversationId || !owner.conversationIds.includes(capability.conversationId)) {
      return reply.code(409).send({ error: "organization management requires an active Team Chat scope" });
    }
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
    const action = body.action;
    const subtree = store.listAgentSubtree(owner.id);
    const descendants = subtree.slice(1);
    const descendantIds = new Set(descendants.map((agent) => agent.id));
    if (action === "describe") {
      return {
        owner: { agentId: owner.id, title: owner.title },
        conversationId: capability.conversationId,
        descendants: descendants.map((agent) => ({
          agentId: agent.id,
          title: agent.title,
          managerAgentId: agent.managerAgentId,
          engine: agent.activeEngine,
          state: agent.state,
        })),
        permissions: {
          autonomous: [
            "create_agent", "rename_agent", "stop_agent",
            ...(owner.managementPermissions.allowAutomaticDescendantDeletion ? ["delete_agent"] : []),
            ...(owner.managementPermissions.allowAutomaticDescendantReorganization ? ["set_manager"] : []),
          ],
          requiresApprovalDecision: [
            ...(!owner.managementPermissions.allowAutomaticDescendantDeletion ? ["delete_agent"] : []),
            ...(!owner.managementPermissions.allowAutomaticDescendantReorganization ? ["set_manager"] : []),
          ],
          bounds: {
            deleteAgent: "descendant roots and their full subtrees; active work is cancelled",
            setManager: "rearrange descendants within this subtree only; detaching and promotion are unavailable",
          },
        },
      };
    }
    if (action !== "plan" && action !== "apply") return reply.code(400).send({ error: "action must be describe, plan, or apply" });
    if (action === "apply") {
      const planId = typeof body.planId === "string" ? body.planId.trim() : "";
      const plan = managementPlans.get(planId);
      if (!plan || plan.agentId !== owner.id || plan.runId !== active.runId || plan.conversationId !== capability.conversationId) {
        return reply.code(404).send({ error: "management plan is absent or does not belong to this Run" });
      }
      if (plan.appliedAt) return { planId: plan.id, replayed: true, result: plan.result };
      if (plan.approvalDecisionId) {
        const decision = workspace.getDecision(plan.approvalDecisionId);
        const expectedOperationKinds = [...new Set(plan.operations.flatMap((operation) =>
          operation.kind === "delete_agent" || operation.kind === "set_manager" ? [operation.kind] : [],
        ))];
        const expectedTargetAgentIds = [...new Set(plan.operations.flatMap((operation) =>
          operation.kind === "delete_agent" || operation.kind === "set_manager" ? [operation.targetAgentId!] : [],
        ))].sort();
        if (!decision || decision.agentId !== owner.id || decision.runId !== active.runId ||
            decision.projectId !== owner.projectId || decision.conversationId !== capability.conversationId ||
            decision.mode !== "approval" || decision.status !== "resolved" ||
            decision.response?.optionId !== "approve" || decision.approvalScope?.kind !== "agent_management" ||
            decision.approvalScope.planId !== plan.id || decision.approvalScope.scopeHash !== plan.scopeHash ||
            JSON.stringify(decision.approvalScope.operationKinds) !== JSON.stringify(expectedOperationKinds) ||
            JSON.stringify(decision.approvalScope.targetAgentIds) !== JSON.stringify(expectedTargetAgentIds) ||
            decision.approvalScope.previewHash !== plan.deletionPreview?.previewHash) {
          return reply.code(409).send({ error: "this exact management plan still requires the user's approval" });
        }
      }
      const refs = new Map<string, string>();
      const changedAgentIds = new Set<string>();
      const internalHeaders = authToken ? { authorization: `Bearer ${authToken}` } : undefined;
      const resolveRef = (value: string | null | undefined): string | null | undefined => {
        if (value === null) return null;
        if (!value) return undefined;
        return refs.get(value) ?? value;
      };
      try {
        if (plan.deletionPreview) {
          const deletion = await commitAgentDeletion(
            plan.deletionPreview.rootAgentIds,
            plan.deletionPreview.previewHash,
            {
              planId: plan.id,
              projectId: owner.projectId,
              conversationId: capability.conversationId,
              ownerAgentId: owner.id,
              runId: active.runId,
              scopeHash: plan.scopeHash!,
              permission: "deletion",
              ...(plan.approvalDecisionId ? { approvalDecisionId: plan.approvalDecisionId } : {}),
            },
          );
          deletion.deletedAgentIds.forEach((agentId) => changedAgentIds.add(agentId));
          plan.appliedAt = new Date().toISOString();
          plan.result = { changedAgentIds: [...changedAgentIds], deletedAgentIds: deletion.deletedAgentIds, refs: {} };
          managementPlans.set(plan.id, plan);
          return { planId: plan.id, replayed: false, result: plan.result };
        }
        const reorganizationOperations = plan.operations.filter((operation) => operation.kind === "set_manager");
        if (reorganizationOperations.length > 0) {
          const reorganized = store.applyAuthorizedAgentReorganization({
            planId: plan.id,
            projectId: owner.projectId,
            conversationId: capability.conversationId!,
            ownerAgentId: owner.id,
            runId: active.runId,
            scopeHash: plan.scopeHash!,
            permission: "reorganization",
            ...(plan.approvalDecisionId ? { approvalDecisionId: plan.approvalDecisionId } : {}),
          }, reorganizationOperations.map((operation) => ({
            targetAgentId: operation.targetAgentId!,
            managerAgentId: operation.managerAgentId!,
          })));
          reorganized.forEach((agentId) => changedAgentIds.add(agentId));
          plan.appliedAt = new Date().toISOString();
          plan.result = { changedAgentIds: [...changedAgentIds], refs: {} };
          managementPlans.set(plan.id, plan);
          notifyScheduler();
          appendWorkspace({ type: "project_changed", projectId: owner.projectId, action: "updated" });
          return { planId: plan.id, replayed: false, result: plan.result };
        }
        for (const [index, operation] of plan.operations.entries()) {
          if (operation.kind === "create_agent") {
            const parentId = resolveRef(operation.parentRef) ?? owner.id;
            if (parentId !== owner.id && !descendantIds.has(parentId) && ![...refs.values()].includes(parentId)) throw new Error("create parent escaped the managed subtree");
            if (deletingAgentIds.has(parentId)) throw new Error("create parent is being deleted");
            const engineId = operation.engine?.trim() || owner.activeEngine;
            const engine = engines.get(engineId);
            if (!engine) throw new Error(`unknown engine: ${engineId}`);
            const selectionError = runtimeSelectionError(
              engine.adapter,
              operation.model,
              operation.effort,
              cachedModelOptions(engine.adapter, owner.projectId),
            );
            if (selectionError) throw new Error(selectionError);
            const created = store.createAgent(owner.projectId, {
              title: operation.title?.trim().slice(0, 80) || "Managed Agent",
              engine: engineId,
              conversationId: capability.conversationId,
              managerAgentId: parentId,
              ...(operation.model?.trim() ? { model: operation.model.trim() } : {}),
              ...(operation.effort?.trim() ? { effort: operation.effort.trim() } : {}),
            }, { agentId: owner.id, executionId: active.runId, idempotencyKey: `${plan.id}:${index}`, prompt: operation.instructions?.trim() });
            if (operation.instructions?.trim()) store.setImportedHistory(created.id, `${owner.title} management plan`, [{ role: "system", text: operation.instructions.trim(), createdAt: plan.createdAt }]);
            if (operation.ref) refs.set(operation.ref, created.id);
            changedAgentIds.add(created.id);
            continue;
          }
          const targetId = resolveRef(operation.targetAgentId);
          if (!targetId || (!descendantIds.has(targetId) && ![...refs.values()].includes(targetId))) throw new Error("operation target escaped the managed subtree");
          if (deletingAgentIds.has(targetId)) throw new Error("operation target is being deleted");
          if (operation.kind === "rename_agent") {
            const title = operation.title?.trim();
            if (!title) throw new Error("rename_agent requires title");
            store.updateAgent(targetId, { title: title.slice(0, 80) });
            changedAgentIds.add(targetId);
          } else if (operation.kind === "stop_agent") {
            const targetRunId = operation.targetRunId;
            const currentRunId = coordinationV3.agentSnapshot(targetId).activeRun?.id;
            if (!targetRunId || currentRunId !== targetRunId) {
              throw new Error("the exact Run bound to this stop_agent plan is no longer active");
            }
            const response = await app.inject({
              method: "POST", url: `/api/agents/${encodeURIComponent(targetId)}/cancel`, headers: internalHeaders,
              payload: { targetRunId, idempotencyKey: `${plan.id}:${index}` },
            });
            if (response.statusCode >= 400) throw new Error(response.json().error ?? "Agent stop failed");
            changedAgentIds.add(targetId);
          } else if (operation.kind === "set_manager") {
            const managerId = resolveRef(operation.managerAgentId);
            if (!managerId) throw new Error("Agents cannot detach or promote descendants");
            if (managerId !== owner.id && (!descendantIds.has(managerId) && ![...refs.values()].includes(managerId))) throw new Error("new manager escaped the managed subtree");
            if (deletingAgentIds.has(managerId)) throw new Error("new manager is being deleted");
            store.updateAgentOrganization(targetId, { managerAgentId: managerId });
            changedAgentIds.add(targetId);
          }
        }
        plan.appliedAt = new Date().toISOString();
        plan.result = { changedAgentIds: [...changedAgentIds], refs: Object.fromEntries(refs) };
        managementPlans.set(plan.id, plan);
        notifyScheduler();
        appendWorkspace({ type: "project_changed", projectId: owner.projectId, action: "updated" });
        return { planId: plan.id, replayed: false, result: plan.result };
      } catch (error) {
        return reply.code(409).send({
          error: error instanceof Error ? error.message : "management plan failed",
          partialChangesPossible: !plan.deletionPreview,
        });
      }
    }

    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
    const steeringInjectionIds = coordinationV3.steeringInjectionIds(capability.runId);
    const operations = Array.isArray(body.operations) ? (body.operations as ManagementOperation[]).map((operation) => ({
      ...operation,
      ...(typeof operation.title === "string"
        ? { title: canonicalizeProviderText(operation.title, steeringInjectionIds) }
        : {}),
      ...(typeof operation.instructions === "string"
        ? { instructions: canonicalizeProviderText(operation.instructions, steeringInjectionIds) }
        : {}),
    })) : [];
    if (!idempotencyKey || idempotencyKey.length > 200 || operations.length < 1 || operations.length > 100) {
      return reply.code(400).send({ error: "plan requires idempotencyKey and 1 to 100 operations" });
    }
    const replay = [...managementPlans.values()].find((plan) => plan.agentId === owner.id && plan.runId === active.runId && plan.idempotencyKey === idempotencyKey);
    if (replay) return {
      planId: replay.id,
      replayed: true,
      operations: publicManagementOperations(replay.operations),
      ...(replay.approvalDecisionId ? {
        approvalDecisionId: replay.approvalDecisionId,
        approvalStatus: workspace.getDecision(replay.approvalDecisionId)?.status ?? "pending",
      } : {}),
    };
    const refs = new Set<string>();
    let reachedDelete = false;
    for (const operation of operations) {
      if (!operation || !["create_agent", "rename_agent", "stop_agent", "delete_agent", "set_manager"].includes(operation.kind)) return reply.code(400).send({ error: "unknown management operation" });
      const allowedFields = new Set(["kind", "ref", "targetAgentId", "parentRef", "managerAgentId", "title", "engine", "model", "effort", "instructions"]);
      if (Object.keys(operation).some((key) => !allowedFields.has(key))) {
        return reply.code(400).send({ error: "management operation contains an unknown field" });
      }
      if (operation.kind === "delete_agent") reachedDelete = true;
      else if (reachedDelete) return reply.code(400).send({ error: "delete_agent operations must be last" });
      if (operation.kind === "create_agent") {
        if (!operation.ref?.trim() || refs.has(operation.ref) || !operation.title?.trim()) return reply.code(400).send({ error: "create_agent requires a unique ref and title" });
        if (operation.parentRef && operation.parentRef !== owner.id && !descendantIds.has(operation.parentRef) && !refs.has(operation.parentRef)) return reply.code(403).send({ error: "create parent is outside the managed subtree" });
        refs.add(operation.ref);
        continue;
      }
      if (!operation.targetAgentId || (!descendantIds.has(operation.targetAgentId) && !refs.has(operation.targetAgentId))) return reply.code(403).send({ error: "management target is outside the descendant subtree" });
      if (operation.kind === "rename_agent" && !operation.title?.trim()) return reply.code(400).send({ error: "rename_agent requires title" });
      if (operation.kind === "stop_agent" && !coordinationV3.agentSnapshot(operation.targetAgentId).activeRun?.id) {
        return reply.code(409).send({ error: "stop_agent target does not have an active Run to bind" });
      }
      if (operation.kind === "set_manager") {
        const managerId = operation.managerAgentId;
        if (!managerId) return reply.code(403).send({ error: "Agents cannot detach or promote descendants" });
        if (managerId !== owner.id && !descendantIds.has(managerId) && !refs.has(managerId)) return reply.code(403).send({ error: "new manager is outside the managed subtree" });
      }
    }
    const deleteOperations = operations.filter((operation) => operation.kind === "delete_agent");
    if (deleteOperations.length > 0 && deleteOperations.length !== operations.length) {
      return reply.code(400).send({ error: "delete_agent plans may contain only delete_agent operations" });
    }
    const reorganizationOperations = operations.filter((operation) => operation.kind === "set_manager");
    if (reorganizationOperations.length > 0 && reorganizationOperations.length !== operations.length) {
      return reply.code(400).send({ error: "set_manager plans may contain only set_manager operations" });
    }
    const deletionPreview = deleteOperations.length > 0
      ? store.previewAgentDeletion(deleteOperations.map((operation) => operation.targetAgentId!))
      : undefined;
    if (deletionPreview?.affectedAgents.some((agent) => !descendantIds.has(agent.id))) {
      return reply.code(403).send({ error: "deletion cascade escaped the descendant subtree" });
    }
    const createdAt = new Date().toISOString();
    const planId = `management-${createHash("sha256").update(`${owner.id}\0${active.runId}\0${idempotencyKey}`).digest("hex")}`;
    const plannedOperations = operations.map((operation) => operation.kind === "stop_agent"
      ? { ...operation, targetRunId: coordinationV3.agentSnapshot(operation.targetAgentId!).activeRun!.id }
      : operation);
    const operationKinds = [...new Set(plannedOperations.flatMap((operation) =>
      operation.kind === "delete_agent" || operation.kind === "set_manager" ? [operation.kind] : [],
    ))] as Array<"delete_agent" | "set_manager">;
    const targetAgentIds = [...new Set(plannedOperations.flatMap((operation) =>
      operation.kind === "delete_agent" || operation.kind === "set_manager" ? [operation.targetAgentId!] : [],
    ))].sort();
    const scopeHash = createHash("sha256").update(JSON.stringify({
      planId,
      projectId: owner.projectId,
      conversationId: capability.conversationId,
      ownerAgentId: owner.id,
      runId: active.runId,
      operations: plannedOperations.map((operation) => ({
        kind: operation.kind,
        targetAgentId: operation.targetAgentId ?? null,
        targetRunId: operation.targetRunId ?? null,
        managerAgentId: operation.managerAgentId ?? null,
      })),
      previewHash: deletionPreview?.previewHash ?? null,
    })).digest("hex");
    const requiresApproval = deleteOperations.length > 0
      ? !owner.managementPermissions.allowAutomaticDescendantDeletion
      : reorganizationOperations.length > 0
        ? !owner.managementPermissions.allowAutomaticDescendantReorganization
        : false;
    const plan: ManagementPlan = {
      id: planId,
      agentId: owner.id,
      runId: active.runId,
      conversationId: capability.conversationId,
      idempotencyKey,
      operations: structuredClone(plannedOperations),
      ...(deletionPreview ? { deletionPreview } : {}),
      scopeHash,
      createdAt,
    };
    if (requiresApproval) {
      const affected = deletionPreview?.affectedAgents ?? targetAgentIds.map((id) => {
        const target = store.getAgent(id)!;
        return { id, title: target.title, ...(target.managerAgentId ? { managerAgentId: target.managerAgentId } : {}) };
      });
      const actionLabel = deleteOperations.length > 0 ? "permanently delete" : "reorganize";
      const cursor = workspace.cursor();
      const decision = workspace.createDecision({
        idempotencyKey: `management-approval:${plan.id}`,
        projectId: owner.projectId,
        conversationId: capability.conversationId,
        agentId: owner.id,
        runId: active.runId,
        mode: "approval",
        question: `Allow ${owner.title} to ${actionLabel} this exact Agent plan?`,
        context: `${affected.length} affected Agent${affected.length === 1 ? "" : "s"}: ${affected.slice(0, 20).map((agent) => agent.title).join(", ")}${affected.length > 20 ? `, and ${affected.length - 20} more` : ""}. This approval can be used once and only for this plan.`,
        options: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
        allowOther: true,
        blocking: true,
        approvalScope: {
          kind: "agent_management",
          planId: plan.id,
          operationKinds,
          targetAgentIds,
          ...(deletionPreview ? { previewHash: deletionPreview.previewHash } : {}),
          scopeHash: scopeHash!,
        },
      });
      try {
        store.createAgentManagementApproval({
          decisionId: decision.id,
          planId: plan.id,
          projectId: owner.projectId,
          conversationId: capability.conversationId,
          ownerAgentId: owner.id,
          runId: active.runId,
          scopeHash: scopeHash!,
        });
      } catch (error) {
        workspace.cancelDecision(decision.id);
        coordinationV3.releaseDecisionQuestionSuspensions(decision.id);
        return reply.code(409).send({ error: error instanceof Error ? error.message : "could not create scoped management approval" });
      }
      workspace.createNotification({
        projectId: decision.projectId,
        conversationId: decision.conversationId,
        conversationIds: owner.conversationIds,
        agentId: decision.agentId,
        agentIds: [decision.agentId],
        kind: "decision",
        category: "decision",
        severity: "urgent",
        status: "open",
        dedupeKey: `decision:${decision.id}`,
        action: { kind: "open_decision", targetId: decision.id },
        title: `${owner.title} needs a destructive-operation decision`,
        body: decision.question,
        decision: { id: decision.id, mode: decision.mode, options: decision.options, allowOther: decision.allowOther, status: decision.status },
      }, true);
      publishWorkspaceSince(cursor);
      plan.approvalDecisionId = decision.id;
    }
    managementPlans.set(plan.id, plan);
    return {
      planId: plan.id,
      replayed: false,
      operations: publicManagementOperations(plan.operations),
      ...(plan.approvalDecisionId ? { approvalDecisionId: plan.approvalDecisionId, approvalStatus: "pending" } : {}),
      instruction: plan.approvalDecisionId
        ? "Ponderosa asked the user to approve this exact plan. Do not call apply until the Decision response resumes this Run."
        : "Review the exact plan, then call apply with planId.",
    };
  });
}
