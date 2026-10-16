import type Database from "better-sqlite3";
import { unifiedDiffLineTotals } from "@ponderosa/core";
import type {
  ArtifactDto,
  ResponseFileActivityDto,
} from "@ponderosa/core";
import { artifactId } from "./ids.js";
import { activityDtoFromProjectionRow } from "./store-activity.js";
import type {
  ActivityProjectionReadRow,
  ArtifactProjectionReadRow,
} from "./store-types.js";

export class AgentFileActivityReadModel {
  constructor(
    private readonly client: Database.Database,
    private readonly artifactSeq: (agentId: string, seq: number) => number,
    private readonly artifactsForAgent: (agentId: string) => ArtifactDto[],
    private readonly artifactFromRow: (
      agentId: string,
      row: ArtifactProjectionReadRow,
    ) => ArtifactDto | undefined,
  ) {}

  byExecution(
    agentId: string,
    status: ResponseFileActivityDto["status"],
    executionFilter?: ReadonlySet<string>,
  ): Map<string, ResponseFileActivityDto[]> {
    const scopedArtifacts = executionFilter
      ? executionFilter.size
        ? (
            this.client
              .prepare(`
                SELECT id, agent_id, execution_id, kind, path, summary, created_at,
                  source_path, media_type, visibility, pinned, size
                FROM artifacts
                WHERE agent_id = ? AND execution_id IN (${[...executionFilter].map(() => "?").join(", ")})
                ORDER BY created_at, id
              `)
              .all(
                agentId,
                ...executionFilter,
              ) as ArtifactProjectionReadRow[]
          ).flatMap(row => {
            const artifact = this.artifactFromRow(agentId, row);
            return artifact ? [artifact] : [];
          })
        : []
      : this.artifactsForAgent(agentId);
    const artifactById = new Map(
      scopedArtifacts.map(artifact => [artifact.id, artifact] as const),
    );
    const generatedByExecutionAndPath = new Map(
      scopedArtifacts.flatMap(artifact =>
        artifact.kind === "generated_file" &&
        artifact.executionId &&
        artifact.sourcePath
          ? [
              [
                `${artifact.executionId}\0${artifact.sourcePath}`,
                artifact,
              ] as const,
            ]
          : [],
      ),
    );
    const byExecution = new Map<
      string,
      Map<string, ResponseFileActivityDto>
    >();
    const activity = executionFilter
      ? executionFilter.size
        ? (
            this.client
              .prepare(`
                SELECT seq, execution_id, event_json, created_at,
                  output_preview_utf8_bytes, output_total_utf8_bytes, output_sha256
                FROM activity_projection
                WHERE agent_id = ? AND event_type = 'file_change'
                  AND execution_id IN (${[...executionFilter].map(() => "?").join(", ")})
                ORDER BY seq
              `)
              .all(
                agentId,
                ...executionFilter,
              ) as ActivityProjectionReadRow[]
          ).map(row => activityDtoFromProjectionRow(agentId, row))
        : []
      : (
          this.client
            .prepare(`
              SELECT seq, execution_id, event_json, created_at,
                output_preview_utf8_bytes, output_total_utf8_bytes, output_sha256
              FROM activity_projection WHERE agent_id = ? ORDER BY seq
            `)
            .all(agentId) as ActivityProjectionReadRow[]
        ).map(row => activityDtoFromProjectionRow(agentId, row));
    for (const item of activity) {
      if (!item.executionId || item.event.type !== "file_change") continue;
      if (executionFilter && !executionFilter.has(item.executionId)) continue;
      const projectedArtifactId = artifactId(agentId, this.artifactSeq(agentId, item.seq), 0);
      const artifact =
        generatedByExecutionAndPath.get(
          `${item.executionId}\0${item.event.path}`,
        ) ?? artifactById.get(projectedArtifactId);
      const totals = unifiedDiffLineTotals(item.event.diff);
      const byPath =
        byExecution.get(item.executionId) ??
        new Map<string, ResponseFileActivityDto>();
      byPath.set(item.event.path, {
        // Canonical authority/deduplication keeps the exact provider value.
        // Ordinary clients must derive presentation from the Project root.
        path: item.event.path,
        kind: item.event.kind,
        status,
        sourceSeq: item.seq,
        executionId: item.executionId,
        ...(artifact
          ? { artifactId: artifact.id, artifactKind: artifact.kind }
          : {}),
        previewable: Boolean(item.event.diff && artifact?.kind === "diff"),
        ...(totals ?? {}),
      });
      byExecution.set(item.executionId, byPath);
    }
    return new Map(
      [...byExecution].map(([executionId, byPath]) => [
        executionId,
        [...byPath.values()].sort((a, b) => a.sourceSeq - b.sourceSeq),
      ]),
    );
  }
}
