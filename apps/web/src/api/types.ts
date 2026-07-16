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
  CreateAgentRequest,
  ConversationDetailDto,
  ConversationDto,
  UpdateConversationRequest,
  UpdateAgentRequest,
  UpdateAgentConversationMembershipsRequest,
  UpdateAgentOrganizationRequest,
  EngineDto,
  DirectReplyResponse,
  MultiAgentDirectMessageResponse,
  QueuedConversationMessageDto,
  CancelQueuedMessageRequest,
  CancelQueuedMessageResponse,
  LetCurrentRunFinishRequest,
  LetCurrentRunFinishResponse,
  CorrectConversationMessageRequest,
  CorrectConversationMessageResponse,
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
  WorkspaceStreamStatusDto,
  HostFolderBrowseDto,
  WebPushSubscriptionDto,
  WebPushStatusDto,
  UpdateProjectRequest,
  ProjectEngineCapabilitiesDto,
  FilesResponse,
  SendMessageRequest,
  SendMessageResponse,
  SseEventEnvelope,
  AgentStreamStatusDto,
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

/** User-facing options when spawning an agent from the UI. */
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
  onStatus?(status: AgentStreamStatusDto): void;
  onOpen?(): void;
  onError?(error: unknown): void;
}

export interface WorkspaceStreamHandlers {
  onEvent(envelope: WorkspaceEventEnvelope): void;
  onStatus?(status: WorkspaceStreamStatusDto): void;
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
  browseProjectFolders(path?: string): Promise<HostFolderBrowseDto>;
  markProjectUsed(projectId: string, conversationId?: string): Promise<ProjectDto>;
  updateProject(projectId: string, request: UpdateProjectRequest): Promise<ProjectDto>;
  deleteProject(projectId: string): Promise<void>;
  getAgentHealth(projectId: string): Promise<AgentHealthProjectionDto>;
  getTokenUsage(scope: TokenUsageScope, id?: string, range?: TokenUsageRangeDto): Promise<TokenUsageSummaryDto>;
  searchGlobalChats(query: string, limit?: number): Promise<GlobalChatSearchResponseDto>;
  listConversations(projectId: string): Promise<ConversationDto[]>;
  createConversation(projectId: string, request: CreateConversationRequest): Promise<ConversationDto>;
  getConversation(conversationId: string): Promise<ConversationDetailDto>;
  getCollaborationView(conversationId: string): Promise<CollaborationViewDto>;
  updateConversation(conversationId: string, patch: UpdateConversationRequest): Promise<ConversationDto>;
  deleteConversation(conversationId: string): Promise<void>;
  sendConversationMessage(conversationId: string, request: CreateConversationMessageRequest): Promise<void>;
  getConversationDraft(conversationId: string): Promise<ConversationDraftDto>;
  getConversationDraftConflicts(conversationId: string): Promise<ConversationDraftConflictListDto>;
  putConversationDraft(conversationId: string, request: PutConversationDraftRequest): Promise<ConversationDraftDto>;
  uploadDraftAttachment(conversationId: string, file: File): Promise<DraftAttachmentDto>;
  downloadDraftAttachment(attachment: DraftAttachmentDto): Promise<File>;
  deleteDraftAttachment(conversationId: string, attachmentId: string): Promise<void>;
  generateConversationTitle(conversationId: string): Promise<GenerateConversationTitleResponse>;
  getWorkspacePreferences(): Promise<WorkspacePreferencesDto>;
  updateWorkspacePreferences(request: UpdateWorkspacePreferencesRequest): Promise<WorkspacePreferencesDto>;
  listNotifications(): Promise<WorkspaceNotificationDto[]>;
  clearConversationNotifications(conversationId: string): Promise<void>;
  markAllNotificationsRead(): Promise<void>;
  clearAllNotifications(): Promise<void>;
  getWebPushStatus(deviceId?: string): Promise<WebPushStatusDto>;
  upsertWebPushSubscription(subscription: WebPushSubscriptionDto): Promise<void>;
  deleteWebPushSubscription(deviceId: string): Promise<void>;
  sendCollaborationMessage(conversationId: string, request: CreateCollaborationMessageRequest): Promise<CreateCollaborationMessageResponse>;
  sendDirectReply(conversationId: string, request: CreateDirectReplyRequest): Promise<DirectReplyResponse>;
  sendMultiAgentDirectMessage(conversationId: string, request: CreateMultiAgentDirectMessageRequest): Promise<MultiAgentDirectMessageResponse>;
  listQueuedConversationMessages(conversationId: string): Promise<QueuedConversationMessageDto[]>;
  cancelQueuedConversationMessage(conversationId: string, deliveryId: string, request: CancelQueuedMessageRequest): Promise<CancelQueuedMessageResponse>;
  letCurrentRunFinish(injectionId: string, request: LetCurrentRunFinishRequest): Promise<LetCurrentRunFinishResponse>;
  correctConversationMessage(conversationId: string, messageId: string, request: CorrectConversationMessageRequest): Promise<CorrectConversationMessageResponse>;
  sendUserReaction(request: CreateUserReactionRequest): Promise<CreateUserReactionResponse>;
  listAgents(projectId: string): Promise<AgentDto[]>;
  listAgentPresets(projectId: string): Promise<AgentPresetDto[]>;
  createAgentPreset(projectId: string, request: CreateAgentPresetRequest): Promise<AgentPresetDto>;
  updateAgentPreset(id: string, patch: UpdateAgentPresetRequest): Promise<AgentPresetDto>;
  deleteAgentPreset(id: string): Promise<void>;
  createAgentRecord(projectId: string, request: CreateAgentRequest): Promise<AgentDto>;
  /** User-facing wrapper that creates an agent, optionally under a conversation. */
  createAgent(projectId: string, conversationId: string | undefined, options: CreateAgentOptions): Promise<AgentDto>;
  updateAgent(agentId: string, patch: UpdateAgentRequest): Promise<AgentDto>;
  updateAgentConversationMemberships(agentId: string, request: UpdateAgentConversationMembershipsRequest): Promise<AgentDto>;
  updateAgentOrganization(agentId: string, request: UpdateAgentOrganizationRequest): Promise<AgentDto>;
  deleteAgent(agentId: string): Promise<void>;
  getAgent(agentId: string): Promise<AgentDetailDto>;
  listEngines(): Promise<EngineDto[]>;
  getEngineCapabilities(projectId: string): Promise<ProjectEngineCapabilitiesDto[]>;
  getFiles(projectId: string, path?: string): Promise<FilesResponse>;
  getWorkspaceStatus(projectId: string): Promise<WorkspaceStatusDto>;
  getWorkspaceFile(projectId: string, path: string): Promise<WorkspaceFileReviewDto>;
  getArtifact(agentId: string, artifactId: string): Promise<ArtifactContentDto>;
  getCommunicationDocument(previewUrl: string): Promise<CommunicationDocumentContentDto>;
  sendMessage(agentId: string, request: SendMessageRequest): Promise<SendMessageResponse>;
  uploadAttachment(agentId: string, file: File): Promise<ImageAttachmentDto>;
  deleteAttachment(agentId: string, attachmentId: string): Promise<void>;
  cancelRun(agentId: string, idempotencyKey?: string): Promise<CancelAgentRunResponse>;
  compactSession(agentId: string): Promise<{ compacted: boolean }>;
  getBrowserSession(projectId: string, agentId: string, runId: string): Promise<BrowserSessionDto>;
  openBrowserSession(projectId: string, agentId: string, runId: string): Promise<BrowserSessionDto>;
  reconnectBrowserSession(projectId: string, agentId: string, runId: string): Promise<BrowserSessionDto>;
  closeBrowserSession(projectId: string, agentId: string, runId: string): Promise<BrowserSessionDto>;
  setBrowserControl(projectId: string, agentId: string, runId: string, request: BrowserControlRequest): Promise<BrowserSessionDto>;
  sendBrowserInput(projectId: string, agentId: string, runId: string, request: BrowserOperatorInputRequest): Promise<BrowserSessionDto>;
  getBrowserFrame(projectId: string, agentId: string, runId: string): Promise<{ blob: Blob; revision: number }>;
  subscribeAgent(agentId: string, lastSeenSeq: number | undefined, handlers: StreamHandlers): StreamSubscription;
  subscribeWorkspace(lastSeenId: number | undefined, handlers: WorkspaceStreamHandlers): StreamSubscription;
}
