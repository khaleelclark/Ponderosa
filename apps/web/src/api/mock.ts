import type {
  AgentEvent,
  ArtifactContentDto,
  ArtifactDto,
  EngineDto,
  MessageDto,
  ProjectDto,
  SendMessageRequest,
  SendMessageResponse,
  SseEventEnvelope,
  TaskDto,
  ThreadDetailDto,
  ThreadDto,
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
  },
  {
    id: "mobile",
    label: "Mobile App",
    hostPath: "/home/khaleel/projects/mobile",
    createdAt: now,
  },
];

const threads: ThreadDto[] = [
  {
    id: "thread-auth",
    projectId: "ponderosa",
    title: "Chunk G web PWA",
    activeEngine: "codex",
    state: { branch: "feature/web-pwa", commit: "local" },
    createdAt: now,
    updatedAt: now,
    archived: false,
  },
  {
    id: "thread-sse",
    projectId: "ponderosa",
    title: "SSE reconnect audit",
    activeEngine: "codex",
    state: { branch: "main", commit: "b7f4c2a" },
    createdAt: now,
    updatedAt: now,
    archived: false,
  },
  {
    id: "thread-login",
    projectId: "mobile",
    title: "Phone login regression",
    activeEngine: "codex",
    state: { branch: "fix/login" },
    createdAt: now,
    updatedAt: now,
    archived: false,
  },
];

const messages: Record<string, MessageDto[]> = {
  "thread-auth": [
    {
      id: "m1",
      threadId: "thread-auth",
      seq: 1,
      role: "user",
      text: "Implement the mobile-first Ponderosa web shell.",
      createdAt: now,
    },
    {
      id: "m2",
      threadId: "thread-auth",
      seq: 2,
      role: "assistant",
      text: "I have the shell structure mapped and will keep execution detail in Tasks and Artifacts.",
      createdAt: now,
    },
  ],
  "thread-sse": [
    {
      id: "m3",
      threadId: "thread-sse",
      seq: 1,
      role: "user",
      text: "Verify reconnect behavior when the phone sleeps.",
      createdAt: now,
    },
  ],
  "thread-login": [
    {
      id: "m4",
      threadId: "thread-login",
      seq: 1,
      role: "user",
      text: "Find why mobile login started failing after the auth refactor.",
      createdAt: now,
    },
  ],
};

const tasks: Record<string, TaskDto[]> = {
  "thread-auth": [
    {
      id: "task-ui",
      threadId: "thread-auth",
      title: "Build responsive shell",
      status: "running",
      engine: "codex",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "task-pwa",
      threadId: "thread-auth",
      title: "Add manifest and shell caching",
      status: "waiting_approval",
      engine: "codex",
      createdAt: now,
      updatedAt: now,
    },
  ],
  "thread-sse": [
    {
      id: "task-stream",
      threadId: "thread-sse",
      title: "Replay missed events from seq",
      status: "done",
      engine: "codex",
      createdAt: now,
      updatedAt: now,
    },
  ],
  "thread-login": [],
};

const artifacts: Record<string, ArtifactDto[]> = {
  "thread-auth": [
    {
      id: "artifact-diff-app",
      threadId: "thread-auth",
      taskId: "task-ui",
      kind: "diff",
      path: "apps/web/src/App.tsx.diff",
      summary: "Responsive workbench shell",
      createdAt: now,
    },
    {
      id: "artifact-report",
      threadId: "thread-auth",
      taskId: "task-pwa",
      kind: "test_report",
      path: "reports/web-build.md",
      summary: "Latest web build notes",
      createdAt: now,
    },
  ],
  "thread-sse": [],
  "thread-login": [],
};

const artifactContent: Record<string, ArtifactContentDto> = {
  "artifact-diff-app": {
    ...artifacts["thread-auth"]![0]!,
    contentType: "diff",
    content:
      "diff --git a/apps/web/src/App.tsx b/apps/web/src/App.tsx\n+function Workbench() {\n+  return <ThreadView />;\n+}\n",
  },
  "artifact-report": {
    ...artifacts["thread-auth"]![1]!,
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
const threadSeq = new Map<string, number>([
  ["thread-auth", 10],
  ["thread-sse", 4],
  ["thread-login", 1],
]);

function delay<T>(value: T, ms = 160): Promise<T> {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(value), ms);
  });
}

function nextSeq(threadId: string): number {
  const next = (threadSeq.get(threadId) ?? 0) + 1;
  threadSeq.set(threadId, next);
  return next;
}

