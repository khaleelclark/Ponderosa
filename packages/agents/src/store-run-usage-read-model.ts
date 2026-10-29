import {activeAgentProductSql,type ProductScope} from './product-scope-sql.js';
import type Database from "better-sqlite3";
import { asc, eq } from "drizzle-orm";
import type {
  AgentLifecycleReason,
  AgentRunDto,
  AgentRunStatus,
  HistoryPageDto,
  ProviderInputDto,
  ProviderInputSourceManifest,
  TokenUsage,
  TokenUsageBreakdownDto,
  TokenUsageMetric,
  TokenUsageRangeDto,
  TokenUsageSummaryDto,
  WorkItemDto,
  WorkItemStatus,
} from "@ponderosa/core";
import type { Db } from "./db.js";
import { runs, workItems } from "./schema.js";

type HistoryCursor = { orderKey: string; rowKey: string };
type EncodeHistoryCursor = (input: {
  stream: string;
  scope: string;
  orderKey: string;
  rowKey: string;
}) => string;
type DecodeHistoryCursor = (
  cursor: string,
  stream: string,
  scope: string,
) => HistoryCursor;
type UsageScope = ({ type: "overall" } | { type: "project" | "agent" | "conversation" | "branch"; id: string }) & {productScope?:ProductScope};

export class AgentRunUsageReadModel {
  constructor(
    private readonly db: Db,
    private readonly client: Database.Database,
    private readonly encodeHistoryCursor: EncodeHistoryCursor,
    private readonly decodeHistoryCursor: DecodeHistoryCursor,
    private readonly communicationConversationId: (
      projectId: string,
      eventId: string,
    ) => string | undefined,
  ) {}

  private runActivityCounts(
    agentId: string,
    executionIds?: readonly string[],
  ): Map<string, NonNullable<AgentRunDto["activityCounts"]>> {
    if (executionIds?.length === 0) return new Map();
    const rows = this.client
      .prepare(`
        SELECT execution_id, event_type,
          CASE
            WHEN event_type = 'file_change'
            THEN COUNT(DISTINCT json_extract(event_json, '$.path'))
            ELSE COUNT(*)
          END AS n
        FROM activity_projection
        WHERE agent_id = ? AND execution_id IS NOT NULL
          ${executionIds ? `AND execution_id IN (${executionIds.map(() => "?").join(",")})` : ""}
          AND event_type IN ('command', 'tool_call', 'file_change', 'error')
        GROUP BY execution_id, event_type
      `)
      .all(agentId, ...(executionIds ?? [])) as Array<{
      execution_id: string;
      event_type: string;
      n: number;
    }>;
    const counts = new Map<
      string,
      NonNullable<AgentRunDto["activityCounts"]>
    >();
    for (const row of rows) {
      const current = counts.get(row.execution_id) ?? {
        commands: 0,
        tools: 0,
        files: 0,
        errors: 0,
      };
      if (row.event_type === "command") current.commands = row.n;
      else if (row.event_type === "tool_call") current.tools = row.n;
      else if (row.event_type === "file_change") current.files = row.n;
      else if (row.event_type === "error") current.errors = row.n;
      counts.set(row.execution_id, current);
    }
    return counts;
  }

  /** Chat file activity needs only the status of executions on this page. */
  getActiveExecutionIds(agentId: string, executionIds: ReadonlySet<string>): ReadonlySet<string> {
    const ids = [...executionIds];
    const active = new Set<string>();
    for (let offset = 0; offset < ids.length; offset += 400) {
      const page = ids.slice(offset, offset + 400);
      const rows = this.client.prepare(`
        SELECT id FROM runs WHERE agent_id = ?
          AND status IN ('running', 'compacting')
          AND id IN (${page.map(() => "?").join(",")})
      `).all(agentId, ...page) as Array<{ id: string }>;
      for (const row of rows) active.add(row.id);
    }
    return active;
  }

