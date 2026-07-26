import type Database from "better-sqlite3";
import { stableJson } from "./coordination-v3-canonical-json.js";
import { runtimeArtifactMetadataIsValid } from "./coordination-v3-runtime-validation.js";
import type {
  CoordinationV3StoreOptions,
  RuntimeArtifactInputV3,
} from "./coordination-v3-types.js";

type RuntimeArtifactAuthorityOptions = Pick<CoordinationV3StoreOptions, "artifactAuthority">;

export class CoordinationV3RuntimeArtifactAuthority {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly options: RuntimeArtifactAuthorityOptions,
  ) {}

  resolveRuntimeArtifacts(
    projectId: string,
    artifacts: RuntimeArtifactInputV3[] | undefined,
    ownerLabel: string,
  ): RuntimeArtifactInputV3[] {
    this.requireRuntimeArtifacts(projectId, artifacts, ownerLabel);
    if (!artifacts?.length) return [];
    const authority = this.options.artifactAuthority;
    if (!authority) throw new Error(`${ownerLabel} artifact authority is unavailable`);
    const resolvedById = new Map<string, RuntimeArtifactInputV3>();
    for (const artifact of artifacts) {
      if (resolvedById.has(artifact.id)) {
        throw new Error(`${ownerLabel} artifact metadata or provenance is invalid`);
      }
      const resolved = authority(projectId, artifact);
      if (
        !resolved
        || stableJson(resolved.artifact) !== stableJson(artifact)
        || resolved.contentHash !== artifact.blobHash
        || resolved.byteLength !== artifact.byteLength
        || !resolved.localPath
      ) {
        throw new Error(`${ownerLabel} artifact authority mismatch`);
      }
      resolvedById.set(artifact.id, resolved.artifact);
    }
    return [...resolvedById.values()];
  }

  requireRuntimeArtifacts(
    projectId: string,
    artifacts: RuntimeArtifactInputV3[] | undefined,
    ownerLabel: string,
  ): void {
    if (artifacts === undefined) return;
    const ids = new Set<string>();
    const roles = new Set<string>();
    if (
      !Array.isArray(artifacts)
      || artifacts.length > 2
      || artifacts.some((artifact) => {
        if (
          !this.runtimeArtifactAgreesWithProject(projectId, artifact)
          || ids.has(artifact.id)
          || roles.has(artifact.role)
        ) return true;
        ids.add(artifact.id);
        roles.add(artifact.role);
        return false;
      })
    ) {
      throw new Error(`${ownerLabel} artifact metadata or provenance is invalid`);
    }
  }

  private runtimeArtifactAgreesWithProject(
    projectId: string,
    artifact: unknown,
  ): artifact is RuntimeArtifactInputV3 {
    if (!runtimeArtifactMetadataIsValid(artifact)) return false;
    const originAgentId = artifact.originAgentId;
    const executionId = artifact.executionId;
    if (originAgentId === undefined && executionId === undefined) return true;
    if (
      originAgentId === undefined
      || executionId === undefined
      || !this.sqlite.prepare(`
        SELECT 1 FROM agents WHERE id = ? AND project_id = ? AND archived = 0
      `).get(originAgentId, projectId)
    ) return false;
    const run = this.sqlite.prepare(`
      SELECT agent_id FROM scheduler_runs
      WHERE id = ? AND project_id = ? AND status IN ('leased', 'running')
    `).get(executionId, projectId) as { agent_id: string } | undefined;
    return Boolean(run && run.agent_id === originAgentId);
  }
}
