import type {
  ArtifactContentDto,
  AgentHealthProjectionDto,
  CollaborationViewDto,
  CreateCollaborationMessageRequest,
  CreateCollaborationMessageResponse,
  CreateConversationMessageRequest,
  CreateConversationRequest,
  CreateProjectRequest,
  CreateAgentRequest,
  ConversationDetailDto,
  ConversationDto,
  UpdateConversationRequest,
  UpdateAgentRequest,
  UpdateAgentConversationMembershipsRequest,
  UpdateAgentOrganizationRequest,
  EngineDto,
  ImageAttachmentDto,
  ProjectDto,
  ProjectFolderOptionsDto,
  WorkspaceFileReviewDto,
  WorkspaceStatusDto,
  WorkspacePreferencesDto,
  UpdateWorkspacePreferencesRequest,
  ConversationDraftDto,
  ConversationDraftConflictListDto,
  DraftAttachmentDto,
  PutConversationDraftRequest,
  GenerateConversationTitleResponse,
  WorkspaceNotificationDto,
  WorkspaceEventEnvelope,
  HostFolderBrowseDto,
  UpdateProjectRequest,
  ProjectEngineCapabilitiesDto,
  FilesResponse,
  SendMessageRequest,
  SendMessageResponse,
  SseEventEnvelope,
  AgentDetailDto,
  AgentDto,
  TokenUsageScope,
  TokenUsageRangeDto,
  TokenUsageSummaryDto,
  CancelAgentRunResponse,
  GlobalChatSearchResponseDto,
  BrowserSessionDto,
  BrowserControlRequest,
  BrowserOperatorInputRequest,
} from "@ponderosa/core";
import { ApiRequestError, type PonderosaApi, type StreamHandlers, type StreamSubscription, type WorkspaceStreamHandlers } from "./types";

const API_BASE = "";

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    throw new ApiRequestError(response.status, `${response.status} ${response.statusText}`);
  }

  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return undefined as T;
  }
  const body = await response.text();
  return (body ? JSON.parse(body) : undefined) as T;
}

