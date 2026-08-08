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
import { sendCollectionPageError, sqliteCollectionRevision, StaleCollectionCursorError } from "../collection-page.js";

const DEFAULT_DIRECTORY_LIMIT = 25;
const MAX_DIRECTORY_LIMIT = 100;

type DirectoryQuery = {
  limit?: string;
  cursor?: string;
  search?: string;
  projectId?: string;
  agentIds?: string;
  conversationId?: string;
  sort?: string;
};

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
  coordination: Pick<CoordinationV3Store, "getTriggerDefinition">;
  workspace: Pick<WorkspaceStore, "getPreferences">;
  agentHealth(
    scope: AgentHealthProjectionDto["scope"],
    agents: AgentDto[],
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
  sort: ProjectSort,
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
          (
            SELECT COUNT(*) FROM agents active_agent
            WHERE active_agent.project_id = p.id
              AND active_agent.archived = 0
              AND active_agent.deleted_at IS NULL
              AND (
                EXISTS (
                  SELECT 1 FROM scheduler_runs active_run
                  WHERE active_run.agent_id = active_agent.id
                    AND active_run.status IN ('leased', 'running')
                )
                OR EXISTS (
                  SELECT 1 FROM context_rollovers active_rollover
                  WHERE active_rollover.agent_id = active_agent.id
                    AND active_rollover.state IN (
                      'requested', 'handoff_committed',
                      'session_retiring', 'continuation_ready'
                    )
                )
              )
          ) AS running_agent_count
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
          NULL AS running_agent_count
        FROM conversations c
        JOIN projects p ON p.id = c.project_id
        WHERE ${where.join(" AND ")}
      `,
      params,
    };
  }

  if (kind === "agent") {
    where.push("a.archived = 0", "a.deleted_at IS NULL");
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
          NULL AS running_agent_count
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
  if (filteredAgentIds.length > 0) {
    where.push(`t.agent_id IN (${placeholders(filteredAgentIds.length)})`);
    params.push(...filteredAgentIds);
  }
  if (query.conversationId) {
    where.push("t.conversation_id = ?");
    params.push(query.conversationId);
  }
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
        NULL AS running_agent_count
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
  sort: ProjectSort,
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
  sort: ProjectSort,
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

function workspaceActiveAgentCount(sqlite: Database.Database): number {
  const row = sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM agents a
    WHERE a.archived = 0
      AND a.deleted_at IS NULL
      AND (
        EXISTS (
          SELECT 1 FROM scheduler_runs r
          WHERE r.agent_id = a.id AND r.status IN ('leased', 'running')
        )
        OR EXISTS (
          SELECT 1 FROM context_rollovers c
          WHERE c.agent_id = a.id
            AND c.state IN (
              'requested', 'handoff_committed',
              'session_retiring', 'continuation_ready'
            )
        )
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
    const sort = requestedSort ?? settings.sort;
    const sqlite = context.store.sqlite;
    const order = settings.order;
    const normalizedSearch = (request.query.search ?? "")
      .trim()
      .toLocaleLowerCase();
    const filteredAgentIds = [
      ...new Set((request.query.agentIds ?? "").split(",").filter(Boolean)),
    ];

    const directorySettingsHash = createHash("sha256")
      .update(JSON.stringify({
        order,
        stars: [...starredKeys(preferences)]
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
      directorySettingsHash,
    });

    const base = baseDirectoryQuery(
      kind,
      request.query,
      normalizedSearch,
      filteredAgentIds,
    );
    const generationKeys = kind === "project"
      ? ["projects", "conversations"]
      : kind === "conversation"
        ? ["conversations", "projects"]
        : kind === "agent"
          ? ["agents", "projects"]
          : ["triggers", "agents", "projects"];
    const collection = sqliteCollectionRevision(sqlite, base.sql, base.params, generationKeys);
    const revision = collection.revision;
    const total = collection.total;

    let cursorPosition: CursorPosition | undefined;
    if (request.query.cursor) {
      try {
        cursorPosition = decodeCursor(request.query.cursor, scope, sort, revision);
      } catch (error) {
        return sendCollectionPageError(reply, error, "invalid directory cursor");
      }
    }

    const stars = [...starredKeys(preferences)]
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

    const agentHealthById = new Map<string, AgentHealthDto>();
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
        for (const health of context.agentHealth(
          { type: "project", id: projectId },
          agents,
        ).agents) {
          agentHealthById.set(health.agentId, health);
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
        } satisfies WorkspaceConversationDirectoryItemDto;
      }
      if (kind === "agent") {
        const agent = context.store.getAgent(row.id);
        const health = agentHealthById.get(row.id);
        if (!agent || !health) return undefined;
        return {
          kind: "agent",
          project: projectSummary(project),
          agent,
          health,
        } satisfies WorkspaceAgentDirectoryItemDto;
      }
      const trigger = context.coordination.getTriggerDefinition(row.id);
      const agent = row.agent_id
        ? context.store.getAgent(row.agent_id)
        : undefined;
      if (!trigger || !agent) return undefined;
      return {
        kind: "trigger",
        project: projectSummary(project),
        agent: { id: agent.id, title: agent.title },
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
      ...(kind === "agent"
        ? { activeCount: workspaceActiveAgentCount(sqlite) }
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
