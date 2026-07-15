import type {
  AgentPresetDto,
  ArtifactContentDto,
  ArtifactDto,
  EngineDto,
  ConversationDto,
  ConversationMessageDto,
  CollaborationViewDto,
  MessageDto,
  ProjectDto,
  SendMessageRequest,
  SendMessageResponse,
  SseEventEnvelope,
  AgentRunDto,
  WorkItemDto,
  AgentDetailDto,
  AgentDto,
  TokenUsageScope,
  TokenUsageRangeDto,
  CancelAgentRunResponse,
} from "@ponderosa/core";
import type { PonderosaApi, StreamHandlers, StreamSubscription } from "./types";

const now = new Date("2026-07-09T19:00:00.000Z").toISOString();

const projects: ProjectDto[] = [
  {
    id: "ponderosa",
    label: "Ponderosa",
    hostPath: "/Users/khaleel/Projects/Ponderosa",
    createdAt: now,
    lastUsedAt: now,
    defaultEngine: "codex",
    lastConversationId: "master-release",
  },
  {
    id: "mobile",
    label: "Mobile App",
    hostPath: "/home/khaleel/projects/mobile",
    createdAt: now,
    defaultEngine: "codex",
    lastConversationId: "master-mobile",
  },
];

const conversations: ConversationDto[] = [
  { id: "master-release", projectId: "ponderosa", title: "Release coordination", createdAt: now, updatedAt: now, archived: false },
  { id: "master-mobile", projectId: "mobile", title: "Mobile quality", createdAt: now, updatedAt: now, archived: false },
];

const masterMessages: Record<string, ConversationMessageDto[]> = {
  "master-release": [{ id: "master-note-1", conversationId: "master-release", role: "user", text: "Keep this release stable and split work into focused agents.", createdAt: now }],
  "master-mobile": [],
};
const collaborationMessages: Record<string, ConversationMessageDto[]> = {};
const agentPresets: AgentPresetDto[] = [];
const drafts = new Map<string, import("@ponderosa/core").ConversationDraftDto>();
const draftAttachments = new Map<string, { dto: import("@ponderosa/core").DraftAttachmentDto; file: File }>();
let workspacePreferences: import("@ponderosa/core").WorkspacePreferencesDto = { projectSort: "last_used", projectOrder: [], sidebarCollapsed: false, sidebarWidth: 288, notifications: { mentions: true, directReplies: true, projectChatMessages: true, broadcasts: true, allMessages: false }, fontFamily: "inter", updatedAt: now };

const agents: AgentDto[] = [
  {
    id: "agent-auth",
    projectId: "ponderosa",
    conversationId: "master-release",
    conversationIds: ["master-release"],
    title: "Chunk G web PWA",
    activeEngine: "codex",
    state: { branch: "feature/web-pwa", commit: "local" },
    createdAt: now,
    updatedAt: now,
    archived: false,
  },
  {
    id: "agent-sse",
    projectId: "ponderosa",
    conversationIds: [],
    title: "SSE reconnect audit",
    activeEngine: "codex",
    state: { branch: "main", commit: "b7f4c2a" },
    createdAt: now,
    updatedAt: now,
    archived: false,
  },
  {
    id: "agent-login",
    projectId: "mobile",
    conversationIds: [],
    title: "Phone login regression",
    activeEngine: "codex",
    state: { branch: "fix/login" },
    createdAt: now,
    updatedAt: now,
    archived: false,
  },
];

const messages: Record<string, MessageDto[]> = {
  "agent-auth": [
    {
      id: "m1",
      agentId: "agent-auth",
      seq: 1,
      role: "user",
      text: "Implement the mobile-first Ponderosa web shell.",
      createdAt: now,
    },
    {
      id: "m2",
      agentId: "agent-auth",
      seq: 2,
      role: "assistant",
      text: "I have the shell structure mapped and will keep execution detail in Runs and Files & results.",
      createdAt: now,
    },
  ],
  "agent-sse": [
    {
      id: "m3",
      agentId: "agent-sse",
      seq: 1,
      role: "user",
      text: "Verify reconnect behavior when the phone sleeps.",
      createdAt: now,
    },
  ],
  "agent-login": [
    {
      id: "m4",
      agentId: "agent-login",
      seq: 1,
      role: "user",
      text: "Find why mobile login started failing after the auth refactor.",
      createdAt: now,
    },
  ],
};