  /** Read one exact source or the latest projected Run, never its full history. */
  getLatestRun(agentId: string, exactRunId?: string): Pick<AgentRunDto,
    "id" | "status" | "engine" | "model" | "effort" | "communicationEventId"
  > | undefined {
    const row = this.client.prepare(`
      SELECT id, status, engine, model, effort, communication_event_id AS communicationEventId
      FROM runs WHERE agent_id = ? ${exactRunId ? "AND id = ?" : ""}
      ORDER BY started_at DESC, id DESC LIMIT 1
    `).get(...(exactRunId ? [agentId, exactRunId] : [agentId])) as (Pick<AgentRunDto, "id" | "status" | "engine"> & {
      model: string | null; effort: string | null; communicationEventId: string | null;
    }) | undefined;
    return row ? {
      ...row,
      model: row.model ?? undefined,
      effort: row.effort ?? undefined,
      communicationEventId: row.communicationEventId ?? undefined,
    } : undefined;
  }

  /** Audit status for one exact Agent/Run pair, including retained history. */
  getRunStatus(agentId: string, runId: string): AgentRunDto["status"] | undefined {
    return (this.client.prepare("SELECT status FROM runs WHERE agent_id = ? AND id = ?")
      .get(agentId, runId) as Pick<AgentRunDto, "status"> | undefined)?.status;
  }

  /** Health consumes only the latest outcome and latest assigned-work outcome.
   * Updated time owns outcome order; start time and ID retain deterministic
   * ordering for equal-time outcomes without hydrating unrelated audit data. */
  getRunHealthSummaries(agentId: string): Array<Pick<AgentRunDto,
    "id" | "status" | "reason" | "wakeCause" | "updatedAt"
  >> {
    const rows = this.client.prepare(`
      SELECT id, status, reason, wake_cause AS wakeCause, updated_at AS updatedAt
      FROM runs WHERE agent_id = ? AND id IN (
        (SELECT id FROM runs WHERE agent_id = ?
          ORDER BY updated_at DESC, started_at DESC, id DESC LIMIT 1),
        (SELECT id FROM runs WHERE agent_id = ?
          AND (wake_cause IS NULL OR wake_cause NOT IN ('coordination', 'collaboration'))
          ORDER BY updated_at DESC, started_at DESC, id DESC LIMIT 1)
      )
      ORDER BY started_at ASC, id ASC
    `).all(agentId, agentId, agentId) as Array<Pick<AgentRunDto,
      "id" | "status" | "reason" | "updatedAt"
    > & { wakeCause: AgentRunDto["wakeCause"] | null }>;
    return rows.map(row => ({ ...row, wakeCause: row.wakeCause ?? undefined }));
  }

  getRuns(agentId: string): AgentRunDto[] {
    const activityCounts = this.runActivityCounts(agentId);
    return this.db
      .select()
      .from(runs)
      .where(eq(runs.agentId, agentId))
      .orderBy(asc(runs.startedAt))
      .all()
      .map(r => {
        const providerInput = this.client
          .prepare(`
            SELECT prompt_hash, source_manifest_json
            FROM provider_inputs WHERE execution_id = ? AND agent_id = ?
          `)
          .get(r.id, agentId) as
          | { prompt_hash: string; source_manifest_json: string }
          | undefined;
        const sourceManifest = providerInput
          ? JSON.parse(providerInput.source_manifest_json) as ProviderInputSourceManifest
          : undefined;
        return {
          id: r.id,
          agentId: r.agentId,
          title: r.title,
          status: r.status as AgentRunStatus,
          reason: r.reason as AgentLifecycleReason,
          engine: r.engine,
          model: r.model ?? undefined,
          effort: r.effort ?? undefined,
          communicationEventId: r.communicationEventId ?? undefined,
          wakeCause: (r.wakeCause as AgentRunDto["wakeCause"]) ?? undefined,
          ...([
            r.inputTokens,
            r.cachedInputTokens,
            r.cacheWriteInputTokens,
            r.outputTokens,
            r.reasoningOutputTokens,
            r.totalTokens,
          ].some(value => value !== null)
            ? {
                usage: {
                  ...(r.inputTokens !== null
                    ? { inputTokens: r.inputTokens }
                    : {}),
                  ...(r.cachedInputTokens !== null
                    ? { cachedInputTokens: r.cachedInputTokens }
                    : {}),
                  ...(r.cacheWriteInputTokens !== null
                    ? { cacheWriteInputTokens: r.cacheWriteInputTokens }
                    : {}),
                  ...(r.outputTokens !== null
                    ? { outputTokens: r.outputTokens }
                    : {}),
                  ...(r.reasoningOutputTokens !== null
                    ? { reasoningOutputTokens: r.reasoningOutputTokens }
                    : {}),
                  ...(r.totalTokens !== null
                    ? { totalTokens: r.totalTokens }
                    : {}),
                },
              }
            : {}),
          startedAt: r.startedAt,
          updatedAt: r.updatedAt,
          completedAt: r.completedAt ?? undefined,
          ...(activityCounts.get(r.id)
            ? { activityCounts: activityCounts.get(r.id) }
            : {}),
          ...(providerInput
            ? {
                providerInput: {
                  promptHash: providerInput.prompt_hash,
                  sourceCommunicationCount: sourceManifest!.communicationEventIds.length,
                  sourceManifest: sourceManifest!,
                  exactPromptAvailable: true as const,
                },
              }
            : {}),
        };
      });
  }

