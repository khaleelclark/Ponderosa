import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
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

/** Observation only. The returned bytes never enter storage before approval. */
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
    agent?.projectId === scope.projectId && agent.conversationId === scope.conversationId && !agent.archived &&
    chat?.projectId === scope.projectId && !chat.archived && Boolean(store.getProject(scope.projectId));
}

export async function externalPublicationDecision(input: {
  workspace: WorkspaceStore; store: AgentStore; coordinationV3: CoordinationV3Store;
  agentId: string; projectId: string; conversationId: string;
  runId: string; coordinationRunId: string; sourcePath: string; signal: AbortSignal;
  authorityIsCurrent(): boolean; publishWorkspaceSince(cursor: number): void;
}): Promise<DecisionDto & { approvalScope: PublicationScope }> {
  const { workspace, store, coordinationV3 } = input;
  const candidates = workspace.listDecisions({ agentId: input.agentId }).filter(decision =>
    decision.approvalScope?.kind === "artifact_publication" &&
    decision.approvalScope.sourcePath === input.sourcePath &&
    decision.approvalScope.projectId === input.projectId &&
    decision.approvalScope.conversationId === input.conversationId);
  let decision = candidates.find(decision => decision.runId === input.runId ||
    coordinationV3.decisionResponseAttachedToRun(decision.id, input.coordinationRunId, input.agentId));
  decision ??= candidates.find(decision => decision.status === "pending");
  if (!decision) {
    const source = await readPublicationSource(input.sourcePath, input.signal);
    if (!input.authorityIsCurrent()) throw new FilePublicationError(409, "publication_cancelled", "Run authority ended. Nothing was published.");
    const filename = source.name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "_").trim();
    if (!filename) throw new FilePublicationError(400, "publication_unsafe_file", "The file requires a readable download filename.");
    const scope: PublicationScope = {
      kind: "artifact_publication", operationId: randomUUID(), projectId: input.projectId,
      conversationId: input.conversationId, agentId: input.agentId, sourcePath: input.sourcePath,
      filename, size: source.body.length, sha256: createHash("sha256").update(source.body).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
    const chat = store.getConversation(input.conversationId)!;
    const agent = store.getAgent(input.agentId)!;
    const visiblePath = JSON.stringify(scope.sourcePath).replace(/[\u202a-\u202e\u2066-\u2069]/gu,
      char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
    const cursor = workspace.cursor();
    const continuationRequestIds = coordinationV3.outboundAwaitingQuestionRequestIdsAttachedToRun(input.coordinationRunId, input.agentId);
    decision = workspace.createDecision({
      idempotencyKey: `file-publication:${input.runId}:${createHash("sha256").update(input.sourcePath).digest("hex")}`,
      projectId: input.projectId, conversationId: input.conversationId, agentId: input.agentId,
      runId: input.runId, coordinationRunId: input.coordinationRunId,
      mode: "approval", question: `Publish ${filename} from ${agent.title} in ${chat.title}?`,
      context: `Source: ${visiblePath}\nDownload filename: ${filename}\nSize: ${scope.size} bytes\nSHA-256: ${scope.sha256}\nApproval copies only these exact bytes into managed downloadable storage. It does not authorize other files, a directory, or general filesystem access. This request expires in one hour.`,
      options: [{ id: "approve", label: "Publish this file" }, { id: "do_not_approve", label: "Not now" }],
      allowOther: false, blocking: true, approvalScope: scope,
      ...(continuationRequestIds.length ? { continuationRequestIds } : {}),
    });
    if (continuationRequestIds.length) coordinationV3.suspendQuestionsForDecision({
      runId: input.coordinationRunId, agentId: input.agentId, decisionId: decision.id, requestIds: continuationRequestIds,
    });
    workspace.createNotification({
      projectId: input.projectId, conversationId: input.conversationId, conversationIds: [input.conversationId],
      agentId: input.agentId, agentIds: [input.agentId], kind: "decision", category: "decision", severity: "urgent", status: "open",
      dedupeKey: `decision:${decision.id}`, action: { kind: "open_decision", targetId: decision.id },
      title: `${agent.title} requests file publication`, body: decision.question,
      decision: { id: decision.id, mode: decision.mode, options: decision.options, allowOther: false, status: decision.status },
    }, true);
    input.publishWorkspaceSince(cursor);
  }
  const scope = decision.approvalScope;
  if (scope?.kind !== "artifact_publication" || !publicationOwnerIsCurrent(store, decision) ||
      !input.authorityIsCurrent()) throw new FilePublicationError(409, "publication_cancelled", "The publication owner or Run authority changed. Nothing was published.");
  if (!Number.isFinite(Date.parse(scope.expiresAt)) || Date.parse(scope.expiresAt) <= Date.now()) {
    throw new FilePublicationError(410, "publication_expired", "This single-file approval expired. Nothing was published.", decision.id);
  }
  if (decision.status === "cancelled") throw new FilePublicationError(409, "publication_cancelled", "Publication was cancelled. Nothing was published.", decision.id);
  if (decision.status === "pending") throw new FilePublicationError(403, "outside_import_roots",
    "This source is outside the workspace and server-wide import roots. A single-file publication Decision is pending. End this Run without copying the file into the workspace. After approval resumes you, retry ponderosa_import_file with the same exact path.", decision.id);
  if (decision.response?.optionId !== "approve") throw new FilePublicationError(403, "publication_denied", "Publication was not approved. Nothing was published.", decision.id);
  // A pending Decision from another Run is discoverable, but never grants it authority.
  if (decision.runId !== input.runId && !coordinationV3.decisionResponseAttachedToRun(decision.id, input.coordinationRunId, input.agentId)) {
    throw new FilePublicationError(403, "publication_wrong_run", "This Run is not the authorized Decision continuation.", decision.id);
  }
  return decision as DecisionDto & { approvalScope: PublicationScope };
}
