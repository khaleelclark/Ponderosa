import { createHash, randomUUID } from "node:crypto";
import { CAPABILITY_IDS, type MemorySourceReference, type MemorySourceClassification } from "@ponderosa/core";
import { CapabilityPolicyStore, MemoryStore, MemoryNotFoundError, MemoryRevisionConflictError,
  type AgentStore, type TrustedMemoryContext } from "@ponderosa/agents";
import type { ActiveRun, AgentMessageCapability, CreateServerOptions } from "./app-contracts.js";
import { projectInProduct, resourceInProduct, type ProductScope } from "./product-scope.js";

export class MemoryAuthorityError extends Error {}
export interface MemoryAuthorityPorts {
  store: AgentStore;
  opts: CreateServerOptions;
  agentMessageCapabilities: ReadonlyMap<string, AgentMessageCapability>;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  capabilityOwnsAuthoritativeRun(capability: AgentMessageCapability, run: ActiveRun | undefined): boolean;
  unavailable(projectId: string, agentId?: string, conversationId?: string): boolean;
}

/** Internal host boundary: caller identity never comes from a body/schema. All
 * resolver calls execute synchronously in MemoryStore's SAME SQLite transaction. */
export class MemoryAuthority {
  private readonly policies: CapabilityPolicyStore;
  constructor(readonly ports: MemoryAuthorityPorts) { this.policies = new CapabilityPolicyStore(ports.store.sqlite); }

  private enabled(): void {
    if (!this.ports.opts.memoryEnabled) throw new MemoryAuthorityError("Memory is disabled");
  }
  private singleProtectedOperator(): boolean {
    const { opts } = this.ports;
    if ((opts.operatorIdentities?.length ?? 0) > 1) return false;
    if (opts.networkSecurity?.mode === "reverse_proxy") return opts.operatorIdentities?.length === 1;
    return Boolean(opts.authToken || opts.launcherSecurity);
  }
  private principal(): string {
    if (!this.singleProtectedOperator()) throw new MemoryAuthorityError("Memory requires one protected installation operator; shared-daemon private tenancy is unsupported");
    const { sqlite } = this.ports.store;
    // ponytail: one opaque installation owner; per-person identity requires a
    // separate authenticated membership/Run binding, not a header/token hash.
    sqlite.prepare("INSERT OR IGNORE INTO memory_installation_owner VALUES(1,?)").run(randomUUID());
    return (sqlite.prepare("SELECT principal_id FROM memory_installation_owner WHERE singleton=1").get() as { principal_id: string }).principal_id;
  }
  private existingPrincipal(): string {
    if (!this.singleProtectedOperator()) throw new MemoryAuthorityError("Memory owner is unavailable");
    const row = this.ports.store.sqlite.prepare("SELECT principal_id FROM memory_installation_owner WHERE singleton=1").get() as { principal_id: string } | undefined;
    if (!row?.principal_id) throw new MemoryAuthorityError("Memory owner is unavailable");
    return row.principal_id;
  }
  private projectLive(projectId: string, product: ProductScope): boolean {
    const { store } = this.ports;
    return projectInProduct(store, projectId, product) && !this.ports.unavailable(projectId) &&
      !store.sqlite.prepare(`SELECT 1 FROM project_deletion_pending WHERE project_id=?
        UNION ALL SELECT 1 FROM project_deletion_receipts WHERE project_id=?
        UNION ALL SELECT 1 FROM branch_installation_resources WHERE local_id=? AND state!='active'`).get(projectId, projectId, projectId);
  }
  private temporary(projectId: string): boolean {
    return Boolean(this.ports.store.sqlite.prepare("SELECT 1 FROM conversations WHERE project_id=? AND branch_execution_id IS NOT NULL").get(projectId));
  }

