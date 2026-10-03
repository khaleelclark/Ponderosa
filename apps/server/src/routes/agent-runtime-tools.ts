import { createHash } from "node:crypto";
import path from "node:path";
import type { AgentStore, CoordinationV3Store, StoredLogEvent, WorkspaceStore } from "@ponderosa/agents";
import {
  CompactionHistoryQueryError,
  normalizeCompactionHistoryQuery,
  publishManagedArtifactContentAsync,
} from "@ponderosa/agents";
import { PONDEROSA_HISTORY_TOOL, PONDEROSA_IMPORT_FILE_TOOL } from "@ponderosa/core";
import type { FastifyInstance } from "fastify";
import {
  browserUploadEligibility,
  BrowserSessionError,
  type BrowserSessionManager,
  type BrowserScope,
} from "../browser-session-manager.js";
import { BrowserDriverActionError } from "../chrome-cdp-driver.js";
import type { BrowserProfileAuthority } from "../browser-profile-authority.js";
import type {
  ActiveRun,
  AgentMessageCapability,
} from "../app-contracts.js";
import type { AssetStore, GeneratedArtifactImportReceipt } from "../assets.js";
import { legacyPublicationDecision, FilePublicationError, publicationOwnerIsCurrent, readPublicationSource } from "../file-publication.js";

interface AgentRuntimeToolRoutesContext {
  // Kept for existing route callers; roots no longer gate host-file publication.
  allowedImportRoots?: string[];
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  agentMessageCapabilities: ReadonlyMap<string, AgentMessageCapability>;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  browserSessions: BrowserSessionManager;
  projectBrowserSessions: BrowserSessionManager;
  browserProfiles: BrowserProfileAuthority;
  workspace: WorkspaceStore;
  publishWorkspaceSince(cursor: number): void;
  projectBrowserGrants: Map<string, { agentId: string; runId: string }>;
  deletingProjectIds: ReadonlySet<string>;
  deletingAgentIds: ReadonlySet<string>;
  deletingConversationIds: ReadonlySet<string>;
  dataDir: string;
  assets: AssetStore;
  publish(agentId: string, stored: StoredLogEvent): void;
  projectBrowserScope(projectId: string, grant?: { agentId: string; runId: string }): BrowserScope;
  capabilityOwnsAuthoritativeRun(
    capability: AgentMessageCapability,
    run: ActiveRun | undefined,
  ): boolean;
}

