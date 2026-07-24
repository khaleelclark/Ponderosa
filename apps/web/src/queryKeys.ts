/**
 * Canonical React Query identities for workspace resources.
 *
 * Prefixes intentionally remain stable: invalidating `queryKeys.agents.all`
 * refreshes every Project roster, while `queryKeys.agents.project(id)` only
 * refreshes one Project. Components should not spell these arrays themselves.
 */
export const queryKeys = {
  projects: {
    all: ["projects"] as const,
  },
  workspacePreferences: {
    all: ["workspace-preferences"] as const,
  },
  notifications: {
    all: ["notifications"] as const,
  },
  engines: {
    all: ["engines"] as const,
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
  },
  agents: {
    all: ["agents"] as const,
    project: (projectId: string | undefined) => ["agents", projectId] as const,
    detailAll: ["agent"] as const,
    detailPrefix: (agentId: string) => ["agent", agentId] as const,
    detail: (agentId: string | undefined, limit = 100) => ["agent", agentId, limit] as const,
    healthAll: ["agent-health"] as const,
    health: (projectId: string | undefined) => ["agent-health", projectId] as const,
    presets: (projectId: string | undefined) => ["agent-presets", projectId] as const,
  },
  triggers: {
    all: ["triggers"] as const,
    agent: (agentId: string) => ["triggers", agentId] as const,
    occurrencesAll: ["trigger-occurrences"] as const,
    occurrence: (triggerId: string | undefined) => ["trigger-occurrences", triggerId] as const,
    agentOccurrences: (agentId: string) => ["agent-trigger-occurrences", agentId] as const,
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
    project: (projectId: string) => ["workspace-status", projectId] as const,
  },
  workspaceFile: {
    all: ["workspace-file"] as const,
    project: (projectId: string) => ["workspace-file", projectId] as const,
  },
  agentWork: {
    all: ["agent-work"] as const,
    project: (projectId: string) => ["agent-work", projectId] as const,
  },
  tokenUsage: {
    all: ["token-usage"] as const,
  },
  globalSearch: {
    all: ["global-search"] as const,
    results: (query: string) => ["global-search", query] as const,
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
