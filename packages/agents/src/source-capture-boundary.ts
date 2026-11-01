import type Database from "better-sqlite3";

/** Optimistic source cut. Retain bytes first, validate synchronously, then publish.
 * This is not a provider checkpoint or a lock on user working folders. */
export interface SourceCaptureToken { readonly kind: "source_capture" }
type Stamp = { changes: bigint; data: bigint; schema: bigint };
const cuts = new WeakMap<SourceCaptureToken, { epoch: bigint; databases: Array<{ db: Database.Database; stamp: Stamp }> }>();
let epoch = 0n;
const writers = new Set<object>();
const uncertain = new Set<string>();

export class SourceCaptureChangedError extends Error {
  constructor() { super("Checkpoint source changed or has an unsettled writer; discard staged capture and retry"); this.name = "SourceCaptureChangedError"; }
}

function stamp(db: Database.Database, allowTransaction = false): Stamp {
  if (!db.open || db.inTransaction && !allowTransaction) throw new SourceCaptureChangedError();
  const changes = db.prepare("SELECT total_changes() AS n").safeIntegers().get() as { n: bigint };
  const data = db.prepare("PRAGMA data_version").safeIntegers().get() as { data_version: bigint };
  const schema = db.prepare("PRAGMA schema_version").safeIntegers().get() as { schema_version: bigint };
  return { changes: changes.n, data: data.data_version, schema: schema.schema_version };
}

/** Start BEFORE the first asynchronous external effect; finish only after it settles.
 * Unknown remote outcomes remain fenced for this process lifetime. */
export function beginSourceMutation(): (unknownOutcome?: string) => void {
  const writer = {};
  writers.add(writer);
  epoch++;
  let finished = false;
  return (unknownOutcome?: string) => {
    if (finished) return;
    finished = true;
    if (unknownOutcome) uncertain.add(unknownOutcome);
    writers.delete(writer);
    epoch++;
  };
}

export async function withSourceMutation<T>(work: () => Promise<T>): Promise<T> {
  const finish = beginSourceMutation();
  try { return await work(); } finally { finish(); }
}

/** Synchronous writers cannot interleave with capture reads in this isolate.
 * Invalidate even if a subsequent disk/SQL operation fails or rolls back. */
export function touchSourceMutation(): void { epoch++; }

export function beginSourceCapture(...databases: Database.Database[]): SourceCaptureToken {
  if (!databases.length || writers.size || uncertain.size) throw new SourceCaptureChangedError();
  const token: SourceCaptureToken = Object.freeze({ kind: "source_capture" });
  cuts.set(token, { epoch, databases: [...new Set(databases)].map(db => ({ db, stamp: stamp(db) })) });
  return token;
}

/** Call after fsync of every independently retained byte, without an await
 * between this assertion and the synchronous publication of the captured cut.
 * Reads must use these exact connections, outside any long-lived SQL snapshot. */
export function assertSourceCapture(token: SourceCaptureToken): void {
  validate(token);
}

function validate(token: SourceCaptureToken, locked?: Database.Database): void {
  const cut = cuts.get(token);
  if (!cut || writers.size || uncertain.size || cut.epoch !== epoch) throw new SourceCaptureChangedError();
  for (const { db, stamp: before } of cut.databases) {
    const after = stamp(db, db === locked);
    if (before.changes !== after.changes || before.data !== after.data || before.schema !== after.schema) throw new SourceCaptureChangedError();
  }
}

/** Serialize final validation and receipt insertion against other SQLite writers.
 * The first supplied connection is the receipt authority; publication is synchronous. */
export function commitSourceCapture<T>(token: SourceCaptureToken, publish: () => T): T {
  const db = cuts.get(token)?.databases[0]?.db;
  if (!db || db.inTransaction) throw new SourceCaptureChangedError();
  try {
    return db.transaction(() => {
      validate(token, db);
      const result = publish();
      if (result && (typeof result === "object" || typeof result === "function") && "then" in result) {
        throw new Error("Source capture receipt publication must be synchronous");
      }
      return result;
    }).immediate();
  } finally { releaseSourceCapture(token); }
}

export function releaseSourceCapture(token: SourceCaptureToken): void { cuts.delete(token); }
