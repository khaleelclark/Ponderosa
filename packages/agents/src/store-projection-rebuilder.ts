import { existsSync, mkdirSync, readdirSync } from "node:fs";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import {
  allocateAgentMentionHandle,
  type AgentOrganizationEvent,
  type AgentPresetDto,
} from "@ponderosa/core";
import type { Db } from "./db.js";
import { EventLog } from "./eventlog.js";
import { readRepairableJsonl } from "./append-jsonl.js";
import { pruneArtifactDirectory, readJson, writeJson } from "./store-filesystem.js";
import type { AgentJson, ConversationJson, PresetEvent, ProjectJson } from "./store-types.js";
import { AgentArtifactCatalog } from "./store-artifact-catalog.js";
import { AgentCatalogAuthority } from "./store-agent-catalog-authority.js";
import { AgentEventProjectionStore } from "./store-event-projection.js";
import { sharedWorkingCopy } from "./working-copy.js";
import {
  activityProjection,
  agentConversationMemberships,
  agentHandleReservations,
  agentPresets,
  agents,
  artifacts,
  changedFileProjection,
  chatSearchMessages,
  continuationHandoffs,
  conversations,
  events,
  importedHistoryMessages,
  managedArtifactProjection,
  messages,
  projects,
  runs,
  workItems,
} from "./schema.js";
import {
  agentJsonPath,
  agentOrganizationEventsPath,
  agentPresetsPath,
  agentsDir,
  artifactsDir,
  conversationJsonPath,
  conversationsDir,
  eventsPath,
  importedAgentHistoryPath,
  projectJsonPath,
  projectsDir,
} from "./paths.js";

function isBoundedRecordId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

export class AgentProjectionRebuilder {
  private recoveryIssues: Array<{ projectId: string; detail: string }> = [];
  constructor(
    private readonly dataDir: string,
    private readonly db: Db,
    private readonly client: Database.Database,
    private readonly artifactCatalog: AgentArtifactCatalog,
    private readonly agentCatalog: AgentCatalogAuthority,
    private readonly eventProjection: AgentEventProjectionStore,
    private readonly recoverProjectDeletionDirectories: () => void,
    private readonly recoverAgentDeletionDirectories: () => void,
    private readonly sanitizeOrganizationProjection: (projectId: string) => void,
    private readonly rebuildGlobalChatSearchProjection: () => void,
  ) {}

  rebuildProjections(): void {
    // Project recovery crosses an irreversible filesystem boundary. Its receipt
    // commits must not be rolled back when a later, unrelated projection replay
    // fails and the broad rebuild transaction is reverted.
    this.recoverProjectDeletionDirectories();
    this.client.transaction(() => this.rebuildProjectionsInTransaction())();
  }

