import type {
  AgentActivityOutputDto,
  AssetLimitsDto,
  AgentDeletionPreviewDto,
  AgentDeletionPreviewRequest,
  AgentDetailDto,
  AgentDto,
  AgentExportMode,
  AgentHealthProjectionDto,
  AgentPortablePackageDto,
  AgentPresetDto,
  AgentStreamStatusDto,
  AgentTelemetryPageDto,
  AgentTelemetryStream,
  AgentWorkInspectorDto,
  AgentWorkItemDetailsDto,
  AgentWorkItemDto,
  ArtifactContentDto,
  ArtifactDto,
  BrowserControlRequest,
  BrowserOperatorInputRequest,
  BrowserSessionDto,
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
  ConversationDraftConflictListDto,
  ConversationDraftDto,
  ConversationDto,
  CorrectConversationMessageRequest,
  CorrectConversationMessageResponse,
  CreateAgentPresetRequest,
  CreateAgentRequest,
  CreateCollaborationMessageRequest,
  CreateCollaborationMessageResponse,
  CreateConversationMessageRequest,
  CreateConversationRequest,
  CreateMultiAgentDirectMessageRequest,
  CreateProjectRequest,
  CreateTriggerRequest,
  CreateTriggerResponse,
  DecisionDto,
  DraftAttachmentDto,
  EditQueuedMessageRequest,
  EditQueuedMessageResponse,
  EngineDto,
  EngineModelValidationDto,
  FilesResponse,
  GenerateConversationTitleResponse,
  GlobalChatSearchResponseDto,
  AllChatPageDto,
  CreateHostFolderRequest,
  HostFolderCreateDto,
  HistoryPageDto,
  HostFolderBrowseDto,
  ImageAttachmentDto,
  ImportAgentPackageRequest,
  ImportAgentPackageResponse,
  LetCurrentRunFinishRequest,
  LetCurrentRunFinishResponse,
  MarkWorkspaceResourceUsedRequest,
  RetryMessageDeliveryRequest,
  RetryMessageDeliveryResponse,
  RunOutputTextDto,
  MultiAgentDirectMessageResponse,
  ProjectBrowserControlRequest,
  ProjectBrowserSessionDto,
  ProjectDto,
  ProjectEngineModelCatalogDto,
  ProjectEngineCapabilitiesDto,
  ProviderUsageCenterDto,
  ProviderUsageStateDto,
  ReadinessDto,
  ProjectFolderOptionsDto,
  PutConversationDraftRequest,
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
  TriggerOccurrenceDto,
  UpdateAgentConversationMembershipsRequest,
  UpdateAgentOrganizationRequest,
  UpdateAgentPresetRequest,
  UpdateAgentRequest,
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
  WorkspacePreferencesDto,
  WorkspaceResourceRecencyDto,
  WorkspaceResourceRecencyListDto,
  WorkspaceStatusDto,
  WorkspaceStreamStatusDto,
  WikiArticleDto,
  WikiIndexDto,
  WikiSearchResponseDto,
} from "@ponderosa/core";
import {
  ApiRequestError,
  type CreateAgentOptions,
  type StreamHandlers,
  type StreamSubscription,
  type WorkspaceStreamHandlers,
} from "./types";

const API_BASE = "";

