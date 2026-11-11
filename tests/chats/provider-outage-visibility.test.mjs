import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AgentStore} from '@ponderosa/agents';
import {withFixture,until} from '../shared/fixture.mjs';

for(const product of ['core','branches'])for(const category of ['unavailable','rate_limit'])test(`Main provider failure exposes the exact safe Activity cause and preserves work: ${product}, ${category}`,{timeout:30000},async t=>{
 const configured='SYNTHETIC_MAIN_OUTAGE_KNOWN_1462',prior=process.env.ANTHROPIC_API_KEY;process.env.ANTHROPIC_API_KEY=configured;
 t.after(()=>{if(prior===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=prior;});
 let store,capability;
 await withFixture(t,async f=>{
  const prefix=product==='core'?'/api':'/api/branches/engine';let chat;
  if(product==='core')chat=await f.createChat('Main outage exact cause');
  else{const branch=f.ok(await f.api('POST','/api/branches',{name:'Main outage exact cause',idempotencyKey:randomUUID()}));chat=f.ok(await f.api('POST',`/api/branches/${branch.id}/chats`,{label:'Main outage exact cause',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));}
  const agent=f.ok(await f.api('POST',`${prefix}/projects/${chat.projectId}/agents`,{title:'Outage reader',engine:'codex',conversationId:chat.id,idempotencyKey:randomUUID()}));
  const marker=category==='unavailable'?'MAIN_OUTAGE_CONNECTION_REFUSED_1462':'MAIN_RATE_LIMIT_HTTP_429_1462',description=category==='unavailable'?'connection refused':'HTTP 429 request rejected',text=`#broadcast #${agent.handle} Inspect this synthetic status once.`,baseline=f.turns.filter(turn=>turn.agentId===agent.id).length;
  f.plans.set(agent.id,[{output:false,run:session=>session.events.push({type:'error',terminalStatus:'failed',category,code:category==='unavailable'?'network':'rate_limit',httpStatusCode:category==='unavailable'?503:429,message:`${marker}: ${description}. api_key=${configured}; ${capability}`})}]);
  const accepted=f.ok(await f.api('POST',`${prefix}/conversations/${chat.id}/messages`,{text,idempotencyKey:randomUUID(),recipientAgentMentions:[{agentId:agent.id,projectId:chat.projectId,handle:agent.handle,currentHandle:agent.handle,currentTitle:agent.title}]}));
  const detail=await until(async()=>{const value=await f.detail(agent.id,prefix);return value.runs.some(run=>run.status==='failed')&&value.activity.some(item=>item.event.type==='error'&&item.event.message.includes(marker))?value:false;},'retained typed outage');
  const error=detail.activity.find(item=>item.event.type==='error'&&item.event.message.includes(marker));
  const inspect=async()=>{
   const conversation=f.ok(await f.api('GET',`${prefix}/conversations/${chat.id}`));
   const message=conversation.providerFailureMessages.find(item=>item.communicationEventId===accepted.communicationEventId);assert(message,'Main interruption projection includes the exact outage request');
   const receipt=message.deliveryReceipts.find(item=>item.targetAgentId===agent.id),failure=receipt.providerFailure;
   assert.equal(failure.category,category);assert.equal(failure.activityId,error.id);assert.equal(message.text,text);assert.equal(receipt.retryMayDuplicate,true);
   const page=f.ok(await f.api('GET',`${prefix}/agents/${agent.id}/history/activity?limit=1&focusId=${encodeURIComponent(failure.activityId)}`));
   assert.equal(page.items.length,1);assert.equal(page.items[0].id,error.id);assert.equal(page.items[0].event.message,error.event.message);assert(page.items[0].event.message.includes(description));
   for(const value of [configured,capability])assert(!JSON.stringify([conversation,page]).includes(value),'A known value must not enter the public projection');
   return {messageId:message.id,activationId:receipt.activationId,runId:failure.runId,activityId:failure.activityId};
  };
  const before=await inspect();
  store.appendEvent(agent.id,{type:'error',executionId:'unrelated-later-fixture-execution',message:'Unrelated later error must never replace this exact cause'});
  assert.deepEqual(await inspect(),before,'A newer unrelated Activity error cannot steal the exact Run pointer');
  assert.equal(f.turns.filter(turn=>turn.agentId===agent.id).length,baseline+1,'Viewing failure projections never retries work');
  await f.reopen();assert.deepEqual(await inspect(),before,'The exact canonical pointer survives reopen');
 },{storeFactory:root=>(store=new AgentStore(root)),onProviderOpen:options=>{capability=options.environment.PONDEROSA_AGENT_MESSAGE_TOKEN;}});
});
