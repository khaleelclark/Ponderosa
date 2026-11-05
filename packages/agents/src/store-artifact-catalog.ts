import {validWorkingFileTransportPart,type WorkingFileTransportPart} from "./working-file-transport.js";
import {activeChatOwnerSql} from "./product-scope-sql.js";
import {artifactAgentProductSql,managedArtifactProductSql} from './artifact-product-scope.js';
import type { ProjectionProgress } from "./projection-checkpoint.js";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "@ponderosa/native-host/fs";
import type {
  ArtifactDto,
  ArtifactKind,
  HistoryPageDto,
  CommunicationEvent,
} from "@ponderosa/core";
import { relative, resolve, sep } from "node:path";
import { readSecureFile } from "@ponderosa/native-host";
import { removeManagedArtifactContent, publishManagedArtifactContent } from "./managed-artifact-files.js";
import { appendFsyncedJsonl, readRepairableJsonl } from "./append-jsonl.js";
import type { LogEvent, StoredLogEvent } from "./log-event.js";
import { communicationEventsPath, managedArtifactContentPath, managedArtifactsLogPath } from "./paths.js";
import type {
  ArtifactProjectionReadRow,
  ManagedArtifactAccess,
  ManagedArtifactEvent,
  ManagedProjectArtifact,
} from "./store-types.js";

type CursorBoundary = { orderKey: string; rowKey: string };
type CursorInput = CursorBoundary & { stream: string; scope: string };
type ArtifactAgent = { projectId: string; conversationId?: string };

export class AgentArtifactCatalog {
  constructor(
    private readonly dataDir: string,
    private readonly client: Database.Database,
    private readonly encodeHistoryCursor: (input: CursorInput) => string,
    private readonly decodeHistoryCursor: (
      cursor: string,
      stream: string,
      scope: string,
    ) => CursorBoundary,
    private readonly agentById: (agentId: string) => ArtifactAgent | undefined,
    private readonly projectExists: (projectId: string) => boolean,
    private readonly readAgentEvents: (agentId: string) => StoredLogEvent[],
    private readonly progress: ProjectionProgress,
  ) {}

  retainDeletedAgentArtifactBytes(projectId: string, agentId: string, sourceDirectory: string): void {
    const rows = this.client.prepare("SELECT id, path FROM artifacts WHERE agent_id = ?")
      .all(agentId) as Array<{ id: string; path: string }>;
    for (const row of rows) {
      const artifact = this.getProjectArtifact(projectId, row.id);
      if (!artifact || !this.operatorCanReadProjectArtifact(projectId, row.id)) continue;
      const base = resolve(sourceDirectory, "artifacts");
      const source = resolve(base, row.path);
      if (!source.startsWith(base + sep)) throw new Error("Shared artifact path escapes its owned directory");
      if (!existsSync(source)) continue;
      const body = readSecureFile({ root: this.dataDir, relativePath: relative(this.dataDir, source), maxBytes: 64 * 1024 * 1024 });
      if (!body || body.length !== artifact.size || createHash("sha256").update(body).digest("hex") !== artifact.sha256) {
        throw new Error("Shared Agent artifact bytes could not be verified; deletion cleanup remains pending");
      }
      publishManagedArtifactContent(this.dataDir, projectId, row.id, body);
    }
  }

  getArtifacts(agentId: string): ArtifactDto[] {
    const rows = this.client.prepare(`
      SELECT id, agent_id, execution_id, kind, path, summary, created_at,
        source_path, media_type, visibility, pinned, size
      FROM artifacts WHERE agent_id = ? ORDER BY created_at, id
    `).all(agentId) as ArtifactProjectionReadRow[];
    return rows.flatMap((row) => {
      const artifact = this.artifactDtoFromProjectionRow(agentId, row);
      return artifact ? [artifact] : [];
    });
  }

