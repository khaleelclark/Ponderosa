import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import type {
  AgentDto,
  AgentOrganizationEvent,
  ProjectDto,
  UpdateAgentOrganizationRequest,
  UpdateAgentRequest,
} from "@ponderosa/core";
import {
  agentMentionHandleBase,
  allocateAgentMentionHandle,
} from "@ponderosa/core";
import type { Db } from "./db.js";
import { normalizeAgentTitle } from "./agent-identity.js";
import { appendFsyncedJsonl, readRepairableJsonl } from "./append-jsonl.js";
import { requireManagementPermissions } from "./store-agent-management.js";
import { readJson, writeJson } from "./store-filesystem.js";
import type {
  AgentJson,
  AgentManagementAuthorization,
  ManagementOperationProgress,
  ManagementPlan,
} from "./store-types.js";
import { agentHandleReservations, agents } from "./schema.js";
import { agentJsonPath, agentOrganizationEventsPath } from "./paths.js";

export class AgentManagementAuthority {
  constructor(
    private readonly dataDir: string,
    private readonly db: Db,
    private readonly client: Database.Database,
    private readonly getAgent: (agentId: string) => AgentDto | undefined,
    private readonly listAgents: (projectId: string) => AgentDto[],
    private readonly getProject: (projectId: string) => ProjectDto | undefined,
    private readonly rowToAgentDto: (agentId: string) => AgentDto | undefined,
    private readonly refreshAllChatFeedProject: (projectId: string) => void,
  ) {}

  private managementPlanRow(id: string): ManagementPlan | undefined {
    const row = this.client.prepare(`
      SELECT plan_json, status, operation_progress_json, refs_json,
        changed_agent_ids_json, approval_required, approval_decision_id,
        result_json, applied_at
      FROM agent_management_plans WHERE id = ?
    `).get(id) as {
      plan_json: string;
      status: ManagementPlan["status"];
      operation_progress_json: string;
      refs_json: string;
      changed_agent_ids_json: string;
      approval_required: number;
      approval_decision_id: string | null;
      result_json: string | null;
      applied_at: string | null;
    } | undefined;
    if (!row) return undefined;
    const frozen = JSON.parse(row.plan_json) as ManagementPlan;
    return {
      ...frozen,
      status: row.status,
      operationProgress: JSON.parse(row.operation_progress_json) as ManagementOperationProgress[],
      refs: JSON.parse(row.refs_json) as Record<string, string>,
      changedAgentIds: JSON.parse(row.changed_agent_ids_json) as string[],
      approvalRequired: row.approval_required === 1,
      ...(row.approval_decision_id ? { approvalDecisionId: row.approval_decision_id } : {}),
      ...(row.result_json ? { result: JSON.parse(row.result_json) as unknown } : {}),
      ...(row.applied_at ? { appliedAt: row.applied_at } : {}),
    };
  }

