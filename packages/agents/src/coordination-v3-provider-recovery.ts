import type Database from "better-sqlite3";

/** Count attempts, not callbacks or recovery generations. Exact reply lineage
 * survives normal retries, coalescing and Decision/context transfers. */
export function providerRecoveryAttempts(sqlite: Database.Database, runId: string, activationId: string): number {
  const root = sqlite.prepare(`SELECT project_id, agent_id, scope_key, reply_authority_json
    FROM required_reply_obligations WHERE run_id=? AND source_activation_id=?`)
    .get(runId, activationId) as { project_id: string; agent_id: string; scope_key: string; reply_authority_json: string } | undefined;
  if (!root) return 0;
  return (sqlite.prepare(`WITH RECURSIVE lineage(id) AS (
      SELECT @activationId
      UNION
      SELECT parent.source_activation_id FROM required_reply_obligations parent
        JOIN lineage ON parent.recovery_activation_id=lineage.id
      WHERE parent.project_id=@project_id AND parent.agent_id=@agent_id
        AND parent.scope_key=@scope_key AND parent.reply_authority_json=@reply_authority_json
    )
    SELECT COUNT(DISTINCT run.id) AS attempts
    FROM required_reply_obligations obligation JOIN scheduler_runs run ON run.id=obligation.run_id
    WHERE obligation.source_activation_id IN (SELECT id FROM lineage)
      AND obligation.project_id=@project_id AND obligation.agent_id=@agent_id
      AND obligation.scope_key=@scope_key AND obligation.reply_authority_json=@reply_authority_json
      AND run.project_id=@project_id AND run.agent_id=@agent_id AND run.scope_key=@scope_key
      AND (run.id=@runId OR run.status IN ('failed','outcome_unknown') OR
        (run.status='completed' AND EXISTS (SELECT 1 FROM agent_activations recovery
          WHERE recovery.id=obligation.recovery_activation_id AND recovery.kind='required_reply_recovery'
            AND recovery.state<>'cancelled' AND recovery.project_id=@project_id
            AND recovery.agent_id=@agent_id AND recovery.scope_key=@scope_key)))`)
    .get({ ...root, runId, activationId }) as { attempts: number }).attempts;
}
