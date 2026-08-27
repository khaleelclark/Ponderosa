import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import type {
  AgentDto,
  AgentOrganizationEvent,
  ConversationDto,
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
import type { AgentJson, AgentManagementAuthorization } from "./store-types.js";
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
    private readonly getConversation: (conversationId: string) => ConversationDto | undefined,
    private readonly rowToAgentDto: (agentId: string) => AgentDto | undefined,
    private readonly refreshAllChatFeedProject: (projectId: string) => void,
  ) {}

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
    this.client.prepare(`
      INSERT INTO agent_management_approvals (
        decision_id, plan_id, project_id, conversation_id, owner_agent_id,
        run_id, scope_hash, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      input.decisionId, input.planId, input.projectId, input.conversationId,
      input.ownerAgentId, input.runId, input.scopeHash, now,
    );
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
    const descendants = new Set(this.listAgentSubtree(owner.id).slice(1).map((agent) => agent.id));
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
        if (cursor.projectId !== agent.projectId || cursor.archived) throw new Error("organizational ancestry must contain active agents from the same project");
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
      const currentDescendants = new Set(this.listAgentSubtree(authorization.ownerAgentId).slice(1).map((agent) => agent.id));
      for (const operation of operations) {
        const target = byId.get(operation.targetAgentId);
        const manager = byId.get(operation.managerAgentId);
        if (!target || !manager || target.archived || manager.archived) throw new Error("reorganization Agents must remain active");
        if (manager.id !== authorization.ownerAgentId && !currentDescendants.has(manager.id)) {
          throw new Error("management authority changed; a new manager is no longer inside the owner's subtree");
        }
        if (target.id === authorization.ownerAgentId || target.id === manager.id) throw new Error("reorganization cannot move the owner or create a self-cycle");
        managerById.set(target.id, manager.id);
        const visited = new Set<string>([target.id]);
        let cursor: string | undefined = manager.id;
        while (cursor) {
          if (visited.has(cursor)) throw new Error("organizational parent would create a cycle");
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
        if (!parent || parent.archived || seen.has(parentId)) {
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
