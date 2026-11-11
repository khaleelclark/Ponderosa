import type { AgentEvent } from "@ponderosa/core";
type Candidate = Extract<AgentEvent, { type: "response_text" }>;
/** Grounded in app-server item/started + itemId deltas + completed snapshot.
 * https://developers.openai.com/codex/app-server (Items / Item deltas).
 * Missing phase stays unknown; completed snapshots never repeat delta audio. */
export class CodexResponseText {
  private turn?: string;
  private items = new Map<string, Candidate["phase"]>();
  constructor(private readonly threadId: string) {}
  map(method: string, value: unknown): Candidate[] {
    if (!value || typeof value !== "object") return [];
    const p = value as Record<string, any>;
    if (p.threadId !== this.threadId) return [];
    if (method === "turn/started" && typeof p.turn?.id === "string") {
      this.turn = p.turn.id; this.items.clear(); return [];
    }
    if (method === "turn/completed") { this.turn = undefined; this.items.clear(); return []; }
    if (!this.turn || p.turnId !== this.turn) return [];
    const kind = method === "item/started" ? "start" : method === "item/completed" ? "complete"
      : method === "item/agentMessage/delta" ? "delta" : undefined;
    if (!kind) return [];
    const item = p.item;
    if (kind !== "delta" && item?.type !== "agentMessage") return [];
    const id = kind === "delta" ? p.itemId : item?.id;
    if (typeof id !== "string" || !id || id.length > 256) return [];
    if (kind === "start") {
      if (this.items.size >= 64 || this.items.has(id)) return [];
      this.items.set(id, item.phase === "final_answer" || item.phase === "commentary" ? item.phase : "unknown");
    }
    const known = this.items.get(id);
    if (!known) return [];
    const phase = kind === "complete" && (item.phase === "final_answer" || item.phase === "commentary") ? item.phase : known;
    const text = kind === "delta" ? p.delta : item.text;
    if (kind === "complete") this.items.delete(id);
    return typeof text === "string" ? [{ type: "response_text", providerTurnId: this.turn,
      itemId: id, phase, kind, text }] : [];
  }
}
