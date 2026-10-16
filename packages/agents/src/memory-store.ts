import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  normalizeCanonicalText, unicodeCodePointLength, INLINE_TEXT_MAX_CODE_POINTS,
  type MemoryAuthor, type MemoryCommandReceipt, type MemoryDto, type MemoryRevisionDto,
  type MemoryScope, type MemorySourceClassification, type MemorySourceReference,
} from "@ponderosa/core";
import { payloadHash } from "./coordination-v3-canonical-json.js";

/** INTERNAL host port. Never deserialize this from a model/tool/request body.
 * resolve() must validate live authority (including Run fence) synchronously,
 * using the SAME SQLite connection. No identity/grant implementation is implied.
 */
export interface TrustedMemoryContext {
  actor: MemoryAuthor;
  projectId?: string;
  globalPrincipalId?: string;
  read: boolean;
  writeProject: boolean;
  writeGlobal: boolean;
  /** Checks canonical provenance AND whether sharing text expands its audience.
   * Must also verify a user source for agent-authored user_statement revisions. */
  maySaveSource(scope: MemoryScope, source: MemorySourceReference, classification: MemorySourceClassification): boolean;
  /** Link authorization is independent from permission to read memory text. */
  mayReadSource(source: MemorySourceReference): boolean;
}
export interface MemoryRevisionInput {
  text: string;
  classification: MemorySourceClassification;
  sources?: readonly MemorySourceReference[];
  expiresAt?: string;
}
interface Row {
  id: string; scope: "global" | "project"; owner_id: string;
  current_revision: number; generation: number; lifecycle: string; updated_at: string;
  text: string; text_hash: string; author_json: string; classification: MemorySourceClassification;
  sources_json: string; created_at: string; expires_at: string | null; prior_revision: number | null;
}
const currentSql = `SELECT m.*,r.text,r.text_hash,r.author_json,r.classification,r.sources_json,
  r.created_at,r.expires_at,r.prior_revision FROM memories m JOIN memory_revisions r
  ON r.memory_id=m.id AND r.revision=m.current_revision`;
export class MemoryNotFoundError extends Error { constructor() { super("Memory not found"); } }
export class MemoryRevisionConflictError extends Error { constructor() { super("Memory revision changed"); } }
export class MemoryCommandConflictError extends Error { constructor() { super("Memory command payload changed"); } }

function boundedId(value: string): string {
  if (typeof value !== "string" || !value || value.length > 256 || /[\u0000-\u001f]/u.test(value)) throw new Error("Invalid memory identifier");
  return value;
}
function owner(scope: MemoryScope): string { return scope.kind === "project" ? scope.projectId : scope.principalId; }
function scopeOf(row: Pick<Row, "scope" | "owner_id">): MemoryScope {
  return row.scope === "project" ? { kind: "project", projectId: row.owner_id } : { kind: "global", principalId: row.owner_id };
}
function revisionNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid memory revision");
  return value;
}