async function requestJson<T>(path: string, init?: RequestInit, acceptedErrorStatuses: number[] = []): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok && !acceptedErrorStatuses.includes(response.status)) {
    let message = `${response.status} ${response.statusText}`;
    if (response.headers.get("content-type")?.includes("application/json")) {
      try {
        const body = await response.json() as { error?: unknown };
        if (typeof body.error === "string" && body.error.trim()) message = body.error.trim();
      } catch {
        // Preserve the stable HTTP fallback when an upstream JSON error is malformed.
      }
    }
    throw new ApiRequestError(response.status, message);
  }

  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return undefined as T;
  }
  const body = await response.text();
  return (body ? JSON.parse(body) : undefined) as T;
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
  getWikiIndex(): Promise<WikiIndexDto> {
    return requestJson<WikiIndexDto>("/api/wiki");
  },
  getAssetLimits(): Promise<AssetLimitsDto> { return requestJson<AssetLimitsDto>("/api/asset-limits"); },
  getWikiArticle(id: string): Promise<WikiArticleDto> {
    return requestJson<WikiArticleDto>(`/api/wiki/articles/${encodeURIComponent(id)}`);
  },
  searchWiki(query: string, limit = 20): Promise<WikiSearchResponseDto> {
    return requestJson<WikiSearchResponseDto>(`/api/wiki/search${toQuery({ q: query, limit })}`);
  },
  listProjects(): Promise<ProjectDto[]> {
    return requestJson<ProjectDto[]>("/api/projects");
  },
  createProject(request: CreateProjectRequest): Promise<ProjectDto> {
    return requestJson<ProjectDto>("/api/projects", {
      method: "POST",
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
  deleteProject(projectId: string): Promise<void> {
    return requestJson<void>(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
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
  searchGlobalChats(query: string, limit?: number): Promise<GlobalChatSearchResponseDto> {
    return requestJson<GlobalChatSearchResponseDto>(`/api/search${toQuery({ q: query, limit })}`);
  },
  getAllChat(limit: number = 50, cursor?: string): Promise<AllChatPageDto> {
    return requestJson<AllChatPageDto>(`/api/all-chat${toQuery({ limit: String(limit), cursor })}`);
  },
  listConversations(projectId: string): Promise<ConversationDto[]> {
    return requestJson<ConversationDto[]>("/api/projects/" + encodeURIComponent(projectId) + "/conversations");
  },
  createConversation(projectId: string, request: CreateConversationRequest): Promise<ConversationDto> {
    return requestJson<ConversationDto>("/api/projects/" + encodeURIComponent(projectId) + "/conversations", {
      method: "POST",
      body: JSON.stringify(request satisfies CreateConversationRequest),
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
  async deleteConversation(conversationId: string): Promise<void> {
    await requestJson("/api/conversations/" + encodeURIComponent(conversationId), { method: "DELETE" });
  },
  async sendConversationMessage(conversationId: string, request: CreateConversationMessageRequest): Promise<void> {
    await requestJson("/api/conversations/" + encodeURIComponent(conversationId) + "/messages", {
      method: "POST",
      body: JSON.stringify(request satisfies CreateConversationMessageRequest),
    });
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
  listNotifications(): Promise<WorkspaceNotificationDto[]> { return requestJson<WorkspaceNotificationDto[]>("/api/notifications"); },
  async markNotificationRead(notificationId: string): Promise<void> { await requestJson(`/api/notifications/${encodeURIComponent(notificationId)}/read`, { method: "POST" }); },
  async clearConversationNotifications(conversationId: string, scope?: "messages"): Promise<void> { await requestJson(`/api/conversations/${encodeURIComponent(conversationId)}/notifications/read`, { method: "POST", ...(scope ? { body: JSON.stringify({ scope }) } : {}) }); },
  async markAllNotificationsRead(): Promise<void> { await requestJson("/api/notifications/read", { method: "POST" }); },
  async clearAllNotifications(): Promise<void> { await requestJson("/api/notifications", { method: "DELETE" }); },
  async clearProjectNotifications(projectId: string): Promise<void> { await requestJson(`/api/projects/${encodeURIComponent(projectId)}/notifications`, { method: "DELETE" }); },
  setNotificationStatus(notificationId: string, status: "resolved" | "dismissed"): Promise<WorkspaceNotificationDto> { return requestJson(`/api/notifications/${encodeURIComponent(notificationId)}/status`, { method: "POST", body: JSON.stringify({ status }) }); },
  listDecisions(filter: { projectId?: string; conversationId?: string; agentId?: string; status?: DecisionDto["status"] } = {}): Promise<DecisionDto[]> { return requestJson<DecisionDto[]>(`/api/decisions${toQuery(filter)}`); },
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
  correctConversationMessage(conversationId: string, messageId: string, request: CorrectConversationMessageRequest): Promise<CorrectConversationMessageResponse> {
    return requestJson(`/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/corrections`, {
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
    return requestJson<AgentDto[]>(`/api/projects/${encodeURIComponent(projectId)}/agents`);
  },
  createAgentRecord(projectId: string, request: CreateAgentRequest): Promise<AgentDto> {
    return requestJson<AgentDto>(`/api/projects/${encodeURIComponent(projectId)}/agents`, {
      method: "POST",
      body: JSON.stringify(request satisfies CreateAgentRequest),
    });
  },
  createAgent(projectId: string, conversationId: string | undefined, options: CreateAgentOptions): Promise<AgentDto> {
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
    });
  },
  listAgentPresets(projectId: string): Promise<AgentPresetDto[]> { return requestJson(`/api/projects/${encodeURIComponent(projectId)}/agent-presets`); },
  createAgentPreset(projectId: string, request: CreateAgentPresetRequest): Promise<AgentPresetDto> { return requestJson(`/api/projects/${encodeURIComponent(projectId)}/agent-presets`, { method: "POST", body: JSON.stringify(request) }); },
  updateAgentPreset(id: string, patch: UpdateAgentPresetRequest): Promise<AgentPresetDto> { return requestJson(`/api/agent-presets/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }); },
  async deleteAgentPreset(id: string): Promise<void> { await requestJson(`/api/agent-presets/${encodeURIComponent(id)}`, { method: "DELETE" }); },
  updateAgent(agentId: string, patch: UpdateAgentRequest): Promise<AgentDto> {
    return requestJson<AgentDto>(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch satisfies UpdateAgentRequest),
    });
  },
  updateAgentConversationMemberships(agentId: string, membership: UpdateAgentConversationMembershipsRequest): Promise<AgentDto> {
    return requestJson<AgentDto>(`/api/agents/${encodeURIComponent(agentId)}/conversation-memberships`, {
      method: "PUT",
      body: JSON.stringify(membership satisfies UpdateAgentConversationMembershipsRequest),
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
  getAgent(agentId: string, limit: number = 100, cursor?: string, focusId?: string): Promise<AgentDetailDto> {
    return requestJson<AgentDetailDto>(`/api/agents/${encodeURIComponent(agentId)}${toQuery({ limit: String(limit), cursor, focusId })}`);
  },
  getAgentHistory(agentId: string, stream: AgentTelemetryStream, limit: number = 100, cursor?: string, focusId?: string): Promise<AgentTelemetryPageDto> {
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
  updateProjectArtifact(projectId: string, artifactId: string, input: { pinned?: boolean; visibility?: "project" | "published" }): Promise<ArtifactDto> {
    return requestJson<ArtifactDto>(`/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },
  exportAgent(agentId: string, mode: AgentExportMode, organization: boolean = false): Promise<AgentPortablePackageDto> {
    return requestJson<AgentPortablePackageDto>(`/api/agents/${encodeURIComponent(agentId)}/export${toQuery({ mode, organization: String(organization) })}`);
  },
  importAgents(projectId: string, request: ImportAgentPackageRequest): Promise<ImportAgentPackageResponse> {
    return requestJson<ImportAgentPackageResponse>(`/api/projects/${encodeURIComponent(projectId)}/import-agents`, { method: "POST", body: JSON.stringify(request satisfies ImportAgentPackageRequest) });
  },
  listTriggers(agentId: string): Promise<TriggerDefinitionDto[]> {
    return requestJson(`/api/agents/${encodeURIComponent(agentId)}/triggers`);
  },
  listAllTriggers(): Promise<TriggerDefinitionDto[]> {
    return requestJson("/api/triggers");
  },
  createTrigger(agentId: string, request: CreateTriggerRequest): Promise<CreateTriggerResponse> {
    return requestJson(`/api/agents/${encodeURIComponent(agentId)}/triggers`, { method: "POST", body: JSON.stringify(request) });
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
  listTriggerOccurrences(triggerId: string, limit: number = 100): Promise<TriggerOccurrenceDto[]> {
    return requestJson(`/api/triggers/${encodeURIComponent(triggerId)}/occurrences?limit=${encodeURIComponent(String(limit))}`);
  },
  listAgentTriggerOccurrences(agentId: string, limit: number = 100): Promise<TriggerOccurrenceDto[]> {
    return requestJson(`/api/agents/${encodeURIComponent(agentId)}/trigger-occurrences?limit=${encodeURIComponent(String(limit))}`);
  },
  listEngines(): Promise<EngineDto[]> {
    return requestJson<EngineDto[]>("/api/engines");
  },
  getReadiness(): Promise<ReadinessDto> {
    return requestJson<ReadinessDto>("/api/ready", undefined, [503]);
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
  getWorkspaceStatus(projectId: string): Promise<WorkspaceStatusDto> {
    return requestJson<WorkspaceStatusDto>(`/api/projects/${encodeURIComponent(projectId)}/workspace`);
  },
  getWorkspaceFile(projectId: string, path: string): Promise<WorkspaceFileReviewDto> {
    return requestJson<WorkspaceFileReviewDto>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/file${toQuery({ path })}`,
    );
  },
  getWorkspaceFileView(projectId: string, path: string): Promise<WorkspaceFileViewDto> {
    return requestJson<WorkspaceFileViewDto>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace-files/view-info${toQuery({ path })}`,
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
  uploadAttachment(agentId: string, file: File): Promise<ImageAttachmentDto> {
    return requestJson<ImageAttachmentDto>(`/api/agents/${encodeURIComponent(agentId)}/attachments`, {
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
    const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/attachments/${encodeURIComponent(attachmentId)}`, { method: "DELETE" });
    if (!response.ok) throw new ApiRequestError(response.status, `${response.status} ${response.statusText}`);
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
  openBrowserSession(projectId: string, agentId: string, runId: string): Promise<BrowserSessionDto> {
    return requestJson<BrowserSessionDto>(browserPath(projectId, agentId, runId), { method: "POST" });
  },
  reconnectBrowserSession(projectId: string, agentId: string, runId: string): Promise<BrowserSessionDto> {
    return requestJson<BrowserSessionDto>(`${browserPath(projectId, agentId, runId)}/reconnect`, { method: "POST" });
  },
  closeBrowserSession(projectId: string, agentId: string, runId: string): Promise<BrowserSessionDto> {
    return requestJson<BrowserSessionDto>(browserPath(projectId, agentId, runId), { method: "DELETE" });
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
  async getBrowserFrame(projectId: string, agentId: string, runId: string): Promise<{ blob: Blob; revision: number }> {
    const response = await fetch(`${browserPath(projectId, agentId, runId)}/frame`, { cache: "no-store" });
    if (!response.ok) throw new ApiRequestError(response.status, `${response.status} ${response.statusText}`);
    return { blob: await response.blob(), revision: Number(response.headers.get("x-ponderosa-browser-revision") ?? 0) };
  },
  getProjectBrowser(projectId: string): Promise<ProjectBrowserSessionDto> {
    return requestJson<ProjectBrowserSessionDto>(`/api/projects/${encodeURIComponent(projectId)}/browser`);
  },
  openProjectBrowser(projectId: string, url?: string): Promise<ProjectBrowserSessionDto> {
    return requestJson<ProjectBrowserSessionDto>(`/api/projects/${encodeURIComponent(projectId)}/browser`, {
      method: "POST", body: JSON.stringify(url ? { url } : {}),
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
  async getProjectBrowserFrame(projectId: string): Promise<{ blob: Blob; revision: number }> {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/browser/frame`, { cache: "no-store" });
    if (!response.ok) throw new ApiRequestError(response.status, `${response.status} ${response.statusText}`);
    return { blob: await response.blob(), revision: Number(response.headers.get("x-ponderosa-browser-revision") ?? 0) };
  },
  subscribeAgent(agentId: string, lastSeenSeq: number | undefined, handlers: StreamHandlers): StreamSubscription {
    const url = `/api/agents/${encodeURIComponent(agentId)}/stream${toQuery({
      lastEventId: lastSeenSeq,
    })}`;
    const source = new EventSource(url);

    source.onopen = () => handlers.onOpen?.();
    source.onerror = (event) => handlers.onError?.(event);
    source.addEventListener("message", (event) => {
      const envelope = JSON.parse(event.data as string) as SseEventEnvelope;
      handlers.onEvent(envelope);
    });
    source.addEventListener("agent_status", (event) => {
      handlers.onStatus?.(JSON.parse(event.data as string) as import("@ponderosa/core").AgentStreamStatusDto);
    });

    return {
      close() {
        source.close();
      },
    };
  },
  subscribeWorkspace(lastSeenId: number | undefined, handlers: WorkspaceStreamHandlers): StreamSubscription {
    const source = new EventSource(`/api/workspace/stream${toQuery({ lastEventId: lastSeenId })}`);
    source.onopen = () => handlers.onOpen?.();
    source.onerror = (event) => handlers.onError?.(event);
    source.addEventListener("message", (event) => handlers.onEvent(JSON.parse(event.data as string) as WorkspaceEventEnvelope));
    source.addEventListener("workspace_status", (event) => handlers.onStatus?.(JSON.parse(event.data as string) as import("@ponderosa/core").WorkspaceStreamStatusDto));
    return { close: () => source.close() };
  },
};
