import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import type {
  ArtifactDto,
  ArtifactKind,
  HistoryPageDto,
  CommunicationEvent,
} from "@ponderosa/core";
import { appendFsyncedJsonl, readRepairableJsonl } from "./append-jsonl.js";
import {
  type AgentDeletionDirectoryIdentity,
  validateAgentDeletionDirectory,
} from "./agent-deletion-identity.js";
import { artifactAgentProductSql, managedArtifactProductSql, userCommunicationArtifactOwners } from "./artifact-product-scope.js";
import type { LogEvent, StoredLogEvent } from "./log-event.js";
import { agentDir, communicationEventsPath, managedArtifactContentPath, managedArtifactsLogPath } from "./paths.js";
import type {
  ArtifactProjectionReadRow,
  ManagedArtifactAccess,
  ManagedArtifactEvent,
} from "./store-types.js";

type CursorBoundary = { orderKey: string; rowKey: string };
type CursorInput = CursorBoundary & { stream: string; scope: string };
type ArtifactAgent = { projectId: string; conversationId?: string; archived?: boolean };

function hasHistoricalCustody(
  dataDir: string,
  client: Database.Database,
  projectId: string,
  agentId: string,
  recoveredAt: string,
  createdAt: string,
  deletedAt: string,
): boolean {
  if (recoveredAt < createdAt || recoveredAt > deletedAt) return false;
  try {
    const marker = client.prepare(`SELECT agent_id, project_id, conversation_id,
      tombstone_name, ownership_token, created_at FROM agent_deletion_tombstones
      WHERE agent_id=? AND project_id=?`).get(agentId, projectId) as {
        agent_id: string;
        project_id: string;
        conversation_id: string | null;
        tombstone_name: string;
        ownership_token: string | null;
        created_at: string;
      } | undefined;
    if (!marker?.ownership_token || !marker.conversation_id) return false;
    const identity: AgentDeletionDirectoryIdentity = {
      agentId: marker.agent_id,
      projectId: marker.project_id,
      conversationId: marker.conversation_id,
      tombstoneName: marker.tombstone_name,
      ownershipToken: marker.ownership_token,
      createdAt: marker.created_at,
    };
    validateAgentDeletionDirectory(agentDir(dataDir, projectId, agentId), identity);
    return Boolean(client.prepare(`SELECT 1 FROM conversations
      WHERE id=? AND project_id=?`).get(identity.conversationId, projectId))
      || Boolean(client.prepare(`SELECT 1 FROM conversation_deletion_receipts
        WHERE conversation_id=? AND project_id=? AND canonical_deletion_completed=1`)
        .get(identity.conversationId, projectId));
  } catch {
    return false;
  }
}

