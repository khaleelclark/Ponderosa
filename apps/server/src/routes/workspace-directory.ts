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

type CursorPayload = {
  v: 1;
  offset: number;
  scope: string;
};

interface WorkspaceDirectoryRoutesContext {
  store: Pick<AgentStore, "listProjects" | "listConversations" | "listAgents">;
  coordination: Pick<CoordinationV3Store, "listTriggerDefinitions">;
  workspace: Pick<WorkspaceStore, "getPreferences">;
  agentHealth(
    scope: AgentHealthProjectionDto["scope"],
    agents: AgentDto[],
  ): AgentHealthProjectionDto;
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

function encodeCursor(offset: number, scope: string): string {
  return Buffer.from(
    JSON.stringify({ v: 1, offset, scope } satisfies CursorPayload),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(value: string, scope: string): number {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<CursorPayload>;
    if (
      parsed.v !== 1 ||
      parsed.scope !== scope ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset ?? -1) < 0
    ) {
      throw new Error("invalid directory cursor");
    }
    return parsed.offset!;
  } catch {
    throw new Error("invalid directory cursor");
  }
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

    const preferences = context.workspace.getPreferences();
    const projects = context.store.listProjects();
    const projectById = new Map(projects.map(project => [project.id, project]));
    const projectAgents = new Map<string, AgentDto[]>();
    const agentsForProject = (projectId: string): AgentDto[] => {
      const cached = projectAgents.get(projectId);
      if (cached) return cached;
      const agents = context.store.listAgents(projectId);
      projectAgents.set(projectId, agents);
      return agents;
    };

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
        },
      }));
    } else if (kind === "conversation") {
      rows = projects.flatMap(project =>
        context.store
          .listConversations(project.id)
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
      rows = projects.flatMap(project =>
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
        row.searchText += ` ${context.store
          .listConversations(row.projectId)
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

    const { sort, order } = resourceSettings(preferences, kind);
    sortSeeds(rows, sort, order);
    const stars = starredKeys(preferences);
    const prefix = kind === "conversation" ? "conversation" : kind;
    const starredRows = rows.filter(row => stars.has(`${prefix}:${row.id}`));
    const unstarredRows = rows.filter(
      row => !stars.has(`${prefix}:${row.id}`),
    );
    const scope = JSON.stringify({
      kind,
      search: normalizedSearch,
      projectId: request.query.projectId ?? "",
      agentIds: [...filteredAgentIds].sort(),
      conversationId: request.query.conversationId ?? "",
      sort,
    });

    let offset = 0;
    if (request.query.cursor) {
      try {
        offset = decodeCursor(request.query.cursor, scope);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    }
    const pageRows = unstarredRows.slice(offset, offset + limit);
    const hasMore = offset + pageRows.length < unstarredRows.length;

    let starredItems = starredRows.map(row => row.item) as WorkspaceDirectoryItemDto[];
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
        const conversations = context.store
          .listConversations(item.project.id)
          .filter(conversation => !conversation.archived)
          .sort((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt),
          );
        const health = context.agentHealth(
          { type: "project", id: item.project.id },
          agentsForProject(item.project.id),
        ).agents;
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
      starredItems = starredRows.map(withSummary);
      items = pageRows.map(withSummary);
    } else if (kind === "agent") {
      const allHealth = projects.flatMap(project =>
        context
          .agentHealth(
            { type: "project", id: project.id },
            agentsForProject(project.id),
          )
          .agents,
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
      starredItems = starredRows.map(withHealth);
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
          ? { cursor: encodeCursor(offset + pageRows.length, scope) }
          : {}),
      },
    } satisfies WorkspaceDirectoryPageDto;
  });
}