  getRunPage(
    agentId: string,
    input: {
      limit: number;
      cursor?: string;
      focusId?: string;
      includeProviderInputManifest?: boolean;
    },
  ): HistoryPageDto<AgentRunDto> {
    const limit = Math.max(1, Math.min(input.limit, 500));
    if (input.cursor && input.focusId) {
      throw new Error("history cursor and focus cannot be combined");
    }
    const focusId = input.focusId;
    const focusBoundary = focusId
      ? (this.client
          .prepare(`
            SELECT started_at AS orderKey, id AS rowKey
            FROM runs WHERE agent_id = ? AND id = ?
          `)
          .get(agentId, focusId) as
          | { orderKey: string; rowKey: string }
          | undefined)
      : undefined;
    if (focusId && !focusBoundary) {
      return { items: [], history: { limit, hasMore: false } };
    }
    const boundary =
      focusBoundary ??
      (input.cursor
        ? this.decodeHistoryCursor(input.cursor, "agent:runs", agentId)
        : undefined);
    const rows = this.client
      .prepare(`
        SELECT id, agent_id, title, status, reason, engine, model, effort,
          communication_event_id, wake_cause, input_tokens, cached_input_tokens,
          cache_write_input_tokens, output_tokens, reasoning_output_tokens,
          total_tokens, started_at, updated_at, completed_at
        FROM runs
        WHERE agent_id = ?
          ${boundary ? `AND (started_at < ? OR (started_at = ? AND id ${focusBoundary ? "<=" : "<"} ?))` : ""}
        ORDER BY started_at DESC, id DESC LIMIT ?
      `)
      .all(
        ...(boundary
          ? [
              agentId,
              boundary.orderKey,
              boundary.orderKey,
              boundary.rowKey,
              limit + 1,
            ]
          : [agentId, limit + 1]),
      ) as Array<{
      id: string;
      agent_id: string;
      title: string;
      status: string;
      reason: string;
      engine: AgentRunDto["engine"];
      model: string | null;
      effort: string | null;
      communication_event_id: string | null;
      wake_cause: string | null;
      input_tokens: number | null;
      cached_input_tokens: number | null;
      cache_write_input_tokens: number | null;
      output_tokens: number | null;
      reasoning_output_tokens: number | null;
      total_tokens: number | null;
      started_at: string;
      updated_at: string;
      completed_at: string | null;
    }>;
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const activityCounts = this.runActivityCounts(agentId, selected.map(row => row.id));
    const items = selected
      .map((row): AgentRunDto => {
        const providerInput = this.client
          .prepare(`
            SELECT prompt_hash, source_manifest_json
            FROM provider_inputs WHERE execution_id = ? AND agent_id = ?
          `)
          .get(row.id, agentId) as
          | { prompt_hash: string; source_manifest_json: string }
          | undefined;
        const sourceManifest = providerInput
          ? JSON.parse(providerInput.source_manifest_json) as ProviderInputSourceManifest
          : undefined;
        return {
          id: row.id,
          agentId: row.agent_id,
          title: row.title,
          status: row.status as AgentRunStatus,
          reason: row.reason as AgentLifecycleReason,
          engine: row.engine,
          ...(row.model ? { model: row.model } : {}),
          ...(row.effort ? { effort: row.effort } : {}),
          ...(row.communication_event_id
            ? { communicationEventId: row.communication_event_id }
            : {}),
          ...(row.wake_cause
            ? { wakeCause: row.wake_cause as AgentRunDto["wakeCause"] }
            : {}),
          ...([
            row.input_tokens,
            row.cached_input_tokens,
            row.cache_write_input_tokens,
            row.output_tokens,
            row.reasoning_output_tokens,
            row.total_tokens,
          ].some(value => value !== null)
            ? {
                usage: {
                  ...(row.input_tokens !== null
                    ? { inputTokens: row.input_tokens }
                    : {}),
                  ...(row.cached_input_tokens !== null
                    ? { cachedInputTokens: row.cached_input_tokens }
                    : {}),
                  ...(row.cache_write_input_tokens !== null
                    ? { cacheWriteInputTokens: row.cache_write_input_tokens }
                    : {}),
                  ...(row.output_tokens !== null
                    ? { outputTokens: row.output_tokens }
                    : {}),
                  ...(row.reasoning_output_tokens !== null
                    ? { reasoningOutputTokens: row.reasoning_output_tokens }
                    : {}),
                  ...(row.total_tokens !== null
                    ? { totalTokens: row.total_tokens }
                    : {}),
                },
              }
            : {}),
          startedAt: row.started_at,
          updatedAt: row.updated_at,
          ...(row.completed_at ? { completedAt: row.completed_at } : {}),
          ...(activityCounts.get(row.id)
            ? { activityCounts: activityCounts.get(row.id) }
            : {}),
          ...(providerInput
            ? {
                providerInput: {
                  promptHash: providerInput.prompt_hash,
                  sourceCommunicationCount: sourceManifest!.communicationEventIds.length,
                  ...(input.includeProviderInputManifest === false
                    ? {}
                    : { sourceManifest: sourceManifest! }),
                  exactPromptAvailable: true as const,
                },
              }
            : {}),
        };
      })
      .reverse();
    const oldest = selected.at(-1);
    return {
      items,
      history: {
        limit,
        hasMore,
        ...(hasMore && oldest
          ? {
              cursor: this.encodeHistoryCursor({
                stream: "agent:runs",
                scope: agentId,
                orderKey: oldest.started_at,
                rowKey: oldest.id,
              }),
            }
          : {}),
      },
    };
  }

