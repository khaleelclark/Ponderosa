import { createHash, randomUUID } from "node:crypto";
import { readProviderExitEvidence, stableJson } from "@ponderosa/agents";
import type Database from "better-sqlite3";
import type { ProviderProcessRegistration, ProviderProcessExitReceipt, RuntimeProcessHandle, RuntimeProcessIdentity } from "@ponderosa/core";
import { recoveredRuntimeProcessHandle } from "@ponderosa/engines";

export interface ProviderProcessScope {
  purpose: string;
  projectId?: string;
  agentId?: string;
  runId?: string;
  /** Exact spawn/turn fence; never inferred from a later cancellation. */
  runFence?: number;
}

interface ProviderProcessRow {
  id: string;
  worker_id: string;
  purpose: string;
  project_id: string | null;
  agent_id: string | null;
  run_id: string | null;
  pid: number;
  pgid: number;
  birth_marker: string;
  scope_json: string | null;
  created_at: string;
}

export class ProviderProcessAuthority {
  // Windows Jobs retain their live handle here; kill-on-close supplies restart
  // containment. POSIX continues to use restart-recoverable SQLite identities.
  private readonly nativeHandles = new Map<object, { id:string; handle: RuntimeProcessHandle; scope: ProviderProcessScope }>();
  constructor(
    private readonly sqlite: Database.Database,
    readonly workerId: string,
  ) {}

  register(handle: RuntimeProcessHandle, scope: ProviderProcessScope, ownerIdentity?: object): void {
    if (process.platform === "win32") {
      for (const [key, owned] of this.nativeHandles) if (!owned.handle.isAlive()) { this.observeExit(owned.id,"os-not-alive"); this.nativeHandles.delete(key); }
      // Readiness and returned Session facades can wrap the same native Job.
      // Only the existing code-owned runtime lifetime may rebind that handle;
      // Agent identity alone never proves that two processes are the same.
      const key = ownerIdentity ?? handle;
      const prior=this.nativeHandles.get(key);
      const retained = prior?.handle ?? handle;
      const id=prior?.id??randomUUID();
      this.nativeHandles.set(key, { id, handle: retained, scope: { ...scope } });
      try { this.registerEvidence(id,{kind:"native-job",lifetimeId:id},scope); }
      catch(error) { void retained.close().catch(()=>undefined); throw error; }
      return;
    }
    const identity = handle.processIdentity;
    if (!identity) {
      if (handle.isAlive()) {
        void handle.close().catch(() => undefined);
        throw new Error("provider process did not expose restart-recoverable POSIX identity");
      }
      return;
    }
    try {
      this.pruneExited();
      this.sqlite.prepare(`
        INSERT INTO provider_process_authority (
          id, worker_id, purpose, project_id, agent_id, run_id,
          pid, pgid, birth_marker, scope_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(worker_id, pid, birth_marker) DO UPDATE SET
          purpose = excluded.purpose,
          project_id = COALESCE(excluded.project_id, provider_process_authority.project_id),
          agent_id = COALESCE(excluded.agent_id, provider_process_authority.agent_id),
          run_id = COALESCE(excluded.run_id, provider_process_authority.run_id),
          scope_json = COALESCE(excluded.scope_json, provider_process_authority.scope_json)
      `).run(
        randomUUID(), this.workerId, scope.purpose,
        scope.projectId ?? null, scope.agentId ?? null, scope.runId ?? null,
        identity.pid, identity.pgid, identity.birthMarker, identity.scope ? JSON.stringify(identity.scope) : null, new Date().toISOString(),
      );
      const row=this.sqlite.prepare("SELECT id FROM provider_process_authority WHERE worker_id=? AND pid=? AND birth_marker=?").get(this.workerId,identity.pid,identity.birthMarker) as {id:string};
      this.registerEvidence(row.id,{kind:"posix",identity},scope);
    } catch (error) {
      // Admission cannot continue without durable restart authority. Begin
      // teardown immediately; the caller's in-memory authority retains the
      // same handle and will also await/retry cleanup on the rejected open.
      void handle.close().catch(() => undefined);
      throw error;
    }
  }

