import type Database from "better-sqlite3";
import {
  normalizeRestrictedCapabilityIds,
  resolveCapabilityPolicy,
  type CapabilityPolicyLayer,
  type CapabilityPolicyRecord,
  type CapabilityScopeKind,
  type EffectiveCapabilityPolicy,
} from "@ponderosa/core";

interface PolicyRow {
  scope_kind: CapabilityScopeKind;
  scope_id: string;
  revision: number;
  restricted_capability_ids_json: string;
  updated_at: string;
}

interface OwnershipRow {
  agent_id?: string;
  agent_title?: string;
  spawned_by_agent_id?: string | null;
  conversation_id: string;
  conversation_title: string;
  branch_id: string | null;
  branch_name: string | null;
}

export class CapabilityPolicyRevisionConflictError extends Error {
  constructor(readonly current: CapabilityPolicyRecord | undefined) {
    super("Capability policy changed before this update was applied");
  }
}

function parseIds(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(item => typeof item === "string")
      ? normalizeRestrictedCapabilityIds(parsed)
      : [];
  } catch {
    return [];
  }
}

function record(row: PolicyRow): CapabilityPolicyRecord {
  return {
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    revision: row.revision,
    restrictedCapabilityIds: parseIds(row.restricted_capability_ids_json),
    updatedAt: row.updated_at,
  };
}

export class CapabilityPolicyStore {
  constructor(readonly sqlite: Database.Database) {}

  get(scopeKind: CapabilityScopeKind, scopeId: string): CapabilityPolicyRecord | undefined {
    const row = this.sqlite.prepare(`
      SELECT scope_kind, scope_id, revision, restricted_capability_ids_json, updated_at
      FROM capability_policies
      WHERE scope_kind = ? AND scope_id = ?
    `).get(scopeKind, scopeId) as PolicyRow | undefined;
    return row ? record(row) : undefined;
  }

  put(input: {
    scopeKind: CapabilityScopeKind;
    scopeId: string;
    expectedRevision: number;
    restrictedCapabilityIds: readonly string[];
  }): CapabilityPolicyRecord {
    const scopeId = input.scopeId.trim();
    if (!scopeId) throw new Error("Capability policy scope ID is required");
    const ids = normalizeRestrictedCapabilityIds(input.restrictedCapabilityIds);
    const now = new Date().toISOString();
    return this.sqlite.transaction(() => {
      const current = this.get(input.scopeKind, scopeId);
      if ((current?.revision ?? 0) !== input.expectedRevision) {
        throw new CapabilityPolicyRevisionConflictError(current);
      }
      const revision = input.expectedRevision + 1;
      this.sqlite.prepare(`
        INSERT INTO capability_policies (
          scope_kind, scope_id, revision, restricted_capability_ids_json, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
          revision = excluded.revision,
          restricted_capability_ids_json = excluded.restricted_capability_ids_json,
          updated_at = excluded.updated_at
      `).run(input.scopeKind, scopeId, revision, JSON.stringify(ids), now);
      return this.get(input.scopeKind, scopeId)!;
    })();
  }

  resolveForBranch(branchId: string): EffectiveCapabilityPolicy {
    const branch = this.sqlite.prepare("SELECT id, name FROM branches WHERE id = ?").get(branchId) as { id: string; name: string } | undefined;
    if (!branch) throw new Error("Branch not found");
    return this.resolveLayers([
      ["global", "ponderosa", "Ponderosa"],
      ["product", "branches", "Ponderosa Branches"],
      ["branch", branch.id, branch.name],
    ]);
  }

  resolveForChat(chatId: string): EffectiveCapabilityPolicy {
    const owner = this.ownershipForChat(chatId);
    return this.resolveOwnership(owner);
  }

  resolveForAgent(agentId: string, runId?: string): EffectiveCapabilityPolicy {
    const owner = this.sqlite.prepare(`
      SELECT agents.id AS agent_id, agents.title AS agent_title,
             agents.spawned_by_agent_id AS spawned_by_agent_id,
             conversations.id AS conversation_id, conversations.title AS conversation_title,
             conversations.branch_id AS branch_id, branches.name AS branch_name
      FROM agents
      JOIN conversations ON conversations.id = agents.conversation_id
      LEFT JOIN branches ON branches.id = conversations.branch_id
      WHERE agents.id = ? AND agents.deleted_at IS NULL
    `).get(agentId) as OwnershipRow | undefined;
    if (!owner) throw new Error("Agent not found");
    const ancestors: Array<{ id: string; title: string }> = [];
    const seen = new Set([agentId]);
    let parentId = owner.spawned_by_agent_id ?? undefined;
    while (parentId) {
      if (seen.has(parentId)) {
        throw new Error("Agent spawner lineage contains a cycle");
      }
      seen.add(parentId);
      // Spawner lineage is immutable authority, not the mutable reporting tree.
      // Deleted Agents remain as audit rows, so keep walking through them: a
      // surviving child must never regain authority when its spawner is retired.
      const parent = this.sqlite.prepare(
        "SELECT id, title, spawned_by_agent_id FROM agents WHERE id = ?",
      ).get(parentId) as { id: string; title: string; spawned_by_agent_id: string | null } | undefined;
      if (!parent) {
        throw new Error("Agent spawner lineage is incomplete");
      }
      ancestors.push({ id: parent.id, title: parent.title });
      parentId = parent.spawned_by_agent_id ?? undefined;
    }
    return this.resolveOwnership(owner, runId, ancestors.reverse());
  }

  private ownershipForChat(chatId: string): OwnershipRow {
    const owner = this.sqlite.prepare(`
      SELECT conversations.id AS conversation_id, conversations.title AS conversation_title,
             conversations.branch_id AS branch_id, branches.name AS branch_name
      FROM conversations
      LEFT JOIN branches ON branches.id = conversations.branch_id
      WHERE conversations.id = ?
    `).get(chatId) as OwnershipRow | undefined;
    if (!owner) throw new Error("Chat not found");
    return owner;
  }

  private resolveOwnership(owner: OwnershipRow, runId?: string, agentAncestors:Array<{id:string;title:string}>=[]): EffectiveCapabilityPolicy {
    const layers: Array<[CapabilityScopeKind, string, string]> = [
      ["global", "ponderosa", "Ponderosa"],
      ["product", owner.branch_id ? "branches" : "interactive", owner.branch_id ? "Ponderosa Branches" : "Ponderosa"],
    ];
    if (owner.branch_id) layers.push(["branch", owner.branch_id, owner.branch_name ?? "Branch"]);
    layers.push(["chat", owner.conversation_id, owner.conversation_title]);
    for(const ancestor of agentAncestors)layers.push(["agent",ancestor.id,`${ancestor.title} (spawner)`]);
    if (owner.agent_id) layers.push(["agent", owner.agent_id, owner.agent_title ?? "Agent"]);
    if (runId) layers.push(["run", runId, "Run"]);
    return this.resolveLayers(layers);
  }

  private resolveLayers(specs: Array<[CapabilityScopeKind, string, string]>): EffectiveCapabilityPolicy {
    const layers: CapabilityPolicyLayer[] = specs.map(([scopeKind, scopeId, label]) => ({
      scopeKind,
      scopeId,
      label,
      restrictedCapabilityIds: this.get(scopeKind, scopeId)?.restrictedCapabilityIds ?? [],
    }));
    return resolveCapabilityPolicy(layers);
  }
}