function emit(threadId: string, event: AgentEvent): void {
  const envelope: SseEventEnvelope = {
    threadId,
    seq: nextSeq(threadId),
    ts: new Date().toISOString(),
    event,
  };
  const handlers = subscribers.get(threadId);
  handlers?.forEach((handler) => handler.onEvent(envelope));
}

function replayRun(threadId: string, prompt: string): void {
  const events: AgentEvent[] = [
    { type: "session", sessionId: `mock-${threadId}` },
    { type: "task_update", taskId: "task-live", status: "running", title: "Run requested change" },
    { type: "text", delta: "I am on it. I will keep the chat clean and put execution detail in the task panes." },
    { type: "command", command: "pnpm --filter @ponderosa/web typecheck", cwd: "/Users/khaleel/Projects/Ponderosa" },
    {
      type: "file_change",
      path: "apps/web/src/App.tsx",
      kind: "edit",
      diff: `diff --git a/apps/web/src/App.tsx b/apps/web/src/App.tsx\n+// ${prompt.slice(0, 54)}\n`,
    },
    { type: "test_result", passed: true, summary: "Mock typecheck passed for the web shell." },
    { type: "task_update", taskId: "task-live", status: "done", title: "Run requested change" },
    { type: "text", delta: "The web shell update is complete in the mock run." },
    { type: "turn_done" },
  ];

  events.forEach((event, index) => {
    window.setTimeout(() => emit(threadId, event), 500 + index * 700);
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
      hostPath: request.hostPath,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    projects.push(project);
    return delay(project);
  },
  listThreads(projectId) {
    return delay(threads.filter((thread) => thread.projectId === projectId && !thread.archived));
  },
  createThread(projectId, request) {
    const thread: ThreadDto = {
      id: `thread-${Date.now()}`,
      projectId,
      title: request.title,
      activeEngine: request.engine,
      state: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archived: false,
    };
    threads.push(thread);
    messages[thread.id] = [];
    tasks[thread.id] = [];
    artifacts[thread.id] = [];
    threadSeq.set(thread.id, 0);
    return delay(thread);
  },
  deleteThread(threadId) {
    const index = threads.findIndex((candidate) => candidate.id === threadId);
    if (index !== -1) threads.splice(index, 1);
    delete messages[threadId];
    delete tasks[threadId];
    delete artifacts[threadId];
    threadSeq.delete(threadId);
    subscribers.delete(threadId);
    return delay(undefined, 80);
  },
  getThread(threadId) {
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (!thread) {
      return Promise.reject(new Error("Thread not found"));
    }

    return delay({
      thread,
      messages: messages[threadId] ?? [],
      tasks: tasks[threadId] ?? [],
      artifacts: artifacts[threadId] ?? [],
      state: thread.state,
    });
  },
  listEngines() {
    return delay(engines);
  },
  getArtifact(_threadId, artifactId) {
    const content = artifactContent[artifactId];
    if (!content) {
      return Promise.reject(new Error("Artifact not found"));
    }
    return delay(content);
  },
  sendMessage(threadId, request: SendMessageRequest): Promise<SendMessageResponse> {
    const nextMessage: MessageDto = {
      id: `mock-user-${Date.now()}`,
      threadId,
      seq: nextSeq(threadId),
      role: "user",
      text: request.text,
      createdAt: new Date().toISOString(),
    };
    messages[threadId] = [...(messages[threadId] ?? []), nextMessage];
    replayRun(threadId, request.text);
    return delay({ runId: `mock-run-${Date.now()}`, mode: "continue" });
  },
  async cancelRun(threadId) {
    emit(threadId, { type: "error", message: "Mock run cancelled." });
    emit(threadId, { type: "turn_done" });
    await delay(undefined, 80);
  },
  subscribeThread(threadId, lastSeenSeq, handlers): StreamSubscription {
    const handlersForThread = subscribers.get(threadId) ?? new Set<StreamHandlers>();
    handlersForThread.add(handlers);
    subscribers.set(threadId, handlersForThread);
    window.setTimeout(() => handlers.onOpen?.(), 0);

    if (lastSeenSeq !== undefined && lastSeenSeq < (threadSeq.get(threadId) ?? 0)) {
      window.setTimeout(() => {
        emit(threadId, { type: "text", delta: "Reconnected to the mock stream." });
      }, 250);
    }

    return {
      close() {
        handlersForThread.delete(handlers);
      },
    };
  },
};