  async recoverPreviousWorkers(): Promise<number> {
    return this.terminateRows(this.rows("worker_id <> ?", [this.workerId]), "daemon restart recovery");
  }

  /** Retry retained diagnostic cleanup before admitting its replacement. */
  async terminatePurpose(purpose: string): Promise<number> {
    return this.terminateScope(this.rows("purpose = ?", [purpose]), scope => scope.purpose === purpose, purpose);
  }

  async terminateRun(runId: string): Promise<number> {
    return this.terminateScope(this.rows("run_id = ?", [runId]), scope => scope.runId === runId, `Run ${runId} cancellation`);
  }

  async terminateAgents(agentIds: ReadonlySet<string>, reason: string): Promise<number> {
    if (agentIds.size === 0) return 0;
    const values = [...agentIds];
    return this.terminateScope(this.rows(
      `agent_id IN (${values.map(() => "?").join(", ")})`, values,
    ), scope => Boolean(scope.agentId && agentIds.has(scope.agentId)), reason);
  }

  async terminateProject(projectId: string, reason: string): Promise<number> {
    return this.terminateScope(this.rows("project_id = ?", [projectId]), scope => scope.projectId === projectId, reason);
  }

  /** Observe exited handles, without termination. The owner drains first and re-reads at seal. */
  readExitEvidence(input:Parameters<typeof readProviderExitEvidence>[1]):ReturnType<typeof readProviderExitEvidence> {
    this.pruneExited();
    return readProviderExitEvidence(this.sqlite,input);
  }

  pruneExited(): number {
    let removed = 0;
    for (const [key, { id,handle }] of this.nativeHandles) if (!handle.isAlive()) { this.observeExit(id,"os-not-alive"); this.nativeHandles.delete(key); removed += 1; }
    for (const row of this.rows()) {
      const handle = this.recover(row);
      if (handle.isAlive()) continue;
      removed += this.observeExit(row.id,"os-not-alive");
    }
    return removed;
  }

  count(scope: { projectId?: string; agentId?: string; runId?: string; purpose?: string } = {}): number {
    const clauses: string[] = [];
    const params: string[] = [];
    if (scope.projectId) { clauses.push("project_id = ?"); params.push(scope.projectId); }
    if (scope.agentId) { clauses.push("agent_id = ?"); params.push(scope.agentId); }
    if (scope.runId) { clauses.push("run_id = ?"); params.push(scope.runId); }
    if (scope.purpose) { clauses.push("purpose = ?"); params.push(scope.purpose); }
    const nativeCount = [...this.nativeHandles.values()].filter(({scope: owned}) =>
      Object.entries(scope).every(([key, value]) => owned[key as keyof ProviderProcessScope] === value)).length;
    return nativeCount + (this.sqlite.prepare(`SELECT COUNT(*) AS count FROM provider_process_authority${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}`)
      .get(...params) as { count: number }).count;
  }

  async terminateDiagnostics(): Promise<void> {
    const purposes = new Set([
      ...this.rows().filter(row => / (authentication|availability) diagnostic$/u.test(row.purpose)).map(row => row.purpose),
      ...[...this.nativeHandles.values()].filter(({scope}) => / (authentication|availability) diagnostic$/u.test(scope.purpose)).map(({scope}) => scope.purpose),
    ]);
    const results = await Promise.allSettled([...purposes].map(purpose => this.terminatePurpose(purpose)));
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Provider diagnostic cleanup remains pending");
  }

