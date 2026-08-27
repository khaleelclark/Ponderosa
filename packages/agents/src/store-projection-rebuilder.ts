import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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
import { pruneArtifactDirectory, readJson, readJsonLines, writeJson } from "./store-filesystem.js";
import type { AgentJson, ConversationJson, PresetEvent, ProjectJson } from "./store-types.js";
import { AgentArtifactCatalog } from "./store-artifact-catalog.js";
import { AgentCatalogAuthority } from "./store-agent-catalog-authority.js";
import { AgentEventProjectionStore } from "./store-event-projection.js";
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
  agentDir,
  agentJsonPath,
  agentOrganizationEventsPath,
  agentPresetsPath,
  agentsDir,
  artifactsDir,
  conversationJsonPath,
  conversationsDir,
  eventsPath,
  importedAgentHistoryPath,
  projectDir,
  projectJsonPath,
  projectsDir,
} from "./paths.js";

export class AgentProjectionRebuilder {
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
    this.client.transaction(() => this.rebuildProjectionsInTransaction())();
  }

  private rebuildProjectionsInTransaction(): void {
    this.recoverProjectDeletionDirectories();
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

    for (const projectId of readdirSync(root)) {
      if (projectId.startsWith(".") || projectId.endsWith(".creating")) {
        rmSync(projectDir(this.dataDir, projectId), { recursive: true, force: true });
        continue;
      }
      const pj = projectJsonPath(this.dataDir, projectId);
      if (!existsSync(pj)) continue;
      const p = readJson<ProjectJson>(pj);
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
      for (const event of readRepairableJsonl<PresetEvent>(agentPresetsPath(this.dataDir, projectId), "agent preset journal", true)) event.type === "upsert" ? resolved.set(event.preset.id, event.preset) : resolved.delete(event.id);
      for (const preset of resolved.values()) this.db.insert(agentPresets).values({ ...preset, enabled: preset.enabled ? 1 : 0 }).run();
      const organizationalParents = new Map<string, string | null>();
      for (const event of readJsonLines<AgentOrganizationEvent>(agentOrganizationEventsPath(this.dataDir, projectId))) {
        if (event.projectId === projectId && event.type === "manager_changed") {
          organizationalParents.set(event.agentId, event.managerAgentId);
        }
      }

      const mDir = conversationsDir(this.dataDir, projectId);
      if (existsSync(mDir)) {
        for (const conversationId of readdirSync(mDir)) {
          const mj = conversationJsonPath(this.dataDir, projectId, conversationId);
          if (!existsSync(mj)) continue;
          const m = readJson<ConversationJson>(mj);
          this.db
            .insert(conversations)
            .values({
              id: m.id,
              projectId: m.projectId,
              title: m.title,
              defaultEngine: m.defaultEngine ?? null,
              defaultModel: m.defaultModel ?? null,
              defaultEffort: m.defaultEffort ?? null,
              createdAt: m.createdAt,
              updatedAt: m.updatedAt,
              archived: m.archived ? 1 : 0,
            })
            .run();
        }
      }

      this.artifactCatalog.rebuildProjectProjection(projectId);

      const tDir = agentsDir(this.dataDir, projectId);
      if (!existsSync(tDir)) continue;
      for (const agentId of readdirSync(tDir)) {
        if (agentId.startsWith(".") || agentId.endsWith(".creating")) {
          rmSync(agentDir(this.dataDir, projectId, agentId), { recursive: true, force: true });
          continue;
        }
        const tj = agentJsonPath(this.dataDir, projectId, agentId);
        if (!existsSync(tj)) continue;
        const t = readJson<AgentJson>(tj);
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
        const membershipIds = [...new Set(t.conversationIds ?? (t.conversationId ? [t.conversationId] : []))];
        const primaryConversationId = t.conversationId && membershipIds.includes(t.conversationId)
          ? t.conversationId
          : membershipIds[0];
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
          })
          .run();
        membershipIds.forEach((conversationId, position) => {
          this.db.insert(agentConversationMemberships).values({ agentId: t.id, conversationId, position }).run();
        });
        if (t.handle !== handle || t.conversationIds === undefined || t.conversationId !== primaryConversationId) {
          writeJson(tj, { ...t, handle, conversationId: primaryConversationId, conversationIds: membershipIds });
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
      this.sanitizeOrganizationProjection(projectId);
    }
    // Project rows are rebuildable and are deleted/reinserted above. The
    // deletion quarantine is authoritative, so prune it only after canonical
    // Project folders have been fully reconstructed.
    this.client.prepare(`
      DELETE FROM project_deletion_pending
      WHERE project_id NOT IN (SELECT id FROM projects)
    `).run();
    this.rebuildGlobalChatSearchProjection();
  }

}
