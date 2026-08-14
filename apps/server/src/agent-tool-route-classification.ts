type AgentApiAudience = "agent" | "operator";

interface AgentApiRouteClassification {
  audience: AgentApiAudience;
  match: "exact" | "prefix";
  path: string;
}

/**
 * Security-sensitive classification for every `/api/agent-*` namespace.
 * Agent-facing routes accept a per-Run capability. Operator routes must pass
 * the ordinary operator/session boundary instead.
 */
export const AGENT_API_ROUTES = [
  { path: "/api/agent-messages", match: "exact", audience: "agent" },
  { path: "/api/agent-coordinate", match: "exact", audience: "agent" },
  { path: "/api/agent-request-updates", match: "exact", audience: "agent" },
  { path: "/api/agent-spawn", match: "exact", audience: "agent" },
  { path: "/api/agent-browser", match: "exact", audience: "agent" },
  { path: "/api/agent-decisions", match: "exact", audience: "agent" },
  { path: "/api/agent-management", match: "exact", audience: "agent" },
  { path: "/api/agent-directory", match: "exact", audience: "agent" },
  { path: "/api/agent-history", match: "exact", audience: "agent" },
  { path: "/api/agent-documents/", match: "prefix", audience: "agent" },
  {
    path: "/api/agent-trigger-occurrences/",
    match: "prefix",
    audience: "agent",
  },
  { path: "/api/agent-directory/", match: "prefix", audience: "agent" },
  { path: "/api/agent-presets/", match: "prefix", audience: "operator" },
] as const satisfies readonly AgentApiRouteClassification[];

export function agentApiAudience(url: string): AgentApiAudience | undefined {
  const path = url.split("?", 1)[0]!;
  return AGENT_API_ROUTES.find(route =>
    route.match === "exact"
      ? path === route.path
      : path.startsWith(route.path)
  )?.audience;
}

export function isAgentToolRoute(url: string): boolean {
  return agentApiAudience(url) === "agent";
}
