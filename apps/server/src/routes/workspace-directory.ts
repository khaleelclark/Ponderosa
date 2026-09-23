import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AgentDto,
  AgentHealthDto,
  AgentHealthProjectionDto,
  ProjectDto,
  ProjectSort,
  WorkspaceAgentDirectoryItemDto,
  WorkspaceConversationDirectoryItemDto,
  WorkspaceDirectoryItemDto,
  WorkspaceDirectoryKind,
  WorkspaceDirectoryPageDto,
  WorkspacePreferencesDto,
  WorkspaceProjectDirectoryItemDto,
  WorkspaceTriggerDirectoryItemDto,
} from "@ponderosa/core";
import type {
  AgentStore,
  CoordinationV3Store,
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
  enabled?: string;
  summary?: string;
};

type DirectorySort = ProjectSort | "next_fire";

type CursorPosition =
  | { kind: "custom"; rank: number; title: string; id: string }
  | { kind: "alphabetical"; title: string; id: string }
  | { kind: "last_used"; updatedAt: string; id: string }
  | { kind: "next_fire"; nextFireAt: string | null; id: string };

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
  next_fire_at: string | null;
  custom_rank?: number;
  sort_title?: string;
};

interface WorkspaceDirectoryRoutesContext {
  store: Pick<
    AgentStore,
    "sqlite" | "getProject" | "getConversation" | "getAgent"
  >;
  coordination: Pick<CoordinationV3Store, "getTriggerDefinition">;
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
      sort === "next_fire" && position.kind === "next_fire" &&
      (position.nextFireAt === null || typeof position.nextFireAt === "string") &&
      typeof position.id === "string"
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
      AND active_agent.archived = 0 AND active_agent.deleted_at IS NULL
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
  if (kind === "agent") {
    return {
      sort: preferences.agentSort ?? "last_used",
      order: preferences.agentOrder ?? [],
    };
  }
  return {
    sort: preferences.triggerSort ?? "last_used",
    order: preferences.triggerOrder ?? [],
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
            AND search_conversation.archived = 0
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
              AND count_conversation.archived = 0
          ) AS conversation_count,
          (
            SELECT recent.id FROM conversations recent
            WHERE recent.project_id = p.id AND recent.archived = 0
            ORDER BY recent.updated_at DESC, recent.id ASC LIMIT 1
          ) AS recent_conversation_id,
          (
            SELECT recent.title FROM conversations recent
            WHERE recent.project_id = p.id AND recent.archived = 0
            ORDER BY recent.updated_at DESC, recent.id ASC LIMIT 1
          ) AS recent_conversation_title,
          (
            SELECT recent.updated_at FROM conversations recent
            WHERE recent.project_id = p.id AND recent.archived = 0
            ORDER BY recent.updated_at DESC, recent.id ASC LIMIT 1
          ) AS recent_conversation_updated_at,
          ${runningAgentCountSql("active_agent.project_id = p.id")} AS running_agent_count,
          NULL AS next_fire_at
        FROM projects p
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      `,
      params,
    };
  }

  if (kind === "conversation") {
    where.push("c.archived = 0");
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
          ${runningAgentCountSql("active_agent.conversation_id = c.id")} AS running_agent_count,
          NULL AS next_fire_at
        FROM conversations c
        JOIN projects p ON p.id = c.project_id
        WHERE ${where.join(" AND ")}
      `,
      params,
    };
  }

  if (kind === "agent") {
    where.push("a.archived = 0", "a.deleted_at IS NULL");
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
        "lower(a.title || ' ' || a.active_engine || ' ' || p.label || ' ' || p.host_path) LIKE ? ESCAPE '\\'",
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
          NULL AS running_agent_count,
          NULL AS next_fire_at
        FROM agents a
        JOIN projects p ON p.id = a.project_id
        WHERE ${where.join(" AND ")}
      `,
      params,
    };
  }

  if (query.projectId) {
    where.push("t.project_id = ?");
    params.push(query.projectId);
  }
  where.push(`NOT EXISTS (
    SELECT 1
    FROM agent_creation_operation_members creation_members
    JOIN agent_creation_operations creation_operations ON creation_operations.id = creation_members.operation_id
    WHERE creation_members.agent_id = a.id
      AND creation_operations.status IN ('preparing', 'canonical_committed', 'rolling_back')
  )`);
  if (filteredAgentIds.length > 0) {
    where.push(`t.agent_id IN (${placeholders(filteredAgentIds.length)})`);
    params.push(...filteredAgentIds);
  }
  if (query.conversationId) {
    where.push("t.conversation_id = ?");
    params.push(query.conversationId);
  }
  if (query.enabled === "true") where.push("t.enabled = 1");
  if (normalizedSearch) {
    where.push(`lower(
      t.name || ' ' || t.instructions || ' ' || t.source_kind ||
      ' ' || a.title || ' ' || p.label
    ) LIKE ? ESCAPE '\\'`);
    params.push(pattern);
  }
  return {
    sql: `
      SELECT t.id, t.name AS title, t.updated_at, t.project_id,
        t.agent_id, t.conversation_id,
        NULL AS conversation_count, NULL AS recent_conversation_id,
        NULL AS recent_conversation_title,
        NULL AS recent_conversation_updated_at,
        NULL AS running_agent_count,
        t.next_fire_at
      FROM trigger_definitions t
      JOIN agents a ON a.id = t.agent_id
        AND a.archived = 0 AND a.deleted_at IS NULL
      JOIN projects p ON p.id = t.project_id
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    `,
    params,
  };
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
  if (sort === "next_fire") {
    return { sql: "next_fire_at IS NULL ASC, next_fire_at ASC, id ASC", rankSql: "0", rankParams: [] };
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
  if (position.kind === "next_fire") {
    return position.nextFireAt === null
      ? { sql: "next_fire_at IS NULL AND id > ?", params: [position.id] }
      : {
          sql: "(next_fire_at IS NULL OR next_fire_at > ? OR (next_fire_at = ? AND id > ?))",
          params: [position.nextFireAt, position.nextFireAt, position.id],
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
  if (sort === "next_fire") {
    return { kind: "next_fire", nextFireAt: row.next_fire_at, id: row.id };
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

function workspaceAgentHealth(
  context: WorkspaceDirectoryRoutesContext,
  projectId?: string,
  includeRunHistory = true,
): {
  byId: Map<string, AgentHealthDto>;
  workingIds: string[];
  outcomeIds: string[];
  revision: string;
} {
  const rows = context.store.sqlite.prepare(`
    SELECT a.id, a.project_id
    FROM agents a
    WHERE a.archived = 0 AND a.deleted_at IS NULL
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
  for (const [projectId, agents] of agentsByProject) {
    for (const health of context.agentHealth(
      { type: "project", id: projectId },
      agents,
      { includeRunHistory },
    ).agents) {
      byId.set(health.agentId, health);
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
      Boolean(health.assignedWorkOutcome))
    .sort((left, right) =>
      right.assignedWorkOutcome.updatedAt.localeCompare(left.assignedWorkOutcome.updatedAt) ||
      left.agentId.localeCompare(right.agentId))
    .slice(0, MAX_RECENT_OUTCOMES);
  return {
    byId,
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

function workspaceEnabledTriggerCount(sqlite: Database.Database): number {
  const row = sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM trigger_definitions t
    JOIN agents a ON a.id = t.agent_id
      AND a.archived = 0 AND a.deleted_at IS NULL
    WHERE t.enabled = 1
      AND NOT EXISTS (
        SELECT 1
        FROM agent_creation_operation_members creation_members
        JOIN agent_creation_operations creation_operations ON creation_operations.id = creation_members.operation_id
        WHERE creation_members.agent_id = a.id
          AND creation_operations.status IN ('preparing', 'canonical_committed', 'rolling_back')
      )
  `).get() as { count: number };
  return row.count;
}

export function registerWorkspaceDirectoryRoutes(
  app: FastifyInstance,
  context: WorkspaceDirectoryRoutesContext,
): void {
  app.get<{
    Params: { kind: string };
    Querystring: DirectoryQuery;
  }>("/api/workspace/directory/:kind", async (request, reply) => {
    const kind = request.params.kind;
    if (
      kind !== "project" &&
      kind !== "conversation" &&
      kind !== "agent" &&
      kind !== "trigger"
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
    if (request.query.enabled !== undefined &&
        (kind !== "trigger" || request.query.enabled !== "true")) {
      return reply.code(400).send({ error: "enabled=true is supported only for the Automation directory" });
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
      requestedSort !== "custom" &&
      requestedSort !== "next_fire"
    ) {
      return reply.code(400).send({ error: "invalid directory sort" });
    }
    if (requestedSort === "next_fire" && (kind !== "trigger" || request.query.enabled !== "true")) {
      return reply.code(400).send({ error: "next_fire sort requires enabled Automations" });
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
        : sort === "next_fire" ? [] : settings.order;
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
      enabled: request.query.enabled ?? "",
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
        : kind === "agent"
          ? [
              scoped("agents"),
              projectKey,
              "scheduler_runs",
              "context_rollovers",
              ...(request.query.conversationId
                ? [collectionGenerationKey("memberships", `conversation:${request.query.conversationId}`)]
                : []),
            ]
          : [scoped("triggers"), scoped("agents"), projectKey];
    const collection = sqliteCollectionRevision(sqlite, base.sql, base.params, generationKeys);
    const revision = kind === "agent"
      ? `${collection.revision}:health=${health?.revision ?? ""}`
      : collection.revision;
    const total = collection.total;

    if (request.query.summary === "true") {
      return {
        kind, total, starredItems: [], items: [],
        ...(health && !request.query.projectId ? { activeCount: health.workingIds.length } : {}),
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

    const stars = sort === "next_fire" || canonicalAgentView ? [] : [...starredKeys(preferences)]
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
        for (const health of context.agentHealth(
          { type: "project", id: projectId },
          agents,
        ).agents) {
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
        } satisfies WorkspaceAgentDirectoryItemDto;
      }
      const trigger = context.coordination.getTriggerDefinition(row.id);
      const targetAgent = row.agent_id
        ? context.store.getAgent(row.agent_id)
        : undefined;
      if (!trigger) return undefined;
      return {
        kind: "trigger",
        project: projectSummary(project),
        ...(targetAgent
          ? { targetAgent: { id: targetAgent.id, title: targetAgent.title } }
          : {}),
        trigger,
      } satisfies WorkspaceTriggerDirectoryItemDto;
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
      ...(kind === "trigger"
        ? { enabledCount: workspaceEnabledTriggerCount(sqlite) }
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