  private async terminateScope(rows: readonly ProviderProcessRow[], matches: (scope: ProviderProcessScope) => boolean, reason: string): Promise<number> {
    const results = await Promise.allSettled([
      this.terminateRows(rows, reason),
      ...[...this.nativeHandles].filter(([, {scope}]) => matches(scope)).map(async ([key, {id,handle}]) => {
        await handle.close();
        if (handle.isAlive()) throw new Error(`${reason} did not observe native workload exit`);
        this.observeExit(id,"close-confirmed");
        this.nativeHandles.delete(key);
        return 1;
      }),
    ]);
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, `${reason} left provider process authority pending`);
    return results.reduce((sum, result) => sum + (result.status === "fulfilled" ? result.value : 0), 0);
  }

  private rows(where?: string, params: readonly unknown[] = []): ProviderProcessRow[] {
    return this.sqlite.prepare(`
      SELECT id, worker_id, purpose, project_id, agent_id, run_id,
        pid, pgid, birth_marker, scope_json, created_at
      FROM provider_process_authority
      ${where ? `WHERE ${where}` : ""}
      ORDER BY created_at ASC, id ASC
    `).all(...params) as ProviderProcessRow[];
  }

  private recover(row: ProviderProcessRow): RuntimeProcessHandle {
    const identity: RuntimeProcessIdentity = {
      pid: row.pid,
      pgid: row.pgid,
      birthMarker: row.birth_marker,
      ...(row.scope_json ? { scope: JSON.parse(row.scope_json) } : {}),
    };
    return recoveredRuntimeProcessHandle(identity, {
      label: `${row.purpose} (${row.id})`,
      termGraceMs: 3_000,
      killConfirmationMs: 1_000,
    });
  }

  private async terminateRows(rows: readonly ProviderProcessRow[], reason: string): Promise<number> {
    const failures: Error[] = [];
    let terminated = 0;
    for (const row of rows) {
      try {
        const handle = this.recover(row);
        await handle.close();
        if(handle.isAlive())throw new Error("Provider process still alive after close");
        this.observeExit(row.id,"close-confirmed");
        terminated += 1;
      } catch (error) {
        failures.push(new Error(
          `${reason} could not confirm ${row.purpose} process-group exit: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    }
    if (failures.length) throw new AggregateError(failures, `${reason} left provider process authority pending`);
    return terminated;
  }

  private hash(value:unknown):string { return createHash("sha256").update(stableJson(value)).digest("hex"); }

  private commit(kind:string,identity:string,value:unknown):void {
    const bytes=stableJson(value),sha256=this.hash(value);
    if(Buffer.byteLength(bytes)>4*1024*1024)throw Error("Provider evidence exceeds bound");
    const prior=this.sqlite.prepare("SELECT receipt_json,receipt_sha256 FROM host_lifecycle_commits WHERE kind=? AND identity=?").get(kind,identity) as {receipt_json:string;receipt_sha256:string}|undefined;
    if(prior){if(prior.receipt_json!==bytes||prior.receipt_sha256!==sha256)throw Error("Provider immutable receipt conflict");return;}
    this.sqlite.prepare("INSERT INTO host_lifecycle_commits(kind,identity,input_json,receipt_json,receipt_sha256) VALUES(?,?,?,?,?)").run(kind,identity,bytes,bytes,sha256);
  }

  private registerEvidence(id:string,process:ProviderProcessRegistration['process'],scope:ProviderProcessScope):void {
    if(this.sqlite.prepare("SELECT 1 FROM host_lifecycle_commits WHERE kind='provider-process-exit' AND identity=?").get(id))throw Error("Exited provider lifetime cannot be rebound");
    const agent=scope.agentId?this.sqlite.prepare("SELECT project_id,conversation_id FROM agents WHERE id=?").get(scope.agentId) as {project_id:string;conversation_id:string|null}|undefined:undefined;
    const run=scope.runId?this.sqlite.prepare("SELECT project_id,agent_id,fencing_token FROM scheduler_runs WHERE id=?").get(scope.runId) as {project_id:string;agent_id:string;fencing_token:number}|undefined:undefined;
    // Low-level cleanup may retain an orphan identity. It cannot qualify capture:
    // the reader requires surviving canonical scope and the actual spawn fence.
    if(run&&(run.project_id!==scope.projectId||run.agent_id!==scope.agentId))throw Error("Provider registration Run scope mismatch");
    if(agent&&agent.project_id!==scope.projectId)throw Error("Provider registration Agent scope mismatch");
    if(scope.runFence!==undefined&&(!run||!Number.isSafeInteger(scope.runFence)||scope.runFence<1||scope.runFence>run.fencing_token))throw Error('Provider registration fence mismatch');
    const value:ProviderProcessRegistration={schema:'provider-process-registration.v1',authorityId:id,workerId:this.workerId,process,purpose:scope.purpose,projectId:scope.projectId??null,agentId:scope.agentId??null,conversationId:agent?.conversation_id??null,runId:scope.runId??null,runFence:scope.runFence??null};
    const prior=this.sqlite.prepare("SELECT receipt_json FROM host_lifecycle_commits WHERE kind='provider-process-registration' AND json_extract(receipt_json,'$.authorityId')=? ORDER BY identity LIMIT 4097").all(id) as Array<{receipt_json:string}>;
    if(prior.length>=4096&&!prior.some(row=>row.receipt_json===stableJson(value)))throw Error('Provider lifetime registration bound exceeded');
    for(const row of prior){const old=JSON.parse(row.receipt_json) as ProviderProcessRegistration;
      if(stableJson(old.process)!==stableJson(process)||old.workerId!==this.workerId||old.projectId!==value.projectId||old.agentId!==value.agentId||old.conversationId!==value.conversationId)throw Error('Provider lifetime ownership cannot change');
    }
    this.commit('provider-process-registration',`${id}:${this.hash(value)}`,value);
  }

  // Only callers holding the actual OS/native handle may reach this observation boundary.
  // Archive and authority removal share one savepoint: failed persistence retains the hold.
  private observeExit(id:string,observation:ProviderProcessExitReceipt['observation']):number {
    return this.sqlite.transaction(()=>{
      const prior=this.sqlite.prepare("SELECT receipt_json,receipt_sha256 FROM host_lifecycle_commits WHERE kind='provider-process-exit' AND identity=?").get(id) as {receipt_json:string;receipt_sha256:string}|undefined;
      if(prior){const value=JSON.parse(prior.receipt_json) as ProviderProcessExitReceipt;
        if(this.hash(value)!==prior.receipt_sha256||stableJson(value)!==prior.receipt_json||value.authorityId!==id||value.result!=='observed_exited')throw Error('Retained provider exit integrity failure');
      }
      if(!prior){
        const rows=this.sqlite.prepare("SELECT identity,receipt_json,receipt_sha256 FROM host_lifecycle_commits WHERE kind='provider-process-registration' AND json_extract(receipt_json,'$.authorityId')=? ORDER BY identity LIMIT 4097").all(id) as Array<{identity:string;receipt_json:string;receipt_sha256:string}>;
        if(rows.length>4096)throw Error('Provider lifetime registration bound exceeded');
        const registrations=rows.map(row=>{const registration=JSON.parse(row.receipt_json) as ProviderProcessRegistration;if(this.hash(registration)!==row.receipt_sha256||stableJson(registration)!==row.receipt_json)throw Error('Provider registration integrity failure');return {identity:row.identity,sha256:row.receipt_sha256,registration};});
        // Legacy recovered rows may be drained, but empty coverage cannot qualify capture.
        const receipt:ProviderProcessExitReceipt={schema:'provider-process-exit.v1',operationId:`provider-exit:${id}`,authorityId:id,result:'observed_exited',observation,observedAt:new Date().toISOString(),registrations};
        this.commit('provider-process-exit',id,receipt);
      }
      return this.sqlite.prepare("DELETE FROM provider_process_authority WHERE id=?").run(id).changes;
    })();
  }
}
