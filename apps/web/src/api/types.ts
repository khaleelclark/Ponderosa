import type {
  ArtifactContentDto,
  AgentHealthProjectionDto,
  AgentPresetDto, CreateAgentPresetRequest, UpdateAgentPresetRequest,
  CollaborationChatDetailDto,
  CreateCollaborationMessageRequest,
  CreateCollaborationMessageResponse,
  CreateDirectReplyRequest,
  CreateMultiAgentDirectMessageRequest,
  CreateMasterChatMessageRequest,
  CreateMasterChatRequest,
  CreateProjectRequest,
  CreateThreadRequest,
  MasterChatDetailDto,
  MasterChatDto,
  UpdateMasterChatRequest,
  UpdateThreadRequest,
  UpdateThreadMasterChatMembershipsRequest,
  EngineDto,
  DirectReplyResponse,
  MultiAgentDirectMessageResponse,
  ImageAttachmentDto,
  ProjectDto,
  ProjectEngineCapabilitiesDto,
  FilesResponse,
  SendMessageRequest,
  SendMessageResponse,
  SseEventEnvelope,
  SubagentEventEnvelope,
  SubagentRunDto,
  CancelSubagentRequest,
  CancelSubagentResponse,
  ThreadDetailDto,
  ThreadDto,
  ReactionEmoji,
  SetMessageReactionResponse,
} from "@ponderosa/core";

/** User-facing options when spawning an agent (a thread) from the UI. */
export interface CreateAgentOptions {
  title: string;
  engine: string;
  model?: string;
  effort?: string;
  /** Starts the first turn as part of creation, avoiding a stranded idle agent. */
  initialMessage?: string;
  replyToMessageId?: string;
  presetId?: string;
}

export interface StreamSubscription {
  close(): void;
}

export interface StreamHandlers {
  onEvent(envelope: SseEventEnvelope): void;
  onOpen?(): void;
  onError?(error: unknown): void;
}

export interface SubagentStreamHandlers {
  onEvent(envelope: SubagentEventEnvelope): void;
  onOpen?(): void;
  onError?(error: unknown): void;
}

export class ApiRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface PonderosaApi {
  listProjects(): Promise<ProjectDto[]>;
  createProject(request: CreateProjectRequest): Promise<ProjectDto>;
  getAgentHealth(projectId: string): Promise<AgentHealthProjectionDto>;
  listMasterChats(projectId: string): Promise<MasterChatDto[]>;
  createMasterChat(projectId: string, request: CreateMasterChatRequest): Promise<MasterChatDto>;
  getMasterChat(masterChatId: string): Promise<MasterChatDetailDto>;
  getCollaborationChat(masterChatId: string): Promise<CollaborationChatDetailDto>;
  updateMasterChat(masterChatId: string, patch: UpdateMasterChatRequest): Promise<MasterChatDto>;
  deleteMasterChat(masterChatId: string): Promise<void>;
  sendMasterChatMessage(masterChatId: string, request: CreateMasterChatMessageRequest): Promise<void>;
  sendCollaborationMessage(masterChatId: string, request: CreateCollaborationMessageRequest): Promise<CreateCollaborationMessageResponse>;
  sendDirectReply(masterChatId: string, request: CreateDirectReplyRequest): Promise<DirectReplyResponse>;
  sendMultiAgentDirectMessage(masterChatId: string, request: CreateMultiAgentDirectMessageRequest): Promise<MultiAgentDirectMessageResponse>;
  setMessageReaction(masterChatId: string, channel: "main" | "collaboration", messageId: string, emoji: ReactionEmoji, active: boolean, idempotencyKey: string): Promise<SetMessageReactionResponse>;
  listSubagents(masterChatId: string): Promise<SubagentRunDto[]>;
  cancelSubagent(runId: string, request: CancelSubagentRequest): Promise<CancelSubagentResponse>;
  subscribeSubagents(masterChatId: string, lastSeenSeq: number | undefined, handlers: SubagentStreamHandlers): StreamSubscription;
  listThreads(projectId: string): Promise<ThreadDto[]>;
  listAgentPresets(projectId: string): Promise<AgentPresetDto[]>;
  createAgentPreset(projectId: string, request: CreateAgentPresetRequest): Promise<AgentPresetDto>;
  updateAgentPreset(id: string, patch: UpdateAgentPresetRequest): Promise<AgentPresetDto>;
  deleteAgentPreset(id: string): Promise<void>;
  createThread(projectId: string, request: CreateThreadRequest): Promise<ThreadDto>;
  /** User-facing wrapper around createThread that spawns an agent, optionally under a master chat. */
  createAgent(projectId: string, masterChatId: string | undefined, options: CreateAgentOptions): Promise<ThreadDto>;
  updateThread(threadId: string, patch: UpdateThreadRequest): Promise<ThreadDto>;
  updateThreadMasterChatMemberships(threadId: string, request: UpdateThreadMasterChatMembershipsRequest): Promise<ThreadDto>;
  deleteThread(threadId: string): Promise<void>;
  getThread(threadId: string): Promise<ThreadDetailDto>;
  listEngines(): Promise<EngineDto[]>;
  getEngineCapabilities(projectId: string): Promise<ProjectEngineCapabilitiesDto[]>;
  getFiles(projectId: string, path?: string): Promise<FilesResponse>;
  getArtifact(threadId: string, artifactId: string): Promise<ArtifactContentDto>;
  sendMessage(threadId: string, request: SendMessageRequest): Promise<SendMessageResponse>;
  uploadAttachment(threadId: string, file: File): Promise<ImageAttachmentDto>;
  deleteAttachment(threadId: string, attachmentId: string): Promise<void>;
  cancelRun(threadId: string): Promise<void>;
  compactSession(threadId: string): Promise<{ compacted: boolean }>;
  subscribeThread(threadId: string, lastSeenSeq: number | undefined, handlers: StreamHandlers): StreamSubscription;
}
