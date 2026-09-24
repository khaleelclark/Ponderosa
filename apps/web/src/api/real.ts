import type {
  LocalBrowserConnectionDto,
  LocalBrowserPairingDto,
  BrowserFrameMetadata,
  BrowserViewportSize,
  ActiveMessageDeliveryReceiptsDto,
  ActiveMessageDeliveryReceiptsRequest,
  AgentActivityOutputDto,
  AgentImportOperationDto,
  AssetLimitsDto,
  AgentDeletionPreviewDto,
  AgentDeletionPreviewRequest,
  AgentDetailDto,
  AgentDto,
  AgentExportMode,
  AgentHealthProjectionDto,
  AgentOperationalStatus,
  AgentOrganizationPageDto,
  AgentOrganizationScope,
  AgentPortablePackageDto,
  AgentPresetDto,
  AgentStreamStatusDto,
  AgentTelemetryPageDto,
  AgentTelemetryStream,
  AgentWorkInspectorDto,
  AgentWorkItemDetailsDto,
  AgentWorkItemDto,
  AssetDto,
  ArtifactContentDto,
  ArtifactDto,
  BrowserControlRequest,
  BrowserAgentPreferenceDto,
  BrowserProfileDto,
  BrowserOperatorInputRequest,
  BrowserSessionDto,
  BrowserUploadResponseDto,
  CancelAgentRunRequest,
  CancelAgentRunResponse,
  CancelMessageDeliveryRequest,
  CancelMessageDeliveryResponse,
  CancelQueuedMessageRequest,
  CancelQueuedMessageResponse,
  CollaborationViewDto,
  ChangedFileDetailDto,
  CommitAgentDeletionRequest,
  CommitAgentDeletionResponse,
  CommunicationDocumentContentDto,
  ConversationDetailDto,
  ConversationMessageDto,
  ConversationDraftConflictListDto,
  ConversationDraftDto,
  ConversationDto,
  CopyAgentPackageRequest,
  CreateAgentPresetRequest,
  CreateBrowserProfileRequest,
  CreateAgentRequest,
  CreateCollaborationMessageRequest,
  CreateCollaborationMessageResponse,
  CreateConversationMessageRequest,
  CreateConversationRequest,
  CreateMultiAgentDirectMessageRequest,
  CreateProjectRequest,
  CreateTriggerRequest,
  CreateTriggerResponse,
  RunTriggerResponse,
  DecisionDto,
  DraftAttachmentDto,
  EditQueuedMessageRequest,
  EditQueuedMessageResponse,
  EngineDto,
  EngineModelValidationDto,
  TargetedNextRunReceiptListDto,
  FilesResponse,
  GenerateConversationTitleResponse,
  GlobalChatSearchResponseDto,
  HealthDto,
  AllChatPageDto,
  CreateHostFolderRequest,
  HostFolderCreateDto,
  HistoryPageDto,
  HostFolderBrowseDto,
  ImportAgentPackageRequest,
  ImportAgentPackageResponse,
  LetCurrentRunFinishRequest,
  LetCurrentRunFinishResponse,
  MarkWorkspaceResourceUsedRequest,
  RetryMessageDeliveryRequest,
  RetryMessageDeliveryResponse,
  RetryCoordinationRequestResponse,
  RuntimeElicitationActionDto,
  RunOutputTextDto,
  MultiAgentDirectMessageResponse,
  ProjectBrowserControlRequest,
  ProjectBrowserSessionDto,
  ProjectDto,
  ProjectDeletionPreviewDto,
  ProjectDeletionResponseDto,
  ProjectSort,
  ProjectEngineModelCatalogDto,
  ProjectEngineCapabilitiesDto,
  ProviderUsageCenterDto,
  ProviderUsageStateDto,
  ReadinessDto,
  ProjectFolderOptionsDto,
  PutConversationDraftRequest,
  ResolveConversationDraftConflictResponse,
  RestoreConversationDraftConflictRequest,
  QueuedConversationMessageDto,
  ResolveDecisionRequest,
  SendMessageRequest,
  SendMessageResponse,
  SseEventEnvelope,
  SteerQueuedMessageRequest,
  SteerQueuedMessageResponse,
  TokenUsageRangeDto,
  TokenUsageScope,
  TokenUsageSummaryDto,
  TriggerDefinitionDto,
  UpdateBrowserAgentPreferenceRequest,
  UpdateBrowserProfileRequest,
  TriggerOccurrenceDto,
  UpdateAgentOrganizationRequest,
  UpdateAgentPresetRequest,
  UpdateAgentRequest,
  CreateAgentResponse,
  UpdateConversationRequest,
  UpdateProjectRequest,
  UpdateTriggerRequest,
  UpdateWorkspacePreferencesRequest,
  UploadedOperatorAvatarDto,
  WebPushStatusDto,
  WebPushSubscriptionDto,
  WorkspaceEventEnvelope,
  WorkspaceFileReviewDto,
  WorkspaceFileViewDto,
  WorkspaceNotificationDto,
  WorkspaceNotificationPageDto,
  WorkspaceNotificationProjectionDto,
  WorkspaceNotificationProjectionRequestDto,
  WorkspaceDirectoryItemDto,
  WorkspaceDirectoryKind,
  WorkspaceDirectoryPageDto,
  WorkspacePreferencesDto,
  WorkspaceResourceRecencyDto,
  WorkspaceResourceRecencyListDto,
  WorkspaceStatusDto,
  WorkspaceStreamStatusDto,
} from "@ponderosa/core";
import { createClientId } from "../clientId";
import {
  AGENT_DETAIL_PAGE_SIZE,
  AGENT_HISTORY_PAGE_SIZE,
} from "../agentHistoryPagination";
import {
  ApiRequestError,
  type CreateAgentOptions,
  type StreamHandlers,
  type StreamSubscription,
  type WorkspaceStreamHandlers,
} from "./types";
import { createResilientEventSource } from "./resilientEventSource";
import {
  backgroundCooldownRemaining,
  noteBackgroundRateLimit,
  parseRetryAfter,
  waitForBackgroundCooldown,
} from "./backgroundCooldown";

const API_BASE = "";
const pendingBackgroundReads = new Map<string, Promise<unknown>>();

function backgroundRead(method: string, path: string): boolean {
  if (method === "GET") return true;
  if (method !== "POST") return false;
  return path === "/api/notifications/projection"
    || /^\/api\/conversations\/[^/]+\/message-delivery-receipts(?:\?|$)/u.test(path);
}

function coalesceBackgroundRead<T>(key: string, load: () => Promise<T>): Promise<T> {
  const pending = pendingBackgroundReads.get(key);
  if (pending) return pending as Promise<T>;
  const result = load().finally(() => {
    if (pendingBackgroundReads.get(key) === result) pendingBackgroundReads.delete(key);
  });
  pendingBackgroundReads.set(key, result);
  return result;
}

async function probeStreamRateLimit(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch("/api/health", {
      cache: "no-store",
      signal: controller.signal,
    });
    if (response.status === 429) noteBackgroundRateLimit(response.headers.get("retry-after"));
    await response.body?.cancel();
  } finally {
    clearTimeout(timeout);
  }
}

export function requestJson<T>(path: string, init?: RequestInit, acceptedErrorStatuses: number[] = []): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const isBackground = backgroundRead(method, path);
  const load = async (): Promise<T> => {
    const headers = new Headers(init?.headers);
    if (init?.body != null && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    if (isBackground) await waitForBackgroundCooldown(init?.signal ?? undefined);

    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok && !acceptedErrorStatuses.includes(response.status)) {
      const retryAfterMs = response.status === 429
        ? parseRetryAfter(response.headers.get("retry-after"))
        : undefined;
      if (response.status === 429 && isBackground) {
        noteBackgroundRateLimit(response.headers.get("retry-after"));
      }
      let message = `${response.status} ${response.statusText}`;
      let errorBody: unknown;
      if (response.headers.get("content-type")?.includes("application/json")) {
        try {
          const body = await response.json() as { error?: unknown };
          errorBody = body;
          if (typeof body.error === "string" && body.error.trim()) message = body.error.trim();
        } catch {
          // Preserve the stable HTTP fallback when an upstream JSON error is malformed.
        }
      }
      throw new ApiRequestError(response.status, message, errorBody, retryAfterMs);
    }

    if (response.status === 204 || response.headers.get("content-length") === "0") {
      return undefined as T;
    }
    const body = await response.text();
    return (body ? JSON.parse(body) : undefined) as T;
  };
  return isBackground && init === undefined && acceptedErrorStatuses.length === 0
    ? coalesceBackgroundRead(`json:${path}`, load)
    : load();
}

