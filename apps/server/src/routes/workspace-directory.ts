import { agentDisplayStatus, summarizeWorkspaceActivity } from "@ponderosa/core";
import { createHash } from "node:crypto";
import type {
  WorkspaceActivityProjectionRequestDto,
  WorkspaceActivityProjectionDto,
  AgentDto,
  AgentHealthDto,
  AgentHealthProjectionDto,
  AgentRunStatus,
  ProjectDto,
  ProjectSort,
  WorkspaceAgentDirectoryItemDto,
  WorkspaceConversationDirectoryItemDto,
  WorkspaceDirectoryItemDto,
  WorkspaceDirectoryKind,
  WorkspaceDirectoryPageDto,
  WorkspacePreferencesDto,
  WorkspaceProjectDirectoryItemDto,
} from "@ponderosa/core";
import type {
  AgentStore,
  WorkspaceStore,
} from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import { collectionGenerationKey, sendCollectionPageError, sqliteCollectionRevision, StaleCollectionCursorError } from "../collection-page.js";

const DEFAULT_DIRECTORY_LIMIT = 25;
const MAX_DIRECTORY_LIMIT = 100;
const MAX_RECENT_OUTCOMES = 100;

type DirectoryQuery = {
  limit?: string;
  cursor?: string;
  search?: string;
  projectId?: string;
  agentIds?: string;
  conversationId?: string;
  sort?: string;
  active?: string;
  outcomes?: string;
  summary?: string;
};

type DirectorySort = ProjectSort;

type CursorPosition =
  | { kind: "custom"; rank: number; title: string; id: string }
  | { kind: "alphabetical"; title: string; id: string }
  | { kind: "last_used"; updatedAt: string; id: string };

type CursorPayload = {
  v: 4;
  scope: string;
  revision: string;
  position: CursorPosition;
};

type ResourceRow = {
  id: string;
  title: string;
  updated_at: string;
  project_id: string;
  agent_id: string | null;
  conversation_id: string | null;
  conversation_count: number | null;
  recent_conversation_id: string | null;
  recent_conversation_title: string | null;
  recent_conversation_updated_at: string | null;
  running_agent_count: number | null;
  custom_rank?: number;
  sort_title?: string;
};

interface WorkspaceDirectoryRoutesContext {
  store: Pick<
    AgentStore,
    "sqlite" | "getProject" | "getConversation" | "getAgent"
  >;
  workspace: Pick<WorkspaceStore, "getPreferences">;
  agentHealth(
    scope: AgentHealthProjectionDto["scope"],
    agents: AgentDto[],
    options?: { includeRunHistory?: boolean },
  ): AgentHealthProjectionDto;
  projectDisplayPath(hostPath: string): string;
}

function projectSummary(
  project: ProjectDto,
): Pick<ProjectDto, "id" | "label" | "hostPath"> {
  return {
    id: project.id,
    label: project.label,
    hostPath: project.hostPath,
  };
}

