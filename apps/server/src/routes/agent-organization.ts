import type {
  AgentDto,
  AgentHealthProjectionDto,
  AgentOperationalStatus,
  AgentOrganizationHealthDto,
  AgentOrganizationNodeDto,
  AgentOrganizationPageDto,
  AgentOrganizationScope,
} from "@ponderosa/core";
import type { AgentStore } from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  collectionGenerationKey,
  sendCollectionPageError,
  sqliteCollectionGeneration,
  sqliteCollectionPage,
  StaleCollectionCursorError,
  type CollectionQuery,
} from "../collection-page.js";

const ORGANIZATION_STATUSES = new Set<AgentOperationalStatus>([
  "idle",
  "preparing",
  "running",
  "waiting",
  "needs_decision",
  "completed",
  "blocked",
  "compacting",
  "cancelled",
  "failed",
  "stalled",
  "interrupted",
]);

const ORGANIZATION_CURSOR_KEY = randomBytes(32);
const MAX_SIGNED_ORGANIZATION_CURSOR_LENGTH = 4_096;

function signOrganizationCursor(rawCursor: string): string {
  const signature = createHmac("sha256", ORGANIZATION_CURSOR_KEY)
    .update(rawCursor)
    .digest("base64url");
  return `v1.${rawCursor}.${signature}`;
}

function unwrapOrganizationCursor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length > MAX_SIGNED_ORGANIZATION_CURSOR_LENGTH) {
    throw new StaleCollectionCursorError();
  }
  const parts = value.split(".");
  if (
    parts.length !== 3 ||
    parts[0] !== "v1" ||
    !parts[1] ||
    !/^[A-Za-z0-9_-]+$/.test(parts[1]) ||
    !parts[2] ||
    !/^[A-Za-z0-9_-]+$/.test(parts[2])
  ) {
    throw new StaleCollectionCursorError();
  }
  const actual = Buffer.from(parts[2], "base64url");
  const expected = createHmac("sha256", ORGANIZATION_CURSOR_KEY)
    .update(parts[1])
    .digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new StaleCollectionCursorError();
  }
  return parts[1];
}

interface OrganizationQuery extends CollectionQuery {
  scope?: AgentOrganizationScope;
  parentAgentId?: string;
  status?: AgentOperationalStatus;
}

interface AgentOrganizationRoutesContext {
  store: AgentStore;
  agentHealth(
    scope: AgentHealthProjectionDto["scope"],
    agents: AgentDto[],
  ): AgentHealthProjectionDto;
}

interface LiveOrganizationRow {
  id: string;
  project_id: string;
  title: string;
  handle: string;
  active_engine: AgentDto["activeEngine"];
  created_at: string;
  updated_at: string;
  manager_agent_id: string | null;
  manager_id: string | null;
  manager_title: string | null;
  direct_report_count: number;
}

