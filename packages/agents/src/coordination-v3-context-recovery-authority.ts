import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ProviderContextRecoveryProgress, ProviderContextRecoveryRequest } from "@ponderosa/core";
import { transitionUnsubmittedActivationSql } from "./coordination-v3-transition-unsubmitted.js";
import type { CoordinationV3RuntimeScopeAuthority } from "./coordination-v3-runtime-scope-authority.js";

export class ContextRecoveryConflictError extends Error {}

/** Exact canonical Stop cancellation does not request erasure of native context. */
export const stoppedContextSourceSql = (run: string): string => `(
  ${run}.status='cancelled' AND ${run}.provider_session_id IS NOT NULL
  AND ${run}.prompt_injection_state<>'not_injected'
  AND EXISTS (SELECT 1 FROM scheduler_cancellation_receipts stopped
    WHERE stopped.agent_id=${run}.agent_id AND stopped.run_id=${run}.id
      AND stopped.accepted=1 AND stopped.fencing_token=${run}.fencing_token)
)`;
/** Only acknowledged source input and observed exact Stop cleanup qualify. */
export const stoppedContextRecoverySourceSql = (run: string): string => `(
  ${stoppedContextSourceSql(run)} AND ${run}.prompt_injection_state='injected'
  AND NOT EXISTS (SELECT 1 FROM scheduler_prompt_injections pending
    WHERE pending.run_id=${run}.id AND pending.state IN ('pending','submitted','outcome_unknown'))
  AND EXISTS (SELECT 1 FROM provider_operation_outbox cleanup
    WHERE cleanup.run_id=${run}.id AND cleanup.operation='interrupt' AND cleanup.state='completed'
      AND json_extract(cleanup.payload_json,'$.agentId')=${run}.agent_id
      AND json_extract(cleanup.payload_json,'$.fencingToken')=${run}.fencing_token)
)`;

/** A completed turn can still contain an unconfirmed interruption. The
 * acknowledged turn binds the session; the steer remains unknown work. */
export const uncertainContextRecoverySourceSql = (run: string): string => `(
  ${stoppedContextRecoverySourceSql(run)} OR ${run}.status='outcome_unknown' OR (
    ${run}.status='completed' AND ${run}.prompt_injection_state='injecting'
    AND EXISTS (SELECT 1 FROM scheduler_prompt_injections turn
      WHERE turn.run_id=${run}.id AND turn.kind='turn' AND turn.state='acknowledged')
    AND EXISTS (SELECT 1 FROM scheduler_prompt_injections steer
      WHERE steer.run_id=${run}.id AND steer.kind='steer' AND steer.state='outcome_unknown')
  ))`;

interface Row {
  id: string; agent_id: string; project_id: string; source_run_id: string; scope_key: string;
  provider_session_id: string; tool_contract_hash: string; source_fence: number;
  progress_json: string | null; state: ProviderContextRecoveryRequest["state"]; created_at: string; dismissed_at: string | null;
}
function project(row: Row): ProviderContextRecoveryRequest {
  return { id: row.id, agentId: row.agent_id, projectId: row.project_id, sourceRunId: row.source_run_id,
    scopeKey: row.scope_key, providerSessionId: row.provider_session_id, toolContractHash: row.tool_contract_hash,
    sourceFence: row.source_fence, state: row.state, code: row.progress_json ? "provider_context_recovery_source_work_held" : "provider_context_recovery_unsupported",
    ...(row.progress_json ? { progress: JSON.parse(row.progress_json) as ProviderContextRecoveryProgress } : {}),
    createdAt: row.created_at, ...(row.dismissed_at ? { dismissedAt: row.dismissed_at } : {}) };
}

/** SQLite owns recovery reservation and mutation custody. Neither accepting
 * context nor dismissing a hold resolves an uncertain source Run's effects. */
