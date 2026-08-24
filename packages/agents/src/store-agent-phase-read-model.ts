import type Database from "better-sqlite3";
import type { AgentPhaseDto } from "@ponderosa/core";

type ExecutionPhase = Extract<
  AgentPhaseDto,
  { kind: "running_command" | "using_tool" }
>;

interface OpenCallRow {
  event_type: "command" | "tool_call";
  call_id: string;
  created_at: string;
  seq: number;
}

/** Exact open command/tool spans projected from the append-only event log. */
export class AgentPhaseReadModel {
  constructor(private readonly client: Database.Database) {}

  activeExecutionPhase(
    agentId: string,
    executionId: string,
  ): ExecutionPhase | undefined {
    if (!agentId || !executionId) return undefined;
    const newestOpenCommand = this.client.prepare(`
      SELECT start.event_type,
        json_extract(start.event_json, '$.callId') AS call_id,
        start.created_at, start.seq
      FROM activity_projection start
      WHERE start.agent_id = ?
        AND start.execution_id = ?
        AND start.event_type = 'command'
        AND json_type(start.event_json, '$.callId') = 'text'
        AND length(json_extract(start.event_json, '$.callId')) > 0
        AND NOT EXISTS (
          SELECT 1
          FROM activity_projection result
          WHERE result.agent_id = ?
            AND result.execution_id = ?
            AND result.event_type = 'tool_result'
            AND result.seq > start.seq
            AND json_type(result.event_json, '$.id') = 'text'
            AND json_extract(result.event_json, '$.id') =
              json_extract(start.event_json, '$.callId')
        )
      ORDER BY start.seq DESC
      LIMIT 1
    `).get(agentId, executionId, agentId, executionId) as OpenCallRow | undefined;
    const newestOpenTool = this.client.prepare(`
      SELECT start.event_type,
        json_extract(start.event_json, '$.id') AS call_id,
        start.created_at, start.seq
      FROM activity_projection start
      WHERE start.agent_id = ?
        AND start.execution_id = ?
        AND start.event_type = 'tool_call'
        AND json_type(start.event_json, '$.id') = 'text'
        AND length(json_extract(start.event_json, '$.id')) > 0
        AND NOT EXISTS (
          SELECT 1
          FROM activity_projection result
          WHERE result.agent_id = ?
            AND result.execution_id = ?
            AND result.event_type = 'tool_result'
            AND result.seq > start.seq
            AND json_type(result.event_json, '$.id') = 'text'
            AND json_extract(result.event_json, '$.id') =
              json_extract(start.event_json, '$.id')
        )
      ORDER BY start.seq DESC
      LIMIT 1
    `).get(agentId, executionId, agentId, executionId) as OpenCallRow | undefined;
    const row = [newestOpenCommand, newestOpenTool]
      .filter((candidate): candidate is OpenCallRow => Boolean(candidate))
      .sort((left, right) => right.seq - left.seq
        || left.event_type.localeCompare(right.event_type))[0];
    if (!row?.call_id) return undefined;
    return {
      kind: row.event_type === "command" ? "running_command" : "using_tool",
      observedAt: row.created_at,
      executionId,
      callId: row.call_id,
    };
  }
}
