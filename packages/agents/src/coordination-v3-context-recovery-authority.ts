import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ProviderContextRecoveryProgress, ProviderContextRecoveryRequest } from "@ponderosa/core";

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
  constructor(private readonly sqlite: Database.Database) {}
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
  reserveOperation(agentId: string, id: string): boolean {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.prepare("SELECT * FROM provider_context_recovery_requests WHERE id=? AND agent_id=? AND state='unsupported_fenced'").get(id, agentId) as Row | undefined;
      if (!row || row.progress_json) return false;
      this.assertSource(row);
      if (this.sqlite.prepare(`SELECT 1 FROM provider_context_recovery_requests WHERE agent_id=? AND provider_session_id=?
        AND json_extract(progress_json,'$.nativeInvoked')=1 AND json_extract(progress_json,'$.phase')<>'context_accepted' LIMIT 1`)
        .get(agentId,row.provider_session_id)) throw new ContextRecoveryConflictError("Earlier native recovery outcome is unknown; a different key cannot replay compaction");
      this.sqlite.prepare("UPDATE provider_context_recovery_requests SET progress_json=? WHERE id=?")
        .run(JSON.stringify({phase:"reserved",updatedAt:new Date().toISOString(),sourceWork:"held_unknown"}),id);
      return true;
    })();
  }
  advanceOperation(agentId: string, id: string, expected: ProviderContextRecoveryProgress["phase"],
    phase: ProviderContextRecoveryProgress["phase"], details: {usedTokens?:number;windowTokens?:number;message?:string;contextUsageEventSequence?:number} = {}): ProviderContextRecoveryRequest {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.prepare("SELECT * FROM provider_context_recovery_requests WHERE id=? AND agent_id=? AND state='unsupported_fenced'").get(id,agentId) as Row | undefined;
      const progress = row?.progress_json ? JSON.parse(row.progress_json) as ProviderContextRecoveryProgress : undefined;
      if (!row || progress?.phase !== expected) throw new ContextRecoveryConflictError("Recovery operation phase changed; never replay native input");
      const allowed = phase === "held" || expected === "reserved" && phase === "drained" ||
        expected === "drained" && phase === "native_started" || expected === "native_started" && phase === "context_accepted";
      if (!allowed) throw new ContextRecoveryConflictError("Invalid recovery transition");
      this.assertSource(row);
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
        .run(JSON.stringify({phase,updatedAt:new Date().toISOString(),sourceWork:"held_unknown",nativeInvoked:progress.nativeInvoked || phase === "native_started",...details}),id);
      return project(this.sqlite.prepare("SELECT * FROM provider_context_recovery_requests WHERE id=?").get(id) as Row);
    })();
  }
  /** Recover only the local event-to-phase commit gap, never a missing native result. */
  reconcileRecordedCompletion(agentId:string,id:string):boolean {
    return this.sqlite.transaction(()=>{
      const row=this.sqlite.prepare("SELECT * FROM provider_context_recovery_requests WHERE id=? AND agent_id=? AND state='unsupported_fenced'").get(id,agentId) as Row|undefined;
      if(!row||!row.progress_json||JSON.parse(row.progress_json).phase!=='native_started')return false;
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
      this.advanceOperation(agentId,id,'native_started','context_accepted',{usedTokens:usage.usedTokens,
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
