import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync,
  mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, opendirSync,
  rmSync, writeFileSync, writeSync,
} from "@ponderosa/native-host/fs";
import type { BigIntStats } from "@ponderosa/native-host/fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { prepareSqliteStorage, storageDatabaseFilename } from "@ponderosa/native-host/sqlite-storage";
prepareSqliteStorage(Database);
import { DataDirectoryAuthority, dataDirectoryAuthoritySupported, physicalDirectoryIdentity } from "@ponderosa/native-host";
import type { WindowsDirectoryLeaseTransfer } from "@ponderosa/native-host";
import { initializeCurrentDatabase } from "./db.js";
import { stateSchemaSignature } from "./state-schema-signature.js";
import { StateReadBudget, stateReadBudget, bindStateReadBudget, withStateReadInvocation, withStateReads } from "./state-read-budget.js";

export const STATE_EPOCH = 2;
export const STATE_SCHEMA_CONTRACT = "ponderosa.state.current-single-db";
export const STATE_MARKER = ".ponderosa-layout-version";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const generationDdl = `CREATE TABLE _state_generation (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  state_epoch INTEGER NOT NULL CHECK(state_epoch=2),
  generation_id TEXT NOT NULL,
  schema_contract TEXT NOT NULL
)`;
export interface StateIdentity { layoutVersion: 2; stateEpoch: 2; generationId: string }
export class StateAdmissionError extends Error {
  constructor(readonly file?: string, readonly check?: string) {
    super(`unsupported or incomplete current state; existing bytes are preserved${file ? `; ${file}: ${check}` : ""}`);
    this.name = "StateAdmissionError";
  }
}
function refuse(file?: string, check?: string): never { throw new StateAdmissionError(file, check); }
const statFields = ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"] as const;
function identity(stat: BigIntStats): string { return `${stat.dev}:${stat.ino}`; }
function same(a: BigIntStats, b: BigIntStats): boolean {
  return statFields.every(key => a[key] === b[key]);
}
function regular(path: string): BigIntStats | undefined {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.nlink !== 1n)) refuse(basename(path), "file type or link count");
  return stat;
}
function fsyncPath(path: string): void {
  const fd = openSync(path, (process.platform === "win32" && !lstatSync(path).isDirectory() ? constants.O_RDWR : constants.O_RDONLY) | (/^\/proc\/self\/fd\/\d+$/u.test(path) ? 0 : constants.O_NOFOLLOW));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function* directoryNames(root: string, budget: StateReadBudget): Generator<string> {
  budget.allocate(32 * 8192); budget.reserve(1);
  const directory = opendirSync(root);
  try {
    while (true) {
      budget.allocate(8192); budget.reserve(1);
      const entry = directory.readSync(); if (!entry) return;
      if (Buffer.byteLength(entry.name) > 255) refuse(); yield entry.name;
    }
  } finally { directory.closeSync(); }
}
function readMarker(root: string, budget = new StateReadBudget()): StateIdentity {
  budget.allocate(32768); budget.reserve(256);
  const path = join(root, STATE_MARKER);
  const markerStat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!markerStat?.isFile()) refuse();
  const fd = openSync(path, (process.platform === "win32" && !lstatSync(path).isDirectory() ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > 256n) refuse();
    if (before.nlink !== 1n) {
      if (before.nlink !== 2n) refuse();
      let aliasFound = false;
      for (const name of directoryNames(root, budget)) {
        const prefix = `${STATE_MARKER}.`;
        if (!name.startsWith(prefix) || !name.endsWith(".tmp") || !UUID.test(name.slice(prefix.length, -4))) continue;
        const alias = lstatSync(join(root, name), { bigint: true });
        if (alias.isFile() && identity(alias) === identity(before)) { aliasFound = true; break; }
      }
      if (!aliasFound) refuse();
    }
    const marker = JSON.parse(readFileSync(fd, "utf8")) as StateIdentity;
    if (!marker || Array.isArray(marker) || Object.keys(marker).sort().join(",") !== "generationId,layoutVersion,stateEpoch" ||
        marker.layoutVersion !== 2 || marker.stateEpoch !== 2 || !UUID.test(marker.generationId) ||
        !same(before, fstatSync(fd, { bigint: true })) || !same(before, lstatSync(path, { bigint: true }))) refuse();
    return marker;
  } finally { closeSync(fd); }
}
function declareGeneration(sqlite: Database.Database): void {
  const budget = stateReadBudget(sqlite); budget.statement(generationDdl, []); budget.reserve(512); sqlite.exec(generationDdl);
}
function mintGeneration(sqlite: Database.Database, generationId: string): void {
  const sql = "INSERT INTO _state_generation VALUES (1,2,?,?)", budget = stateReadBudget(sqlite);
  budget.statement(sql, [generationId, STATE_SCHEMA_CONTRACT]); budget.reserve(1); sqlite.prepare(sql).run(generationId, STATE_SCHEMA_CONTRACT);
}
const schemaSignature = stateSchemaSignature;
let compiledContract: string | undefined;
function expectedContract(budget = new StateReadBudget()): string {
  if (compiledContract) return compiledContract;
  budget.allocate(8192 * 1024 + 16 * 1024 ** 2); budget.reserve(512);
  const sqlite = new Database(":memory:");
  try {
    bindStateReadBudget(sqlite, budget);
    sqlite.pragma("cache_size=-8192"); sqlite.pragma("mmap_size=0");
    initializeCurrentDatabase(sqlite);
    declareGeneration(sqlite);
    return compiledContract = schemaSignature(sqlite);
  } finally { sqlite.close(); }
}
// Only the exact pre-history and pre-workspace schemas may upgrade online.
// Derive signatures from current DDL; arbitrary missing tables remain refused.
let compiledHistoryPredecessor: string | undefined;
let compiledWorkspacePredecessor: string | undefined;
function workspacePredecessorContract(budget = new StateReadBudget(), beforeHistory = false): string {
  const cached = beforeHistory ? compiledHistoryPredecessor : compiledWorkspacePredecessor;
  if (cached) return cached;
  budget.allocate(8192 * 1024 + 16 * 1024 ** 2); budget.reserve(512);
  const sqlite = new Database(":memory:");
  try {
    bindStateReadBudget(sqlite, budget);
    sqlite.pragma("cache_size=-8192"); sqlite.pragma("mmap_size=0");
    initializeCurrentDatabase(sqlite); declareGeneration(sqlite);
    sqlite.exec("DROP TRIGGER assistant_status_communication; DROP TRIGGER assistant_status_request; DROP TRIGGER assistant_status_run; DROP TABLE assistant_status_sources; DROP TABLE assistant_report_scan; DROP TABLE assistant_report_sources; DROP TABLE workspace_agent_actions; DELETE FROM sqlite_sequence WHERE name='assistant_status_sources'");
    sqlite.prepare("DELETE FROM _schema_version WHERE name=?").run("0029_assistant_workspace.sql");
    if (beforeHistory) {
      sqlite.exec("DROP TABLE capability_policy_history");
      sqlite.prepare("DELETE FROM _schema_version WHERE name=?").run("0028_capability_policy_history.sql");
    }
    const signature = schemaSignature(sqlite);
    if (beforeHistory) compiledHistoryPredecessor = signature; else compiledWorkspacePredecessor = signature;
    return signature;
  } finally { sqlite.close(); }
}
function historyPredecessorContract(budget = new StateReadBudget()): string {
  return workspacePredecessorContract(budget, true);
}
function verifyDatabase(sqlite: Database.Database, generationId: string,
  contract = expectedContract(), allowHistoryUpgrade = false): boolean {
  const actual = schemaSignature(sqlite), upgrade = actual !== contract;
  if (upgrade && (!allowHistoryUpgrade || (actual !== historyPredecessorContract(stateReadBudget(sqlite)) && actual !== workspacePredecessorContract(stateReadBudget(sqlite))))) refuse();
  withStateReads(sqlite, reads => {
    const objectCount = reads.population("sqlite_master");
    const tables = reads.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'", ["name"], 512, 1024 ** 2, objectCount);
    let work = 0;
    for (const table of tables) {
      const n = reads.population(`"${table.name.replaceAll('"', '""')}"`);
      const keys = reads.population(`pragma_index_list('${table.name.replaceAll("'", "''")}')`);
      if (keys > 512) refuse(); work += n * (keys + 1);
      if (!Number.isSafeInteger(work) || work > 16_000_000) refuse();
    }
    const integrity = reads.all<{ integrity_check: string }>("SELECT integrity_check FROM pragma_integrity_check LIMIT 1", ["integrity_check"], 1, 1024, work);
    if (integrity[0]?.integrity_check !== "ok") refuse();
    const generation = reads.all("SELECT singleton,state_epoch,generation_id,schema_contract FROM _state_generation WHERE singleton=1",
      ["singleton", "state_epoch", "generation_id", "schema_contract"], 1, 1024, 1)[0];
    reads.budget.allocate(4096); reads.budget.reserve(1);
    if (JSON.stringify(generation) !== JSON.stringify({ singleton: 1, state_epoch: 2, generation_id: generationId, schema_contract: STATE_SCHEMA_CONTRACT })) refuse();
  });
  return upgrade;
}
function databaseNames(primary: string): string[] {
  if (!primary || primary !== basename(primary) || !/^[A-Za-z0-9_.-]+$/u.test(primary) ||
      primary === STATE_MARKER) refuse();
  return [primary];
}

