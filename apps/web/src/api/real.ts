import type {
  ArtifactContentDto,
  CreateProjectRequest,
  CreateThreadRequest,
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
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
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
  listThreads(projectId) {
    return requestJson<ThreadDto[]>(`/api/projects/${encodeURIComponent(projectId)}/threads`);
  },
  createThread(projectId, request) {
    return requestJson<ThreadDto>(`/api/projects/${encodeURIComponent(projectId)}/threads`, {
      method: "POST",
      body: JSON.stringify(request satisfies CreateThreadRequest),
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
