import { failedSettingsHandoffUnsubmittedSql, transitionUnsubmittedActivationSql } from "./coordination-v3-transition-unsubmitted.js";
import type Database from "better-sqlite3";

/** Scope only the exact queued Activation. A failed or uncertain rollover
 * remains a hold even if its failure was recorded by startup recovery rather
 * than the ordinary transition path. */
export function settingsTransitionActivationHoldSql(activation:string):string {
  return `(EXISTS(SELECT 1 FROM context_rollovers folder JOIN activation_sources source
      ON source.source_kind='context_rollover' AND source.source_id=folder.id
      JOIN agent_activations handoff ON handoff.id=source.activation_id AND handoff.kind='context_rollover_handoff'
      WHERE folder.agent_id=${activation}.agent_id AND folder.project_id=${activation}.project_id
        AND (folder.state<>'completed' OR EXISTS(SELECT 1 FROM scheduler_runs verifying
          WHERE verifying.id=folder.replacement_run_id AND verifying.status IN ('leased','running'))) AND json_type(handoff.payload_json,'$.workingCopyTransition')='object'
        AND ${activation}.id<>handoff.id AND ${activation}.id<>coalesce(folder.continuation_activation_id,''))
    OR EXISTS (SELECT 1 FROM activation_sources reservation
      WHERE reservation.activation_id=${activation}.id AND reservation.source_kind='settings_transition_reservation_wait')
    OR EXISTS (
      SELECT 1 FROM context_rollovers rollover
      JOIN activation_sources source ON source.source_kind='context_rollover' AND source.source_id=rollover.id
      JOIN agent_activations handoff ON handoff.id=source.activation_id AND handoff.kind='context_rollover_handoff'
      WHERE rollover.project_id=${activation}.project_id AND rollover.agent_id=${activation}.agent_id
        AND rollover.state IN ('failed','outcome_unknown')
        AND json_extract(handoff.payload_json,'$.settingsTransition.activationId')=${activation}.id
        AND NOT EXISTS (SELECT 1 FROM activation_sources released
          WHERE released.activation_id=${activation}.id AND released.source_kind='settings_transition_release'
            AND released.source_id=rollover.id)
    )
    OR (${activation}.kind='required_reply_recovery' AND EXISTS (
      SELECT 1 FROM provider_context_recovery_requests recovery
      WHERE recovery.agent_id=${activation}.agent_id AND recovery.project_id=${activation}.project_id
        AND recovery.scope_key=${activation}.scope_key
        AND (recovery.source_run_id=json_extract(${activation}.payload_json,'$.requiredReplyRecovery.sourceRunId')
          OR (json_extract(recovery.progress_json,'$.reconstructionRolloverId') IS NOT NULL AND EXISTS(
            SELECT 1 FROM scheduler_runs original
            WHERE original.id=json_extract(${activation}.payload_json,'$.requiredReplyRecovery.sourceRunId')
              AND original.agent_id=recovery.agent_id AND original.project_id=recovery.project_id AND original.scope_key=recovery.scope_key
              AND original.fencing_token<=recovery.source_fence
              AND (original.provider_session_id=recovery.provider_session_id OR EXISTS(
                SELECT 1 FROM context_rollovers predecessor
                WHERE predecessor.id=json_extract(recovery.progress_json,'$.reconstructionPredecessorRolloverId')
                  AND predecessor.agent_id=recovery.agent_id AND predecessor.project_id=recovery.project_id
                  AND predecessor.scope_key=recovery.scope_key AND predecessor.provider_session_generation=recovery.provider_session_id
                  AND predecessor.replacement_run_id=original.id)))))
    ) AND NOT EXISTS (
      SELECT 1 FROM activation_sources reviewed JOIN coordination_idempotency proof
        ON proof.project_id=${activation}.project_id AND proof.operation='reviewed_steering_continue'
        AND json_extract(proof.result_json,'$.activationId')=${activation}.id
        AND json_extract(proof.result_json,'$.agentId')=${activation}.agent_id
        AND json_extract(proof.result_json,'$.sourceRunId')=json_extract(${activation}.payload_json,'$.requiredReplyRecovery.sourceRunId')
        AND json_extract(proof.result_json,'$.injectionId')=reviewed.source_id
      WHERE reviewed.activation_id=${activation}.id AND reviewed.source_kind='reviewed_steering'
    ))
    OR EXISTS(SELECT 1 FROM provider_context_recovery_requests recovery
      WHERE recovery.agent_id=${activation}.agent_id AND recovery.project_id=${activation}.project_id AND recovery.scope_key=${activation}.scope_key
        AND json_extract(recovery.progress_json,'$.reconstructionRolloverId') IS NOT NULL
        AND (( ${activation}.kind IN ('context_rollover_handoff','context_rollover_continuation')
          AND json_extract(${activation}.payload_json,'$.rolloverId')=json_extract(recovery.progress_json,'$.reconstructionPredecessorRolloverId'))
          OR EXISTS(SELECT 1 FROM activation_sources old
            WHERE old.activation_id=${activation}.id AND old.source_kind='context_rollover_recovery'
              AND old.source_id=json_extract(recovery.progress_json,'$.reconstructionPredecessorRolloverId'))))
    OR (${activation}.kind='required_reply_recovery' AND EXISTS (
      SELECT 1 FROM context_rollovers rollover
      JOIN activation_sources source ON source.source_kind='context_rollover' AND source.source_id=rollover.id
      JOIN agent_activations handoff ON handoff.id=source.activation_id AND handoff.kind='context_rollover_handoff'
      WHERE rollover.project_id=${activation}.project_id AND rollover.agent_id=${activation}.agent_id
        AND rollover.scope_key=${activation}.scope_key AND rollover.state IN ('failed','outcome_unknown')
        AND json_type(handoff.payload_json,'$.settingsTransition')='object'
        AND json_extract(${activation}.payload_json,'$.requiredReplyRecovery.sourceRunId')=rollover.source_run_id
        AND NOT EXISTS(SELECT 1 FROM activation_sources released
          WHERE released.source_kind='settings_transition_release' AND released.source_id=rollover.id
            AND NOT EXISTS(SELECT 1 FROM provider_context_recovery_requests recovery
              WHERE recovery.agent_id=rollover.agent_id
                AND json_extract(recovery.progress_json,'$.reconstructionPredecessorRolloverId')=rollover.id
                AND json_extract(recovery.progress_json,'$.deliveryRetryActivationId')=released.activation_id))
    )))`;
}