  createAgentManagementPlan(plan: ManagementPlan): { plan: ManagementPlan; replayed: boolean } {
    return this.client.transaction(() => {
      const existing = this.findAgentManagementPlan(plan.agentId, plan.runId, plan.idempotencyKey);
      if (existing) {
        if (existing.id !== plan.id || existing.requestHash !== plan.requestHash) {
          throw new Error("management plan idempotency key was reused with different input");
        }
        return { plan: existing, replayed: true };
      }
      const now = new Date().toISOString();
      this.client.prepare(`
        INSERT INTO agent_management_plans (
          id, project_id, conversation_id, owner_agent_id, run_id,
          idempotency_key, request_hash, scope_hash, plan_json, status,
          operation_progress_json, refs_json, changed_agent_ids_json,
          approval_required, approval_decision_id, result_json,
          created_at, updated_at, applied_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        plan.id, plan.projectId, plan.conversationId, plan.agentId, plan.runId,
        plan.idempotencyKey, plan.requestHash, plan.scopeHash, JSON.stringify(plan),
        plan.status, JSON.stringify(plan.operationProgress), JSON.stringify(plan.refs),
        JSON.stringify(plan.changedAgentIds), plan.approvalRequired ? 1 : 0,
        plan.approvalDecisionId ?? null,
        plan.result === undefined ? null : JSON.stringify(plan.result),
        plan.createdAt, now, plan.appliedAt ?? null,
      );
      return { plan: this.managementPlanRow(plan.id)!, replayed: false };
    })();
  }

  getAgentManagementPlan(id: string): ManagementPlan | undefined {
    return this.managementPlanRow(id);
  }

  findAgentManagementPlan(
    ownerAgentId: string,
    runId: string,
    idempotencyKey: string,
  ): ManagementPlan | undefined {
    const row = this.client.prepare(`
      SELECT id FROM agent_management_plans
      WHERE owner_agent_id = ? AND run_id = ? AND idempotency_key = ?
    `).get(ownerAgentId, runId, idempotencyKey) as { id: string } | undefined;
    return row ? this.managementPlanRow(row.id) : undefined;
  }

  listAgentManagementPlans(): ManagementPlan[] {
    return (this.client.prepare(`
      SELECT id FROM agent_management_plans ORDER BY created_at, id
    `).all() as Array<{ id: string }>).flatMap(({ id }) => {
      const plan = this.managementPlanRow(id);
      return plan ? [plan] : [];
    });
  }

  updateAgentManagementPlan(
    id: string,
    patch: Partial<Pick<ManagementPlan,
      "status" | "operationProgress" | "refs" | "changedAgentIds" |
      "approvalDecisionId" | "result" | "appliedAt"
    >>,
  ): ManagementPlan {
    const current = this.managementPlanRow(id);
    if (!current) throw new Error("management plan not found");
    const transitions: Record<ManagementPlan["status"], ManagementPlan["status"][]> = {
      planned: ["planned", "applying"],
      applying: ["applying", "completed"],
      completed: ["completed"],
    };
    const status = patch.status ?? current.status;
    if (!transitions[current.status].includes(status)) {
      throw new Error("management plan status cannot move backward");
    }
    if (current.status === "completed") {
      const conflicts =
        (patch.status !== undefined && patch.status !== current.status) ||
        (patch.operationProgress !== undefined && JSON.stringify(patch.operationProgress) !== JSON.stringify(current.operationProgress)) ||
        (patch.refs !== undefined && JSON.stringify(patch.refs) !== JSON.stringify(current.refs)) ||
        (patch.changedAgentIds !== undefined && JSON.stringify(patch.changedAgentIds) !== JSON.stringify(current.changedAgentIds)) ||
        (patch.approvalDecisionId !== undefined && patch.approvalDecisionId !== current.approvalDecisionId) ||
        (patch.result !== undefined && JSON.stringify(patch.result) !== JSON.stringify(current.result)) ||
        (patch.appliedAt !== undefined && patch.appliedAt !== current.appliedAt);
      if (conflicts) throw new Error("completed management plan is immutable");
      return current;
    }
    this.client.prepare(`
      UPDATE agent_management_plans SET
        status = ?, operation_progress_json = ?, refs_json = ?,
        changed_agent_ids_json = ?, approval_decision_id = ?, result_json = ?,
        applied_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      status,
      JSON.stringify(patch.operationProgress ?? current.operationProgress),
      JSON.stringify(patch.refs ?? current.refs),
      JSON.stringify(patch.changedAgentIds ?? current.changedAgentIds),
      patch.approvalDecisionId ?? current.approvalDecisionId ?? null,
      patch.result === undefined
        ? current.result === undefined ? null : JSON.stringify(current.result)
        : JSON.stringify(patch.result),
      patch.appliedAt ?? current.appliedAt ?? null,
      new Date().toISOString(),
      id,
    );
    return this.managementPlanRow(id)!;
  }

  listAgentSubtree(id: string): AgentDto[] {
    const root = this.getAgent(id);
    if (!root) return [];
    const projectAgents = this.listAgents(root.projectId);
    const children = new Map<string, AgentDto[]>();
    for (const agent of projectAgents) {
      if (!agent.managerAgentId) continue;
      children.set(agent.managerAgentId, [...(children.get(agent.managerAgentId) ?? []), agent]);
    }
    const ordered: AgentDto[] = [];
    const visit = (agent: AgentDto) => {
      ordered.push(agent);
      for (const child of children.get(agent.id) ?? []) visit(child);
    };
    visit(root);
    return ordered;
  }

  createAgentManagementApproval(input: {
    decisionId: string;
    planId: string;
    projectId: string;
    conversationId: string;
    ownerAgentId: string;
    runId: string;
    scopeHash: string;
  }): void {
    const now = new Date().toISOString();
    this.client.transaction(() => {
      const existing = this.client.prepare(`
        SELECT plan_id, project_id, conversation_id, owner_agent_id, run_id, scope_hash
        FROM agent_management_approvals WHERE decision_id = ?
      `).get(input.decisionId) as {
        plan_id: string; project_id: string; conversation_id: string;
        owner_agent_id: string; run_id: string; scope_hash: string;
      } | undefined;
      if (existing) {
        if (existing.plan_id !== input.planId || existing.project_id !== input.projectId ||
            existing.conversation_id !== input.conversationId ||
            existing.owner_agent_id !== input.ownerAgentId || existing.run_id !== input.runId ||
            existing.scope_hash !== input.scopeHash) {
          throw new Error("management approval identity conflicts with its exact plan");
        }
        return;
      }
      this.client.prepare(`
        INSERT INTO agent_management_approvals (
          decision_id, plan_id, project_id, conversation_id, owner_agent_id,
          run_id, scope_hash, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        input.decisionId, input.planId, input.projectId, input.conversationId,
        input.ownerAgentId, input.runId, input.scopeHash, now,
      );
    })();
  }

  resolveAgentManagementApproval(decisionId: string, approved: boolean, at = new Date().toISOString()): boolean {
    return this.client.transaction(() => {
      const row = this.client.prepare(`
        SELECT status FROM agent_management_approvals WHERE decision_id = ?
      `).get(decisionId) as { status: string } | undefined;
      if (!row) return false;
      const desired = approved ? "approved" : "denied";
      if (row.status === desired) return true;
      if (row.status !== "pending") throw new Error("management approval is already terminal");
      this.client.prepare(`
        UPDATE agent_management_approvals SET status = ?, resolved_at = ? WHERE decision_id = ?
      `).run(desired, at, decisionId);
      return true;
    })();
  }

  /** Revalidate current owner authority and consume one exact approval in the
   * same SQLite transaction as the caller's destructive projection mutation. */
  authorizeAgentManagementPlan(
    authorization: AgentManagementAuthorization,
    targetAgentIds: readonly string[],
    consumeApproval = true,
  ): void {
    const owner = this.getAgent(authorization.ownerAgentId);
    if (!owner || owner.projectId !== authorization.projectId || owner.archived) {
      throw new Error("management owner is no longer active in this Project");
    }
    if (owner.conversationId !== authorization.conversationId) {
      throw new Error("management owner no longer belongs to the authorized Chat");
    }
    const subtree = this.listAgentSubtree(owner.id);
    if (subtree.some((agent) => agent.conversationId !== authorization.conversationId)) {
      throw new Error("management authority cannot cross Chat ownership boundaries");
    }
    const descendants = new Set(subtree.slice(1).map((agent) => agent.id));
    if (targetAgentIds.some((id) => !descendants.has(id))) {
      throw new Error("management authority changed; a target is no longer inside the owner's subtree");
    }
    const permissionEnabled = authorization.permission === "deletion"
      ? owner.managementPermissions.allowAutomaticDescendantDeletion
      : owner.managementPermissions.allowAutomaticDescendantReorganization;
    if (!authorization.approvalDecisionId) {
      if (!permissionEnabled) throw new Error(`automatic descendant ${authorization.permission} permission was revoked`);
      return;
    }
    const approval = this.client.prepare(`
      SELECT plan_id, project_id, conversation_id, owner_agent_id, run_id,
             scope_hash, status
      FROM agent_management_approvals WHERE decision_id = ?
    `).get(authorization.approvalDecisionId) as {
      plan_id: string; project_id: string; conversation_id: string;
      owner_agent_id: string; run_id: string; scope_hash: string; status: string;
    } | undefined;
    if (!approval || approval.plan_id !== authorization.planId ||
        approval.project_id !== authorization.projectId ||
        approval.conversation_id !== authorization.conversationId ||
        approval.owner_agent_id !== authorization.ownerAgentId ||
        approval.run_id !== authorization.runId ||
        approval.scope_hash !== authorization.scopeHash) {
      throw new Error("management approval does not match this exact plan and Run");
    }
    if (approval.status !== "approved") throw new Error("management approval is not approved or was already consumed");
    if (!consumeApproval) return;
    const consumedAt = new Date().toISOString();
    const consumed = this.client.prepare(`
      UPDATE agent_management_approvals
      SET status = 'consumed', consumed_at = ?
      WHERE decision_id = ? AND status = 'approved'
    `).run(consumedAt, authorization.approvalDecisionId);
    if (consumed.changes !== 1) throw new Error("management approval was already consumed");
  }

  updateAgent(id: string, patch: UpdateAgentRequest): AgentDto | undefined {
    const row = this.db.select().from(agents).where(eq(agents.id, id)).get();
    if (!row || row.deletedAt) return undefined;
    const now = new Date().toISOString();
    const title = patch.title === undefined ? row.title : normalizeAgentTitle(patch.title);
    const handle = patch.title !== undefined &&
        agentMentionHandleBase(title).toLocaleLowerCase() !==
          agentMentionHandleBase(row.title).toLocaleLowerCase()
      ? allocateAgentMentionHandle(
          title,
          this.db.select({ handle: agentHandleReservations.handle })
            .from(agentHandleReservations)
            .where(eq(agentHandleReservations.projectId, row.projectId))
            .all()
            .map(reservation => reservation.handle),
        )
      : row.handle;
    const archived = patch.archived ?? row.archived === 1;
    const activeEngine = patch.activeEngine?.trim() || row.activeEngine;
    const model = patch.model === undefined ? row.model ?? undefined : patch.model?.trim() || undefined;
    const effort = patch.effort === undefined ? row.effort ?? undefined : patch.effort?.trim() || undefined;
    const managementPermissions = patch.managementPermissions
      ? requireManagementPermissions(patch.managementPermissions)
      : {
          allowAutomaticDescendantDeletion: row.allowAutomaticDescendantDeletion === 1,
          allowAutomaticDescendantReorganization: row.allowAutomaticDescendantReorganization === 1,
        };
    if (archived && row.archived !== 1) {
      for (const child of this.listAgents(row.projectId).filter((agent) => agent.managerAgentId === id)) {
        this.updateAgentOrganization(child.id, { managerAgentId: null });
      }
      if (this.getAgent(id)?.managerAgentId) this.updateAgentOrganization(id, { managerAgentId: null });
    }
    // Canonical metadata is crash-safe and durable before its rebuildable
    // SQLite projection changes. A crash can therefore never resurrect a
    // permission that the operator just revoked.
    const json = readJson<AgentJson>(agentJsonPath(this.dataDir, row.projectId, id));
    writeJson(agentJsonPath(this.dataDir, row.projectId, id), {
      ...json,
      title,
      handle,
      archived,
      activeEngine,
      model,
      effort,
      managementPermissions,
      updatedAt: now,
    });
    this.client.transaction(() => {
      if (handle.toLocaleLowerCase() !== row.handle.toLocaleLowerCase()) {
        this.db.insert(agentHandleReservations).values({
          projectId: row.projectId,
          normalizedHandle: handle.toLocaleLowerCase(),
          handle,
          agentId: id,
          reservedAt: now,
        }).run();
      }
      this.db.update(agents).set({
        title,
        handle,
        archived: archived ? 1 : 0,
        activeEngine,
        model: model ?? null,
        effort: effort ?? null,
        allowAutomaticDescendantDeletion: managementPermissions.allowAutomaticDescendantDeletion ? 1 : 0,
        allowAutomaticDescendantReorganization: managementPermissions.allowAutomaticDescendantReorganization ? 1 : 0,
        updatedAt: now,
      })
      .where(eq(agents.id, id))
      .run();
    })();
    if (archived !== (row.archived === 1)) this.refreshAllChatFeedProject(row.projectId);
    return this.rowToAgentDto(id);
  }

  /** Change only the mutable organizational reporting line. */
  updateAgentOrganization(id: string, input: UpdateAgentOrganizationRequest): AgentDto | undefined {
    const agent = this.getAgent(id);
    if (!agent) return undefined;
    if (agent.archived) throw new Error("archived agents cannot be reorganized");
    const parentId = input.managerAgentId ?? undefined;
    if (parentId === id) throw new Error("an agent cannot report to itself");
    if (parentId) {
      const parent = this.getAgent(parentId);
      if (!parent || parent.projectId !== agent.projectId) throw new Error("organizational parent must belong to the same project");
      if (parent.archived) throw new Error("organizational parent must be active");
      if (parent.conversationId !== agent.conversationId) {
        throw new Error("organizational parent must belong to the same Chat");
      }
      const visited = new Set<string>([id]);
      let cursor: AgentDto | undefined = parent;
      while (cursor) {
        if (visited.has(cursor.id)) throw new Error("organizational parent would create a cycle");
        if (cursor.projectId !== agent.projectId || cursor.archived ||
            cursor.conversationId !== agent.conversationId) {
          throw new Error("organizational ancestry must contain active Agents from the same Chat");
        }
        visited.add(cursor.id);
        cursor = cursor.managerAgentId ? this.getAgent(cursor.managerAgentId) : undefined;
      }
    }
    if (agent.managerAgentId === parentId) return agent;
    const event: AgentOrganizationEvent = {
      eventId: randomUUID(), type: "manager_changed", projectId: agent.projectId,
      agentId: id, managerAgentId: parentId ?? null, createdAt: new Date().toISOString(),
    };
    appendFsyncedJsonl(agentOrganizationEventsPath(this.dataDir, agent.projectId), [event]);
    this.db.update(agents).set({
      managerAgentId: parentId ?? null,
      updatedAt: event.createdAt,
    }).where(eq(agents.id, id)).run();
    return this.getAgent(id);
  }

  applyAuthorizedAgentReorganization(
    authorization: AgentManagementAuthorization,
    operations: ReadonlyArray<{ targetAgentId: string; managerAgentId: string }>,
  ): string[] {
    return this.client.transaction(() => {
      this.authorizeAgentManagementPlan(
        authorization,
        [...new Set(operations.map((operation) => operation.targetAgentId))],
      );
      const projectAgents = this.listAgents(authorization.projectId);
      const byId = new Map(projectAgents.map((agent) => [agent.id, agent]));
      const managerById = new Map(projectAgents.map((agent) => [agent.id, agent.managerAgentId]));
      const owner = byId.get(authorization.ownerAgentId);
      if (!owner || owner.conversationId !== authorization.conversationId) {
        throw new Error("management owner no longer belongs to the authorized Chat");
      }
      const currentSubtree = this.listAgentSubtree(authorization.ownerAgentId);
      if (currentSubtree.some((agent) => agent.conversationId !== authorization.conversationId)) {
        throw new Error("management authority cannot cross Chat ownership boundaries");
      }
      const currentDescendants = new Set(currentSubtree.slice(1).map((agent) => agent.id));
      for (const operation of operations) {
        const target = byId.get(operation.targetAgentId);
        const manager = byId.get(operation.managerAgentId);
        if (!target || !manager || target.archived || manager.archived) throw new Error("reorganization Agents must remain active");
        if (target.conversationId !== authorization.conversationId ||
            manager.conversationId !== authorization.conversationId) {
          throw new Error("reorganization Agents must belong to the authorized Chat");
        }
        if (manager.id !== authorization.ownerAgentId && !currentDescendants.has(manager.id)) {
          throw new Error("management authority changed; a new manager is no longer inside the owner's subtree");
        }
        if (target.id === authorization.ownerAgentId || target.id === manager.id) throw new Error("reorganization cannot move the owner or create a self-cycle");
        managerById.set(target.id, manager.id);
        const visited = new Set<string>([target.id]);
        let cursor: string | undefined = manager.id;
        while (cursor) {
          if (visited.has(cursor)) throw new Error("organizational parent would create a cycle");
          const ancestor = byId.get(cursor);
          if (!ancestor || ancestor.archived ||
              ancestor.conversationId !== authorization.conversationId) {
            throw new Error("organizational ancestry must remain inside the authorized Chat");
          }
          visited.add(cursor);
          cursor = managerById.get(cursor);
        }
      }
      const createdAt = new Date().toISOString();
      const eventsToAppend: AgentOrganizationEvent[] = operations
        .filter((operation) => managerById.get(operation.targetAgentId) !== byId.get(operation.targetAgentId)?.managerAgentId)
        .map((operation) => ({
          eventId: randomUUID(),
          type: "manager_changed",
          projectId: authorization.projectId,
          agentId: operation.targetAgentId,
          managerAgentId: operation.managerAgentId,
          createdAt,
        }));
      if (eventsToAppend.length > 0) {
        for (const event of eventsToAppend) this.client.prepare(`
          UPDATE agents SET manager_agent_id = ?, updated_at = ? WHERE id = ?
        `).run(event.managerAgentId, event.createdAt, event.agentId);
        // The canonical log append is the last statement in the transaction. A
        // failing UPDATE now rolls back before anything reaches the log, rather
        // than leaving a durable record of a reorganization SQLite rejected --
        // which a later projection rebuild would have replayed as real. The
        // remaining window, a crash between this append and COMMIT, is the one
        // setAgentManager already has and resolves the same way: the log is
        // canonical and the rebuild reapplies it.
        appendFsyncedJsonl(agentOrganizationEventsPath(this.dataDir, authorization.projectId), eventsToAppend);
      }
      return [...new Set(operations.map((operation) => operation.targetAgentId))];
    })();
  }

  applyAuthorizedAgentReorganizationAndCompletePlan(
    authorization: AgentManagementAuthorization,
    operations: ReadonlyArray<{ targetAgentId: string; managerAgentId: string }>,
    appliedAt: string,
  ): { changedAgentIds: string[]; plan: ManagementPlan } {
    return this.client.transaction(() => {
      const changedAgentIds = this.applyAuthorizedAgentReorganization(authorization, operations);
      const result = { changedAgentIds, refs: {} };
      const plan = this.updateAgentManagementPlan(authorization.planId, {
        status: "completed",
        changedAgentIds,
        appliedAt,
        result,
      });
      return { changedAgentIds, plan };
    })();
  }

  readAgentOrganizationEvents(projectId: string): AgentOrganizationEvent[] {
    if (!this.getProject(projectId)) throw new Error("organization project not found");
    return readRepairableJsonl<AgentOrganizationEvent>(
      agentOrganizationEventsPath(this.dataDir, projectId), "agent organization log", true,
    );
  }

  sanitizeOrganizationProjection(projectId: string): void {
    const projectAgents = this.listAgents(projectId);
    const byId = new Map(projectAgents.map((agent) => [agent.id, agent]));
    for (const agent of projectAgents) {
      if (!agent.managerAgentId) continue;
      const seen = new Set<string>([agent.id]);
      let parentId: string | undefined = agent.managerAgentId;
      let valid = true;
      while (parentId) {
        const parent = byId.get(parentId);
        if (!parent || parent.archived ||
            parent.conversationId !== agent.conversationId || seen.has(parentId)) {
          valid = false;
          break;
        }
        seen.add(parentId);
        parentId = parent.managerAgentId;
      }
      if (!valid) this.db.update(agents).set({ managerAgentId: null }).where(eq(agents.id, agent.id)).run();
    }
  }

}
