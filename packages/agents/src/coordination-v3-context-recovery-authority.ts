import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ProviderContextRecoveryRequest } from "@ponderosa/core";

export class ContextRecoveryConflictError extends Error {}

interface Row {
  id: string; agent_id: string; project_id: string; source_run_id: string; scope_key: string;
  provider_session_id: string; tool_contract_hash: string; source_fence: number;
  state: ProviderContextRecoveryRequest["state"]; created_at: string; dismissed_at: string | null;
}
function project(row: Row): ProviderContextRecoveryRequest {
  return { id: row.id, agentId: row.agent_id, projectId: row.project_id, sourceRunId: row.source_run_id,
    scopeKey: row.scope_key, providerSessionId: row.provider_session_id, toolContractHash: row.tool_contract_hash,
    sourceFence: row.source_fence, state: row.state, code: "provider_context_recovery_unsupported",
    createdAt: row.created_at, ...(row.dismissed_at ? { dismissedAt: row.dismissed_at } : {}) };
}

/** No executable recovery states exist yet. A committed refusal deliberately
 * holds dispatch; dismissal removes only this hold, never the context guards. */
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
      const source = this.sqlite.prepare(`SELECT id, status, provider_session_id, fencing_token, scope_key, project_id
        FROM scheduler_runs WHERE agent_id=? AND prompt_injection_state<>'not_injected'
        ORDER BY fencing_token DESC LIMIT 1`).get(input.agentId) as {
          id:string;status:string;provider_session_id:string;fencing_token:number;scope_key:string;project_id:string;
        } | undefined;
      if (source?.id !== input.sourceRunId || source.status !== 'outcome_unknown' ||
          source.provider_session_id !== input.providerSessionId || source.project_id !== input.projectId ||
          source.fencing_token !== input.sourceFence || source.scope_key !== input.scopeKey) throw new ContextRecoveryConflictError("Recovery requires the exact idle uncertain source boundary");
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
  dismiss(agentId: string,id: string): ProviderContextRecoveryRequest {
    return this.sqlite.transaction(() => {
      const row=this.sqlite.prepare("SELECT * FROM provider_context_recovery_requests WHERE agent_id=? AND id=?").get(agentId,id) as Row | undefined;
      if (!row) throw new ContextRecoveryConflictError("Recovery request not found");
      // These are refusal-only states: there is no native input to drain or
      // ambiguous acceptance to reconcile. Never reuse this for executable states.
      this.sqlite.prepare("UPDATE provider_context_recovery_requests SET state='dismissed',dismissed_at=COALESCE(dismissed_at,?) WHERE id=? AND state='unsupported_fenced'").run(new Date().toISOString(),id);
      return project(this.sqlite.prepare("SELECT * FROM provider_context_recovery_requests WHERE id=?").get(id) as Row);
    })();
  }
}