/** True only while a handoff owns recovery for this exact queued Activation. */
export function settingsTransitionRecoveryInProgressSql(activation:string):string {
  return `EXISTS(SELECT 1 FROM context_rollovers rollover
    JOIN activation_sources source ON source.source_kind='context_rollover' AND source.source_id=rollover.id
    JOIN agent_activations handoff ON handoff.id=source.activation_id AND handoff.kind='context_rollover_handoff'
    WHERE rollover.project_id=${activation}.project_id AND rollover.agent_id=${activation}.agent_id
      AND rollover.scope_key=${activation}.scope_key
      AND rollover.state IN ('requested','handoff_committed','session_retiring','continuation_ready')
      AND json_extract(handoff.payload_json,'$.settingsTransition.activationId')=${activation}.id)`;
}

/** An independent activation cannot treat an older interrupted handoff as
 * settled merely because the old session pointer has been cleared. */
export function unsettledSettingsTransitionPredecessor(
  db:Database.Database,projectId:string,agentId:string,scopeKey:string,activationId:string,
):boolean {
  return Boolean(db.prepare(`SELECT 1 FROM context_rollovers prior
    JOIN agents ag ON ag.id=prior.agent_id AND (ag.active_session_id IS NULL OR ag.active_session_id=prior.old_provider_session_id)
    JOIN activation_sources source ON source.source_kind='context_rollover' AND source.source_id=prior.id
    JOIN agent_activations handoff ON handoff.id=source.activation_id AND handoff.kind='context_rollover_handoff'
    WHERE prior.agent_id=? AND prior.project_id=? AND prior.scope_key=?
      AND json_type(handoff.payload_json,'$.settingsTransition')='object'
      AND coalesce(json_extract(handoff.payload_json,'$.settingsTransition.engineId'),ag.active_engine)=ag.active_engine
      AND json_extract(handoff.payload_json,'$.settingsTransition.activationId')<>?
      AND (prior.state='outcome_unknown' OR prior.state='failed' AND NOT ${failedSettingsHandoffUnsubmittedSql('prior')})
      AND NOT EXISTS(SELECT 1 FROM provider_context_recovery_requests recovery
        WHERE recovery.agent_id=prior.agent_id AND recovery.project_id=prior.project_id AND recovery.scope_key=prior.scope_key
          AND recovery.state='dismissed' AND json_extract(recovery.progress_json,'$.phase')='canonical_reconstructed'
          AND json_extract(recovery.progress_json,'$.reconstructionPredecessorRolloverId')=prior.id)
    LIMIT 1`).get(agentId,projectId,scopeKey,activationId));
}