  getProviderInput(
    executionId: string,
    includeExactPrompt = false,
  ): ProviderInputDto | undefined {
    const row = this.client
      .prepare(`
        SELECT execution_id, scheduler_run_id, provider_prompt, prompt_hash,
          provider_system_prompt, system_prompt_hash,
          source_manifest_json, created_at, updated_at
        FROM provider_inputs WHERE execution_id = ?
      `)
      .get(executionId) as
      | {
          execution_id: string;
          scheduler_run_id: string;
          provider_prompt: string;
          prompt_hash: string;
          provider_system_prompt: string;
          system_prompt_hash: string;
          source_manifest_json: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      executionId: row.execution_id,
      schedulerRunId: row.scheduler_run_id,
      promptHash: row.prompt_hash,
      ...(row.system_prompt_hash ? { systemPromptHash: row.system_prompt_hash } : {}),
      sourceManifest: JSON.parse(
        row.source_manifest_json,
      ) as ProviderInputSourceManifest,
      ...(includeExactPrompt ? { exactPrompt: row.provider_prompt } : {}),
      ...(includeExactPrompt && row.provider_system_prompt
        ? { exactSystemPrompt: row.provider_system_prompt }
        : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getTokenUsage(
    scope: UsageScope,
    range: TokenUsageRangeDto = {},
  ): TokenUsageSummaryDto {
    const rows = this.getUsageRows(scope, range);
    const finalizedRuns = rows.length;
    const reportedRuns = rows.filter(
      row => row.totalTokens !== undefined,
    ).length;
    const providerRequests = rows.reduce((total, row) => {
      if (!row.providerRequestUsageJson) return total;
      try {
        const parsed = JSON.parse(row.providerRequestUsageJson) as unknown;
        return total + (Array.isArray(parsed) ? parsed.length : 0);
      } catch {
        return total;
      }
    }, 0);
    const durationMs = rows.reduce((total, row) => {
      if (!row.completedAt) return total;
      return (
        total +
        Math.max(
          0,
          new Date(row.completedAt).getTime() -
            new Date(row.startedAt).getTime(),
        )
      );
    }, 0);
    const keys: TokenUsageMetric[] = [
      "inputTokens",
      "cachedInputTokens",
      "cacheWriteInputTokens",
      "outputTokens",
      "reasoningOutputTokens",
      "totalTokens",
    ];
    const totals: TokenUsage = {};
    const metricAvailability = Object.fromEntries(
      keys.map(key => [
        key,
        rows.some(row => row.usage[key] !== undefined)
          ? "available"
          : "unavailable",
      ]),
    ) as Record<TokenUsageMetric, "available" | "unavailable">;
    for (const row of rows) {
      for (const key of keys) {
        const value = row.usage[key];
        if (value !== undefined) totals[key] = (totals[key] ?? 0) + value;
      }
    }
    const grouped = new Map<string, TokenUsageBreakdownDto>();
    const wakeCauses = this.exactWakeCauses(rows.map(row => row.executionId));
    for (const row of rows.filter(item => item.totalTokens !== undefined)) {
      const key = [
        row.projectId,
        row.conversationId ?? "",
        row.agentId,
        row.engine,
        row.model ?? "",
      ].join("\0");
      const current = grouped.get(key) ?? {
        projectId: row.projectId,
        ...(row.conversationId
          ? { conversationId: row.conversationId }
          : {}),
        agentId: row.agentId,
        agentTitle: row.agentTitle,
        engine: row.engine as TokenUsageBreakdownDto["engine"],
        ...(row.model ? { model: row.model } : {}),
        runs: 0,
        usage: {},
      };
      current.runs += 1;
      for (const keyName of keys) {
        const value = row.usage[keyName];
        if (value !== undefined) {
          current.usage[keyName] =
            (current.usage[keyName] ?? 0) + value;
        }
      }
      grouped.set(key, current);
    }
    return {
      scope: scope.type,
      ...(scope.type !== "overall" ? { scopeId: scope.id } : {}),
      ...totals,
      finalizedRuns,
      reportedRuns,
      unreportedRuns: finalizedRuns - reportedRuns,
      providerRequests,
      durationMs,
      coverage: finalizedRuns ? reportedRuns / finalizedRuns : null,
      ...(range.from || range.to ? { range } : {}),
      metricAvailability,
      breakdown: [...grouped.values()].sort(
        (a, b) =>
          b.runs - a.runs || a.agentTitle.localeCompare(b.agentTitle),
      ),
      wakeCauses,
      recentTurns: rows
        .filter(row => row.totalTokens !== undefined)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 10)
        .map(row => ({
          projectId: row.projectId,
          ...(row.conversationId
            ? { conversationId: row.conversationId }
            : {}),
          agentId: row.agentId,
          agentTitle: row.agentTitle,
          executionId: row.executionId,
          engine: row.engine as TokenUsageBreakdownDto["engine"],
          ...(row.model ? { model: row.model } : {}),
          startedAt: row.startedAt,
          ...(row.completedAt ? { completedAt: row.completedAt } : {}),
          usage: row.usage,
        })),
    };
  }

  getMeteredRuns(scope: UsageScope, range: TokenUsageRangeDto = {}) {
    return this.getUsageRows(scope, range)
      .filter(row => row.totalTokens !== undefined)
      .map(row => {
        let providerRequestUsage: TokenUsage[] | undefined;
        if (row.providerRequestUsageJson) {
          try {
            const parsed = JSON.parse(
              row.providerRequestUsageJson,
            ) as unknown;
            if (Array.isArray(parsed)) {
              providerRequestUsage = parsed as TokenUsage[];
            }
          } catch {
            // A malformed rebuildable projection must not make the usage API fail.
          }
        }
        return {
          projectId: row.projectId,
          ...(row.conversationId
            ? { conversationId: row.conversationId }
            : {}),
          agentId: row.agentId,
          agentTitle: row.agentTitle,
          executionId: row.executionId,
          engine: row.engine,
          model: row.model ?? undefined,
          startedAt: row.startedAt,
          ...(row.completedAt ? { completedAt: row.completedAt } : {}),
          usage: row.usage,
          ...(providerRequestUsage ? { providerRequestUsage } : {}),
        };
      });
  }

  private getUsageRows(
    scope: UsageScope,
    range: TokenUsageRangeDto,
  ): Array<{
    projectId: string;
    conversationId: string | null;
    agentId: string;
    agentTitle: string;
    executionId: string;
    engine: string;
    model: string | undefined;
    startedAt: string;
    completedAt: string | undefined;
    totalTokens: number | undefined;
    usage: TokenUsage;
    providerRequestUsageJson: string | null;
  }> {
    const predicates = [
      "runs.status IN ('cancelled', 'completed', 'failed', 'interrupted')",
    ];
    const params: string[] = [];
    if(scope.productScope)predicates.push(activeAgentProductSql('agents',scope.productScope));
    if(scope.type==='branch'){
      predicates.push("EXISTS(SELECT 1 FROM conversations owner WHERE owner.id=agents.conversation_id AND owner.branch_id=?)");
      params.push(scope.id);
    }
    if (scope.type === "project") {
      predicates.push("agents.project_id = ?");
      params.push(scope.id);
    }
    if (scope.type === "agent") {
      predicates.push("runs.agent_id = ?");
      params.push(scope.id);
    }
    if (scope.type === "conversation") {
      predicates.push("agents.project_id = (SELECT project_id FROM conversations WHERE id = ?)");
      params.push(scope.id);
    }
    if (range.from) {
      predicates.push(
        "COALESCE(runs.completed_at, runs.started_at) >= ?",
      );
      params.push(range.from);
    }
    if (range.to) {
      predicates.push("COALESCE(runs.completed_at, runs.started_at) < ?");
      params.push(range.to);
    }
    const rows = this.client
      .prepare(`
        SELECT runs.id AS execution_id, runs.agent_id, agents.project_id,
          agents.conversation_id, agents.title AS agent_title,
          runs.communication_event_id, runs.engine, runs.model, runs.started_at,
          runs.completed_at, runs.input_tokens, runs.cached_input_tokens,
          runs.cache_write_input_tokens, runs.output_tokens,
          runs.reasoning_output_tokens, runs.total_tokens,
          runs.provider_request_usage_json
        FROM runs JOIN agents ON agents.id = runs.agent_id
        WHERE ${predicates.join(" AND ")}
      `)
      .all(...params) as Array<{
      execution_id: string;
      agent_id: string;
      project_id: string;
      conversation_id: string | null;
      agent_title: string;
      communication_event_id: string | null;
      engine: string;
      model: string | null;
      started_at: string;
      completed_at: string | null;
      input_tokens: number | null;
      cached_input_tokens: number | null;
      cache_write_input_tokens: number | null;
      output_tokens: number | null;
      reasoning_output_tokens: number | null;
      total_tokens: number | null;
      provider_request_usage_json: string | null;
    }>;
    return rows.map(row => ({
      projectId: row.project_id,
      // Prefer the immutable communication's room over mutable current
      // membership so historical usage remains scoped to its original chat.
      conversationId: row.communication_event_id
        ? (this.communicationConversationId(
            row.project_id,
            row.communication_event_id,
          ) ?? row.conversation_id)
        : row.conversation_id,
      agentId: row.agent_id,
      agentTitle: row.agent_title,
      executionId: row.execution_id,
      engine: row.engine,
      model: row.model ?? undefined,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      totalTokens: row.total_tokens ?? undefined,
      usage: {
        ...(row.input_tokens !== null
          ? { inputTokens: row.input_tokens }
          : {}),
        ...(row.cached_input_tokens !== null
          ? { cachedInputTokens: row.cached_input_tokens }
          : {}),
        ...(row.cache_write_input_tokens !== null
          ? { cacheWriteInputTokens: row.cache_write_input_tokens }
          : {}),
        ...(row.output_tokens !== null
          ? { outputTokens: row.output_tokens }
          : {}),
        ...(row.reasoning_output_tokens !== null
          ? { reasoningOutputTokens: row.reasoning_output_tokens }
          : {}),
        ...(row.total_tokens !== null
          ? { totalTokens: row.total_tokens }
          : {}),
      },
      providerRequestUsageJson: row.provider_request_usage_json,
    })).filter(row => scope.type !== "conversation" || row.conversationId === scope.id);
  }

  private exactWakeCauses(
    executionIds: string[],
  ): TokenUsageSummaryDto["wakeCauses"] {
    const uniqueIds = [...new Set(executionIds)];
    const causedRunIds = new Set<string>();
    const aggregates = new Map<
      string,
      { runs: Set<string>; activations: number }
    >();
    for (let offset = 0; offset < uniqueIds.length; offset += 400) {
      const page = uniqueIds.slice(offset, offset + 400);
      if (!page.length) continue;
      const attached = this.client
        .prepare(`
          SELECT attached.run_id, activation.kind
          FROM scheduler_run_activations attached
          JOIN agent_activations activation
            ON activation.id = attached.activation_id
          WHERE attached.run_id IN (${page.map(() => "?").join(",")})
          ORDER BY attached.run_id, activation.kind, activation.id
        `)
        .all(...page) as Array<{ run_id: string; kind: string }>;
      for (const row of attached) {
        causedRunIds.add(row.run_id);
        const aggregate = aggregates.get(row.kind) ?? {
          runs: new Set<string>(),
          activations: 0,
        };
        aggregate.runs.add(row.run_id);
        aggregate.activations += 1;
        aggregates.set(row.kind, aggregate);
      }
    }
    const otherRuns = uniqueIds.filter(id => !causedRunIds.has(id)).length;
    const result = [...aggregates.entries()].map(([cause, aggregate]) => ({
      cause,
      runs: aggregate.runs.size,
      activations: aggregate.activations,
    }));
    if (otherRuns) {
      result.push({
        cause: "other",
        runs: otherRuns,
        activations: otherRuns,
      });
    }
    return result.sort(
      (left, right) =>
        right.runs - left.runs ||
        right.activations - left.activations ||
        left.cause.localeCompare(right.cause),
    );
  }

  getWorkItems(agentId: string): WorkItemDto[] {
    return this.db
      .select()
      .from(workItems)
      .where(eq(workItems.agentId, agentId))
      .orderBy(asc(workItems.createdAt))
      .all()
      .map(r => ({
        id: r.id,
        agentId: r.agentId,
        executionId: r.executionId ?? undefined,
        title: r.title,
        status: r.status as WorkItemStatus,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
  }

  getWorkItemPage(
    agentId: string,
    input: { limit: number; cursor?: string; focusId?: string },
  ): HistoryPageDto<WorkItemDto> {
    const limit = Math.max(1, Math.min(input.limit, 500));
    if (input.cursor && input.focusId) {
      throw new Error("history cursor and focus cannot be combined");
    }
    const focusId = input.focusId;
    const focusBoundary = focusId
      ? (this.client
          .prepare(`
            SELECT created_at AS orderKey, id AS rowKey
            FROM work_items WHERE agent_id = ? AND id = ?
          `)
          .get(agentId, focusId) as
          | { orderKey: string; rowKey: string }
          | undefined)
      : undefined;
    if (focusId && !focusBoundary) {
      return { items: [], history: { limit, hasMore: false } };
    }
    const boundary =
      focusBoundary ??
      (input.cursor
        ? this.decodeHistoryCursor(input.cursor, "agent:workItems", agentId)
        : undefined);
    const rows = this.client
      .prepare(`
        SELECT id, agent_id, execution_id, title, status, created_at, updated_at
        FROM work_items
        WHERE agent_id = ?
          ${boundary ? `AND (created_at < ? OR (created_at = ? AND id ${focusBoundary ? "<=" : "<"} ?))` : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?
      `)
      .all(
        ...(boundary
          ? [
              agentId,
              boundary.orderKey,
              boundary.orderKey,
              boundary.rowKey,
              limit + 1,
            ]
          : [agentId, limit + 1]),
      ) as Array<{
      id: string;
      agent_id: string;
      execution_id: string | null;
      title: string;
      status: string;
      created_at: string;
      updated_at: string;
    }>;
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items = selected
      .map(
        (row): WorkItemDto => ({
          id: row.id,
          agentId: row.agent_id,
          ...(row.execution_id ? { executionId: row.execution_id } : {}),
          title: row.title,
          status: row.status as WorkItemStatus,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }),
      )
      .reverse();
    const oldest = selected.at(-1);
    return {
      items,
      history: {
        limit,
        hasMore,
        ...(hasMore && oldest
          ? {
              cursor: this.encodeHistoryCursor({
                stream: "agent:workItems",
                scope: agentId,
                orderKey: oldest.created_at,
                rowKey: oldest.id,
              }),
            }
          : {}),
      },
    };
  }
}
