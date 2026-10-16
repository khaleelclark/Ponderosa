import { browserOwnerId, type BrowserOwner, type BrowserSessionDto } from "@ponderosa/core";
import { readFileSync, readdirSync, rmSync } from "@ponderosa/native-host/fs";
import path from "node:path";
import { BrowserSessionError } from "./browser-security.js";

export interface RetainedBrowserScope {
  projectId: string;
  agentId: string;
  runId: string;
  conversationId?: string;
  owner?: BrowserOwner;
}
interface RetainedBrowserRecord extends RetainedBrowserScope {
  checkpointVersion: 2;
  id: string;
  profileId?: string;
  profileMode: BrowserSessionDto["profileMode"];
}
interface RetainedEntry {
  filename: string;
  body?: string;
  record?: RetainedBrowserRecord;
  conflict?: boolean;
}
export type RetainedBrowserTarget = { projectId: string } | { conversationId: string } | { profileId: string };

function pending(): never {
  throw new BrowserSessionError("Retained browser custody or observed cleanup remains unresolved. Explicit reconciliation is required before removal.", 409, "browser_recovery_required");
}
function validScope(value: RetainedBrowserScope): boolean {
  if (!value || !value.owner || typeof value.projectId !== "string" || !value.projectId || typeof value.agentId !== "string" || !value.agentId || typeof value.runId !== "string" || !value.runId) return false;
  try { browserOwnerId(value.owner); } catch { return false; }
  return value.owner.kind === "chat"
    ? value.conversationId === value.owner.conversationId
    : value.conversationId === undefined;
}
function sameRetainedScope(left: RetainedBrowserScope, right: RetainedBrowserScope): boolean {
  return validScope(left) && validScope(right) && left.projectId === right.projectId &&
    left.agentId === right.agentId && left.runId === right.runId &&
    left.conversationId === right.conversationId && browserOwnerId(left.owner!) === browserOwnerId(right.owner!);
}
function parseRecord(filename: string, body: string): RetainedBrowserRecord | undefined {
  try {
    const record = JSON.parse(body) as RetainedBrowserRecord;
    if (!/^[a-f0-9-]{36}\.json$/u.test(filename) || record.checkpointVersion !== 2 ||
        record.id !== filename.slice(0, -5) || !validScope(record) ||
        (record.profileMode !== "trusted" && record.profileMode !== "disposable") ||
        (record.profileMode === "trusted" ? !/^[a-f0-9-]{36}$/u.test(record.profileId ?? "") : record.profileId !== undefined)) return undefined;
    return record;
  } catch { return undefined; }
}
function applies(entry: RetainedEntry, target: RetainedBrowserTarget): boolean {
  const record = entry.record;
  // Unreadable/missing/incompatible custody cannot be assigned to an unrelated scope.
  if (!record || entry.conflict) return true;
  if ("profileId" in target) return record.profileId === target.profileId;
  return "projectId" in target ? record.projectId === target.projectId :
    record.owner?.kind === "chat" && record.owner.conversationId === target.conversationId;
}

/** One authority shared by the profile catalog and both session managers.
 * Missing files never settle observed broker IDs or previously seen metadata.
 * Only exact observed termination may retire a retained reference. */
export class BrowserRetainedInventory {
  private readonly directory: string;
  private readonly entries = new Map<string, RetainedEntry>();
  private readonly settled = new WeakSet<RetainedEntry>();
  constructor(dataDir: string) { this.directory = path.join(dataDir, "retained-browser-sessions"); }

  recordBrokerClaim(ids: string[]): void {
    for (const id of ids) {
      if (!/^[a-f0-9-]{36}$/u.test(id)) pending();
      const filename = `${id}.json`;
      if (!this.entries.has(filename)) this.entries.set(filename, { filename });
    }
    this.refresh();
  }

  quarantine(id: string): void {
    const entry = this.entries.get(`${id}.json`);
    if (entry) entry.conflict = true;
  }

  private refresh(): void {
    let filenames: string[];
    try { filenames = readdirSync(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      pending();
    }
    for (const filename of filenames) {
      // Interrupted atomic writes are evidence too; normal writes finish synchronously.
      let body: string | undefined;
      try { body = readFileSync(path.join(this.directory, filename), "utf8"); } catch { /* retained unknown */ }
      const previous = this.entries.get(filename);
      if (previous?.body !== undefined && body !== previous.body) {
        previous.conflict = true;
        continue;
      }
      if (!previous || previous.body === undefined) this.entries.set(filename, {
        filename, body, record: body === undefined ? undefined : parseRecord(filename, body),
        conflict: previous?.conflict,
      });
    }
  }

  snapshot(target: RetainedBrowserTarget): RetainedEntry[] {
    this.refresh();
    return [...this.entries.values()].filter(entry => applies(entry, target));
  }

  assertClear(target: RetainedBrowserTarget): void {
    if (this.snapshot(target).length) pending();
  }

  matches(entry: RetainedEntry, dto: BrowserSessionDto): boolean {
    const record = entry.record;
    return !entry.conflict && Boolean(record && record.id === dto.id &&
      sameRetainedScope(record, dto) && record.profileId === dto.profileId && record.profileMode === dto.profileMode);
  }

  beforeWrite(dto: BrowserSessionDto, cleanupSource?: RetainedBrowserScope): void {
    this.refresh();
    const entry = this.entries.get(`${dto.id}.json`);
    if (!entry) return;
    if (this.matches(entry, dto)) return;
    // Only the synchronous source-to-saved promotion may change checkpoint custody.
    if (!entry.conflict && entry.record && cleanupSource?.owner?.kind === "chat" && sameRetainedScope(entry.record, cleanupSource) &&
        dto.owner?.kind === "saved" && entry.record.profileId === dto.profileId && entry.record.profileMode === dto.profileMode) return;
    pending();
  }

  written(dto: BrowserSessionDto, body: string): void {
    const filename = `${dto.id}.json`;
    this.entries.set(filename, { filename, body, record: parseRecord(filename, body) });
  }

  beginCleanup(dto: BrowserSessionDto): RetainedEntry | undefined {
    this.refresh();
    const entry = this.entries.get(`${dto.id}.json`);
    if (entry && !this.matches(entry, dto)) pending();
    return entry;
  }

  finishCleanup(entry: RetainedEntry | undefined, observedTermination: boolean): void {
    if (!entry || this.settled.has(entry)) return;
    if (!observedTermination || this.entries.get(entry.filename) !== entry || entry.conflict) pending();
    // Synchronous compare/removal has no app await gap. Absence alone is never proof.
    let body: string;
    try { body = readFileSync(path.join(this.directory, entry.filename), "utf8"); } catch { pending(); }
    if (body !== entry.body) { entry.conflict = true; pending(); }
    rmSync(path.join(this.directory, entry.filename));
    this.entries.delete(entry.filename);
    this.settled.add(entry);
  }
}