/** SQLite opens only this descriptor-copied private cohort. The held directory
 * lease excludes cooperating writers; each source file remains identity-bound
 * through final verification and closes before live SQLite opens. This is not
 * custody against a hostile host. */
function snapshot(root: string, names: readonly string[], budget: StateReadBudget) {
  budget.allocate(16384);
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-state-"));
  const entries: Array<{ path: string; fd: number; before: BigIntStats; hash: string }> = [];
  const present = () => names.flatMap(name => ["", "-wal", "-shm", "-journal"]
    .filter(suffix => regular(join(root, name + suffix)))
    .map(suffix => name + suffix));
  let cohort: string[] = [];
  const hashDescriptor = (fd: number, size: bigint): string => {
    if (size > BigInt(Number.MAX_SAFE_INTEGER)) refuse();
    budget.allocate(256 * 1024);
    const hash = createHash("sha256"); const buffer = Buffer.alloc(256 * 1024);
    for (let position = 0; position < Number(size);) {
      budget.reserve(1);
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, Number(size) - position), position);
      if (!count) refuse(); hash.update(buffer.subarray(0, count)); position += count;
    }
    return hash.digest("hex");
  };
  const verify = () => {
    const current = present();
    const changed = cohort.find(name => !current.includes(name)) ?? current.find(name => !cohort.includes(name));
    if (changed) refuse(changed, "cohort membership changed during admission");
    for (const entry of entries) {
      const file = basename(entry.path);
      for (const stat of [fstatSync(entry.fd, { bigint: true }), regular(entry.path)]) {
        if (!stat) refuse(file, "file disappeared during admission");
        const field = statFields.find(key => entry.before[key] !== stat[key]);
        if (field) refuse(file, `${field} changed during admission`);
      }
      if (hashDescriptor(entry.fd, entry.before.size) !== entry.hash) refuse(file, "content changed during admission");
    }
  };
  const dispose = () => {
    for (const entry of entries) closeSync(entry.fd);
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    cohort = present();
    for (const name of names) if (!cohort.includes(name)) refuse();
    for (const name of cohort) {
      const path = join(root, name);
      const fd = openSync(path, (process.platform === "win32" && !lstatSync(path).isDirectory() ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n) { closeSync(fd); refuse(); }
      const entry = { path, fd, before, hash: "" };
      entries.push(entry); entry.hash = hashDescriptor(fd, before.size);
      if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) refuse();
      budget.allocate(Number(before.size) + 256 * 1024);
      const target = openSync(join(directory, name), "wx", 0o600);
      try {
        const buffer = Buffer.alloc(256 * 1024);
        for (let position = 0; position < Number(before.size);) {
          budget.reserve(1);
          const count = readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - position), position);
          if (!count) refuse();
          for (let written = 0; written < count;) {
            const size = writeSync(target, buffer, written, count - written);
            if (!size) refuse(); written += size;
          }
          position += count;
        }
      } finally { closeSync(target); }
    }
    verify();
    return { directory, verify, dispose };
  } catch (error) { dispose(); throw error; }
}

