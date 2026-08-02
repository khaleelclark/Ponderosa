import { createHash } from "node:crypto";
import type {
  AgentDto,
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

type DirectorySeed = {
  id: string;
  title: string;
  updatedAt: string;
  projectId: string;
  agentId?: string;
  conversationId?: string;
  searchText: string;
  item: WorkspaceDirectoryItemDto |
    Omit<WorkspaceAgentDirectoryItemDto, "health"> |
    Omit<WorkspaceProjectDirectoryItemDto,
      "recentConversation" | "conversationCount" | "runningAgentCount"
    >;
};

type CursorPosition =
  | { kind: "offset"; offset: number }
  | { kind: "alphabetical"; title: string; id: string }
  | { kind: "last_used"; updatedAt: string; id: string };

type CursorPayload = {
  v: 2;
  scope: string;
  position: CursorPosition;
};

interface WorkspaceDirectoryRoutesContext {
  store: Pick<AgentStore, "listProjects" | "listConversations" | "listAgents">;
  coordination: Pick<CoordinationV3Store, "listTriggerDefinitions">;
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

function encodeCursor(position: CursorPosition, scope: string): string {
  return Buffer.from(
    JSON.stringify({ v: 2, position, scope } satisfies CursorPayload),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(
  value: string,
  scope: string,
  sort: ProjectSort,
): CursorPosition {
  try {
    if (!value || value.length > 4096) throw new Error();
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<CursorPayload>;
    if (parsed.v !== 2 || parsed.scope !== scope || !parsed.position) {
      throw new Error();
    }
    const position = parsed.position;
    if (
      sort === "custom" && position.kind === "offset" &&
      Number.isSafeInteger(position.offset) && position.offset >= 0
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
  } catch {
    throw new Error("invalid directory cursor");
  }
}

function rowsAfterCursor(
  rows: DirectorySeed[],
  position: CursorPosition,
): DirectorySeed[] {
  if (position.kind === "offset") return rows.slice(position.offset);
  if (position.kind === "alphabetical") {
    return rows.filter(row =>
      row.title.localeCompare(position.title) > 0 ||
      (row.title.localeCompare(position.title) === 0 &&
        row.id.localeCompare(position.id) > 0),
    );
  }
  return rows.filter(row =>
    row.updatedAt.localeCompare(position.updatedAt) < 0 ||
    (row.updatedAt === position.updatedAt &&
      row.id.localeCompare(position.id) > 0),
  );
}

function nextCursorPosition(
  row: DirectorySeed,
  sort: ProjectSort,
  nextOffset: number,
): CursorPosition {
  if (sort === "custom") return { kind: "offset", offset: nextOffset };
  if (sort === "alphabetical") {
    return { kind: "alphabetical", title: row.title, id: row.id };
  }
  return { kind: "last_used", updatedAt: row.updatedAt, id: row.id };
}

function resourceSettings(
  preferences: WorkspacePreferencesDto,
  kind: WorkspaceDirectoryKind,
): { sort: ProjectSort; order: readonly string[] } {
  if (kind === "project") {
    return {
      sort: preferences.projectSort,
      order: preferences.projectOrder,
    };
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

function sortSeeds(
  rows: DirectorySeed[],
  sort: ProjectSort,
  order: readonly string[],
): DirectorySeed[] {
  if (sort === "alphabetical") {
    return rows.sort(
      (left, right) =>
        left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
    );
  }
  if (sort === "last_used") {
    return rows.sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id),
    );
  }
  const rank = new Map(order.map((id, index) => [id, index] as const));
  return rows.sort((left, right) => {
    const leftRank = rank.get(left.id);
    const rightRank = rank.get(right.id);
    if (leftRank === undefined && rightRank === undefined) {
      return (
        left.title.localeCompare(right.title) ||
        left.id.localeCompare(right.id)
      );
    }
    if (leftRank === undefined) return 1;
    if (rightRank === undefined) return -1;
    return leftRank - rightRank;
  });
}

function starredKeys(preferences: WorkspacePreferencesDto): Set<string> {
  return new Set([
    ...(preferences.starredResourceIds ?? []),
    ...preferences.starredProjectIds.map(id => `project:${id}`),
  ]);
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
    ) return reply.code(400).send({ error: "invalid directory sort" });

    const preferences = context.workspace.getPreferences();
    const projects = context.store.listProjects();
    const projectById = new Map(projects.map(project => [project.id, project]));
    const projectAgents = new Map<string, AgentDto[]>();
    const projectConversations = new Map<
      string,
      ReturnType<AgentStore["listConversations"]>
    >();
    const projectHealth = new Map<string, AgentHealthProjectionDto>();
    const agentsForProject = (projectId: string): AgentDto[] => {
      const cached = projectAgents.get(projectId);
      if (cached) return cached;
      const agents = context.store.listAgents(projectId);
      projectAgents.set(projectId, agents);
      return agents;
    };
    const conversationsForProject = (projectId: string) => {
      const cached = projectConversations.get(projectId);
      if (cached) return cached;
      const conversations = context.store.listConversations(projectId);
      projectConversations.set(projectId, conversations);
      return conversations;
    };
    const healthForProject = (projectId: string) => {
      const cached = projectHealth.get(projectId);
      if (cached) return cached;
      const health = context.agentHealth(
        { type: "project", id: projectId },
        agentsForProject(projectId),
      );
      projectHealth.set(projectId, health);
      return health;
    };
    const directoryProjects = request.query.projectId
      ? projects.filter(project => project.id === request.query.projectId)
      : projects;

    let rows: DirectorySeed[];
    if (kind === "project") {
      rows = projects.map(project => ({
        id: project.id,
        title: project.label,
        updatedAt: project.lastUsedAt ?? project.createdAt,
        projectId: project.id,
        searchText: `${project.label} ${project.hostPath}`,
        item: {
          kind: "project",
          project,
          displayPath: context.projectDisplayPath(project.hostPath),
        },
      }));
    } else if (kind === "conversation") {
      rows = directoryProjects.flatMap(project =>
        conversationsForProject(project.id)
          .filter(conversation => !conversation.archived)
          .map(conversation => ({
            id: conversation.id,
            title: conversation.title,
            updatedAt: conversation.updatedAt,
            projectId: project.id,
            searchText: `${conversation.title} ${project.label} ${project.hostPath}`,
            item: {
              kind: "conversation",
              project: projectSummary(project),
              conversation,
            } satisfies WorkspaceConversationDirectoryItemDto,
          })),
      );
    } else if (kind === "agent") {
      rows = directoryProjects.flatMap(project =>
        agentsForProject(project.id)
          .filter(agent => !agent.archived)
          .map(agent => ({
            id: agent.id,
            title: agent.title,
            updatedAt: agent.updatedAt,
            projectId: project.id,
            searchText: `${agent.title} ${agent.activeEngine} ${project.label} ${project.hostPath}`,
            item: {
              kind: "agent",
              project: projectSummary(project),
              agent,
            },
          })),
      );
    } else {
      const agentById = new Map(
        projects.flatMap(project =>
          agentsForProject(project.id).map(
            agent => [agent.id, { agent, project }] as const,
          ),
        ),
      );
      rows = context.coordination
        .listTriggerDefinitions()
        .flatMap(trigger => {
          const destination = agentById.get(trigger.agentId);
          if (!destination) return [];
          return [{
            id: trigger.id,
            title: trigger.name,
            updatedAt: trigger.updatedAt,
            projectId: destination.project.id,
            agentId: destination.agent.id,
            conversationId: trigger.conversationId,
            searchText: [
              trigger.name,
              trigger.instructions,
              trigger.sourceKind,
              destination.agent.title,
              destination.project.label,
            ].join(" "),
            item: {
              kind: "trigger",
              project: projectSummary(destination.project),
              agent: {
                id: destination.agent.id,
                title: destination.agent.title,
              },
              trigger,
            } satisfies WorkspaceTriggerDirectoryItemDto,
          }];
        });
    }

    const normalizedSearch = (request.query.search ?? "")
      .trim()
      .toLocaleLowerCase();
    if (kind === "project" && normalizedSearch) {
      for (const row of rows) {
        row.searchText += ` ${conversationsForProject(row.projectId)
          .filter(conversation => !conversation.archived)
          .map(conversation => conversation.title)
          .join(" ")}`;
      }
    }
    const filteredAgentIds = new Set(
      (request.query.agentIds ?? "").split(",").filter(Boolean),
    );
    rows = rows.filter(row =>
      (!request.query.projectId || row.projectId === request.query.projectId) &&
      (filteredAgentIds.size === 0 ||
        Boolean(row.agentId && filteredAgentIds.has(row.agentId))) &&
      (!request.query.conversationId ||
        row.conversationId === request.query.conversationId) &&
      (!normalizedSearch ||
        row.searchText.toLocaleLowerCase().includes(normalizedSearch)),
    );

    const settings = resourceSettings(preferences, kind);
    const sort = requestedSort ?? settings.sort;
    const order = settings.order;
    sortSeeds(rows, sort, order);
    const stars = starredKeys(preferences);
    const starredRows = rows.filter(row => stars.has(`${kind}:${row.id}`));
    const unstarredRows = rows.filter(
      row => !stars.has(`${kind}:${row.id}`),
    );
    const directorySettingsHash = createHash("sha256")
      .update(JSON.stringify({
        order,
        stars: [...stars]
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

    let cursorPosition: CursorPosition | undefined;
    if (request.query.cursor) {
      try {
        cursorPosition = decodeCursor(request.query.cursor, scope, sort);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    }
    const candidateRows = cursorPosition
      ? rowsAfterCursor(unstarredRows, cursorPosition)
      : unstarredRows;
    const pageRows = candidateRows.slice(0, limit);
    const hasMore = pageRows.length < candidateRows.length;
    const previousOffset = cursorPosition?.kind === "offset"
      ? cursorPosition.offset
      : 0;
    const includeStarred = !request.query.cursor;

    let starredItems = includeStarred
      ? starredRows.map(row => row.item) as WorkspaceDirectoryItemDto[]
      : [];
    let items = pageRows.map(row => row.item) as WorkspaceDirectoryItemDto[];
    let activeCount: number | undefined;
    if (kind === "project") {
      const withSummary = (
        row: DirectorySeed,
      ): WorkspaceProjectDirectoryItemDto => {
        const item = row.item as Omit<
          WorkspaceProjectDirectoryItemDto,
          "recentConversation" | "conversationCount" | "runningAgentCount"
        >;
        const conversations = conversationsForProject(item.project.id)
          .filter(conversation => !conversation.archived)
          .sort((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt),
          );
        const health = healthForProject(item.project.id).agents;
        const recent = conversations[0];
        return {
          ...item,
          ...(recent ? {
            recentConversation: {
              id: recent.id,
              title: recent.title,
              updatedAt: recent.updatedAt,
            },
          } : {}),
          conversationCount: conversations.length,
          runningAgentCount: health.filter(agent =>
            agent.status === "running" || agent.status === "compacting"
          ).length,
        };
      };
      starredItems = includeStarred ? starredRows.map(withSummary) : [];
      items = pageRows.map(withSummary);
    } else if (kind === "agent") {
      const allHealth = projects.flatMap(project =>
        healthForProject(project.id).agents,
      );
      const healthByAgentId = new Map(
        allHealth.map(health => [health.agentId, health] as const),
      );
      activeCount = allHealth.filter(
        health => health.status === "running" || health.status === "compacting",
      ).length;
      const withHealth = (
        row: DirectorySeed,
      ): WorkspaceAgentDirectoryItemDto => {
        const item = row.item as Omit<WorkspaceAgentDirectoryItemDto, "health">;
        return {
          ...item,
          health: healthByAgentId.get(item.agent.id)!,
        };
      };
      starredItems = includeStarred ? starredRows.map(withHealth) : [];
      items = pageRows.map(withHealth);
    }

    return {
      kind,
      starredItems,
      items,
      total: rows.length,
      ...(activeCount === undefined ? {} : { activeCount }),
      history: {
        limit,
        hasMore,
        ...(hasMore
          ? {
              cursor: encodeCursor(
                nextCursorPosition(
                  pageRows[pageRows.length - 1]!,
                  sort,
                  previousOffset + pageRows.length,
                ),
                scope,
              ),
            }
          : {}),
      },
    } satisfies WorkspaceDirectoryPageDto;
  });
}
