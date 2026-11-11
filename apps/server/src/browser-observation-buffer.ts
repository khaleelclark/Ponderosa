import {randomUUID} from 'node:crypto';
import type {BrowserConsoleEntry, BrowserConsoleQuery, BrowserConsoleResult, BrowserRecordingData, BrowserRecordingStatus} from '@ponderosa/core';
import {BrowserSessionError, redactBrowserText} from './browser-security.js';

export class BrowserObservationBuffer {
  private sequence = 0;
  private readonly entries: BrowserConsoleEntry[] = [];
  private recording?: {status: BrowserRecordingStatus; start: number; bytes: number; frames: BrowserRecordingData['frames']; endedAt?: string; reason?: BrowserRecordingData['reason']};
  console(pageId: string, level: BrowserConsoleEntry['level'], text: string): void {
    const redacted = redactBrowserText(text);
    this.entries.push({sequence: ++this.sequence, at: new Date().toISOString(), pageId, level, text: redacted.slice(0, 4000), textTruncated: redacted.length > 4000});
    if (this.entries.length > 500) this.entries.shift();
  }
  query(query: BrowserConsoleQuery = {}): BrowserConsoleResult {
    if (!query || typeof query !== 'object' || Array.isArray(query) ||
      (query.after !== undefined && (!Number.isSafeInteger(query.after) || query.after < 0)) ||
      (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)) ||
      (query.pageId !== undefined && (typeof query.pageId !== 'string' || query.pageId.length > 200)) ||
      (query.level !== undefined && !['log','info','warning','error'].includes(query.level))) throw new BrowserSessionError('Invalid console query.', 400);
    const after = query.after ?? 0;
    if (after > this.sequence) throw new BrowserSessionError('Console cursor belongs to another session or is ahead of this session.', 409);
    const matches = this.entries.filter(e => e.sequence > after && (!query.pageId || e.pageId === query.pageId) && (!query.level || e.level === query.level));
    const entries = matches.slice(0, query.limit ?? 50).map(e => ({...e}));
    return {entries, next: matches.length > entries.length ? entries[entries.length - 1]!.sequence : this.sequence, truncated: after < (this.entries[0]?.sequence ?? 1) - 1};
  }
  start(pageId: string): BrowserRecordingStatus {
    if (this.recording) throw new BrowserSessionError('Stop or discard the existing recording first.', 409);
    const status = {id: randomUUID(), pageId, startedAt: new Date().toISOString()};
    this.recording = {status, start: performance.now(), bytes: 0, frames: []};
    return {...status};
  }
  active(pageId: string): boolean { return this.recording?.status.pageId === pageId && !this.recording.reason; }
  frame(pageId: string, jpeg: string): void {
    const r = this.recording;
    if (!r || r.status.pageId !== pageId || r.reason) return;
    const atMs = Math.max(0, performance.now() - r.start);
    if (atMs >= 60_000) { this.finish('duration_limit'); return; }
    if (r.frames.length >= 120) { this.finish('frame_limit'); return; }
    if (r.bytes + jpeg.length > 8 * 1024 * 1024) { this.finish('byte_limit'); return; }
    if (!jpeg || !/^[A-Za-z0-9+/]+={0,2}$/.test(jpeg)) return;
    r.frames.push({atMs, jpeg}); r.bytes += jpeg.length;
    if (r.frames.length === 120) this.finish('frame_limit');
    else if (r.bytes === 8 * 1024 * 1024) this.finish('byte_limit');
  }
  finish(reason: BrowserRecordingData['reason']): void { if (this.recording && !this.recording.reason) { this.recording.reason = reason; this.recording.endedAt = new Date().toISOString(); } }
  stop(id: string): BrowserRecordingData {
    const r = this.recording;
    if (!r || r.status.id !== id) throw new BrowserSessionError('Recording does not belong to this session.', 409);
    this.finish(performance.now() - r.start >= 60_000 ? 'duration_limit' : 'explicit_stop');
    const reason = r.reason!;
    const result: BrowserRecordingData = {...r.status, format: 'ponderosa.browser-recording.v1', endedAt: r.endedAt!, reason, frames: r.frames};
    return result;
  }
  recordingPage(): string | undefined { return this.recording?.status.pageId; }
  discard(): void { this.recording = undefined; }
}