const runs: Record<string, AgentRunDto[]> = {
  "agent-auth": [
    {
      id: "run-ui",
      agentId: "agent-auth",
      title: "Build responsive shell",
      status: "running",
      reason: "active_run",
      engine: "codex",
      startedAt: now,
      updatedAt: now,
    },
  ],
  "agent-sse": [
    {
      id: "run-stream",
      agentId: "agent-sse",
      title: "Replay missed events from seq",
      status: "completed",
      reason: "turn_completed",
      engine: "codex",
      startedAt: now,
      updatedAt: now,
      completedAt: now,
    },
  ],
  "agent-login": [],
};

const workItems: Record<string, WorkItemDto[]> = {
  "agent-auth": [{ id: "agent-auth:work-item:pwa", agentId: "agent-auth", executionId: "run-ui", title: "Add manifest and shell caching", status: "waiting_approval", createdAt: now, updatedAt: now }],
  "agent-sse": [],
  "agent-login": [],
};

const artifacts: Record<string, ArtifactDto[]> = {
  "agent-auth": [
    {
      id: "artifact-diff-app",
      agentId: "agent-auth",
      executionId: "run-ui",
      kind: "diff",
      path: "apps/web/src/App.tsx.diff",
      summary: "Responsive workbench shell",
      createdAt: now,
    },
    {
      id: "artifact-report",
      agentId: "agent-auth",
      executionId: "run-ui",
      kind: "test_report",
      path: "reports/web-build.md",
      summary: "Latest web build notes",
      createdAt: now,
    },
  ],
  "agent-sse": [],
  "agent-login": [],
};

const artifactContent: Record<string, ArtifactContentDto> = {
  "artifact-diff-app": {
    ...artifacts["agent-auth"]![0]!,
    contentType: "diff",
    content:
      "diff --git a/apps/web/src/App.tsx b/apps/web/src/App.tsx\n+function Workbench() {\n+  return <AgentView />;\n+}\n",
  },
  "artifact-report": {
    ...artifacts["agent-auth"]![1]!,
    contentType: "markdown",
    content: "## Web build\n\n- TypeScript contract imports are wired.\n- Chat excludes command and diff output.\n",
  },
};

const engines: EngineDto[] = [
  {
    id: "codex",
    displayName: "Codex",
    authenticated: true,
    authDetail: "Subscription CLI session detected",
    models: [
      { id: "", label: "Codex default" },
    ],
    efforts: [
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "XHigh" },
    ],
  },
  {
    id: "claude",
    displayName: "Claude",
    authenticated: true,
    authDetail: "Subscription CLI session detected",
    models: [
      { id: "", label: "Claude default" },
      { id: "opus", label: "Opus" },
      { id: "sonnet", label: "Sonnet" },
      { id: "haiku", label: "Haiku" },
    ],
    efforts: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "XHigh" },
    ],
  },
];

const subscribers = new Map<string, Set<StreamHandlers>>();
const agentSeq = new Map<string, number>([
  ["agent-auth", 10],
  ["agent-sse", 4],
  ["agent-login", 1],
]);

function delay<T>(value: T, ms = 160): Promise<T> {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(value), ms);
  });
}

function nextSeq(agentId: string): number {
  const next = (agentSeq.get(agentId) ?? 0) + 1;
  agentSeq.set(agentId, next);
  return next;
}

function emit(agentId: string, event: SseEventEnvelope["event"]): void {
  const envelope: SseEventEnvelope = {
    agentId,
    seq: nextSeq(agentId),
    ts: new Date().toISOString(),
    event,
  };
  const handlers = subscribers.get(agentId);
  handlers?.forEach((handler) => handler.onEvent(envelope));
}