export class AgentArtifactCatalog {
  private readonly pendingLegacyCustody = new Map<string, Extract<ManagedArtifactEvent, { type: "legacy_custody" }>[]>();
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
  ) {}

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
      .map((row) => JSON.parse(row.artifact_json) as ArtifactDto & {
        projectId: string;
        originAgentId: string;
      })
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
    this.pendingLegacyCustody.set(projectId, []);
    for (const event of readRepairableJsonl<ManagedArtifactEvent>(
      managedArtifactsLogPath(this.dataDir, projectId),
      `managed artifacts for project ${projectId}`,
    )) {
      if (!["created", "visibility", "deleted", "legacy_custody"].includes(event.type)) {
        throw new Error(`managed artifact record does not belong to Project ${projectId}`);
      }
      const artifactId = event.type === "created" ? event.artifact.id : event.artifactId;
      if (typeof artifactId !== "string" || !artifactId || artifactId.length > 200 ||
          (event.type === "created" && event.artifact.projectId !== projectId)) {
        throw new Error(`managed artifact record does not belong to Project ${projectId}`);
      }
      if (event.type === "legacy_custody") {
        this.pendingLegacyCustody.get(projectId)!.push(event);
      } else {
        if (event.type === "deleted") this.pendingLegacyCustody.set(projectId,
          this.pendingLegacyCustody.get(projectId)!.filter(item => item.artifactId !== event.artifactId));
        this.projectManagedArtifactEvent(projectId, event);
      }
    }
  }

  rebuildLegacyCustody(projectId: string): void {
    for (const event of this.pendingLegacyCustody.get(projectId) ?? []) this.projectManagedArtifactEvent(projectId, event);
    this.pendingLegacyCustody.delete(projectId);
  }

  /** Bounded Project-wide file/result catalog. SQLite applies the boundary to
   * Agent execution artifacts; the usually-small authored catalog is merged by
   * the same stable key before the response page is formed. */
  getProjectArtifactPage(
    projectId: string,
    input: { limit: number; cursor?: string; conversationId?: string; search?: string; branchOwned?: boolean; scope?: string },
  ): HistoryPageDto<ArtifactDto> {
    const limit = Math.max(1, Math.min(input.limit, 500));
    const conversationId = input.conversationId?.trim() || undefined;
    const search = input.search?.trim().toLocaleLowerCase() ?? "";
    if (search.length > 200) throw new Error("File search must be at most 200 characters");
    const terms = search.split(/\s+/u).filter(Boolean).map(term => `%${term.replace(/[\\%_]/gu, "\\$&")}%`);
    const baseScope = conversationId
      ? `${projectId}:conversation:${conversationId}`
      : projectId;
    const productScope = `${input.scope ?? "all"}:${baseScope}`;
    const cursorScope = search ? `${productScope}:search:${createHash("sha256").update(search).digest("hex")}` : productScope;
    const ownerFilter = input.branchOwned === undefined ? "" : `AND ${artifactAgentProductSql("agent", input.branchOwned ? "branches" : "dev")}`;
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
        ${ownerFilter}
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
    const canonicalEvents = readRepairableJsonl<CommunicationEvent>(
      communicationEventsPath(this.dataDir, projectId), "communication log", true);
    const userDocumentIds = canonicalEvents.filter(event => event.sender.kind === 'user' && event.document)
      .map(event => event.document!.artifactId);
    const userOwners = userCommunicationArtifactOwners(this.client, canonicalEvents, projectId);
    const userIds = [...userOwners].filter(([,owner]) =>
      (input.branchOwned === undefined || owner.product === (input.branchOwned ? 'branches' : 'dev')) &&
      (!conversationId || owner.conversationId === conversationId)).map(([id]) => id);
    const userIdsSql = `(SELECT value FROM json_each('${JSON.stringify(userIds).replace(/'/gu, "''")}'))`;
    const managedRows = this.client.prepare(`
      SELECT artifact_json FROM managed_artifact_projection artifact
      WHERE project_id = ? AND json_extract(audience_json, '$.kind') = 'organization'
        ${input.branchOwned === undefined ? "" : `AND ${managedArtifactProductSql("artifact", input.branchOwned ? "branches" : "dev", userIds, userDocumentIds)}`}
        ${conversationId ? `AND (artifact.artifact_id IN ${userIdsSql} OR EXISTS (
          SELECT 1 FROM agent_conversation_memberships membership
          WHERE membership.agent_id = COALESCE(json_extract(artifact_json, '$.legacyRecovery.custodianAgentId'), json_extract(artifact_json, '$.originAgentId'))
            AND membership.conversation_id = ?
        ) OR EXISTS (
          SELECT 1 FROM agents origin
          WHERE origin.id = COALESCE(json_extract(artifact_json, '$.legacyRecovery.custodianAgentId'), json_extract(artifact_json, '$.originAgentId'))
            AND origin.project_id = artifact.project_id
            AND origin.conversation_id = ?
        ) OR EXISTS (
          SELECT 1 FROM agent_deletion_tombstones tombstone
          WHERE tombstone.agent_id = COALESCE(json_extract(artifact_json, '$.legacyRecovery.custodianAgentId'), json_extract(artifact_json, '$.originAgentId'))
            AND tombstone.project_id = artifact.project_id
            AND tombstone.conversation_id = ?
        ))` : ""}
        ${boundary ? "AND (created_at < ? OR (created_at = ? AND artifact_id < ?))" : ""}
        ${terms.map(() => "AND lower(coalesce(json_extract(artifact_json, '$.sourcePath'), json_extract(artifact_json, '$.path'), '') || ' ' || coalesce(json_extract(artifact_json, '$.summary'), '')) LIKE ? ESCAPE '\\'").join("\n")}
      ORDER BY created_at DESC, artifact_id DESC LIMIT ?
    `).all(...(
      boundary
        ? [projectId, ...(conversationId ? [conversationId, conversationId, conversationId] : []), boundary.orderKey, boundary.orderKey, boundary.rowKey, ...terms, limit + 1]
        : [projectId, ...(conversationId ? [conversationId, conversationId, conversationId] : []), ...terms, limit + 1]
    )) as Array<{ artifact_json: string }>;
    const managed = managedRows.map((row) =>
      this.withProjectUrls(
        projectId,
        JSON.parse(row.artifact_json) as ArtifactDto & {
          projectId: string;
          originAgentId: string;
        },
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
      JSON.parse(row.artifact_json) as ArtifactDto & {
        projectId: string;
        originAgentId: string;
      },
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

  projectArtifactIsOrganizationVisible(projectId: string, artifactIdValue: string): boolean {
    return this.getProjectArtifactAccess(projectId, artifactIdValue)?.audience.kind
      === "organization";
  }

  operatorCanReadProjectArtifact(projectId: string, artifactIdValue: string): boolean {
    // The single local operator owns the Project audit surfaces (including
    // Team Chat), but private artifacts still stay out of the organizational
    // catalog and future-agent context.
    return Boolean(
      this.projectExists(projectId)
      && this.getProjectArtifactAccess(projectId, artifactIdValue),
    );
  }

  agentCanReadProjectArtifact(
    projectId: string,
    artifactIdValue: string,
    agentId: string,
  ): boolean {
    const agent = this.agentById(agentId);
    const access = this.getProjectArtifactAccess(projectId, artifactIdValue);
    if (!agent || agent.projectId !== projectId || agent.archived || !access) return false;
    const artifact = this.getProjectArtifact(projectId, artifactIdValue);
    const originId = artifact?.legacyRecovery?.custodianAgentId ?? artifact?.originAgentId ?? artifact?.agentId;
    const origin = originId ? this.agentById(originId) : undefined;
    let ownerChat = origin?.conversationId;
    const events = readRepairableJsonl<CommunicationEvent>(communicationEventsPath(this.dataDir, projectId), "communication log", true);
    if (originId === "local-operator" || events.some(event => event.sender.kind === 'user' && event.document?.artifactId === artifactIdValue)) {
      ownerChat = userCommunicationArtifactOwners(this.client, events, projectId).get(artifactIdValue)?.conversationId;
    } else if (!ownerChat && access.ownerKind === "communication") {
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
    const events = readRepairableJsonl<CommunicationEvent>(communicationEventsPath(this.dataDir, projectId), "communication log", true);
    const userDocumentIds = events.filter(event => event.sender.kind === 'user' && event.document).map(event => event.document!.artifactId);
    const userIds = [...userCommunicationArtifactOwners(this.client, events, projectId)]
      .filter(([,owner]) => !conversationId || owner.conversationId === conversationId).map(([id]) => id);
    const rows = this.client.prepare(`
      SELECT artifact_json FROM managed_artifact_projection
      WHERE project_id = ? AND json_extract(audience_json, '$.kind') = 'organization'
        AND (json_extract(artifact_json, '$.originAgentId') != 'local-operator'
          AND artifact_id NOT IN (SELECT value FROM json_each('${JSON.stringify(userDocumentIds).replace(/'/gu, "''")}'))
          OR artifact_id IN (SELECT value FROM json_each('${JSON.stringify(userIds).replace(/'/gu, "''")}')))
        AND (pinned = 1 OR visibility = 'published')
        AND (? IS NULL OR artifact_id IN (SELECT value FROM json_each('${JSON.stringify(userIds).replace(/'/gu, "''")}'))
          OR COALESCE(json_extract(artifact_json, '$.legacyRecovery.custodianAgentId'), json_extract(artifact_json, '$.originAgentId')) IN
          (SELECT id FROM agents WHERE conversation_id = ?))
      ORDER BY created_at DESC, artifact_id DESC LIMIT ?
    `).all(projectId, conversationId ?? null, conversationId ?? null, boundedLimit) as Array<{ artifact_json: string }>;
    return rows.map((row) =>
      this.withProjectUrls(
        projectId,
        JSON.parse(row.artifact_json) as ArtifactDto & {
          projectId: string;
          originAgentId: string;
        },
      ));
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
    }>,
  ): void {
    if (entries.length === 0) return;
    const projectId = entries[0]!.artifact.projectId;
    if (!this.projectExists(projectId)) throw new Error("artifact project not found");
    const ids = new Set<string>();
    const events: ManagedArtifactEvent[] = [];
    for (const entry of entries) {
      const { artifact } = entry;
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
        || artifact.legacyRecovery !== undefined
        || ids.has(artifact.id)
        || !artifact.summary?.trim()
        || !artifact.mediaType?.trim()
        || artifact.size === undefined
        || !Number.isSafeInteger(artifact.size)
        || artifact.size < 1
        || !/^[a-f0-9]{64}$/u.test(artifact.sha256 ?? "")
        || !artifact.originAgentId.trim()
      ) {
        throw new Error("managed artifact immutable metadata is required");
      }
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
      if (event.artifact.legacyRecovery !== undefined) throw new Error("Legacy custody requires a separate recovery record");
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
      if (event.type === "legacy_custody") throw new Error("Legacy custody refers to a missing artifact");
      return;
    }
    const artifact = JSON.parse(row.artifact_json) as ArtifactDto & {
      projectId: string;
      originAgentId: string;
    };
    if (event.type === "legacy_custody") {
      const origin = this.client.prepare("SELECT conversation_id, deleted_at FROM agents WHERE id=? AND project_id=?")
        .get(event.originAgentId, projectId) as { conversation_id: string | null; deleted_at: string | null } | undefined;
      const custodian = this.client.prepare(`SELECT id, conversation_id, created_at, deleted_at
        FROM agents WHERE id=? AND project_id=?`)
        .get(event.custodianAgentId, projectId) as {
          id: string;
          conversation_id: string | null;
          created_at: string;
          deleted_at: string | null;
        } | undefined;
      const liveCustodian = custodian?.deleted_at === null
        && Boolean(custodian.conversation_id)
        && Boolean(this.client.prepare(`SELECT 1 FROM conversations
          WHERE id=? AND project_id=?`).get(custodian.conversation_id, projectId));
      // Legacy custody is historical provenance, not permanent Agent authority.
      // A Chat deletion may remove its archived custodian after recovery. Its
      // exact canonical deletion marker proves the former Chat binding; reads by
      // Agents still fail closed because the custodian no longer has a live Chat.
      const deletedCustodian = Boolean(custodian?.deleted_at)
        && hasHistoricalCustody(
          this.dataDir,
          this.client,
          projectId,
          event.custodianAgentId,
          event.at,
          custodian!.created_at,
          custodian!.deleted_at!,
        );
      const recovery = { custodianAgentId: event.custodianAgentId, recoveredAt: event.at };
      if (!origin?.deleted_at || origin.conversation_id || (!liveCustodian && !deletedCustodian)
        || artifact.originAgentId !== event.originAgentId || artifact.sha256 !== event.sha256
        || !Number.isFinite(Date.parse(event.at))
        || (artifact.legacyRecovery && JSON.stringify(artifact.legacyRecovery) !== JSON.stringify(recovery))) {
        throw new Error("Invalid legacy artifact custody assignment");
      }
      this.client.prepare("UPDATE managed_artifact_projection SET artifact_json=? WHERE project_id=? AND artifact_id=?")
        .run(JSON.stringify({ ...artifact, legacyRecovery: recovery }), projectId, event.artifactId);
      return;
    }
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