interface DeletedOrganizationRow {
  id: string;
  title: string;
  deleted_at: string;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function healthSubset(
  health: AgentHealthProjectionDto["agents"][number] | undefined,
): AgentOrganizationHealthDto | undefined {
  if (!health) return undefined;
  return {
    status: health.status,
    statusTimestamp: health.statusTimestamp,
    reason: health.reason,
    ...(health.phase ? { phase: health.phase } : {}),
    ...(health.executionId ? { executionId: health.executionId } : {}),
    ...(health.schedulerRunId ? { schedulerRunId: health.schedulerRunId } : {}),
    ...(health.runtimeOwnership ? { runtimeOwnership: health.runtimeOwnership } : {}),
    ...(health.attention ? { attention: health.attention } : {}),
  };
}

export function registerAgentOrganizationRoutes(
  app: FastifyInstance,
  context: AgentOrganizationRoutesContext,
): void {
  app.get<{
    Params: { projectId: string };
    Querystring: OrganizationQuery;
  }>("/api/projects/:projectId/agent-organization", async (request, reply) => {
    const { projectId } = request.params;
    if (!context.store.getProject(projectId)) {
      return reply.code(404).send({ error: "project not found" });
    }
    const scope = request.query.scope ?? "roots";
    if (!["roots", "children", "orphaned", "deleted"].includes(scope)) {
      return reply.code(400).send({ error: "invalid organization scope" });
    }
    const parentAgentId = request.query.parentAgentId?.trim();
    if (scope === "children") {
      if (!parentAgentId) {
        return reply.code(400).send({ error: "parentAgentId is required for children" });
      }
      const parent = context.store.getAgent(parentAgentId);
      if (!parent || parent.projectId !== projectId || parent.archived) {
        return reply.code(404).send({ error: "parent Agent not found" });
      }
    } else if (parentAgentId) {
      return reply.code(400).send({ error: "parentAgentId is valid only for children" });
    }
    const normalizedSearch = request.query.search?.trim().toLocaleLowerCase() ?? "";
    if (normalizedSearch.length > 200) {
      return reply.code(400).send({ error: "search must be 200 characters or fewer" });
    }
    const status = request.query.status;
    if (status && !ORGANIZATION_STATUSES.has(status)) {
      return reply.code(400).send({ error: "invalid Agent status" });
    }
    if (scope === "deleted" && status) {
      return reply.code(400).send({ error: "deleted history has no live status" });
    }

    const generationKey = collectionGenerationKey("agents", `project:${projectId}`);
    const collectionGeneration = sqliteCollectionGeneration(
      context.store.sqlite,
      [generationKey],
    );
    const escapedSearch = normalizedSearch.replace(/[\\%_]/g, match => `\\${match}`);
    const filteredFlat = Boolean(normalizedSearch || status);
    let scopePredicate: string;
    const params: unknown[] = [projectId];
    if (scope === "deleted") {
      scopePredicate = "a.deleted_at IS NOT NULL";
    } else if (filteredFlat) {
      scopePredicate = "a.deleted_at IS NULL AND a.archived = 0";
    } else if (scope === "roots") {
      scopePredicate = "a.deleted_at IS NULL AND a.archived = 0 AND a.manager_agent_id IS NULL";
    } else if (scope === "children") {
      scopePredicate = "a.deleted_at IS NULL AND a.archived = 0 AND a.manager_agent_id = ?";
      params.push(parentAgentId!);
    } else {
      scopePredicate = `a.deleted_at IS NULL AND a.archived = 0
        AND a.manager_agent_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM agents manager
          WHERE manager.id = a.manager_agent_id
            AND manager.project_id = a.project_id
            AND manager.deleted_at IS NULL
            AND manager.archived = 0
        )`;
    }
    const searchPredicate = normalizedSearch
      ? "AND lower(a.title || ' ' || a.active_engine) LIKE ? ESCAPE '\\'"
      : "";
    if (normalizedSearch) params.push(`%${escapedSearch}%`);
    const baseSql = `
      SELECT a.id, a.title, a.updated_at
      FROM agents a
      WHERE a.project_id = ? AND ${scopePredicate}
      ${searchPredicate}
    `;

    try {
      const rawCursor = unwrapOrganizationCursor(request.query.cursor);
      let idPage;
      try {
        idPage = sqliteCollectionPage<string>(
          context.store.sqlite,
          { ...request.query, cursor: rawCursor },
          {
          baseSql,
          params,
          order: "title",
          scope: `agent-organization:${projectId}:${scope}:${parentAgentId ?? ""}:${status ?? ""}`,
          generationKeys: [generationKey],
          defaultLimit: 25,
          maxLimit: 100,
          hydrate: id => id,
          },
        );
      } catch (error) {
        if (request.query.cursor && !(error instanceof StaleCollectionCursorError)) {
          throw new StaleCollectionCursorError();
        }
        throw error;
      }
      const specialGroupCounts = context.store.sqlite.prepare(`
        SELECT
          SUM(CASE WHEN a.deleted_at IS NULL AND a.archived = 0
            AND a.manager_agent_id IS NULL THEN 1 ELSE 0 END) AS independent,
          SUM(CASE WHEN a.deleted_at IS NULL AND a.archived = 0
            AND a.manager_agent_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM agents manager
              WHERE manager.id = a.manager_agent_id
                AND manager.project_id = a.project_id
                AND manager.deleted_at IS NULL
                AND manager.archived = 0
            ) THEN 1 ELSE 0 END) AS orphaned,
          SUM(CASE WHEN a.deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted
        FROM agents a WHERE a.project_id = ?
      `).get(projectId) as {
        independent: number | null;
        orphaned: number | null;
        deleted: number | null;
      };

      let items: AgentOrganizationNodeDto[];
      if (scope === "deleted") {
        const rows = idPage.items.length === 0 ? [] : context.store.sqlite.prepare(`
          SELECT id, title, deleted_at
          FROM agents
          WHERE project_id = ? AND deleted_at IS NOT NULL
            AND id IN (${placeholders(idPage.items.length)})
        `).all(projectId, ...idPage.items) as DeletedOrganizationRow[];
        const byId = new Map(rows.map(row => [row.id, row]));
        items = idPage.items.flatMap(id => {
          const row = byId.get(id);
          return row ? [{
            id: row.id,
            title: row.title,
            relation: { kind: "deleted" as const, deletedAt: row.deleted_at },
          }] : [];
        });
      } else {
        const rows = idPage.items.length === 0 ? [] : context.store.sqlite.prepare(`
          SELECT
            a.id, a.project_id, a.title, a.handle, a.active_engine, a.created_at,
            a.updated_at, a.manager_agent_id,
            manager.id AS manager_id, manager.title AS manager_title,
            (
              SELECT COUNT(*) FROM agents child
              WHERE child.project_id = a.project_id
                AND child.manager_agent_id = a.id
                AND child.deleted_at IS NULL
                AND child.archived = 0
            ) AS direct_report_count
          FROM agents a
          LEFT JOIN agents manager
            ON manager.id = a.manager_agent_id
            AND manager.project_id = a.project_id
            AND manager.deleted_at IS NULL
            AND manager.archived = 0
          WHERE a.project_id = ? AND a.deleted_at IS NULL AND a.archived = 0
            AND a.id IN (${placeholders(idPage.items.length)})
        `).all(projectId, ...idPage.items) as LiveOrganizationRow[];
        const agents: AgentDto[] = rows.flatMap(row => {
          const agent = context.store.getAgent(row.id);
          return agent ? [agent] : [];
        });
        const projected = context.agentHealth(
          { type: "project", id: projectId },
          agents,
        );
        const healthById = new Map(projected.agents.map(health => [health.agentId, health]));
        const byId = new Map(rows.map(row => [row.id, row]));
        items = idPage.items.flatMap(id => {
          const row = byId.get(id);
          if (!row) return [];
          const relation = !row.manager_agent_id
            ? { kind: "independent" as const }
            : row.manager_id && row.manager_title
              ? {
                  kind: "managed" as const,
                  manager: { id: row.manager_id, title: row.manager_title },
                }
              : { kind: "orphaned" as const, managerAgentId: row.manager_agent_id };
          return [{
            id: row.id,
            projectId: row.project_id,
            title: row.title,
            activeEngine: row.active_engine,
            updatedAt: row.updated_at,
            relation,
            directReportCount: row.direct_report_count,
            ...(healthSubset(healthById.get(row.id))
              ? { health: healthSubset(healthById.get(row.id)) }
              : {}),
          }];
        });
        if (status) items = items.filter(item =>
          "health" in item && item.health?.status === status
        );
      }

      const page: AgentOrganizationPageDto = {
        scope,
        items,
        total: idPage.total,
        limit: idPage.limit,
        ...(idPage.cursor ? { nextCursor: signOrganizationCursor(idPage.cursor) } : {}),
        collectionGeneration,
        specialGroupCounts: {
          independent: specialGroupCounts.independent ?? 0,
          orphaned: specialGroupCounts.orphaned ?? 0,
          deleted: specialGroupCounts.deleted ?? 0,
        },
      };
      return page;
    } catch (error) {
      return sendCollectionPageError(reply, error);
    }
  });
}
