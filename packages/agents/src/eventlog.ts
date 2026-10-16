// The append-only event log for one agent (SPEC §4/§7). This is the canonical
// source of truth; SQLite is a rebuildable projection over it. The public surface
// is append-only by construction — there is NO update or delete of events
// (AGENTS.md invariant 3).

import { mkdirSync } from "@ponderosa/native-host/fs";
import path from "node:path";
import { appendFsyncedJsonl, readRepairableJsonl } from "./append-jsonl.js";
import type { LogEvent, StoredLogEvent } from "./log-event.js";

/**
 * Read every stored event from a log file in order. Repairs a torn final append
 * and fails on corruption anywhere earlier in the log.
 */
export function readLog(file: string): StoredLogEvent[] {
  return readRepairableJsonl<StoredLogEvent>(file, "agent event log", true);
}

/** Read events with `seq > sinceSeq` (for SSE replay-from-last-seen). */
export function readLogSince(file: string, sinceSeq: number): StoredLogEvent[] {
  return readLog(file).filter((e) => e.seq > sinceSeq);
}

/** The highest seq present in a log file (0 if empty/absent). */
export function lastSeq(file: string): number {
  const events = readLog(file);
  return events.length === 0 ? 0 : (events[events.length - 1]?.seq ?? 0);
}

/**
 * An append-only writer bound to one agent's `events.jsonl`. Tracks the next seq
 * in memory (seeded from disk on open) and fsyncs each append so a crash can't lose
 * an acknowledged event. Not safe for concurrent writers to the same file — the
 * session manager guarantees one active run per agent (SPEC §8).
 */
export class EventLog {
  private nextSeq: number;

  constructor(private readonly file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.nextSeq = lastSeq(file) + 1;
  }

  /** The seq that the next appended event will receive. */
  peekNextSeq(): number {
    return this.nextSeq;
  }

  /** Append one event; returns the stored form (with assigned seq + ts). */
  append(event: LogEvent, ts: string = new Date().toISOString()): StoredLogEvent {
    const stored: StoredLogEvent = { seq: this.nextSeq, ts, event };
    appendFsyncedJsonl(this.file, [stored]);
    this.nextSeq += 1;
    return stored;
  }

  /** All events in order. */
  readAll(): StoredLogEvent[] {
    return readLog(this.file);
  }

  /** Events with seq > sinceSeq. */
  readSince(sinceSeq: number): StoredLogEvent[] {
    return readLogSince(this.file, sinceSeq);
  }
}