  private sources(projectId: string | undefined, product: ProductScope, agentId?: string, conversationId?: string) {
    const { store } = this.ports;
    const mayReadSource = (source: MemorySourceReference): boolean => {
      if (!projectId) return false; // Global links lack a trusted Project source binding.
      if (source.kind === "artifact") {
        const artifact = store.getProjectArtifact(projectId, source.id);
        if (!artifact || source.revision !== "1" || artifact.sha256 !== source.sha256) return false;
        const origin = artifact.originAgentId ?? artifact.agentId;
        return resourceInProduct(store, "agent", origin, product) &&
          (!agentId || store.agentCanReadProjectArtifact(projectId, source.id, agentId));
      }
      const event = store.getCommunicationEvent(projectId, source.id);
      if (!event || source.revision !== "1" || event.document ||
          createHash("sha256").update(event.text).digest("hex") !== source.sha256 ||
          store.readCommunicationRevisions(projectId).some(revision => revision.targetEventId === source.id)) return false;
      if (!event.conversationId || !resourceInProduct(store, "conversation", event.conversationId, product)) return false;
      if (!agentId) return true; // Authenticated installation audit owner.
      if (event.conversationId !== conversationId) return false;
      if (event.sender.kind === "agent" && event.sender.agentId === agentId) return true;
      if (event.intent === "broadcast") return true;
      if (event.intent === "collaboration") return event.audience.agentIds.includes(agentId);
      return event.audience.kind === "user_agent" ? event.audience.agentId === agentId
        : event.audience.kind === "user_agents" && event.audience.agentIds.includes(agentId);
    };
    return {
      mayReadSource,
      // Canonical sources currently belong to a Chat/explicit recipients, while
      // Project memory shares across Chats. No existing exact declassification
      // Decision port is bound here. Reject rather than expand the audience.
      maySaveSource: (_scope: unknown, _source: MemorySourceReference, _classification: MemorySourceClassification): boolean => false,
    };
  }
  forAgent(token: string, toolName: string, requestedScope: "project" | "global" | "both" = "both"): MemoryStore {
    return new MemoryStore(this.ports.store.sqlite, () => {
      this.enabled();
      const { agentMessageCapabilities, activeRuns } = this.ports;
      const capability = agentMessageCapabilities.get(token);
      const active = capability && activeRuns.get(capability.agentId);
      if (!capability || active?.messageCapability !== token || !this.ports.capabilityOwnsAuthoritativeRun(capability, active) ||
          !capability.availableToolNames.includes(toolName)) throw new MemoryAuthorityError("Memory capability is not authorized for an active Run");
      return this.agentContext(capability, toolName, requestedScope);
    });
  }
  /** Host-only preparation, before an ActiveRun capability is issued. The
   * scheduler row, fence, policy and owning Chat remain the authority. */
  forPreparation(scope: { agentId: string; runId: string; fencingToken: number }): MemoryStore {
    return new MemoryStore(this.ports.store.sqlite, () => {
      this.enabled();
      const agent = this.ports.store.getAgent(scope.agentId);
      return this.agentContext({ agentId: scope.agentId, runId: scope.runId,
        conversationId: agent?.conversationId, v3SchedulerRunId: scope.runId,
        v3FencingToken: scope.fencingToken }, "ponderosa_memory_search", "both");
    });
  }
  /** Host-only exposure read: no provider, tool, publication or write authority. */
  forPlayback(scope: { agentId: string; runId: string; fencingToken: number; conversationId: string }): MemoryStore {
    return new MemoryStore(this.ports.store.sqlite, () => this.agentContext({
      agentId: scope.agentId, runId: scope.runId, conversationId: scope.conversationId,
      v3SchedulerRunId: scope.runId, v3FencingToken: scope.fencingToken,
    }, "ponderosa_memory_search", "both", true));
  }
  private agentContext(capability: Pick<AgentMessageCapability, "agentId" | "runId" | "conversationId" | "v3SchedulerRunId" | "v3FencingToken">,
    toolName: string, requestedScope: "project" | "global" | "both", playback = false): TrustedMemoryContext {
    const { store } = this.ports;
    const agent = store.getAgent(capability.agentId);
    const chat = agent && store.getConversation(agent.conversationId);
    if (!agent || agent.archived || store.agentCreationPending(agent.id) || !chat || chat.archived || chat.projectId !== agent.projectId ||
        capability.conversationId !== chat.id || this.ports.unavailable(agent.projectId, agent.id, chat.id)) throw new MemoryAuthorityError("Memory owner is unavailable");
    const product = chat.branchId ? "branches" : "dev";
    if (!this.projectLive(agent.projectId, product) || !resourceInProduct(store, "agent", agent.id, product) ||
        (chat.branchId && !store.sqlite.prepare("SELECT 1 FROM branches WHERE id=? AND deleting=0").get(chat.branchId))) throw new MemoryAuthorityError("Memory owner is unavailable");
    // Independently bind the canonical Run to this Agent/Project on the same
    // connection. Cleanup/outcome-unknown authority never admits memory.
    if (!store.sqlite.prepare(`SELECT 1 FROM scheduler_runs WHERE id=? AND agent_id=? AND project_id=?
      AND fencing_token=? AND side_effects_fenced_at IS NULL
      AND ((status IN ('leased','running') AND lease_expires_at>?) OR (?=1 AND status='completed'))`).get(
        capability.v3SchedulerRunId, agent.id, agent.projectId, capability.v3FencingToken, new Date().toISOString(), playback ? 1 : 0)) throw new MemoryAuthorityError("Memory Run is fenced");
    const restricted = this.policies.resolveForAgent(agent.id, capability.runId).restrictedCapabilityIds;
    const read = !restricted.includes(CAPABILITY_IDS.memoryRead);
    const writeProject = !playback && !restricted.includes(CAPABILITY_IDS.memoryWriteProject) && !this.temporary(agent.projectId);
    if ((toolName.endsWith("_get") || toolName.endsWith("_search")) ? !read : !writeProject) throw new MemoryAuthorityError("Memory operation is restricted");
    const grant = this.grant(agent.projectId, product);
    const principalId = playback && this.ports.opts.memoryEnabled ? this.existingPrincipal() : undefined;
    return {
      actor: { kind: "agent", id: agent.id, agentId: agent.id, runId: capability.runId },
      ...(requestedScope !== "global" ? { projectId: agent.projectId } : {}),
      ...(requestedScope !== "project" && grant.enabled && this.singleProtectedOperator() ? { globalPrincipalId: playback ? (principalId ?? this.existingPrincipal()) : this.principal() } : {}),
      read: read && (!playback || !!this.ports.opts.memoryEnabled), writeProject, writeGlobal: false, ...this.sources(agent.projectId, product, agent.id, chat.id),
    } satisfies TrustedMemoryContext;
  }

