import type Database from "better-sqlite3";

/** Exact durable task-accounting holds; no age-based inference or new work. */
export function heldTaskDecisionRepairs(db:Database.Database,projectId:string,requested:readonly {activationId:string;communicationEventId?:string}[]):Set<string> {
 if(!requested.length)return new Set();
 const rows=db.prepare(`SELECT DISTINCT original.id
  FROM json_each(@requested) requested
  JOIN agent_activations original ON original.id=json_extract(requested.value,'$.activationId')
  LEFT JOIN activation_delivery_retry_lineage retry ON retry.successor_activation_id=original.id
  JOIN agent_activations root ON root.id=COALESCE(retry.root_activation_id,original.id)
    AND root.project_id=original.project_id AND root.agent_id=original.agent_id AND root.scope_key=original.scope_key
  JOIN activation_sources marker ON marker.activation_id=root.id AND marker.source_kind='task_decision_repair'
  JOIN required_reply_obligations obligation ON obligation.run_id=marker.source_id AND obligation.source_activation_id=root.id
  JOIN scheduler_runs owner ON owner.id=obligation.run_id
  WHERE original.project_id=@projectId AND obligation.project_id=root.project_id
    AND obligation.agent_id=root.agent_id AND obligation.scope_key=root.scope_key
    AND owner.project_id=obligation.project_id AND owner.agent_id=obligation.agent_id AND owner.scope_key=obligation.scope_key
    AND owner.status IN ('completed','failed','outcome_unknown') AND root.kind='human_message'
    AND json_extract(root.payload_json,'$.communication.sender.kind')='user'
    AND (json_extract(requested.value,'$.communicationEventId') IS NULL
      OR json_extract(root.payload_json,'$.communication.eventId')=json_extract(requested.value,'$.communicationEventId'))
    AND (obligation.state IN ('pending','recovery_pending') OR (obligation.state='satisfied' AND obligation.delivery_phase='initial'))
    AND NOT EXISTS (SELECT 1 FROM required_reply_obligations newer JOIN scheduler_runs newer_run ON newer_run.id=newer.run_id
      WHERE newer.source_activation_id=obligation.source_activation_id AND newer.project_id=obligation.project_id
        AND newer.agent_id=obligation.agent_id AND newer.scope_key=obligation.scope_key AND newer_run.rowid>owner.rowid)
 `).all({projectId,requested:JSON.stringify(requested)}) as Array<{id:string}>;
 return new Set(rows.map(row=>row.id));
}

/** A single rollover can own several human task roots. Any one held root
 * prevents retrying that shared continuation through a different receipt. */
export function heldTaskDecisionRepairRuns(db:Database.Database,projectId:string,runIds:readonly string[]):Set<string> {
 if(!runIds.length)return new Set();
 const rows=db.prepare(`SELECT DISTINCT owner.id
  FROM json_each(@runs) requested JOIN scheduler_runs owner ON owner.id=requested.value
  JOIN required_reply_obligations obligation ON obligation.run_id=owner.id
  JOIN agent_activations root ON root.id=obligation.source_activation_id
  JOIN activation_sources marker ON marker.activation_id=root.id AND marker.source_kind='task_decision_repair' AND marker.source_id=owner.id
  WHERE owner.project_id=@projectId AND obligation.project_id=owner.project_id AND obligation.agent_id=owner.agent_id AND obligation.scope_key=owner.scope_key
    AND root.project_id=owner.project_id AND root.agent_id=owner.agent_id AND root.scope_key=owner.scope_key
    AND owner.status IN ('completed','failed','outcome_unknown') AND root.kind='human_message'
    AND json_extract(root.payload_json,'$.communication.sender.kind')='user'
    AND (obligation.state IN ('pending','recovery_pending') OR (obligation.state='satisfied' AND obligation.delivery_phase='initial'))
    AND NOT EXISTS (SELECT 1 FROM required_reply_obligations newer JOIN scheduler_runs newer_run ON newer_run.id=newer.run_id
      WHERE newer.source_activation_id=obligation.source_activation_id AND newer.project_id=obligation.project_id
        AND newer.agent_id=obligation.agent_id AND newer.scope_key=obligation.scope_key AND newer_run.rowid>owner.rowid)
 `).all({projectId,runs:JSON.stringify(runIds)}) as Array<{id:string}>;
 return new Set(rows.map(row=>row.id));
}
