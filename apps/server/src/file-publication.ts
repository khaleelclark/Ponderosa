import { lstat, realpath } from "@ponderosa/native-host/fs/promises";
import path from "node:path";
import type { AgentStore, CoordinationV3Store, WorkspaceStore } from "@ponderosa/agents";
import { MANAGED_ARTIFACT_MAX_BYTES } from "@ponderosa/agents";
import type { DecisionDto } from "@ponderosa/core";
import { readWorkspaceArtifactFileAsync, type SafeProjectFile } from "./project-file-access.js";

export type PublicationScope = Extract<NonNullable<DecisionDto["approvalScope"]>, { kind: "artifact_publication" }>;

export class FilePublicationError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly decisionId?: string) {
    super(message);
  }
}

/** Secure capture only. The caller must revalidate current Run authority before publication. */
export async function readPublicationSource(sourcePath: string, signal: AbortSignal): Promise<SafeProjectFile> {
  const root = path.dirname(sourcePath);
  try {
    const info = await lstat(sourcePath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
        path.relative(root, await realpath(root)) !== "") {
      throw new FilePublicationError(400, "publication_unsafe_file", "Publication requires one regular file without symbolic paths.");
    }
    if (info.size > MANAGED_ARTIFACT_MAX_BYTES) {
      throw new FilePublicationError(413, "publication_too_large", "The file exceeds the existing 64 MiB publication limit.");
    }
    if (info.size === 0) throw new FilePublicationError(400, "publication_empty_file", "The file is empty.");
    const source = await readWorkspaceArtifactFileAsync({
      rootPath: root, requestedPath: sourcePath, purpose: "host_import",
      maxBytes: MANAGED_ARTIFACT_MAX_BYTES, requireNonEmpty: true, signal,
    });
    if (!source || path.relative(root, await realpath(root)) !== "") {
      throw new FilePublicationError(409, "publication_file_changed", "The file changed or could not be read safely. Nothing was published.");
    }
    return source;
  } catch (error) {
    if (error instanceof FilePublicationError) throw error;
    if (signal.aborted) throw new FilePublicationError(409, "publication_cancelled", "Run authority ended. Nothing was published.");
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FilePublicationError(404, "publication_file_missing", "The source file is missing. Nothing was published.");
    }
    throw new FilePublicationError(400, "publication_unsafe_file", "The source file is unavailable or cannot be read safely.");
  }
}

export function publicationOwnerIsCurrent(store: AgentStore, decision: DecisionDto): boolean {
  const scope = decision.approvalScope;
  if (scope?.kind !== "artifact_publication") return false;
  if (!/^[a-f0-9-]{36}$/u.test(scope.operationId) || !/^[a-f0-9]{64}$/u.test(scope.sha256) ||
      !Number.isSafeInteger(scope.size) || scope.size < 1 || scope.size > MANAGED_ARTIFACT_MAX_BYTES ||
      typeof scope.sourcePath !== "string" || scope.sourcePath.length > 4096 || !path.isAbsolute(scope.sourcePath) ||
      typeof scope.filename !== "string" || !scope.filename || !Number.isFinite(Date.parse(scope.expiresAt))) return false;
  const agent = store.getAgent(scope.agentId);
  const chat = store.getConversation(scope.conversationId);
  return scope.agentId === decision.agentId && scope.projectId === decision.projectId &&
    scope.conversationId === decision.conversationId &&
    agent?.projectId === scope.projectId && agent.conversationId === scope.conversationId &&
    chat?.projectId === scope.projectId && Boolean(store.getProject(scope.projectId));
}

/** Existing approvals retain their original operation/receipt identity. Never
 * create or approve a Decision for a new trusted-host import. */
export function legacyPublicationDecision(input: {
  workspace: WorkspaceStore; store: AgentStore; coordinationV3: CoordinationV3Store;
  agentId: string; projectId: string; conversationId: string;
  runId: string; coordinationRunId: string; sourcePath: string;
  authorityIsCurrent(): boolean;
}): (DecisionDto & { approvalScope: PublicationScope }) | undefined {
  const { workspace, store, coordinationV3 } = input;
  const candidates = workspace.listDecisions({ agentId: input.agentId }).filter(decision =>
    decision.approvalScope?.kind === "artifact_publication" &&
    decision.approvalScope.sourcePath === input.sourcePath &&
    decision.approvalScope.projectId === input.projectId &&
    decision.approvalScope.conversationId === input.conversationId);
  const decision = candidates.find(decision => decision.runId === input.runId ||
    coordinationV3.decisionResponseAttachedToRun(decision.id, input.coordinationRunId, input.agentId));
  if (!decision) return undefined;
  const scope = decision.approvalScope;
  if (scope?.kind !== "artifact_publication" || !publicationOwnerIsCurrent(store, decision) ||
      !input.authorityIsCurrent()) throw new FilePublicationError(409, "publication_cancelled", "The publication owner or Run authority changed. Nothing was published.");
  if (!Number.isFinite(Date.parse(scope.expiresAt)) || Date.parse(scope.expiresAt) <= Date.now()) {
    throw new FilePublicationError(410, "publication_expired", "This single-file approval expired. Nothing was published.", decision.id);
  }
  if (decision.status === "cancelled") throw new FilePublicationError(409, "publication_cancelled", "Publication was cancelled. Nothing was published.", decision.id);
  if (decision.status === "pending") throw new FilePublicationError(403, "outside_import_roots",
    "This pre-upgrade publication operation still has a pending Decision. Resolve or cancel that existing Decision; the upgrade does not automatically approve or resume it.", decision.id);
  if (decision.response?.optionId !== "approve") throw new FilePublicationError(403, "publication_denied", "Publication was not approved. Nothing was published.", decision.id);
  // A pending Decision from another Run is discoverable, but never grants it authority.
  if (decision.runId !== input.runId && !coordinationV3.decisionResponseAttachedToRun(decision.id, input.coordinationRunId, input.agentId)) {
    throw new FilePublicationError(403, "publication_wrong_run", "This Run is not the authorized Decision continuation.", decision.id);
  }
  return decision as DecisionDto & { approvalScope: PublicationScope };
}