function parseLimit(value: string | undefined): number {
  if (!value) return DEFAULT_DIRECTORY_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DIRECTORY_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_DIRECTORY_LIMIT}`);
  }
  return parsed;
}

function encodeCursor(
  position: CursorPosition,
  scope: string,
  revision: string,
): string {
  return Buffer.from(
    JSON.stringify({ v: 4, position, scope, revision } satisfies CursorPayload),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(
  value: string,
  scope: string,
  sort: DirectorySort,
  revision: string,
): CursorPosition {
  try {
    if (!value || value.length > 4096) throw new Error();
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<CursorPayload>;
    if (parsed.v !== 4 || parsed.scope !== scope || !parsed.position) {
      throw new Error();
    }
    if (parsed.revision !== revision) throw new StaleCollectionCursorError("stale directory cursor");
    const position = parsed.position;
    if (
      sort === "custom" && position.kind === "custom" &&
      Number.isSafeInteger(position.rank) && position.rank >= 0 &&
      typeof position.title === "string" && typeof position.id === "string"
    ) return position;
    if (
      sort === "alphabetical" && position.kind === "alphabetical" &&
      typeof position.title === "string" && typeof position.id === "string"
    ) return position;
    if (
      sort === "last_used" && position.kind === "last_used" &&
      typeof position.updatedAt === "string" && typeof position.id === "string"
    ) return position;
    throw new Error();
  } catch (error) {
    if (error instanceof StaleCollectionCursorError) throw error;
    throw new Error("invalid directory cursor");
  }
}

/** Shared activity projection for Project and Chat directory indicators. */
function runningAgentCountSql(scope: "active_agent.project_id = p.id" | "active_agent.conversation_id = c.id"): string {
  return `(SELECT COUNT(*) FROM agents active_agent
    WHERE ${scope}
      AND active_agent.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM agent_creation_operation_members creation_members
        JOIN agent_creation_operations creation_operations ON creation_operations.id = creation_members.operation_id
        WHERE creation_members.agent_id = active_agent.id
          AND creation_operations.status IN ('preparing', 'canonical_committed', 'rolling_back')
      )
      AND (EXISTS (
        SELECT 1 FROM scheduler_runs active_run
        WHERE active_run.agent_id = active_agent.id AND active_run.status IN ('leased', 'running')
      ) OR EXISTS (
        SELECT 1 FROM context_rollovers active_rollover
        WHERE active_rollover.agent_id = active_agent.id
          AND active_rollover.state IN ('requested', 'handoff_committed', 'session_retiring', 'continuation_ready')
      )))`;
}

function workspaceRunningAgentCount(context: WorkspaceDirectoryRoutesContext, health?: Map<string, AgentHealthDto>): number {
  const candidates = context.store.sqlite.prepare(`SELECT DISTINCT runs.agent_id
    FROM scheduler_runs runs
    JOIN agents agent ON agent.id = runs.agent_id
    WHERE runs.status IN ('leased', 'running')
      AND runs.side_effects_fenced_at IS NULL
      AND agent.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM agent_creation_operation_members members
        JOIN agent_creation_operations operation ON operation.id = members.operation_id
        WHERE members.agent_id = agent.id
          AND operation.status IN ('preparing', 'canonical_committed', 'rolling_back')
      )`).all() as Array<{ agent_id: string }>;
  if (health) return candidates.filter(row => health.has(row.agent_id) && agentDisplayStatus(health.get(row.agent_id)!) === "working").length;
  const groups = new Map<string, AgentDto[]>();
  for (const row of candidates) {
    const agent = context.store.getAgent(row.agent_id);
    if (!agent) continue;
    const group = groups.get(agent.projectId) ?? [];
    group.push(agent); groups.set(agent.projectId, group);
  }
  let count = 0;
  for (const [projectId, agents] of groups) count += context.agentHealth(
    { type: "project", id: projectId }, agents, { includeRunHistory: false },
  ).agents.filter(agent => agentDisplayStatus(agent) === "working").length;
  return count;
}

function resourceSettings(
  preferences: WorkspacePreferencesDto,
  kind: WorkspaceDirectoryKind,
): { sort: ProjectSort; order: readonly string[] } {
  if (kind === "project") {
    return { sort: preferences.projectSort, order: preferences.projectOrder };
  }
  if (kind === "conversation") {
    return {
      sort: preferences.chatSort ?? "last_used",
      order: preferences.chatOrder ?? [],
    };
  }
  return {
    sort: preferences.agentSort ?? "last_used",
    order: preferences.agentOrder ?? [],
  };
}

function starredKeys(preferences: WorkspacePreferencesDto): Set<string> {
  return new Set([
    ...(preferences.starredResourceIds ?? []),
    ...preferences.starredProjectIds.map(id => `project:${id}`),
  ]);
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, match => `\\${match}`)}%`;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function baseDirectoryQuery(
  kind: WorkspaceDirectoryKind,
  query: DirectoryQuery,
  normalizedSearch: string,
  filteredAgentIds: readonly string[],
  workingAgentIds: readonly string[],
  outcomeAgentIds: readonly string[],
): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const pattern = likePattern(normalizedSearch);

  if (kind === "project") {
    if (query.projectId) {
      where.push("p.id = ?");
      params.push(query.projectId);
    }
    if (normalizedSearch) {
      where.push(`(
        lower(p.label || ' ' || p.host_path) LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM conversations search_conversation
          WHERE search_conversation.project_id = p.id
            AND NOT EXISTS (SELECT 1 FROM conversation_deletion_receipts deleting_chat WHERE deleting_chat.conversation_id = search_conversation.id)
            AND lower(search_conversation.title) LIKE ? ESCAPE '\\'
        )
      )`);
      params.push(pattern, pattern);
    }
    return {
      sql: `
        SELECT
          p.id,
          p.label AS title,
          COALESCE(p.last_used_at, p.created_at) AS updated_at,
          p.id AS project_id,
          NULL AS agent_id,
          NULL AS conversation_id,
          (
            SELECT COUNT(*) FROM conversations count_conversation
            WHERE count_conversation.project_id = p.id
              AND NOT EXISTS (SELECT 1 FROM conversation_deletion_receipts deleting_chat WHERE deleting_chat.conversation_id = count_conversation.id)
          ) AS conversation_count,
          (
            SELECT recent.id FROM conversations recent
            WHERE recent.project_id = p.id AND NOT EXISTS (SELECT 1 FROM conversation_deletion_receipts deleting_chat WHERE deleting_chat.conversation_id = recent.id)
            ORDER BY recent.updated_at DESC, recent.id ASC LIMIT 1
          ) AS recent_conversation_id,
          (
            SELECT recent.title FROM conversations recent
            WHERE recent.project_id = p.id AND NOT EXISTS (SELECT 1 FROM conversation_deletion_receipts deleting_chat WHERE deleting_chat.conversation_id = recent.id)
            ORDER BY recent.updated_at DESC, recent.id ASC LIMIT 1
          ) AS recent_conversation_title,
          (
            SELECT recent.updated_at FROM conversations recent
            WHERE recent.project_id = p.id AND NOT EXISTS (SELECT 1 FROM conversation_deletion_receipts deleting_chat WHERE deleting_chat.conversation_id = recent.id)
            ORDER BY recent.updated_at DESC, recent.id ASC LIMIT 1
          ) AS recent_conversation_updated_at,
          ${runningAgentCountSql("active_agent.project_id = p.id")} AS running_agent_count
        FROM projects p
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      `,
      params,
    };
  }

  if (kind === "conversation") {
    where.push("NOT EXISTS (SELECT 1 FROM conversation_deletion_receipts deleting_chat WHERE deleting_chat.conversation_id = c.id)");
    if (query.projectId) {
      where.push("c.project_id = ?");
      params.push(query.projectId);
    }
    if (query.conversationId) {
      where.push("c.id = ?");
      params.push(query.conversationId);
    }
    if (normalizedSearch) {
      where.push(
        "lower(c.title || ' ' || p.label || ' ' || p.host_path) LIKE ? ESCAPE '\\'",
      );
      params.push(pattern);
    }
    return {
      sql: `
        SELECT c.id, c.title, c.updated_at, c.project_id,
          NULL AS agent_id, c.id AS conversation_id,
          NULL AS conversation_count, NULL AS recent_conversation_id,
          NULL AS recent_conversation_title,
          NULL AS recent_conversation_updated_at,
          ${runningAgentCountSql("active_agent.conversation_id = c.id")} AS running_agent_count
        FROM conversations c
        JOIN projects p ON p.id = c.project_id
        WHERE ${where.join(" AND ")}
      `,
      params,
    };
  }

  if (kind === "agent") {
    where.push("a.deleted_at IS NULL");
    where.push(`NOT EXISTS (
      SELECT 1
      FROM agent_creation_operation_members creation_members
      JOIN agent_creation_operations creation_operations ON creation_operations.id = creation_members.operation_id
      WHERE creation_members.agent_id = a.id
        AND creation_operations.status IN ('preparing', 'canonical_committed', 'rolling_back')
    )`);
    if (query.projectId) {
      where.push("a.project_id = ?");
      params.push(query.projectId);
    }
    if (filteredAgentIds.length > 0) {
      where.push(`a.id IN (${placeholders(filteredAgentIds.length)})`);
      params.push(...filteredAgentIds);
    }
    if (query.conversationId) {
      where.push(`EXISTS (
        SELECT 1 FROM agent_conversation_memberships membership
        WHERE membership.agent_id = a.id
          AND membership.conversation_id = ?
      )`);
      params.push(query.conversationId);
    }
    if (query.active === "true") {
      if (workingAgentIds.length === 0) where.push("0");
      else {
        where.push(`a.id IN (${placeholders(workingAgentIds.length)})`);
        params.push(...workingAgentIds);
      }
    }
    if (query.outcomes === "true") {
      if (outcomeAgentIds.length === 0) where.push("0");
      else {
        where.push(`a.id IN (${placeholders(outcomeAgentIds.length)})`);
        params.push(...outcomeAgentIds);
      }
    }
    if (normalizedSearch) {
      where.push(
        "lower(a.title || ' #' || COALESCE(a.handle, '') || ' ' || COALESCE(owner_chat.title, '') || ' ' || a.active_engine || ' ' || p.label || ' ' || p.host_path) LIKE ? ESCAPE '\\'",
      );
      params.push(pattern);
    }
    return {
      sql: `
        SELECT a.id, a.title, a.updated_at, a.project_id,
          a.id AS agent_id, a.conversation_id,
          NULL AS conversation_count, NULL AS recent_conversation_id,
          NULL AS recent_conversation_title,
          NULL AS recent_conversation_updated_at,
          NULL AS running_agent_count
        FROM agents a
        JOIN projects p ON p.id = a.project_id
        LEFT JOIN conversations owner_chat ON owner_chat.id = a.conversation_id AND owner_chat.project_id = a.project_id
        WHERE ${where.join(" AND ")}
      `,
      params,
    };
  }

  throw new Error("invalid directory kind");
}

