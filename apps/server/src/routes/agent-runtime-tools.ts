import { createHash } from "node:crypto";
import path from "node:path";
import type { AgentStore, StoredLogEvent } from "@ponderosa/agents";
import {
  CompactionHistoryQueryError,
  MANAGED_ARTIFACT_MAX_BYTES,
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
import type {
  ActiveRun,
  AgentMessageCapability,
} from "../app-contracts.js";
import type { AssetStore, GeneratedArtifactImportReceipt } from "../assets.js";
import { readWorkspaceArtifactFileAsync } from "../project-file-access.js";

interface AgentRuntimeToolRoutesContext {
  allowedImportRoots?: string[];
  store: AgentStore;
  agentMessageCapabilities: ReadonlyMap<string, AgentMessageCapability>;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  browserSessions: BrowserSessionManager;
  projectBrowserSessions: BrowserSessionManager;
  projectBrowserGrants: Map<string, { agentId: string; runId: string }>;
  deletingProjectIds: ReadonlySet<string>;
  deletingAgentIds: ReadonlySet<string>;
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
function containsPath(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative !== "" && !path.isAbsolute(relative) &&
    relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function importRootFor(
  projectRoot: string,
  allowedRoots: readonly string[],
  candidatePath: string,
): string | undefined {
  return [projectRoot, ...allowedRoots]
    .map((root) => path.resolve(root))
    .filter((root, index, roots) => roots.indexOf(root) === index)
    .sort((left, right) => right.length - left.length)
    .find((root) => containsPath(root, candidatePath));
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
    agentMessageCapabilities,
    activeRuns,
    browserSessions,
    projectBrowserSessions,
    projectBrowserGrants,
    deletingProjectIds,
    deletingAgentIds,
    allowedImportRoots = [],
    projectBrowserScope,
    capabilityOwnsAuthoritativeRun,
    dataDir,
    assets,
    publish,
  } = context;
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
    const project = store.getProject(agent.projectId);
    if (!project) {
      return reply.code(404).send({ error: "run Project is unavailable" });
    }
    const absoluteSourcePath = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(project.hostPath, requestedPath);
    const importRoot = importRootFor(project.hostPath, allowedImportRoots, absoluteSourcePath);
    if (!importRoot) {
      return reply.code(403).send({
        error: "host file is outside the Project workspace and configured import roots",
      });
    }
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ path: absoluteSourcePath }))
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
      agent.projectId, active.runId, toolCallId,
    );
    if (prior) {
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
    const authorityIsCurrent = () => {
      const current = activeRuns.get(agent.id);
      return current === active &&
        !active.controller.signal.aborted &&
        capabilityOwnsAuthoritativeRun(capability, current) &&
        current.messageCapability === token;
    };
    const source = await readWorkspaceArtifactFileAsync({
      rootPath: importRoot,
      requestedPath: absoluteSourcePath,
      purpose: "host_import",
      maxBytes: MANAGED_ARTIFACT_MAX_BYTES,
      requireNonEmpty: true,
      signal: active.controller.signal,
    });
    if (!source) {
      return reply.code(400).send({
        error: "host file is unavailable, unsafe, empty, changing, or larger than 64 MiB",
      });
    }
    if (!authorityIsCurrent()) {
      return reply.code(409).send({ error: "run authority ended before file import" });
    }
    const artifactId = stableImportArtifactId(agent.projectId, active.runId, toolCallId);
    const extension = path.extname(source.name).toLowerCase();
    const name = source.name
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "_")
      .trim() || `imported-${artifactId}${extension}`;
    const mediaType = importedArtifactMediaType(name);
    const managedPath = `imported/${artifactId}${extension}`;
    const publishedArtifact = await publishManagedArtifactContentAsync(
      dataDir,
      agent.projectId,
      artifactId,
      source.body,
      active.controller.signal,
    );
    if (!authorityIsCurrent()) {
      return reply.code(409).send({ error: "run authority ended during file import" });
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
    }, publishedArtifact, {
      runId: active.runId,
      toolCallId,
      requestHash,
    });
    const catalogArtifact = projectImportReceipt(receipt);
    if (!catalogArtifact) {
      return reply.code(409).send({ error: "file import could not be projected" });
    }
    return artifactResponse(catalogArtifact, source.body);
  });

  app.post<{
    Body: {
      operation?: "open" | "navigate" | "inspect" | "switch_page" | "close_page" | "upload" | "act" | "screenshot" | "take_control" | "close";
      url?: string;
      action?: unknown;
      selector?: unknown;
      text?: unknown;
      key?: unknown;
      page_id?: unknown;
      artifact_id?: unknown;
      consequence?: unknown;
      attempt_id?: unknown;
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
    const projectGrant = projectBrowserGrants.get(agent.projectId);
    const borrowingProjectBrowser = projectGrant?.agentId === agent.id && projectGrant.runId === active.runId;
    const sessionManager = borrowingProjectBrowser ? projectBrowserSessions : browserSessions;
    const scope: BrowserScope = borrowingProjectBrowser
      ? projectBrowserScope(agent.projectId, projectGrant)
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
          return { session, snapshot: await sessionManager.inspect(scope) };
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
            projectBrowserGrants.delete(agent.projectId);
            return { session: await sessionManager.setControl(scope, "operator", session.controlEpoch) };
          }
          return { session: await sessionManager.close(scope, "agent_closed") };
        }
        default:
          return reply.code(400).send({ error: "unknown browser operation" });
      }
    } catch (error) {
      if (error instanceof BrowserSessionError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof BrowserDriverActionError) {
        const mapped = browserDriverSessionError(error);
        return reply.code(mapped.statusCode).send({ error: mapped.message });
      }
      throw error;
    }
  });
}
