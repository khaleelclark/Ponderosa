import type Database from "better-sqlite3";

export type HeldHumanRollover = {
  id:string;state:string;handoff_event_id:string;continuation_activation_id:string;root_activation_id:string;
  replacement_run_id:string|null;failure_signal:string|null;candidate_run_id:string;
  prompt_injection_state:string;provider_session_id:string|null;started_at:string|null;candidate_status:string;no_packet:number;no_submission:number;scope_unchanged:number;owner_proven:number;
};
export const heldHumanRolloverKey=(activationId:string,communicationEventId?:string)=>JSON.stringify([activationId,communicationEventId??null]);

/** One scoped query for a page of authored-message receipts. */
export function heldHumanRollovers(db:Database.Database, projectId:string, requested:readonly {activationId:string;communicationEventId?:string}[]):Map<string,HeldHumanRollover> {
  if (!requested.length) return new Map();
  const rows = db.prepare(`
    SELECT json_extract(request.value,'$.activationId') requested_activation_id,
      json_extract(request.value,'$.communicationEventId') requested_communication_event_id,
      rollover.id,rollover.state,rollover.handoff_event_id,rollover.continuation_activation_id,
      obligation.source_activation_id root_activation_id,
      rollover.replacement_run_id,rollover.failure_signal,candidate.id candidate_run_id,
      candidate.prompt_injection_state,candidate.provider_session_id,candidate.started_at,candidate.status candidate_status,
      EXISTS(SELECT 1 FROM agent_activations continuation
        JOIN activation_sources lineage ON lineage.activation_id=continuation.id
          AND lineage.source_kind='context_rollover' AND lineage.source_id=rollover.id
        WHERE continuation.id=rollover.continuation_activation_id AND continuation.kind='context_rollover_continuation'
          AND continuation.agent_id=rollover.agent_id AND continuation.project_id=rollover.project_id
          AND continuation.scope_key=rollover.scope_key AND continuation.state='failed'
          AND json_extract(continuation.payload_json,'$.rolloverId')=rollover.id
          AND json_extract(continuation.payload_json,'$.sourceRunId')=rollover.source_run_id)
      AND NOT EXISTS(SELECT 1 FROM scheduler_run_activations other WHERE other.run_id=candidate.id
        AND other.activation_id<>rollover.continuation_activation_id) owner_proven,
      NOT EXISTS(SELECT 1 FROM provider_inputs packet WHERE packet.scheduler_run_id=candidate.id) no_packet,
      NOT EXISTS(SELECT 1 FROM scheduler_prompt_injections injection WHERE injection.run_id=candidate.id
        AND (injection.state NOT IN ('pending','cancelled') OR injection.submitted_at IS NOT NULL OR injection.acknowledged_at IS NOT NULL OR injection.provider_turn_id IS NOT NULL)) no_submission,
      NOT EXISTS(SELECT 1 FROM scheduler_runs newer WHERE newer.agent_id=candidate.agent_id
        AND newer.project_id=candidate.project_id AND newer.rowid>candidate.rowid)
      AND NOT EXISTS(SELECT 1 FROM agent_activations newer
        JOIN agent_activations original_continuation ON original_continuation.id=rollover.continuation_activation_id
        WHERE newer.agent_id=candidate.agent_id AND newer.project_id=candidate.project_id
          AND newer.kind='human_message'
          AND newer.rowid>original_continuation.rowid)
      AND NOT EXISTS(SELECT 1 FROM activation_outbox revision
        JOIN agent_activations owner ON owner.id=revision.activation_id
        WHERE owner.agent_id=candidate.agent_id AND owner.project_id=candidate.project_id
          AND revision.event_kind='communication_revision'
          AND revision.created_at>=candidate.created_at) scope_unchanged
    FROM json_each(@requested) request
    JOIN required_reply_obligations obligation
    JOIN scheduler_runs candidate ON candidate.id=obligation.run_id
    JOIN agent_activations original ON original.id=obligation.source_activation_id
    JOIN context_rollovers rollover ON rollover.agent_id=candidate.agent_id AND rollover.project_id=candidate.project_id
      AND rollover.scope_key=candidate.scope_key
    JOIN scheduler_run_activations attached ON attached.run_id=candidate.id
      AND attached.activation_id=rollover.continuation_activation_id
    WHERE (obligation.source_activation_id=json_extract(request.value,'$.activationId')
      OR rollover.continuation_activation_id=json_extract(request.value,'$.activationId'))
      AND obligation.project_id=@projectId
      AND (json_extract(request.value,'$.communicationEventId') IS NULL
        OR json_extract(original.payload_json,'$.communication.eventId')=json_extract(request.value,'$.communicationEventId'))
      AND obligation.state='pending' AND original.kind='human_message'
      AND json_extract(original.payload_json,'$.communication.sender.kind')='user'
      AND rollover.state IN ('failed','outcome_unknown') AND rollover.replacement_verified_at IS NULL
      AND rollover.handoff_event_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM required_reply_obligations newer
        JOIN scheduler_runs newer_run ON newer_run.id=newer.run_id
        WHERE newer.source_activation_id=obligation.source_activation_id AND newer.project_id=obligation.project_id
          AND newer.agent_id=obligation.agent_id AND newer.scope_key=obligation.scope_key AND newer_run.rowid>candidate.rowid)
    ORDER BY candidate.rowid DESC`).all({projectId,requested:JSON.stringify(requested)}) as Array<HeldHumanRollover & {
      requested_activation_id:string;requested_communication_event_id:string|null;
    }>;
  const found=new Map<string,HeldHumanRollover>();
  for(const row of rows){
    const key=heldHumanRolloverKey(row.requested_activation_id,row.requested_communication_event_id??undefined);
    if(!found.has(key))found.set(key,row);
  }
  return found;
}

export function heldHumanRollover(db:Database.Database,projectId:string,activationId:string,communicationEventId?:string):HeldHumanRollover|undefined {
  return heldHumanRollovers(db,projectId,[{activationId,communicationEventId}]).get(heldHumanRolloverKey(activationId,communicationEventId));
}

export function canRetryHeldHumanRollover(held:HeldHumanRollover):boolean {
  return held.state==='failed' && held.replacement_run_id===null && held.failure_signal!=='seed_overflow'
    && held.candidate_status==='failed' && held.started_at===null && held.provider_session_id===null
    && held.prompt_injection_state==='not_injected' && Boolean(held.no_packet) && Boolean(held.no_submission) && Boolean(held.scope_unchanged) && Boolean(held.owner_proven);
}