function orderingSql(
  sort: DirectorySort,
  order: readonly string[],
): { sql: string; rankSql: string; rankParams: unknown[] } {
  if (sort === "alphabetical") {
    return { sql: "lower(title) ASC, id ASC", rankSql: "0", rankParams: [] };
  }
  if (sort === "last_used") {
    return { sql: "updated_at DESC, id ASC", rankSql: "0", rankParams: [] };
  }
  if (order.length === 0) {
    return {
      sql: "custom_rank ASC, sort_title ASC, id ASC",
      rankSql: "0",
      rankParams: [],
    };
  }
  const cases = order.map((_, index) => `WHEN ? THEN ${index}`).join(" ");
  return {
    sql: "custom_rank ASC, sort_title ASC, id ASC",
    rankSql: `CASE id ${cases} ELSE ${order.length} END`,
    rankParams: [...order],
  };
}

function cursorSql(
  position: CursorPosition | undefined,
): { sql: string; params: unknown[] } {
  if (!position) return { sql: "", params: [] };
  if (position.kind === "custom") {
    return {
      sql: `(
        custom_rank > ? OR
        (custom_rank = ? AND (
          sort_title > ? OR
          (sort_title = ? AND id > ?)
        ))
      )`,
      params: [position.rank, position.rank, position.title, position.title, position.id],
    };
  }
  if (position.kind === "alphabetical") {
    return {
      sql: "(lower(title) > lower(?) OR (lower(title) = lower(?) AND id > ?))",
      params: [position.title, position.title, position.id],
    };
  }
  return {
    sql: "(updated_at < ? OR (updated_at = ? AND id > ?))",
    params: [position.updatedAt, position.updatedAt, position.id],
  };
}

