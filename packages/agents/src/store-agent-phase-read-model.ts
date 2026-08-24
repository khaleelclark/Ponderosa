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
}

/** Exact open command/tool spans projected from the append-only event log. */
export class AgentPhaseReadModel {
  constructor(private readonly client: Database.Database) {}

  activeExecutionPhase(
    agentId: string,
    executionId: string,
  ): ExecutionPhase | undefined {
    if (!agentId || !executionId) return undefined;
    const row = this.client.prepare(`
      SELECT start.event_type,
        CASE start.event_type
          WHEN 'command' THEN json_extract(start.event_json, '$.callId')
          ELSE json_extract(start.event_json, '$.id')
        END AS call_id,
        start.created_at
      FROM activity_projection start
      WHERE start.agent_id = ?
        AND start.execution_id = ?
        AND start.event_type IN ('command', 'tool_call')
        AND CASE start.event_type
          WHEN 'command' THEN json_type(start.event_json, '$.callId') = 'text'
            AND length(json_extract(start.event_json, '$.callId')) > 0
          ELSE json_type(start.event_json, '$.id') = 'text'
            AND length(json_extract(start.event_json, '$.id')) > 0
        END
        AND NOT EXISTS (
          SELECT 1
          FROM activity_projection result
          WHERE result.agent_id = start.agent_id
            AND result.execution_id = start.execution_id
            AND result.event_type = 'tool_result'
            AND result.seq > start.seq
            AND json_type(result.event_json, '$.id') = 'text'
            AND json_extract(result.event_json, '$.id') = CASE start.event_type
              WHEN 'command' THEN json_extract(start.event_json, '$.callId')
              ELSE json_extract(start.event_json, '$.id')
            END
        )
      ORDER BY start.seq DESC
      LIMIT 1
    `).get(agentId, executionId) as OpenCallRow | undefined;
    if (!row?.call_id) return undefined;
    return {
      kind: row.event_type === "command" ? "running_command" : "using_tool",
      observedAt: row.created_at,
      executionId,
      callId: row.call_id,
    };
  }
}
