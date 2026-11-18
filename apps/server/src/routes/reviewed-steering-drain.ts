import type { FastifyInstance } from "fastify";
import type { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import { stableJson } from "@ponderosa/agents";
import { createHash } from "node:crypto";
import type { ActiveRun, PersistentRuntime } from "../app-contracts.js";
import type { ProviderProcessAuthority } from "../provider-process-authority.js";

type Dependencies = {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  providerProcessAuthority: ProviderProcessAuthority;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  persistentRuntimeForTermination(agentId:string):PersistentRuntime|undefined;
  teardownPersistentRuntime(agentId:string,runtime:PersistentRuntime,reason:string,projectId?:string):Promise<void>;
  projectDeletionInProgress(projectId:string):boolean;
  agentDeletionInProgress(agentId:string):boolean;
};

/** Explicitly retire only the exact idle provider belonging to the reviewed
 * source Run. This does not authorize continuation or resolve its effects. */
export function registerReviewedSteeringDrain(app:FastifyInstance,deps:Dependencies):void {
 app.post<{Params:{projectId:string;activationId:string}}>(
  "/api/projects/:projectId/message-deliveries/:activationId/reviewed-continuation/retire-source", async (request,reply)=>{
   const {projectId,activationId}=request.params;
   try {
    const target=deps.coordinationV3.reviewedSteeringDrainTarget(projectId,activationId);
    const assertIdle=()=>{
     if(deps.projectDeletionInProgress(projectId)||deps.agentDeletionInProgress(target.agentId)||deps.activeRuns.has(target.agentId))
      throw Error("The Agent is active or being removed; its provider was not retired.");
     const current=deps.coordinationV3.reviewedSteeringDrainTarget(projectId,activationId);
     if(stableJson(current)!==stableJson(target))throw Error("The source Run changed; review it again.");
    };
    assertIdle();
    const runtime=deps.persistentRuntimeForTermination(target.agentId);
    if(runtime) {
     const identity=runtime.session.processIdentity;
     if(!identity)throw Error("The idle provider cannot be matched to its source Run on this platform.");
     const row=deps.store.sqlite.prepare(`SELECT id FROM provider_process_authority
       WHERE worker_id=? AND project_id=? AND agent_id=? AND run_id=? AND pid=? AND pgid=? AND birth_marker=?`)
       .get(deps.providerProcessAuthority.workerId,projectId,target.agentId,target.runId,identity.pid,identity.pgid,identity.birthMarker) as {id:string}|undefined;
     if(!row)throw Error("The idle provider does not match the exact source Run.");
     const receipts=deps.store.sqlite.prepare(`SELECT identity,input_json,receipt_json,receipt_sha256 FROM host_lifecycle_commits
       WHERE kind='provider-process-registration' AND json_extract(receipt_json,'$.authorityId')=? LIMIT 4097`).all(row.id) as Array<{identity:string;input_json:string;receipt_json:string;receipt_sha256:string}>;
     if(receipts.length>4096||!receipts.some(r=>{
      const value=JSON.parse(r.receipt_json);
      return r.input_json===r.receipt_json&&stableJson(value)===r.receipt_json&&createHash('sha256').update(stableJson(value)).digest('hex')===r.receipt_sha256&&
       r.identity===row.id+':'+r.receipt_sha256&&value.schema==='provider-process-registration.v1'&&
       value.workerId===deps.providerProcessAuthority.workerId&&value.projectId===projectId&&value.agentId===target.agentId&&
       value.runId===target.runId&&value.runFence===target.fence&&value.process?.kind==='posix'&&stableJson(value.process.identity)===stableJson(identity);
     })) throw Error("The exact source provider registration is unavailable.");
     assertIdle();
     // Detach the exact held runtime synchronously before yielding to any
     // other local request; teardown retains authority until observed exit.
     await deps.teardownPersistentRuntime(target.agentId,runtime,"reviewed source provider retirement",projectId);
    }
    deps.providerProcessAuthority.pruneExited();
    assertIdle();
    if(deps.store.sqlite.prepare("SELECT 1 FROM provider_process_authority WHERE agent_id=? LIMIT 1").get(target.agentId))
     throw Error("A provider for this Agent has not exited; review remains held.");
    return {status:"source_retired",originalOutcome:"unknown"};
   } catch(error) {
    return reply.code(409).send({error:error instanceof Error?error.message:"The source provider remains held."});
   }
  });
}