function replayRun(agentId: string, prompt: string): void {
  const executionId = `mock-run-${Date.now()}`;
  const events: SseEventEnvelope["event"][] = [
    { type: "agent_lifecycle", status: "running", reason: "active_run", executionId },
    { type: "session", sessionId: `mock-${agentId}` },
    { type: "work_item_update", workItemId: "work-live", status: "running", title: "Apply requested change", executionId },
    { type: "text", delta: "I am on it. I will keep chat explicit and put execution detail in the run views." },
    { type: "command", command: "pnpm --filter @ponderosa/web typecheck", cwd: "/Users/khaleel/Projects/Ponderosa" },
    {
      type: "file_change",
      path: "apps/web/src/App.tsx",
      kind: "edit",
      diff: `diff --git a/apps/web/src/App.tsx b/apps/web/src/App.tsx\n+// ${prompt.slice(0, 54)}\n`,
    },
    { type: "test_result", passed: true, summary: "Mock typecheck passed for the web shell." },
    { type: "work_item_update", workItemId: "work-live", status: "done", title: "Apply requested change", executionId },
    { type: "text", delta: "The web shell update is complete in the mock run." },
    { type: "turn_done" },
    { type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId },
  ];

  events.forEach((event, index) => {
    window.setTimeout(() => emit(agentId, event), 500 + index * 700);
  });
}

