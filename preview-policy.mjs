/** Mutations exposed only for the two explicitly activated candidate UIs. */
export function candidateMutationAllowed(method,pathname,body,installations,trusted={}){
 if(!body||typeof body!=='object'||Array.isArray(body))return false;
 const active=installations.filter(i=>i.deliveryMode==='user-ui'&&i.supported===true);
 const message=pathname.match(/^\/api\/(?:branches\/engine\/)?agents\/([^/]+)\/messages$/);
 if(method==='POST'&&message){
  return active.some(i=>i.spokespersonId===message[1])&&Object.keys(body).every(k=>['text','idempotencyKey','activeRunDelivery'].includes(k))&&typeof body.text==='string'&&Boolean(body.text.trim())&&typeof body.idempotencyKey==='string'&&Boolean(body.idempotencyKey)&&['queue','steer'].includes(body.activeRunDelivery);
 }
 const direct=pathname.match(/^\/api\/branches\/engine\/conversations\/([^/]+)\/direct-messages$/);
 if(method==='POST'&&direct){
  return active.some(i=>i.conversationId===direct[1]&&i.voiceEnabled===true&&
   Object.keys(body).every(k=>['text','idempotencyKey','activeRunDelivery','recipients','voiceReply'].includes(k))&&
   typeof body.text==='string'&&Boolean(body.text.trim())&&typeof body.idempotencyKey==='string'&&Boolean(body.idempotencyKey)&&body.idempotencyKey.length<=200&&
   body.activeRunDelivery==='queue'&&(body.voiceReply===undefined||body.voiceReply===true)&&
   Array.isArray(body.recipients)&&body.recipients.length===1&&Object.keys(body.recipients[0]??{}).length===1&&body.recipients[0]?.agentId===i.spokespersonId);
 }
 const cancel=pathname.match(/^\/api\/branches\/engine\/agents\/([^/]+)\/cancel$/);
 if(method==='POST'&&cancel)return active.some(i=>i.voiceEnabled===true&&i.spokespersonId===cancel[1])&&
  Object.keys(body).every(k=>['targetRunId','idempotencyKey'].includes(k))&&typeof body.targetRunId==='string'&&Boolean(body.targetRunId)&&body.targetRunId.length<=200&&
  typeof body.idempotencyKey==='string'&&Boolean(body.idempotencyKey)&&body.idempotencyKey.length<=200&&trusted.activeRun?.agentId===cancel[1]&&trusted.activeRun?.runId===body.targetRunId;
 const memory=pathname.match(/^\/api\/branches\/engine\/projects\/([^/]+)\/memories$/);
 if(method==='POST'&&memory){
  if(!active.some(i=>i.projectId===memory[1]&&i.memoryEnabled===true)||!['list','get','search','history','save','update','forget'].includes(body.operation)||
   (body.scope!==undefined&&body.scope!=='project')||typeof trusted.memoryCommand!=='function')return false;
  try{trusted.memoryCommand(body,true);return true}catch{return false}
 }
 const decision=pathname.match(/^\/api\/branches\/engine\/decisions\/([^/]+)\/respond$/);
 if(method==='POST'&&decision)return active.some(i=>i.spokespersonId===trusted.decision?.agentId&&i.projectId===trusted.decision?.projectId&&i.conversationId===trusted.decision?.conversationId)&&
  trusted.decision?.id===decision[1]&&trusted.decision?.status==='pending'&&Object.keys(body).every(k=>['optionId','text'].includes(k))&&
  (typeof body.optionId==='string'&&Boolean(body.optionId.trim())||typeof body.text==='string'&&Boolean(body.text.trim()))&&
  (body.optionId===undefined||typeof body.optionId==='string')&&(body.text===undefined||typeof body.text==='string');
 const check=pathname.match(/^\/api\/branches\/([^/]+)\/executions$/);
 if(method==='POST'&&check)return active.some(i=>i.branchId===check[1])&&Object.keys(body).every(k=>['occurrenceKey','input'].includes(k))&&typeof body.occurrenceKey==='string'&&Boolean(body.occurrenceKey)&&typeof body.input==='string';
 const trigger=pathname.match(/^\/api\/(?:branches\/engine\/)?triggers\/([^/]+)$/);
 if(method==='PATCH'&&trigger)return active.some(i=>i.triggerId===trigger[1]&&body.reviewedDefinition?.branchId===i.branchId&&body.reviewedDefinition?.id===i.triggerId)&&Object.keys(body).every(k=>['enabled','reviewedDefinition'].includes(k))&&typeof body.enabled==='boolean';
 return false;
}

/** Deployment adapter supplies ordinary authenticated backend reads and the
 * canonical memory command validator. Request body values never supply these
 * trusted observations. The backend rechecks ownership/fences on mutation. */
export async function authorizeCandidateMutation(method, pathname, body, installations, {readJson, memoryCommand}={}) {
 const active=installations.filter(i=>i.deliveryMode==='user-ui'&&i.supported===true);
 const trusted={memoryCommand};
 const cancel=pathname.match(/^\/api\/branches\/engine\/agents\/([^/]+)\/cancel$/);
 if(method==='POST'&&cancel&&active.some(i=>i.voiceEnabled===true&&i.spokespersonId===cancel[1])&&readJson){
  const detail=await readJson(`/api/branches/engine/agents/${encodeURIComponent(cancel[1])}?limit=1`);
  const run=detail?.runs?.find(r=>r.id===body?.targetRunId&&r.status==='running');
  if(detail?.agent?.id===cancel[1]&&run)trusted.activeRun={agentId:cancel[1],runId:run.id};
 }
 const decision=pathname.match(/^\/api\/branches\/engine\/decisions\/([^/]+)\/respond$/);
 if(method==='POST'&&decision&&readJson){
  for(const i of active.filter(i=>i.projectId&&i.conversationId)){
   const decisions=await readJson(`/api/branches/engine/decisions?agentId=${encodeURIComponent(i.spokespersonId)}&conversationId=${encodeURIComponent(i.conversationId)}&status=pending`);
   trusted.decision=Array.isArray(decisions)?decisions.find(d=>d.id===decision[1]&&d.agentId===i.spokespersonId&&d.projectId===i.projectId&&d.conversationId===i.conversationId):undefined;
   if(trusted.decision)break;
  }
 }
 return candidateMutationAllowed(method,pathname,body,installations,trusted);
}

export function mutationOriginAllowed(origin, allowedOrigins=['http://100.88.80.22:18795']) {
 return origin===undefined||allowedOrigins.includes(origin);
}