export interface CollectionPage<T> {
  items: T[];
  total: number;
  limit: number;
  hasMore: boolean;
  cursor?: string;
  /** Client-only marker: a stale continuation was transparently restarted. */
  reset?: boolean;
}

function withoutCursor(path: string): string {
  const parsed = new URL(path, "http://ponderosa.local");
  parsed.searchParams.delete("cursor");
  return `${parsed.pathname}${parsed.search}`;
}

function requestCollectionPage<T>(path: string, resetOnStale = true): Promise<CollectionPage<T>> {
  return coalesceBackgroundRead(`page:${path}:${resetOnStale}`, async () => {
    await waitForBackgroundCooldown();
    const response = await fetch(`${API_BASE}${path}`);
    if (!response.ok) {
      if (response.status === 429) noteBackgroundRateLimit(response.headers.get("retry-after"));
      let message = `${response.status} ${response.statusText}`;
      let code: string | undefined;
      try {
        const body = await response.json() as { error?: unknown; code?: unknown };
        if (typeof body.error === "string" && body.error.trim()) message = body.error.trim();
        if (typeof body.code === "string") code = body.code;
      } catch {
        // Preserve the stable HTTP fallback for malformed errors.
      }
      if (resetOnStale && response.status === 409 && code === "stale_collection_cursor") {
        return { ...(await requestCollectionPage<T>(withoutCursor(path), false)), reset: true };
      }
      throw new ApiRequestError(response.status, message, undefined,
        response.status === 429 ? parseRetryAfter(response.headers.get("retry-after")) : undefined);
    }
    const items = await response.json() as T[];
    const total = Number(response.headers.get("x-total-count") ?? items.length);
    const limit = Number(response.headers.get("x-page-limit") ?? items.length);
    const hasMore = response.headers.get("x-collection-has-more") === "true";
    const cursor = response.headers.get("x-next-cursor") ?? undefined;
    return { items, total, limit, hasMore, ...(cursor ? { cursor } : {}) };
  });
}

async function collectCollectionPages<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const page = await requestCollectionPage<T>(path + (path.includes("?") ? "&" : "?") + query.toString());
    if (page.reset) items.splice(0);
    items.push(...page.items);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return items;
}

async function requestText(path: string, init?: RequestInit): Promise<string> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    if (response.headers.get("content-type")?.includes("application/json")) {
      try {
        const body = await response.json() as { error?: unknown };
        if (typeof body.error === "string" && body.error.trim()) {
          message = body.error.trim();
        }
      } catch {
        // Preserve the stable HTTP fallback for malformed errors.
      }
    }
    throw new ApiRequestError(response.status, message);
  }
  return response.text();
}

