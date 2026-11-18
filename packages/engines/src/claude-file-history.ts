import { randomUUID } from "node:crypto";
import type { NativeFileRewindResult, NativeHistoryCatalog } from "@ponderosa/core";

const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v);
const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
/** Observed live UUIDs only. A transcript UUID never manufactures a backup. */
export class ClaudeFileHistory {
  private readonly checkpoints = new Set<string>();
  private readonly cuts = new Set<string>();
  private assistant?: string;
  private user?: string;
  private pending?: { id: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
  uncertain = false;
  ready = false;
  constructor(readonly sessionId: string, private readonly write: (frame: unknown) => Promise<void>, private readonly trackingEnabled = false) {}
  beginTurn(): void { this.assistant = undefined; this.user = undefined; }
  catalog(): NativeHistoryCatalog {
    return { ...(this.ready?{trackingEnabled:this.trackingEnabled}:{}), sessionId: this.sessionId, checkpoints: [...this.checkpoints].map(messageId => ({sessionId:this.sessionId,messageId})),
      forkPoints: [...this.cuts], fileRewindSupported: this.trackingEnabled && this.ready && !this.uncertain, transcriptForkSupported: this.ready && !this.uncertain };
  }
  observe(raw: unknown): boolean {
    const e = object(raw);
    if (!e) return false;
    if (e.type === "control_response") {
      const r = object(e.response), p = this.pending;
      if (!p || r?.request_id !== p.id) return false;
      clearTimeout(p.timer); this.pending = undefined;
      if (r.subtype !== "success" || e.session_id !== undefined && e.session_id !== this.sessionId) {
        this.uncertain = true; p.reject(new Error("Unconfirmed native file rewind"));
      } else p.resolve(r.response);
      return true;
    }
    if (e.session_id !== this.sessionId || e.parent_tool_use_id != null) return false;
    if (e.type === "system" && e.subtype === "init") {
      const version=typeof e.claude_code_version==='string'?/^(\d+)\.(\d+)\.(\d+)/u.exec(e.claude_code_version):null;
      this.ready=Boolean(version && (Number(version[1])>2 || Number(version[1])===2 && (Number(version[2])>1 || Number(version[2])===1 && Number(version[3])>=216)));
    }
    if (e.type === "user" && e.isReplay === true && uuid(e.uuid) && object(e.message)?.role === "user") this.user = e.uuid;
    if (e.type === "assistant" && uuid(e.uuid)) this.assistant = e.uuid;
    if (e.type === "result") {
      if (e.subtype === "success" && e.is_error === false) {
        if (this.trackingEnabled && this.user) this.checkpoints.add(this.user);
        if (this.assistant) this.cuts.add(this.assistant);
        while (this.checkpoints.size > 128) this.checkpoints.delete(this.checkpoints.values().next().value!);
        while (this.cuts.size > 128) this.cuts.delete(this.cuts.values().next().value!);
      }
      this.beginTurn();
    }
    return false;
  }
  async rewind(messageId: string, dryRun: boolean): Promise<NativeFileRewindResult> {
    if (!this.trackingEnabled || !this.ready || this.uncertain || this.pending || !this.checkpoints.has(messageId)) throw new Error("Exact tracked native checkpoint unavailable");
    const base = { sessionId:this.sessionId,messageId,dryRun };
    try {
      const value = await new Promise<unknown>((resolve, reject) => {
        const id = `ponderosa-history-${randomUUID()}`;
        const timer = setTimeout(() => { this.pending = undefined; this.uncertain = true; reject(new Error("Native rewind response lost")); }, 10_000);
        this.pending = {id,resolve,reject,timer};
        void this.write({type:"control_request",request_id:id,request:{subtype:"rewind_files",user_message_id:messageId,dry_run:dryRun}}).catch(error => {
          if (this.pending?.id !== id) return;
          clearTimeout(timer); this.pending = undefined; this.uncertain = true; reject(error);
        });
      });
      const r = object(value);
      if (!r || typeof r.canRewind !== "boolean" ||
          r.error !== undefined && typeof r.error !== "string" ||
          r.filesChanged !== undefined && (!Array.isArray(r.filesChanged) || r.filesChanged.length > 1000 || r.filesChanged.some(v => typeof v !== "string" || v.length > 4096)) ||
          [r.insertions,r.deletions,r.skippedLinks].some(v => v !== undefined && (!Number.isSafeInteger(v) || (v as number) < 0))) throw new Error("Invalid native rewind receipt");
      return {...base,outcome:"completed",canRewind:r.canRewind,
        ...(typeof r.error === "string" ? {error:r.error.slice(0,8192)} : {}),
        ...(r.filesChanged !== undefined ? {filesChanged:[...r.filesChanged as string[]]} : {}),
        ...(r.insertions !== undefined ? {insertions:r.insertions as number} : {}),
        ...(r.deletions !== undefined ? {deletions:r.deletions as number} : {}),
        ...(r.skippedLinks !== undefined ? {skippedLinks:r.skippedLinks as number} : {})};
    } catch { this.uncertain = true; return {...base,outcome:"outcome_unknown"}; }
  }
  close(): void {
    this.uncertain = true;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error("History transport closed")); this.pending = undefined; }
  }
}
