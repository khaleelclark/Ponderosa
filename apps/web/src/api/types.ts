import type {
  ArtifactContentDto,
  CommunicationDocumentContentDto,
  AgentHealthProjectionDto,
  AgentPresetDto, CreateAgentPresetRequest, UpdateAgentPresetRequest,
  CollaborationViewDto,
  CreateCollaborationMessageRequest,
  CreateCollaborationMessageResponse,
  CreateDirectReplyRequest,
  CreateMultiAgentDirectMessageRequest,
  CreateConversationMessageRequest,
  CreateConversationRequest,
  CreateUserReactionRequest,
  CreateUserReactionResponse,
  CreateProjectRequest,
  CreateThreadRequest,
  ConversationDetailDto,
  ConversationDto,
  UpdateConversationRequest,
  UpdateThreadRequest,
  UpdateThreadConversationMembershipsRequest,
  UpdateAgentOrganizationRequest,
  EngineDto,
  DirectReplyResponse,
  MultiAgentDirectMessageResponse,
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
  managerAgentId?: string;
}

export interface StreamSubscription {
  close(): void;
}

export interface StreamHandlers {
  onEvent(envelope: SseEventEnvelope): void;
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
  getProjectFolders(): Promise<ProjectFolderOptionsDto>;
  updateProject(projectId: string, request: UpdateProjectRequest): Promise<ProjectDto>;
  deleteProject(projectId: string): Promise<void>;
  getAgentHealth(projectId: string): Promise<AgentHealthProjectionDto>;
  listConversations(projectId: string): Promise<ConversationDto[]>;
  createConversation(projectId: string, request: CreateConversationRequest): Promise<ConversationDto>;
  getConversation(conversationId: string): Promise<ConversationDetailDto>;
  getCollaborationView(conversationId: string): Promise<CollaborationViewDto>;
  updateConversation(conversationId: string, patch: UpdateConversationRequest): Promise<ConversationDto>;
  deleteConversation(conversationId: string): Promise<void>;
  sendConversationMessage(conversationId: string, request: CreateConversationMessageRequest): Promise<void>;
  sendCollaborationMessage(conversationId: string, request: CreateCollaborationMessageRequest): Promise<CreateCollaborationMessageResponse>;
  sendDirectReply(conversationId: string, request: CreateDirectReplyRequest): Promise<DirectReplyResponse>;
  sendMultiAgentDirectMessage(conversationId: string, request: CreateMultiAgentDirectMessageRequest): Promise<MultiAgentDirectMessageResponse>;
  sendUserReaction(request: CreateUserReactionRequest): Promise<CreateUserReactionResponse>;
  listThreads(projectId: string): Promise<ThreadDto[]>;
  listAgentPresets(projectId: string): Promise<AgentPresetDto[]>;
  createAgentPreset(projectId: string, request: CreateAgentPresetRequest): Promise<AgentPresetDto>;
  updateAgentPreset(id: string, patch: UpdateAgentPresetRequest): Promise<AgentPresetDto>;
  deleteAgentPreset(id: string): Promise<void>;
  createThread(projectId: string, request: CreateThreadRequest): Promise<ThreadDto>;
  /** User-facing wrapper around createThread that spawns an agent, optionally under a conversation. */
  createAgent(projectId: string, conversationId: string | undefined, options: CreateAgentOptions): Promise<ThreadDto>;
  updateThread(threadId: string, patch: UpdateThreadRequest): Promise<ThreadDto>;
  updateThreadConversationMemberships(threadId: string, request: UpdateThreadConversationMembershipsRequest): Promise<ThreadDto>;
  updateAgentOrganization(threadId: string, request: UpdateAgentOrganizationRequest): Promise<ThreadDto>;
  deleteThread(threadId: string): Promise<void>;
  getThread(threadId: string): Promise<ThreadDetailDto>;
  listEngines(): Promise<EngineDto[]>;
  getEngineCapabilities(projectId: string): Promise<ProjectEngineCapabilitiesDto[]>;
  getFiles(projectId: string, path?: string): Promise<FilesResponse>;
  getWorkspaceStatus(projectId: string): Promise<WorkspaceStatusDto>;
  getWorkspaceFile(projectId: string, path: string): Promise<WorkspaceFileReviewDto>;
  getArtifact(threadId: string, artifactId: string): Promise<ArtifactContentDto>;
  getCommunicationDocument(previewUrl: string): Promise<CommunicationDocumentContentDto>;
  sendMessage(threadId: string, request: SendMessageRequest): Promise<SendMessageResponse>;
  uploadAttachment(threadId: string, file: File): Promise<ImageAttachmentDto>;
  deleteAttachment(threadId: string, attachmentId: string): Promise<void>;
  cancelRun(threadId: string): Promise<void>;
  compactSession(threadId: string): Promise<{ compacted: boolean }>;
  subscribeThread(threadId: string, lastSeenSeq: number | undefined, handlers: StreamHandlers): StreamSubscription;
}