export type SettingsTransitionDeliveryHold = {
  retryable: boolean;
  recoveryKey: string;
  rolloverId?: string;
  handoffId?: string;
  reprepare?: boolean;
};

/** Read only the exact retained message and its transition evidence. A
 * reservation error does not authorize retry if an uncertain transition also
 * exists. This query is batched across receipts. */
export function settingsTransitionDeliveryHolds(
  db:Database.Database, projectId:string, activationIds:string[], mode:"human"|"request"="human",
):Map<string,SettingsTransitionDeliveryHold> {
  const result=new Map<string,SettingsTransitionDeliveryHold>();
  if (!activationIds.length) return result;
  const rows=db.prepare(`SELECT a.id,a.state,a.kind,a.prompt_class,
      EXISTS(SELECT 1 FROM activation_sources x JOIN runtime_communications m ON m.id=x.source_id
        WHERE x.activation_id=a.id AND x.source_kind='communication' AND m.project_id=a.project_id
          AND json_extract(m.sender_json,'$.kind')='user' AND json_extract(m.sender_json,'$.userId')='local-operator') AS operator_authored,
      ${transitionUnsubmittedActivationSql('a')} AS unsubmitted,
      (SELECT x.source_id FROM activation_sources x WHERE x.activation_id=a.id
        AND x.source_kind='settings_transition_reservation_wait' ORDER BY x.source_id LIMIT 1) AS reservation,
      ag.active_session_id,ag.active_session_contract_hash,
      r.id AS rollover_id,r.state AS rollover_state,r.handoff_event_id,r.replacement_run_id,
      handoff.id AS handoff_id,handoff.state AS handoff_state,
      json_extract(handoff.payload_json,'$.settingsTransition.oldSessionId') AS old_session_id,
      json_extract(handoff.payload_json,'$.settingsTransition.oldContractHash') AS old_contract_hash,
      ${failedSettingsHandoffUnsubmittedSql('r')} AS rollover_unsubmitted,
      EXISTS(SELECT 1 FROM activation_sources x JOIN scheduler_run_activations y ON y.activation_id=x.activation_id
        WHERE x.source_kind='context_rollover' AND x.source_id=r.id) AS rollover_attached
    FROM agent_activations a JOIN agents ag ON ag.id=a.agent_id AND ag.project_id=a.project_id
    LEFT JOIN context_rollovers r ON r.project_id=a.project_id AND r.agent_id=a.agent_id
      AND r.state IN ('requested','handoff_committed','session_retiring','continuation_ready','failed','outcome_unknown')
      AND NOT EXISTS(SELECT 1 FROM activation_sources released WHERE released.activation_id=a.id
        AND released.source_kind='settings_transition_release' AND released.source_id=r.id)
      AND EXISTS(SELECT 1 FROM activation_sources x JOIN agent_activations h ON h.id=x.activation_id
        WHERE x.source_kind='context_rollover' AND x.source_id=r.id AND h.kind='context_rollover_handoff'
          AND json_extract(h.payload_json,'$.settingsTransition.activationId')=a.id)
    LEFT JOIN activation_sources source ON source.source_kind='context_rollover' AND source.source_id=r.id
      AND EXISTS(SELECT 1 FROM agent_activations h WHERE h.id=source.activation_id AND h.kind='context_rollover_handoff'
        AND json_extract(h.payload_json,'$.settingsTransition.activationId')=a.id)
    LEFT JOIN agent_activations handoff ON handoff.id=source.activation_id AND handoff.kind='context_rollover_handoff'
      AND json_extract(handoff.payload_json,'$.settingsTransition.activationId')=a.id
    WHERE a.project_id=? AND a.id IN (SELECT value FROM json_each(?))
    ORDER BY a.id,r.created_at,r.id,handoff.created_at,handoff.id`)
    .all(projectId,JSON.stringify([...new Set(activationIds)])) as Array<{
      id:string;state:string;kind:string;prompt_class:string;operator_authored:number;unsubmitted:number;reservation:string|null;active_session_id:string|null;active_session_contract_hash:string|null;
      rollover_id:string|null;rollover_state:string|null;handoff_event_id:string|null;replacement_run_id:string|null;
      handoff_id:string|null;handoff_state:string|null;old_session_id:string|null;old_contract_hash:string|null;rollover_attached:number;rollover_unsubmitted:number;
    }>;
  const groups=new Map<string,typeof rows>();
  for (const row of rows) { const group=groups.get(row.id)??[]; group.push(row); groups.set(row.id,group); }
  for(const [id,group] of groups) {
    const first=group[0]!, relevant=group.filter(row=>row.rollover_id);
    const terminal=relevant.filter(row=>row.rollover_state==='failed'||row.rollover_state==='outcome_unknown');
    if (!first.reservation&&!terminal.length) continue;
    const failedIds=new Set(terminal.filter(row=>row.rollover_state==='failed').map(row=>row.rollover_id));
    const failed=terminal.find(row=>row.rollover_state==='failed');
    const safeFailed=failedIds.size===1&&failed&&terminal.every(row=>row.rollover_state==='failed'&&
      row.rollover_id===failed.rollover_id&&
      (row.rollover_attached ? row.rollover_unsubmitted : row.handoff_state==='cancelled'&&!row.handoff_event_id&&!row.replacement_run_id)&&
      row.old_session_id===first.active_session_id&&row.old_contract_hash===first.active_session_contract_hash&&
      !!row.old_session_id&&!!row.old_contract_hash);
    const eligible=mode==='human'
      ? first.kind==='human_message'&&first.prompt_class==='human'&&first.operator_authored===1
      : first.kind==='coordination_request'&&first.prompt_class==='coordination';
    const retryable=Boolean(first.unsubmitted)&&eligible&&
      !relevant.some(row=>row.rollover_state!=='failed')&&
      (!terminal.length||Boolean(safeFailed));
    result.set(id,{retryable,recoveryKey:failed?.rollover_id??first.reservation??id,...(safeFailed?{rolloverId:failed.rollover_id!,handoffId:failed.handoff_id!,reprepare:Boolean(failed.rollover_attached)}:{})});
  }
  return result;
}

