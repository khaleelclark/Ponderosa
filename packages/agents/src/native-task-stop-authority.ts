import type Database from "better-sqlite3";
import type { NativeTaskStopRequest, NativeTaskStopReceipt, NativeTaskStopOutcome } from "@ponderosa/core";

/** One durable attempt per exact native task identity, even across distinct HTTP keys. */
export class NativeTaskStopAuthority {
  constructor(private readonly sqlite: Database.Database) {}

  recorded(agentId: string, input: NativeTaskStopRequest): NativeTaskStopReceipt | undefined {
    const row = this.sqlite.prepare(`SELECT run_id, source_fence, session_id, task_key, outcome
      FROM native_task_stops WHERE agent_id=? AND command_key=?`).get(agentId, input.idempotencyKey) as {
        run_id: string; source_fence: number; session_id: string; task_key: string; outcome: NativeTaskStopOutcome;
      } | undefined;
    if (!row) return undefined;
    if (row.run_id !== input.runId || row.source_fence !== input.sourceFence || row.session_id !== input.sessionId || row.task_key !== input.taskKey)
      throw new Error("Native stop command key already binds a different target");
    return { ...input, outcome: row.outcome, processDrainObserved: false };
  }

  reserve(agentId: string, input: NativeTaskStopRequest): void {
    // Unknown is committed BEFORE native input. A crash never authorizes replay.
    this.sqlite.prepare(`INSERT INTO native_task_stops
      (agent_id,command_key,run_id,source_fence,session_id,task_key,outcome,created_at) VALUES (?,?,?,?,?,?,'unknown',?)`)
      .run(agentId, input.idempotencyKey, input.runId, input.sourceFence, input.sessionId, input.taskKey, new Date().toISOString());
  }

  finish(agentId: string, input: NativeTaskStopRequest, outcome: NativeTaskStopOutcome): NativeTaskStopReceipt {
    const result = this.sqlite.prepare(`UPDATE native_task_stops SET outcome=?, completed_at=? WHERE agent_id=? AND command_key=?
      AND run_id=? AND source_fence=? AND session_id=? AND task_key=?`).run(outcome,new Date().toISOString(),agentId,input.idempotencyKey,
      input.runId,input.sourceFence,input.sessionId,input.taskKey);
    if (result.changes !== 1) throw new Error("Native stop receipt boundary changed");
    return this.recorded(agentId,input)!;
  }
}
