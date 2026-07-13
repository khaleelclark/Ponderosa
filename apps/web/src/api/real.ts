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
  UpdateProjectRequest,
  ProjectEngineCapabilitiesDto,
  FilesResponse,
  SendMessageRequest,
  SendMessageResponse,
  SseEventEnvelope,
  AgentDetailDto,
  AgentDto,
} from "@ponderosa/core";
import { ApiRequestError, type PonderosaApi, type StreamHandlers, type StreamSubscription } from "./types";

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
  async cancelRun(agentId) {
    await requestJson(`/api/agents/${encodeURIComponent(agentId)}/cancel`, { method: "POST" });
  },
  compactSession(agentId) {
    return requestJson<{ compacted: boolean }>(`/api/agents/${encodeURIComponent(agentId)}/compact`, { method: "POST" });
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

    return {
      close() {
        source.close();
      },
    };
  },
};
