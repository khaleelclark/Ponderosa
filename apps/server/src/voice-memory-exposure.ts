import { createHash } from "node:crypto";
import type { AgentStore } from "@ponderosa/agents";
import type { VoiceReplyStatus } from "@ponderosa/core";
import { MemoryAuthority, type MemoryAuthorityPorts } from "./memory-authority.js";

type Exposure = NonNullable<VoiceReplyStatus["memoryExposure"]>;
/** Complete canonical event projection, never a bounded recent-event window. */
export function memorySessionResetSeq(store: AgentStore, agentId: string): number {
  return (store.sqlite.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE agent_id=? AND type='session_reset'").get(agentId) as { seq: number }).seq;
}
const scopeKey = (scope: { kind: string; projectId?: string; principalId?: string }) =>
  scope.kind === "project" ? `project:${scope.projectId}` : `global:${scope.principalId}`;

/** Status only. No text, record identifiers, principal IDs or write capability leave this boundary. */
export function voiceMemoryExposure(ports: MemoryAuthorityPorts, input: {
  agentId: string; projectId: string; conversationId: string; messageId: string; runId?: string;
}): Exposure {
  const invalid: Exposure = { state: "invalid", ...(input.runId ? { runId: input.runId } : {}) };
  if (!input.runId) return { state: "pending" };
  try {
    return ports.store.sqlite.transaction((): Exposure => {
      const db = ports.store.sqlite;
      const run = db.prepare("SELECT fencing_token FROM scheduler_runs WHERE id=? AND agent_id=? AND project_id=?").get(
        input.runId, input.agentId, input.projectId) as { fencing_token: number } | undefined;
      if (!run) return invalid;
      const memory = new MemoryAuthority(ports).forPlayback({ ...input, runId: input.runId!, fencingToken: run.fencing_token });
      // Resolve live owner/Run/policy even for confirmed no-memory packets.
      const current = memory.scopeGenerations();
      const packet = db.prepare(`SELECT scheduler_run_id,agent_id,project_id,provider_prompt,prompt_hash,source_manifest_json
        FROM provider_inputs WHERE execution_id=?`).get(input.runId) as {
          scheduler_run_id: string; agent_id: string; project_id: string; provider_prompt: string; prompt_hash: string; source_manifest_json: string;
        } | undefined;
      if (!packet || !db.prepare("SELECT 1 FROM scheduler_prompt_injections WHERE run_id=? AND kind='turn' AND state IN ('submitted','acknowledged') AND submitted_at IS NOT NULL").get(input.runId)) return { state: "pending", runId: input.runId };
      if (packet.scheduler_run_id !== input.runId || packet.agent_id !== input.agentId || packet.project_id !== input.projectId ||
          createHash("sha256").update(packet.provider_prompt).digest("hex") !== packet.prompt_hash) return invalid;
      const manifest = JSON.parse(packet.source_manifest_json);
      if (manifest?.schemaVersion !== 3 || manifest.conversationId !== input.conversationId ||
          !Number.isSafeInteger(manifest.memorySessionResetSeq) || manifest.memorySessionResetSeq < 0 ||
          manifest.memorySessionResetSeq !== memorySessionResetSeq(ports.store, input.agentId) ||
          !Array.isArray(manifest.memoryScopes) || !Array.isArray(manifest.sources) ||
          !Array.isArray(manifest.communicationEventIds) || !manifest.communicationEventIds.includes(input.messageId)) return invalid;
      const scopes = manifest.memoryScopes as Array<{ scope: { kind: string; projectId?: string; principalId?: string }; generation: number }>;
      if (scopes.length > 2 || scopes.some(s => !s?.scope || !["project", "global"].includes(s.scope.kind) ||
          !Number.isSafeInteger(s.generation) || s.generation < 0 ||
          (s.scope.kind === "project" ? s.scope.projectId !== input.projectId : typeof s.scope.principalId !== "string"))) return invalid;
      const sources = manifest.sources.filter((s: { kind?: string }) => s?.kind === "memory");
      if (!scopes.length) return sources.length ? invalid : { state: "disabled", runId: input.runId, sessionResetSeq: manifest.memorySessionResetSeq };
      if (!ports.opts.memoryEnabled || scopes.length !== current.length || new Set(scopes.map(s => scopeKey(s.scope))).size !== scopes.length ||
          scopes.some(s => !current.some(c => scopeKey(c.scope) === scopeKey(s.scope) && c.generation === s.generation))) return invalid;
      for (const source of sources) {
        if (!source || typeof source.ref !== "string" || source.delivery !== "submitted" || !source.scope ||
            !Number.isSafeInteger(source.revision) || source.revision < 1 || !Number.isSafeInteger(source.generation) ||
            typeof source.hash !== "string" || !scopes.some(s => scopeKey(s.scope) === scopeKey(source.scope))) return invalid;
        const record = memory.hydrate([{ memoryId: source.ref, revision: source.revision, generation: source.generation }])[0];
        if (!record || record.textHash !== source.hash || scopeKey(record.scope) !== scopeKey(source.scope)) return invalid;
        // Memory DTOs filter source links independently. Automatic exposure must
        // also deny a selected record whose original provenance is now private.
        const provenance = db.prepare("SELECT sources_json FROM memory_revisions WHERE memory_id=? AND revision=?").get(source.ref, source.revision) as { sources_json: string } | undefined;
        if (!provenance || JSON.parse(provenance.sources_json).length !== record.sources.length) return invalid;
      }
      return { state: "valid", runId: input.runId, sessionResetSeq: manifest.memorySessionResetSeq,
        ...Object.fromEntries(scopes.map(s => [s.scope.kind === "project" ? "projectGeneration" : "globalGeneration", s.generation])) };
    })();
  } catch { return invalid; }
}