  /** Called only after ordinary operator hooks. Agent tokens are rejected by
   * routes even on an otherwise unprotected embedding. */
  forOperator(product: ProductScope, projectId?: string): MemoryStore {
    return new MemoryStore(this.ports.store.sqlite, () => {
      this.enabled(); const principalId = this.principal();
      if (projectId && !this.projectLive(projectId, product)) throw new MemoryNotFoundError();
      return { actor: { kind: "operator", id: principalId }, ...(projectId ? { projectId } : { globalPrincipalId: principalId }),
        read: true, writeProject: !!projectId && !this.temporary(projectId), writeGlobal: !projectId,
        ...this.sources(projectId, product) } satisfies TrustedMemoryContext;
    });
  }
  grant(projectId: string, product: ProductScope): { enabled: boolean; revision: number } {
    const row = this.ports.store.sqlite.prepare("SELECT enabled,revision FROM memory_global_grants WHERE project_id=? AND product=?").get(projectId, product) as { enabled: number; revision: number } | undefined;
    return { enabled: row?.enabled === 1, revision: row?.revision ?? 0 };
  }
  setGrant(projectId: string, product: ProductScope, enabled: boolean, expectedRevision: number) {
    return this.ports.store.sqlite.transaction(() => {
      this.forOperator(product, projectId).list(1); // Live host/Project authority in this transaction.
      if (this.temporary(projectId)) throw new MemoryAuthorityError("Temporary Branch Projects require an explicit durable target before global grants");
      const current = this.grant(projectId, product);
      if (current.revision !== expectedRevision) throw new MemoryRevisionConflictError();
      this.ports.store.sqlite.prepare(`INSERT INTO memory_global_grants VALUES(?,?,?,?,?)
        ON CONFLICT(project_id,product) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,updated_at=excluded.updated_at`)
        .run(projectId, product, expectedRevision + 1, enabled ? 1 : 0, new Date().toISOString());
      if (current.enabled !== enabled) this.ports.store.sqlite.prepare(`INSERT INTO memory_scope_generations VALUES('project',?,1)
        ON CONFLICT(scope,owner_id) DO UPDATE SET generation=generation+1`).run(projectId);
      return this.grant(projectId, product);
    }).immediate();
  }
  promote(product: ProductScope, projectId: string, id: string, expectedRevision: number, textHash: string, commandKey: string) {
    return this.ports.store.sqlite.transaction(() => {
      const source = this.forOperator(product, projectId).get(id);
      if (!source) throw new MemoryNotFoundError();
      if (source.revision !== expectedRevision || source.textHash !== textHash) throw new MemoryRevisionConflictError();
      const receipt = this.forOperator(product).save({ text: source.text, classification: source.classification,
        ...(source.expiresAt ? { expiresAt: source.expiresAt } : {}), scope: "global",
        // Bind lineage into the canonical command hash so changed retries fail.
        // Source links do not acquire the global audience.
        promotionSource: { memoryId: id, revision: expectedRevision, textHash }, commandKey });
      this.ports.store.sqlite.prepare("INSERT OR IGNORE INTO memory_promotions VALUES(?,?,?,?)").run(receipt.memoryId, id, expectedRevision, textHash);
      return receipt;
    }).immediate();
  }
}