function verifyRootWithin(root: string, names: string[], marker: StateIdentity, budget: StateReadBudget, allowHistoryUpgrade = false) {
  const rootIdentity = physicalDirectoryIdentity(root);
  // No unknown top-level SQLite authority is accepted as a current companion.
  const allowed = new Set(names.flatMap(name => ["", "-wal", "-shm", "-journal"].map(suffix => name + suffix)));
  for (const name of directoryNames(root, budget)) {
    if (/\.(?:db|sqlite)(?:-(?:wal|shm|journal))?$/u.test(name) && !allowed.has(name)) refuse();
  }
  const copied = snapshot(root, names, budget);
  try {
    const contract = expectedContract(budget);
    let upgrade = false;
    for (const name of names) {
      budget.allocate(8192 * 1024 + 4096); budget.reserve(1);
      const sqlite = new Database(storageDatabaseFilename(join(copied.directory, name)), { fileMustExist: true });
      try {
        bindStateReadBudget(sqlite, budget);
        sqlite.pragma("cache_size=-8192"); sqlite.pragma("mmap_size=0");
        upgrade = verifyDatabase(sqlite, marker.generationId, contract, allowHistoryUpgrade);
      } finally { sqlite.close(); }
    }
    copied.verify();
    if (JSON.stringify(readMarker(root, budget)) !== JSON.stringify(marker) ||
        physicalDirectoryIdentity(root) !== rootIdentity) refuse();
    return { ...copied, upgrade };
  } catch (error) { copied.dispose(); throw error; }
}

