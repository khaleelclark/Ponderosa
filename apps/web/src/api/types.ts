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

export interface StreamSubscription {
  close(): void;
}

export interface StreamHandlers {
  onEvent(envelope: SseEventEnvelope): void;
  onOpen?(): void;
  onError?(error: unknown): void;
}

export interface PonderosaApi {
  listProjects(): Promise<ProjectDto[]>;
  createProject(request: CreateProjectRequest): Promise<ProjectDto>;
  listThreads(projectId: string): Promise<ThreadDto[]>;
  createThread(projectId: string, request: CreateThreadRequest): Promise<ThreadDto>;
  deleteThread(threadId: string): Promise<void>;
  getThread(threadId: string): Promise<ThreadDetailDto>;
  listEngines(): Promise<EngineDto[]>;
  getArtifact(threadId: string, artifactId: string): Promise<ArtifactContentDto>;
  sendMessage(threadId: string, request: SendMessageRequest): Promise<SendMessageResponse>;
  cancelRun(threadId: string): Promise<void>;
  subscribeThread(threadId: string, lastSeenSeq: number | undefined, handlers: StreamHandlers): StreamSubscription;
}
