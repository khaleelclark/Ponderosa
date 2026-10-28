import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { RuntimeProcessHandle, RuntimeProcessIdentity } from "@ponderosa/core";
import { recoveredRuntimeProcessHandle } from "@ponderosa/engines";

export interface ProviderProcessScope {
  purpose: string;
  projectId?: string;
  agentId?: string;
  runId?: string;
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
  private readonly nativeHandles = new Map<object, { handle: RuntimeProcessHandle; scope: ProviderProcessScope }>();
  constructor(
    private readonly sqlite: Database.Database,
    readonly workerId: string,
  ) {}

  register(handle: RuntimeProcessHandle, scope: ProviderProcessScope, ownerIdentity?: object): void {
    if (process.platform === "win32") {
      for (const [key, {handle: owned}] of this.nativeHandles) if (!owned.isAlive()) this.nativeHandles.delete(key);
      // Readiness and returned Session facades can wrap the same native Job.
      // Only the existing code-owned runtime lifetime may rebind that handle;
      // Agent identity alone never proves that two processes are the same.
      const key = ownerIdentity ?? handle;
      const retained = this.nativeHandles.get(key)?.handle ?? handle;
      this.nativeHandles.set(key, { handle: retained, scope: { ...scope } });
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

  pruneExited(): number {
    let removed = 0;
    for (const [key, { handle }] of this.nativeHandles) if (!handle.isAlive()) { this.nativeHandles.delete(key); removed += 1; }
    for (const row of this.rows()) {
      const handle = this.recover(row);
      if (handle.isAlive()) continue;
      removed += this.deleteRow(row.id);
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
      ...[...this.nativeHandles].filter(([, {scope}]) => matches(scope)).map(async ([key, {handle}]) => {
        await handle.close();
        if (handle.isAlive()) throw new Error(`${reason} did not observe native workload exit`);
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
        this.deleteRow(row.id);
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

  private deleteRow(id: string): number {
    return this.sqlite.prepare("DELETE FROM provider_process_authority WHERE id = ?").run(id).changes;
  }
}