  artifactDtoFromProjectionRow(
    agentId: string,
    row: ArtifactProjectionReadRow,
  ): ArtifactDto | undefined {
    const agent = this.agentById(agentId);
    if (!agent) return undefined;
    if (
      row.kind === "generated_file"
      && row.source_path
      && row.media_type
      && row.size !== null
    ) {
      const root = `/api/projects/${encodeURIComponent(agent.projectId)}/agents/${encodeURIComponent(agentId)}/generated-artifacts/${encodeURIComponent(row.id)}`;
      return {
        id: row.id,
        agentId: row.agent_id,
        executionId: row.execution_id ?? undefined,
        kind: "generated_file",
        path: row.path,
        sourcePath: row.source_path,
        summary: row.summary ?? row.path,
        createdAt: row.created_at,
        mediaType: row.media_type,
        visibility: row.visibility === "published" ? "published" : "project",
        pinned: row.pinned === 1,
        size: row.size,
        previewUrl: `${root}/preview`,
        downloadUrl: `${root}/download`,
      };
    }
    if (row.kind === "diff" && row.source_path) {
      const captured = this.client.prepare(`
        SELECT 1 FROM artifacts
        WHERE agent_id = ? AND kind = 'generated_file' AND source_path = ? LIMIT 1
      `).get(agentId, row.source_path);
      if (captured) return undefined;
    }
    if (row.kind === "diff" && row.source_path?.toLowerCase().endsWith(".pdf")) {
      const root = `/api/projects/${encodeURIComponent(agent.projectId)}/agents/${encodeURIComponent(agentId)}/generated-artifacts/${encodeURIComponent(row.id)}`;
      return {
        id: row.id,
        agentId: row.agent_id,
        executionId: row.execution_id ?? undefined,
        kind: "document",
        path: row.path,
        sourcePath: row.source_path,
        createdAt: row.created_at,
        mediaType: "application/pdf",
        previewUrl: `${root}/preview`,
        downloadUrl: `${root}/download`,
      };
    }
    if (row.kind === "screenshot") {
      const root = `/api/projects/${encodeURIComponent(agent.projectId)}/agents/${encodeURIComponent(agentId)}/browser-artifacts/${encodeURIComponent(row.id)}`;
      return {
        id: row.id,
        agentId: row.agent_id,
        executionId: row.execution_id ?? undefined,
        kind: "screenshot",
        path: row.path,
        summary: row.summary ?? undefined,
        createdAt: row.created_at,
        mediaType: "image/png",
        previewUrl: root,
        downloadUrl: `${root}?download=1`,
      };
    }
    return {
      id: row.id,
      agentId: row.agent_id,
      executionId: row.execution_id ?? undefined,
      kind: row.kind as ArtifactKind,
      path: row.path,
      sourcePath: row.source_path ?? undefined,
      summary: row.summary ?? undefined,
      createdAt: row.created_at,
      mediaType: row.media_type ?? undefined,
      visibility: row.visibility === "published"
        ? "published"
        : row.visibility === "project"
          ? "project"
          : undefined,
      pinned: row.pinned === null ? undefined : row.pinned === 1,
      size: row.size ?? undefined,
    };
  }

