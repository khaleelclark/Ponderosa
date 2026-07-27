import type Database from "better-sqlite3";
import type {
  ArtifactDto,
  ArtifactKind,
  HistoryPageDto,
} from "@ponderosa/core";
import { appendFsyncedJsonl, readRepairableJsonl } from "./append-jsonl.js";
import { artifactId } from "./ids.js";
import type { LogEvent, StoredLogEvent } from "./log-event.js";
import { managedArtifactsLogPath } from "./paths.js";
import type {
  ArtifactProjectionReadRow,
  ManagedArtifactAccess,
  ManagedArtifactEvent,
} from "./store-types.js";

type CursorBoundary = { orderKey: string; rowKey: string };
type CursorInput = CursorBoundary & { stream: string; scope: string };
type ArtifactAgent = { projectId: string; archived?: boolean };

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
        path: row.source_path,
        summary: row.source_path,
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
      summary: row.summary ?? undefined,
      createdAt: row.created_at,
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

  rebuildProjectProjection(projectId: string): void {
    for (const event of readRepairableJsonl<ManagedArtifactEvent>(
      managedArtifactsLogPath(this.dataDir, projectId),
      `managed artifacts for project ${projectId}`,
    )) {
      this.projectManagedArtifactEvent(projectId, event);
    }
  }

  /** Bounded Project-wide file/result catalog. SQLite applies the boundary to
   * Agent execution artifacts; the usually-small authored catalog is merged by
   * the same stable key before the response page is formed. */
  getProjectArtifactPage(
    projectId: string,
    input: { limit: number; cursor?: string },
  ): HistoryPageDto<ArtifactDto> {
    const limit = Math.max(1, Math.min(input.limit, 500));
    const boundary = input.cursor
      ? this.decodeHistoryCursor(input.cursor, "project:artifacts", projectId)
      : undefined;
    const rows = this.client.prepare(`
      SELECT artifact.id, artifact.agent_id, artifact.execution_id, artifact.kind, artifact.path,
        artifact.summary, artifact.created_at, artifact.source_path, artifact.media_type,
        artifact.visibility, artifact.pinned, artifact.size
      FROM artifacts artifact
      JOIN agents agent ON agent.id = artifact.agent_id
      WHERE agent.project_id = ?
        ${boundary ? "AND (artifact.created_at < ? OR (artifact.created_at = ? AND artifact.id < ?))" : ""}
      ORDER BY artifact.created_at DESC, artifact.id DESC LIMIT ?
    `).all(...(
      boundary
        ? [projectId, boundary.orderKey, boundary.orderKey, boundary.rowKey, limit + 1]
        : [projectId, limit + 1]
    )) as ArtifactProjectionReadRow[];
    const executionArtifacts = rows.flatMap((row) => {
      const artifact = this.artifactDtoFromProjectionRow(row.agent_id, row);
      return artifact ? [{ ...artifact, projectId }] : [];
    });
    const managedRows = this.client.prepare(`
      SELECT artifact_json FROM managed_artifact_projection
      WHERE project_id = ? AND json_extract(audience_json, '$.kind') = 'organization'
        ${boundary ? "AND (created_at < ? OR (created_at = ? AND artifact_id < ?))" : ""}
      ORDER BY created_at DESC, artifact_id DESC LIMIT ?
    `).all(...(
      boundary
        ? [projectId, boundary.orderKey, boundary.orderKey, boundary.rowKey, limit + 1]
        : [projectId, limit + 1]
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
              scope: projectId,
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
    if (access.audience.kind === "organization") return true;
    if (access.senderAgentId === agentId) return true;
    if (
      access.audience.kind === "agents"
      || access.audience.kind === "user_agents"
      || access.audience.kind === "request_agents"
    ) return access.audience.agentIds.includes(agentId);
    return access.audience.kind === "user_agent" && access.audience.agentId === agentId;
  }

  getProjectContextArtifacts(projectId: string, limit = 100): ArtifactDto[] {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const rows = this.client.prepare(`
      SELECT artifact_json FROM managed_artifact_projection
      WHERE project_id = ? AND json_extract(audience_json, '$.kind') = 'organization'
        AND (pinned = 1 OR visibility = 'published')
      ORDER BY created_at DESC, artifact_id DESC LIMIT ?
    `).all(projectId, boundedLimit) as Array<{ artifact_json: string }>;
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
    if (!this.projectExists(artifact.projectId)) throw new Error("artifact project not found");
    if (
      !artifact.summary?.trim()
      || !artifact.mediaType?.trim()
      || artifact.size === undefined
      || !Number.isSafeInteger(artifact.size)
      || artifact.size < 1
      || !/^[a-f0-9]{64}$/u.test(artifact.sha256 ?? "")
      || !artifact.originAgentId.trim()
    ) {
      throw new Error("managed artifact immutable metadata is required");
    }
    const existing = this.getProjectArtifact(artifact.projectId, artifact.id);
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
      const existingAccess = this.getProjectArtifactAccess(artifact.projectId, artifact.id);
      if (
        immutableFields.every((field) => existing[field] === artifact[field])
        && JSON.stringify(existingAccess) === JSON.stringify(access)
      ) return;
      throw new Error("managed artifact identity and provenance are immutable");
    }
    const event = { type: "created", artifact, access } satisfies ManagedArtifactEvent;
    appendFsyncedJsonl(managedArtifactsLogPath(this.dataDir, artifact.projectId), [event]);
    this.projectManagedArtifactEvent(artifact.projectId, event);
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

  getGeneratedPdfPath(agentId: string, artifactIdValue: string): string | undefined {
    const stored = this.readAgentEvents(agentId).find((candidate) =>
      artifactId(agentId, candidate.seq, 0) === artifactIdValue
      && candidate.event.type === "file_change"
      && candidate.event.path.toLowerCase().endsWith(".pdf"));
    return stored?.event.type === "file_change" ? stored.event.path : undefined;
  }

  getGeneratedArtifact(
    agentId: string,
    artifactIdValue: string,
  ): Extract<LogEvent, { type: "generated_artifact" }> | undefined {
    const stored = this.readAgentEvents(agentId).find((candidate) =>
      candidate.event.type === "generated_artifact"
      && (candidate.event.artifactId ?? artifactId(agentId, candidate.seq, 0))
        === artifactIdValue);
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
    if (!row) return;
    const artifact = JSON.parse(row.artifact_json) as ArtifactDto & {
      projectId: string;
      originAgentId: string;
    };
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