export const mockApi: PonderosaApi = {
  listProjects() {
    return delay(projects);
  },
  createProject(request) {
    const project: ProjectDto = {
      id: `project-${Date.now()}`,
      label: request.label,
      hostPath: request.hostPath ?? `/tmp/ponderosa-workspaces/${request.createFolderName ?? `project-${Date.now()}`}`,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      defaultEngine: request.defaultEngine,
    };
    projects.push(project);
    return delay(project);
  },
  getProjectFolders() {
    return delay({ managedRoot: "/tmp/ponderosa-workspaces", folders: projects.map((project) => ({ hostPath: project.hostPath, name: project.label, source: "registered" as const })) });
  },
  browseProjectFolders(path) {
    const root = "/tmp/ponderosa-workspaces";
    return delay({ path: path ?? root, root, folders: [] });
  },
  markProjectUsed(projectId, conversationId) {
    const project = projects.find((item) => item.id === projectId)!;
    project.lastUsedAt = new Date().toISOString();
    if (conversationId) project.lastConversationId = conversationId;
    return delay(project);
  },
  updateProject(projectId, patch) {
    const project = projects.find((item) => item.id === projectId);
    if (!project) return Promise.reject(new Error("Project not found"));
    project.label = patch.label;
    return delay(project);
  },
  deleteProject(projectId) {
    const index = projects.findIndex((item) => item.id === projectId);
    if (index >= 0) projects.splice(index, 1);
    return delay(undefined);
  },
  getAgentHealth(projectId) {
    const generatedAt = new Date().toISOString();
    return delay({
      scope: { type: "project" as const, id: projectId },
      generatedAt,
      agents: agents.filter((agent) => agent.projectId === projectId).map((agent) => {
        const agentRuns = runs[agent.id] ?? [];
        const agentWorkItems = workItems[agent.id] ?? [];
        const status = agentRuns.some((run) => run.status === "running") ? "running" as const
          : agentWorkItems.some((item) => item.status === "waiting_approval") ? "waiting" as const
            : agentRuns.length && agentRuns.every((run) => run.status === "completed") ? "completed" as const : "idle" as const;
        return { agentId: agent.id, childAgentIds: [], status, statusTimestamp: agent.updatedAt, reason: status === "running" ? "active_run" as const : status === "waiting" ? "work_item_waiting_approval" as const : status === "completed" ? "turn_completed" as const : "no_active_work" as const };
      }),
    });
  },
  getTokenUsage(scope: TokenUsageScope, id?: string, _range?: TokenUsageRangeDto) {
    const scopedAgents = agents.filter((agent) => scope === "overall" ||
      (scope === "project" && agent.projectId === id) ||
      (scope === "agent" && agent.id === id));
    const scopedRuns = scopedAgents.flatMap((agent) => runs[agent.id] ?? []);
    const finalized = scopedRuns.filter((run) => run.status !== "running");
    const reported = finalized.filter((run) => run.usage);
    const sum = (key: "inputTokens" | "cachedInputTokens" | "outputTokens" | "reasoningOutputTokens" | "totalTokens") =>
      reported.reduce((total, run) => total + (run.usage?.[key] ?? 0), 0);
    return delay({
      scope,
      ...(scope !== "overall" ? { scopeId: id } : {}),
      inputTokens: sum("inputTokens"), cachedInputTokens: sum("cachedInputTokens"),
      outputTokens: sum("outputTokens"), reasoningOutputTokens: sum("reasoningOutputTokens"), totalTokens: sum("totalTokens"),
      finalizedRuns: finalized.length, reportedRuns: reported.length,
      unreportedRuns: finalized.length - reported.length,
      coverage: finalized.length ? reported.length / finalized.length : null,
      metricAvailability: {
        inputTokens: "unavailable", cachedInputTokens: "unavailable", cacheWriteInputTokens: "unavailable",
        outputTokens: "unavailable", reasoningOutputTokens: "unavailable", totalTokens: "unavailable",
      },
      breakdown: [],
      recentTurns: [],
    });
  },
  listAgentPresets(projectId) { return delay(agentPresets.filter((preset) => preset.projectId === projectId)); },
  createAgentPreset(projectId, request) { const now = new Date().toISOString(); const preset: AgentPresetDto = { id: `preset-${Date.now()}`, projectId, ...request, enabled: request.enabled ?? true, createdAt: now, updatedAt: now }; agentPresets.push(preset); return delay(preset); },
  updateAgentPreset(id, patch) { const preset = agentPresets.find((item) => item.id === id); if (!preset) return Promise.reject(new Error("Preset not found")); Object.assign(preset, patch, { updatedAt: new Date().toISOString() }); return delay(preset); },
  deleteAgentPreset(id) { const index = agentPresets.findIndex((item) => item.id === id); if (index >= 0) agentPresets.splice(index, 1); return delay(undefined); },
  listConversations(projectId) {
    return delay(conversations.filter((master) => master.projectId === projectId && !master.archived));
  },
  createConversation(projectId, request) {
    const master: ConversationDto = { id: "master-" + Date.now(), projectId, title: request.title, defaultEngine: request.defaultEngine, defaultModel: request.defaultModel, defaultEffort: request.defaultEffort, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archived: false };
    conversations.push(master);
    masterMessages[master.id] = [];
    return delay(master);
  },
  getConversation(conversationId) {
    const conversation = conversations.find((master) => master.id === conversationId);
    if (!conversation) return Promise.reject(new Error("Master chat not found"));
    return delay({ conversation, messages: masterMessages[conversationId] ?? [], agents: agents.filter((agent) => agent.conversationId === conversationId) });
  },
  getCollaborationView(conversationId) {
    const conversation = conversations.find((master) => master.id === conversationId);
    if (!conversation) return Promise.reject(new Error("Master chat not found"));
    const detail: CollaborationViewDto = {
      messages: collaborationMessages[conversationId] ?? [],
      agents: agents.filter((agent) => agent.conversationId === conversationId),
    };
    return delay(detail);
  },
  updateConversation(conversationId, patch) {
    const master = conversations.find((candidate) => candidate.id === conversationId);
    if (!master) return Promise.reject(new Error("Master chat not found"));
    Object.assign(master, patch, { updatedAt: new Date().toISOString() });
    return delay(master);
  },
  deleteConversation(conversationId) {
    const index = conversations.findIndex((candidate) => candidate.id === conversationId);
    if (index === -1) return Promise.reject(new Error("Master chat not found"));
    conversations.splice(index, 1);
    delete masterMessages[conversationId];
    for (const agent of agents) {
      if (agent.conversationId === conversationId) agent.conversationId = undefined;
    }
    return delay(undefined, 80);
  },
  async sendConversationMessage(conversationId, request) {
    if (!conversations.some((master) => master.id === conversationId)) throw new Error("Master chat not found");
    const text = request.text.replace(/^#broadcast(?=$|\s)\s*/iu, "").trim();
    masterMessages[conversationId] = [...(masterMessages[conversationId] ?? []), { id: "master-message-" + Date.now(), conversationId, role: request.role ?? "user", text: `#broadcast ${text}`, createdAt: new Date().toISOString() }];
    await delay(undefined, 80);
  },
  getConversationDraft(conversationId) {
    const draft = drafts.get(conversationId) ?? { conversationId, text: "", attachmentIds: [], revision: 0, updatedAt: new Date(0).toISOString(), clientId: "" };
    return delay({ ...draft, attachments: draft.attachmentIds.map((id) => draftAttachments.get(id)?.dto).filter((item): item is import("@ponderosa/core").DraftAttachmentDto => Boolean(item)) });
  },
  getConversationDraftConflicts(conversationId) { return delay({ conversationId, conflicts: [] }); },
  putConversationDraft(conversationId, request) {
    const current = drafts.get(conversationId);
    if ((current?.revision ?? 0) !== request.expectedRevision) return Promise.reject(new Error("draft revision conflict"));
    const draft = { conversationId, text: request.text, attachmentIds: request.attachmentIds, attachments: request.attachmentIds.map((id) => draftAttachments.get(id)?.dto).filter((item): item is import("@ponderosa/core").DraftAttachmentDto => Boolean(item)), revision: request.expectedRevision + 1, updatedAt: new Date().toISOString(), clientId: request.clientId };
    drafts.set(conversationId, draft);
    return delay(draft);
  },
  uploadDraftAttachment(conversationId, file) {
    const id = `draft-${Date.now()}-${Math.random()}`;
    const dto = { id, conversationId, name: file.name, mediaType: file.type, size: file.size, createdAt: new Date().toISOString(), downloadUrl: `mock:${id}` };
    draftAttachments.set(id, { dto, file });
    return delay(dto);
  },
  downloadDraftAttachment(attachment) {
    const stored = draftAttachments.get(attachment.id);
    return stored ? delay(stored.file) : Promise.reject(new Error("Draft attachment not found"));
  },
  deleteDraftAttachment(_conversationId, attachmentId) {
    draftAttachments.delete(attachmentId);
    return Promise.resolve();
  },
  generateConversationTitle(conversationId) {
    const conversation = conversations.find((item) => item.id === conversationId);
    if (!conversation || !/^New Chat$/i.test(conversation.title)) return delay({ title: conversation?.title ?? "New Chat", generated: false });
    conversation.title = "Generated Chat Title";
    return delay({ title: conversation.title, generated: true });
  },
  getWorkspacePreferences() { return delay(workspacePreferences); },
  updateWorkspacePreferences(request) { workspacePreferences = { ...workspacePreferences, ...request, updatedAt: new Date().toISOString() }; return delay(workspacePreferences); },
  listNotifications() { return delay([]); },
  clearConversationNotifications() { return delay(undefined); },
  getWebPushStatus() { return delay({ configured: false }); },
  upsertWebPushSubscription() { return delay(undefined); },
  deleteWebPushSubscription() { return delay(undefined); },
  async sendDirectReply(conversationId, request) {
    const target = agents.find((agent) => agent.id === request.targetAuthorAgentId);
    if (!target) throw new Error("Agent not found");
    masterMessages[conversationId] = [...(masterMessages[conversationId] ?? []), {
      id: request.idempotencyKey,
      conversationId,
      role: "user",
      text: `#${target.title.replace(/\s+/g, "-")} ${request.text}`,
      replyTo: { messageId: request.replyToMessageId, text: "", role: "assistant", authorAgentId: target.id },
      createdAt: new Date().toISOString(),
    }];
    return { messageId: request.idempotencyKey, targetAuthorAgentId: request.targetAuthorAgentId, replayed: false, queued: false };
  },
  async sendMultiAgentDirectMessage(conversationId, request) {
    if (!conversations.some((master) => master.id === conversationId)) throw new Error("Master chat not found");
    masterMessages[conversationId] = [...(masterMessages[conversationId] ?? []), {
      id: request.idempotencyKey,
      conversationId,
      role: "user",
      text: request.text,
      createdAt: new Date().toISOString(),
    }];
    for (const recipient of request.recipients) await this.sendMessage(recipient.agentId, { text: request.text, attachmentIds: recipient.attachmentIds });
    return {
      messageId: request.idempotencyKey,
      replayed: false,
      recipients: request.recipients.map((recipient) => ({ agentId: recipient.agentId, queued: false })),
    };
  },
  listQueuedConversationMessages() { return delay([]); },
  cancelQueuedConversationMessage() { return delay({ cancelled: true, replayed: false, status: "cancelled" }); },
  correctConversationMessage(conversationId, messageId, request) {
    const correctionMessageId = request.idempotencyKey;
    masterMessages[conversationId] = [...(masterMessages[conversationId] ?? []), {
      id: correctionMessageId, conversationId, role: "user", text: request.text, createdAt: new Date().toISOString(), correctionOfMessageId: messageId,
    }];
    return delay({ originalMessageId: messageId, correctionMessageId, replayed: false, queued: false });
  },
  async sendUserReaction(request) {
    const reaction = { emoji: request.emoji, count: 1, reactedByCurrentActor: true, reactors: [{ kind: "manager" as const }] };
    let targetAuthorAgentId: string | undefined;
    for (const roomMessages of [...Object.values(masterMessages), ...Object.values(collaborationMessages)]) {
      const message = roomMessages.find((candidate) => candidate.communicationEventId === request.communicationEventId);
      if (message?.authorAgentId) {
        message.reactions = [...(message.reactions ?? []).filter((item) => item.emoji !== request.emoji), reaction];
        targetAuthorAgentId = message.authorAgentId;
      }
    }
    for (const agentMessages of Object.values(messages)) {
      const message = agentMessages.find((candidate) => candidate.communicationEventId === request.communicationEventId);
      if (message) message.reactions = [...(message.reactions ?? []).filter((item) => item.emoji !== request.emoji), reaction];
    }
    if (!targetAuthorAgentId) throw new Error("Agent-authored message not found");
    return { replayed: false, queued: false, targetAuthorAgentId, reactions: [reaction] };
  },
  async sendCollaborationMessage(conversationId, request) {
    if (!conversations.some((master) => master.id === conversationId)) throw new Error("Master chat not found");
    if (request.recipientAgentIds.length === 0) throw new Error("Select at least one active recipient");
    const message = {
      id: "collaboration-message-" + Date.now(),
      conversationId,
      role: "user" as const,
      text: request.text,
      createdAt: new Date().toISOString(),
    };
    collaborationMessages[conversationId] = [
      ...(collaborationMessages[conversationId] ?? []),
      message,
    ];
    return { message, audience: "mention", notifiedAgentIds: [...request.recipientAgentIds] };
  },
  listAgents(projectId) {
    return delay(agents.filter((agent) => agent.projectId === projectId && !agent.archived));
  },
  createAgentRecord(projectId, request) {
    const agent: AgentDto = {
      id: `agent-${Date.now()}`,
      projectId,
      conversationId: request.conversationId,
      conversationIds: request.conversationId ? [request.conversationId] : [],
      title: request.title,
      activeEngine: request.engine,
      state: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archived: false,
      managerAgentId: request.managerAgentId,
    };
    agents.push(agent);
    messages[agent.id] = [];
    runs[agent.id] = [];
    workItems[agent.id] = [];
    artifacts[agent.id] = [];
    agentSeq.set(agent.id, 0);
    return delay(agent);
  },
  async createAgent(projectId, conversationId, options) {
    const agent = await this.createAgentRecord(projectId, {
      title: options.title,
      engine: options.engine as AgentDto["activeEngine"],
      conversationId,
      model: options.model,
      effort: options.effort,
      managerAgentId: options.managerAgentId,
    });
    if (options.initialMessage) {
      if (conversationId) await this.sendConversationMessage(conversationId, { text: options.initialMessage });
      await this.sendMessage(agent.id, {
        text: options.initialMessage,
        model: options.model,
        effort: options.effort,
      });
    }
    return agent;
  },
  updateAgent(agentId, patch) {
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (!agent) return Promise.reject(new Error("Agent not found"));
    if (patch.title !== undefined) agent.title = patch.title;
    if (patch.archived !== undefined) agent.archived = patch.archived;
    agent.updatedAt = new Date().toISOString();
    return delay(agent);
  },
  updateAgentConversationMemberships(agentId, membership) {
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (!agent) return Promise.reject(new Error("Agent not found"));
    agent.conversationIds = [...membership.conversationIds];
    agent.conversationId = membership.primaryConversationId;
    agent.updatedAt = new Date().toISOString();
    return delay(agent);
  },
  updateAgentOrganization(agentId, organization) {
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (!agent) return Promise.reject(new Error("Agent not found"));
    agent.managerAgentId = organization.managerAgentId ?? undefined;
    agent.updatedAt = new Date().toISOString();
    return delay(agent);
  },
  deleteAgent(agentId) {
    const index = agents.findIndex((candidate) => candidate.id === agentId);
    if (index !== -1) agents.splice(index, 1);
    delete messages[agentId];
    delete runs[agentId];
    delete workItems[agentId];
    delete artifacts[agentId];
    agentSeq.delete(agentId);
    subscribers.delete(agentId);
    return delay(undefined, 80);
  },
  getAgent(agentId) {
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (!agent) {
      return Promise.reject(new Error("Agent not found"));
    }

    return delay({
      agent,
      messages: messages[agentId] ?? [],
      runTriggers: [],
      runOutput: [],
      activity: [],
      changedFiles: [],
      runs: runs[agentId] ?? [],
      workItems: workItems[agentId] ?? [],
      artifacts: artifacts[agentId] ?? [],
      state: agent.state,
    });
  },
  listEngines() {
    return delay(engines);
  },
  getEngineCapabilities(_projectId) {
    return delay(engines.map((engine) => ({
      engineId: engine.id,
      steering: engine.id === "codex" || engine.id === "claude",
      persistentSessions: engine.id === "codex" || engine.id === "claude",
      commands: [],
      mcpServers: [],
    })));
  },
  async getFiles(_projectId, path = "") {
    return { kind: "dir" as const, path, entries: [] };
  },
  getWorkspaceStatus(projectId) {
    return delay({ projectId, isGitRepository: true, branch: "feature/web-pwa", head: "local", generatedAt: new Date().toISOString(), changes: [] });
  },
  getWorkspaceFile(projectId, path) {
    return delay({ projectId, path, exists: true, content: "", diff: "", stagedDiff: "", unstagedDiff: "", truncated: false });
  },
  getArtifact(_agentId, artifactId) {
    const content = artifactContent[artifactId];
    if (!content) {
      return Promise.reject(new Error("Artifact not found"));
    }
    return delay(content);
  },
  getCommunicationDocument(previewUrl) {
    return Promise.reject(new Error(`Communication document ${previewUrl} is unavailable in mock mode`));
  },
  sendMessage(agentId, request: SendMessageRequest): Promise<SendMessageResponse> {
    const nextMessage: MessageDto = {
      id: `mock-user-${Date.now()}`,
      agentId,
      seq: nextSeq(agentId),
      role: "user",
      text: request.text,
      createdAt: new Date().toISOString(),
    };
    messages[agentId] = [...(messages[agentId] ?? []), nextMessage];
    replayRun(agentId, request.text);
    return delay({ queued: false, runId: `mock-run-${Date.now()}`, mode: "continue" });
  },
  uploadAttachment(agentId, file) {
    return Promise.resolve({ id: `mock-${Date.now()}`, agentId, name: file.name, mediaType: (file.type || "image/png") as "image/png", size: file.size, width: 1, height: 1, url: URL.createObjectURL(file) });
  },
  deleteAttachment() { return Promise.resolve(); },
  async cancelRun(agentId): Promise<CancelAgentRunResponse> {
    emit(agentId, { type: "error", message: "Mock run cancelled." });
    emit(agentId, { type: "turn_done" });
    await delay(undefined, 80);
    return { cancelled: true, replayed: false };
  },
  compactSession() { return delay({ compacted: true }); },
  subscribeAgent(agentId, lastSeenSeq, handlers): StreamSubscription {
    const handlersForAgent = subscribers.get(agentId) ?? new Set<StreamHandlers>();
    handlersForAgent.add(handlers);
    subscribers.set(agentId, handlersForAgent);
    window.setTimeout(() => handlers.onOpen?.(), 0);

    if (lastSeenSeq !== undefined && lastSeenSeq < (agentSeq.get(agentId) ?? 0)) {
      window.setTimeout(() => {
        emit(agentId, { type: "text", delta: "Reconnected to the mock stream." });
      }, 250);
    }

    return {
      close() {
        handlersForAgent.delete(handlers);
      },
    };
  },
  subscribeWorkspace(_lastSeenId, handlers): StreamSubscription {
    queueMicrotask(() => handlers.onOpen?.());
    return { close() {} };
  },
};