  getArtifactPage(
    agentId: string,
    input: { limit: number; cursor?: string; focusId?: string },
  ): HistoryPageDto<ArtifactDto> {
    const limit = Math.max(1, Math.min(input.limit, 500));
    if (input.cursor && input.focusId) throw new Error("history cursor and focus cannot be combined");
    const focusId = input.focusId;
    const focusBoundary = focusId
      ? this.client.prepare(`
        SELECT created_at AS orderKey, id AS rowKey FROM artifacts
        WHERE agent_id = ? AND id = ?
      `).get(agentId, focusId) as CursorBoundary | undefined
      : undefined;
    if (focusId && !focusBoundary) {
      return { items: [], history: { limit, hasMore: false } };
    }
    const boundary = focusBoundary
      ?? (
        input.cursor
          ? this.decodeHistoryCursor(input.cursor, "agent:artifacts", agentId)
          : undefined
      );
    const rows = this.client.prepare(`
      SELECT id, agent_id, execution_id, kind, path, summary, created_at,
        source_path, media_type, visibility, pinned, size
      FROM artifacts
      WHERE agent_id = ?
        ${boundary ? `AND (created_at < ? OR (created_at = ? AND id ${focusBoundary ? "<=" : "<"} ?))` : ""}
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...(
      boundary
        ? [agentId, boundary.orderKey, boundary.orderKey, boundary.rowKey, limit + 1]
        : [agentId, limit + 1]
    )) as ArtifactProjectionReadRow[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items = selected.flatMap((row) => {
      const artifact = this.artifactDtoFromProjectionRow(agentId, row);
      return artifact ? [artifact] : [];
    }).reverse();
    const oldest = selected.at(-1);
    return {
      items,
      history: {
        limit,
        hasMore,
        ...(hasMore && oldest
          ? {
            cursor: this.encodeHistoryCursor({
              stream: "agent:artifacts",
              scope: agentId,
              orderKey: oldest.created_at,
              rowKey: oldest.id,
            }),
          }
          : {}),
      },
    };
  }

  /** Durable Project-owned generated-artifact catalog. */
  getProjectArtifacts(projectId: string): ArtifactDto[] {
    const rows = this.client.prepare(`
      SELECT artifact_json FROM managed_artifact_projection
      WHERE project_id = ? ORDER BY created_at, artifact_id
    `).all(projectId) as Array<{ artifact_json: string }>;
    return rows
      .map((row) => JSON.parse(row.artifact_json) as ManagedProjectArtifact)
      .map((artifact) => this.withProjectUrls(projectId, artifact));
  }

  /** True only when an exact source path was recorded by an Agent in this Project. */
  projectHasArtifactSourcePath(projectId: string, sourcePath: string): boolean {
    return Boolean(this.client.prepare(`
      SELECT 1
      FROM artifacts artifact
      JOIN agents agent ON agent.id = artifact.agent_id
      WHERE agent.project_id = ? AND artifact.source_path = ?
      LIMIT 1
    `).get(projectId, sourcePath));
  }

  rebuildProjectProjection(projectId: string): void {
    for (const event of readRepairableJsonl<ManagedArtifactEvent>(
      managedArtifactsLogPath(this.dataDir, projectId),
      `managed artifacts for project ${projectId}`,
    )) {
      if (!["created", "visibility", "deleted"].includes(event.type)) {
        throw new Error(`managed artifact record does not belong to Project ${projectId}`);
      }
      const artifactId = event.type === "created" ? event.artifact.id : event.artifactId;
      if (typeof artifactId !== "string" || !artifactId || artifactId.length > 200 ||
          (event.type === "created" && event.artifact.projectId !== projectId)) {
        throw new Error(`managed artifact record does not belong to Project ${projectId}`);
      }
      this.projectManagedArtifactEvent(projectId, event);
    }
  }

  /** Bounded Project-wide file/result catalog. SQLite applies the boundary to
   * Agent execution artifacts; the usually-small authored catalog is merged by
   * the same stable key before the response page is formed. */
  getProjectArtifactPage(
    projectId: string,
    input: { limit: number; cursor?: string; conversationId?: string; search?: string;productScope?:'dev'|'branches' },
  ): HistoryPageDto<ArtifactDto> {
    const limit = Math.max(1, Math.min(input.limit, 500));
    const conversationId = input.conversationId?.trim() || undefined;
    const search = input.search?.trim().toLocaleLowerCase() ?? "";
    if (search.length > 200) throw new Error("File search must be at most 200 characters");
    const terms = search.split(/\s+/u).filter(Boolean).map(term => `%${term.replace(/[\\%_]/gu, "\\$&")}%`);
    const baseScope = conversationId
      ? `${projectId}:conversation:${conversationId}`
      : projectId;
    const scopedBase=input.productScope?`${baseScope}:product:${input.productScope}`:baseScope;
    const cursorScope = search ? `${scopedBase}:search:${createHash("sha256").update(search).digest("hex")}` : scopedBase;
    const boundary = input.cursor
      ? this.decodeHistoryCursor(input.cursor, "project:artifacts", cursorScope)
      : undefined;
    const rows = this.client.prepare(`
      SELECT artifact.id, artifact.agent_id, artifact.execution_id, artifact.kind, artifact.path,
        artifact.summary, artifact.created_at, artifact.source_path, artifact.media_type,
        artifact.visibility, artifact.pinned, artifact.size
      FROM artifacts artifact
      JOIN agents agent ON agent.id = artifact.agent_id
      WHERE agent.project_id = ?
        ${input.productScope?`AND ${artifactAgentProductSql('agent',input.productScope)}`:''}
        ${conversationId ? `AND (agent.conversation_id = ? OR EXISTS (
          SELECT 1 FROM agent_conversation_memberships membership
          WHERE membership.agent_id = artifact.agent_id
            AND membership.conversation_id = ?
        ) OR EXISTS (
          SELECT 1 FROM agent_deletion_tombstones tombstone
          WHERE tombstone.agent_id = artifact.agent_id
            AND tombstone.project_id = agent.project_id
            AND tombstone.conversation_id = ?
        ))` : ""}
        ${boundary ? "AND (artifact.created_at < ? OR (artifact.created_at = ? AND artifact.id < ?))" : ""}
        ${terms.map(() => "AND lower(coalesce(artifact.source_path, artifact.path, '') || ' ' || coalesce(artifact.summary, '') || ' ' || agent.title) LIKE ? ESCAPE '\\'").join("\n")}
      ORDER BY artifact.created_at DESC, artifact.id DESC LIMIT ?
    `).all(...(
      boundary
        ? [projectId, ...(conversationId ? [conversationId, conversationId, conversationId] : []), boundary.orderKey, boundary.orderKey, boundary.rowKey, ...terms, limit + 1]
        : [projectId, ...(conversationId ? [conversationId, conversationId, conversationId] : []), ...terms, limit + 1]
    )) as ArtifactProjectionReadRow[];
    const executionArtifacts = rows.flatMap((row) => {
      const artifact = this.artifactDtoFromProjectionRow(row.agent_id, row);
      return artifact ? [{ ...artifact, projectId }] : [];
    });
    const managedRows = this.client.prepare(`
      SELECT artifact_json FROM managed_artifact_projection
      WHERE project_id = ? AND json_extract(artifact_json, '$.transportPart') IS NULL
        AND (json_extract(audience_json, '$.kind') = 'organization' OR owner_kind = 'operator_chat')
        AND (owner_kind != 'operator_chat' OR EXISTS(SELECT 1 FROM conversations operator_chat WHERE operator_chat.id=owner_id AND operator_chat.project_id=managed_artifact_projection.project_id AND operator_chat.branch_execution_id IS NULL AND ${activeChatOwnerSql('operator_chat')}))
        ${input.productScope?`AND ${managedArtifactProductSql('managed_artifact_projection',input.productScope)}`:''}
        ${conversationId ? `AND ((owner_kind='operator_chat' AND owner_id=?) OR EXISTS (
          SELECT 1 FROM agent_conversation_memberships membership
          WHERE membership.agent_id = json_extract(artifact_json, '$.originAgentId')
            AND membership.conversation_id = ?
        ) OR EXISTS (
          SELECT 1 FROM agents origin
          WHERE origin.id = json_extract(artifact_json, '$.originAgentId')
            AND origin.project_id = managed_artifact_projection.project_id
            AND origin.conversation_id = ?
        ) OR EXISTS (
          SELECT 1 FROM agent_deletion_tombstones tombstone
          WHERE tombstone.agent_id = json_extract(artifact_json, '$.originAgentId')
            AND tombstone.project_id = managed_artifact_projection.project_id
            AND tombstone.conversation_id = ?
        ))` : ""}
        ${boundary ? "AND (created_at < ? OR (created_at = ? AND artifact_id < ?))" : ""}
        ${terms.map(() => `AND lower(coalesce(json_extract(artifact_json, '$.sourcePath'), json_extract(artifact_json, '$.path'), '') || ' ' || coalesce(json_extract(artifact_json, '$.summary'), '') || ' ' || coalesce((
          SELECT title FROM agents author
          WHERE author.id = json_extract(artifact_json, '$.originAgentId')
            AND author.project_id = managed_artifact_projection.project_id
        ), '')) LIKE ? ESCAPE '\\'`).join("\n")}
      ORDER BY created_at DESC, artifact_id DESC LIMIT ?
    `).all(...(
      boundary
        ? [projectId, ...(conversationId ? [conversationId, conversationId, conversationId, conversationId] : []), boundary.orderKey, boundary.orderKey, boundary.rowKey, ...terms, limit + 1]
        : [projectId, ...(conversationId ? [conversationId, conversationId, conversationId, conversationId] : []), ...terms, limit + 1]
    )) as Array<{ artifact_json: string }>;
    const managed = managedRows.map((row) =>
      this.withProjectUrls(
        projectId,
        JSON.parse(row.artifact_json) as ManagedProjectArtifact,
      ));
    const merged = new Map<string, ArtifactDto>();
    for (const artifact of executionArtifacts) merged.set(artifact.id, artifact);
    for (const artifact of managed) merged.set(artifact.id, artifact);
    const ordered = [...merged.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const hasMore = ordered.length > limit
      || rows.length > limit
      || managedRows.length > limit;
    const selected = ordered.slice(0, limit);
    const oldest = selected.at(-1);
    return {
      items: selected.reverse(),
      history: {
        limit,
        hasMore,
        ...(hasMore && oldest
          ? {
            cursor: this.encodeHistoryCursor({
              stream: "project:artifacts",
              scope: cursorScope,
              orderKey: oldest.createdAt,
              rowKey: oldest.id,
            }),
          }
          : {}),
      },
    };
  }

  getProjectArtifact(projectId: string, artifactIdValue: string): ArtifactDto | undefined {
    const row = this.client.prepare(`
      SELECT artifact_json FROM managed_artifact_projection
      WHERE project_id = ? AND artifact_id = ?
    `).get(projectId, artifactIdValue) as { artifact_json: string } | undefined;
    if (!row) return undefined;
    return this.withProjectUrls(
      projectId,
      JSON.parse(row.artifact_json) as ManagedProjectArtifact,
    );
  }

  communicationAttachmentsForOperator(
    projectId: string,
    artifactIds: readonly string[],
    metadataAuthority?: (projectId: string, artifact: ArtifactDto) => boolean,
  ): import("@ponderosa/core").CommunicationAttachmentDto[] {
    return artifactIds.map((artifactIdValue) => {
      const artifact = this.getProjectArtifact(projectId, artifactIdValue);
      const readable = artifact && this.operatorCanReadProjectArtifact(projectId, artifactIdValue);
      let contentMetadataMatches = false;
      if (readable && artifact.size !== undefined && artifact.size > 0 && artifact.sha256 && artifact.mediaType) {
        try {
          const metadata = lstatSync(managedArtifactContentPath(this.dataDir, projectId, artifactIdValue));
          contentMetadataMatches = metadata.isFile() && metadata.nlink === 1 && metadata.size === artifact.size;
        } catch {
          contentMetadataMatches = false;
        }
      }
      const authoritativeMetadata = Boolean(
        artifact && (!metadataAuthority || metadataAuthority(projectId, artifact)),
      );
      const available = Boolean(readable && contentMetadataMatches && authoritativeMetadata);
      if (!artifact || !readable || !available) {
        return {
          id: artifactIdValue,
          agentId: artifact?.originAgentId ?? artifact?.agentId ?? "unavailable",
          name: artifact?.summary ?? "Artifact unavailable",
          mediaType: artifact?.mediaType ?? "application/octet-stream",
          size: artifact?.size ?? 0,
          unavailable: true,
        };
      }
      return {
        id: artifact.id,
        agentId: artifact.originAgentId ?? artifact.agentId,
        name: artifact.summary ?? artifact.path.split("/").at(-1) ?? artifact.id,
        mediaType: artifact.mediaType!,
        size: artifact.size!,
        createdAt: artifact.createdAt,
        url: artifact.previewUrl,
        previewUrl: artifact.previewUrl,
        downloadUrl: artifact.downloadUrl,
      };
    });
  }

  getProjectArtifactAccess(
    projectId: string,
    artifactIdValue: string,
  ): ManagedArtifactAccess | undefined {
    const row = this.client.prepare(`
      SELECT owner_kind, owner_id, audience_json, sender_agent_id
      FROM managed_artifact_projection WHERE project_id = ? AND artifact_id = ?
    `).get(projectId, artifactIdValue) as {
      owner_kind: ManagedArtifactAccess["ownerKind"];
      owner_id: string;
      audience_json: string;
      sender_agent_id: string | null;
    } | undefined;
    if (!row) return undefined;
    try {
      return {
        ownerKind: row.owner_kind,
        ownerId: row.owner_id,
        audience: JSON.parse(row.audience_json) as ManagedArtifactAccess["audience"],
        ...(row.sender_agent_id ? { senderAgentId: row.sender_agent_id } : {}),
      };
    } catch {
      return undefined;
    }
  }

  isWorkingFileTransportPart(projectId:string,artifactIdValue:string):boolean {
    const row=this.client.prepare("SELECT json_extract(artifact_json,'$.transportPart.schema') AS schema FROM managed_artifact_projection WHERE project_id=? AND artifact_id=?").get(projectId,artifactIdValue) as {schema?:string}|undefined;
    return row?.schema==='ponderosa.working-file-part-owner.v1';
  }

  projectArtifactIsOrganizationVisible(projectId: string, artifactIdValue: string): boolean {
    if(this.isWorkingFileTransportPart(projectId,artifactIdValue))return false;
    return this.getProjectArtifactAccess(projectId, artifactIdValue)?.audience.kind
      === "organization";
  }

  projectArtifactBelongsToConversation(projectId: string, artifactIdValue: string, conversationId: string): boolean {
    if(this.isWorkingFileTransportPart(projectId,artifactIdValue))return false;
    const artifact = this.getProjectArtifact(projectId, artifactIdValue);
    const originId = artifact?.originAgentId ?? artifact?.agentId;
    if (artifact?.origin?.kind === "operator") return artifact.origin.conversationId === conversationId && this.operatorCanReadProjectArtifact(projectId, artifactIdValue);
    if (!artifact || !originId) return false;
    // Canonical memberships/current custody or retained deletion attribution;
    // never infer from a profile namespace, rendered panel or last-use value.
    return Boolean(this.client.prepare(`SELECT 1 FROM agents WHERE id=? AND project_id=? AND conversation_id=?
      UNION ALL SELECT 1 FROM agent_conversation_memberships WHERE agent_id=? AND conversation_id=?
      UNION ALL SELECT 1 FROM agent_deletion_tombstones WHERE agent_id=? AND project_id=? AND conversation_id=? LIMIT 1`)
      .get(originId, projectId, conversationId, originId, conversationId, originId, projectId, conversationId));
  }

  operatorCanReadProjectArtifact(projectId: string, artifactIdValue: string): boolean {
    if(this.isWorkingFileTransportPart(projectId,artifactIdValue))return false;
    // The single local operator owns the Project audit surfaces (including
    // Team Chat), but private artifacts still stay out of the organizational
    // catalog and future-agent context.
    const artifact = this.getProjectArtifact(projectId, artifactIdValue);
    if (artifact?.origin?.kind === "operator") {
      const access = this.getProjectArtifactAccess(projectId, artifactIdValue);
      return Boolean(artifact.agentId === artifact.origin.conversationId && artifact.originAgentId === undefined && artifact.executionId === undefined && artifact.kind === "document" && access?.ownerKind === "operator_chat" && access.ownerId === artifact.origin.conversationId &&
        access.audience.kind === "user" && access.audience.userId === "local-operator" && this.client.prepare(
          `SELECT 1 FROM conversations chat WHERE chat.id=? AND chat.project_id=? AND chat.branch_execution_id IS NULL AND ${activeChatOwnerSql('chat')}`,
        ).get(artifact.origin.conversationId, projectId));
    }
    return Boolean(this.projectExists(projectId) && this.getProjectArtifactAccess(projectId, artifactIdValue));
  }

  agentCanReadProjectArtifact(
    projectId: string,
    artifactIdValue: string,
    agentId: string,
  ): boolean {
    if(this.isWorkingFileTransportPart(projectId,artifactIdValue))return false;
    const agent = this.agentById(agentId);
    const access = this.getProjectArtifactAccess(projectId, artifactIdValue);
    if (!agent || agent.projectId !== projectId || !access) return false;
    const artifact = this.getProjectArtifact(projectId, artifactIdValue);
    if (artifact?.origin?.kind === "operator") return false;
    const originId = artifact?.originAgentId ?? artifact?.agentId;
    const origin = originId ? this.agentById(originId) : undefined;
    let ownerChat = origin?.conversationId;
    if (!ownerChat && access.ownerKind === "communication") {
      ownerChat = readRepairableJsonl<CommunicationEvent>(
        communicationEventsPath(this.dataDir, projectId), "communication log", true,
      ).find(event => event.eventId === access.ownerId)?.conversationId;
    }
    if (!ownerChat || ownerChat !== agent.conversationId) return false;
    if (access.audience.kind === "organization") return true;
    if (access.senderAgentId === agentId) return true;
    if (
      access.audience.kind === "agents"
      || access.audience.kind === "user_agents"
      || access.audience.kind === "request_agents"
    ) return access.audience.agentIds.includes(agentId);
    return access.audience.kind === "user_agent" && access.audience.agentId === agentId;
  }

  getProjectContextArtifacts(projectId: string, limit = 100, conversationId?: string): ArtifactDto[] {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const rows = this.client.prepare(`
      SELECT artifact_json FROM managed_artifact_projection
      WHERE project_id = ? AND json_extract(artifact_json, '$.transportPart') IS NULL
        AND json_extract(audience_json, '$.kind') = 'organization'
        AND (pinned = 1 OR visibility = 'published')
        AND (? IS NULL OR json_extract(artifact_json, '$.originAgentId') IN
          (SELECT id FROM agents WHERE conversation_id = ?))
      ORDER BY created_at DESC, artifact_id DESC LIMIT ?
    `).all(projectId, conversationId ?? null, conversationId ?? null, boundedLimit) as Array<{ artifact_json: string }>;
    return rows.map((row) =>
      this.withProjectUrls(
        projectId,
        JSON.parse(row.artifact_json) as ManagedProjectArtifact,
      ));
  }

  recordOperatorChatArtifact(artifact: ArtifactDto & {projectId: string; origin: {kind: "operator"; conversationId: string}}): void {
    if (artifact.agentId !== artifact.origin.conversationId || artifact.originAgentId !== undefined || artifact.executionId !== undefined || artifact.kind !== "document" || artifact.visibility !== "project" || artifact.pinned) throw new Error("Operator documents require exact Chat storage ownership without Agent/Run attribution");
    this.assertOperatorChat(artifact.projectId, artifact.origin.conversationId);
    this.progress.run([managedArtifactsLogPath(this.dataDir, artifact.projectId)], () => this.writeProjectArtifacts([{artifact,
      access: {ownerKind: "operator_chat", ownerId: artifact.origin.conversationId, audience: {kind: "user", userId: "local-operator"}}}]));
  }

  purgeOperatorChatArtifacts(projectId: string, conversationId: string): void {
    if (!this.client.prepare("SELECT 1 FROM conversation_deletion_receipts WHERE conversation_id=? AND project_id=? AND canonical_deletion_completed=1").get(conversationId, projectId)) throw new Error("Operator artifact cleanup requires the exact committed Chat deletion receipt");
    const artifacts = this.getProjectArtifacts(projectId).filter(artifact => artifact.origin?.kind === "operator" && artifact.origin.conversationId === conversationId);
    for (const artifact of artifacts) {
      if (existsSync(managedArtifactContentPath(this.dataDir, projectId, artifact.id)) && !removeManagedArtifactContent(this.dataDir, projectId, artifact.id, artifact.size!, artifact.sha256!)) throw new Error("Operator Chat artifact cleanup remains pending");
      this.deleteProjectArtifact(projectId, artifact.id, "operator_chat_deleted");
    }
  }

  private assertOperatorChat(projectId: string, conversationId: string): void {
    if (!this.client.prepare(`SELECT 1 FROM conversations chat WHERE chat.id=? AND chat.project_id=? AND chat.branch_execution_id IS NULL AND ${activeChatOwnerSql('chat')}`).get(conversationId, projectId)) throw new Error("Operator artifact destination Chat is unavailable");
  }

  recordProjectArtifact(
    artifact: ArtifactDto & { projectId: string; originAgentId: string },
    access: ManagedArtifactAccess = {
      ownerKind: "project",
      ownerId: artifact.id,
      audience: { kind: "organization", organizationId: artifact.projectId },
    },
  ): void {
    this.recordProjectArtifacts([{ artifact, access }]);
  }

  recordProjectArtifacts(
    entries: ReadonlyArray<{
      artifact: ArtifactDto & { projectId: string; originAgentId: string };
      access?: ManagedArtifactAccess;
      transportPart?:WorkingFileTransportPart;
    }>,
  ): void {
    if (entries.length === 0) return;
    this.progress.run([managedArtifactsLogPath(this.dataDir, entries[0]!.artifact.projectId)],
      () => this.writeProjectArtifacts(entries));
  }

  private writeProjectArtifacts(entries: ReadonlyArray<{
    artifact: ManagedProjectArtifact;
    access?: ManagedArtifactAccess;
    transportPart?:WorkingFileTransportPart;
  }>): void {
    const projectId = entries[0]!.artifact.projectId;
    if (!this.projectExists(projectId)) throw new Error("artifact project not found");
    const ids = new Set<string>();
    const events: ManagedArtifactEvent[] = [];
    // Host association must cover the complete logical original in this
    // publication batch. Never hide an unrelated user artifact based on MIME.
    const transportGroups=new Map<string,{count:number;size:number;indices:Set<number>}>();
    for(const entry of entries){
      const part=entry.transportPart;if(!part)continue;
      if(!validWorkingFileTransportPart(part,entry.artifact.id)||!entry.artifact.originAgentId||!Number.isSafeInteger(entry.artifact.size)||entry.artifact.size!<1)
        throw Error('Invalid host working-file transport part');
      const key=JSON.stringify([part.operationId,entry.artifact.originAgentId,part.filePath,part.fileByteLength,part.fileSha256,part.partCount]);
      const group=transportGroups.get(key)??{count:part.partCount,size:0,indices:new Set<number>()};
      if(group.indices.has(part.partIndex))throw Error('Duplicate working-file transport part');
      group.indices.add(part.partIndex);group.size+=entry.artifact.size!;
      if(!Number.isSafeInteger(group.size)||group.size>part.fileByteLength)throw Error('Working-file transport size differs');
      transportGroups.set(key,group);
    }
    for(const [key,group] of transportGroups){
      const [,,,size]=JSON.parse(key) as [string,string,string,number,string,number];
      if(group.indices.size!==group.count||group.size!==size)throw Error('Incomplete working-file transport association');
    }
    for (const entry of entries) {
      if(Object.hasOwn(entry.artifact,'transportPart')||entry.transportPart&&!validWorkingFileTransportPart(entry.transportPart,entry.artifact.id))throw Error('Invalid host working-file transport part');
      const artifact:ManagedProjectArtifact=entry.transportPart?{...entry.artifact,transportPart:entry.transportPart}:entry.artifact;
      const access = entry.access ?? {
        ownerKind: "project" as const,
        ownerId: artifact.id,
        audience: {
          kind: "organization" as const,
          organizationId: artifact.projectId,
        },
      };
      if (
        artifact.projectId !== projectId
        || ids.has(artifact.id)
        || !artifact.summary?.trim()
        || !artifact.mediaType?.trim()
        || artifact.size === undefined
        || !Number.isSafeInteger(artifact.size)
        || artifact.size < 1
        || !/^[a-f0-9]{64}$/u.test(artifact.sha256 ?? "")
        || (artifact.origin?.kind === "operator"
          ? artifact.agentId !== artifact.origin.conversationId || artifact.originAgentId !== undefined || artifact.executionId !== undefined || artifact.kind !== "document" || access.ownerKind !== "operator_chat" || access.ownerId !== artifact.origin.conversationId || access.audience.kind !== "user" || access.audience.userId !== "local-operator"
          : !artifact.originAgentId?.trim() || access.ownerKind === "operator_chat")
      ) {
        throw new Error("managed artifact immutable metadata is required");
      }
      if (artifact.origin?.kind === "operator") this.assertOperatorChat(projectId, artifact.origin.conversationId);
      ids.add(artifact.id);
      const existing = this.getProjectArtifact(projectId, artifact.id);
      if (existing) {
        const immutableFields = [
          "id",
          "projectId",
          "agentId",
          "originAgentId",
          "executionId",
          "kind",
          "path",
          "summary",
          "createdAt",
          "mediaType",
          "sourcePath",
          "size",
          "sha256",
        ] as const;
        const existingAccess = this.getProjectArtifactAccess(
          projectId,
          artifact.id,
        );
        if (
          immutableFields.every((field) =>
            existing[field] === artifact[field]
          )
          && JSON.stringify(existing.origin) === JSON.stringify(artifact.origin)
          && JSON.stringify((existing as ManagedProjectArtifact).transportPart) === JSON.stringify(artifact.transportPart)
          && JSON.stringify(existingAccess) === JSON.stringify(access)
        ) continue;
        throw new Error("managed artifact identity and provenance are immutable");
      }
      events.push({
        type: "created",
        artifact,
        access,
      } satisfies ManagedArtifactEvent);
    }
    appendFsyncedJsonl(managedArtifactsLogPath(this.dataDir, projectId), events);
    this.client.transaction(() => {
      for (const event of events) {
        this.projectManagedArtifactEvent(projectId, event);
      }
    })();
  }

  deleteProjectArtifact(
    projectId: string,
    artifactIdValue: string,
    reason: string,
  ): boolean {
    if (!this.getProjectArtifact(projectId, artifactIdValue)) return false;
    const event = {
      type: "deleted",
      artifactId: artifactIdValue,
      at: new Date().toISOString(),
      reason: reason.slice(0, 240),
    } satisfies ManagedArtifactEvent;
    appendFsyncedJsonl(managedArtifactsLogPath(this.dataDir, projectId), [event]);
    this.projectManagedArtifactEvent(projectId, event);
    return true;
  }

  updateProjectArtifactVisibility(
    projectId: string,
    artifactIdValue: string,
    visibility: "project" | "published",
    pinned: boolean,
  ): ArtifactDto | undefined {
    if (!this.getProjectArtifact(projectId, artifactIdValue)) return undefined;
    const event = {
      type: "visibility",
      artifactId: artifactIdValue,
      visibility,
      pinned,
      at: new Date().toISOString(),
    } satisfies ManagedArtifactEvent;
    appendFsyncedJsonl(managedArtifactsLogPath(this.dataDir, projectId), [event]);
    this.projectManagedArtifactEvent(projectId, event);
    return this.getProjectArtifact(projectId, artifactIdValue);
  }

  getGeneratedArtifact(
    agentId: string,
    artifactIdValue: string,
  ): Extract<LogEvent, { type: "generated_artifact" }> | undefined {
    const stored = this.readAgentEvents(agentId).find((candidate) =>
      candidate.event.type === "generated_artifact"
      && candidate.event.artifactId === artifactIdValue);
    return stored?.event.type === "generated_artifact" ? stored.event : undefined;
  }

  getArtifact(agentId: string, artifactIdValue: string): ArtifactDto | undefined {
    const row = this.client.prepare(`
      SELECT id, agent_id, execution_id, kind, path, summary, created_at,
        source_path, media_type, visibility, pinned, size
      FROM artifacts WHERE agent_id = ? AND id = ?
    `).get(agentId, artifactIdValue) as ArtifactProjectionReadRow | undefined;
    return row ? this.artifactDtoFromProjectionRow(agentId, row) : undefined;
  }

  private projectManagedArtifactEvent(
    projectId: string,
    event: ManagedArtifactEvent,
  ): void {
    if (event.type === "created") {
      const access = event.access ?? {
        ownerKind: "project" as const,
        ownerId: event.artifact.id,
        audience: { kind: "organization" as const, organizationId: projectId },
      };
      const prior = this.client.prepare(`
        SELECT artifact_json, owner_kind, owner_id, audience_json, sender_agent_id
        FROM managed_artifact_projection WHERE project_id = ? AND artifact_id = ?
      `).get(projectId, event.artifact.id) as {
        artifact_json: string;
        owner_kind: string;
        owner_id: string;
        audience_json: string;
        sender_agent_id: string | null;
      } | undefined;
      if (prior) {
        if (
          prior.artifact_json === JSON.stringify(event.artifact)
          && prior.owner_kind === access.ownerKind
          && prior.owner_id === access.ownerId
          && prior.audience_json === JSON.stringify(access.audience)
          && prior.sender_agent_id === (access.senderAgentId ?? null)
        ) return;
        throw new Error("managed artifact identity, provenance, and audience are immutable");
      }
      this.client.prepare(`
        INSERT INTO managed_artifact_projection(
          project_id, artifact_id, created_at, visibility, pinned, artifact_json,
          owner_kind, owner_id, audience_json, sender_agent_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        projectId,
        event.artifact.id,
        event.artifact.createdAt,
        event.artifact.visibility ?? "project",
        event.artifact.pinned ? 1 : 0,
        JSON.stringify(event.artifact),
        access.ownerKind,
        access.ownerId,
        JSON.stringify(access.audience),
        access.senderAgentId ?? null,
      );
      return;
    }
    if (event.type === "deleted") {
      this.client.prepare(`
        DELETE FROM managed_artifact_projection WHERE project_id = ? AND artifact_id = ?
      `).run(projectId, event.artifactId);
      return;
    }
    const row = this.client.prepare(`
      SELECT artifact_json FROM managed_artifact_projection
      WHERE project_id = ? AND artifact_id = ?
    `).get(projectId, event.artifactId) as { artifact_json: string } | undefined;
    if (!row) {
      return;
    }
    const artifact = JSON.parse(row.artifact_json) as ManagedProjectArtifact;
    this.client.prepare(`
      UPDATE managed_artifact_projection SET visibility = ?, pinned = ?, artifact_json = ?
      WHERE project_id = ? AND artifact_id = ?
    `).run(
      event.visibility,
      event.pinned ? 1 : 0,
      JSON.stringify({ ...artifact, visibility: event.visibility, pinned: event.pinned }),
      projectId,
      event.artifactId,
    );
  }

  private withProjectUrls(projectId: string, artifact: ArtifactDto): ArtifactDto {
    const root = `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifact.id)}`;
    return { ...artifact, previewUrl: `${root}/preview`, downloadUrl: `${root}/download` };
  }
}
