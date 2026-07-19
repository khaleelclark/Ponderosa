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
  GlobalChatSearchResponseDto,
  BrowserSessionDto,
  ProjectBrowserSessionDto,
  TriggerDefinitionDto,
  TriggerOccurrenceDto,
  AgentWorkInspectorDto,
  AgentWorkItemDetailsDto,
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
const browserSessions = new Map<string, BrowserSessionDto>();
const projectBrowserSessions = new Map<string, ProjectBrowserSessionDto>();
const agentPresets: AgentPresetDto[] = [];
const triggers: TriggerDefinitionDto[] = [];
const triggerOccurrences = new Map<string, TriggerOccurrenceDto[]>();
const drafts = new Map<string, import("@ponderosa/core").ConversationDraftDto>();
const draftAttachments = new Map<string, { dto: import("@ponderosa/core").DraftAttachmentDto; file: File }>();
const uploadedAttachments = new Map<string, import("@ponderosa/core").ImageAttachmentDto>();
let workspacePreferences: import("@ponderosa/core").WorkspacePreferencesDto = { projectSort: "last_used", projectOrder: [], starredProjectIds: [], sidebarCollapsed: false, sidebarWidth: 288, notifications: { mentions: true, directReplies: true, projectChatMessages: true, broadcasts: true, allMessages: false }, fontFamily: "inter", providerAvailability: {}, engineDefaults: {}, globalInstructions: "", profile: { displayName: "Patrick", handle: "patrick", avatarId: "default-user" }, updatedAt: now };

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
    managementPermissions: { allowAutomaticDescendantDeletion: false, allowAutomaticDescendantReorganization: false },
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
    managementPermissions: { allowAutomaticDescendantDeletion: false, allowAutomaticDescendantReorganization: false },
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
    managementPermissions: { allowAutomaticDescendantDeletion: false, allowAutomaticDescendantReorganization: false },
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
    configured: true,
    authenticated: true,
    available: true,
    authDetail: "Subscription CLI session detected",
    models: [
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", defaultEffort: "high" },
    ],
    defaultModel: "gpt-5.6-sol",
    defaultEffort: "high",
    efforts: [
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "XHigh" },
    ],
  },
  {
    id: "claude",
    displayName: "Claude",
    configured: true,
    authenticated: true,
    available: true,
    authDetail: "Subscription CLI session detected",
    models: [
      { id: "opus", label: "Opus" },
      { id: "sonnet", label: "Sonnet" },
      { id: "haiku", label: "Haiku" },
    ],
    defaultModel: "sonnet",
    defaultEffort: "high",
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
      defaultModel: request.defaultModel,
      defaultEffort: request.defaultEffort,
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
    if (patch.label !== undefined) project.label = patch.label;
    if (patch.instructions !== undefined) project.instructions = patch.instructions || undefined;
    if (patch.defaultEngine !== undefined) project.defaultEngine = patch.defaultEngine;
    if (patch.defaultModel !== undefined) project.defaultModel = patch.defaultModel || undefined;
    if (patch.defaultEffort !== undefined) project.defaultEffort = patch.defaultEffort || undefined;
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
  searchGlobalChats(query, limit = 30) {
    const normalized = query.trim().toLocaleLowerCase();
    const results: GlobalChatSearchResponseDto["results"] = [];
    for (const conversation of conversations) {
      const project = projects.find((item) => item.id === conversation.projectId);
      if (!project) continue;
      for (const message of masterMessages[conversation.id] ?? []) {
        const match = normalized ? message.text.toLocaleLowerCase().indexOf(normalized) : -1;
        if (normalized && match < 0) continue;
        results.push({
          project: { id: project.id, label: project.label },
          chat: { kind: "conversation", id: conversation.id, title: conversation.title },
          messageId: message.id,
          ...(message.communicationEventId ? { communicationEventId: message.communicationEventId } : {}),
          author: message.authorAgentId
            ? { kind: "agent", label: agents.find((agent) => agent.id === message.authorAgentId)?.title ?? "Agent", agentId: message.authorAgentId }
            : { kind: message.role === "system" ? "system" : "user", label: message.role === "system" ? "System" : "User" },
          timestamp: message.createdAt,
          snippet: message.text,
          highlights: match >= 0 ? [{ start: match, length: normalized.length }] : [],
          unread: false,
        });
      }
    }
    const recentChats = normalized ? [] : conversations.slice(0, 10).flatMap((conversation) => {
      const project = projects.find((item) => item.id === conversation.projectId);
      if (!project) return [];
      return [{
        project: { id: project.id, label: project.label },
        chat: { kind: "conversation" as const, id: conversation.id, title: conversation.title },
        lastActivityAt: conversation.updatedAt,
        ...(masterMessages[conversation.id]?.at(-1)?.text ? { snippet: masterMessages[conversation.id]!.at(-1)!.text } : {}),
        unreadCount: 0,
      }];
    });
    return delay({ query: query.trim(), results: results.slice(0, limit), recentChats, scannedMessages: results.length, truncated: results.length > limit });
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
  getAgentWork(projectId, filter = {}) {
    const projectAgents = agents.filter((agent) => agent.projectId === projectId && (!filter.agentId || agent.id === filter.agentId));
    const detail: AgentWorkInspectorDto = {
      projectId,
      ...(filter.conversationId ? { conversationId: filter.conversationId } : {}),
      ...(filter.agentId ? { agentId: filter.agentId } : {}),
      generatedAt: new Date().toISOString(),
      agents: projectAgents.map((agent) => ({ id: agent.id, title: agent.title })),
      traces: [],
      items: [],
    };
    return delay(detail);
  },
  getAgentWorkItemDetails(projectId, kind, recordId) {
    const detail: AgentWorkItemDetailsDto = {
      projectId,
      itemId: `${kind}:${recordId}`,
      recordId,
      details: [],
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
    masterMessages[conversationId] = [...(masterMessages[conversationId] ?? []), {
      id: "master-message-" + Date.now(), conversationId, role: request.role ?? "user",
      text: text ? `#broadcast ${text}` : "#broadcast",
      createdAt: new Date().toISOString(),
      ...(request.attachments?.length ? { attachments: request.attachments } : {}),
    }];
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
  markAllNotificationsRead() { return delay(undefined); },
  clearAllNotifications() { return delay(undefined); },
  setNotificationStatus(notificationId, status) { return delay({ id: notificationId, kind: "operational", title: "Notification", body: "", category: "system", severity: "info", status, createdAt: now, resolvedAt: new Date().toISOString() }); },
  listDecisions() { return delay([]); },
  respondDecision(decisionId, request) { return delay({ id: decisionId, projectId: "ponderosa", conversationId: "master-release", agentId: "agent-auth", runId: "run", mode: "choice", question: "Decision", options: [], allowOther: true, blocking: true, status: "resolved", response: { ...request, respondedAt: new Date().toISOString() }, createdAt: now, updatedAt: new Date().toISOString() }); },
  getWebPushStatus() { return delay({ configured: false, configuration: "missing" as const, detail: "Run host setup.", setupCommand: "pnpm --filter @ponderosa/server push:configure" }); },
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
  listQueuedAgentMessages() { return delay([]); },
  cancelQueuedAgentMessage() { return delay({ cancelled: true, replayed: false, status: "cancelled" }); },
  editQueuedAgentMessage() { return delay({ edited: true, replayed: false, status: "edited" }); },
  steerQueuedAgentMessage() { return delay({ steered: true, replayed: false, status: "steered" }); },
  letCurrentRunFinish() { return delay({ accepted: true, replayed: false, state: "waiting_for_run" }); },
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
    const firstRecipientAttachments = request.recipientAttachments?.[0]?.attachmentIds
      .map((id) => uploadedAttachments.get(id))
      .filter((item): item is import("@ponderosa/core").ImageAttachmentDto => Boolean(item)) ?? [];
    const message = {
      id: "collaboration-message-" + Date.now(),
      conversationId,
      role: "user" as const,
      text: request.text,
      createdAt: new Date().toISOString(),
      ...(firstRecipientAttachments.length ? { attachments: firstRecipientAttachments } : {}),
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
      managementPermissions: request.managementPermissions ?? { allowAutomaticDescendantDeletion: false, allowAutomaticDescendantReorganization: false },
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
    if (patch.managementPermissions !== undefined) agent.managementPermissions = patch.managementPermissions;
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
  previewAgentDeletion(projectId, request) {
    const requested = new Set(request.rootAgentIds);
    const projectAgents = agents.filter((agent) => agent.projectId === projectId);
    const byId = new Map(projectAgents.map((agent) => [agent.id, agent]));
    const rootAgentIds = [...requested].filter((id) => {
      let managerId = byId.get(id)?.managerAgentId;
      while (managerId) {
        if (requested.has(managerId)) return false;
        managerId = byId.get(managerId)?.managerAgentId;
      }
      return true;
    }).sort();
    const affected = new Set<string>();
    const visit = (id: string) => {
      affected.add(id);
      projectAgents.filter((agent) => agent.managerAgentId === id).forEach((agent) => visit(agent.id));
    };
    rootAgentIds.forEach(visit);
    const affectedAgents = [...affected].sort().map((id) => {
      const agent = byId.get(id)!;
      return { id, title: agent.title, ...(agent.managerAgentId ? { managerAgentId: agent.managerAgentId } : {}) };
    });
    return delay({ projectId, rootAgentIds, affectedAgents, previewHash: `mock:${JSON.stringify(affectedAgents)}` });
  },
  async commitAgentDeletion(projectId, request) {
    const preview = await this.previewAgentDeletion(projectId, { rootAgentIds: request.rootAgentIds });
    if (preview.previewHash !== request.previewHash) return Promise.reject(new Error("Agent organization changed after deletion preview"));
    for (const agentId of preview.affectedAgents.map((agent) => agent.id)) {
      const index = agents.findIndex((candidate) => candidate.id === agentId);
      if (index !== -1) agents.splice(index, 1);
      delete messages[agentId];
      delete runs[agentId];
      delete workItems[agentId];
      delete artifacts[agentId];
      agentSeq.delete(agentId);
      subscribers.delete(agentId);
    }
    return delay({
      deleted: true as const,
      deletedAgentIds: preview.affectedAgents.map((agent) => agent.id),
      deletionReceiptId: `mock-receipt:${request.previewHash}`,
      cleanupPending: false,
    }, 80);
  },
  getAgent(agentId) {
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (!agent) {
      return Promise.reject(new Error("Agent not found"));
    }

    return delay({
      agent,
      messages: messages[agentId] ?? [],
      runOutput: [],
      activity: [],
      changedFiles: [],
      runs: runs[agentId] ?? [],
      workItems: workItems[agentId] ?? [],
      artifacts: artifacts[agentId] ?? [],
      state: agent.state,
    });
  },
  getAgentHistory(agentId, stream) {
    const detail = {
      runOutput: [],
      activity: [],
      runs: runs[agentId] ?? [],
      workItems: workItems[agentId] ?? [],
      artifacts: artifacts[agentId] ?? [],
    }[stream];
    return delay({ stream, items: detail, history: { limit: 100, hasMore: false } } as never);
  },
  getActivityOutput() {
    return Promise.reject(new Error("Tool output not available in mock data"));
  },
  listProjectArtifacts(projectId) {
    const projectAgentIds = new Set(agents.filter((agent) => agent.projectId === projectId).map((agent) => agent.id));
    const items = Object.entries(artifacts).flatMap(([agentId, entries]) => projectAgentIds.has(agentId)
      ? entries.filter((artifact) => artifact.kind === "generated_file").map((artifact) => ({ ...artifact, projectId }))
      : []);
    return delay({ items, history: { limit: 100, hasMore: false } });
  },
  exportAgent(agentId, mode, organization = false) {
    const agent = agents.find((candidate) => candidate.id === agentId)!;
    return delay({ schema: "ponderosa.agent-package.v1", mode, kind: organization ? "organization" : "agent", exportedAt: new Date().toISOString(), sourceLabel: agent.title, rootRef: agent.id, agents: [{ ref: agent.id, title: agent.title, engine: agent.activeEngine, managementPermissions: agent.managementPermissions }] });
  },
  importAgents(_projectId, request) { return delay({ rootAgentId: request.package.rootRef, agentIds: request.package.agents.map((node) => node.ref) }); },
  listTriggers(agentId) {
    return delay(triggers.filter((trigger) => trigger.agentId === agentId));
  },
  listAllTriggers() {
    return delay([...triggers]);
  },
  createTrigger(agentId, request) {
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (!agent) return Promise.reject(new Error("Agent not found"));
    const createdAt = new Date().toISOString();
    const trigger: TriggerDefinitionDto = {
      id: `trigger-${Date.now()}`, projectId: agent.projectId, conversationId: request.conversationId,
      agentId, name: request.name, instructions: request.instructions, sourceKind: request.sourceKind,
      sourceConfig: request.sourceConfig, enabled: request.enabled !== false, fullAccess: true,
      ...(request.sourceKind === "webhook" ? { webhookPath: `/api/trigger-webhooks/trigger-${Date.now()}`, secretFingerprint: "demo" } : {}),
      createdAt, updatedAt: createdAt,
    };
    triggers.push(trigger);
    return delay({ trigger, ...(request.sourceKind === "webhook" ? { webhookSecret: "demo-secret-shown-once" } : {}) });
  },
  updateTrigger(triggerId, request) {
    const trigger = triggers.find((candidate) => candidate.id === triggerId);
    if (!trigger) return Promise.reject(new Error("Trigger not found"));
    Object.assign(trigger, request, { updatedAt: new Date().toISOString() });
    return delay(trigger);
  },
  deleteTrigger(triggerId) {
    const index = triggers.findIndex((candidate) => candidate.id === triggerId);
    if (index !== -1) triggers.splice(index, 1);
    return delay(undefined);
  },
  rotateTriggerSecret(triggerId) {
    const trigger = triggers.find((candidate) => candidate.id === triggerId);
    return trigger ? delay({ trigger, webhookSecret: "rotated-demo-secret" }) : Promise.reject(new Error("Trigger not found"));
  },
  allowTriggerRuns(triggerId, additionalRuns) {
    const trigger = triggers.find((candidate) => candidate.id === triggerId);
    if (!trigger || !trigger.budgetState) return Promise.reject(new Error("Trigger budget not found"));
    trigger.budgetState = { ...trigger.budgetState, allowance: trigger.budgetState.allowance + additionalRuns, held: false };
    return delay(trigger);
  },
  listTriggerOccurrences(triggerId) {
    return delay(triggerOccurrences.get(triggerId) ?? []);
  },
  listAgentTriggerOccurrences() {
    return delay([...triggerOccurrences.values()].flat());
  },
  listEngines() {
    return delay(engines);
  },
  updateEngine(engineId, request) {
    const engine = engines.find((candidate) => candidate.id === engineId);
    if (!engine) return Promise.reject(new Error("unknown engine"));
    Object.assign(engine, { enabled: request.enabled, available: request.enabled && engine.authenticated });
    return delay(engine);
  },
  recheckEngine(engineId) {
    const engine = engines.find((candidate) => candidate.id === engineId);
    return engine ? delay(engine) : Promise.reject(new Error("unknown engine"));
  },
  getEngineCapabilities(_projectId) {
    return delay(engines.map((engine) => ({
      engineId: engine.id,
      steering: engine.id === "codex" || engine.id === "claude",
      persistentSessions: engine.id === "codex" || engine.id === "claude",
      commands: [],
      mcpServers: [],
      composerCapabilities: [],
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
    const attachment = { id: `mock-${Date.now()}-${Math.random()}`, agentId, name: file.name, mediaType: (file.type || "image/png") as "image/png", size: file.size, width: 1, height: 1, url: URL.createObjectURL(file) };
    uploadedAttachments.set(attachment.id, attachment);
    return Promise.resolve(attachment);
  },
  deleteAttachment(_agentId, attachmentId) {
    uploadedAttachments.delete(attachmentId);
    return Promise.resolve();
  },
  async cancelRun(agentId, _request): Promise<CancelAgentRunResponse> {
    emit(agentId, { type: "error", message: "Mock run cancelled." });
    emit(agentId, { type: "turn_done" });
    await delay(undefined, 80);
    return { cancelled: true, replayed: false };
  },
  compactSession() { return delay({ compacted: true }); },
  getBrowserSession(_projectId, agentId, runId) {
    const session = browserSessions.get(agentId);
    return session?.runId === runId ? Promise.resolve(session) : Promise.reject(new Error("Browser session not found"));
  },
  openBrowserSession(projectId, agentId, runId) {
    const session: BrowserSessionDto = {
      id: `mock-browser-${agentId}`, projectId, agentId, runId, status: "ready",
      controlOwner: "agent", controlEpoch: 1, frameRevision: 1, url: "about:blank",
      title: "Browser", openedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    browserSessions.set(agentId, session);
    return Promise.resolve(session);
  },
  reconnectBrowserSession(projectId, agentId, runId) {
    return this.openBrowserSession(projectId, agentId, runId);
  },
  closeBrowserSession(_projectId, agentId, _runId) {
    const current = browserSessions.get(agentId)!;
    const session = { ...current, status: "closed" as const, controlEpoch: current.controlEpoch + 1, updatedAt: new Date().toISOString() };
    browserSessions.set(agentId, session);
    return Promise.resolve(session);
  },
  setBrowserControl(_projectId, agentId, _runId, request) {
    const current = browserSessions.get(agentId)!;
    const session = { ...current, controlOwner: request.owner, controlEpoch: current.controlEpoch + 1, updatedAt: new Date().toISOString() };
    browserSessions.set(agentId, session);
    return Promise.resolve(session);
  },
  sendBrowserInput(_projectId, agentId) {
    return Promise.resolve(browserSessions.get(agentId)!);
  },
  getBrowserFrame() {
    return Promise.resolve({ blob: new Blob([], { type: "image/png" }), revision: 1 });
  },
  getProjectBrowser(projectId) {
    const session = projectBrowserSessions.get(projectId);
    return session ? Promise.resolve(session) : Promise.reject(new Error("Project browser not found"));
  },
  openProjectBrowser(projectId, url) {
    const session: ProjectBrowserSessionDto = {
      id: `mock-project-browser-${projectId}`, projectId, status: "ready", controlOwner: "operator",
      controlEpoch: 1, frameRevision: 1, url: url ?? "about:blank", title: "Project browser",
      openedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    projectBrowserSessions.set(projectId, session);
    return Promise.resolve(session);
  },
  navigateProjectBrowser(projectId, url) {
    const current = projectBrowserSessions.get(projectId);
    if (!current) return this.openProjectBrowser(projectId, url);
    const session = { ...current, url, frameRevision: current.frameRevision + 1, updatedAt: new Date().toISOString() };
    projectBrowserSessions.set(projectId, session);
    return Promise.resolve(session);
  },
  reconnectProjectBrowser(projectId) {
    const current = projectBrowserSessions.get(projectId);
    return current ? Promise.resolve({ ...current, status: "ready" as const }) : this.openProjectBrowser(projectId);
  },
  closeProjectBrowser(projectId) {
    const current = projectBrowserSessions.get(projectId)!;
    const session = { ...current, status: "closed" as const, controlEpoch: current.controlEpoch + 1, updatedAt: new Date().toISOString() };
    projectBrowserSessions.set(projectId, session);
    return Promise.resolve(session);
  },
  setProjectBrowserControl(projectId, request) {
    const current = projectBrowserSessions.get(projectId)!;
    const session = { ...current, controlOwner: request.owner, ...(request.owner === "agent" ? { controllerAgentId: request.agentId, controllerRunId: "mock-run" } : { controllerAgentId: undefined, controllerRunId: undefined }), controlEpoch: current.controlEpoch + 1, updatedAt: new Date().toISOString() };
    projectBrowserSessions.set(projectId, session);
    return Promise.resolve(session);
  },
  sendProjectBrowserInput(projectId) {
    return Promise.resolve(projectBrowserSessions.get(projectId)!);
  },
  getProjectBrowserFrame() {
    return Promise.resolve({ blob: new Blob([], { type: "image/png" }), revision: 1 });
  },
  subscribeAgent(agentId, lastSeenSeq, handlers): StreamSubscription {
    const handlersForAgent = subscribers.get(agentId) ?? new Set<StreamHandlers>();
    handlersForAgent.add(handlers);
    subscribers.set(agentId, handlersForAgent);
    window.setTimeout(() => handlers.onOpen?.(), 0);
    window.setTimeout(() => handlers.onStatus?.({
      agentId,
      instanceId: "mock-instance",
      cursor: agentSeq.get(agentId) ?? 0,
      reset: false,
    }), 0);

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