function toQuery(params: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

function browserPath(projectId: string, agentId: string, runId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/browser`;
}

export const realApi = {
  getAssetLimits(): Promise<AssetLimitsDto> { return requestJson<AssetLimitsDto>("/api/asset-limits"); },
  listProjects(): Promise<ProjectDto[]> {
    return collectCollectionPages<ProjectDto>("/api/projects");
  },
  listProjectsPage(options: { limit?: number; cursor?: string; search?: string } = {}): Promise<CollectionPage<ProjectDto>> {
    return requestCollectionPage<ProjectDto>(`/api/projects${toQuery({ limit: options.limit, cursor: options.cursor, search: options.search })}`);
  },
  getProject(projectId: string): Promise<ProjectDto> {
    return requestJson<ProjectDto>(`/api/projects/${encodeURIComponent(projectId)}`);
  },
  createProject(request: CreateProjectRequest, idempotencyKey: string): Promise<ProjectDto> {
    return requestJson<ProjectDto>("/api/projects", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(request satisfies CreateProjectRequest),
    });
  },
  getProjectFolders(): Promise<ProjectFolderOptionsDto> {
    return requestJson<ProjectFolderOptionsDto>("/api/project-folders");
  },
  browseProjectFolders(path?: string): Promise<HostFolderBrowseDto> {
    return requestJson<HostFolderBrowseDto>(`/api/project-folders/browse${toQuery({ path })}`);
  },
  createProjectFolder(request: CreateHostFolderRequest): Promise<HostFolderCreateDto> {
    return requestJson<HostFolderCreateDto>("/api/project-folders/create", {
      method: "POST",
      body: JSON.stringify(request satisfies CreateHostFolderRequest),
    });
  },
  markProjectUsed(projectId: string, conversationId?: string): Promise<ProjectDto> {
    return requestJson<ProjectDto>(`/api/projects/${encodeURIComponent(projectId)}/use`, { method: "POST", body: JSON.stringify({ conversationId }) });
  },
  updateProject(projectId: string, patch: UpdateProjectRequest): Promise<ProjectDto> {
    return requestJson<ProjectDto>(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch satisfies UpdateProjectRequest),
    });
  },
  deleteProject(projectId: string): Promise<ProjectDeletionResponseDto> {
    return requestJson<ProjectDeletionResponseDto>(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
  },
  getProjectDeletionPreview(projectId: string): Promise<ProjectDeletionPreviewDto> {
    return requestJson<ProjectDeletionPreviewDto>(`/api/projects/${encodeURIComponent(projectId)}/deletion-preview`);
  },
  getAgentHealth(projectId: string): Promise<AgentHealthProjectionDto> {
    return requestJson<AgentHealthProjectionDto>(`/api/projects/${encodeURIComponent(projectId)}/agent-health`);
  },
  getAgentWork(projectId: string, filter: { conversationId?: string; agentId?: string; focusId?: string; limit?: number } = {}): Promise<AgentWorkInspectorDto> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/agent-work${toQuery({
      conversationId: filter.conversationId,
      agentId: filter.agentId,
      focusId: filter.focusId,
      limit: filter.limit === undefined ? undefined : String(filter.limit),
    })}`);
  },
  getAgentWorkItemDetails(projectId: string, kind: AgentWorkItemDto["kind"], recordId: string, filter: { conversationId?: string } = {}): Promise<AgentWorkItemDetailsDto> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/agent-work/items/${encodeURIComponent(kind)}/${encodeURIComponent(recordId)}${toQuery({
      conversationId: filter.conversationId,
    })}`);
  },
  getTokenUsage(scope: TokenUsageScope, id?: string, range?: TokenUsageRangeDto): Promise<TokenUsageSummaryDto> {
    const path = scope === "overall" ? "/api/usage" : `/api/${scope}s/${encodeURIComponent(id ?? "")}/usage`;
    const url = `${path}${toQuery({ from: range?.from, to: range?.to })}`;
    return requestJson<TokenUsageSummaryDto>(url);
  },
  getProviderUsage(refreshStale = false): Promise<ProviderUsageCenterDto> {
    return requestJson<ProviderUsageCenterDto>(`/api/provider-usage${refreshStale ? "?refresh=stale" : ""}`);
  },
  refreshProviderUsage(providerId: string): Promise<ProviderUsageStateDto> {
    return requestJson<ProviderUsageStateDto>(`/api/provider-usage/${encodeURIComponent(providerId)}/refresh`, { method: "POST" });
  },
  getAgentProviderUsage(agentId: string, refreshStale = false): Promise<ProviderUsageStateDto> {
    return requestJson<ProviderUsageStateDto>(`/api/agents/${encodeURIComponent(agentId)}/provider-usage${refreshStale ? "?refresh=stale" : ""}`);
  },
  searchGlobalChats(
    query: string,
    limit?: number,
    kind?: "conversation" | "agent",
  ): Promise<GlobalChatSearchResponseDto> {
    return requestJson<GlobalChatSearchResponseDto>(
      `/api/search${toQuery({ q: query, limit, kind })}`,
    );
  },
  searchGlobalFiles(query: string, limit = 25): Promise<import("@ponderosa/core").GlobalFileSearchResponseDto> {
    return requestJson(`/api/search/files${toQuery({ q: query, limit })}`);
  },
  getAllChat(limit: number = 50, cursor?: string): Promise<AllChatPageDto> {
    return requestJson<AllChatPageDto>(`/api/all-chat${toQuery({ limit: String(limit), cursor })}`);
  },
  listConversations(projectId: string): Promise<ConversationDto[]> {
    return collectCollectionPages<ConversationDto>("/api/projects/" + encodeURIComponent(projectId) + "/conversations");
  },
  listConversationsPage(projectId: string, options: { limit?: number; cursor?: string; search?: string } = {}): Promise<CollectionPage<ConversationDto>> {
    return requestCollectionPage<ConversationDto>(`/api/projects/${encodeURIComponent(projectId)}/conversations${toQuery({ limit: options.limit, cursor: options.cursor, search: options.search })}`);
  },
  listConversationMembersPage(conversationId: string, options: { limit?: number; cursor?: string; search?: string } = {}): Promise<CollectionPage<AgentDto>> {
    return requestCollectionPage<AgentDto>(`/api/conversations/${encodeURIComponent(conversationId)}/members${toQuery({ limit: options.limit, cursor: options.cursor, search: options.search })}`);
  },
  listConversationMembers(conversationId: string): Promise<AgentDto[]> {
    return collectCollectionPages<AgentDto>(`/api/conversations/${encodeURIComponent(conversationId)}/members`);
  },
  createConversation(projectId: string, request: CreateConversationRequest, idempotencyKey: string): Promise<ConversationDto> {
    return requestJson<ConversationDto>("/api/projects/" + encodeURIComponent(projectId) + "/conversations", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(request satisfies CreateConversationRequest),
    });
  },
  createChat(request: CreateProjectRequest, idempotencyKey: string): Promise<ConversationDto> {
    return requestJson<ConversationDto>("/api/chats", {
      method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify(request),
    });
  },
  getConversation(conversationId: string, limit: number = 100, cursor?: string, focusId?: string): Promise<ConversationDetailDto> {
    return requestJson<ConversationDetailDto>("/api/conversations/" + encodeURIComponent(conversationId) + toQuery({ limit: String(limit), cursor, focusId }));
  },
  getCollaborationView(conversationId: string, limit: number = 100, cursor?: string, focusId?: string, operationCursor?: string): Promise<CollaborationViewDto> {
    return requestJson<CollaborationViewDto>(
      "/api/conversations/" + encodeURIComponent(conversationId) + "/collaboration" + toQuery({ limit: String(limit), cursor, focusId, operationCursor }),
    );
  },
  updateConversation(conversationId: string, patch: UpdateConversationRequest): Promise<ConversationDto> {
    return requestJson<ConversationDto>("/api/conversations/" + encodeURIComponent(conversationId), {
      method: "PATCH",
      body: JSON.stringify(patch satisfies UpdateConversationRequest),
    });
  },
  async deleteConversation(conversationId: string, expectedAgentIds?: string[]): Promise<void> {
    await requestJson("/api/conversations/" + encodeURIComponent(conversationId), {
      method: "DELETE",
      ...(expectedAgentIds ? { body: JSON.stringify({ expectedAgentIds }) } : {}),
    });
  },
  sendConversationMessage(
    conversationId: string,
    request: CreateConversationMessageRequest,
  ): Promise<ConversationMessageDto | { communicationEventId?: string }> {
    return requestJson<ConversationMessageDto | { communicationEventId?: string }>("/api/conversations/" + encodeURIComponent(conversationId) + "/messages", {
      method: "POST",
      body: JSON.stringify(request satisfies CreateConversationMessageRequest),
    });
  },
  getTargetedNextRunReceipts(conversationId: string, limit = 20): Promise<TargetedNextRunReceiptListDto> {
    return requestJson<TargetedNextRunReceiptListDto>(
      `/api/conversations/${encodeURIComponent(conversationId)}/next-run-deliveries${toQuery({ limit })}`,
    );
  },
  getConversationDraft(conversationId: string, ownerId: string): Promise<ConversationDraftDto> {
    return requestJson<ConversationDraftDto>(`/api/conversations/${encodeURIComponent(conversationId)}/draft?ownerId=${encodeURIComponent(ownerId)}`);
  },
  getConversationDraftConflicts(conversationId: string, ownerId: string): Promise<ConversationDraftConflictListDto> {
    return requestJson<ConversationDraftConflictListDto>(`/api/conversations/${encodeURIComponent(conversationId)}/draft-conflicts?ownerId=${encodeURIComponent(ownerId)}`);
  },
  putConversationDraft(conversationId: string, request: PutConversationDraftRequest): Promise<ConversationDraftDto> {
    return requestJson<ConversationDraftDto>(`/api/conversations/${encodeURIComponent(conversationId)}/draft`, { method: "PUT", body: JSON.stringify(request satisfies PutConversationDraftRequest) });
  },
  restoreConversationDraftConflict(
    conversationId: string,
    conflictId: string,
    request: RestoreConversationDraftConflictRequest,
  ): Promise<ResolveConversationDraftConflictResponse> {
    return requestJson<ResolveConversationDraftConflictResponse>(
      `/api/conversations/${encodeURIComponent(conversationId)}/draft-conflicts/${encodeURIComponent(conflictId)}/restore`,
      { method: "POST", body: JSON.stringify(request) },
    );
  },
  discardConversationDraftConflict(
    conversationId: string,
    ownerId: string,
    conflictId: string,
  ): Promise<ResolveConversationDraftConflictResponse> {
    return requestJson<ResolveConversationDraftConflictResponse>(
      `/api/conversations/${encodeURIComponent(conversationId)}/draft-conflicts/${encodeURIComponent(conflictId)}?ownerId=${encodeURIComponent(ownerId)}`,
      { method: "DELETE" },
    );
  },
  uploadDraftAttachment(conversationId: string, ownerId: string, file: File): Promise<DraftAttachmentDto> {
    return requestJson<DraftAttachmentDto>(`/api/conversations/${encodeURIComponent(conversationId)}/draft-attachments`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-ponderosa-media-type": file.type || "application/octet-stream",
        "x-ponderosa-filename": file.name,
        "x-ponderosa-draft-owner": ownerId,
      },
      body: file,
    });
  },
  async downloadDraftAttachment(attachment: DraftAttachmentDto): Promise<File> {
    const response = await fetch(attachment.downloadUrl, { cache: "no-store" });
    if (!response.ok) throw new ApiRequestError(response.status, `${response.status} ${response.statusText}`);
    return new File([await response.blob()], attachment.name, { type: attachment.mediaType });
  },
  async deleteDraftAttachment(conversationId: string, ownerId: string, attachmentId: string): Promise<void> {
    const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/draft-attachments/${encodeURIComponent(attachmentId)}?ownerId=${encodeURIComponent(ownerId)}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new ApiRequestError(response.status, `${response.status} ${response.statusText}`);
  },
  generateConversationTitle(conversationId: string): Promise<GenerateConversationTitleResponse> {
    return requestJson<GenerateConversationTitleResponse>(`/api/conversations/${encodeURIComponent(conversationId)}/generate-title`, { method: "POST" });
  },
  getWorkspacePreferences(): Promise<WorkspacePreferencesDto> { return requestJson<WorkspacePreferencesDto>("/api/workspace/preferences"); },
  setNotificationMode(kind: "agent" | "conversation", id: string, mode: "all" | "attention" | "muted" | "inherit"): Promise<WorkspacePreferencesDto> {
    return requestJson<WorkspacePreferencesDto>(`/api/notification-settings/${kind}/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ mode }) });
  },
  getWorkspaceDirectory<T extends WorkspaceDirectoryItemDto>(
    kind: WorkspaceDirectoryKind,
    options: {
      limit?: number;
      cursor?: string;
      search?: string;
      projectId?: string;
      agentIds?: string;
      conversationId?: string;
      sort?: ProjectSort | "next_fire";
      active?: boolean;
      outcomes?: boolean;
      enabled?: boolean;
      summary?: boolean;
    } = {},
  ): Promise<WorkspaceDirectoryPageDto<T>> {
    const path = `/api/workspace/directory/${encodeURIComponent(kind)}${toQuery({
        limit: options.limit,
        cursor: options.cursor,
        search: options.search,
        projectId: options.projectId,
        agentIds: options.agentIds,
        conversationId: options.conversationId,
        sort: options.sort,
        active: options.active ? "true" : undefined,
        outcomes: options.outcomes ? "true" : undefined,
        summary: options.summary ? "true" : undefined,
        enabled: options.enabled ? "true" : undefined,
      })}`;
    return requestJson<WorkspaceDirectoryPageDto<T>>(path).catch(async (error) => {
      if (!(error instanceof ApiRequestError) || error.status !== 409 || !options.cursor) throw error;
      const fresh = await requestJson<WorkspaceDirectoryPageDto<T>>(withoutCursor(path));
      return { ...fresh, reset: true };
    });
  },
  updateWorkspacePreferences(request: UpdateWorkspacePreferencesRequest): Promise<WorkspacePreferencesDto> { return requestJson<WorkspacePreferencesDto>("/api/workspace/preferences", { method: "PATCH", body: JSON.stringify(request satisfies UpdateWorkspacePreferencesRequest) }); },
  getWorkspaceResourceRecency(): Promise<WorkspaceResourceRecencyListDto> { return requestJson<WorkspaceResourceRecencyListDto>("/api/workspace/recent-resources"); },
  markWorkspaceResourceUsed(request: MarkWorkspaceResourceUsedRequest): Promise<WorkspaceResourceRecencyDto> { return requestJson<WorkspaceResourceRecencyDto>("/api/workspace/recent-resources/use", { method: "POST", body: JSON.stringify(request satisfies MarkWorkspaceResourceUsedRequest) }); },
  uploadOperatorAvatar(file: File): Promise<UploadedOperatorAvatarDto> {
    return requestJson<UploadedOperatorAvatarDto>("/api/workspace/profile-images", {
      method: "POST",
      headers: { "content-type": file.type },
      body: file,
    });
  },
  listNotifications(cursor?: string, limit = 100): Promise<WorkspaceNotificationPageDto> {
    return requestJson<WorkspaceNotificationPageDto>(`/api/notifications${toQuery({ limit, cursor })}`);
  },
  getNotificationProjection(
    request: WorkspaceNotificationProjectionRequestDto,
  ): Promise<WorkspaceNotificationProjectionDto> {
    return requestJson<WorkspaceNotificationProjectionDto>("/api/notifications/projection", {
      method: "POST",
      body: JSON.stringify(request satisfies WorkspaceNotificationProjectionRequestDto),
    });
  },
  async activeNotificationIds(notificationIds: string[]): Promise<string[]> {
    if (!notificationIds.length) return [];
    const response = await requestJson<{ activeNotificationIds: string[] }>("/api/notifications/active", {
      method: "POST",
      body: JSON.stringify({ notificationIds }),
    });
    return response.activeNotificationIds;
  },
  async markNotificationRead(notificationId: string): Promise<void> { await requestJson(`/api/notifications/${encodeURIComponent(notificationId)}/read`, { method: "POST" }); },
  async markNotificationsRead(notificationIds: string[]): Promise<void> { await requestJson("/api/notifications/read-batch", { method: "POST", body: JSON.stringify({ notificationIds }) }); },
  async markNotificationCommunicationsRead(communicationEventIds: string[]): Promise<number> {
    const response = await requestJson<{ read: number }>("/api/notifications/read-visible", {
      method: "POST",
      body: JSON.stringify({ communicationEventIds }),
    });
    return response.read;
  },
  async acknowledgeNotifications(notificationIds: string[]): Promise<void> { await requestJson("/api/notifications/acknowledge-batch", { method: "POST", body: JSON.stringify({ notificationIds }) }); },
  setNotificationStatus(notificationId: string, status: "resolved" | "dismissed"): Promise<WorkspaceNotificationDto> { return requestJson(`/api/notifications/${encodeURIComponent(notificationId)}/status`, { method: "POST", body: JSON.stringify({ status }) }); },
  async dismissNotifications(kind: "attention" | "updates"): Promise<number> {
    const response = await requestJson<{ dismissed: number }>("/api/notifications/dismiss-all", {
      method: "POST",
      body: JSON.stringify({ kind }),
    });
    return response.dismissed;
  },
  retryCoordinationRequest(requestId: string, request: { idempotencyKey?: string; createJoin?: boolean } = {}): Promise<RetryCoordinationRequestResponse> {
    return requestJson(`/api/requests/${encodeURIComponent(requestId)}/retry`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
  listDecisions(filter: { projectId?: string; conversationId?: string; agentId?: string; status?: DecisionDto["status"] } = {}): Promise<DecisionDto[]> { return requestJson<DecisionDto[]>(`/api/decisions${toQuery(filter)}`); },
  getDecisionAction(decisionId: string): Promise<RuntimeElicitationActionDto> { return requestJson<RuntimeElicitationActionDto>(`/api/decisions/${encodeURIComponent(decisionId)}/action`); },
  respondDecision(decisionId: string, request: ResolveDecisionRequest): Promise<DecisionDto> { return requestJson<DecisionDto>(`/api/decisions/${encodeURIComponent(decisionId)}/respond`, { method: "POST", body: JSON.stringify(request satisfies ResolveDecisionRequest) }); },
  getWebPushStatus(deviceId?: string): Promise<WebPushStatusDto> { return requestJson(`/api/push/status${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ""}`); },
  async upsertWebPushSubscription(subscription: WebPushSubscriptionDto): Promise<void> {
    await requestJson(`/api/push/subscriptions/${encodeURIComponent(subscription.deviceId)}`, { method: "PUT", body: JSON.stringify(subscription) });
  },
  async deleteWebPushSubscription(deviceId: string): Promise<void> {
    await requestJson(`/api/push/subscriptions/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
  },
  sendMultiAgentDirectMessage(conversationId: string, request: CreateMultiAgentDirectMessageRequest): Promise<MultiAgentDirectMessageResponse> {
    return requestJson(`/api/conversations/${encodeURIComponent(conversationId)}/direct-messages`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
  listQueuedConversationMessages(conversationId: string): Promise<QueuedConversationMessageDto[]> {
    return requestJson(`/api/conversations/${encodeURIComponent(conversationId)}/queued-messages`);
  },
  activeMessageDeliveryReceipts(
    conversationId: string,
    request: ActiveMessageDeliveryReceiptsRequest,
  ): Promise<ActiveMessageDeliveryReceiptsDto> {
    return requestJson(`/api/conversations/${encodeURIComponent(conversationId)}/message-delivery-receipts`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
  cancelQueuedConversationMessage(conversationId: string, deliveryId: string, request: CancelQueuedMessageRequest): Promise<CancelQueuedMessageResponse> {
    return requestJson(`/api/conversations/${encodeURIComponent(conversationId)}/queued-messages/${encodeURIComponent(deliveryId)}/cancel`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
  listQueuedAgentMessages(agentId: string): Promise<QueuedConversationMessageDto[]> {
    return requestJson(`/api/agents/${encodeURIComponent(agentId)}/queued-messages`);
  },
  cancelQueuedAgentMessage(agentId: string, deliveryId: string, request: CancelQueuedMessageRequest): Promise<CancelQueuedMessageResponse> {
    return requestJson(`/api/agents/${encodeURIComponent(agentId)}/queued-messages/${encodeURIComponent(deliveryId)}/cancel`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
  editQueuedAgentMessage(agentId: string, deliveryId: string, request: EditQueuedMessageRequest): Promise<EditQueuedMessageResponse> {
    return requestJson(`/api/agents/${encodeURIComponent(agentId)}/queued-messages/${encodeURIComponent(deliveryId)}`, {
      method: "PATCH",
      body: JSON.stringify(request),
    });
  },
  steerQueuedAgentMessage(agentId: string, deliveryId: string, request: SteerQueuedMessageRequest): Promise<SteerQueuedMessageResponse> {
    return requestJson(`/api/agents/${encodeURIComponent(agentId)}/queued-messages/${encodeURIComponent(deliveryId)}/steer`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
  letCurrentRunFinish(injectionId: string, request: LetCurrentRunFinishRequest): Promise<LetCurrentRunFinishResponse> {
    return requestJson(`/api/message-deliveries/${encodeURIComponent(injectionId)}/let-current-run-finish`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
  retryMessageDelivery(projectId: string, activationId: string, request: RetryMessageDeliveryRequest): Promise<RetryMessageDeliveryResponse> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/message-deliveries/${encodeURIComponent(activationId)}/retry`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
  cancelMessageDelivery(projectId: string, activationId: string, request: CancelMessageDeliveryRequest): Promise<CancelMessageDeliveryResponse> {
    return requestJson<CancelMessageDeliveryResponse>(`/api/projects/${encodeURIComponent(projectId)}/message-deliveries/${encodeURIComponent(activationId)}/cancel`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
  async sendCollaborationMessage(conversationId: string, request: CreateCollaborationMessageRequest): Promise<CreateCollaborationMessageResponse> {
    return requestJson<CreateCollaborationMessageResponse>("/api/conversations/" + encodeURIComponent(conversationId) + "/collaboration/messages", {
      method: "POST",
      body: JSON.stringify(request satisfies CreateCollaborationMessageRequest),
    });
  },
  listAgents(projectId: string): Promise<AgentDto[]> {
    return collectCollectionPages<AgentDto>(`/api/projects/${encodeURIComponent(projectId)}/agents`);
  },
  listAgentsPage(projectId: string, options: { limit?: number; cursor?: string; search?: string } = {}): Promise<CollectionPage<AgentDto>> {
    return requestCollectionPage<AgentDto>(`/api/projects/${encodeURIComponent(projectId)}/agents${toQuery({ limit: options.limit, cursor: options.cursor, search: options.search })}`);
  },
  cleanupDeletedAgentWorkingCopy(projectId: string, agentId: string): Promise<AgentDto["workingCopy"]> {
    return requestJson<AgentDto["workingCopy"]>(
      `/api/projects/${encodeURIComponent(projectId)}/deleted-agents/${encodeURIComponent(agentId)}/working-copy`,
      { method: "DELETE" },
    );
  },
  async getAgentOrganizationPage(
    projectId: string,
    options: {
      scope: AgentOrganizationScope;
      parentAgentId?: string;
      limit?: number;
      cursor?: string;
      search?: string;
      status?: AgentOperationalStatus;
    },
    signal?: AbortSignal,
  ): Promise<AgentOrganizationPageDto & { reset?: boolean }> {
    const path = `/api/projects/${encodeURIComponent(projectId)}/agent-organization${toQuery(options)}`;
    try {
      return await requestJson<AgentOrganizationPageDto>(path, { signal });
    } catch (error) {
      if (!(error instanceof ApiRequestError) || error.status !== 409 || !options.cursor) throw error;
      return {
        ...(await requestJson<AgentOrganizationPageDto>(
          `/api/projects/${encodeURIComponent(projectId)}/agent-organization${toQuery({
            ...options,
            cursor: undefined,
          })}`,
          { signal },
        )),
        reset: true,
      };
    }
  },
  createAgentRecord(projectId: string, request: CreateAgentRequest): Promise<CreateAgentResponse> {
    return requestJson<CreateAgentResponse>(`/api/projects/${encodeURIComponent(projectId)}/agents`, {
      method: "POST",
      body: JSON.stringify(request satisfies CreateAgentRequest),
    });
  },
  createAgent(projectId: string, conversationId: string, options: CreateAgentOptions): Promise<CreateAgentResponse> {
    return this.createAgentRecord(projectId, {
      title: options.title,
      engine: options.engine as CreateAgentRequest["engine"],
      conversationId,
      model: options.model,
      effort: options.effort,
      speed: options.speed,
      initialMessage: options.initialMessage,
      draftAttachmentIds: options.draftAttachmentIds,
      draftOwnerId: options.draftOwnerId,
      presetId: options.presetId,
      managerAgentId: options.managerAgentId,
      idempotencyKey: options.idempotencyKey,
    });
  },
  listAgentPresets(projectId: string): Promise<AgentPresetDto[]> { return requestJson(`/api/projects/${encodeURIComponent(projectId)}/agent-presets`); },
  createAgentPreset(projectId: string, request: CreateAgentPresetRequest, idempotencyKey: string): Promise<AgentPresetDto> { return requestJson(`/api/projects/${encodeURIComponent(projectId)}/agent-presets`, { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify(request) }); },
  updateAgentPreset(id: string, patch: UpdateAgentPresetRequest): Promise<AgentPresetDto> { return requestJson(`/api/agent-presets/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }); },
  async deleteAgentPreset(id: string): Promise<void> { await requestJson(`/api/agent-presets/${encodeURIComponent(id)}`, { method: "DELETE" }); },
  updateAgent(agentId: string, patch: UpdateAgentRequest): Promise<AgentDto> {
    return requestJson<AgentDto>(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch satisfies UpdateAgentRequest),
    });
  },
  updateAgentOrganization(agentId: string, organization: UpdateAgentOrganizationRequest): Promise<AgentDto> {
    return requestJson<AgentDto>(`/api/agents/${encodeURIComponent(agentId)}/manager`, {
      method: "PUT",
      body: JSON.stringify(organization satisfies UpdateAgentOrganizationRequest),
    });
  },
  previewAgentDeletion(projectId: string, request: AgentDeletionPreviewRequest): Promise<AgentDeletionPreviewDto> {
    return requestJson<AgentDeletionPreviewDto>(`/api/projects/${encodeURIComponent(projectId)}/agent-deletions/preview`, {
      method: "POST",
      body: JSON.stringify(request satisfies AgentDeletionPreviewRequest),
    });
  },
  commitAgentDeletion(projectId: string, request: CommitAgentDeletionRequest): Promise<CommitAgentDeletionResponse> {
    return requestJson<CommitAgentDeletionResponse>(`/api/projects/${encodeURIComponent(projectId)}/agent-deletions/commit`, {
      method: "POST",
      body: JSON.stringify(request satisfies CommitAgentDeletionRequest),
    });
  },
  getAgent(agentId: string, limit: number = AGENT_DETAIL_PAGE_SIZE, cursor?: string, focusId?: string): Promise<AgentDetailDto> {
    return requestJson<AgentDetailDto>(`/api/agents/${encodeURIComponent(agentId)}${toQuery({ limit: String(limit), cursor, focusId })}`);
  },
  getAgentHistory(agentId: string, stream: AgentTelemetryStream, limit: number = AGENT_HISTORY_PAGE_SIZE, cursor?: string, focusId?: string): Promise<AgentTelemetryPageDto> {
    return requestJson(`/api/agents/${encodeURIComponent(agentId)}/history/${encodeURIComponent(stream)}${toQuery({ limit: String(limit), cursor, focusId })}`);
  },
  getChangedFileDetail(agentId: string, path: string): Promise<ChangedFileDetailDto> {
    return requestJson(`/api/agents/${encodeURIComponent(agentId)}/changed-file${toQuery({ path })}`);
  },
  getActivityOutput(retrievalUrl: string, cursor?: string): Promise<AgentActivityOutputDto> {
    return requestJson(`${retrievalUrl}${toQuery({ cursor })}`);
  },
  getRunOutputText(retrievalUrl: string): Promise<RunOutputTextDto> {
    return requestJson(retrievalUrl);
  },
  listProjectArtifacts(projectId: string, limit: number = 100, cursor?: string): Promise<HistoryPageDto<ArtifactDto>> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/artifacts${toQuery({ limit: String(limit), cursor })}`);
  },
  getProjectArtifact(projectId: string, artifactId: string): Promise<ArtifactDto> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}`);
  },
  listConversationArtifacts(projectId: string, conversationId: string, limit: number = 100, cursor?: string): Promise<HistoryPageDto<ArtifactDto>> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/artifacts${toQuery({ conversationId, limit: String(limit), cursor })}`);
  },
  updateProjectArtifact(projectId: string, artifactId: string, input: { pinned?: boolean; visibility?: "project" | "published" }): Promise<ArtifactDto> {
    return requestJson<ArtifactDto>(`/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },
  exportAgent(agentId: string, mode: AgentExportMode, organization: boolean = false): Promise<AgentPortablePackageDto> {
    return requestJson<AgentPortablePackageDto>(`/api/agents/${encodeURIComponent(agentId)}/export${toQuery({ mode, organization: String(organization) })}`);
  },
  exportAgentText(agentId: string, mode: AgentExportMode, organization: boolean = false): Promise<string> {
    return requestText(`/api/agents/${encodeURIComponent(agentId)}/export${toQuery({ mode, organization: String(organization) })}`);
  },
  agentExportDownloadUrl(agentId: string, mode: AgentExportMode, organization: boolean = false): string {
    return `/api/agents/${encodeURIComponent(agentId)}/export${toQuery({ mode, organization: String(organization), download: 1 })}`;
  },
  importAgents(projectId: string, request: ImportAgentPackageRequest, requestId = createClientId()): Promise<ImportAgentPackageResponse> {
    return requestJson<ImportAgentPackageResponse>(`/api/projects/${encodeURIComponent(projectId)}/import-agents`, {
      method: "POST",
      headers: { "idempotency-key": requestId },
      body: JSON.stringify(request satisfies ImportAgentPackageRequest),
    });
  },
  importAgentPackageBlob(
    projectId: string,
    packageBlob: Blob,
    metadata: Omit<ImportAgentPackageRequest, "package">,
    requestId = createClientId(),
  ): Promise<ImportAgentPackageResponse> {
    const body = new Blob(
      [`${JSON.stringify(metadata)}\n`, packageBlob],
      { type: "application/vnd.ponderosa.agent-import" },
    );
    return requestJson<ImportAgentPackageResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/import-agent-package`,
      {
        method: "POST",
        headers: { "content-type": body.type, "idempotency-key": requestId },
        body,
      },
    );
  },
  startAgentPackageImport(
    projectId: string,
    packageBlob: Blob,
    metadata: Omit<ImportAgentPackageRequest, "package">,
    requestId: string,
  ): Promise<AgentImportOperationDto> {
    const body = new Blob(
      [`${JSON.stringify(metadata)}\n`, packageBlob],
      { type: "application/vnd.ponderosa.agent-import" },
    );
    return requestJson<AgentImportOperationDto>(
      `/api/projects/${encodeURIComponent(projectId)}/agent-import-operations`,
      {
        method: "POST",
        headers: {
          "content-type": body.type,
          "idempotency-key": requestId,
        },
        body,
      },
    );
  },
  getAgentImportOperation(projectId: string, operationId: string): Promise<AgentImportOperationDto> {
    return requestJson<AgentImportOperationDto>(
      `/api/projects/${encodeURIComponent(projectId)}/agent-import-operations/${encodeURIComponent(operationId)}`,
    );
  },
  copyAgent(
    projectId: string,
    request: CopyAgentPackageRequest,
    requestId = createClientId(),
  ): Promise<ImportAgentPackageResponse> {
    return requestJson<ImportAgentPackageResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/copy-agent`,
      {
        method: "POST",
        headers: { "idempotency-key": requestId },
        body: JSON.stringify(request satisfies CopyAgentPackageRequest),
      },
    );
  },
  listTriggers(projectId: string): Promise<TriggerDefinitionDto[]> {
    return collectCollectionPages<TriggerDefinitionDto>(`/api/triggers${toQuery({ projectId })}`);
  },
  listTriggersPage(projectId: string, options: { limit?: number; cursor?: string; search?: string } = {}): Promise<CollectionPage<TriggerDefinitionDto>> {
    return requestCollectionPage<TriggerDefinitionDto>(`/api/triggers${toQuery({ projectId, limit: options.limit, cursor: options.cursor, search: options.search })}`);
  },
  listAllTriggers(): Promise<TriggerDefinitionDto[]> {
    return collectCollectionPages<TriggerDefinitionDto>("/api/triggers");
  },
  createTrigger(projectId: string, request: CreateTriggerRequest): Promise<CreateTriggerResponse> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/triggers`, { method: "POST", body: JSON.stringify(request) });
  },
  updateTrigger(triggerId: string, request: UpdateTriggerRequest): Promise<TriggerDefinitionDto> {
    return requestJson(`/api/triggers/${encodeURIComponent(triggerId)}`, { method: "PATCH", body: JSON.stringify(request) });
  },
  async deleteTrigger(triggerId: string): Promise<void> {
    await requestJson(`/api/triggers/${encodeURIComponent(triggerId)}`, { method: "DELETE" });
  },
  rotateTriggerSecret(triggerId: string): Promise<CreateTriggerResponse> {
    return requestJson(`/api/triggers/${encodeURIComponent(triggerId)}/rotate-secret`, { method: "POST" });
  },
  allowTriggerRuns(triggerId: string, additionalRuns: number): Promise<TriggerDefinitionDto> {
    return requestJson(`/api/triggers/${encodeURIComponent(triggerId)}/allow-runs`, { method: "POST", body: JSON.stringify({ additionalRuns }) });
  },
  runTrigger(triggerId: string, confirmDisabled = false): Promise<RunTriggerResponse> {
    return requestJson(`/api/triggers/${encodeURIComponent(triggerId)}/run`, {
      method: "POST",
      body: JSON.stringify({ confirmDisabled }),
    });
  },
  listTriggerOccurrences(triggerId: string, limit: number = 100): Promise<TriggerOccurrenceDto[]> {
    return requestJson(`/api/triggers/${encodeURIComponent(triggerId)}/occurrences?limit=${encodeURIComponent(String(limit))}`);
  },
  listAgentTriggerOccurrences(agentId: string, limit: number = 100): Promise<TriggerOccurrenceDto[]> {
    return requestJson(`/api/agents/${encodeURIComponent(agentId)}/trigger-occurrences?limit=${encodeURIComponent(String(limit))}`);
  },
  listProjectTriggerOccurrences(projectId: string, limit: number = 100): Promise<TriggerOccurrenceDto[]> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/trigger-occurrences?limit=${encodeURIComponent(String(limit))}`);
  },
  listEngines(): Promise<EngineDto[]> {
    return requestJson<EngineDto[]>("/api/engines");
  },
  getHealth(): Promise<HealthDto> {
    return requestJson<HealthDto>("/api/health");
  },
  getReadiness(): Promise<ReadinessDto> {
    return requestJson<ReadinessDto>("/api/diagnostics/ready", undefined, [503]);
  },
  updateEngine(engineId: string, request: { enabled: boolean }): Promise<EngineDto> {
    return requestJson<EngineDto>(`/api/engines/${encodeURIComponent(engineId)}`, { method: "PATCH", body: JSON.stringify(request) });
  },
  recheckEngine(engineId: string): Promise<EngineDto> {
    return requestJson<EngineDto>(`/api/engines/${encodeURIComponent(engineId)}/recheck`, { method: "POST" });
  },
  getEngineModels(projectId: string, engineId: string, refresh = false): Promise<ProjectEngineModelCatalogDto> {
    return requestJson<ProjectEngineModelCatalogDto>(
      `/api/projects/${encodeURIComponent(projectId)}/engine-models/${encodeURIComponent(engineId)}${toQuery(refresh ? { refresh: true } : {})}`,
    );
  },
  validateEngineModel(projectId: string, engineId: string, modelId: string): Promise<EngineModelValidationDto> {
    return requestJson<EngineModelValidationDto>(
      `/api/projects/${encodeURIComponent(projectId)}/engine-models/${encodeURIComponent(engineId)}/validate`,
      { method: "POST", body: JSON.stringify({ modelId }) },
    );
  },
  getEngineCapabilities(projectId: string, context?: { engineId?: string; model?: string; agentId?: string; refresh?: boolean }): Promise<ProjectEngineCapabilitiesDto[]> {
    return requestJson<ProjectEngineCapabilitiesDto[]>(
      `/api/projects/${encodeURIComponent(projectId)}/engine-capabilities${toQuery(context ?? {})}`,
    );
  },
  getFiles(projectId: string, path?: string): Promise<FilesResponse> {
    return requestJson<FilesResponse>(`/api/files${toQuery({ projectId, path })}`);
  },
  getConversationFiles(conversationId: string, path?: string): Promise<FilesResponse> {
    return requestJson<FilesResponse>(`/api/conversations/${encodeURIComponent(conversationId)}/files${toQuery({ path })}`);
  },
  getWorkspaceStatus(agentId: string): Promise<WorkspaceStatusDto> {
    return requestJson<WorkspaceStatusDto>(`/api/agents/${encodeURIComponent(agentId)}/workspace`);
  },
  getWorkspaceFile(agentId: string, path: string): Promise<WorkspaceFileReviewDto> {
    return requestJson<WorkspaceFileReviewDto>(
      `/api/agents/${encodeURIComponent(agentId)}/workspace/file${toQuery({ path })}`,
    );
  },
  getWorkspaceFileView(projectId: string, path: string, agentId?: string): Promise<WorkspaceFileViewDto> {
    return requestJson<WorkspaceFileViewDto>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace-files/view-info${toQuery({ path, agentId })}`,
    );
  },
  getArtifact(agentId: string, artifactId: string): Promise<ArtifactContentDto> {
    return requestJson<ArtifactContentDto>(
      `/api/agents/${encodeURIComponent(agentId)}/artifacts/${encodeURIComponent(artifactId)}`,
    );
  },
  getCommunicationDocument(previewUrl: string): Promise<CommunicationDocumentContentDto> {
    return requestJson(previewUrl);
  },
  sendMessage(agentId: string, request: SendMessageRequest): Promise<SendMessageResponse> {
    return requestJson<SendMessageResponse>(`/api/agents/${encodeURIComponent(agentId)}/messages`, {
      method: "POST",
      body: JSON.stringify(request satisfies SendMessageRequest),
    });
  },
  uploadAttachment(agentId: string, file: File): Promise<AssetDto> {
    return requestJson<AssetDto>(`/api/agents/${encodeURIComponent(agentId)}/attachments`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-ponderosa-media-type": file.type || "application/octet-stream",
        "x-ponderosa-filename": file.name,
      },
      body: file,
    });
  },
  async deleteAttachment(agentId: string, attachmentId: string): Promise<void> {
    await requestJson<void>(
      `/api/agents/${encodeURIComponent(agentId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: "DELETE" },
    );
  },
  cancelRun(agentId: string, request: CancelAgentRunRequest): Promise<CancelAgentRunResponse> {
    return requestJson<CancelAgentRunResponse>(`/api/agents/${encodeURIComponent(agentId)}/cancel`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
  compactSession(agentId: string): Promise<{ compacted: boolean }> {
    return requestJson<{ compacted: boolean }>(`/api/agents/${encodeURIComponent(agentId)}/compact`, { method: "POST" });
  },
  invokeProviderCommand(agentId: string, request: { name: string; argumentsText?: string }): Promise<{ invoked: true; name: string; catalogVersion?: string; message?: string; usage?: ProviderUsageStateDto }> {
    return requestJson(`/api/agents/${encodeURIComponent(agentId)}/provider-commands`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
  invokeProjectProviderCommand(projectId: string, request: { engineId: string; model?: string; effort?: string; name: string; argumentsText?: string }): Promise<{ invoked: true; name: string; catalogVersion?: string; message?: string; usage?: ProviderUsageStateDto }> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/provider-commands`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
  getBrowserSession(projectId: string, agentId: string, runId: string): Promise<BrowserSessionDto> {
    return requestJson<BrowserSessionDto>(browserPath(projectId, agentId, runId));
  },
  listActiveBrowserSessions(projectId: string, conversationId?: string): Promise<BrowserSessionDto[]> {
    return requestJson<BrowserSessionDto[]>(
      `/api/projects/${encodeURIComponent(projectId)}/browser-sessions${toQuery({ conversationId })}`,
    );
  },
  listBrowserProfiles(projectId: string): Promise<BrowserProfileDto[]> {
    return requestJson<BrowserProfileDto[]>(`/api/projects/${encodeURIComponent(projectId)}/browser-profiles`);
  },
  createBrowserProfile(projectId: string, request: CreateBrowserProfileRequest): Promise<BrowserProfileDto> {
    return requestJson<BrowserProfileDto>(`/api/projects/${encodeURIComponent(projectId)}/browser-profiles`, {
      method: "POST", body: JSON.stringify(request),
    });
  },
  updateBrowserProfile(projectId: string, profileId: string, request: UpdateBrowserProfileRequest): Promise<BrowserProfileDto> {
    return requestJson<BrowserProfileDto>(`/api/projects/${encodeURIComponent(projectId)}/browser-profiles/${encodeURIComponent(profileId)}`, {
      method: "PUT", body: JSON.stringify(request),
    });
  },
  async deleteBrowserProfile(projectId: string, profileId: string): Promise<void> {
    await requestJson<void>(`/api/projects/${encodeURIComponent(projectId)}/browser-profiles/${encodeURIComponent(profileId)}`, { method: "DELETE" });
  },
  getBrowserAgentPreference(projectId: string, agentId: string): Promise<BrowserAgentPreferenceDto> {
    return requestJson<BrowserAgentPreferenceDto>(`/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}/browser-preference`);
  },
  updateBrowserAgentPreference(projectId: string, agentId: string, request: UpdateBrowserAgentPreferenceRequest): Promise<BrowserAgentPreferenceDto> {
    return requestJson<BrowserAgentPreferenceDto>(`/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}/browser-preference`, {
      method: "PUT", body: JSON.stringify(request),
    });
  },
  openBrowserSession(projectId: string, agentId: string, runId: string): Promise<BrowserSessionDto> {
    return requestJson<BrowserSessionDto>(browserPath(projectId, agentId, runId), { method: "POST" });
  },
  reconnectBrowserSession(projectId: string, agentId: string, runId: string): Promise<BrowserSessionDto> {
    return requestJson<BrowserSessionDto>(`${browserPath(projectId, agentId, runId)}/reconnect`, { method: "POST" });
  },
  closeBrowserSession(projectId: string, agentId: string, runId: string): Promise<BrowserSessionDto> {
    return requestJson<BrowserSessionDto>(browserPath(projectId, agentId, runId), { method: "DELETE" });
  },
  activateBrowserPage(projectId: string, agentId: string, runId: string, pageId: string, expectedControlEpoch: number): Promise<BrowserSessionDto> {
    return requestJson<BrowserSessionDto>(browserPath(projectId, agentId, runId) + "/pages/" + encodeURIComponent(pageId) + "/active", {
      method: "PUT", body: JSON.stringify({ expectedControlEpoch }),
    });
  },
  closeBrowserPage(projectId: string, agentId: string, runId: string, pageId: string, expectedControlEpoch: number): Promise<BrowserSessionDto> {
    return requestJson<BrowserSessionDto>(browserPath(projectId, agentId, runId) + "/pages/" + encodeURIComponent(pageId), {
      method: "DELETE", body: JSON.stringify({ expectedControlEpoch }),
    });
  },
  uploadBrowserArtifact(projectId: string, agentId: string, runId: string, artifactId: string, selector: string | undefined, expectedControlEpoch: number): Promise<BrowserUploadResponseDto> {
    return requestJson<BrowserUploadResponseDto>(browserPath(projectId, agentId, runId) + "/upload", {
      method: "POST", body: JSON.stringify({ artifactId, selector, expectedControlEpoch }),
    });
  },
  cancelBrowserFileChooser(projectId: string, agentId: string, runId: string, expectedControlEpoch: number): Promise<BrowserSessionDto> {
    return requestJson<BrowserSessionDto>(browserPath(projectId, agentId, runId) + "/file-chooser", {
      method: "DELETE", body: JSON.stringify({ expectedControlEpoch }),
    });
  },
  setBrowserControl(projectId: string, agentId: string, runId: string, request: BrowserControlRequest): Promise<BrowserSessionDto> {
    return requestJson<BrowserSessionDto>(`${browserPath(projectId, agentId, runId)}/control`, {
      method: "PUT", body: JSON.stringify(request satisfies BrowserControlRequest),
    });
  },
  sendBrowserInput(projectId: string, agentId: string, runId: string, request: BrowserOperatorInputRequest): Promise<BrowserSessionDto> {
    return requestJson<BrowserSessionDto>(`${browserPath(projectId, agentId, runId)}/input`, {
      method: "POST", body: JSON.stringify(request satisfies BrowserOperatorInputRequest),
    });
  },
  async getBrowserFrame(projectId: string, agentId: string, runId: string, pageId?: string): Promise<{ blob: Blob; revision: number; metadata?: BrowserFrameMetadata }> {
    const response = await fetch(`${browserPath(projectId, agentId, runId)}/frame${pageId ? `?pageId=${encodeURIComponent(pageId)}` : ""}`, { cache: "no-store" });
    if (!response.ok) throw new ApiRequestError(response.status, `${response.status} ${response.statusText}`);
    return { blob: await response.blob(), revision: Number(response.headers.get("x-ponderosa-browser-revision") ?? 0), metadata: JSON.parse(response.headers.get("x-ponderosa-browser-frame") ?? "null") ?? undefined };
  },
  getProjectBrowser(projectId: string): Promise<ProjectBrowserSessionDto> {
    return requestJson<ProjectBrowserSessionDto>(`/api/projects/${encodeURIComponent(projectId)}/browser`);
  },
  getChatBrowserPreferences(projectId: string): Promise<{ rememberSignIns: boolean }> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/browser/preferences`);
  },
  getSavedBrowser(): Promise<{ browser: import("@ponderosa/core").SavedBrowserDto | null }> {
    return requestJson("/api/saved-browser");
  },
  getAgentBrowserLocation(projectId: string, agentId: string): Promise<{ kind: "saved" | "chat" | "run" | "none"; runId?: string; status?: string }> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}/browser-location`);
  },
  getSavedBrowserAccess(projectId: string): Promise<{ agentIds: string[] }> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/saved-browser-access`);
  },
  setSavedBrowserAccess(projectId: string, agentId: string, allowed: boolean): Promise<{ agentIds: string[] }> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/saved-browser-access/${encodeURIComponent(agentId)}`, {
      method: "PUT", body: JSON.stringify({ allowed }),
    });
  },
  promoteBrowser(projectId: string, sessionId: string, expectedControlEpoch: number): Promise<ProjectBrowserSessionDto> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/browser/promote`, {
      method: "POST", body: JSON.stringify({ sessionId, expectedControlEpoch, confirmInstanceSharing: true }),
    });
  },
  hostedBrowserControl(projectId: string, action: "open" | "pause" | "resume" | "connect", sessionId?: string, expectedControlEpoch?: number): Promise<ProjectBrowserSessionDto> {
    return requestJson<ProjectBrowserSessionDto>(`/api/projects/${encodeURIComponent(projectId)}/browser/manual`, {
      method: "POST", body: JSON.stringify({ action, sessionId, expectedControlEpoch }),
    });
  },
  resizeHostedDisplay(projectId: string, sessionId: string, expectedControlEpoch: number, width: number, height: number): Promise<{ ok: boolean }> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/browser/manual`, { method: "POST", body: JSON.stringify({ action: "resize", sessionId, expectedControlEpoch, width, height }) });
  },
  hostedBrowserTicket(projectId: string, sessionId: string, expectedControlEpoch: number): Promise<{ path: string; protocol: string }> {
    return requestJson<{ path: string; protocol: string }>(`/api/projects/${encodeURIComponent(projectId)}/browser/manual`, {
      method: "POST", body: JSON.stringify({ action: "ticket", sessionId, expectedControlEpoch }),
    });
  },
  openProjectBrowser(projectId: string, url?: string, rememberSignIns?: boolean): Promise<ProjectBrowserSessionDto> {
    return requestJson<ProjectBrowserSessionDto>(`/api/projects/${encodeURIComponent(projectId)}/browser`, {
      method: "POST", body: JSON.stringify({ url, rememberSignIns }),
    });
  },
  navigateProjectBrowser(projectId: string, url: string): Promise<ProjectBrowserSessionDto> {
    return requestJson<ProjectBrowserSessionDto>(`/api/projects/${encodeURIComponent(projectId)}/browser/navigate`, {
      method: "POST", body: JSON.stringify({ url }),
    });
  },
  reconnectProjectBrowser(projectId: string): Promise<ProjectBrowserSessionDto> {
    return requestJson<ProjectBrowserSessionDto>(`/api/projects/${encodeURIComponent(projectId)}/browser/reconnect`, { method: "POST" });
  },
  closeProjectBrowser(projectId: string): Promise<ProjectBrowserSessionDto> {
    return requestJson<ProjectBrowserSessionDto>(`/api/projects/${encodeURIComponent(projectId)}/browser`, { method: "DELETE" });
  },
  activateProjectBrowserPage(projectId: string, pageId: string, expectedControlEpoch: number): Promise<ProjectBrowserSessionDto> {
    return requestJson<ProjectBrowserSessionDto>("/api/projects/" + encodeURIComponent(projectId) + "/browser/pages/" + encodeURIComponent(pageId) + "/active", {
      method: "PUT", body: JSON.stringify({ expectedControlEpoch }),
    });
  },
  closeProjectBrowserPage(projectId: string, pageId: string, expectedControlEpoch: number): Promise<ProjectBrowserSessionDto> {
    return requestJson<ProjectBrowserSessionDto>("/api/projects/" + encodeURIComponent(projectId) + "/browser/pages/" + encodeURIComponent(pageId), {
      method: "DELETE", body: JSON.stringify({ expectedControlEpoch }),
    });
  },
  uploadProjectBrowserArtifact(projectId: string, artifactId: string, selector: string | undefined, expectedControlEpoch: number): Promise<BrowserUploadResponseDto> {
    return requestJson<BrowserUploadResponseDto>("/api/projects/" + encodeURIComponent(projectId) + "/browser/upload", {
      method: "POST", body: JSON.stringify({ artifactId, selector, expectedControlEpoch }),
    });
  },
  cancelProjectBrowserFileChooser(projectId: string, expectedControlEpoch: number): Promise<ProjectBrowserSessionDto> {
    return requestJson<ProjectBrowserSessionDto>("/api/projects/" + encodeURIComponent(projectId) + "/browser/file-chooser", {
      method: "DELETE", body: JSON.stringify({ expectedControlEpoch }),
    });
  },
  setProjectBrowserControl(projectId: string, request: ProjectBrowserControlRequest): Promise<ProjectBrowserSessionDto> {
    return requestJson<ProjectBrowserSessionDto>(`/api/projects/${encodeURIComponent(projectId)}/browser/control`, {
      method: "PUT", body: JSON.stringify(request satisfies ProjectBrowserControlRequest),
    });
  },
  sendProjectBrowserInput(projectId: string, request: BrowserOperatorInputRequest): Promise<ProjectBrowserSessionDto> {
    return requestJson<ProjectBrowserSessionDto>(`/api/projects/${encodeURIComponent(projectId)}/browser/input`, {
      method: "POST", body: JSON.stringify(request satisfies BrowserOperatorInputRequest),
    });
  },
  newBrowserPage(projectId: string, expectedControlEpoch: number, agentId?: string, runId?: string): Promise<BrowserSessionDto | ProjectBrowserSessionDto> {
    const base = agentId && runId ? browserPath(projectId, agentId, runId) : `/api/projects/${encodeURIComponent(projectId)}/browser`;
    return requestJson(`${base}/pages`, { method: "POST", body: JSON.stringify({ expectedControlEpoch }) });
  },
  pairLocalBrowser(projectId: string): Promise<LocalBrowserPairingDto> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/local-browser/pair`, { method: "POST" });
  },
  listLocalBrowsers(projectId: string): Promise<LocalBrowserConnectionDto[]> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/local-browser`);
  },
  connectLocalBrowser(projectId: string, id: string): Promise<{ ok: boolean }> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/local-browser/${encodeURIComponent(id)}/connect`, { method: "POST" });
  },
  navigateAgentBrowser(projectId: string, agentId: string, runId: string, url: string): Promise<BrowserSessionDto> {
    return requestJson(`${browserPath(projectId, agentId, runId)}/navigate`, { method: "POST", body: JSON.stringify({ url }) });
  },
  resizeBrowserViewport(projectId: string, pageId: string, size: BrowserViewportSize, expectedControlEpoch: number, agentId?: string, runId?: string): Promise<{ ok: boolean }> {
    const base = agentId && runId ? browserPath(projectId, agentId, runId) : `/api/projects/${encodeURIComponent(projectId)}/browser`;
    return requestJson(`${base}/pages/${encodeURIComponent(pageId)}/viewport`, { method: "PUT", body: JSON.stringify({ ...size, expectedControlEpoch }) });
  },
  async getProjectBrowserFrame(projectId: string, pageId?: string): Promise<{ blob: Blob; revision: number; metadata?: BrowserFrameMetadata }> {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/browser/frame${pageId ? `?pageId=${encodeURIComponent(pageId)}` : ""}`, { cache: "no-store" });
    if (!response.ok) throw new ApiRequestError(response.status, `${response.status} ${response.statusText}`);
    return { blob: await response.blob(), revision: Number(response.headers.get("x-ponderosa-browser-revision") ?? 0), metadata: JSON.parse(response.headers.get("x-ponderosa-browser-frame") ?? "null") ?? undefined };
  },
  subscribeAgent(agentId: string, lastSeenSeq: number | undefined, handlers: StreamHandlers): StreamSubscription {
    let cursor = lastSeenSeq;
    return createResilientEventSource({
      probeRateLimit: probeStreamRateLimit,
      reconnectCooldownMs: backgroundCooldownRemaining,
      createSource: () => new EventSource(`/api/agents/${encodeURIComponent(agentId)}/stream${toQuery({
        lastEventId: cursor,
      })}`),
      onOpen: () => handlers.onOpen?.(),
      onError: (event) => handlers.onError?.(event),
      configure(source) {
        source.addEventListener("message", (event) => {
          const envelope = JSON.parse(event.data as string) as SseEventEnvelope;
          cursor = Math.max(cursor ?? 0, envelope.seq);
          handlers.onEvent(envelope);
        });
        source.addEventListener("agent_status", (event) => {
          const status = JSON.parse(event.data as string) as AgentStreamStatusDto;
          if (status.reset) cursor = 0;
          handlers.onStatus?.(status);
        });
      },
    });
  },
  subscribeWorkspace(lastSeenId: number | undefined, handlers: WorkspaceStreamHandlers): StreamSubscription {
    let cursor = lastSeenId;
    return createResilientEventSource({
      probeRateLimit: probeStreamRateLimit,
      reconnectCooldownMs: backgroundCooldownRemaining,
      createSource: () => new EventSource(`/api/workspace/stream${toQuery({ lastEventId: cursor, bootstrap: true })}`),
      onOpen: () => handlers.onOpen?.(),
      onError: (event) => handlers.onError?.(event),
      configure(source) {
        source.addEventListener("message", (event) => {
          const envelope = JSON.parse(event.data as string) as WorkspaceEventEnvelope;
          cursor = Math.max(cursor ?? 0, envelope.id);
          handlers.onEvent(envelope);
        });
        source.addEventListener("workspace_status", (event) => {
          const status = JSON.parse(event.data as string) as WorkspaceStreamStatusDto;
          if (status.snapshot) cursor = status.cursor;
          else if (status.reset) cursor = 0;
          handlers.onStatus?.(status);
        });
      },
    });
  },
};
