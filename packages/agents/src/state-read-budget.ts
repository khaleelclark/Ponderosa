import type Database from "better-sqlite3";

// Shared ordinary/offline read accounting. No converter, native host, new
// database, profile cache, or caller admission witness belongs in this module.
// Canonical schema with pause receipts has 513 objects; retain a fixed metadata bound.
export const STATE_READ_LIMITS = Object.freeze({ rows: 16_000_000, objects: 528,
  columns: 256, metadataBytes: 1024 ** 2, rowBytes: 64 * 1024 ** 2 });
const fail: (code: string) => never = code => { throw new Error(`bounded state read refused (${code})`); };
export const stateQuote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
export type Bind = string | number | bigint | Buffer | null;
export class StateReadBudget {
  #rows = 0;
  #bytes = 0;
  constructor(private storage?: { charge(bytes: number): void }) {}
  /** Bind invocation storage once, charging already reserved fixed setup bytes.
   * No counter reset/refund; this cost sink supplies no admission authority. */
  bindStorage(storage: { charge(bytes: number): void }): void {
    if (this.storage && this.storage !== storage) fail("storage-rebind");
    if (this.storage) return;
    try { storage.charge(this.#bytes); } catch (error) { this.exhausted = true; throw error; }
    this.storage = storage;
  }
  get bytes(): number { return this.#bytes; }
  allocate(bytes: number): void {
    // Existing offline invocation byte ceiling; no failed allocation refunds.
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 1024 ** 4 - this.#bytes) { this.exhausted = true; fail("allocation"); }
    this.#bytes += bytes;
    try { this.storage?.charge(bytes); } catch (error) { this.exhausted = true; throw error; }
  }
  get rows(): number { return this.#rows; }
  exhausted = false;
  // Reservations survive prepare/query/iteration exceptions; only successful
  // bounded scalar discovery settles its unused allowance. No failed refund.
  reserve(rows: number): void {
    if (!Number.isSafeInteger(rows) || rows < 0 || rows > STATE_READ_LIMITS.rows - this.rows) {
      this.exhausted = true; fail("work");
    }
    this.#rows += rows;
  }
  discoverPopulation(read: (limit: number) => number, unitsPerRow = 1): number {
    if (!Number.isSafeInteger(unitsPerRow) || unitsPerRow < 1) fail("population-unit-cost");
    const allowance = Math.floor((STATE_READ_LIMITS.rows - this.#rows) / unitsPerRow);
    if (allowance < 2) { this.exhausted = true; fail("population-work"); }
    this.reserve(allowance * unitsPerRow);
    const n = read(allowance - 1);
    if (!Number.isSafeInteger(n) || n < 0 || n >= allowance - 1) { this.exhausted = true; fail("population-work"); }
    this.#rows -= (allowance - (n + 1)) * unitsPerRow; // successful, complete scalar only
    return n;
  }
  statement(sql: string, parameters: readonly Bind[]): void {
    if (Buffer.byteLength(sql) > STATE_READ_LIMITS.metadataBytes || parameters.length > STATE_READ_LIMITS.columns ||
        parameters.reduce<number>((n, value) => n + (typeof value === "string" ? Buffer.byteLength(value) : Buffer.isBuffer(value) ? value.length : 16), 0) > STATE_READ_LIMITS.metadataBytes) fail("prepare-bindings");
    // Preparation and each binding are work too, even for empty populations.
    this.allocate(2 * Buffer.byteLength(sql) + 64 * (1 + parameters.length) + parameters.reduce<number>((n, value) => n + (typeof value === "string" ? 2 * Buffer.byteLength(value) : Buffer.isBuffer(value) ? value.length : 16), 0));
    this.reserve(1 + parameters.length);
  }
}
const budgets = new WeakMap<Database.Database, StateReadBudget>();
const scopes = new WeakMap<Database.Database, StateReads>();
let invocation: StateReadBudget | undefined;
export const currentStateReadInvocation = (): StateReadBudget | undefined => invocation;
/** Accounting context only: never schema, admission or publication authority. */
export function withStateReadInvocation<T>(budget: StateReadBudget, action: () => T): T {
  if (invocation && invocation !== budget) fail("foreign-invocation");
  const previous = invocation; invocation = budget;
  try { return action(); } finally { invocation = previous; }
}
export function bindStateReadBudget(db: Database.Database, budget: StateReadBudget): void {
  const previous = budgets.get(db);
  if ((previous && previous !== budget) || scopes.has(db)) fail("budget-rebind");
  budgets.set(db, budget);
}
export function stateReadBudget(db: Database.Database): StateReadBudget {
  const selected = scopes.get(db)?.budget ?? budgets.get(db) ?? invocation ?? new StateReadBudget();
  if (invocation && invocation !== selected) fail("foreign-invocation-handle");
  if (invocation) budgets.set(db, selected);
  return selected;
}
/** Lazy consumers retain their internally owned snapshot through iterator close,
 * including early break/errors. No iterator/population cache is constructed. */
export function* iterateStateReads<T>(db: Database.Database, action: (reads: StateReads) => Iterable<T>): Generator<T> {
  const active = scopes.get(db);
  if (active) { yield* action(active); return; }
  if (db.inTransaction) fail("foreign-transaction");
  const budget = stateReadBudget(db); budget.allocate(512);
  const reads = new StateReads(db, budget);
  reads.budget.reserve(2); db.exec("BEGIN"); scopes.set(db, reads);
  let complete = false;
  try { yield* action(reads); complete = true; }
  finally { scopes.delete(db); db.exec(complete ? "COMMIT" : "ROLLBACK"); }
}
/** All measurement and consumption are in the same internally owned snapshot.
 * Nested helpers reuse this scope. A foreign transaction is never a witness. */
export function withStateReads<T>(db: Database.Database, action: (reads: StateReads) => T, budget?: StateReadBudget): T {
  const active = scopes.get(db);
  if (active) {
    if (budget && budget !== active.budget) fail("foreign-budget");
    return action(active);
  }
  if (db.inTransaction) fail("foreign-transaction");
  const selected = budgets.get(db) ?? budget ?? invocation ?? new StateReadBudget();
  if (budget && budget !== selected) fail("foreign-budget");
  if (invocation) budgets.set(db, selected);
  if (invocation && invocation !== selected) fail("foreign-invocation-handle");
  selected.allocate(512);
  const reads = new StateReads(db, selected);
  selected.reserve(2);
  return db.transaction(() => {
    scopes.set(db, reads);
    try { return action(reads); } finally { scopes.delete(db); }
  })();
}
export class StateReads {
  constructor(readonly db: Database.Database, readonly budget: StateReadBudget) {}
  scalar(sql: string, scanned: number, parameters: readonly Bind[] = []): Record<string, number> {
    this.budget.statement(sql, parameters); this.budget.reserve(scanned + 1);
    this.budget.allocate(STATE_READ_LIMITS.metadataBytes);
    const result = this.db.prepare(sql).safeIntegers().get(...parameters) as Record<string, unknown> | undefined;
    if (!result) fail("scalar");
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === "bigint") {
        if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail("scalar");
        result[key] = Number(value);
      } else if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("scalar");
    }
    return result as Record<string, number>;
  }
  /** Discover an unknown population through a bounded prefix. Equality with
   * remaining allowance refuses: completeness was not observed. */
  population(from: string): number {
    const sql = `SELECT count(*) n FROM (SELECT 1 FROM ${from} LIMIT ?)`;
    this.budget.statement(sql, [0]); this.budget.allocate(1024);
    return this.budget.discoverPopulation(limit => {
      const value = (this.db.prepare(sql).safeIntegers().get(limit) as { n: bigint }).n;
      if (typeof value !== "bigint" || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail("population-scalar");
      return Number(value);
    });
  }
  /** SQL measures bytes in the owned snapshot before returning cells to JS.
   * Proven ASCII (printable plus tab/CR/LF) needs at most two bytes per byte
   * for either UTF-16 storage or JSON escaping. Other TEXT/BLOB retains the
   * six-byte envelope, including malformed encodings and control characters.
   * Field names are internally supplied JS strings with exact JSON framing. */
  measure(sql: string, fields: readonly string[], maxRows: number, maxBytes: number, scanned: number, parameters: readonly Bind[] = []): { n: number; bytes: number } {
    if (fields.length > STATE_READ_LIMITS.columns || maxBytes > STATE_READ_LIMITS.rowBytes) fail("measurement-shape");
    const expressionBytes = 8 * Buffer.byteLength(sql) + 1024 * fields.length + 64 * fields.reduce((n, field) => n + Buffer.byteLength(field), 0);
    if (expressionBytes > STATE_READ_LIMITS.metadataBytes) fail("measurement-sql-bytes");
    this.budget.allocate(expressionBytes);
    const rawBytes = fields.map(field => `coalesce(length(CAST(${stateQuote(field)} AS BLOB)),0)`).join("+") || "0";
    const raw = this.scalar(`SELECT coalesce(sum(${rawBytes}),0) bytes FROM (${sql})`, scanned, parameters).bytes;
    if (raw === undefined || raw > maxBytes) fail("returned-values");
    // Charge the complete byte scan before testing ASCII or escaping any key.
    this.budget.reserve(2 * raw);
    const bytes = fields.map(field => {
      const q = stateQuote(field);
      const length = `coalesce(length(CAST(${q} AS BLOB)),0)`;
      const ascii = `length(${q})=${length} AND ${q} NOT GLOB '*[^ -~\t\r\n]*'`;
      return `(CASE typeof(${q}) WHEN 'null' THEN 4 WHEN 'integer' THEN length(CAST(${q} AS TEXT))+4 WHEN 'real' THEN 32 WHEN 'text' THEN (CASE WHEN ${ascii} THEN 2 ELSE 6 END)*${length}+32 ELSE 6*${length}+32 END)+${2 + Buffer.byteLength(JSON.stringify(field))}`;
    }).join("+") || "16";
    const result = this.scalar(`SELECT count(*) n, coalesce(sum(${bytes}),0) bytes FROM (${sql})`, scanned, parameters);
    if (result.n! > maxRows || result.bytes! > maxBytes) fail("returned-values");
    return result as { n: number; bytes: number };
  }
  each<T>(sql: string, fields: readonly string[], maxRows: number, maxBytes: number, scanned: number, visit: (row: T) => void, parameters: readonly Bind[] = [], reserve?: (bytes: number) => void): void {
    const size = this.measure(sql, fields, maxRows, maxBytes, scanned, parameters);
    this.budget.allocate(size.bytes + 2 + size.n);
    reserve?.(size.bytes + 2 + size.n); // BEFORE row materialization or array append.
    this.budget.statement(sql, parameters); this.budget.reserve(scanned + size.n);
    let n = 0;
    for (const row of this.db.prepare(sql).safeIntegers(false).iterate(...parameters) as Iterable<T>) { visit(row); n++; }
    if (n !== size.n) fail("snapshot-cardinality");
  }
  *iterate<T>(sql: string, fields: readonly string[], maxRows: number, maxRowBytes: number, scanned: number,
      parameters: readonly Bind[] = [], raw = false): Generator<T> {
    if (fields.length > STATE_READ_LIMITS.columns || maxRowBytes > STATE_READ_LIMITS.rowBytes) fail("stream-shape");
    const expressionBytes = 8 * Buffer.byteLength(sql) + 1024 * fields.length + 64 * fields.reduce((n, field) => n + Buffer.byteLength(field), 0);
    if (expressionBytes > STATE_READ_LIMITS.metadataBytes) fail("measurement-sql-bytes");
    this.budget.allocate(expressionBytes);
    const bytes = fields.map(field => `coalesce(length(CAST(${stateQuote(field)} AS BLOB)),0)+16`).join("+") || "16";
    const size = this.scalar(`SELECT count(*) n, coalesce(max(${bytes}),0) bytes, coalesce(sum(${bytes}),0) total FROM (${sql})`, scanned, parameters);
    if (size.n! > maxRows || size.bytes! > maxRowBytes) fail("stream-row");
    // Cumulative returned-cell/typed-row framing, BEFORE first materialization.
    this.budget.allocate(8 * size.total! + 256 * size.n!);
    this.budget.statement(sql, parameters); this.budget.reserve(scanned + size.n!);
    let statement = this.db.prepare(sql).safeIntegers();
    if (raw) statement = statement.raw();
    let n = 0;
    for (const row of statement.iterate(...parameters) as Iterable<T>) { yield row; n++; }
    if (n !== size.n) fail("stream-snapshot");
  }
  stream<T>(sql: string, fields: readonly string[], maxRows: number, maxRowBytes: number, scanned: number, visit: (row: T) => void): void {
    for (const row of this.iterate<T>(sql, fields, maxRows, maxRowBytes, scanned)) visit(row);
  }
  all<T>(sql: string, fields: readonly string[], maxRows: number, maxBytes: number, scanned: number, parameters: readonly Bind[] = [], reserve?: (bytes: number) => void): T[] {
    this.budget.allocate(64);
    const result: T[] = [];
    this.each<T>(sql, fields, maxRows, maxBytes, scanned, row => result.push(row), parameters, reserve);
    return result;
  }
}
