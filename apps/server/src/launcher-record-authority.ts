import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "@ponderosa/native-host/fs";
import path from "node:path";
import { StateAdmission } from "@ponderosa/agents";
import { DataDirectoryAuthority, physicalDirectoryIdentity } from "@ponderosa/native-host";
import type { LauncherShutdownReceiptDto } from "@ponderosa/core";
import { processBirthMarker } from "@ponderosa/engines";
import { secretEqual } from "./security.js";
import { writeLauncherShutdownReceipt } from "./launcher-shutdown-receipt.js";

interface LauncherRecord {
  schemaVersion: 2; stateEpoch: 2; stateGenerationId: string;
  physicalDataDirectoryIdentity: string; physicalLauncherDirectoryIdentity: string;
  generation: string; controlToken: string; pid: number; processBirthMarker?: string;
  dataDir: string; installRoot: string; shutdownRequestedAt?: string;
  [key: string]: unknown;
}
const identity = physicalDirectoryIdentity;
function readRecord(root: string): LauncherRecord {
  const fd = openSync(path.join(root, "launcher-state", "instance.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 32_768) throw new Error("unsupported launcher control record");
    return JSON.parse(readFileSync(fd, "utf8")) as LauncherRecord;
  } finally { closeSync(fd); }
}
/** Read-only proof, before any child SQLite/log/layout effect. */
export function validateLauncherRecord(root: string, input: {
  generation: string; controlToken: string; stateGenerationId: string; physicalDataDirectoryIdentity: string;
  recovery?: { pid: number; birth?: string; requestedAt?: string };
}): void {
  const record = readRecord(root);
  if (input.recovery && (record.pid !== input.recovery.pid || record.processBirthMarker !== input.recovery.birth ||
      record.shutdownRequestedAt !== input.recovery.requestedAt)) throw new Error("shutdown recovery fence changed");
  if (record.schemaVersion !== 2 || record.stateEpoch !== 2 || record.generation !== input.generation ||
      typeof record.controlToken !== "string" || !secretEqual(record.controlToken, input.controlToken) ||
      record.stateGenerationId !== input.stateGenerationId || record.physicalDataDirectoryIdentity !== input.physicalDataDirectoryIdentity ||
      record.physicalLauncherDirectoryIdentity !== identity(root) ||
      identity(path.join(root, "data")) !== input.physicalDataDirectoryIdentity ||
      !Number.isSafeInteger(record.pid) || record.pid < 0) throw new Error("launcher control proof does not bind the held current roots");
}
interface Lifetime {
  parent: DataDirectoryAuthority; admission: StateAdmission; root: string;
  record: LauncherRecord; references: number; live: boolean;
}
export class LauncherRecordAuthority {
  #lifetime: Lifetime;
  #closed = false;
  #closing = false;
  static assertCurrent(value: unknown, admission: StateAdmission): asserts value is LauncherRecordAuthority {
    StateAdmission.assertValid(admission);
    if (!value || typeof value !== "object") throw new Error("launcher records require live current authority");
    const state = (value as LauncherRecordAuthority).#state();
    if (state.admission.generationId !== admission.generationId ||
        state.admission.physicalIdentity !== admission.physicalIdentity) throw new Error("launcher records belong to a different current root");
  }
  constructor(parent: DataDirectoryAuthority, admission: StateAdmission, generation: string, token: string, recovery = false) {
    StateAdmission.assertValid(admission);
    const root = DataDirectoryAuthority.ownedRoot(parent);
    validateLauncherRecord(root, { generation, controlToken: token, stateGenerationId: admission.generationId,
      physicalDataDirectoryIdentity: admission.physicalIdentity });
    const record = readRecord(root);
    if (!recovery) {
      const birth = processBirthMarker(process.pid);
      if (!birth || record.pid !== 0 && (record.pid !== process.pid || record.processBirthMarker !== birth) || record.shutdownRequestedAt) {
        throw new Error("launcher startup cannot replace an unrelated process or shutdown fence");
      }
      record.pid = process.pid; record.processBirthMarker = birth;
    } else if (!record.shutdownRequestedAt || record.pid <= 0 || !record.processBirthMarker) {
      throw new Error("shutdown recovery has no exact canonical fence");
    }
    this.#lifetime = { parent, admission: admission.retain(), root, record, references: 1, live: true };
    if (!recovery) { try { this.#writeRecord(); } catch (error) { this.close(); throw error; } }
  }
  #state(): Lifetime {
    if (this.#closing || this.#closed || !this.#lifetime.live) throw new Error("launcher record authority is closed");
    const state = this.#lifetime;
    if (DataDirectoryAuthority.ownedRoot(state.parent) !== state.root || identity(state.root) !== state.record.physicalLauncherDirectoryIdentity ||
        state.admission.generationId !== state.record.stateGenerationId) throw new Error("launcher physical authority changed");
    return state;
  }
  retain(): LauncherReceiptReference { return new LauncherRecordAuthorityReference(this.#state()); }
  metadata() {
    const state = this.#state();
    if (JSON.stringify(readRecord(state.root)) !== JSON.stringify(state.record)) throw new Error("canonical launcher record changed or write was uncertain");
    return { generation: state.record.generation, pid: state.record.pid, processBirthMarker: state.record.processBirthMarker,
      shutdownRequestedAt: state.record.shutdownRequestedAt, stateEpoch: 2,
      stateGenerationId: state.record.stateGenerationId, physicalDataDirectoryIdentity: state.record.physicalDataDirectoryIdentity,
      physicalLauncherDirectoryIdentity: state.record.physicalLauncherDirectoryIdentity };
  }
  #writeRecord(): void { writeRecord(this.#state()); }
  beginShutdown(requestedAt: string): void {
    const state = this.#state();
    if (state.record.shutdownRequestedAt && state.record.shutdownRequestedAt !== requestedAt) throw new Error("a different exact shutdown fence already exists");
    state.record.shutdownRequestedAt = requestedAt;
    this.#writeRecord();
    this.writeReceipt("pending");
  }
  writeReceipt(status: "pending" | "clean" | "incomplete", error?: unknown): void { receipt(this.#state(), status, error); }
  close(): void {
    if (this.#closed) return;
    this.#closing = true;
    release(this.#lifetime);
    this.#closed = true;
  }
}
function writeRecord(state: Lifetime): void {
  const actual = readRecord(state.root);
  if (actual.generation !== state.record.generation || actual.controlToken !== state.record.controlToken ||
      actual.stateGenerationId !== state.record.stateGenerationId || actual.physicalDataDirectoryIdentity !== state.record.physicalDataDirectoryIdentity ||
      actual.physicalLauncherDirectoryIdentity !== state.record.physicalLauncherDirectoryIdentity ||
      actual.pid !== 0 && (actual.pid !== state.record.pid || actual.processBirthMarker !== state.record.processBirthMarker) ||
      actual.shutdownRequestedAt && actual.shutdownRequestedAt !== state.record.shutdownRequestedAt) throw new Error("launcher control authority changed");
  const pathname = path.join(state.root, "launcher-state", "instance.json");
  const temporary = `${pathname}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(state.record) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, pathname);
  const directory = openSync(path.dirname(pathname), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function receipt(state: Lifetime, status: "pending" | "clean" | "incomplete", error?: unknown): void {
  if (!state.live || !state.record.shutdownRequestedAt || DataDirectoryAuthority.ownedRoot(state.parent) !== state.root ||
      state.admission.generationId !== state.record.stateGenerationId) throw new Error("launcher receipt authority is unavailable");
  const record = readRecord(state.root);
  if (JSON.stringify(record) !== JSON.stringify(state.record)) throw new Error("launcher terminal record changed");
  const value: LauncherShutdownReceiptDto = { schemaVersion: 1, generation: record.generation, pid: record.pid,
    processBirthMarker: record.processBirthMarker, state: status, requestedAt: record.shutdownRequestedAt!, updatedAt: new Date().toISOString(),
    ...(error ? { error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) } : {}) };
  writeLauncherShutdownReceipt(state.admission, state.parent, value);
}
function release(state: Lifetime): void {
  if (state.references > 1) { state.references -= 1; return; }
  // A failed application close retains the final reference and parent custody.
  // Terminal receipt writes and another close attempt still own this lifetime.
  state.admission.close();
  state.parent.close();
  state.references = 0;
  state.live = false;
}
export interface LauncherReceiptReference { writeReceipt(status: "pending" | "clean" | "incomplete", error?: unknown): void; close(): void }
class LauncherRecordAuthorityReference implements LauncherReceiptReference {
  #closed = false;
  #state: Lifetime;
  constructor(state: Lifetime) { this.#state = state; state.references += 1; }
  writeReceipt(status: "pending" | "clean" | "incomplete", error?: unknown): void {
    if (this.#closed) throw new Error("launcher receipt reference is closed");
    receipt(this.#state, status, error);
  }
  close(): void { if (this.#closed) return; release(this.#state); this.#closed = true; }
}