function browserDriverSessionError(error: BrowserDriverActionError): BrowserSessionError {
  switch (error.reason) {
    case "page_not_found":
      return new BrowserSessionError(
        "The active browser page is no longer available. Open or activate a page and retry.",
        404,
        error.reason,
      );
    case "last_page":
      return new BrowserSessionError("The last browser page cannot be closed.", 409, error.reason);
    case "invalid_selector":
      return new BrowserSessionError("The browser selector is invalid.", 400, error.reason);
    case "selector_not_found":
      return new BrowserSessionError("The browser could not find that page element.", 404, error.reason);
    case "selector_ambiguous":
      return new BrowserSessionError("The selector matched multiple elements. Inspect and use a unique selector.", 409, error.reason);
    case "selector_not_interactable":
      return new BrowserSessionError("The selected element is covered or not currently interactable. Inspect before retrying.", 409, error.reason);
    case "click_unconfirmed":
      return new BrowserSessionError("The click could not be confirmed and may have taken effect. Inspect before any retry.", 409, error.reason);
    case "fill_unconfirmed":
      return new BrowserSessionError("The field input could not be confirmed and may have partially changed the field. Inspect before retrying.", 409, error.reason);
    case "selector_not_editable":
      return new BrowserSessionError("The selected page element cannot be edited.", 409, error.reason);
    case "upload_disabled":
      return new BrowserSessionError("Browser file uploads are unavailable for this session.", 503, error.reason);
    case "selector_not_file_input":
      return new BrowserSessionError("The selected page element is not a file input.", 409, error.reason);
    case "file_input_disabled":
      return new BrowserSessionError("The selected file input is disabled.", 409, error.reason);
    case "file_type_not_accepted":
      return new BrowserSessionError("The selected file input does not accept this file type.", 415, error.reason);
    case "no_pending_file_chooser":
      return new BrowserSessionError("No browser file chooser is waiting for a file.", 409, error.reason);
    case "stale_file_chooser":
      return new BrowserSessionError("The browser file chooser expired. Open it again and retry.", 409, error.reason);
    case "unsupported_file_chooser":
      return new BrowserSessionError("This browser file chooser is not supported.", 409, error.reason);
    case "stale_upload_context":
      return new BrowserSessionError("The browser page changed before the file could be attached. Retry on the current page.", 409, error.reason);
    case "upload_verification_failed":
      return new BrowserSessionError("The browser could not verify that the file was attached.", 409, error.reason);
  }
}
function importedArtifactMediaType(file: string): string {
  const extension = path.extname(file).toLowerCase();
  return ({
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".jar": "application/java-archive",
    ".md": "text/plain", ".txt": "text/plain", ".csv": "text/plain", ".log": "text/plain",
    ".json": "application/json", ".html": "text/html", ".zip": "application/zip",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}
function stableImportArtifactId(projectId: string, runId: string, toolCallId: string): string {
  return `import_${createHash("sha256")
    .update(projectId).update("\0").update(runId).update("\0").update(toolCallId)
    .digest("hex").slice(0, 48)}`;
}


export function registerAgentRuntimeToolRoutes(
  app: FastifyInstance,
  context: AgentRuntimeToolRoutesContext,
): void {
  const {
    store,
    coordinationV3,
    agentMessageCapabilities,
    activeRuns,
    browserSessions,
    projectBrowserSessions,
    browserProfiles,
    workspace,
    publishWorkspaceSince,
    projectBrowserGrants,
    deletingProjectIds,
    deletingAgentIds,
    projectBrowserScope,
    capabilityOwnsAuthoritativeRun,
    dataDir,
    assets,
    publish,
  } = context;
  // Keep the browser selected by a Run even after a shared control grant is revoked.
  const savedBrowserUsedByRun = new WeakSet<ActiveRun>();
  const projectImportReceipt = (receipt: GeneratedArtifactImportReceipt) => {
    const artifact = receipt.artifact;
    const project = store.getProject(artifact.projectId);
    const agent = store.getAgent(artifact.agentId);
    if (!project || !agent || !assets.generatedArtifactImportIsAvailable(receipt)) {
      assets.quarantineGeneratedArtifactImport(receipt);
      return undefined;
    }
    const catalogArtifact = {
      ...artifact,
      visibility: "project" as const,
      pinned: false,
    };
    const existing = store.readEvents(agent.id).find((stored) =>
      stored.event.type === "generated_artifact" &&
      stored.event.artifactId === artifact.id
    );
    let captured: StoredLogEvent | undefined;
    if (!existing) {
      captured = store.appendEvent(agent.id, {
        type: "generated_artifact",
        artifactId: artifact.id,
        executionId: artifact.executionId ?? receipt.runId,
        path: artifact.path,
        sourcePath: artifact.sourcePath ?? artifact.path,
        name: artifact.summary,
        mediaType: artifact.mediaType,
        size: artifact.size,
        sha256: artifact.sha256,
        visibility: "project",
      }, artifact.createdAt);
    }
    store.recordProjectArtifact(catalogArtifact);
    assets.markGeneratedArtifactImportProjected(receipt);
    if (captured) publish(agent.id, captured);
    return catalogArtifact;
  };

  for (const receipt of assets.pendingGeneratedArtifactImports()) {
    projectImportReceipt(receipt);
  }


  app.post<{
    Body: {
      action?: unknown;
      x?: unknown;
      y?: unknown;
      delta_x?: unknown;
      delta_y?: unknown;
      query?: unknown;
      communicationEventId?: unknown;
      limit?: unknown;
      before?: unknown;
      after?: unknown;
    };
  }>("/api/agent-history", async (request, reply) => {
    const startedAt = performance.now();
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    const agent = capability ? store.getAgent(capability.agentId) : undefined;
    if (!capability || !active || !agent || !capabilityOwnsAuthoritativeRun(capability, active) ||
        active.messageCapability !== token || !capability.historyRetrievalBoundary ||
        !capability.availableToolNames.includes(PONDEROSA_HISTORY_TOOL.name)) {
      return reply.code(401).send({ error: "history capability is not authorized for an active compacted run" });
    }
    const historyBoundary = capability.historyRetrievalBoundary;
    const requestedAction = request.body?.action;
    const action = requestedAction === "read" ? "read" as const : "search" as const;
    const rawQuery = typeof request.body?.query === "string" ? request.body.query : "";
    const rawCommunicationEventId = typeof request.body?.communicationEventId === "string"
      ? request.body.communicationEventId : "";
    const rawLimit = request.body?.limit;
    const rawBefore = request.body?.before;
    const rawAfter = request.body?.after;
    const strategy = "lexical" as const;
    const appendAudit = (input: {
      normalizedQuery?: string;
      outcome: "results" | "no_match" | "rejected";
      reason?: string;
      eligibleMessages?: number;
      matchedMessages?: number;
      selected?: Array<{
        communicationEventId: string;
        contentSha256: string;
        matchBasis?: "lexical";
      }>;
      excludedCurrentContextEventIds?: string[];
      responseUtf8Bytes?: number;
      hasMore?: boolean;
    }) => store.appendEvent(agent.id, {
      type: "compaction_history_retrieval",
      executionId: active.executionId,
      runId: active.runId,
      action,
      ...(action === "search" ? { query: rawQuery.trim().slice(0, 200), strategy } : {
        communicationEventId: rawCommunicationEventId.trim().slice(0, 200),
      }),
      ...(input.normalizedQuery ? { normalizedQuery: input.normalizedQuery } : {}),
      querySha256: createHash("sha256").update(
        action === "search" ? rawQuery.trim() : `read:${rawCommunicationEventId.trim()}`,
      ).digest("hex"),
      ...(action === "search" ? { strategy } : {}),
      compactionCutoffOrdinal: historyBoundary.canonicalOrdinal,
      outcome: input.outcome,
      ...(input.reason ? { reason: input.reason } : {}),
      scannedMessages: input.eligibleMessages ?? 0,
      eligibleMessages: input.eligibleMessages ?? 0,
      matchedMessages: input.matchedMessages ?? 0,
      selected: input.selected ?? [],
      excludedCurrentContextEventIds: input.excludedCurrentContextEventIds ?? [],
      responseUtf8Bytes: input.responseUtf8Bytes ?? 0,
      hasMore: input.hasMore ?? false,
      durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
    });
    try {
      const allowedKeys = new Set(["action", "query", "communicationEventId", "limit", "before", "after"]);
      if (request.body && Object.keys(request.body).some((key) => !allowedKeys.has(key))) {
        throw new CompactionHistoryQueryError("history request contains an unsupported field");
      }
      if (requestedAction !== "search" && requestedAction !== "read") {
        throw new CompactionHistoryQueryError("action must be search or read");
      }
      const common = {
        agentId: agent.id,
        ...(capability.conversationId ? { currentConversationId: capability.conversationId } : {}),
        boundary: historyBoundary,
        excludedCommunicationEventIds: new Set(
          capability.historyRetrievalExcludedCommunicationEventIds,
        ),
      };
      if (action === "read") {
        if (rawBefore !== undefined && (!Number.isSafeInteger(rawBefore) || Number(rawBefore) < 0 || Number(rawBefore) > 2) ||
            rawAfter !== undefined && (!Number.isSafeInteger(rawAfter) || Number(rawAfter) < 0 || Number(rawAfter) > 2)) {
          throw new CompactionHistoryQueryError("before and after must be integers from 0 to 2");
        }
        const { response, audit } = store.readCompactionHistory({
          ...common,
          communicationEventId: rawCommunicationEventId,
          ...(rawBefore !== undefined ? { before: Number(rawBefore) } : {}),
          ...(rawAfter !== undefined ? { after: Number(rawAfter) } : {}),
        });
        appendAudit({
          outcome: "results",
          eligibleMessages: audit.eligibleMessages,
          matchedMessages: response.messages.length,
          selected: audit.selected,
          excludedCurrentContextEventIds: audit.excludedRecentTailEventIds,
          responseUtf8Bytes: response.utf8Bytes,
        });
        return response;
      }
      const normalized = normalizeCompactionHistoryQuery(rawQuery);
      if (rawLimit !== undefined && (!Number.isSafeInteger(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 8)) {
        throw new CompactionHistoryQueryError("limit must be an integer from 1 to 8");
      }
      const { response, audit } = store.searchCompactionHistory({
        ...common,
        query: rawQuery,
        ...(rawLimit !== undefined ? { limit: Number(rawLimit) } : {}),
      });
      appendAudit({
        normalizedQuery: normalized.normalizedQuery,
        outcome: response.noMatch ? "no_match" : "results",
        eligibleMessages: response.eligibleMessages,
        matchedMessages: response.hits.length,
        selected: audit.selected,
        excludedCurrentContextEventIds: audit.excludedRecentTailEventIds,
        responseUtf8Bytes: response.utf8Bytes,
        hasMore: response.hasMore,
      });
      return response;
    } catch (error) {
      if (!(error instanceof CompactionHistoryQueryError)) throw error;
      let normalizedQuery: string | undefined;
      if (action === "search") {
        try { normalizedQuery = normalizeCompactionHistoryQuery(rawQuery).normalizedQuery; } catch { /* rejected */ }
      }
      appendAudit({ normalizedQuery, outcome: "rejected", reason: error.message });
      return reply.code(400).send({ error: error.message });
    }
  });

  app.post<{
    Body: { path?: unknown; toolCallId?: unknown };
  }>("/api/agent-import-file", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    const agent = capability ? store.getAgent(capability.agentId) : undefined;
    if (!capability || !active || !agent ||
        !capabilityOwnsAuthoritativeRun(capability, active) ||
        active.messageCapability !== token ||
        !capability.availableToolNames.includes(PONDEROSA_IMPORT_FILE_TOOL.name)) {
      return reply.code(401).send({
        error: "file import capability is not authorized for an active run",
      });
    }
    const requestedPath = typeof request.body?.path === "string"
      ? request.body.path.trim()
      : "";
    const toolCallId = typeof request.body?.toolCallId === "string"
      ? request.body.toolCallId.trim()
      : "";
    if (!requestedPath || requestedPath.length > 4096 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(requestedPath)) {
      return reply.code(400).send({
        error: "path must be a non-empty filesystem path of at most 4096 characters",
      });
    }
    if (!toolCallId || toolCallId.length > 256 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(toolCallId)) {
      return reply.code(400).send({
        error: "toolCallId must identify the provider tool call",
      });
    }
    const project = store.getChatContext(agent.conversationId);
    if (!project) {
      return reply.code(404).send({ error: "run Project is unavailable" });
    }
    const workingRoot = active.workingCopy.rootPath;
    const absoluteSourcePath = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(workingRoot, requestedPath);
    const authorityIsCurrent = () => {
      const current = activeRuns.get(agent.id);
      const owner = store.getAgent(agent.id);
      const chat = store.getConversation(agent.conversationId);
      return current === active && !active.controller.signal.aborted &&
        capabilityOwnsAuthoritativeRun(capability, current) && current.messageCapability === token &&
        owner?.projectId === agent.projectId && owner.conversationId === agent.conversationId && !owner.archived &&
        Boolean(chat && !chat.archived) &&
        !context.deletingAgentIds?.has(agent.id) && !context.deletingProjectIds?.has(agent.projectId) &&
        !context.deletingConversationIds?.has(agent.conversationId);
    };
    if (!authorityIsCurrent()) return reply.code(409).send({ code: "publication_cancelled", error: "Run authority ended before file import." });
    let publication: ReturnType<typeof legacyPublicationDecision>;
    try {
      publication = legacyPublicationDecision({
        workspace, store, coordinationV3, agentId: agent.id, projectId: agent.projectId,
        conversationId: agent.conversationId, runId: active.runId, coordinationRunId: capability.runId,
        sourcePath: absoluteSourcePath, authorityIsCurrent,
      });
    } catch (error) {
      if (error instanceof FilePublicationError) return reply.code(error.statusCode).send({
        error: error.message, code: error.code, ...(error.decisionId ? { decisionId: error.decisionId } : {}),
      });
      return reply.code(503).send({ code: "publication_storage_failure", error: "Existing publication state could not be read. Nothing was published. Retry this import request." });
    }
    const receiptRunId = publication?.runId ?? active.runId;
    const receiptToolCallId = publication ? `publication:${publication.approvalScope.operationId}` : toolCallId;
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ path: absoluteSourcePath, ...(publication ? { operationId: publication.approvalScope.operationId, sha256: publication.approvalScope.sha256 } : {}) }))
      .digest("hex");
    const artifactResponse = (
      catalogArtifact: ReturnType<typeof projectImportReceipt>,
      body: Buffer,
    ) => {
      if (!catalogArtifact) throw new Error("file import projection is unavailable");
      const eligibility = browserUploadEligibility(catalogArtifact, body);
      const artifactRoot = `/api/projects/${encodeURIComponent(agent.projectId)}/artifacts/${encodeURIComponent(catalogArtifact.id)}`;
      return {
        artifact: {
          id: catalogArtifact.id,
          name: catalogArtifact.summary,
          mediaType: catalogArtifact.mediaType,
          size: catalogArtifact.size,
          sha256: catalogArtifact.sha256,
          previewUrl: `${artifactRoot}/preview`,
          downloadUrl: `${artifactRoot}/download`,
        },
        browserUpload: eligibility,
        ...(eligibility.eligible ? {
          next: { browserUpload: { artifact_id: catalogArtifact.id } },
        } : {}),
      };
    };
    const prior = assets.generatedArtifactImportReceipt(
      agent.projectId, receiptRunId, receiptToolCallId,
    );
    if (prior) {
      if (!authorityIsCurrent()) return reply.code(409).send({ code: "publication_cancelled", error: "Run authority ended before receipt recovery." });
      if (prior.requestHash !== requestHash) {
        return reply.code(409).send({
          error: "tool call was already used for a different file import",
        });
      }
      const catalogArtifact = projectImportReceipt(prior);
      if (!catalogArtifact) {
        return reply.code(409).send({ error: "file import could not be recovered" });
      }
      const resolved = assets.authoritativeGeneratedArtifact(agent.projectId, catalogArtifact);
      if (!resolved) {
        return reply.code(409).send({ error: "imported file content is unavailable" });
      }
      return artifactResponse(catalogArtifact, resolved.body);
    }
    const publicationIsCurrent = () => !publication ||
      workspace.getDecision(publication.id)?.status === "resolved" &&
      workspace.getDecision(publication.id)?.response?.optionId === "approve" &&
      Date.parse(publication.approvalScope.expiresAt) > Date.now() && publicationOwnerIsCurrent(store, publication);
    let source: Awaited<ReturnType<typeof readPublicationSource>>;
    try {
      source = await readPublicationSource(absoluteSourcePath, active.controller.signal);
    } catch (error) {
      if (error instanceof FilePublicationError) return reply.code(error.statusCode).send({ code: error.code, error: error.message });
      return reply.code(400).send({ code: "publication_unsafe_file", error: "The source file could not be read safely." });
    }
    if (publication && (source.body.length !== publication.approvalScope.size ||
        createHash("sha256").update(source.body).digest("hex") !== publication.approvalScope.sha256)) {
      return reply.code(409).send({ code: "publication_file_changed", error: "The source bytes differ from the approved file. Nothing was published." });
    }
    if (!authorityIsCurrent() || !publicationIsCurrent()) {
      return reply.code(409).send({ code: "publication_cancelled", error: "Run or publication authority ended before file import." });
    }
    const artifactId = stableImportArtifactId(agent.projectId, receiptRunId, receiptToolCallId);
    const extension = path.extname(source.name).toLowerCase();
    const name = publication?.approvalScope.filename ?? (source.name
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "_")
      .trim() || `imported-${artifactId}${extension}`);
    const mediaType = importedArtifactMediaType(name);
    const managedPath = `imported/${artifactId}${extension}`;
    try {
      const publishedArtifact = await publishManagedArtifactContentAsync(
        dataDir, agent.projectId, artifactId, source.body, active.controller.signal,
      );
      if (!authorityIsCurrent() || !publicationIsCurrent()) {
        return reply.code(409).send({ code: "publication_cancelled", error: "Run or publication authority ended during file import." });
      }
      const receipt = assets.registerPublishedGeneratedArtifactImport({
        id: artifactId,
        projectId: agent.projectId,
        agentId: agent.id,
        originAgentId: agent.id,
        executionId: active.executionId,
        kind: "generated_file",
        path: managedPath,
        sourcePath: absoluteSourcePath,
        summary: name,
        createdAt: new Date().toISOString(),
        mediaType,
        size: publishedArtifact.size,
        sha256: publishedArtifact.sha256,
      }, publishedArtifact, { runId: receiptRunId, toolCallId: receiptToolCallId, requestHash });
      const catalogArtifact = projectImportReceipt(receipt);
      if (!catalogArtifact) {
        return reply.code(409).send({ code: "publication_storage_failure", error: "File import could not be projected. Retry the same publication." });
      }
      return artifactResponse(catalogArtifact, source.body);
    } catch {
      if (!authorityIsCurrent() || !publicationIsCurrent()) {
        return reply.code(409).send({ code: "publication_cancelled", error: "Run or publication authority ended during file import." });
      }
      return reply.code(503).send({ code: "publication_storage_failure", error: "The file could not be published or its receipt recovered. Retry the same publication; do not copy it elsewhere." });
    }
  });

  app.post<{
    Body: {
      operation?: "open" | "navigate" | "inspect" | "new_page" | "switch_page" | "close_page" | "upload" | "act" | "screenshot" | "take_control" | "close";
      url?: string;
      action?: unknown;
      selector?: unknown;
      text?: unknown;
      key?: unknown;
      page_id?: unknown;
      artifact_id?: unknown;
      consequence?: unknown;
      attempt_id?: unknown;
      browser?: "saved" | "temporary";
    };
  }>("/api/agent-browser", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    const agent = capability ? store.getAgent(capability.agentId) : undefined;
    if (!capability || !active || !agent || !capabilityOwnsAuthoritativeRun(capability, active) || active.messageCapability !== token) {
      return reply.code(401).send({ error: "browser capability is not authorized for an active run" });
    }
    if (deletingProjectIds.has(agent.projectId) || deletingAgentIds.has(agent.id)) {
      return reply.code(409).send({ error: "browser owner deletion is in progress" });
    }
    const requestedBrowser = request.body?.browser;
    if (requestedBrowser !== undefined && (request.body?.operation !== "open" || (requestedBrowser !== "saved" && requestedBrowser !== "temporary"))) {
      return reply.code(400).send({ error: "browser may be saved or temporary when opening a browser" });
    }
    if (requestedBrowser === "saved" && typeof request.body?.url === "string") {
      return reply.code(400).send({ error: "Open the saved browser without a URL, then inspect its tabs before navigating." });
    }
    if (requestedBrowser === "temporary" && ["saved-browser", agent.projectId].some(id => {
      const grant = projectBrowserGrants.get(id);
      return grant?.agentId === agent.id && grant.runId === active.runId;
    })) {
      return reply.code(409).send({ code: "browser_selection_conflict", error: "This Run currently controls a shared browser. Release it before opening a temporary browser; no tabs were closed." });
    }
    try {
      const savedPending = requestedBrowser !== "temporary" && projectBrowserSessions.get(projectBrowserScope("saved-browser").agentId)?.nextRunAgentId === agent.id;
      const ownerProjectId = savedPending ? "saved-browser" : agent.projectId;
      if (requestedBrowser !== "saved" && requestedBrowser !== "temporary" && await projectBrowserSessions.claimNextRun(projectBrowserScope(ownerProjectId), agent.id, active.runId, active.conversationId)) {
        if (activeRuns.get(agent.id) !== active || !capabilityOwnsAuthoritativeRun(capability, active)) {
          const current = projectBrowserSessions.get(projectBrowserScope(ownerProjectId).agentId);
          if (current) await projectBrowserSessions.setControl(projectBrowserScope(ownerProjectId), "operator", current.controlEpoch);
          return reply.code(409).send({ error: "Run ended before browser access could be granted." });
        }
        projectBrowserGrants.set(ownerProjectId, { agentId: agent.id, runId: active.runId });
        if (ownerProjectId === "saved-browser") savedBrowserUsedByRun.add(active);
      }
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Browser authorization changed." }); }
    if (requestedBrowser === "saved") {
      const privateSession = browserSessions.get(agent.id);
      if (privateSession?.status === "ready" || privateSession?.status === "opening") {
        return reply.code(409).send({ code: "browser_selection_conflict", error: "This Agent already has a temporary browser. Close it explicitly before switching to the saved browser; no tabs were closed." });
      }
      const chatGrant = projectBrowserGrants.get(agent.projectId);
      if (chatGrant?.agentId === agent.id && chatGrant.runId === active.runId) {
        return reply.code(409).send({ code: "browser_selection_conflict", error: "This Run currently controls the chat browser. Release it before using the saved browser; no tabs were closed." });
      }
      if (!browserProfiles.hasSavedBrowserAccess(agent.projectId, agent.id)) {
        const saved = browserProfiles.savedBrowser();
        if (!saved) return reply.code(404).send({ code: "saved_browser_unavailable", error: "No saved browser exists. Temporary browsing remains available." });
        const question = `Allow ${agent.title} to use the saved browser for this Project until you revoke access?`;
        const cursor = workspace.cursor();
        const decision = workspace.createDecision({
          idempotencyKey: `saved-browser:${saved.profileId}:${active.runId}:${agent.id}`,
          projectId: agent.projectId,
          ...(active.conversationId ? { conversationId: active.conversationId } : {}),
          agentId: agent.id,
          runId: active.runId,
          coordinationRunId: capability.runId,
          mode: "approval",
          question,
          context: "This browser may contain signed-in accounts. Approval applies only to this Agent within this Project, across Runs and conversations, until you revoke it. Chrome may separately ask to approve its automation connection. Declining does not affect temporary browsing.",
          options: [{ id: "approve", label: "Allow saved browser" }, { id: "do_not_approve", label: "Not now" }],
          allowOther: false,
          blocking: true,
          approvalScope: { kind: "saved_browser", profileId: saved.profileId, projectId: agent.projectId, agentId: agent.id },
        });
        if (decision.approvalScope?.kind !== "saved_browser" || decision.approvalScope.profileId !== saved.profileId ||
            decision.approvalScope.projectId !== agent.projectId || decision.approvalScope.agentId !== agent.id || decision.status !== "pending") {
          return reply.code(409).send({ code: "saved_browser_permission_request_changed", error: "The saved-browser permission request is no longer pending. No access was granted." });
        }
        workspace.createNotification({
          projectId: agent.projectId,
          conversationId: decision.conversationId,
          conversationIds: [agent.conversationId],
          agentId: agent.id,
          agentIds: [agent.id],
          kind: "decision",
          category: "decision",
          severity: "urgent",
          status: "open",
          dedupeKey: `decision:${decision.id}`,
          action: { kind: "open_decision", targetId: decision.id },
          title: `${agent.title} needs saved-browser access`,
          body: question,
          decision: { id: decision.id, mode: decision.mode, options: decision.options, allowOther: decision.allowOther, status: decision.status },
        }, true);
        publishWorkspaceSince(cursor);
        return reply.code(202).send({ code: "saved_browser_permission_pending", decisionId: decision.id, message: "A saved-browser approval is waiting for the operator in Ponderosa. End this Run without asking them to re-lend the browser. After approval resumes you, call ponderosa_browser_open with browser: saved again." });
      }
      const savedScope = projectBrowserScope("saved-browser");
      const current = projectBrowserSessions.get(savedScope.agentId);
      if (!current || current.status !== "ready") {
        return reply.code(409).send({ code: "saved_browser_unavailable", error: "The saved browser is not open. Ask the operator to reopen it; no replacement was started." });
      }
      if (current.manualControl && current.manualControl !== "automation") {
        return reply.code(409).send({ code: "saved_browser_connection_required", error: "The saved browser is under manual control. The operator must connect Chrome for agent access; its tabs were not replaced." });
      }
      const existing = projectBrowserGrants.get("saved-browser");
      if (existing && (existing.agentId !== agent.id || existing.runId !== active.runId)) {
        return reply.code(409).send({ code: "saved_browser_occupied", error: "Another agent currently controls the saved browser. Ask the operator for a handoff or wait until it is released." });
      }
      if (!existing) {
        const grant = { agentId: agent.id, runId: active.runId };
        projectBrowserGrants.set("saved-browser", grant);
        try {
          await projectBrowserSessions.setControl(savedScope, "agent", current.controlEpoch);
          if (projectBrowserGrants.get("saved-browser") !== grant || !browserProfiles.hasSavedBrowserAccess(agent.projectId, agent.id) || activeRuns.get(agent.id) !== active || !capabilityOwnsAuthoritativeRun(capability, active)) {
            const latest = projectBrowserSessions.get(savedScope.agentId);
            if (latest?.status === "ready" && latest.controlOwner === "agent") await projectBrowserSessions.setControl(savedScope, "operator", latest.controlEpoch);
            throw new BrowserSessionError("Saved browser access changed before it could be granted.", 409);
          }
        } catch (error) {
          if (projectBrowserGrants.get("saved-browser") === grant) projectBrowserGrants.delete("saved-browser");
          if (error instanceof BrowserSessionError) return reply.code(error.statusCode).send({ error: error.message, code: error.code });
          return reply.code(409).send({ error: "The saved browser could not hand control to this agent. Its tabs were preserved." });
        }
      }
    }
    const savedGrant = projectBrowserGrants.get("saved-browser");
    if (savedGrant?.agentId === agent.id && savedGrant.runId === active.runId) savedBrowserUsedByRun.add(active);
    if (request.body?.operation !== "open" && savedBrowserUsedByRun.has(active) &&
        (savedGrant?.agentId !== agent.id || savedGrant.runId !== active.runId)) {
      const authorized = browserProfiles.hasSavedBrowserAccess(agent.projectId, agent.id);
      return reply.code(409).send(authorized
        ? { code: "saved_browser_control_changed", error: "The saved browser is no longer assigned to this Run. This action was not applied. Wait for an operator handoff before opening it again." }
        : { code: "saved_browser_access_revoked", error: "Saved browser access was revoked. This action was not applied. Ask the operator to approve access again if needed; temporary browsing remains available." });
    }
    const ownerProjectId = requestedBrowser !== "temporary" && savedGrant?.agentId === agent.id && savedGrant.runId === active.runId ? "saved-browser" : agent.projectId;
    const projectGrant = projectBrowserGrants.get(ownerProjectId);
    const borrowingProjectBrowser = requestedBrowser !== "temporary" && projectGrant?.agentId === agent.id && projectGrant.runId === active.runId;
    const sessionManager = borrowingProjectBrowser ? projectBrowserSessions : browserSessions;
    const scope: BrowserScope = borrowingProjectBrowser
      ? projectBrowserScope(ownerProjectId, projectGrant)
      : {
          projectId: agent.projectId,
          agentId: agent.id,
          runId: active.runId,
          ...(active.conversationId ? { conversationId: active.conversationId } : {}),
        };
    try {
      switch (request.body?.operation) {
        case "open": {
          const session = await sessionManager.open(scope, request.body.url);
          const snapshot = await sessionManager.inspect(scope);
          if (borrowingProjectBrowser && ownerProjectId === "saved-browser") savedBrowserUsedByRun.add(active);
          else savedBrowserUsedByRun.delete(active);
          return { session, snapshot };
        }
        case "navigate": {
          if (typeof request.body.url !== "string") throw new BrowserSessionError("url is required");
          const session = await sessionManager.navigate(scope, request.body.url, "agent");
          return { session, snapshot: await sessionManager.inspect(scope) };
        }
        case "inspect": {
          if (request.body.selector !== undefined && typeof request.body.selector !== "string") {
            throw new BrowserSessionError("selector must be a string");
          }
          const session = sessionManager.get(scope.agentId);
          return {
            session,
            pages: session ? { activePageId: session.activePageId, pages: session.pages } : undefined,
            snapshot: await sessionManager.inspect(scope, request.body.selector as string | undefined),
          };
        }
        case "new_page": {
          const current = sessionManager.get(scope.agentId);
          if (!current) throw new BrowserSessionError("browser session is unavailable", 404);
          const session = await sessionManager.newPage(scope, current.controlEpoch, "agent");
          return { session, pages: { activePageId: session.activePageId, pages: session.pages } };
        }
        case "switch_page": {
          if (typeof request.body.page_id !== "string") throw new BrowserSessionError("page_id is required");
          const current = sessionManager.get(scope.agentId);
          if (!current) throw new BrowserSessionError("browser session is unavailable", 404);
          const session = await sessionManager.activatePage(scope, request.body.page_id, "agent", current.controlEpoch);
          return { session, pages: { activePageId: session.activePageId, pages: session.pages }, snapshot: await sessionManager.inspect(scope) };
        }
        case "close_page": {
          if (typeof request.body.page_id !== "string") throw new BrowserSessionError("page_id is required");
          const current = sessionManager.get(scope.agentId);
          if (!current) throw new BrowserSessionError("browser session is unavailable", 404);
          const session = await sessionManager.closePage(scope, request.body.page_id, "agent", current.controlEpoch);
          return { session, pages: { activePageId: session.activePageId, pages: session.pages }, snapshot: await sessionManager.inspect(scope) };
        }
        case "upload": {
          if (typeof request.body.artifact_id !== "string") throw new BrowserSessionError("artifact_id is required");
          if (request.body.selector !== undefined && typeof request.body.selector !== "string") {
            throw new BrowserSessionError("selector must be a string");
          }
          const current = sessionManager.get(scope.agentId);
          if (!current) throw new BrowserSessionError("browser session is unavailable", 404);
          const response = await sessionManager.upload(
            scope,
            request.body.artifact_id,
            request.body.selector as string | undefined,
            "agent",
            current.controlEpoch,
          );
          return {
            session: response.session,
            upload: response.upload,
            snapshot: await sessionManager.inspect(scope),
            note: "The file was attached to the browser input; the form was not submitted.",
          };
        }
        case "act": {
          const session = await sessionManager.act(scope, request.body);
          return { session, snapshot: await sessionManager.inspect(scope) };
        }
        case "screenshot":
          return { session: sessionManager.get(scope.agentId), artifact: await sessionManager.captureArtifact(scope) };
        case "take_control":
          return { session: await sessionManager.setControl(scope, "agent") };
        case "close": {
          if (borrowingProjectBrowser) {
            const session = sessionManager.get(scope.agentId);
            if (!session) throw new BrowserSessionError("project browser session is unavailable", 404);
            const released = await sessionManager.setControl(scope, "operator", session.controlEpoch).catch((error: unknown) => {
              if (error instanceof BrowserSessionError) throw error;
              throw new BrowserSessionError("Browser handoff did not finish. Its tabs and Agent grant were preserved; retry or ask the operator to take control.", 409, "browser_handoff_incomplete");
            });
            if (projectBrowserGrants.get(ownerProjectId) === projectGrant) projectBrowserGrants.delete(ownerProjectId);
            return { session: released };
          }
          return { session: await sessionManager.close(scope, "agent_closed") };
        }
        default:
          return reply.code(400).send({ error: "unknown browser operation" });
      }
    } catch (error) {
      if (error instanceof BrowserSessionError) return reply.code(error.statusCode).send({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      if (error instanceof BrowserDriverActionError) {
        const mapped = browserDriverSessionError(error);
        return reply.code(mapped.statusCode).send({ error: mapped.message });
      }
      if (error instanceof Error && /native manual control|manual mode|awaiting Chrome connection approval/i.test(error.message)) {
        return reply.code(409).send({ code: "browser_connection_required", error: "The browser is under manual control or awaiting Chrome approval. The operator must connect Chrome before Agent actions; no tabs were replaced." });
      }
      if (error instanceof Error && /Browser service did not respond/i.test(error.message)) {
        return reply.code(504).send({ code: "browser_service_timeout", error: "The browser service did not respond. No replacement was opened; check the existing browser before retrying." });
      }
      if (error instanceof Error && /Target page, context or browser has been closed/i.test(error.message)) {
        return reply.code(409).send({ code: "browser_page_changed", error: "The browser tab closed during the action. Inspect the current tabs before retrying; no action was repeated." });
      }
      throw error;
    }
  });
}
