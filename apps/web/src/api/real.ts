import type {
  ArtifactContentDto,
  AgentHealthProjectionDto,
  CollaborationChatDetailDto,
  CreateCollaborationMessageRequest,
  CreateCollaborationMessageResponse,
  CreateMasterChatMessageRequest,
  CreateMasterChatRequest,
  CreateProjectRequest,
  CreateThreadRequest,
  MasterChatDetailDto,
  MasterChatDto,
  UpdateMasterChatRequest,
  UpdateThreadRequest,
  UpdateThreadMasterChatMembershipsRequest,
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
  ThreadDetailDto,
  ThreadDto,
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
  listMasterChats(projectId) {
    return requestJson<MasterChatDto[]>("/api/projects/" + encodeURIComponent(projectId) + "/master-chats");
  },
  createMasterChat(projectId, request) {
    return requestJson<MasterChatDto>("/api/projects/" + encodeURIComponent(projectId) + "/master-chats", {
      method: "POST",
      body: JSON.stringify(request satisfies CreateMasterChatRequest),
    });
  },
  getMasterChat(masterChatId) {
    return requestJson<MasterChatDetailDto>("/api/master-chats/" + encodeURIComponent(masterChatId));
  },
  getCollaborationChat(masterChatId) {
    return requestJson<CollaborationChatDetailDto>(
      "/api/master-chats/" + encodeURIComponent(masterChatId) + "/collaboration",
    );
  },
  updateMasterChat(masterChatId, patch) {
    return requestJson<MasterChatDto>("/api/master-chats/" + encodeURIComponent(masterChatId), {
      method: "PATCH",
      body: JSON.stringify(patch satisfies UpdateMasterChatRequest),
    });
  },
  async deleteMasterChat(masterChatId) {
    await requestJson("/api/master-chats/" + encodeURIComponent(masterChatId), { method: "DELETE" });
  },
  async sendMasterChatMessage(masterChatId, request) {
    await requestJson("/api/master-chats/" + encodeURIComponent(masterChatId) + "/messages", {
      method: "POST",
      body: JSON.stringify(request satisfies CreateMasterChatMessageRequest),
    });
  },
  sendDirectReply(masterChatId, request) {
    return requestJson(`/api/master-chats/${encodeURIComponent(masterChatId)}/direct-replies`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
  sendMultiAgentDirectMessage(masterChatId, request) {
    return requestJson(`/api/master-chats/${encodeURIComponent(masterChatId)}/direct-messages`, {
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
  async sendCollaborationMessage(masterChatId, request) {
    return requestJson<CreateCollaborationMessageResponse>("/api/master-chats/" + encodeURIComponent(masterChatId) + "/collaboration/messages", {
      method: "POST",
      body: JSON.stringify(request satisfies CreateCollaborationMessageRequest),
    });
  },
  listThreads(projectId) {
    return requestJson<ThreadDto[]>(`/api/projects/${encodeURIComponent(projectId)}/threads`);
  },
  createThread(projectId, request) {
    return requestJson<ThreadDto>(`/api/projects/${encodeURIComponent(projectId)}/threads`, {
      method: "POST",
      body: JSON.stringify(request satisfies CreateThreadRequest),
    });
  },
  createAgent(projectId, masterChatId, options) {
    return this.createThread(projectId, {
      title: options.title,
      engine: options.engine as CreateThreadRequest["engine"],
      masterChatId,
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
  updateThread(threadId, patch) {
    return requestJson<ThreadDto>(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch satisfies UpdateThreadRequest),
    });
  },
  updateThreadMasterChatMemberships(threadId, membership) {
    return requestJson<ThreadDto>(`/api/threads/${encodeURIComponent(threadId)}/master-chat-memberships`, {
      method: "PUT",
      body: JSON.stringify(membership satisfies UpdateThreadMasterChatMembershipsRequest),
    });
  },
  updateAgentOrganization(threadId, organization) {
    return requestJson<ThreadDto>(`/api/threads/${encodeURIComponent(threadId)}/manager`, {
      method: "PUT",
      body: JSON.stringify(organization satisfies UpdateAgentOrganizationRequest),
    });
  },
  async deleteThread(threadId) {
    await requestJson(`/api/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
  },
  getThread(threadId) {
    return requestJson<ThreadDetailDto>(`/api/threads/${encodeURIComponent(threadId)}`);
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
  getArtifact(threadId, artifactId) {
    return requestJson<ArtifactContentDto>(
      `/api/threads/${encodeURIComponent(threadId)}/artifacts/${encodeURIComponent(artifactId)}`,
    );
  },
  getCommunicationDocument(previewUrl) {
    return requestJson(previewUrl);
  },
  sendMessage(threadId, request) {
    return requestJson<SendMessageResponse>(`/api/threads/${encodeURIComponent(threadId)}/messages`, {
      method: "POST",
      body: JSON.stringify(request satisfies SendMessageRequest),
    });
  },
  uploadAttachment(threadId, file) {
    return requestJson<ImageAttachmentDto>(`/api/threads/${encodeURIComponent(threadId)}/attachments`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-ponderosa-media-type": file.type || "application/octet-stream",
        "x-ponderosa-filename": file.name,
      },
      body: file,
    });
  },
  async deleteAttachment(threadId, attachmentId) {
    const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(attachmentId)}`, { method: "DELETE" });
    if (!response.ok) throw new ApiRequestError(response.status, `${response.status} ${response.statusText}`);
  },
  async cancelRun(threadId) {
    await requestJson(`/api/threads/${encodeURIComponent(threadId)}/cancel`, { method: "POST" });
  },
  compactSession(threadId) {
    return requestJson<{ compacted: boolean }>(`/api/threads/${encodeURIComponent(threadId)}/compact`, { method: "POST" });
  },
  subscribeThread(threadId, lastSeenSeq, handlers): StreamSubscription {
    const url = `/api/threads/${encodeURIComponent(threadId)}/stream${toQuery({
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