export class MemoryStore {
  constructor(
    readonly sqlite: Database.Database,
    private readonly resolve: () => TrustedMemoryContext,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  private context(): TrustedMemoryContext {
    const resolved = this.resolve();
    const context = { ...resolved, actor: { ...resolved.actor } };
    boundedId(context.actor.id);
    if (context.actor.kind !== "agent" && context.actor.kind !== "operator") throw new Error("Invalid memory author");
    if (context.actor.agentId) boundedId(context.actor.agentId);
    if (context.actor.runId) boundedId(context.actor.runId);
    if (context.projectId) boundedId(context.projectId);
    if (context.globalPrincipalId) boundedId(context.globalPrincipalId);
    return context;
  }
  private projectLive(id: string): boolean {
    return !!this.sqlite.prepare(`SELECT 1 FROM projects WHERE id=?
      AND NOT EXISTS(SELECT 1 FROM project_deletion_pending WHERE project_id=?)
      AND NOT EXISTS(SELECT 1 FROM project_deletion_receipts WHERE project_id=?)`).get(id, id, id);
  }
  private allowed(c: TrustedMemoryContext, scope: MemoryScope, write = false): boolean {
    return scope.kind === "project"
      ? scope.projectId === c.projectId && this.projectLive(scope.projectId) && (write ? c.writeProject : c.read)
      : scope.principalId === c.globalPrincipalId && (write ? c.writeGlobal : c.read);
  }
  private row(c: TrustedMemoryContext, id: string, write = false, allowForgotten = false): Row | undefined {
    // Owner filtering precedes loading revision text; inaccessible IDs reveal no metadata.
    const m = this.sqlite.prepare("SELECT scope,owner_id FROM memories WHERE id=?").get(boundedId(id)) as Pick<Row, "scope" | "owner_id"> | undefined;
    if (!m || !this.allowed(c, scopeOf(m), write)) return undefined;
    const row = this.sqlite.prepare(`${currentSql} WHERE m.id=?`).get(id) as Row | undefined;
    if (!row) return undefined;
    if (row.lifecycle === "active" && this.sqlite.prepare("SELECT 1 FROM memory_tombstones WHERE memory_id=?").get(id)) return undefined;
    if (!allowForgotten && (row.lifecycle !== "active" || (row.expires_at && row.expires_at <= this.clock()))) return undefined;
    return row;
  }
  private dto(c: TrustedMemoryContext, row: Row): MemoryDto {
    const sources = JSON.parse(row.sources_json) as MemorySourceReference[];
    return {
      memoryId: row.id, revision: row.current_revision, generation: row.generation,
      scope: scopeOf(row), text: row.text, textHash: row.text_hash,
      author: JSON.parse(row.author_json) as MemoryAuthor, classification: row.classification,
      sourceBacked: sources.length > 0,
      sources: sources.filter(source => c.mayReadSource(source)), createdAt: row.created_at,
      updatedAt: row.updated_at, lexicalIndex: "transactional",
      ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
      ...(row.prior_revision ? { priorRevision: row.prior_revision } : {}),
    };
  }
  get(id: string): MemoryDto | undefined {
    return this.sqlite.transaction(() => {
      const c = this.context(); const row = this.row(c, id);
      return row ? this.dto(c, row) : undefined;
    })();
  }
  /** External candidate hydration rejects old revision/generation and revoked scope.
   * Scores from an index are relevance only and never factual confidence. */
  hydrate(candidates: readonly { memoryId: string; revision: number; generation: number }[]): MemoryDto[] {
    return this.sqlite.transaction(() => {
      const c = this.context(); const seen = new Set<string>(); const result: MemoryDto[] = [];
      for (const candidate of candidates.slice(0, 100)) {
        if (seen.has(candidate.memoryId)) continue;
        const row = this.row(c, candidate.memoryId);
        if (!row || row.current_revision !== candidate.revision || row.generation !== candidate.generation) continue;
        seen.add(row.id); result.push(this.dto(c, row));
      }
      return result;
    })();
  }
  private scopes(c: TrustedMemoryContext): MemoryScope[] {
    return [
      ...(c.projectId ? [{ kind: "project" as const, projectId: c.projectId }] : []),
      ...(c.globalPrincipalId ? [{ kind: "global" as const, principalId: c.globalPrincipalId }] : []),
    ].filter(scope => this.allowed(c, scope));
  }
  private limit(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid memory limit");
    return Math.min(value, 100);
  }
  list(limit = 20): MemoryDto[] { return this.find(undefined, limit); }
  search(query: string, limit = 20): MemoryDto[] {
    if (typeof query !== "string" || unicodeCodePointLength(query) > INLINE_TEXT_MAX_CODE_POINTS) throw new Error("Invalid memory query");
    // FTS grammar is not accepted from callers; quote bounded lexical terms.
    const words = normalizeCanonicalText(query).match(/[\p{L}\p{N}_]+/gu)?.slice(0, 32) ?? [];
    if (!words.length) return this.sqlite.transaction(() => { this.context(); return []; })();
    return this.find(words.map(word => `"${word}"`).join(" OR "), limit);
  }
  private find(match: string | undefined, limit: number): MemoryDto[] {
    const maximum = this.limit(limit);
    return this.sqlite.transaction(() => {
      const c = this.context(); const scopes = this.scopes(c); if (!scopes.length) return [];
      const predicate = scopes.map(() => "(m.scope=? AND m.owner_id=?)").join(" OR ");
      const args = scopes.flatMap(scope => [scope.kind, owner(scope)]);
      // Canonical current revision and expiry win even if FTS was stale/restored.
      const rows = this.sqlite.prepare(`${currentSql}
        ${match ? "JOIN memory_fts ON memory_fts.memory_id=m.id AND CAST(memory_fts.revision AS INTEGER)=m.current_revision" : ""}
        WHERE (${predicate}) AND m.lifecycle='active' AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.memory_id=m.id) AND (r.expires_at IS NULL OR r.expires_at>?)
        ${match ? "AND memory_fts MATCH ?" : ""}
        ORDER BY ${match ? "bm25(memory_fts)," : ""} m.updated_at DESC,m.id LIMIT ?`)
        .all(...args, this.clock(), ...(match ? [match] : []), maximum) as Row[];
      return rows.map(row => this.dto(c, row));
    })();
  }
  history(id: string, limit = 20): MemoryRevisionDto[] {
    const maximum = this.limit(limit);
    return this.sqlite.transaction(() => {
      const c = this.context(); const row = this.row(c, id); if (!row) return [];
      const revisions = this.sqlite.prepare(`SELECT * FROM memory_revisions WHERE memory_id=?
        AND (expires_at IS NULL OR expires_at>?) ORDER BY revision DESC LIMIT ?`).all(id, this.clock(), maximum) as Array<Row & { revision: number }>;
      return revisions.map(revision => {
        const { scope: _scope, generation: _generation, updatedAt: _updatedAt, lexicalIndex: _index, ...dto } =
          this.dto(c, { ...row, ...revision, current_revision: revision.revision });
        return dto;
      });
    })();
  }
  generation(scope: MemoryScope): number | undefined {
    const c = this.context(); if (!this.allowed(c, scope)) return undefined;
    return (this.sqlite.prepare("SELECT generation FROM memory_scope_generations WHERE scope=? AND owner_id=?")
      .get(scope.kind, owner(scope)) as { generation: number } | undefined)?.generation ?? 0;
  }
  /** Current authorized scope generations, including empty scopes. */
  scopeGenerations(): Array<{ scope: MemoryScope; generation: number }> {
    return this.sqlite.transaction(() => {
      const c = this.context();
      return this.scopes(c).map(scope => ({ scope, generation: this.generation(scope)! }));
    })();
  }
  private nextGeneration(scope: MemoryScope): number {
    return (this.sqlite.prepare(`INSERT INTO memory_scope_generations VALUES(?,?,1)
      ON CONFLICT(scope,owner_id) DO UPDATE SET generation=generation+1 RETURNING generation`)
      .get(scope.kind, owner(scope)) as { generation: number }).generation;
  }
  private content(c: TrustedMemoryContext, scope: MemoryScope, input: MemoryRevisionInput): MemoryRevisionInput & { sources: MemorySourceReference[] } {
    if (typeof input.text !== "string") throw new Error("Memory text required");
    const text = normalizeCanonicalText(input.text);
    if (!text.trim() || unicodeCodePointLength(text) > INLINE_TEXT_MAX_CODE_POINTS || text.includes("\u0000")) throw new Error("Invalid memory text");
    if (input.classification !== "user_statement" && input.classification !== "agent_inference") throw new Error("Invalid memory classification");
    const sources = input.sources ?? [];
    if (!Array.isArray(sources) || sources.length > 20) throw new Error("Invalid memory sources");
    const checked = sources.map(source => {
      if (source.kind !== "communication" && source.kind !== "artifact") throw new Error("Invalid memory source kind");
      const ref = { kind: source.kind, id: boundedId(source.id), revision: boundedId(source.revision), sha256: source.sha256 };
      if (!/^[a-f0-9]{64}$/u.test(ref.sha256) || !c.maySaveSource(scope, ref, input.classification)) throw new Error("Memory source not authorized for destination");
      return ref;
    });
    if (input.classification === "user_statement" && c.actor.kind !== "operator" && !checked.length) throw new Error("User statement requires verified source");
    let expiresAt: string | undefined;
    if (input.expiresAt !== undefined) {
      const timestamp = Date.parse(input.expiresAt);
      if (!Number.isFinite(timestamp)) throw new Error("Invalid memory expiry");
      expiresAt = new Date(timestamp).toISOString();
      // Retries are hashed identically even after their originally future expiry.
    }
    return { text, classification: input.classification, sources: checked, ...(expiresAt ? { expiresAt } : {}) };
  }
  private command(c: TrustedMemoryContext, scope: MemoryScope, key: string, input: unknown, apply: () => MemoryCommandReceipt): MemoryCommandReceipt {
    boundedId(key); const hash = payloadHash(input);
    const prior = this.sqlite.prepare(`SELECT input_hash,result_json,memory_id FROM memory_commands
      WHERE scope=? AND owner_id=? AND actor_id=? AND command_key=?`)
      .get(scope.kind, owner(scope), `${c.actor.kind}:${c.actor.id}`, key) as { input_hash: string; result_json: string; memory_id: string } | undefined;
    if (prior) {
      if (prior.input_hash !== hash) throw new MemoryCommandConflictError();
      // Receipts contain no text. Current scope and write authority still win.
      if (!this.row(c, prior.memory_id, true, true)) throw new MemoryNotFoundError();
      return JSON.parse(prior.result_json) as MemoryCommandReceipt;
    }
    const result = apply();
    this.sqlite.prepare("INSERT INTO memory_commands VALUES(?,?,?,?,?,?,?)")
      .run(scope.kind, owner(scope), `${c.actor.kind}:${c.actor.id}`, key, hash, result.memoryId, JSON.stringify(result));
    return result;
  }
  private index(id: string, revision: number, generation: number, action: "upsert" | "remove", now: string, text?: string): void {
    this.sqlite.prepare("DELETE FROM memory_fts WHERE memory_id=?").run(id);
    if (action === "upsert") this.sqlite.prepare("INSERT INTO memory_fts(memory_id,revision,text) VALUES(?,?,?)").run(id, revision, text!);
    this.sqlite.prepare("INSERT INTO memory_index_intents VALUES(?,?,?,?,?)").run(id, generation, revision, action, now);
  }
  private insertRevision(id: string, revision: number, c: TrustedMemoryContext, input: MemoryRevisionInput, now: string): void {
    this.sqlite.prepare("INSERT INTO memory_revisions VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(id, revision, input.text, createHash("sha256").update(input.text).digest("hex"), JSON.stringify(c.actor), input.classification,
        JSON.stringify(input.sources), now, input.expiresAt ?? null, revision > 1 ? revision - 1 : null);
  }
  save(input: MemoryRevisionInput & { commandKey: string; scope?: "project" | "global"; promotionSource?: { memoryId: string; revision: number; textHash: string } }): MemoryCommandReceipt {
    return this.sqlite.transaction(() => {
      const c = this.context();
      if (input.scope !== undefined && input.scope !== "project" && input.scope !== "global") throw new Error("Invalid memory scope");
      const scope: MemoryScope = input.scope === "global"
        ? { kind: "global", principalId: c.globalPrincipalId ?? "" } : { kind: "project", projectId: c.projectId ?? "" };
      if (!this.allowed(c, scope, true) || !owner(scope)) throw new MemoryNotFoundError();
      if (input.promotionSource) {
        if (c.actor.kind !== "operator" || scope.kind !== "global") throw new Error("Invalid memory promotion authority");
        boundedId(input.promotionSource.memoryId); revisionNumber(input.promotionSource.revision);
        if (!/^[a-f0-9]{64}$/u.test(input.promotionSource.textHash)) throw new Error("Invalid memory promotion hash");
      }
      const content = this.content(c, scope, input);
      return this.command(c, scope, input.commandKey, { operation: "save", content, ...(input.promotionSource ? { promotionSource: input.promotionSource } : {}) }, () => {
        const now = this.clock(); if (content.expiresAt && content.expiresAt <= now) throw new Error("Memory expiry must be in future");
        const id = randomUUID(); const generation = this.nextGeneration(scope);
        this.sqlite.prepare("INSERT INTO memories VALUES(?,?,?,?,?,'active',?,?,NULL)").run(id, scope.kind, owner(scope), 1, generation, now, now);
        this.insertRevision(id, 1, c, content, now); this.index(id, 1, generation, "upsert", now, content.text);
        return { memoryId: id, revision: 1, generation, operation: "save" };
      });
    }).immediate();
  }
  update(id: string, expectedRevision: number, input: MemoryRevisionInput & { commandKey: string }): MemoryCommandReceipt {
    revisionNumber(expectedRevision);
    return this.sqlite.transaction(() => {
      const c = this.context(); const row = this.row(c, id, true, true); if (!row) throw new MemoryNotFoundError();
      const scope = scopeOf(row); const content = this.content(c, scope, input);
      return this.command(c, scope, input.commandKey, { operation: "update", id, expectedRevision, content }, () => {
        if (row.lifecycle !== "active" || (row.expires_at && row.expires_at <= this.clock())) throw new MemoryNotFoundError();
        if (row.current_revision !== expectedRevision) throw new MemoryRevisionConflictError();
        const now = this.clock(); if (content.expiresAt && content.expiresAt <= now) throw new Error("Memory expiry must be in future");
        const revision = expectedRevision + 1; const generation = this.nextGeneration(scope);
        this.sqlite.prepare("UPDATE memories SET current_revision=?,generation=?,updated_at=? WHERE id=?").run(revision, generation, now, id);
        this.insertRevision(id, revision, c, content, now); this.index(id, revision, generation, "upsert", now, content.text);
        return { memoryId: id, revision, generation, operation: "update" };
      });
    }).immediate();
  }
  forget(id: string, expectedRevision: number, commandKey: string): MemoryCommandReceipt {
    revisionNumber(expectedRevision);
    return this.sqlite.transaction(() => {
      const c = this.context(); const row = this.row(c, id, true, true); if (!row) throw new MemoryNotFoundError();
      const scope = scopeOf(row);
      return this.command(c, scope, commandKey, { operation: "forget", id, expectedRevision }, () => {
        if (row.lifecycle !== "active") throw new MemoryNotFoundError();
        if (row.current_revision !== expectedRevision) throw new MemoryRevisionConflictError();
        const now = this.clock(); const generation = this.nextGeneration(scope);
        this.sqlite.prepare("UPDATE memories SET lifecycle='forgotten',generation=?,forgotten_at=?,updated_at=? WHERE id=?").run(generation, now, now, id);
        this.sqlite.prepare("INSERT INTO memory_tombstones VALUES(?,?,?,?,?,'forgotten')").run(id, scope.kind, owner(scope), generation, now);
        this.index(id, row.current_revision, generation, "remove", now);
        return { memoryId: id, revision: row.current_revision, generation, operation: "forget" };
      });
    }).immediate();
  }
}

/** Called inside the existing Project purge transaction, even with memory off.
 * Purge content/receipts, retaining minimal tombstones, generations and removals. */
export function purgeProjectMemories(sqlite: Database.Database, projectId: string, now: string): void {
  sqlite.prepare("UPDATE memory_global_grants SET enabled=0,revision=revision+1,updated_at=? WHERE project_id=? AND enabled=1").run(now, projectId);
  const rows = sqlite.prepare("SELECT id,current_revision FROM memories WHERE scope='project' AND owner_id=?").all(projectId) as Array<{ id: string; current_revision: number }>;
  if (!rows.length) return;
  const generation = (sqlite.prepare(`INSERT INTO memory_scope_generations VALUES('project',?,1)
    ON CONFLICT(scope,owner_id) DO UPDATE SET generation=generation+1 RETURNING generation`).get(projectId) as { generation: number }).generation;
  for (const row of rows) {
    sqlite.prepare(`INSERT INTO memory_tombstones VALUES(?,'project',?,?,?,'project_deleted')
      ON CONFLICT(memory_id) DO UPDATE SET generation=excluded.generation,deleted_at=excluded.deleted_at,reason=excluded.reason`)
      .run(row.id, projectId, generation, now);
    sqlite.prepare("DELETE FROM memory_fts WHERE memory_id=?").run(row.id);
    sqlite.prepare("DELETE FROM memory_index_intents WHERE memory_id=?").run(row.id);
    sqlite.prepare("INSERT INTO memory_index_intents VALUES(?,?,?,'remove',?)").run(row.id, generation, row.current_revision, now);
    sqlite.prepare("DELETE FROM memory_revisions WHERE memory_id=?").run(row.id);
  }
  sqlite.prepare("DELETE FROM memory_commands WHERE scope='project' AND owner_id=?").run(projectId);
  sqlite.prepare("DELETE FROM memories WHERE scope='project' AND owner_id=?").run(projectId);
}

/** Internal maintenance only, never a provider tool. Rebuild lexical rows from
 * canonical revisions; no authority or deletion state is inferred from FTS. */
export function rebuildMemoryLexicalIndex(sqlite: Database.Database, now = new Date().toISOString()): void {
  sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM memory_fts").run();
    sqlite.prepare(`INSERT INTO memory_fts(memory_id,revision,text)
      SELECT m.id,m.current_revision,r.text FROM memories m JOIN memory_revisions r
      ON r.memory_id=m.id AND r.revision=m.current_revision
      WHERE m.lifecycle='active' AND (r.expires_at IS NULL OR r.expires_at>?)
      AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.memory_id=m.id)
      AND (m.scope='global' OR EXISTS(SELECT 1 FROM projects p WHERE p.id=m.owner_id
        AND NOT EXISTS(SELECT 1 FROM project_deletion_pending WHERE project_id=p.id)
        AND NOT EXISTS(SELECT 1 FROM project_deletion_receipts WHERE project_id=p.id)))`).run(now);
  }).immediate();
}
