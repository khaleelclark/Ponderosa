import type {
  ArtifactContentDto,
  CreateMasterChatMessageRequest,
  CreateMasterChatRequest,
  CreateProjectRequest,
  CreateThreadRequest,
  MasterChatDetailDto,
  MasterChatDto,
  UpdateMasterChatRequest,
  UpdateThreadRequest,
  EngineDto,
  ProjectDto,
  SendMessageRequest,
  SendMessageResponse,
  SseEventEnvelope,
  ThreadDetailDto,
  ThreadDto,
} from "@ponderosa/core";
import type { PonderosaApi, StreamHandlers, StreamSubscription } from "./types";

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
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
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
    });
  },
  updateThread(threadId, patch) {
    return requestJson<ThreadDto>(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch satisfies UpdateThreadRequest),
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
  getArtifact(threadId, artifactId) {
    return requestJson<ArtifactContentDto>(
      `/api/threads/${encodeURIComponent(threadId)}/artifacts/${encodeURIComponent(artifactId)}`,
    );
  },
  sendMessage(threadId, request) {
    return requestJson<SendMessageResponse>(`/api/threads/${encodeURIComponent(threadId)}/messages`, {
      method: "POST",
      body: JSON.stringify(request satisfies SendMessageRequest),
    });
  },
  async cancelRun(threadId) {
    await requestJson(`/api/threads/${encodeURIComponent(threadId)}/cancel`, { method: "POST" });
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