function verifyRoot(root: string, names: string[], marker: StateIdentity, allowHistoryUpgrade = false) {
  const budget = new StateReadBudget();
  return withStateReadInvocation(budget, () => verifyRootWithin(root, names, marker, budget, allowHistoryUpgrade));
}

function bootstrap(root: string, names: string[]): StateIdentity {
  if (readdirSync(root).length !== 0) refuse();
  const marker: StateIdentity = { layoutVersion: 2, stateEpoch: 2, generationId: randomUUID() };
  for (const name of names) {
    const path = join(root, name);
    closeSync(openSync(path, "wx", 0o600));
    const sqlite = new Database(storageDatabaseFilename(path), { fileMustExist: true });
    try { initializeCurrentDatabase(sqlite); declareGeneration(sqlite); mintGeneration(sqlite, marker.generationId);
      verifyDatabase(sqlite, marker.generationId); }
    finally { sqlite.close(); }
    for (const suffix of ["", "-wal", "-shm", "-journal"]) if (regular(path + suffix)) fsyncPath(path + suffix);
  }
  fsyncPath(root);
  const temporary = join(root, `${STATE_MARKER}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(marker) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  // No replace: a partial bootstrap is retained and refused on the next open.
  linkSync(temporary, join(root, STATE_MARKER)); fsyncPath(root);
  rmSync(temporary); fsyncPath(root);
  return marker;
}

interface RootState {
  authority: DataDirectoryAuthority; root: string; physicalIdentity: string;
  primary: string; marker: StateIdentity; client: Database.Database;
  closeClient(): void; references: number; live: boolean; exported: boolean;
}
const rootStates = new WeakSet<RootState>();
const roots = new Map<string, RootState>();
const admissions = new WeakMap<StateAdmission, RootState>();
const databases = new WeakMap<Database.Database, () => boolean>();

/** Instances are issued only by admission. Refcounts retain the exact physical
 * lease until the final database close; serialized identity is never a permit. */
export class StateAdmission {
  #closed = false;
  private constructor(state: RootState) {
    if (!rootStates.has(state) || !state.live || !state.client.open) refuse();
    admissions.set(this, state); state.references += 1;
  }
  static assertValid(value: unknown): asserts value is StateAdmission {
    if (!value || typeof value !== "object" || !admissions.has(value as StateAdmission)) refuse();
    (value as StateAdmission).#state();
  }
  static issue(state: RootState): StateAdmission { return new StateAdmission(state); }
  get dataDir(): string { return this.#state().root; }
  get generationId(): string { return this.#state().marker.generationId; }
  get physicalIdentity(): string { return this.#state().physicalIdentity; }
  get client(): Database.Database { return this.#state().client; }
  #state(): RootState {
    const state = admissions.get(this);
    if (this.#closed || !state?.live || !state.client.open) refuse();
    return state;
  }
  retain(): StateAdmission { return StateAdmission.issue(this.#state()); }
  assertRoot(path: string): void {
    const state = this.#state();
    if (physicalDirectoryIdentity(path) !== state.physicalIdentity) refuse();
  }
  close(): void {
    if (this.#closed) return;
    const state = admissions.get(this)!;
    // If SQLite refuses its final close, retain this reference and the native
    // lease so disposal can be retried without exposing a still-open database.
    if (state.references === 1 && state.client.open) state.closeClient();
    this.#closed = true;
    if (--state.references !== 0) return;
    state.live = false; roots.delete(state.physicalIdentity); databases.delete(state.client);
    state.authority.close();
  }
  revalidateTransferredState(): void {
    const state = admissions.get(this);
    if (this.#closed || !state?.exported || physicalDirectoryIdentity(DataDirectoryAuthority.ownedRoot(state.authority)) !== state.physicalIdentity) refuse();
    const marker = readMarker(state.root);
    if (marker.generationId !== state.marker.generationId) refuse();
    const inspected = verifyRoot(state.root, databaseNames(state.primary), marker);
    inspected.dispose();
  }
  /** The parent remains leased, but closes SQLite before the child can snapshot.
   * Exported native disposal never LOCK_UNs a shared open description. */
  prepareTransfer(): { descriptor: number; generationId: string; physicalIdentity: string; dataLease?: WindowsDirectoryLeaseTransfer } {
    const state = this.#state();
    if (state.references !== 1 || state.exported) refuse();
    state.closeClient(); databases.delete(state.client);
    state.live = false; state.exported = true; roots.delete(state.physicalIdentity);
    return { descriptor: state.authority.exportDescriptor(), dataLease: state.authority.exportLeaseTransfer(), generationId: state.marker.generationId,
      physicalIdentity: state.physicalIdentity };
  }
}

export function requireAdmittedDatabase(sqlite: Database.Database): void {
  if (!sqlite.open || !databases.get(sqlite)?.()) refuse();
}
export function openCurrentMemoryDatabase(): Database.Database {
  const sqlite = new Database(":memory:");
  try {
    initializeCurrentDatabase(sqlite); declareGeneration(sqlite); mintGeneration(sqlite, randomUUID());
    sqlite.pragma("foreign_keys=ON");
    databases.set(sqlite, () => sqlite.open);
    return sqlite;
  } catch (error) { sqlite.close(); throw error; }
}
export function shareStateAdmission(dataDir: string): StateAdmission {
  const state = [...roots.values()].find(state => state.root === dataDir)
    ?? roots.get(physicalDirectoryIdentity(dataDir));
  if (!state?.live || !state.client.open) refuse();
  return StateAdmission.issue(state);
}
export function admitDataDirectory(dataDir: string, primary = "ponderosa.db", inheritedDescriptor?: number, expected?: { generationId: string; physicalIdentity?: string; dataLease?: WindowsDirectoryLeaseTransfer }): StateAdmission {
  // Linux native physical-directory leases only. Add another qualified
  // non-mutating primitive before claiming support on other platforms.
  if (!dataDirectoryAuthoritySupported()) throw new Error("current state admission requires qualified native physical-directory authority");
  const retained = [...roots.values()].find(state => state.root === dataDir);
  if (retained) {
    if (inheritedDescriptor !== undefined || primary !== retained.primary ||
        expected && (expected.generationId !== retained.marker.generationId ||
          expected.physicalIdentity !== undefined && expected.physicalIdentity !== retained.physicalIdentity)) refuse();
    return StateAdmission.issue(retained);
  }
  const named = resolve(dataDir);
  // A portable inherited root is an opaque reference, not a pathname in this
  // child's namespace until native adoption. Inspect the received kernel object
  // first; generation, schema and physical identity checks still follow below.
  const portableTransfer = inheritedDescriptor !== undefined && process.platform !== "linux";
  const existing = portableTransfer ? undefined : lstatSync(named, { bigint: true, throwIfNoEntry: false });
  if (existing && !existing.isDirectory() && !(inheritedDescriptor !== undefined && named === `/proc/self/fd/${inheritedDescriptor}`)) refuse();
  if (existing) {
    const shared = roots.get(physicalDirectoryIdentity(named));
    if (shared) {
      if (inheritedDescriptor !== undefined || shared.primary !== primary || !shared.live ||
          expected && (expected.generationId !== shared.marker.generationId ||
            expected.physicalIdentity !== undefined && expected.physicalIdentity !== shared.physicalIdentity)) refuse();
      return StateAdmission.issue(shared);
    }
  } else if (!portableTransfer) {
    if (inheritedDescriptor !== undefined || expected) refuse();
    mkdirSync(named, { recursive: true, mode: 0o700 });
  }
  const authority = new DataDirectoryAuthority(named, inheritedDescriptor, expected?.dataLease);
  let sqlite: Database.Database | undefined;
  try {
    const root = authority.rootPath;
    const names = databaseNames(primary);
    const empty = readdirSync(root).length === 0;
    if (empty && expected) refuse();
    const marker = empty ? bootstrap(root, names) : readMarker(root);
    const admittedSnapshot = verifyRoot(root, names, marker, true);
    try {
      if (expected && (marker.generationId !== expected.generationId ||
          expected.physicalIdentity !== undefined && physicalDirectoryIdentity(root) !== expected.physicalIdentity)) refuse();
      admittedSnapshot.verify();
    } finally { admittedSnapshot.dispose(); }
    // Closing another descriptor for a live SQLite file can drop its POSIX
    // locks. Close the source cohort first; keep the directory lease throughout.
    sqlite = new Database(storageDatabaseFilename(join(root, primary)), { fileMustExist: true });
    sqlite.pragma("foreign_keys=ON");
    if (admittedSnapshot.upgrade) {
      // Recheck the live handle under the same physical lease before any write.
      // DDL, its receipt and final validation commit as one transaction.
      verifyDatabase(sqlite, marker.generationId, expectedContract(), true);
      const upgrading = sqlite;
      withStateReads(upgrading, () => {
        initializeCurrentDatabase(upgrading);
        verifyDatabase(upgrading, marker.generationId);
      });
    }
    sqlite.pragma("journal_mode=WAL");
    sqlite.pragma("synchronous=FULL"); sqlite.pragma("busy_timeout=500");
    const state: RootState = { authority, root, primary, marker, client: sqlite,
      physicalIdentity: physicalDirectoryIdentity(root), closeClient: sqlite.close.bind(sqlite),
      references: 0, live: true, exported: false };
    rootStates.add(state); roots.set(state.physicalIdentity, state); databases.set(sqlite, () => state.live && state.client.open);
    // The raw client is shared. Only an acquisition's admission may dispose it;
    // its saved native close runs once after the true final reference is released.
    sqlite.close = () => { throw new Error("close the acquired database reference, not its shared client"); };
    return StateAdmission.issue(state);
  } catch (error) {
    if (sqlite?.open) sqlite.close(); authority.close(); throw error;
  }
}

export function readCurrentStateIdentity(dataDir: string): StateIdentity {
  const admission = shareStateAdmission(dataDir);
  try { return { layoutVersion: 2, stateEpoch: 2, generationId: admission.generationId }; }
  finally { admission.close(); }
}

/** Offline byte inspection holds the native lease and opens SQLite only on
 * private copies. It never mints a marker or issues mutable runtime admission. */
export function inspectCurrentState(dataDir: string): {
  dataDir: string; snapshotRoot: string; generationId: string; close(): void;
} {
  if (!dataDirectoryAuthoritySupported()) throw new Error("current state inspection requires qualified native physical-directory authority");
  const authority = new DataDirectoryAuthority(resolve(dataDir));
  try {
    const root = authority.rootPath;
    const marker = readMarker(root);
    const inspected = verifyRoot(root, databaseNames("ponderosa.db"), marker);
    let closed = false;
    return { dataDir: root, snapshotRoot: inspected.directory, generationId: marker.generationId, close: () => {
      if (closed) return; closed = true;
      try { inspected.dispose(); } finally { authority.close(); }
    } };
  } catch (error) { authority.close(); throw error; }
}