function toQuery(params: Record<string, string | number | undefined>): string {
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

export const realApi: PonderosaApi = {
  listProjects() {
    return requestJson<ProjectDto[]>("/api/projects");
  },
  createProject(request) {
    return requestJson<ProjectDto>("/api/projects", {
      method: "POST",
      body: JSON.stringify(request satisfies CreateProjectRequest),
    });
  },
  getProjectFolders() {
    return requestJson<ProjectFolderOptionsDto>("/api/project-folders");
  },
  browseProjectFolders(path) {
    return requestJson<HostFolderBrowseDto>(`/api/project-folders/browse${toQuery({ path })}`);
  },
  markProjectUsed(projectId, conversationId) {
    return requestJson<ProjectDto>(`/api/projects/${encodeURIComponent(projectId)}/use`, { method: "POST", body: JSON.stringify({ conversationId }) });
  },
  updateProject(projectId, patch) {
    return requestJson<ProjectDto>(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch satisfies UpdateProjectRequest),
    });
  },
  deleteProject(projectId) {
    return requestJson<void>(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
  },
  getAgentHealth(projectId) {
    return requestJson<AgentHealthProjectionDto>(`/api/projects/${encodeURIComponent(projectId)}/agent-health`);
  },
  getTokenUsage(scope: TokenUsageScope, id?: string, range?: TokenUsageRangeDto) {
    const path = scope === "overall" ? "/api/usage" : `/api/${scope}s/${encodeURIComponent(id ?? "")}/usage`;
    const url = `${path}${toQuery({ from: range?.from, to: range?.to })}`;
    return requestJson<TokenUsageSummaryDto>(url);
  },
  searchGlobalChats(query, limit) {
    return requestJson<GlobalChatSearchResponseDto>(`/api/search${toQuery({ q: query, limit })}`);
  },
  listConversations(projectId) {
    return requestJson<ConversationDto[]>("/api/projects/" + encodeURIComponent(projectId) + "/conversations");
  },
  createConversation(projectId, request) {
    return requestJson<ConversationDto>("/api/projects/" + encodeURIComponent(projectId) + "/conversations", {
      method: "POST",
      body: JSON.stringify(request satisfies CreateConversationRequest),
    });
  },
  getConversation(conversationId) {
    return requestJson<ConversationDetailDto>("/api/conversations/" + encodeURIComponent(conversationId));
  },
  getCollaborationView(conversationId) {
    return requestJson<CollaborationViewDto>(
      "/api/conversations/" + encodeURIComponent(conversationId) + "/collaboration",
    );
  },
  updateConversation(conversationId, patch) {
    return requestJson<ConversationDto>("/api/conversations/" + encodeURIComponent(conversationId), {
      method: "PATCH",
      body: JSON.stringify(patch satisfies UpdateConversationRequest),
    });
  },
  async deleteConversation(conversationId) {
    await requestJson("/api/conversations/" + encodeURIComponent(conversationId), { method: "DELETE" });
  },
  async sendConversationMessage(conversationId, request) {
    await requestJson("/api/conversations/" + encodeURIComponent(conversationId) + "/messages", {
      method: "POST",
      body: JSON.stringify(request satisfies CreateConversationMessageRequest),
    });
  },
  getConversationDraft(conversationId) {
    return requestJson<ConversationDraftDto>(`/api/conversations/${encodeURIComponent(conversationId)}/draft`);
  },
  getConversationDraftConflicts(conversationId) {
    return requestJson<ConversationDraftConflictListDto>(`/api/conversations/${encodeURIComponent(conversationId)}/draft-conflicts`);
  },
  putConversationDraft(conversationId, request) {
    return requestJson<ConversationDraftDto>(`/api/conversations/${encodeURIComponent(conversationId)}/draft`, { method: "PUT", body: JSON.stringify(request satisfies PutConversationDraftRequest) });
  },
  uploadDraftAttachment(conversationId, file) {
    return requestJson<DraftAttachmentDto>(`/api/conversations/${encodeURIComponent(conversationId)}/draft-attachments`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-ponderosa-media-type": file.type || "application/octet-stream",
        "x-ponderosa-filename": file.name,
      },
      body: file,
    });
  },
  async downloadDraftAttachment(attachment) {
    const response = await fetch(attachment.downloadUrl, { cache: "no-store" });
    if (!response.ok) throw new ApiRequestError(response.status, `${response.status} ${response.statusText}`);
    return new File([await response.blob()], attachment.name, { type: attachment.mediaType });
  },
  async deleteDraftAttachment(conversationId, attachmentId) {
    const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/draft-attachments/${encodeURIComponent(attachmentId)}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new ApiRequestError(response.status, `${response.status} ${response.statusText}`);
  },
  generateConversationTitle(conversationId) {
    return requestJson<GenerateConversationTitleResponse>(`/api/conversations/${encodeURIComponent(conversationId)}/generate-title`, { method: "POST" });
  },
  getWorkspacePreferences() { return requestJson<WorkspacePreferencesDto>("/api/workspace/preferences"); },
  updateWorkspacePreferences(request) { return requestJson<WorkspacePreferencesDto>("/api/workspace/preferences", { method: "PATCH", body: JSON.stringify(request satisfies UpdateWorkspacePreferencesRequest) }); },
  listNotifications() { return requestJson<WorkspaceNotificationDto[]>("/api/notifications"); },
  async clearConversationNotifications(conversationId) { await requestJson(`/api/conversations/${encodeURIComponent(conversationId)}/notifications/read`, { method: "POST" }); },
  async markAllNotificationsRead() { await requestJson("/api/notifications/read", { method: "POST" }); },
  async clearAllNotifications() { await requestJson("/api/notifications", { method: "DELETE" }); },
  getWebPushStatus(deviceId) { return requestJson(`/api/push/status${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ""}`); },
  async upsertWebPushSubscription(subscription) {
    await requestJson(`/api/push/subscriptions/${encodeURIComponent(subscription.deviceId)}`, { method: "PUT", body: JSON.stringify(subscription) });
  },
  async deleteWebPushSubscription(deviceId) {
    await requestJson(`/api/push/subscriptions/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
  },
  sendDirectReply(conversationId, request) {
    return requestJson(`/api/conversations/${encodeURIComponent(conversationId)}/direct-replies`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
  sendMultiAgentDirectMessage(conversationId, request) {
    return requestJson(`/api/conversations/${encodeURIComponent(conversationId)}/direct-messages`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
  listQueuedConversationMessages(conversationId) {
    return requestJson(`/api/conversations/${encodeURIComponent(conversationId)}/queued-messages`);
  },
  cancelQueuedConversationMessage(conversationId, deliveryId, request) {
    return requestJson(`/api/conversations/${encodeURIComponent(conversationId)}/queued-messages/${encodeURIComponent(deliveryId)}/cancel`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
  letCurrentRunFinish(injectionId, request) {
    return requestJson(`/api/message-deliveries/${encodeURIComponent(injectionId)}/let-current-run-finish`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
  correctConversationMessage(conversationId, messageId, request) {
    return requestJson(`/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/corrections`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
  sendUserReaction(request) {
    return requestJson("/api/user-reactions", {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
  async sendCollaborationMessage(conversationId, request) {
    return requestJson<CreateCollaborationMessageResponse>("/api/conversations/" + encodeURIComponent(conversationId) + "/collaboration/messages", {
      method: "POST",
      body: JSON.stringify(request satisfies CreateCollaborationMessageRequest),
    });
  },
  listAgents(projectId) {
    return requestJson<AgentDto[]>(`/api/projects/${encodeURIComponent(projectId)}/agents`);
  },
  createAgentRecord(projectId, request) {
    return requestJson<AgentDto>(`/api/projects/${encodeURIComponent(projectId)}/agents`, {
      method: "POST",
      body: JSON.stringify(request satisfies CreateAgentRequest),
    });
  },
  createAgent(projectId, conversationId, options) {
    return this.createAgentRecord(projectId, {
      title: options.title,
      engine: options.engine as CreateAgentRequest["engine"],
      conversationId,
      model: options.model,
      effort: options.effort,
      initialMessage: options.initialMessage,
      draftAttachmentIds: options.draftAttachmentIds,
      replyToMessageId: options.replyToMessageId,
      presetId: options.presetId,
      managerAgentId: options.managerAgentId,
    });
  },
  listAgentPresets(projectId) { return requestJson(`/api/projects/${encodeURIComponent(projectId)}/agent-presets`); },
  createAgentPreset(projectId, request) { return requestJson(`/api/projects/${encodeURIComponent(projectId)}/agent-presets`, { method: "POST", body: JSON.stringify(request) }); },
  updateAgentPreset(id, patch) { return requestJson(`/api/agent-presets/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }); },
  async deleteAgentPreset(id) { await requestJson(`/api/agent-presets/${encodeURIComponent(id)}`, { method: "DELETE" }); },
  updateAgent(agentId, patch) {
    return requestJson<AgentDto>(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch satisfies UpdateAgentRequest),
    });
  },
  updateAgentConversationMemberships(agentId, membership) {
    return requestJson<AgentDto>(`/api/agents/${encodeURIComponent(agentId)}/conversation-memberships`, {
      method: "PUT",
      body: JSON.stringify(membership satisfies UpdateAgentConversationMembershipsRequest),
    });
  },
  updateAgentOrganization(agentId, organization) {
    return requestJson<AgentDto>(`/api/agents/${encodeURIComponent(agentId)}/manager`, {
      method: "PUT",
      body: JSON.stringify(organization satisfies UpdateAgentOrganizationRequest),
    });
  },
  async deleteAgent(agentId) {
    await requestJson(`/api/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });
  },
  getAgent(agentId) {
    return requestJson<AgentDetailDto>(`/api/agents/${encodeURIComponent(agentId)}`);
  },
  listEngines() {
    return requestJson<EngineDto[]>("/api/engines");
  },
  getEngineCapabilities(projectId) {
    return requestJson<ProjectEngineCapabilitiesDto[]>(`/api/projects/${encodeURIComponent(projectId)}/engine-capabilities`);
  },
  getFiles(projectId, path) {
    return requestJson<FilesResponse>(`/api/files${toQuery({ projectId, path })}`);
  },
  getWorkspaceStatus(projectId) {
    return requestJson<WorkspaceStatusDto>(`/api/projects/${encodeURIComponent(projectId)}/workspace`);
  },
  getWorkspaceFile(projectId, path) {
    return requestJson<WorkspaceFileReviewDto>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/file${toQuery({ path })}`,
    );
  },
  getArtifact(agentId, artifactId) {
    return requestJson<ArtifactContentDto>(
      `/api/agents/${encodeURIComponent(agentId)}/artifacts/${encodeURIComponent(artifactId)}`,
    );
  },
  getCommunicationDocument(previewUrl) {
    return requestJson(previewUrl);
  },
  sendMessage(agentId, request) {
    return requestJson<SendMessageResponse>(`/api/agents/${encodeURIComponent(agentId)}/messages`, {
      method: "POST",
      body: JSON.stringify(request satisfies SendMessageRequest),
    });
  },
  uploadAttachment(agentId, file) {
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
  async deleteAttachment(agentId, attachmentId) {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/attachments/${encodeURIComponent(attachmentId)}`, { method: "DELETE" });
    if (!response.ok) throw new ApiRequestError(response.status, `${response.status} ${response.statusText}`);
  },
  cancelRun(agentId, idempotencyKey) {
    return requestJson<CancelAgentRunResponse>(`/api/agents/${encodeURIComponent(agentId)}/cancel`, {
      method: "POST",
      ...(idempotencyKey ? { body: JSON.stringify({ idempotencyKey }) } : {}),
    });
  },
  compactSession(agentId) {
    return requestJson<{ compacted: boolean }>(`/api/agents/${encodeURIComponent(agentId)}/compact`, { method: "POST" });
  },
  getBrowserSession(projectId, agentId, runId) {
    return requestJson<BrowserSessionDto>(browserPath(projectId, agentId, runId));
  },
  openBrowserSession(projectId, agentId, runId) {
    return requestJson<BrowserSessionDto>(browserPath(projectId, agentId, runId), { method: "POST" });
  },
  reconnectBrowserSession(projectId, agentId, runId) {
    return requestJson<BrowserSessionDto>(`${browserPath(projectId, agentId, runId)}/reconnect`, { method: "POST" });
  },
  closeBrowserSession(projectId, agentId, runId) {
    return requestJson<BrowserSessionDto>(browserPath(projectId, agentId, runId), { method: "DELETE" });
  },
  setBrowserControl(projectId, agentId, runId, request) {
    return requestJson<BrowserSessionDto>(`${browserPath(projectId, agentId, runId)}/control`, {
      method: "PUT", body: JSON.stringify(request satisfies BrowserControlRequest),
    });
  },
  sendBrowserInput(projectId, agentId, runId, request) {
    return requestJson<BrowserSessionDto>(`${browserPath(projectId, agentId, runId)}/input`, {
      method: "POST", body: JSON.stringify(request satisfies BrowserOperatorInputRequest),
    });
  },
  async getBrowserFrame(projectId, agentId, runId) {
    const response = await fetch(`${browserPath(projectId, agentId, runId)}/frame`, { cache: "no-store" });
    if (!response.ok) throw new ApiRequestError(response.status, `${response.status} ${response.statusText}`);
    return { blob: await response.blob(), revision: Number(response.headers.get("x-ponderosa-browser-revision") ?? 0) };
  },
  subscribeAgent(agentId, lastSeenSeq, handlers): StreamSubscription {
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
  subscribeWorkspace(lastSeenId, handlers: WorkspaceStreamHandlers): StreamSubscription {
    const source = new EventSource(`/api/workspace/stream${toQuery({ lastEventId: lastSeenId })}`);
    source.onopen = () => handlers.onOpen?.();
    source.onerror = (event) => handlers.onError?.(event);
    source.addEventListener("message", (event) => handlers.onEvent(JSON.parse(event.data as string) as WorkspaceEventEnvelope));
    source.addEventListener("workspace_status", (event) => handlers.onStatus?.(JSON.parse(event.data as string) as import("@ponderosa/core").WorkspaceStreamStatusDto));
    return { close: () => source.close() };
  },
};