function nextCursorPosition(
  row: ResourceRow,
  sort: DirectorySort,
): CursorPosition {
  if (sort === "custom") {
    return {
      kind: "custom",
      rank: row.custom_rank ?? 0,
      title: row.sort_title ?? row.title.toLocaleLowerCase(),
      id: row.id,
    };
  }
  if (sort === "alphabetical") {
    return { kind: "alphabetical", title: row.title, id: row.id };
  }
  return {
    kind: "last_used",
    updatedAt: row.updated_at,
    id: row.id,
  };
}

const WORKING_AGENT_STATUSES = new Set<AgentHealthDto["status"]>([
  "running", "waiting", "preparing", "compacting", "blocked",
  "stalled", "interrupted", "needs_decision",
]);
const FINISHED_ASSIGNED_WORK_STATUSES = new Set<AgentRunStatus>([
  "completed", "failed", "cancelled",
]);

function workspaceAgentHealth(
  context: WorkspaceDirectoryRoutesContext,
  projectId?: string,
  includeRunHistory = true,
): {
  byId: Map<string, AgentHealthDto>;
  confirmedById: Map<string, string>;
  workingIds: string[];
  outcomeIds: string[];
  revision: string;
} {
  const rows = context.store.sqlite.prepare(`
    SELECT a.id, a.project_id
    FROM agents a
    WHERE a.deleted_at IS NULL
      ${projectId ? "AND a.project_id = ?" : ""}
      AND NOT EXISTS (
        SELECT 1
        FROM agent_creation_operation_members creation_members
        JOIN agent_creation_operations creation_operations ON creation_operations.id = creation_members.operation_id
        WHERE creation_members.agent_id = a.id
          AND creation_operations.status IN ('preparing', 'canonical_committed', 'rolling_back')
      )
  `).all(...(projectId ? [projectId] : [])) as Array<{ id: string; project_id: string }>;
  const agentsByProject = new Map<string, AgentDto[]>();
  for (const row of rows) {
    const agent = context.store.getAgent(row.id);
    if (!agent) continue;
    const agents = agentsByProject.get(row.project_id) ?? [];
    agents.push(agent);
    agentsByProject.set(row.project_id, agents);
  }
  const byId = new Map<string, AgentHealthDto>();
  const confirmedById = new Map<string, string>();
  for (const [projectId, agents] of agentsByProject) {
    const projection = context.agentHealth({ type: "project", id: projectId }, agents, { includeRunHistory });
    for (const health of projection.agents) {
      byId.set(health.agentId, health);
      confirmedById.set(health.agentId, projection.generatedAt);
    }
  }
  const workingIds = [...byId.values()]
    .filter(health => WORKING_AGENT_STATUSES.has(health.status))
    .sort((left, right) =>
      right.statusTimestamp.localeCompare(left.statusTimestamp) ||
      left.agentId.localeCompare(right.agentId))
    .map(health => health.agentId);
  const outcomes = [...byId.values()]
    .filter((health): health is AgentHealthDto & { assignedWorkOutcome: NonNullable<AgentHealthDto["assignedWorkOutcome"]> } =>
      health.assignedWorkOutcome !== undefined &&
      FINISHED_ASSIGNED_WORK_STATUSES.has(health.assignedWorkOutcome.status))
    .sort((left, right) =>
      right.assignedWorkOutcome.updatedAt.localeCompare(left.assignedWorkOutcome.updatedAt) ||
      left.agentId.localeCompare(right.agentId))
    .slice(0, MAX_RECENT_OUTCOMES);
  return {
    byId,
    confirmedById,
    workingIds,
    outcomeIds: outcomes.map(health => health.agentId),
    revision: createHash("sha256")
      .update([...byId.values()]
        .sort((left, right) => left.agentId.localeCompare(right.agentId))
        .map(health => [
        health.agentId,
        health.status,
        health.statusTimestamp,
        health.assignedWorkOutcome?.runId ?? "",
        health.assignedWorkOutcome?.status ?? "",
        health.assignedWorkOutcome?.updatedAt ?? "",
      ].join("\0")).join("\n"))
      .digest("base64url"),
  };
}

