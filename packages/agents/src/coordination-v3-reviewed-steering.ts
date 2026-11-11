import type Database from "better-sqlite3";
import { activeAgentOwnerSql, activeChatOwnerSql } from "./product-scope-sql.js";
import { CoordinationV3SourceEffectsAuthority } from "./coordination-v3-source-effects-authority.js";
import { payloadHash, stableJson } from "./coordination-v3-canonical-json.js";
import { requireProviderStartsDrained } from "./provider-start-journal.js";
import { hasOutstandingDelegation } from "./coordination-v3-task-lineage.js";
import type { CreateActivationV3Input } from "./coordination-v3-runtime-communication-authority.js";

/** The human's new instruction continues one reviewed task; it never resolves
 * the old delivery or asserts anything about its external effects. */
export class ReviewedSteeringAuthority {
  constructor(private readonly db: Database.Database, private readonly create: (i: CreateActivationV3Input) => string) {}

  /** Later failed preparations do not own provider work. Keep every Run and
   * activation intact, and fail closed if any provider boundary was crossed. */
  private laterUnsubmittedRuns(agentId:string, sourceRowId:number, ownRunId = "") {
    if(this.db.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND id<>? AND status IN ('leased','running') LIMIT 1").get(agentId,ownRunId))
      throw Error("The original provider, a later Run, or context refresh remains active or unconfirmed.");
    const rows=this.db.prepare(`SELECT id,project_id,status,prompt_injection_state,provider_session_id,fencing_token,started_at,terminal_at
      FROM scheduler_runs WHERE agent_id=? AND id<>? AND rowid>? ORDER BY rowid LIMIT 4097`)
      .all(agentId,ownRunId,sourceRowId) as Array<{id:string;project_id:string;status:string;prompt_injection_state:string;provider_session_id:string|null;fencing_token:number;started_at:string|null;terminal_at:string|null}>;
    if(rows.length>4096)throw Error("Later Run evidence exceeds the supported review bound.");
    for(const run of rows){
      if(run.status!=='failed' || run.prompt_injection_state!=='not_injected' || run.provider_session_id!==null ||
         run.started_at!==null || !run.terminal_at ||
         this.db.prepare("SELECT 1 FROM provider_inputs WHERE scheduler_run_id=? OR execution_id=? LIMIT 1").get(run.id,run.id) ||
         this.db.prepare("SELECT 1 FROM provider_operation_outbox WHERE run_id=? UNION ALL SELECT 1 FROM provider_process_authority WHERE run_id=? LIMIT 1").get(run.id,run.id) ||
         this.db.prepare(`SELECT 1 FROM runtime_communications WHERE project_id=? AND json_extract(sender_json,'$.agentId')=?
             AND json_extract(sender_json,'$.executionId')=?
           UNION ALL SELECT 1 FROM coordination_request_updates u JOIN coordination_requests r ON r.id=u.request_id
             WHERE r.project_id=? AND u.actor_kind='agent' AND u.actor_id=? AND json_extract(u.payload_json,'$.executionId')=?
           UNION ALL SELECT 1 FROM coordination_idempotency WHERE project_id=? AND actor_scope=? AND operation='coordinate'
           UNION ALL SELECT 1 FROM generated_artifact_import_receipts r JOIN generated_artifact_authority a
             ON a.project_id=r.project_id AND a.id=r.artifact_id WHERE r.project_id=? AND r.run_id=?
               AND a.origin_agent_id=? AND a.execution_id=?
           UNION ALL SELECT 1 FROM communication_v4_next_run_deliveries WHERE project_id=? AND publisher_kind='agent'
             AND publisher_agent_id=? AND source_run_id=?
           UNION ALL SELECT 1 FROM events e JOIN activity_projection p ON p.agent_id=e.agent_id AND p.seq=e.seq
             WHERE e.agent_id=? AND p.execution_id=? AND e.type IN ('tool_call','tool_result','command','file_change','work_start','text','reasoning')
           UNION ALL SELECT 1 FROM run_output_segments WHERE agent_id=? AND execution_id=?
           LIMIT 1`).get(run.project_id,agentId,run.id,run.project_id,agentId,run.id,
             run.project_id,`agent:${agentId}:run:${run.id}`,run.project_id,run.id,agentId,run.id,
             run.project_id,agentId,run.id,agentId,run.id,agentId,run.id) ||
         this.db.prepare(`SELECT 1 FROM scheduler_prompt_injections WHERE run_id=? AND
           (state NOT IN ('pending','cancelled') OR submitted_at IS NOT NULL OR acknowledged_at IS NOT NULL OR provider_turn_id IS NOT NULL) LIMIT 1`).get(run.id) ||
         this.db.prepare(`SELECT 1 FROM host_lifecycle_commits WHERE kind IN ('provider-start-admission','provider-process-registration')
           AND json_extract(receipt_json,'$.runId')=? LIMIT 1`).get(run.id))
        throw Error("A later Run has provider work or uncertain submission and remains held.");
    }
    return rows;
  }

  private evidence(kind:string, identity:string):any {
    const row=this.db.prepare("SELECT input_json,receipt_json,receipt_sha256 FROM host_lifecycle_commits WHERE kind=? AND identity=?")
      .get(kind,identity) as {input_json:string;receipt_json:string;receipt_sha256:string}|undefined;
    if(!row || Buffer.byteLength(row.receipt_json)>4*1024*1024)throw Error("Provider evidence is unavailable.");
    const value=JSON.parse(row.receipt_json);
    if(row.input_json!==row.receipt_json || stableJson(value)!==row.receipt_json || payloadHash(value)!==row.receipt_sha256)
      throw Error("Provider evidence integrity check failed.");
    return value;
  }

  private current(projectId:string,activationId:string, owner?:{activationId:string;runId?:string;ownStart?:{identity:string;authorityId:string;fence:number;workerId:string;processIdentity:{pid:number;pgid:number;birthMarker:string}}}) {
    const rows=this.db.prepare(`SELECT a.id,a.agent_id,a.project_id,a.scope_key,a.payload_json,i.id injection_id,i.run_id,
      i.activation_ids_json,r.status,r.fencing_token,r.rowid run_rowid,ag.conversation_id,ag.deleted_at
      FROM agent_activations a JOIN scheduler_prompt_injections i ON i.kind='steer' AND i.state='outcome_unknown'
        AND EXISTS(SELECT 1 FROM json_each(i.activation_ids_json) m WHERE m.value=a.id)
      JOIN scheduler_runs r ON r.id=i.run_id AND r.agent_id=a.agent_id AND r.project_id=a.project_id AND r.scope_key=a.scope_key
      JOIN agents ag ON ag.id=a.agent_id AND ag.project_id=a.project_id
      WHERE a.id=? AND a.project_id=? AND a.kind='human_message' AND a.prompt_class='human' AND ${activeAgentOwnerSql('ag')}`).all(activationId,projectId) as any[];
    if(rows.length!==1)throw Error("The exact uncertain instruction is unavailable or has multiple attempts.");
    const a=rows[0], payload=JSON.parse(a.payload_json), members=JSON.parse(a.activation_ids_json);
    if(a.deleted_at || payload.communication?.sender?.kind!=="user" || payload.communication?.sender?.userId!=="local-operator" || !["broadcast","user_dm"].includes(payload.communication?.intent))
      throw Error("The original user instruction is unavailable.");
    const chat=this.db.prepare(`SELECT project_id FROM conversations chat WHERE chat.id=? AND ${activeChatOwnerSql('chat')}`).get(a.conversation_id) as any;
    if(!chat || chat.project_id!==projectId || a.scope_key!=="conversation:"+a.conversation_id)
      throw Error("The original Chat is unavailable.");
    if(!["completed","outcome_unknown"].includes(a.status) || !Number.isSafeInteger(a.fencing_token) || a.fencing_token<1)
      throw Error("The original Run must finish before continuation.");
    if(!Array.isArray(members)||members.length!==1||members[0]!==activationId ||
      (this.db.prepare("SELECT COUNT(*) n FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state IN ('pending','submitted','outcome_unknown')").get(a.run_id) as any).n!==1)
      throw Error("Multiple uncertain interruptions require separate review.");
    if(owner?.runId && !this.db.prepare(`SELECT 1 FROM scheduler_runs r JOIN scheduler_run_activations attached ON attached.run_id=r.id
      JOIN activation_sources source ON source.activation_id=attached.activation_id AND source.source_kind='reviewed_steering'
      WHERE r.id=? AND r.agent_id=? AND r.project_id=? AND r.scope_key=? AND r.status IN ('leased','running') AND r.side_effects_fenced_at IS NULL
      AND attached.activation_id=? AND source.source_id=?`).get(owner.runId,a.agent_id,projectId,a.scope_key,owner.activationId,a.injection_id))
      throw Error("The reviewed continuation no longer owns its exact Run.");
    if(owner && !owner.runId && !this.db.prepare("SELECT 1 FROM agent_activations WHERE id=? AND project_id=? AND agent_id=? AND scope_key=? AND state IN ('pending','retry_pending')")
      .get(owner.activationId,projectId,a.agent_id,a.scope_key)) throw Error("The reviewed continuation is no longer pending.");
    const laterUnsubmittedRuns=this.laterUnsubmittedRuns(a.agent_id,a.run_rowid,owner?.runId);
    if(this.db.prepare("SELECT 1 FROM provider_process_authority WHERE agent_id=? AND id<>? LIMIT 1").get(a.agent_id,owner?.ownStart?.authorityId ?? "") ||
       this.db.prepare("SELECT 1 FROM context_rollovers WHERE agent_id=? AND state IN ('requested','handoff_committed','session_retiring','continuation_ready','outcome_unknown') LIMIT 1").get(a.agent_id))
      throw Error("The original provider, a later Run, or context refresh remains active or unconfirmed.");
    const roots=this.db.prepare(`SELECT source_activation_id,reply_authority_json,attempt_count,delivery_phase,interim_communication_id,blocking_decision_id
      FROM required_reply_obligations WHERE run_id=? AND agent_id=? AND project_id=? AND scope_key=? AND state IN ('pending','recovery_pending','superseded')`)
      .all(a.run_id,a.agent_id,projectId,a.scope_key) as any[];
    if(roots.length!==1 || !["initial","final"].includes(roots[0].delivery_phase) || roots[0].blocking_decision_id ||
       hasOutstandingDelegation(this.db,{runId:a.run_id,sourceActivationId:roots[0].source_activation_id,projectId,agentId:a.agent_id,scopeKey:a.scope_key}))
      throw Error("The original task has multiple or unresolved obligations and remains held.");
    const root=roots[0];
    const ownership=this.db.prepare("SELECT state,recovery_activation_id FROM required_reply_obligations WHERE run_id=? AND source_activation_id=?")
      .get(a.run_id,root.source_activation_id) as {state:string;recovery_activation_id:string|null};
    if (owner ? !(["recovery_pending","superseded"].includes(ownership.state) && ownership.recovery_activation_id===owner.activationId) : ownership.state!=="pending")
      throw Error("The exact original task is no longer available for this review.");
    if(this.db.prepare(`SELECT 1 FROM required_reply_obligations o JOIN scheduler_runs r ON r.id=o.run_id
      WHERE o.source_activation_id=? AND o.agent_id=? AND o.project_id=? AND o.scope_key=? AND r.rowid>? AND r.id<>? LIMIT 1`)
      .get(root.source_activation_id,a.agent_id,projectId,a.scope_key,a.run_rowid,owner?.runId ?? ""))throw Error("The original task has a later owner.");
    const original=this.db.prepare("SELECT payload_json FROM agent_activations WHERE id=? AND kind='human_message' AND agent_id=? AND project_id=? AND scope_key=?")
      .get(root.source_activation_id,a.agent_id,projectId,a.scope_key) as {payload_json:string}|undefined;
    if(!original)throw Error("The original human task is unavailable.");
    const originalPayload=JSON.parse(original.payload_json), taskCommunication=originalPayload?.communication;
    for (const event of [taskCommunication,payload.communication]) {
      if(!event || event.sender?.kind!=="user" || event.sender?.userId!=="local-operator" ||
         event.projectId!==projectId || event.conversationId!==a.conversation_id ||
         typeof event.eventId!=="string" || typeof event.text!=="string" ||
         (event.attachments!==undefined && (!Array.isArray(event.attachments) ||
           event.attachments.some((item:any)=>!item || typeof item.id!=="string"))))
        throw Error("The original task or instruction content is unavailable.");
    }
    const dispatch=payload.dispatch;
    const recipient=Array.isArray(dispatch?.recipients) ? dispatch.recipients.find((item:any)=>item?.agentId===a.agent_id) : undefined;
    const routed=Array.isArray(recipient?.attachments) ? recipient.attachments : dispatch?.attachments;
    if((payload.communication.attachments ?? []).some((item:any)=>!Array.isArray(routed) || !routed.some((candidate:any)=>candidate?.id===item.id)))
      throw Error("An original instruction attachment is unavailable.");
    const coverage=this.evidence("provider-start-coverage",a.agent_id);
    if(coverage.schema!=="provider-start-coverage.v1" || coverage.contract!=="provider-start-admission.v1" ||
       coverage.agentId!==a.agent_id || coverage.projectId!==projectId || coverage.conversationId!==a.conversation_id)
      throw Error("Provider start coverage is unavailable for this Agent.");
    requireProviderStartsDrained(this.db,a.agent_id,owner?.ownStart && owner.runId
      ? {identity:owner.ownStart.identity,runId:owner.runId,fence:owner.ownStart.fence}:undefined);
    const baselineStartClaims=(this.db.prepare("SELECT identity,receipt_sha256 AS sha256 FROM host_lifecycle_commits WHERE kind='provider-start-admission' AND json_extract(receipt_json,'$.agentId')=? ORDER BY identity LIMIT 4097")
      .all(a.agent_id) as Array<{identity:string;sha256:string}>).filter(ref=>ref.identity!==owner?.ownStart?.identity);
    if (baselineStartClaims.length>4096) throw Error("Provider start inventory exceeds the supported review bound.");
    const registrations=this.db.prepare("SELECT identity FROM host_lifecycle_commits WHERE kind='provider-process-registration'  AND json_extract(receipt_json,'$.agentId')=? LIMIT 4097")
      .all(a.agent_id) as Array<{identity:string}>;
    if(!registrations.length || registrations.length>4096)throw Error("Complete provider exit evidence is unavailable.");
    let covered=false;
    const exitRefs:string[]=[], baselineExits:Array<{identity:string;sha256:string}>=[];
    for(const ref of registrations){
      const reg=this.evidence("provider-process-registration",ref.identity);
      if(owner?.ownStart && reg.authorityId===owner.ownStart.authorityId) {
        if(reg.schema!=="provider-process-registration.v1" || ref.identity!==reg.authorityId+":"+payloadHash(reg) ||
          reg.runId!==owner.runId || reg.runFence!==owner.ownStart.fence || reg.workerId!==owner.ownStart.workerId ||
          reg.projectId!==projectId || reg.agentId!==a.agent_id || reg.conversationId!==a.conversation_id ||
          reg.process?.kind!=="posix" || stableJson(reg.process.identity)!==stableJson(owner.ownStart.processIdentity))
          throw Error("Successor provider registration differs.");
        continue;
      }
      if(reg.schema!=="provider-process-registration.v1" || reg.projectId!==projectId || reg.agentId!==a.agent_id ||
        reg.conversationId!==a.conversation_id || typeof reg.authorityId!=="string" || ref.identity!==reg.authorityId+":"+payloadHash(reg))
        throw Error("Provider registration scope differs.");
      const exit=this.evidence("provider-process-exit",reg.authorityId);
      if(exit.schema!=="provider-process-exit.v1" || exit.authorityId!==reg.authorityId || exit.result!=="observed_exited" ||
        !Array.isArray(exit.registrations) || !exit.registrations.some((x:any)=>x.identity===ref.identity && x.sha256===payloadHash(reg) && stableJson(x.registration)===stableJson(reg)))
        throw Error("The original provider exit has not been confirmed.");
      if(reg.runId===a.run_id && reg.runFence===a.fencing_token)covered=true;
      exitRefs.push(ref.identity);
      baselineExits.push({identity:reg.authorityId,sha256:payloadHash(exit)});
    }
    if(!covered)throw Error("The original Run lacks exact observed provider exit evidence.");
    const effectInventory=new CoordinationV3SourceEffectsAuthority(this.db).inspect({agentId:a.agent_id,sourceRunId:a.run_id,sourceFence:a.fencing_token});
    if (a.status==="completed" && !effectInventory.unknownSteeringInjectionIds?.includes(a.injection_id))
      throw Error("The exact unconfirmed interruption is unavailable.");
    const facts={projectId,activationId,agentId:a.agent_id,conversationId:a.conversation_id,runId:a.run_id,
      sourceFence:a.fencing_token,injectionId:a.injection_id,root,originalTask:originalPayload,originalSteer:payload,...(laterUnsubmittedRuns.length?{laterUnsubmittedRuns}:{}),baselineStartClaims,baselineRegistrations:exitRefs.sort(),baselineExits:baselineExits.sort((a,b)=>a.identity.localeCompare(b.identity)),effectInventory};
    return {...facts,reviewSha256:payloadHash(facts),originalOutcome:"unknown" as const,replayAuthorized:false as const};
  }

  drainTarget(projectId:string,activationId:string):{agentId:string;runId:string;fence:number} {
    return this.db.transaction(() => {
      const rows=this.db.prepare(`SELECT a.agent_id,a.scope_key,i.id AS injection_id,i.run_id,r.fencing_token,r.rowid AS run_rowid,ag.conversation_id
        FROM agent_activations a JOIN scheduler_prompt_injections i ON i.kind='steer' AND i.state='outcome_unknown'
          AND EXISTS(SELECT 1 FROM json_each(i.activation_ids_json) member WHERE member.value=a.id)
        JOIN scheduler_runs r ON r.id=i.run_id AND r.agent_id=a.agent_id AND r.project_id=a.project_id AND r.scope_key=a.scope_key
        JOIN agents ag ON ag.id=a.agent_id AND ag.project_id=a.project_id
        JOIN conversations chat ON chat.id=ag.conversation_id AND chat.project_id=ag.project_id
        WHERE a.id=? AND a.project_id=? AND a.kind='human_message' AND a.prompt_class='human'
          AND r.status IN ('completed','outcome_unknown') AND json_extract(a.payload_json,'$.communication.sender.kind')='user'
          AND json_extract(a.payload_json,'$.communication.sender.userId')='local-operator'
          AND json_array_length(i.activation_ids_json)=1 AND ${activeAgentOwnerSql('ag')} AND ${activeChatOwnerSql('chat')}`)
        .all(activationId,projectId) as Array<{agent_id:string;scope_key:string;run_id:string;fencing_token:number;run_rowid:number;conversation_id:string}>;
      if(rows.length!==1)throw Error("The exact finished interruption is unavailable.");
      const a=rows[0]!;
      this.laterUnsubmittedRuns(a.agent_id,a.run_rowid,a.run_id);
      if(a.scope_key!=="conversation:"+a.conversation_id || !Number.isSafeInteger(a.fencing_token) || a.fencing_token<1 ||
         this.db.prepare("SELECT 1 FROM context_rollovers WHERE agent_id=? AND state IN ('requested','handoff_committed','session_retiring','continuation_ready','outcome_unknown') LIMIT 1").get(a.agent_id))
        throw Error("The original Run no longer has exclusive recovery custody.");
      return {agentId:a.agent_id,runId:a.run_id,fence:a.fencing_token};
    })();
  }

  preview(projectId:string,activationId:string) {return this.db.transaction(()=>this.current(projectId,activationId))();}

  recorded(projectId:string,activationId:string) {
    const rows=this.db.prepare("SELECT result_json FROM coordination_idempotency WHERE project_id=? AND actor_scope=? AND operation='reviewed_steering_continue' LIMIT 2")
      .all(projectId,"operator:reviewed-steering:"+activationId) as Array<{result_json:string}>;
    if(rows.length>1)throw Error("The saved continuation record is ambiguous.");
    if(!rows.length)return undefined;
    const result=JSON.parse(rows[0]!.result_json);
    const activation=this.db.prepare("SELECT state,last_delivery_error FROM agent_activations WHERE id=? AND project_id=?").get(result.activationId,projectId) as {state:string;last_delivery_error:string|null}|undefined;
    if(!activation || result.accepted!==true || result.sourceActivationId!==activationId || result.originalOutcome!=="unknown" || result.replayAuthorized!==false)
      throw Error("The saved continuation record is unavailable.");
    return {...result,activationState:activation.state,...(activation.last_delivery_error ? {holdReason:activation.last_delivery_error} : {}),replayed:true};
  }

  private assertReviewed(projectId:string, continuationId:string, runId?:string) {
    const row=this.db.prepare(`SELECT a.payload_json,source.source_id AS injection_id,member.value AS original_id
      FROM agent_activations a JOIN activation_sources source ON source.activation_id=a.id AND source.source_kind='reviewed_steering'
      JOIN scheduler_prompt_injections injection ON injection.id=source.source_id
      JOIN json_each(injection.activation_ids_json) member
      WHERE a.id=? AND a.project_id=?`).get(continuationId,projectId) as {payload_json:string;injection_id:string;original_id:string}|undefined;
    if(!row) throw Error("The reviewed continuation has no exact retained source.");
    const payload=JSON.parse(row.payload_json) as {requiredReplyRecovery?:{reviewSha256?:string}};
    const current=this.current(projectId,row.original_id,{activationId:continuationId,...(runId ? {runId} : {})});
    if(current.injectionId!==row.injection_id || current.reviewSha256!==payload.requiredReplyRecovery?.reviewSha256)
      throw Error("The original task or provider evidence changed; review is required.");
  }

  assertClaim(projectId:string,continuationId:string) {
    return this.assertReviewed(projectId,continuationId);
  }
  assertLease(projectId:string,continuationId:string,runId:string) {
    return this.assertReviewed(projectId,continuationId,runId);
  }

  assertSubmission(projectId:string,continuationId:string,runId:string,fence:number) {
    const run=this.db.prepare("SELECT agent_id,lease_owner,scope_key FROM scheduler_runs WHERE id=? AND project_id=? AND fencing_token=? AND status='running' AND side_effects_fenced_at IS NULL")
      .get(runId,projectId,fence) as {agent_id:string;lease_owner:string;scope_key:string}|undefined;
    if(!run)throw Error("Reviewed successor lost its Run ownership.");
    const claims=this.db.prepare("SELECT identity,receipt_sha256 AS sha256 FROM host_lifecycle_commits WHERE kind='provider-start-admission' AND json_extract(receipt_json,'$.agentId')=? AND json_extract(receipt_json,'$.runId')=? ORDER BY identity LIMIT 3")
      .all(run.agent_id,runId) as Array<{identity:string;sha256:string}>;
    if(claims.length!==1)throw Error("Reviewed successor requires one exact provider start.");
    const ref=claims[0]!,claim=this.evidence("provider-start-admission",ref.identity);
    if(claim.identity!==ref.identity || claim.schema!=="provider-start-admission.v1" || claim.runFence!==fence ||
       run.scope_key!=="conversation:"+claim.conversationId || claim.agentId!==run.agent_id ||
       claim.workerId!==run.lease_owner || claim.projectId!==projectId || claim.operation!=="openSession" ||
       this.db.prepare("SELECT 1 FROM host_lifecycle_commits WHERE kind='provider-start-unknown' AND identity=?").get(ref.identity))
      throw Error("Reviewed successor provider start differs.");
    const settled=this.evidence("provider-start-settlement",ref.identity);
    if(settled.schema!=="provider-start-settlement.v1" || settled.workerId!==run.lease_owner ||
      stableJson(settled.claim)!==stableJson(ref) || !Array.isArray(settled.registrations) || settled.registrations.length!==1)
      throw Error("Reviewed successor provider start is not settled.");
    const authorityId=settled.registrations[0];
    const live=this.db.prepare("SELECT * FROM provider_process_authority WHERE id=? AND agent_id=? AND project_id=? AND run_id=? AND worker_id=?")
      .get(authorityId,run.agent_id,projectId,runId,run.lease_owner) as any;
    if(!live)throw Error("Reviewed successor provider is not registered.");
    const refs=this.db.prepare("SELECT identity FROM host_lifecycle_commits WHERE kind='provider-process-registration' AND json_extract(receipt_json,'$.authorityId')=? ORDER BY identity LIMIT 4097")
      .all(authorityId) as Array<{identity:string}>;
    if(!refs.length || refs.length>4096)throw Error("Reviewed successor provider registration is unavailable.");
    const matches=refs.map(ref=>({ref,reg:this.evidence("provider-process-registration",ref.identity)}));
    if(!matches.some(({ref,reg})=>ref.identity===authorityId+":"+payloadHash(reg) && reg.schema==="provider-process-registration.v1" &&
      reg.authorityId===authorityId && reg.conversationId===claim.conversationId &&
      reg.runId===runId && reg.runFence===fence && reg.workerId===run.lease_owner && reg.projectId===projectId && reg.agentId===run.agent_id &&
      reg.process?.kind==="posix" && reg.process.identity?.pid===live.pid && reg.process.identity?.pgid===live.pgid &&
      reg.process.identity?.birthMarker===live.birth_marker))
      throw Error("Reviewed successor process identity differs.");
    const row=this.db.prepare(`SELECT a.payload_json,source.source_id AS injection_id,member.value AS original_id
      FROM agent_activations a JOIN activation_sources source ON source.activation_id=a.id AND source.source_kind='reviewed_steering'
      JOIN scheduler_prompt_injections injection ON injection.id=source.source_id JOIN json_each(injection.activation_ids_json) member
      WHERE a.id=? AND a.project_id=?`).get(continuationId,projectId) as {payload_json:string;injection_id:string;original_id:string}|undefined;
    if(!row)throw Error("Reviewed continuation source is unavailable.");
    const view=this.current(projectId,row.original_id,{activationId:continuationId,runId,ownStart:{identity:ref.identity,authorityId,fence,workerId:run.lease_owner,
      processIdentity:{pid:live.pid,pgid:live.pgid,birthMarker:live.birth_marker,...(live.scope_json ? {scope:JSON.parse(live.scope_json)} : {})}}});
    if(view.injectionId!==row.injection_id || view.reviewSha256!==JSON.parse(row.payload_json).requiredReplyRecovery?.reviewSha256)
      throw Error("Reviewed source evidence changed before provider input.");
  }

  continue(input:{projectId:string;activationId:string;reviewSha256:string;effectsReviewed:boolean;reviewNote?:string;idempotencyKey:string}) {
    if(!/^[a-f0-9]{64}$/u.test(input.reviewSha256) || !input.idempotencyKey || input.idempotencyKey.length>200 ||
      input.effectsReviewed!==true || (input.reviewNote!==undefined && (typeof input.reviewNote!=="string" || Buffer.byteLength(input.reviewNote,"utf8")>16000)))
      throw Error("Review the original task and any uncertain effects before continuing.");
    return this.db.transaction(()=>{
      const scope="operator:reviewed-steering:"+input.activationId, hash=payloadHash(input);
      const prior=this.db.prepare("SELECT payload_hash,result_json FROM coordination_idempotency WHERE project_id=? AND actor_scope=? AND operation='reviewed_steering_continue' AND idempotency_key=?")
        .get(input.projectId,scope,input.idempotencyKey) as {payload_hash:string;result_json:string}|undefined;
      if(prior){if(prior.payload_hash!==hash)throw Error("This continuation key belongs to a different review.");const saved=this.recorded(input.projectId,input.activationId);if(!saved)throw Error("The saved continuation is unavailable.");return saved;}
      if(this.db.prepare("SELECT 1 FROM coordination_idempotency WHERE project_id=? AND actor_scope=? AND operation='reviewed_steering_continue' LIMIT 1").get(input.projectId,scope))
        throw Error("A continuation was already authorized for this instruction.");
      const view=this.current(input.projectId,input.activationId);
      if(view.reviewSha256!==input.reviewSha256)throw Error("The task or provider evidence changed; review it again.");
      const now=new Date().toISOString(),root=view.root,dedupe="required-reply-recovery:"+view.runId+":"+root.source_activation_id;
      if(this.db.prepare("SELECT 1 FROM agent_activations WHERE project_id=? AND dedupe_key=?").get(input.projectId,dedupe))
        throw Error("An existing task continuation requires review.");
      const originalDispatch = view.originalSteer.dispatch && typeof view.originalSteer.dispatch === "object"
        ? view.originalSteer.dispatch as Record<string,unknown> : {};
      // Preserve typed attachments and original routing, but keep the compiled
      // recovery instruction as the actual dispatch text.
      const { text: _priorDispatchText, ...attachmentDispatch } = originalDispatch;
      const activationId=this.create({projectId:input.projectId,agentId:view.agentId,scopeKey:"conversation:"+view.conversationId,
        kind:"required_reply_recovery",priority:100,dispatchPolicy:"next_run",promptClass:"human",dedupeKey:dedupe,
        sourceKind:"required_reply",sourceId:view.runId+":"+root.source_activation_id,now,
        payload:{communication:view.originalSteer.communication,dispatch:attachmentDispatch,replyAuthority:JSON.parse(root.reply_authority_json),requiredReplyRecovery:{sourceRunId:view.runId,
          sourceActivationId:root.source_activation_id,attempt:root.attempt_count+1,
          instruction:"The human reviewed the original task and unconfirmed interruption and explicitly authorized continuation. Whether the earlier interruption was delivered and what external effects occurred remain unknown. Follow its direction for the remaining work; inspect uncertain actions before deciding what still needs doing, and do not blindly repeat them. Preserve the complete original objective and reply route.",
          operatorReviewNote:input.reviewNote?.trim() ?? "",reviewSha256:input.reviewSha256,baselineStartClaims:view.baselineStartClaims,baselineRegistrations:view.baselineRegistrations}}});
      this.db.prepare("INSERT INTO activation_sources(activation_id,source_kind,source_id) VALUES(?,'reviewed_steering',?)").run(activationId,view.injectionId);
      const changed=this.db.prepare("UPDATE required_reply_obligations SET state='recovery_pending',recovery_activation_id=?,updated_at=? WHERE run_id=? AND source_activation_id=? AND state='pending'")
        .run(activationId,now,view.runId,root.source_activation_id);
      if(changed.changes!==1)throw Error("The original task changed; no continuation was started.");
      const result={accepted:true,sourceActivationId:input.activationId,activationId,agentId:view.agentId,sourceRunId:view.runId,injectionId:view.injectionId,reviewSha256:input.reviewSha256,commandSha256:hash,originalOutcome:"unknown",replayAuthorized:false};
      this.db.prepare("INSERT INTO coordination_idempotency(project_id,actor_scope,operation,idempotency_key,payload_hash,result_json,created_at) VALUES(?,?,'reviewed_steering_continue',?,?,?,?)")
        .run(input.projectId,scope,input.idempotencyKey,hash,stableJson(result),now);
      return {...result,activationState:"pending",replayed:false};
    }).immediate();
  }
}