/** The caller has checked exact task ownership and this hold in the same
 * transaction. Release proven prep failures to admission or rearm the existing
 * never-leased handoff. Keep the task activation and its sources intact. */
export function retrySettingsTransitionHold(db:Database.Database,activationId:string,projectId:string,agentId:string,
  hold:SettingsTransitionDeliveryHold,now:string,deferSteering=false):void {
  if (!hold.retryable) throw Error('Settings transition is not safe to retry');
  if (hold.reprepare) {
    db.prepare("INSERT INTO activation_sources VALUES(?,'settings_transition_release',?)").run(activationId,hold.rolloverId);
  } else if (hold.rolloverId && hold.handoffId) {
    const changed=db.prepare(`UPDATE context_rollovers SET state='requested',last_error=NULL,
      failure_signal=NULL,failure_provenance='internal',terminal_at=NULL,updated_at=?
      WHERE id=? AND project_id=? AND agent_id=? AND state='failed' AND handoff_event_id IS NULL
        AND replacement_run_id IS NULL`).run(now,hold.rolloverId,projectId,agentId);
    const handoff=db.prepare(`UPDATE agent_activations SET state='pending',terminal_at=NULL,
      last_delivery_error=NULL,available_at=?,updated_at=? WHERE id=? AND kind='context_rollover_handoff' AND state='cancelled'`)
      .run(now,now,hold.handoffId);
    if(changed.changes!==1||handoff.changes!==1) throw Error('Settings transition changed before retry');
  }
  if (hold.reprepare || deferSteering && !hold.rolloverId) db.prepare("INSERT OR IGNORE INTO activation_sources(activation_id,source_kind,source_id) VALUES(?,'settings_transition_retry_pending','preflight')").run(activationId);
  db.prepare("DELETE FROM activation_sources WHERE activation_id=? AND source_kind='settings_transition_reservation_wait'").run(activationId);
}