export class CoordinationV3ContextRecoveryAuthority {
  constructor(private readonly sqlite: Database.Database, private readonly runtimeScopeAuthority: CoordinationV3RuntimeScopeAuthority) {}
  /** Internal maintenance policy: only independently saved, provably unsubmitted
   * human input in the retained source scope authorizes automatic recovery. */
  hasPendingMaintenanceInput(boundary: Pick<ProviderContextRecoveryRequest,"agentId"|"projectId"|"scopeKey"|"sourceRunId">): boolean {
    if(!this.runtimeScopeAuthority.recipientAuthorizedForActivationScope(boundary.projectId,boundary.agentId,boundary.scopeKey))return false;
    return Boolean(this.sqlite.prepare(`SELECT 1 FROM agent_activations a
      WHERE a.agent_id=? AND a.project_id=? AND a.scope_key=? AND a.kind='human_message' AND a.prompt_class='human'
        AND a.state IN ('pending','retry_pending') AND ${transitionUnsubmittedActivationSql('a')}
        -- An interrupted handoff belongs to its existing rollover authority;
        -- session compaction cannot reconstruct an unconfirmed transfer.
        AND NOT EXISTS(SELECT 1 FROM scheduler_run_activations source
          JOIN agent_activations handoff ON handoff.id=source.activation_id
          WHERE source.run_id=? AND handoff.kind='context_rollover_handoff')
        AND EXISTS(SELECT 1 FROM activation_sources s JOIN runtime_communications c ON c.id=s.source_id
          WHERE s.activation_id=a.id AND s.source_kind='communication' AND c.project_id=a.project_id
            AND json_extract(c.sender_json,'$.kind')='user' AND json_extract(c.sender_json,'$.userId')='local-operator')
      LIMIT 1`).get(boundary.agentId,boundary.projectId,boundary.scopeKey,boundary.sourceRunId));
  }
  requestMaintenance(boundary: Omit<Parameters<CoordinationV3ContextRecoveryAuthority["request"]>[0],"idempotencyKey">) {
    if (!this.hasPendingMaintenanceInput(boundary)) throw new ContextRecoveryConflictError("No eligible pending input requires maintenance");
    const active=this.active(boundary.agentId);
    if(active) {
      if(active.projectId!==boundary.projectId||active.scopeKey!==boundary.scopeKey||active.providerSessionId!==boundary.providerSessionId||
          active.sourceRunId!==boundary.sourceRunId||active.sourceFence!==boundary.sourceFence||active.toolContractHash!==boundary.toolContractHash)
        throw new ContextRecoveryConflictError("Maintenance boundary changed");
      return {request:active.progress&&!active.progress.reconstructionRolloverId&&active.progress.phase!=="context_accepted"
        ? this.advanceOperation(active.agentId,active.id,active.progress.phase,active.progress.phase,{automaticMaintenance:true}) : active,replayed:true};
    }
    return this.request({...boundary,idempotencyKey:`maintenance:${boundary.sourceRunId}:${boundary.sourceFence}`});
  }
  active(agentId: string): ProviderContextRecoveryRequest | undefined {
    const row = this.sqlite.prepare("SELECT * FROM provider_context_recovery_requests WHERE agent_id=? AND state='unsupported_fenced'").get(agentId) as Row | undefined;
    return row && project(row);
  }
  byKey(agentId: string, key: string): ProviderContextRecoveryRequest | undefined {
    const row = this.sqlite.prepare("SELECT * FROM provider_context_recovery_requests WHERE agent_id=? AND idempotency_key=?").get(agentId,key) as Row | undefined;
    return row && project(row);
  }
  request(input: {
    agentId: string; projectId: string; sourceRunId: string; providerSessionId: string;
    toolContractHash: string; sourceFence: number; scopeKey: string; idempotencyKey: string;
  }): { request: ProviderContextRecoveryRequest; replayed: boolean } {
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200 || !/^[a-f0-9]{64}$/u.test(input.toolContractHash)) {
      throw new ContextRecoveryConflictError("Invalid exact recovery binding");
    }
    return this.sqlite.transaction(() => {
      const prior = this.byKey(input.agentId,input.idempotencyKey);
      if (prior) {
        if (prior.projectId !== input.projectId || prior.sourceRunId !== input.sourceRunId ||
            prior.providerSessionId !== input.providerSessionId || prior.toolContractHash !== input.toolContractHash ||
            prior.sourceFence !== input.sourceFence || prior.scopeKey !== input.scopeKey) throw new ContextRecoveryConflictError("Recovery key belongs to a different boundary");
        return { request: prior, replayed: true };
      }
      if (this.active(input.agentId)) throw new ContextRecoveryConflictError("An explicit recovery hold already exists");
      if (!this.sqlite.prepare("SELECT 1 FROM agents WHERE id=? AND project_id=? AND active_session_id=? AND active_session_contract_hash=?")
          .get(input.agentId,input.projectId,input.providerSessionId,input.toolContractHash)) throw new ContextRecoveryConflictError("Accepted normal contract changed");
      const source = this.sqlite.prepare(`SELECT r.id, r.status, r.provider_session_id, r.fencing_token, r.scope_key, r.project_id,
        ${uncertainContextRecoverySourceSql('r')} AS eligible
        FROM scheduler_runs r WHERE r.agent_id=? AND r.prompt_injection_state<>'not_injected'
        ORDER BY fencing_token DESC LIMIT 1`).get(input.agentId) as {
          id:string;status:string;provider_session_id:string;fencing_token:number;scope_key:string;project_id:string;eligible:number;
        } | undefined;
      if (source?.id !== input.sourceRunId || !source.eligible ||
          source.provider_session_id !== input.providerSessionId || source.project_id !== input.projectId ||
          source.fencing_token !== input.sourceFence || source.scope_key !== input.scopeKey) throw new ContextRecoveryConflictError("Recovery requires the exact idle uncertain or stopped source boundary");
      if (this.sqlite.prepare(`SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running')
        UNION ALL SELECT 1 FROM agent_run_pauses WHERE agent_id=? AND state IN ('paused','resume_requested')
        UNION ALL SELECT 1 FROM context_rollovers WHERE agent_id=? AND state IN ('requested','handoff_committed','session_retiring','continuation_ready') LIMIT 1`).get(input.agentId,input.agentId,input.agentId)) {
        throw new ContextRecoveryConflictError("Recovery conflicts with a live Run, pause or context transition");
      }
      const id=randomUUID(),now=new Date().toISOString();
      this.sqlite.prepare(`INSERT INTO provider_context_recovery_requests
        (id,agent_id,project_id,source_run_id,scope_key,provider_session_id,tool_contract_hash,source_fence,idempotency_key,state,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,'unsupported_fenced',?)`).run(id,input.agentId,input.projectId,input.sourceRunId,input.scopeKey,input.providerSessionId,input.toolContractHash,input.sourceFence,input.idempotencyKey,now);
      return { request: this.active(input.agentId)!, replayed: false };
    })();
  }
  /** A committed reservation is never replayed, including after daemon restart. */
  reserveOperation(agentId: string, id: string, resumeUninvoked = false): boolean {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.prepare("SELECT * FROM provider_context_recovery_requests WHERE id=? AND agent_id=? AND state='unsupported_fenced'").get(id, agentId) as Row | undefined;
      const previous=row?.progress_json?JSON.parse(row.progress_json) as ProviderContextRecoveryProgress:undefined;
      if (!row || previous && !(resumeUninvoked && !previous.nativeInvoked && ["reserved","drained","held"].includes(previous.phase))) return false;
      this.assertSource(row);
      if (this.sqlite.prepare(`SELECT 1 FROM provider_context_recovery_requests WHERE agent_id=? AND provider_session_id=?
        AND json_extract(progress_json,'$.nativeInvoked')=1 AND json_extract(progress_json,'$.phase')<>'context_accepted' LIMIT 1`)
        .get(agentId,row.provider_session_id)) throw new ContextRecoveryConflictError("Earlier native recovery outcome is unknown; a different key cannot replay compaction");
      this.sqlite.prepare("UPDATE provider_context_recovery_requests SET progress_json=? WHERE id=?")
        .run(JSON.stringify({...previous,phase:"reserved",updatedAt:new Date().toISOString(),sourceWork:"held_unknown"}),id);
      return true;
    })();
  }
  advanceOperation(agentId: string, id: string, expected: ProviderContextRecoveryProgress["phase"],
    phase: ProviderContextRecoveryProgress["phase"], details: Partial<Pick<ProviderContextRecoveryProgress,"usedTokens"|"windowTokens"|"message"|"contextUsageEventSequence"|"nativeOutcome"|"maintenanceAttempts"|"nextMaintenanceAt"|"automaticMaintenance">> = {}): ProviderContextRecoveryRequest {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.prepare("SELECT * FROM provider_context_recovery_requests WHERE id=? AND agent_id=? AND state='unsupported_fenced'").get(id,agentId) as Row | undefined;
      const progress = row?.progress_json ? JSON.parse(row.progress_json) as ProviderContextRecoveryProgress : undefined;
      if (!row || progress?.phase !== expected) throw new ContextRecoveryConflictError("Recovery operation phase changed; never replay native input");
      if(expected==='context_accepted'&&phase===expected) details={usedTokens:progress.usedTokens,
        windowTokens:progress.windowTokens,contextUsageEventSequence:progress.contextUsageEventSequence,...details};
      const allowed = phase === expected || phase === "held" || expected === "reserved" && phase === "drained" ||
        expected === "drained" && phase === "native_started" ||
        (expected === "native_started" || expected === "held" && progress.nativeInvoked) && phase === "context_accepted";
      if (!allowed) throw new ContextRecoveryConflictError("Invalid recovery transition");
      if(progress.reconstructionRolloverId) {
        if(phase!==expected||Object.keys(details).some(key=>!['maintenanceAttempts','nextMaintenanceAt','automaticMaintenance'].includes(key)))
          throw new ContextRecoveryConflictError('Reserved reconstruction cannot mutate native recovery evidence');
        this.assertReconstruction(agentId,id,progress.reconstructionRolloverId);
      } else this.assertSource(row);
      if (phase === "context_accepted" && (!Number.isSafeInteger(details.usedTokens) || details.usedTokens! < 0 ||
          details.windowTokens !== undefined && (!Number.isSafeInteger(details.windowTokens) || details.windowTokens <= 0))) {
        throw new ContextRecoveryConflictError("Recovery acceptance requires fresh exact native occupancy");
      }
      if (phase === "context_accepted" && !this.sqlite.prepare(`SELECT 1 FROM events WHERE agent_id=? AND seq=? AND type='context_usage'
        AND json_extract(payload_json,'$.providerSessionId')=? AND json_extract(payload_json,'$.providerSessionGeneration')=?
        AND json_extract(payload_json,'$.providerCommand.invocationId')=? AND json_extract(payload_json,'$.usedTokens')=?
        AND json_extract(payload_json,'$.windowTokens') IS ?`)
        .get(agentId,details.contextUsageEventSequence ?? -1,row.provider_session_id,row.provider_session_id,id,details.usedTokens,details.windowTokens ?? null)) {
        throw new ContextRecoveryConflictError("Recovery acceptance requires its durable exact context-usage event");
      }
      this.sqlite.prepare("UPDATE provider_context_recovery_requests SET progress_json=? WHERE id=?")
        .run(JSON.stringify({...progress,phase,updatedAt:new Date().toISOString(),sourceWork:"held_unknown",nativeInvoked:progress.nativeInvoked || phase === "native_started",...details}),id);
      return project(this.sqlite.prepare("SELECT * FROM provider_context_recovery_requests WHERE id=?").get(id) as Row);
    })();
  }
  /** Recover only the local event-to-phase commit gap, never a missing native result. */
  reconcileRecordedCompletion(agentId:string,id:string,verifyAccepted=false):boolean {
    return this.sqlite.transaction(()=>{
      const row=this.sqlite.prepare("SELECT * FROM provider_context_recovery_requests WHERE id=? AND agent_id=? AND state='unsupported_fenced'").get(id,agentId) as Row|undefined;
      const progress=row?.progress_json?JSON.parse(row.progress_json) as ProviderContextRecoveryProgress:undefined;
      if(!row||!progress||!['native_started','context_accepted','held'].includes(progress.phase)||progress.phase==='held'&&!progress.nativeInvoked)return false;
      if(progress.reconstructionRolloverId)return false;
      if(progress.phase==='context_accepted'&&!verifyAccepted)return false;
      this.assertSource(row);
      if(this.sqlite.prepare('SELECT 1 FROM provider_process_authority WHERE agent_id=? LIMIT 1').get(agentId))return false;
      const events=this.sqlite.prepare(`SELECT seq,payload_json FROM events WHERE agent_id=? AND type='context_usage'
        AND json_extract(payload_json,'$.providerSessionId')=? AND json_extract(payload_json,'$.providerSessionGeneration')=?
        AND json_extract(payload_json,'$.providerCommand.name')='compact' AND json_extract(payload_json,'$.providerCommand.invocationId')=?
        AND json_extract(payload_json,'$.providerCommand.executionId')=? AND json_extract(payload_json,'$.providerCommand.fencingToken')=? LIMIT 2`)
        .all(agentId,row.provider_session_id,row.provider_session_id,id,row.source_run_id,row.source_fence) as {seq:number;payload_json:string}[];
      if(!events.length)return false;
      if(events.length!==1)throw new ContextRecoveryConflictError('Recovery completion evidence is ambiguous');
      const event=events[0]!,usage=JSON.parse(event.payload_json);
      if(progress.phase==='context_accepted') {
        if(progress.contextUsageEventSequence!==event.seq || progress.usedTokens!==usage.usedTokens ||
            progress.windowTokens!==usage.windowTokens) throw new ContextRecoveryConflictError('Accepted recovery evidence changed');
        return true;
      }
      this.advanceOperation(agentId,id,progress.phase,'context_accepted',{usedTokens:usage.usedTokens,
        ...(usage.windowTokens!==undefined?{windowTokens:usage.windowTokens}:{}),contextUsageEventSequence:event.seq});
      return true;
    })();
  }
  private assertSource(row: Row): void {
    if (!this.sqlite.prepare(`SELECT 1 FROM agents a JOIN scheduler_runs r ON r.id=? AND r.agent_id=a.id
      WHERE a.id=? AND a.active_session_id=? AND a.active_session_contract_hash=? AND a.project_id=? AND a.deleted_at IS NULL
        AND r.scope_key=? AND r.project_id=a.project_id AND ${uncertainContextRecoverySourceSql('r')} AND r.fencing_token=? AND r.provider_session_id=?
        AND NOT EXISTS (SELECT 1 FROM scheduler_runs newer WHERE newer.agent_id=a.id
          AND (newer.status IN ('leased','running') OR newer.fencing_token>r.fencing_token AND newer.prompt_injection_state<>'not_injected'))`)
      .get(row.source_run_id,row.agent_id,row.provider_session_id,row.tool_contract_hash,row.project_id,row.scope_key,row.source_fence,row.provider_session_id)) {
      throw new ContextRecoveryConflictError("Recovery source authority changed");
    }
  }
  /** Only the existing invoked operation can reserve a replacement generation.
   * Its source work stays fenced, including after this hold becomes terminal. */
  assertReconstruction(agentId:string,id:string,rolloverId?:string):ProviderContextRecoveryRequest {
    const row=this.sqlite.prepare("SELECT * FROM provider_context_recovery_requests WHERE agent_id=? AND id=? AND state='unsupported_fenced'").get(agentId,id) as Row|undefined;
    const recovery=row&&project(row),progress=recovery?.progress;
    if(!row||!recovery||!progress?.nativeInvoked||!['held','native_started'].includes(progress.phase)||
        progress.usedTokens!==undefined||progress.contextUsageEventSequence!==undefined||
        (progress.reconstructionRolloverId??null)!==(rolloverId??null))
      throw new ContextRecoveryConflictError('Canonical reconstruction requires its exact unmeasured invoked recovery');
    if(!this.runtimeScopeAuthority.recipientAuthorizedForActivationScope(row.project_id,agentId,row.scope_key))
      throw new ContextRecoveryConflictError('Recovery scope access changed');
    if(!rolloverId)this.assertSource(row);
    else {
      // Retirement clears the accepted snapshot before asynchronous teardown.
      // Only this durable old-generation reservation can bridge that gap.
      const exact=this.sqlite.prepare(`SELECT 1 FROM context_rollovers c JOIN agents a ON a.id=c.agent_id
        JOIN scheduler_runs r ON r.id=c.source_run_id AND r.agent_id=a.id
        WHERE c.id=? AND c.agent_id=? AND c.project_id=? AND c.source_run_id=? AND c.scope_key=?
          AND c.old_provider_session_id=? AND c.provider_session_generation=?
          AND c.state='completed' AND c.completion_reason='no_continuation_required'
          AND c.handoff_event_id IS NULL AND c.replacement_run_id IS NULL
          AND a.project_id=c.project_id AND a.deleted_at IS NULL
          AND ((a.active_session_id=? AND a.active_session_contract_hash=?) OR (a.active_session_id IS NULL AND a.active_session_contract_hash IS NULL))
          AND r.project_id=c.project_id AND r.scope_key=c.scope_key AND r.provider_session_id=c.old_provider_session_id
          AND r.fencing_token=? AND ${uncertainContextRecoverySourceSql('r')}
          AND NOT EXISTS(SELECT 1 FROM scheduler_runs newer WHERE newer.agent_id=a.id
            AND (newer.status IN ('leased','running') OR newer.fencing_token>r.fencing_token AND newer.prompt_injection_state<>'not_injected'))`)
        .get(rolloverId,agentId,row.project_id,row.source_run_id,row.scope_key,row.provider_session_id,row.provider_session_id,
          row.provider_session_id,row.tool_contract_hash,row.source_fence);
      if(!exact)throw new ContextRecoveryConflictError('Canonical reconstruction generation or source changed');
      const prior=this.reconstructionPredecessor(recovery,rolloverId);
      if((prior??null)!==(progress.reconstructionPredecessorRolloverId??null))
        throw new ContextRecoveryConflictError('Historical reconstruction predecessor changed');
    }
    if(this.sqlite.prepare(`SELECT 1 FROM agent_run_pauses WHERE agent_id=? AND state IN ('paused','resume_requested')
      UNION ALL SELECT 1 FROM context_rollovers WHERE agent_id=? AND state IN ('requested','handoff_committed','session_retiring','continuation_ready') LIMIT 1`).get(agentId,agentId))
      throw new ContextRecoveryConflictError('Canonical reconstruction conflicts with another context owner');
    // Exact evidence always wins before retirement. Ambiguous evidence is held.
    if(!rolloverId&&this.sqlite.prepare(`SELECT 1 FROM events WHERE agent_id=? AND type='context_usage'
      AND json_extract(payload_json,'$.providerSessionId')=? AND json_extract(payload_json,'$.providerSessionGeneration')=?
      AND json_extract(payload_json,'$.providerCommand.invocationId')=? LIMIT 1`).get(agentId,row.provider_session_id,row.provider_session_id,id))
      throw new ContextRecoveryConflictError('Recorded recovery evidence must be reconciled first');
    return recovery;
  }
  /** A later accepted source may outlive an earlier failed transfer. Preserve
   * that whole attempt, including prepared-but-unaccepted replacement input.
   * ponytail: one historical predecessor; multiple transfers need an audited lineage. */
  reconstructionPredecessor(recovery:ProviderContextRecoveryRequest,excludeRolloverId?:string):string|undefined {
    const rows=this.sqlite.prepare(`SELECT id FROM context_rollovers WHERE agent_id=? AND provider_session_generation=? AND id<>coalesce(?,'')`)
      .all(recovery.agentId,recovery.providerSessionId,excludeRolloverId??null) as {id:string}[];
    if(!rows.length)return undefined;
    if(rows.length!==1)throw new ContextRecoveryConflictError('Historical context transfer ownership is ambiguous');
    const id=rows[0]!.id;
    const safe=this.sqlite.prepare(`SELECT 1 FROM context_rollovers c JOIN scheduler_runs source ON source.id=c.source_run_id
      WHERE c.id=? AND c.agent_id=? AND c.project_id=? AND c.scope_key=? AND c.old_provider_session_id=?
        AND c.state IN ('failed','outcome_unknown') AND c.terminal_at IS NOT NULL
        AND c.replacement_session_id IS NULL AND c.replacement_session_at IS NULL AND c.replacement_verified_at IS NULL
        AND source.agent_id=c.agent_id AND source.project_id=c.project_id AND source.scope_key=c.scope_key
        AND source.status='completed' AND source.prompt_injection_state='injected'
        AND source.provider_session_id=c.old_provider_session_id AND source.fencing_token<?
        AND (c.handoff_event_id IS NULL OR EXISTS(SELECT 1 FROM continuation_handoffs h
          JOIN scheduler_runs handoff ON handoff.id=h.source_execution_id
          WHERE h.id=c.handoff_event_id AND h.agent_id=c.agent_id AND handoff.agent_id=c.agent_id
            AND handoff.project_id=c.project_id AND handoff.scope_key=c.scope_key AND handoff.status='completed'
            AND handoff.prompt_injection_state='injected' AND handoff.provider_session_id=c.old_provider_session_id
            AND handoff.fencing_token>source.fencing_token AND handoff.fencing_token<?))
        AND (c.replacement_run_id IS NULL OR EXISTS(SELECT 1 FROM scheduler_runs replacement
          WHERE replacement.id=c.replacement_run_id AND replacement.agent_id=c.agent_id AND replacement.project_id=c.project_id
            AND replacement.scope_key=c.scope_key AND replacement.status IN ('failed','cancelled','outcome_unknown')
            AND replacement.terminal_at IS NOT NULL AND replacement.prompt_injection_state='not_injected'
            AND replacement.fencing_token>source.fencing_token AND replacement.fencing_token<?
            AND NOT EXISTS(SELECT 1 FROM scheduler_prompt_injections i WHERE i.run_id=replacement.id
              AND (i.state NOT IN ('pending','cancelled') OR i.submitted_at IS NOT NULL OR i.acknowledged_at IS NOT NULL OR i.provider_turn_id IS NOT NULL))))
        AND NOT EXISTS(SELECT 1 FROM events e WHERE e.agent_id=c.agent_id AND e.type IN ('session_snapshot','context_rollover_session_accepted')
          AND (json_extract(e.payload_json,'$.rolloverId')=c.id OR json_extract(e.payload_json,'$.executionId')=c.replacement_run_id))`)
      .get(id,recovery.agentId,recovery.projectId,recovery.scopeKey,recovery.providerSessionId,recovery.sourceFence,recovery.sourceFence,recovery.sourceFence);
    if(!safe)throw new ContextRecoveryConflictError('Earlier context transfer has no safe historical boundary');
    return id;
  }
  /** Called inside the rollover transaction, before any session is retired. */
  bindReconstruction(agentId:string,id:string,rolloverId:string,predecessorRolloverId?:string):void {
    const recovery=this.assertReconstruction(agentId,id);
    if(this.reconstructionPredecessor(recovery)!==predecessorRolloverId)
      throw new ContextRecoveryConflictError('Historical reconstruction predecessor changed before reservation');
    this.sqlite.prepare('UPDATE provider_context_recovery_requests SET progress_json=? WHERE id=?')
      .run(JSON.stringify({...recovery.progress,reconstructionRolloverId:rolloverId,reconstructionPredecessorRolloverId:predecessorRolloverId,updatedAt:new Date().toISOString()}),id);
  }
  completeReconstruction(agentId:string,id:string,rolloverId:string):void {
    this.sqlite.transaction(()=>{
      const recovery=this.assertReconstruction(agentId,id,rolloverId);
      if(this.sqlite.prepare(`SELECT 1 FROM agents WHERE id=? AND active_session_id IS NOT NULL
        UNION ALL SELECT 1 FROM provider_process_authority WHERE agent_id=? LIMIT 1`).get(agentId,agentId))
        throw new ContextRecoveryConflictError('Old provider generation has not drained');
      const now=new Date().toISOString();
      this.sqlite.prepare("UPDATE provider_context_recovery_requests SET state='dismissed',dismissed_at=?,progress_json=? WHERE id=? AND state='unsupported_fenced'")
        .run(now,JSON.stringify({...recovery.progress,phase:'canonical_reconstructed',updatedAt:now,nextMaintenanceAt:undefined}),id);
    })();
  }
  /** Provenance for future independent input, never executable old work. */
  reconstructedBoundary(agentId:string,projectId:string,scopeKey:string):ProviderContextRecoveryRequest|undefined {
    const row=this.sqlite.prepare(`SELECT * FROM provider_context_recovery_requests WHERE agent_id=? AND project_id=? AND scope_key=?
      AND state='dismissed' AND json_extract(progress_json,'$.phase')='canonical_reconstructed'
      AND NOT EXISTS(SELECT 1 FROM scheduler_runs newer JOIN scheduler_runs source ON source.id=provider_context_recovery_requests.source_run_id
        WHERE newer.agent_id=provider_context_recovery_requests.agent_id AND newer.fencing_token>source.fencing_token AND newer.prompt_injection_state<>'not_injected')
      ORDER BY dismissed_at DESC LIMIT 1`).get(agentId,projectId,scopeKey) as Row|undefined;
    return row&&project(row);
  }
  dismiss(agentId: string,id: string): ProviderContextRecoveryRequest {
    return this.sqlite.transaction(() => {
      const row=this.sqlite.prepare("SELECT * FROM provider_context_recovery_requests WHERE agent_id=? AND id=?").get(agentId,id) as Row | undefined;
      if (!row) throw new ContextRecoveryConflictError("Recovery request not found");
      const progress = row.progress_json ? JSON.parse(row.progress_json) as ProviderContextRecoveryProgress : undefined;
      if (progress && !["held", "context_accepted"].includes(progress.phase)) {
        throw new ContextRecoveryConflictError("Recovery operation must settle or be reconciled before dismissal");
      }
      // Dismissal never clears source uncertainty or authorizes replay.
      this.sqlite.prepare("UPDATE provider_context_recovery_requests SET state='dismissed',dismissed_at=COALESCE(dismissed_at,?) WHERE id=? AND state='unsupported_fenced'").run(new Date().toISOString(),id);
      return project(this.sqlite.prepare("SELECT * FROM provider_context_recovery_requests WHERE id=?").get(id) as Row);
    })();
  }
}