  private rebuildProjectionsInTransaction(): void {
    this.recoveryIssues = [];
    this.recoverAgentDeletionDirectories();
    this.client.prepare(`DELETE FROM all_chat_feed_projection`).run();
    this.client.prepare(`DELETE FROM agent_health_projection`).run();
    this.client.prepare(`DELETE FROM agent_event_head_projection`).run();
    this.client.prepare(`DELETE FROM tool_output_projection`).run();
    this.db.delete(continuationHandoffs).run();
    this.db.delete(activityProjection).run();
    this.client.prepare(`DELETE FROM changed_file_execution_projection`).run();
    this.db.delete(changedFileProjection).run();
    this.db.delete(managedArtifactProjection).run();
    this.db.delete(importedHistoryMessages).run();
    this.db.delete(events).run();
    this.db.delete(artifacts).run();
    this.db.delete(workItems).run();
    this.db.delete(runs).run();
    this.db.delete(messages).run();
    this.db.delete(chatSearchMessages).run();
    this.db.delete(agents).run();
    this.db.delete(agentConversationMemberships).run();
    this.db.delete(conversations).run();
    this.db.delete(projects).run();
    this.db.delete(agentPresets).run();
    this.eventProjection.clearCaches();

    const root = projectsDir(this.dataDir);
    if (!existsSync(root)) return;
    const canonicallyDeletedConversationIds = new Map<string, Set<string>>();
    for (const row of this.client.prepare(`
      SELECT project_id, conversation_id FROM conversation_deletion_receipts
      WHERE canonical_deletion_completed = 1
    `).all() as Array<{ project_id: string; conversation_id: string }>) {
      const projectConversationIds = canonicallyDeletedConversationIds.get(row.project_id) ??
        new Set<string>();
      projectConversationIds.add(row.conversation_id);
      canonicallyDeletedConversationIds.set(row.project_id, projectConversationIds);
    }

    for (const projectId of readdirSync(root)) {
      if (projectId.startsWith(".") || projectId.endsWith(".creating")) {
        // Hidden and creation-shaped entries without a durable ownership
        // receipt are preserved. Recovery authorities may claim an exact entry;
        // projection rebuild must never authenticate storage by its name alone.
        continue;
      }
      this.client.exec("SAVEPOINT ponderosa_project_projection");
      try {
      const pj = projectJsonPath(this.dataDir, projectId);
      if (!existsSync(pj)) continue;
      const p = readJson<ProjectJson>(pj);
      if (!isBoundedRecordId(projectId) || p.id !== projectId) {
        throw new Error(`Project record ${p.id} does not match containing directory ${projectId}`);
      }
      this.db
        .insert(projects)
        .values({
          id: p.id,
          label: p.label,
          hostPath: p.hostPath,
          createdAt: p.createdAt,
          lastUsedAt: p.lastUsedAt ?? null,
          defaultEngine: p.defaultEngine ?? "codex",
          defaultModel: p.defaultModel ?? null,
          defaultEffort: p.defaultEffort ?? null,
          lastConversationId: p.lastConversationId ?? null,
        })
        .run();
      const resolved = new Map<string, AgentPresetDto>();
      for (const event of readRepairableJsonl<PresetEvent>(
        agentPresetsPath(this.dataDir, projectId), "agent preset journal", true,
      )) {
        if (event.type === "upsert") {
          if (event.preset.projectId !== projectId || !isBoundedRecordId(event.preset.id)) {
            throw new Error(`Agent preset record does not belong to Project ${projectId}`);
          }
          resolved.set(event.preset.id, event.preset);
        } else if (event.type === "delete") {
          if (!isBoundedRecordId(event.id)) {
            throw new Error(`Agent preset deletion record is invalid for Project ${projectId}`);
          }
          resolved.delete(event.id);
        } else {
          throw new Error(`Agent preset journal contains an unknown event for Project ${projectId}`);
        }
      }
      for (const preset of resolved.values()) this.db.insert(agentPresets).values({ ...preset, enabled: preset.enabled ? 1 : 0 }).run();
      const organizationalParents = new Map<string, string | null>();
      for (const event of readRepairableJsonl<AgentOrganizationEvent>(
        agentOrganizationEventsPath(this.dataDir, projectId), "agent organization log", true,
      )) {
        if (event.projectId !== projectId || event.type !== "manager_changed" ||
            !isBoundedRecordId(event.eventId) || !isBoundedRecordId(event.agentId) ||
            (event.managerAgentId !== null && !isBoundedRecordId(event.managerAgentId))) {
          throw new Error(`Agent organization record does not belong to Project ${projectId}`);
        }
        organizationalParents.set(event.agentId, event.managerAgentId);
      }

      const mDir = conversationsDir(this.dataDir, projectId);
      if (existsSync(mDir)) {
        for (const conversationId of readdirSync(mDir)) {
          if (conversationId.startsWith(".") || conversationId.endsWith(".creating")) continue;
          if (canonicallyDeletedConversationIds.get(projectId)?.has(conversationId)) continue;
          const mj = conversationJsonPath(this.dataDir, projectId, conversationId);
          if (!existsSync(mj)) continue;
          const m = readJson<ConversationJson>(mj);
          if (!isBoundedRecordId(conversationId) || m.id !== conversationId || m.projectId !== projectId) {
            throw new Error(`Chat record ${m.id} does not match its containing Project and directory`);
          }
          this.db
            .insert(conversations)
            .values({
              id: m.id,
              projectId: m.projectId,
              title: m.title,
              branchId: m.branchId ?? null,
              executionId: m.executionId ?? null,
              defaultEngine: m.defaultEngine ?? null,
              defaultModel: m.defaultModel ?? null,
              defaultEffort: m.defaultEffort ?? null,
              defaultSpeed: m.defaultSpeed ?? null,
              createdAt: m.createdAt,
              updatedAt: m.updatedAt,
              archived: m.archived ? 1 : 0,
            })
            .run();
        }
      }

      this.artifactCatalog.rebuildProjectProjection(projectId);
      const tDir = agentsDir(this.dataDir, projectId);
      if (!existsSync(tDir)) {
        this.artifactCatalog.rebuildLegacyCustody(projectId);
        continue;
      }
      for (const agentId of readdirSync(tDir)) {
        if (agentId.startsWith(".") || agentId.endsWith(".creating")) {
          // Recovery authorities may claim exact journal-bound staging paths.
          // Projection rebuild never derives mutation ownership from a name.
          continue;
        }
        const tj = agentJsonPath(this.dataDir, projectId, agentId);
        if (!existsSync(tj)) continue;
        const t = readJson<AgentJson>(tj);
        if (!isBoundedRecordId(agentId) || t.id !== agentId || t.projectId !== projectId) {
          throw new Error(`Agent record ${t.id} does not match its containing Project and directory`);
        }
        const latestReservation = this.client.prepare(`
          SELECT handle FROM agent_handle_reservations
          WHERE project_id = ? AND agent_id = ?
          ORDER BY reserved_at DESC, normalized_handle DESC
          LIMIT 1
        `).get(projectId, t.id) as { handle: string } | undefined;
        const handle = t.handle ?? latestReservation?.handle ?? allocateAgentMentionHandle(
          t.title,
          this.db.select({ handle: agentHandleReservations.handle })
            .from(agentHandleReservations)
            .where(eq(agentHandleReservations.projectId, projectId))
            .all()
            .map(reservation => reservation.handle),
        );
        this.db.insert(agentHandleReservations).values({
          projectId,
          normalizedHandle: handle.toLocaleLowerCase(),
          handle,
          agentId: t.id,
          reservedAt: t.createdAt,
        }).onConflictDoNothing().run();
        const workingCopy = t.workingCopy ?? sharedWorkingCopy(p, t.updatedAt);
        const fallbackConversation = this.client.prepare(`
          SELECT id FROM conversations WHERE project_id = ? AND archived = 0
          ORDER BY created_at, id LIMIT 1
        `).get(projectId) as { id: string } | undefined;
        const conversationExists = (conversationId: string | undefined): conversationId is string =>
          Boolean(conversationId && this.client.prepare(`
            SELECT 1 FROM conversations WHERE id = ? AND project_id = ?
          `).get(conversationId, projectId));
        const primaryConversationId = t.deletedAt
          ? undefined
          : conversationExists(t.conversationId)
            ? t.conversationId
            : conversationExists(p.lastConversationId)
              ? p.lastConversationId
              : fallbackConversation?.id;
        if (!t.deletedAt && !primaryConversationId) {
          throw new Error(`live Agent ${t.id} has no owner Chat`);
        }
        this.db
          .insert(agents)
          .values({
            id: t.id,
            projectId: t.projectId,
            conversationId: primaryConversationId ?? null,
            title: t.title,
            handle,
            activeEngine: t.activeEngine,
            model: t.model ?? null,
            effort: t.effort ?? null,
            speed: t.speed ?? null,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
            deletedAt: t.deletedAt ?? null,
            archived: t.archived ? 1 : 0,
            managerAgentId: organizationalParents.get(t.id) ?? null,
            allowAutomaticDescendantDeletion: t.managementPermissions?.allowAutomaticDescendantDeletion ? 1 : 0,
            allowAutomaticDescendantReorganization: t.managementPermissions?.allowAutomaticDescendantReorganization ? 1 : 0,
            spawnedByAgentId: t.spawnedByAgentId ?? null,
            spawnedByExecutionId: t.spawnedByExecutionId ?? null,
            spawnPrompt: t.spawnPrompt ?? null,
            spawnIdempotencyKey: t.spawnIdempotencyKey ?? null,
            presetSnapshotJson: t.presetSnapshot ? JSON.stringify(t.presetSnapshot) : null,
            creationIdempotencyKey: t.creationIdempotencyKey ?? null,
            workingCopyJson: JSON.stringify(workingCopy),
          })
          .run();
        if (primaryConversationId) {
          this.db.insert(agentConversationMemberships).values({
            agentId: t.id,
            conversationId: primaryConversationId,
            position: 0,
          }).run();
        }
        if (t.handle !== handle || t.conversationId !== primaryConversationId || !t.workingCopy) {
          writeJson(tj, { ...t, handle, conversationId: primaryConversationId, workingCopy });
        }

        const importedHistoryFile = importedAgentHistoryPath(this.dataDir, projectId, agentId);
        if (existsSync(importedHistoryFile)) {
          this.agentCatalog.projectImportedHistory(agentId, readJson(importedHistoryFile));
        }

        const logFile = eventsPath(this.dataDir, projectId, agentId);
        mkdirSync(artifactsDir(this.dataDir, projectId, agentId), { recursive: true });
        if (!existsSync(logFile)) continue;
        const stored = new EventLog(logFile).readAll();
        const protectedArtifactPaths = new Set(stored.flatMap(({ event }) =>
          event.type === "generated_artifact" || event.type === "browser_screenshot" ? [event.path] : [],
        ));
        // Provider-generated bytes are authored state. Other artifact files are
        // projections and are safely rebuilt from canonical events below.
        pruneArtifactDirectory(artifactsDir(this.dataDir, projectId, agentId), protectedArtifactPaths);
        this.eventProjection.projectStored(agentId, projectId, stored, t.activeEngine);
        if (t.deletedAt) {
          this.db.update(agents).set({
            conversationId: null,
            activeSessionId: null,
            activeSessionContractHash: null,
            activeSessionArtifactIdsJson: "[]",
            archived: 1,
            managerAgentId: null,
            allowAutomaticDescendantDeletion: 0,
            allowAutomaticDescendantReorganization: 0,
            deletedAt: t.deletedAt,
            updatedAt: t.deletedAt,
          }).where(eq(agents.id, t.id)).run();
        }
      }
      // Artifact recovery validates custody against the rebuilt Agent/Chat catalog.
      this.artifactCatalog.rebuildLegacyCustody(projectId);
      this.sanitizeOrganizationProjection(projectId);
      } catch (error) {
        this.client.exec("ROLLBACK TO ponderosa_project_projection");
        this.recoveryIssues.push({
          projectId,
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.client.exec("RELEASE ponderosa_project_projection");
      }
    }
    // Project rows are rebuildable and are deleted/reinserted above. The
    // deletion quarantine is authoritative, so prune it only after canonical
    // Project folders have been fully reconstructed.
    const quarantined = new Set(this.recoveryIssues.map((issue) => issue.projectId));
    for (const row of this.client.prepare(`
      SELECT project_id FROM project_deletion_pending
      WHERE project_id NOT IN (SELECT id FROM projects)
    `).all() as Array<{ project_id: string }>) {
      if (!quarantined.has(row.project_id)) {
        this.client.prepare("DELETE FROM project_deletion_pending WHERE project_id = ?")
          .run(row.project_id);
      }
    }
    this.rebuildGlobalChatSearchProjection();
  }

  listRecoveryIssues(): ReadonlyArray<{ projectId: string; detail: string }> {
    return this.recoveryIssues;
  }

}