export function registerWorkspaceDirectoryRoutes(
  app: FastifyInstance,
  context: WorkspaceDirectoryRoutesContext,
): void {
  // Presentation scopes are bounded separately from directory pagination. Read
  // canonical health in bounded batches and dedupe Agents shared by member Chats.
  app.post<{ Body: WorkspaceActivityProjectionRequestDto }>("/api/workspace/directory/activity", {
    bodyLimit: 2 * 1024 * 1024,
  }, async (request, reply) => {
    const body = request.body;
    const validIds = (ids: unknown, limit: number): ids is string[] => Array.isArray(ids)
      && ids.length <= limit && ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 200);
    if (!body || !validIds(body.conversationIds, 200) || !Array.isArray(body.chatFolders)
      || body.chatFolders.length > 200 || body.chatFolders.some(folder => !folder
        || typeof folder.id !== "string" || !folder.id || folder.id.length > 200
        || !validIds(folder.conversationIds, 10_000))
      || body.chatFolders.reduce((sum, folder) => sum + folder.conversationIds.length, 0) > 10_000
      || new Set(body.chatFolders.map(folder => folder.id)).size !== body.chatFolders.length) {
      return reply.code(400).send({ error: "invalid bounded activity scopes" });
    }
    const chatIds = [...new Set([...body.conversationIds, ...body.chatFolders.flatMap(folder => folder.conversationIds)])];
    const byChat = new Map<string, Set<string>>(chatIds.map(id => [id, new Set()]));
    const knownChats = new Set<string>();
    const agentsByProject = new Map<string, Map<string, AgentDto>>();
    // Chunk ID predicates as well as health work; do not depend on SQLite's
    // platform-specific variable ceiling or on rendered directory rows.
    for (let start = 0; start < chatIds.length; start += 200) {
      const ids = chatIds.slice(start, start + 200);
      for (const row of context.store.sqlite.prepare(`SELECT c.id FROM conversations c JOIN projects p ON p.id = c.project_id
        WHERE NOT EXISTS (SELECT 1 FROM conversation_deletion_receipts deleting_chat WHERE deleting_chat.conversation_id = c.id) AND c.id IN (${placeholders(ids.length)})`).all(...ids) as Array<{ id: string }>) knownChats.add(row.id);
      const rows = context.store.sqlite.prepare(`
        SELECT DISTINCT a.id, a.project_id, membership.conversation_id
        FROM agent_conversation_memberships membership
        JOIN conversations c ON c.id = membership.conversation_id AND NOT EXISTS (SELECT 1 FROM conversation_deletion_receipts deleting_chat WHERE deleting_chat.conversation_id = c.id)
        JOIN agents a ON a.id = membership.agent_id AND a.project_id = c.project_id
        WHERE membership.conversation_id IN (${placeholders(ids.length)})
          AND a.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM agent_creation_operation_members member
            JOIN agent_creation_operations operation ON operation.id = member.operation_id
            WHERE member.agent_id = a.id AND operation.status IN ('preparing', 'canonical_committed', 'rolling_back')
          )
      `).all(...ids) as Array<{ id: string; project_id: string; conversation_id: string }>;
      for (const row of rows) {
        byChat.get(row.conversation_id)!.add(row.id);
        const agents = agentsByProject.get(row.project_id) ?? new Map<string, AgentDto>();
        if (!agents.has(row.id)) {
          const agent = context.store.getAgent(row.id);
          if (agent) agents.set(row.id, agent);
        }
        agentsByProject.set(row.project_id, agents);
      }
    }
    const byId = new Map<string, AgentHealthDto>();
    let confirmedAt: string | undefined = new Date().toISOString();
    for (const [projectId, agents] of agentsByProject) {
      const rows = [...agents.values()];
      for (let start = 0; start < rows.length; start += 100) {
        const projection = context.agentHealth({ type: "project", id: projectId }, rows.slice(start, start + 100), { includeRunHistory: false });
        if (!projection.generatedAt || !Number.isFinite(Date.parse(projection.generatedAt))) confirmedAt = undefined;
        else if (confirmedAt && projection.generatedAt < confirmedAt) confirmedAt = projection.generatedAt;
        for (const health of projection.agents) byId.set(health.agentId, health);
      }
    }
    const summarize = (ids: string[]) => summarizeWorkspaceActivity(
      [...new Set(ids.flatMap(id => [...(byChat.get(id) ?? [])]))].map(id => byId.get(id))
        .concat([...new Set(ids)].filter(id => !knownChats.has(id)).map(() => undefined)), confirmedAt,
    );
    return {
      conversations: Object.fromEntries(body.conversationIds.map(id => [id, summarize([id])])),
      chatFolders: Object.fromEntries(body.chatFolders.map(folder => [folder.id, summarize(folder.conversationIds)])),
    } satisfies WorkspaceActivityProjectionDto;
  });

  app.get<{
    Params: { kind: string };
    Querystring: DirectoryQuery;
  }>("/api/workspace/directory/:kind", async (request, reply) => {
    const kind = request.params.kind;
    if (
      kind !== "project" &&
      kind !== "conversation" &&
      kind !== "agent"
    ) {
      return reply.code(404).send({ error: "unknown workspace directory" });
    }
    if (request.query.active !== undefined &&
        (kind !== "agent" || request.query.active !== "true")) {
      return reply.code(400).send({ error: "active=true is supported only for the Agent directory" });
    }
    if (request.query.outcomes !== undefined &&
        (kind !== "agent" || request.query.outcomes !== "true")) {
      return reply.code(400).send({ error: "outcomes=true is supported only for the Agent directory" });
    }
    if (request.query.summary !== undefined && request.query.summary !== "true") {
      return reply.code(400).send({ error: "summary must be true when provided" });
    }
    if (request.query.summary && request.query.cursor) {
      return reply.code(400).send({ error: "summaries do not support cursors" });
    }

    let limit: number;
    try {
      limit = parseLimit(request.query.limit);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }

    const requestedSort = request.query.sort;
    if (
      requestedSort !== undefined &&
      requestedSort !== "alphabetical" &&
      requestedSort !== "last_used" &&
      requestedSort !== "custom"
    ) {
      return reply.code(400).send({ error: "invalid directory sort" });
    }

    const preferences = context.workspace.getPreferences();
    const settings = resourceSettings(preferences, kind);
    const activeAgents = request.query.active === "true";
    const recentOutcomes = request.query.outcomes === "true";
    if (activeAgents && recentOutcomes) {
      return reply.code(400).send({ error: "Active Agents and Recent Agent outcomes are separate directory views" });
    }
    if ((activeAgents || recentOutcomes) && requestedSort !== undefined) {
      return reply.code(400).send({
        error: activeAgents
          ? "Active Agents have a canonical sort"
          : "Recent Agent outcomes have a canonical sort",
      });
    }
    const canonicalAgentView = activeAgents || recentOutcomes;
    // Only canonical health-filtered views need the complete workspace projection
    // (including its global counts and top-100 outcome selection).
    const scopedActiveSummary = activeAgents && request.query.summary === "true";
    const health = canonicalAgentView ? workspaceAgentHealth(
      context,
      scopedActiveSummary ? request.query.projectId : undefined,
      !scopedActiveSummary,
    ) : undefined;
    const sort = canonicalAgentView ? "custom" : requestedSort ?? settings.sort;
    const sqlite = context.store.sqlite;
    const order = activeAgents
      ? health?.workingIds ?? []
      : recentOutcomes
        ? health?.outcomeIds ?? []
        : settings.order;
    const normalizedSearch = (request.query.search ?? "")
      .trim()
      .toLocaleLowerCase();
    const filteredAgentIds = [
      ...new Set((request.query.agentIds ?? "").split(",").filter(Boolean)),
    ];
    const workingAgentIds = health?.workingIds ?? [];
    const outcomeAgentIds = health?.outcomeIds ?? [];

    const directorySettingsHash = createHash("sha256")
      .update(JSON.stringify({
        order: canonicalAgentView ? [] : order,
        stars: canonicalAgentView ? [] : [...starredKeys(preferences)]
          .filter(key => key.startsWith(`${kind}:`))
          .sort(),
      }))
      .digest("base64url");
    const scope = JSON.stringify({
      kind,
      search: normalizedSearch,
      projectId: request.query.projectId ?? "",
      agentIds: [...filteredAgentIds].sort(),
      conversationId: request.query.conversationId ?? "",
      sort,
      active: request.query.active ?? "",
      outcomes: request.query.outcomes ?? "",
      directorySettingsHash,
    });

    const base = baseDirectoryQuery(
      kind,
      request.query,
      normalizedSearch,
      filteredAgentIds,
      workingAgentIds,
      outcomeAgentIds,
    );
    const projectScope = request.query.projectId;
    const scoped = (collection: string): string => projectScope
      ? collectionGenerationKey(collection, `project:${projectScope}`)
      : collection;
    const projectKey = projectScope
      ? collectionGenerationKey("projects", `id:${projectScope}`)
      : "projects";
    const generationKeys = kind === "project"
      ? [projectKey, scoped("conversations")]
      : kind === "conversation"
        ? [scoped("conversations"), projectKey]
        : [
              scoped("agents"),
              ...(normalizedSearch ? [scoped("conversations")] : []),
              projectKey,
              "scheduler_runs",
              "context_rollovers",
              ...(request.query.conversationId
                ? [collectionGenerationKey("memberships", `conversation:${request.query.conversationId}`)]
                : []),
            ];
    const collection = sqliteCollectionRevision(sqlite, base.sql, base.params, generationKeys);
    const revision = kind === "agent"
      ? `${collection.revision}:health=${health?.revision ?? ""}`
      : collection.revision;
    const total = collection.total;

    if (request.query.summary === "true") {
      return {
        kind, total, starredItems: [], items: [],
        ...(health ? { activity: summarizeWorkspaceActivity([...health.byId.values()], [...health.confirmedById.values()].sort()[0]) } : {}),
        ...(health && !request.query.projectId ? { activeCount: health.workingIds.length } : {}),
        ...(kind === "agent" && !request.query.projectId
          ? { runningCount: workspaceRunningAgentCount(context, health?.byId) }
          : {}),
        history: { limit, hasMore: false },
      } satisfies WorkspaceDirectoryPageDto;
    }

    let cursorPosition: CursorPosition | undefined;
    if (request.query.cursor) {
      try {
        cursorPosition = decodeCursor(request.query.cursor, scope, sort, revision);
      } catch (error) {
        return sendCollectionPageError(reply, error, "invalid directory cursor");
      }
    }

    const stars = canonicalAgentView ? [] : [...starredKeys(preferences)]
      .filter(key => key.startsWith(`${kind}:`))
      .map(key => key.slice(kind.length + 1));
    let starredRows: ResourceRow[] = [];
    if (!request.query.cursor && stars.length > 0) {
      starredRows = sqlite.prepare(`
        SELECT * FROM (${base.sql}) resources
        WHERE id IN (${placeholders(stars.length)})
      `).all(...base.params, ...stars) as ResourceRow[];
      const rank = new Map(stars.map((id, index) => [id, index] as const));
      starredRows.sort(
        (left, right) =>
          (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER),
      );
    }

    const ordering = orderingSql(sort, order);
    const pageWhere: string[] = [];
    const pageParams: unknown[] = [...ordering.rankParams, ...base.params];
    if (stars.length > 0) {
      pageWhere.push(`id NOT IN (${placeholders(stars.length)})`);
      pageParams.push(...stars);
    }
    const cursor = cursorSql(cursorPosition);
    if (cursor.sql) {
      pageWhere.push(cursor.sql);
      pageParams.push(...cursor.params);
    }
    pageParams.push(limit + 1);

    const candidateRows = sqlite.prepare(`
      SELECT * FROM (
        SELECT resources.*, lower(title) AS sort_title,
          ${ordering.rankSql} AS custom_rank
        FROM (${base.sql}) resources
      ) ranked_resources
      ${pageWhere.length > 0 ? `WHERE ${pageWhere.join(" AND ")}` : ""}
      ORDER BY ${ordering.sql}
      LIMIT ?
    `).all(...pageParams) as ResourceRow[];
    const hasMore = candidateRows.length > limit;
    const pageRows = candidateRows.slice(0, limit);

    const projectCache = new Map<string, ProjectDto>();
    const getProject = (id: string): ProjectDto | undefined => {
      if (projectCache.has(id)) return projectCache.get(id);
      const project = context.store.getProject(id);
      if (project) projectCache.set(id, project);
      return project;
    };

    const agentHealthById = health?.byId ?? new Map<string, AgentHealthDto>();
    const agentConfirmedById = health?.confirmedById ?? new Map<string, string>();
    if (kind === "agent") {
      const agentsByProject = new Map<string, AgentDto[]>();
      for (const row of [...starredRows, ...pageRows]) {
        const agent = context.store.getAgent(row.id);
        if (!agent) continue;
        const group = agentsByProject.get(agent.projectId) ?? [];
        group.push(agent);
        agentsByProject.set(agent.projectId, group);
      }
      for (const [projectId, agents] of agentsByProject) {
        if (agents.every(agent => agentHealthById.has(agent.id))) continue;
        // Relationships belong to the visible Project roster, not the page.
        // Read identities only; off-page Agents need no detailed health.
        const rosterQuery = baseDirectoryQuery("agent", { projectId }, "", [], [], []);
        const roster = sqlite.prepare(`
          SELECT a.id, a.manager_agent_id
          FROM (${rosterQuery.sql}) visible JOIN agents a ON a.id = visible.id
        `).all(...rosterQuery.params) as Array<{ id: string; manager_agent_id: string | null }>;
        const rosterIds = new Set(roster.map(agent => agent.id));
        const children = new Map<string, string[]>();
        for (const agent of roster) {
          if (!agent.manager_agent_id || !rosterIds.has(agent.manager_agent_id)) continue;
          const ids = children.get(agent.manager_agent_id) ?? [];
          ids.push(agent.id);
          children.set(agent.manager_agent_id, ids);
        }
        const parents = new Map(roster.map(agent => [agent.id, agent.manager_agent_id]));
        const projection = context.agentHealth({ type: "project", id: projectId }, agents);
        for (const health of projection.agents) {
          agentConfirmedById.set(health.agentId, projection.generatedAt);
          const { managerAgentId: _pageParent, ...details } = health;
          const parent = parents.get(health.agentId);
          agentHealthById.set(health.agentId, {
            ...details,
            ...(parent && rosterIds.has(parent) ? { managerAgentId: parent } : {}),
            childAgentIds: (children.get(health.agentId) ?? []).sort(),
          });
        }
      }
    }

    const hydrate = (row: ResourceRow): WorkspaceDirectoryItemDto | undefined => {
      const project = getProject(row.project_id);
      if (!project) return undefined;
      if (kind === "project") {
        return {
          kind: "project",
          project,
          displayPath: context.projectDisplayPath(project.hostPath),
          ...(row.recent_conversation_id &&
          row.recent_conversation_title &&
          row.recent_conversation_updated_at
            ? {
                recentConversation: {
                  id: row.recent_conversation_id,
                  title: row.recent_conversation_title,
                  updatedAt: row.recent_conversation_updated_at,
                },
              }
            : {}),
          conversationCount: row.conversation_count ?? 0,
          runningAgentCount: row.running_agent_count ?? 0,
        } satisfies WorkspaceProjectDirectoryItemDto;
      }
      if (kind === "conversation") {
        const conversation = context.store.getConversation(row.id);
        if (!conversation) return undefined;
        return {
          kind: "conversation",
          project: projectSummary(project),
          conversation,
          runningAgentCount: row.running_agent_count ?? 0,
        } satisfies WorkspaceConversationDirectoryItemDto;
      }
      if (kind === "agent") {
        const agent = context.store.getAgent(row.id);
        const health = agentHealthById.get(row.id);
        if (!agent || !health) return undefined;
        const ownerConversation = context.store.getConversation(
          agent.conversationId,
        );
        return {
          kind: "agent",
          project: projectSummary(project),
          agent,
          ...(ownerConversation
            ? {
                ownerConversation: {
                  id: ownerConversation.id,
                  title: ownerConversation.title,
                },
              }
            : {}),
          health,
          healthConfirmedAt: agentConfirmedById.get(row.id),
        } satisfies WorkspaceAgentDirectoryItemDto;
      }
      return undefined;
    };

    const starredItems = starredRows
      .map(hydrate)
      .filter((item): item is WorkspaceDirectoryItemDto => Boolean(item));
    const items = pageRows
      .map(hydrate)
      .filter((item): item is WorkspaceDirectoryItemDto => Boolean(item));
    const lastRow = pageRows[pageRows.length - 1];

    return {
      kind,
      starredItems,
      items,
      total,
      ...(health
        ? { activeCount: workingAgentIds.length }
        : {}),
      history: {
        limit,
        hasMore,
        ...(hasMore && lastRow
          ? {
              cursor: encodeCursor(
                nextCursorPosition(lastRow, sort),
                scope,
                revision,
              ),
            }
          : {}),
      },
    } satisfies WorkspaceDirectoryPageDto;
  });
}
