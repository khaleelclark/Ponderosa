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

/** User-facing options when spawning an agent (a thread) from the UI. */
export interface CreateAgentOptions {
  title: string;
  engine: string;
  model?: string;
  effort?: string;
  /** Starts the first turn as part of creation, avoiding a stranded idle agent. */
  initialMessage?: string;
}

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
  listMasterChats(projectId: string): Promise<MasterChatDto[]>;
  createMasterChat(projectId: string, request: CreateMasterChatRequest): Promise<MasterChatDto>;
  getMasterChat(masterChatId: string): Promise<MasterChatDetailDto>;
  updateMasterChat(masterChatId: string, patch: UpdateMasterChatRequest): Promise<MasterChatDto>;
  deleteMasterChat(masterChatId: string): Promise<void>;
  sendMasterChatMessage(masterChatId: string, request: CreateMasterChatMessageRequest): Promise<void>;
  listThreads(projectId: string): Promise<ThreadDto[]>;
  createThread(projectId: string, request: CreateThreadRequest): Promise<ThreadDto>;
  /** User-facing wrapper around createThread that spawns an agent, optionally under a master chat. */
  createAgent(projectId: string, masterChatId: string | undefined, options: CreateAgentOptions): Promise<ThreadDto>;
  updateThread(threadId: string, patch: UpdateThreadRequest): Promise<ThreadDto>;
  deleteThread(threadId: string): Promise<void>;
  getThread(threadId: string): Promise<ThreadDetailDto>;
  listEngines(): Promise<EngineDto[]>;
  getArtifact(threadId: string, artifactId: string): Promise<ArtifactContentDto>;
  sendMessage(threadId: string, request: SendMessageRequest): Promise<SendMessageResponse>;
  cancelRun(threadId: string): Promise<void>;
  subscribeThread(threadId: string, lastSeenSeq: number | undefined, handlers: StreamHandlers): StreamSubscription;
}
