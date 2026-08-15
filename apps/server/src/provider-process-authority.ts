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
  created_at: string;
}

export class ProviderProcessAuthority {
  constructor(
    private readonly sqlite: Database.Database,
    readonly workerId: string,
  ) {}

  register(handle: RuntimeProcessHandle, scope: ProviderProcessScope): void {
    if (process.platform === "win32") return;
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
          pid, pgid, birth_marker, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(worker_id, pid, birth_marker) DO UPDATE SET
          purpose = excluded.purpose,
          project_id = COALESCE(excluded.project_id, provider_process_authority.project_id),
          agent_id = COALESCE(excluded.agent_id, provider_process_authority.agent_id),
          run_id = COALESCE(excluded.run_id, provider_process_authority.run_id)
      `).run(
        randomUUID(), this.workerId, scope.purpose,
        scope.projectId ?? null, scope.agentId ?? null, scope.runId ?? null,
        identity.pid, identity.pgid, identity.birthMarker, new Date().toISOString(),
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

  async terminateRun(runId: string): Promise<number> {
    return this.terminateRows(this.rows("run_id = ?", [runId]), `Run ${runId} cancellation`);
  }

  async terminateAgents(agentIds: ReadonlySet<string>, reason: string): Promise<number> {
    if (agentIds.size === 0) return 0;
    const values = [...agentIds];
    return this.terminateRows(this.rows(
      `agent_id IN (${values.map(() => "?").join(", ")})`, values,
    ), reason);
  }

  async terminateProject(projectId: string, reason: string): Promise<number> {
    return this.terminateRows(this.rows("project_id = ?", [projectId]), reason);
  }

  pruneExited(): number {
    let removed = 0;
    for (const row of this.rows()) {
      const handle = this.recover(row);
      if (handle.isAlive()) continue;
      removed += this.deleteRow(row.id);
    }
    return removed;
  }

  count(scope: { projectId?: string; agentId?: string; runId?: string } = {}): number {
    const clauses: string[] = [];
    const params: string[] = [];
    if (scope.projectId) { clauses.push("project_id = ?"); params.push(scope.projectId); }
    if (scope.agentId) { clauses.push("agent_id = ?"); params.push(scope.agentId); }
    if (scope.runId) { clauses.push("run_id = ?"); params.push(scope.runId); }
    return (this.sqlite.prepare(`SELECT COUNT(*) AS count FROM provider_process_authority${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}`)
      .get(...params) as { count: number }).count;
  }

  private rows(where?: string, params: readonly unknown[] = []): ProviderProcessRow[] {
    return this.sqlite.prepare(`
      SELECT id, worker_id, purpose, project_id, agent_id, run_id,
        pid, pgid, birth_marker, created_at
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
      const handle = this.recover(row);
      try {
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
