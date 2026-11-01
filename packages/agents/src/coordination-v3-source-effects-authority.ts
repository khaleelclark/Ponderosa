import type Database from "better-sqlite3";
import type { SourceEffectBoundary, SourceEffectEvidence, SourceEffectInventory, SourceEffectReconcileInput, SourceEffectReconcileReceipt } from "@ponderosa/core";
import { payloadHash, stableJson } from "./coordination-v3-canonical-json.js";

export class SourceEffectConflictError extends Error {}
interface SourceRun {
  project_id: string; scope_key: string; provider_session_id: string | null;
  status: string; fencing_token: number;
}
/** SQLite host receipts resolve only their exact original effects. Provider
 * telemetry is inspectable evidence, never authority to declare an external
 * write complete. No Run, Request, publication or provider command is replayed. */
export class CoordinationV3SourceEffectsAuthority {
  constructor(private readonly sqlite: Database.Database) {}

  inspect(boundary: SourceEffectBoundary): SourceEffectInventory {
    return this.sqlite.transaction(() => this.inventory(boundary))();
  }

  private inventory(boundary: SourceEffectBoundary): SourceEffectInventory {
    if (!boundary.agentId || !boundary.sourceRunId || !Number.isSafeInteger(boundary.sourceFence) || boundary.sourceFence < 1) {
      throw new SourceEffectConflictError("Exact original Agent, Run and positive fence required");
    }
    const source = this.sqlite.prepare(`SELECT project_id,scope_key,provider_session_id,status,fencing_token
      FROM scheduler_runs WHERE id=? AND agent_id=?`).get(boundary.sourceRunId,boundary.agentId) as SourceRun | undefined;
    if (!source || source.fencing_token !== boundary.sourceFence || source.status !== "outcome_unknown") {
      throw new SourceEffectConflictError("Exact original uncertain Run/fence changed or unavailable");
    }
    if (this.sqlite.prepare("SELECT 1 FROM provider_process_authority WHERE run_id=? LIMIT 1").get(boundary.sourceRunId)) {
      throw new SourceEffectConflictError("Original provider process custody has not drained");
    }
    const effects: SourceEffectEvidence[] = [];
    const add = (kind: SourceEffectEvidence["kind"], row: Record<string, unknown>, outcome: SourceEffectEvidence["outcome"], detail: string) => {
      const id = String(row.id);
      effects.push({id:`${kind}:${id}`,kind,outcome,receiptId:id,receiptHash:payloadHash(row),detail,
        ...(typeof row.tool_call_id === "string" ? {toolCallId:row.tool_call_id} : {}),
        ...(typeof row.request_id === "string" ? {requestId:row.request_id} : {}),
        ...(typeof row.resulting_state === "string" ? {resultingState:row.resulting_state} : {}),
        ...(typeof row.resulting_version === "number" ? {resultingVersion:row.resulting_version} : {})});
    };
    // Sender/actor execution bindings originate in the host publication paths,
    // not in tool-result prose or a nearby timestamp.
    const communications = this.sqlite.prepare(`SELECT id,payload_hash,sender_json,intent,audience_json,payload_json
      FROM runtime_communications WHERE project_id=? AND json_extract(sender_json,'$.agentId')=?
        AND json_extract(sender_json,'$.executionId')=? ORDER BY id`)
      .all(source.project_id,boundary.agentId,boundary.sourceRunId) as Record<string,unknown>[];
    for (const row of communications) add("communication",row,"host_committed","Canonical Communication committed; recipient processing is not implied");
    const updates = this.sqlite.prepare(`SELECT u.id,u.request_id,u.kind,u.payload_hash,u.payload_json,u.resulting_state,u.resulting_version
      FROM coordination_request_updates u JOIN coordination_requests r ON r.id=u.request_id
      WHERE r.project_id=? AND u.actor_kind='agent' AND u.actor_id=?
        AND json_extract(u.payload_json,'$.executionId')=? ORDER BY u.id`)
      .all(source.project_id,boundary.agentId,boundary.sourceRunId) as Record<string,unknown>[];
    for (const row of updates) add("request_update",row,"host_committed","Canonical Request update committed at its recorded version; current Request state may differ");
    const coordination = this.sqlite.prepare(`SELECT idempotency_key AS id,payload_hash,result_json
      FROM coordination_idempotency WHERE project_id=? AND actor_scope=? AND operation='coordinate' ORDER BY idempotency_key`)
      .all(source.project_id,`agent:${boundary.agentId}:run:${boundary.sourceRunId}`) as Record<string,unknown>[];
    for (const row of coordination) add("coordination",row,"host_committed","Request/Join creation transaction committed; delegated work completion is not implied");
    const imports = this.sqlite.prepare(`SELECT r.artifact_id AS id,r.tool_call_id,r.request_hash,r.projected,a.blob_hash,a.byte_length
      FROM generated_artifact_import_receipts r JOIN generated_artifact_authority a
        ON a.project_id=r.project_id AND a.id=r.artifact_id
      WHERE r.project_id=? AND r.run_id=? AND a.origin_agent_id=? AND a.execution_id=? ORDER BY r.artifact_id`)
      .all(source.project_id,boundary.sourceRunId,boundary.agentId,boundary.sourceRunId) as Record<string,unknown>[];
    for (const row of imports) add("artifact_import",row,"host_committed","Managed artifact import committed; original file or external publication state is not implied");
    const deliveries = this.sqlite.prepare(`SELECT id,payload_hash,recipient_agent_ids_json FROM communication_v4_next_run_deliveries
      WHERE project_id=? AND publisher_kind='agent' AND publisher_agent_id=? AND source_run_id=? ORDER BY id`)
      .all(source.project_id,boundary.agentId,boundary.sourceRunId) as Record<string,unknown>[];
    for (const row of deliveries) add("queued_delivery",row,"host_committed","Next-Run information committed; recipient delivery is not implied");
    // Read full canonical event bytes, using the existing execution projection
    // solely for its host-selected Run binding. Never return input/output prose.
    const telemetry = this.sqlite.prepare(`SELECT e.id,e.seq,e.type,e.payload_json FROM events e JOIN activity_projection p
      ON p.agent_id=e.agent_id AND p.seq=e.seq
      WHERE e.agent_id=? AND p.execution_id=? AND e.type IN ('tool_call','tool_result','command','file_change') ORDER BY e.seq`)
      .all(boundary.agentId,boundary.sourceRunId) as {id:string;seq:number;type:"tool_call"|"tool_result"|"command"|"file_change";payload_json:string}[];
    for (const row of telemetry) {
      const event = JSON.parse(row.payload_json) as {id?:unknown};
      add(row.type,{...row,...(typeof event.id === "string" ? {tool_call_id:event.id} : {})},"unknown",
        "Provider telemetry does not prove an external effect or authorize retry");
    }
    effects.sort((a,b)=>a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const facts = {...boundary,projectId:source.project_id,scopeKey:source.scope_key,providerSessionId:source.provider_session_id,
      sourceStatus:"outcome_unknown" as const,effects,nativeTail:"unknown" as const,sourceWork:"held_unknown" as const,replayAuthorized:false as const};
    return {...facts,inventoryHash:payloadHash(facts)};
  }

  /** Read by command key after any uncertain HTTP result; no mutation/replay. */
  recorded(boundary: SourceEffectBoundary, key: string): SourceEffectReconcileReceipt | undefined {
    if (!boundary.agentId || !boundary.sourceRunId || !Number.isSafeInteger(boundary.sourceFence) || boundary.sourceFence < 1 ||
        typeof key !== "string" || !key.trim() || key.length > 200) throw new SourceEffectConflictError("Exact boundary and command key required");
    const row = this.sqlite.prepare(`SELECT result_json FROM coordination_idempotency
      WHERE actor_scope=? AND operation='source_effects_reconcile' AND idempotency_key=?`)
      .get(`operator:source-effects:${payloadHash(boundary)}`,key) as {result_json:string}|undefined;
    return row ? JSON.parse(row.result_json) as SourceEffectReconcileReceipt : undefined;
  }

  reconcile(boundary: SourceEffectBoundary, input: SourceEffectReconcileInput): {receipt:SourceEffectReconcileReceipt;replayed:boolean} {
    if (!input || !Number.isSafeInteger(input.sourceFence) || input.sourceFence !== boundary.sourceFence ||
        typeof input.expectedInventoryHash !== "string" || !/^[a-f0-9]{64}$/u.test(input.expectedInventoryHash) ||
        typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200) {
      throw new SourceEffectConflictError("Exact original fence, inventory hash and command key required");
    }
    return this.sqlite.transaction(() => {
      const actorScope = `operator:source-effects:${payloadHash(boundary)}`;
      const hash = payloadHash({boundary,input});
      const prior = this.sqlite.prepare(`SELECT payload_hash,result_json FROM coordination_idempotency
        WHERE actor_scope=? AND operation='source_effects_reconcile' AND idempotency_key=?`)
        .get(actorScope,input.idempotencyKey) as {payload_hash:string;result_json:string}|undefined;
      if (prior) {
        if (prior.payload_hash !== hash) throw new SourceEffectConflictError("Reconciliation key belongs to a different inventory");
        return {receipt:JSON.parse(prior.result_json) as SourceEffectReconcileReceipt,replayed:true};
      }
      const inventory = this.inventory(boundary);
      if (inventory.inventoryHash !== input.expectedInventoryHash) throw new SourceEffectConflictError("Original effect inventory changed; read it again before reconciliation");
      const receipt: SourceEffectReconcileReceipt = {inventory,reconciledAt:new Date().toISOString(),
        disposition:"host_receipts_reconciled_external_unknown",replayAuthorized:false};
      this.sqlite.prepare(`INSERT INTO coordination_idempotency
        (project_id,actor_scope,operation,idempotency_key,payload_hash,result_json,created_at) VALUES (?,?,'source_effects_reconcile',?,?,?,?)`)
        .run(inventory.projectId,actorScope,input.idempotencyKey,hash,stableJson(receipt),receipt.reconciledAt);
      // No scheduler/request/context mutation: unknown external work remains held.
      return {receipt,replayed:false};
    })();
  }
}
