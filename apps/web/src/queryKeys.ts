/**
 * Canonical React Query identities for workspace resources.
 *
 * Prefixes intentionally remain stable: invalidating `queryKeys.agents.all`
 * refreshes every Project roster, while `queryKeys.agents.project(id)` only
 * refreshes one Project. Components should not spell these arrays themselves.
 */
import { AGENT_DETAIL_PAGE_SIZE } from "./agentHistoryPagination.js";

export const queryKeys = {
  health: {
    all: ["health"] as const,
  },
  readiness: {
    all: ["readiness"] as const,
  },
  engine: {
    status: ["engine", "status"] as const,
    log: (stream: "server" | "error") => ["engine", "log", stream] as const,
  },
  projects: {
    all: ["projects"] as const,
    detail: (projectId: string | undefined) => ["project", projectId] as const,
  },
  workspaceDirectory: {
    all: ["workspace-directory"] as const,
    kind: (kind: "project" | "conversation" | "agent" | "trigger") =>
      ["workspace-directory", kind] as const,
    list: (
      kind: "project" | "conversation" | "agent" | "trigger",
      search: string,
      projectId: string | undefined,
      agentIds: string | undefined,
      conversationId: string | undefined,
      sort: "alphabetical" | "last_used" | "custom" | undefined,
    ) => [
      "workspace-directory",
      kind,
      search,
      projectId ?? "",
      agentIds ?? "",
      conversationId ?? "",
      sort ?? "",
    ] as const,
  },
  workspacePreferences: {
    all: ["workspace-preferences"] as const,
  },
  workspaceResourceRecency: {
    all: ["workspace-resource-recency"] as const,
  },
  notifications: {
    all: ["notifications"] as const,
    projection: (projectIds: readonly string[], conversationIds: readonly string[]) => [
      "notifications",
      "projection",
      projectIds.join("\0"),
      conversationIds.join("\0"),
    ] as const,
  },
  decisions: {
    all: ["decisions"] as const,
    project: (projectId: string) => ["decisions", "project", projectId] as const,
  },
  engines: {
    all: ["engines"] as const,
    models: (projectId: string | undefined, engineId: string) =>
      ["engine-models", projectId, engineId] as const,
    capabilities: (projectId: string) => ["engine-capabilities", projectId] as const,
    capabilitySelection: (
      projectId: string | undefined,
      agentId: string | undefined,
      engineId: string | undefined,
      model: string | undefined,
    ) => ["engine-capabilities", projectId, agentId, engineId, model] as const,
  },
  conversations: {
    all: ["conversations"] as const,
    project: (projectId: string | undefined) => ["conversations", projectId] as const,
    detailAll: ["conversation"] as const,
    detailPrefix: (conversationId: string) => ["conversation", conversationId] as const,
    detail: (conversationId: string | undefined, limit = 100) =>
      ["conversation", conversationId, limit] as const,
    members: (conversationId: string | undefined, search = "") =>
      ["conversation-members", conversationId, search] as const,
    targetedNextRun: (conversationId: string) =>
      ["targeted-next-run", conversationId] as const,
  },
  agents: {
    all: ["agents"] as const,
    project: (projectId: string | undefined) => ["agents", projectId] as const,
    detailAll: ["agent"] as const,
    detailPrefix: (agentId: string) => ["agent", agentId] as const,
    detail: (agentId: string | undefined, limit = AGENT_DETAIL_PAGE_SIZE) =>
      ["agent", agentId, limit] as const,
    healthAll: ["agent-health"] as const,
    health: (projectId: string | undefined) => ["agent-health", projectId] as const,
    presets: (projectId: string | undefined) => ["agent-presets", projectId] as const,
    organizationAll: ["agent-organization"] as const,
    organizationProject: (projectId: string) => ["agent-organization", projectId] as const,
    organizationPage: (
      projectId: string,
      scope: "roots" | "children" | "orphaned" | "deleted",
      parentAgentId: string | undefined,
      search: string,
      status: string | undefined,
    ) => [
      "agent-organization",
      projectId,
      scope,
      parentAgentId ?? "",
      search,
      status ?? "",
    ] as const,
  },
  triggers: {
    all: ["triggers"] as const,
    project: (projectId: string) => ["triggers", "project", projectId] as const,
    occurrencesAll: ["trigger-occurrences"] as const,
    occurrence: (triggerId: string | undefined) => ["trigger-occurrences", triggerId] as const,
    agentOccurrences: (agentId: string) => ["agent-trigger-occurrences", agentId] as const,
    projectOccurrences: (projectId: string) => ["project-trigger-occurrences", projectId] as const,
  },
  queuedMessages: {
    conversation: (conversationId: string) => ["queued-messages", conversationId] as const,
    agentsAll: ["queued-agent-messages"] as const,
    agent: (agentId: string) => ["queued-agent-messages", agentId] as const,
  },
  conversationDraft: {
    prefix: (conversationId: string) => ["conversation-draft", conversationId] as const,
    detail: (conversationId: string | undefined, draftOwnerId: string | undefined) =>
      ["conversation-draft", conversationId, draftOwnerId] as const,
  },
  workspaceStatus: {
    all: ["workspace-status"] as const,
    agent: (agentId: string) => ["workspace-status", agentId] as const,
  },
  workspaceFile: {
    all: ["workspace-file"] as const,
    agent: (agentId: string) => ["workspace-file", agentId] as const,
    detail: (agentId: string, path: string | undefined) =>
      ["workspace-file", agentId, path] as const,
  },
  workspaceChanges: {
    agent: (agentId: string) => ["workspace", agentId] as const,
    file: (
      agentId: string | undefined,
      path: string | undefined,
      lastSeq: number | undefined,
    ) => ["changed-file", agentId, path, lastSeq] as const,
  },
  workspaceFileView: {
    detail: (projectId: string, path: string, agentId?: string) =>
      ["workspace-file-view", projectId, agentId, path] as const,
  },
  agentWork: {
    all: ["agent-work"] as const,
    project: (projectId: string) => ["agent-work", projectId] as const,
    overview: (projectId: string) =>
      ["agent-work", projectId, "", "", "overview"] as const,
    list: (
      projectId: string,
      conversationId: string | undefined,
      agentId: string | undefined,
      focusId: string | undefined,
    ) => [
      "agent-work",
      projectId,
      conversationId ?? "",
      agentId ?? "",
      focusId ?? "",
    ] as const,
    detail: (
      projectId: string,
      conversationId: string | undefined,
      itemId: string,
    ) => [
      "agent-work",
      projectId,
      conversationId ?? "",
      "detail",
      itemId,
    ] as const,
  },
  tokenUsage: {
    all: ["token-usage"] as const,
    detail: (
      scope: "overall" | "project" | "agent",
      scopeId: string | undefined,
      rangeKey: "24h" | "7d" | "30d" | "all",
    ) => ["token-usage", scope, scopeId, rangeKey] as const,
  },
  providerUsage: {
    all: ["provider-usage"] as const,
    agent: (agentId: string | undefined) => ["provider-usage", "agent", agentId] as const,
  },
  globalSearch: {
    all: ["global-search"] as const,
    results: (
      query: string,
      limit = 25,
      kind?: "conversation" | "agent",
    ) => ["global-search", query, limit, kind ?? "all"] as const,
  },
  projectBrowser: {
    all: ["project-browser"] as const,
    project: (projectId: string | undefined) =>
      ["project-browser", projectId] as const,
  },
  agentBrowsers: {
    all: ["agent-browsers"] as const,
    conversation: (projectId: string | undefined, conversationId: string | undefined) =>
      ["agent-browsers", projectId, conversationId] as const,
    session: (projectId: string, agentId: string, runId: string) =>
      ["agent-browser", projectId, agentId, runId] as const,
    agent: (projectId: string, agentId: string) =>
      ["agent-browsers", projectId, "agent", agentId] as const,
    profiles: (projectId: string) =>
      ["browser-profiles", projectId] as const,
    preference: (projectId: string, agentId: string) =>
      ["browser-preference", projectId, agentId] as const,
  },
  hostFolderBrowser: {
    all: ["host-folder-browser"] as const,
    path: (path: string | undefined) => ["host-folder-browser", path] as const,
  },
  projectArtifacts: {
    all: ["project-artifacts"] as const,
    project: (projectId: string) => ["project-artifacts", projectId] as const,
    conversation: (projectId: string, conversationId: string) =>
      ["project-artifacts", projectId, "conversation", conversationId] as const,
    agentContent: (agentId: string, artifactId: string | undefined) =>
      ["artifact", agentId, artifactId] as const,
    recorded: (artifactId: string, agentId: string | undefined) =>
      ["project-recorded-artifact", artifactId, agentId] as const,
    textPreview: (artifactId: string, previewUrl: string | undefined) =>
      ["project-artifact-text-preview", artifactId, previewUrl] as const,
  },
  communicationDocument: {
    detail: (documentId: string) =>
      ["communication-document", documentId] as const,
  },
  activityOutput: {
    detail: (
      agentId: string,
      seq: number,
      sha256: string | undefined,
    ) => ["activity-output", agentId, seq, sha256] as const,
  },
  runOutputText: {
    detail: (agentId: string, seq: number, totalUtf8Bytes: number) =>
      ["run-output-text", agentId, seq, totalUtf8Bytes] as const,
  },
  assetLimits: {
    all: ["asset-limits"] as const,
  },
  agentDeletionPreview: {
    detail: (projectId: string, rootsKey: string) =>
      ["agent-deletion-preview", projectId, rootsKey] as const,
  },
  allChatAll: ["all-chat"] as const,
  allChat: (limit: number) => ["all-chat", limit] as const,
  projectFolders: ["project-folders"] as const,
  collaborationAll: ["collaboration-chat"] as const,
  collaborationPrefix: (conversationId: string | undefined) =>
    ["collaboration-chat", conversationId] as const,
  collaboration: (conversationId: string | undefined, limit = 100) =>
    ["collaboration-chat", conversationId, limit] as const,
} as const;
