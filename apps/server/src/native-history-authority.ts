import { createHash, randomUUID } from "node:crypto";
import type { AgentStore } from "@ponderosa/agents";
import type { NativeTranscriptSeed } from "@ponderosa/core";
export const historyHash = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");
import type { HistoryBoundary, HistoryReceipt, NativeHistoryTrackingPreference } from "@ponderosa/core";
export type { HistoryBoundary, HistoryReceipt } from "@ponderosa/core";
/** Durable once-only host reservation; never a native idempotency guarantee. */
export class NativeHistoryAuthority {
  constructor(private readonly store:AgentStore) {}
  tracking(agentId:string):NativeHistoryTrackingPreference {
    const row=this.store.sqlite.prepare("SELECT result_json FROM coordination_idempotency WHERE actor_scope=? AND operation='native_history_tracking' AND idempotency_key='preference'").get(`operator:native-history:${agentId}`) as {result_json:string}|undefined;
    return row?JSON.parse(row.result_json):{enabled:false,appliesTo:"next_native_session"};
  }
  setTracking(agentId:string,enabled:boolean):NativeHistoryTrackingPreference {
    const agent=this.store.getAgent(agentId);
    if(!agent||agent.activeEngine!=='claude')throw new Error("Claude tracking preference unavailable");
    const preference:NativeHistoryTrackingPreference={enabled,appliesTo:"next_native_session",updatedAt:new Date().toISOString()};
    this.store.sqlite.prepare(`INSERT INTO coordination_idempotency(project_id,actor_scope,operation,idempotency_key,payload_hash,result_json,created_at)
      VALUES (?,?,'native_history_tracking','preference',?,?,?) ON CONFLICT(actor_scope,operation,idempotency_key) DO UPDATE SET payload_hash=excluded.payload_hash,result_json=excluded.result_json,created_at=excluded.created_at`)
      .run(agent.projectId,`operator:native-history:${agentId}`,historyHash(preference),JSON.stringify(preference),preference.updatedAt!);
    return preference;
  }
  read(agentId:string,key:string):HistoryReceipt|undefined {
    const row=this.store.sqlite.prepare("SELECT result_json FROM coordination_idempotency WHERE actor_scope=? AND operation='native_history' AND idempotency_key=?")
      .get(`operator:native-history:${agentId}`,key) as {result_json:string}|undefined;
    return row?JSON.parse(row.result_json):undefined;
  }
  held(agentId:string):boolean {
    return Boolean(this.store.sqlite.prepare(`SELECT 1 FROM coordination_idempotency WHERE operation='native_history'
      AND json_extract(result_json,'$.state') IN ('prepared','started')
      AND (json_extract(result_json,'$.boundary.agentId')=? OR json_extract(result_json,'$.targetAgentId')=?) LIMIT 1`).get(agentId,agentId));
  }
  reserve(boundary:HistoryBoundary,key:string,kind:HistoryReceipt['kind'],input:unknown,extra:Partial<HistoryReceipt>={}):{receipt:HistoryReceipt;replayed:boolean} {
    return this.store.sqlite.transaction(()=>{
      const hash=historyHash({boundary,kind,input});
      const prior=this.read(boundary.agentId,key);
      if(prior) {if(prior.inputHash!==hash)throw new Error("Native history command key conflicts");return {receipt:prior,replayed:true};}
      if(this.held(boundary.agentId)||extra.targetAgentId&&this.held(extra.targetAgentId))throw new Error("An earlier native history operation is held; inspect its original key");
      const receipt:HistoryReceipt={...extra,id:randomUUID(),key,kind,boundary,inputHash:hash,createdAt:new Date().toISOString(),state:kind==='fork'?'prepared':'started'};
      this.store.sqlite.prepare(`INSERT INTO coordination_idempotency(project_id,actor_scope,operation,idempotency_key,payload_hash,result_json,created_at)
        VALUES (?,?,'native_history',?,?,?,?)`).run(boundary.projectId,`operator:native-history:${boundary.agentId}`,key,hash,JSON.stringify(receipt),receipt.createdAt);
      return {receipt,replayed:false};
    })();
  }
  save(receipt:HistoryReceipt,state:HistoryReceipt['state'],result?:import("@ponderosa/core").NativeHistoryResult,patch:Partial<HistoryReceipt>={}):HistoryReceipt {
    const next={...receipt,...patch,state,...(result!==undefined?{result}:{})};
    const changed=this.store.sqlite.prepare(`UPDATE coordination_idempotency SET result_json=? WHERE actor_scope=? AND operation='native_history'
      AND idempotency_key=? AND result_json=?`).run(JSON.stringify(next),`operator:native-history:${receipt.boundary.agentId}`,receipt.key,JSON.stringify(receipt));
    if(changed.changes!==1)throw new Error("Native history receipt changed; outcome unknown");
    return next;
  }
  cancel(agentId:string,key:string):HistoryReceipt {
    const r=this.read(agentId,key);
    if(!r||r.kind!=='fork'||r.state!=='prepared')throw new Error("Only a not-started fork preparation can be cancelled");
    return this.save(r,'cancelled');
  }
  /** Called only by the destination's real scheduler Run, before provider open. */
  takeSeed(agentId:string,runId:string,fence:number,resumeSessionId:string|undefined,humanMessage=false):{seed:NativeTranscriptSeed;receipt:HistoryReceipt;assertCurrent():void;observed(sessionId:string):void;opened(sessionId:string):void}|undefined {
    return this.store.sqlite.transaction(()=>{
      if(this.store.sqlite.prepare(`SELECT 1 FROM coordination_idempotency WHERE operation='native_history'
        AND json_extract(result_json,'$.boundary.agentId')=? AND json_extract(result_json,'$.state') IN ('prepared','started') LIMIT 1`).get(agentId))throw new Error("Source has a reserved native history operation");
      const target=(this.store.sqlite.prepare(`SELECT result_json FROM coordination_idempotency WHERE operation='native_history'
        AND json_extract(result_json,'$.targetAgentId')=? AND json_extract(result_json,'$.state')!='cancelled' LIMIT 2`).all(agentId) as {result_json:string}[]).map(r=>JSON.parse(r.result_json) as HistoryReceipt);
      if(!target.length)return undefined;
      if(target.length!==1)throw new Error("Ambiguous transcript seed ownership");
      let receipt=target[0]!;
      if(receipt.state==='opened'&&resumeSessionId===receipt.newSessionId)return undefined;
      if(!humanMessage)throw new Error("A new canonical human message must open the prepared transcript context");
      if(!fence||!Number.isSafeInteger(fence)||receipt.state!=='prepared'||resumeSessionId)throw new Error("Transcript seed already started or uncertain; never repeat fork");
      const source=this.store.getAgent(receipt.boundary.agentId),destination=this.store.getAgent(agentId);
      if(!source||!destination||source.projectId!==destination.projectId||source.conversationId!==destination.conversationId||source.activeEngine!==destination.activeEngine||
         destination.workingCopy.rootPath!==receipt.boundary.rootPath||this.store.resumeSessionId(agentId))throw new Error("Fresh destination ownership changed");
      const assertCurrent=()=>{
        const live=this.read(receipt.boundary.agentId,receipt.key);
        const current=this.store.providerCommandContextBoundary(receipt.boundary.agentId);
        const b=receipt.boundary;
        const s=this.store.getAgent(b.agentId),t=this.store.getAgent(agentId);
        if(!s||!t||s.activeEngine!==b.engine||t.activeEngine!==b.engine||s.conversationId!==b.conversationId||t.conversationId!==b.conversationId||s.workingCopy.rootPath!==b.rootPath||t.workingCopy.rootPath!==b.rootPath||!live||live.id!==receipt.id||!['prepared','started'].includes(live.state)||!current||
           current.providerSessionId!==b.sessionId||current.executionId!==b.runId||current.fencingToken!==b.fence||current.toolContractHash!==b.toolContractHash||
           this.store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running')").get(b.agentId)||
           !this.store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND agent_id=? AND fencing_token=? AND status='running' AND side_effects_fenced_at IS NULL AND lease_expires_at>?").get(runId,agentId,fence,new Date().toISOString()))throw new Error("Transcript source or destination fence changed");
      };
      assertCurrent();
      receipt={...receipt,targetRunId:runId,targetFence:fence};
      // Preserve compare-and-swap bytes of the prepared row before attaching Run.
      const prior=target[0]!;
      const started={...receipt,state:'started' as const};
      const changed=this.store.sqlite.prepare("UPDATE coordination_idempotency SET result_json=? WHERE actor_scope=? AND operation='native_history' AND idempotency_key=? AND result_json=?")
        .run(JSON.stringify(started),`operator:native-history:${prior.boundary.agentId}`,prior.key,JSON.stringify(prior));
      if(changed.changes!==1)throw new Error("Transcript seed reservation changed");
      receipt=started;
      return {receipt,seed:{sourceSessionId:receipt.boundary.sessionId,throughId:receipt.throughId!,newSessionId:receipt.newSessionId!},assertCurrent,
        observed:(sessionId:string)=>{assertCurrent();receipt=this.save(receipt,'started',{nativeSessionId:sessionId,contextAccepted:false,replayAuthorized:false},{newSessionId:sessionId});},
        opened:(sessionId:string)=>{assertCurrent();receipt=this.save(receipt,'opened',
          {nativeSessionId:sessionId,contextAccepted:false,replayAuthorized:false},{newSessionId:sessionId});}
      };
    })();
  }
}
