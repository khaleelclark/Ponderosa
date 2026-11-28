import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {serveFixture} from '../shared/serve-ui-fixture.mjs';
const {fixture,until}=await import('../shared/fixture.mjs');
const {AgentStore,BranchStore,CoordinationV3Store}=await import('../../packages/agents/dist/index.js');

const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
let store,browser,web,loseAcknowledgement=false,passed=false;
const f=await fixture({storeFactory:dir=>store=new AgentStore(dir),steeringResponse:()=>{
 if(loseAcknowledgement)throw new Error('Controlled lost steering acknowledgement');
 return {status:'accepted'};
}});
const branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
const post=async(path,body,headers)=>f.ok(await f.api('POST',path,body,headers));
const read=async path=>f.ok(await f.api('GET',path));
const owner=name=>post('/api/branches',{name,idempotencyKey:randomUUID()});
const gate={id:'review',kind:'human_gate',label:'Review scheduled input',prompt:'Do you approve the report?',editable:false};
const report={id:'report',kind:'script',runtime:'node',cwdRef:'workspace',timeoutMs:5000,source:"process.stdout.write('The manual report is ready.')"};
function publish(branch,step,kind='manual',sourceConfig={},agents={}){
 return post('/api/branches/deploy',{branchId:branch.id,chatId:branch.chatId,expectedVersionId:branch.versionId,idempotencyKey:randomUUID(),
  definition:{schema:'ponderosa.branch.v1',name:branch.name,entry:step.id,trigger:kind==='manual'?{kind}:{kind,configRef:'source'},
   steps:[step],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},
  bindings:{agents,directories:{workspace:f.root},...(kind!=='manual'?{triggers:{source:{enabled:true,sourceConfig}}}:{})}});
}
const scheduleConfig=whenRunning=>({scheduleKind:'interval',everyMs:60000,startsAt:new Date(Date.now()+86400000).toISOString(),whenRunning});
const runs=branch=>read('/api/branches/'+branch.id+'/executions');
const events=branch=>read('/api/branches/'+branch.id+'/trigger/occurrences');
const manualRun=branch=>post('/api/branches/'+branch.id+'/executions',{occurrenceKey:randomUUID(),input:'Original manual input'});
function tick(branch,text){
 const now=new Date().toISOString();
 branches.triggers.updateTriggerDefinition(branch.triggerId,{nextFireAt:now});
 return branches.triggers.recordScheduledTriggerOccurrence({
  triggerId:branch.triggerId,expectedNextFireAt:now,nextFireAt:new Date(Date.now()+86400000).toISOString(),lastFiredAt:now,
  occurrenceKey:randomUUID(),payload:{scheduledTimes:[now],missedCount:1,text},provenance:{source:'schedule',evaluatedAt:now},now,
 }).occurrenceId;
}
async function delivered(branch,id,delivery){
 return until(async()=>{
  const event=(await events(branch)).find(row=>row.id===id);
  return event?.schedule?.delivery===delivery&&event;
 },delivery,15000);
}

try{
 const manual=await publish(await owner('Manual Trigger Events'),report);
 const manualExecution=await manualRun(manual);
 await until(async()=>{const result=await runs(manual);return result.some(run=>run.id===manualExecution.id&&run.state==='completed');},'manual Run completes',20000);
 assert.equal((await events(manual)).length,0);
 const empty=await publish(await owner('Automatic Trigger Events empty'),gate,'webhook');
 const webhook=await publish(await owner('Retained webhook history'),gate,'webhook');
 const payload={text:'Original webhook payload'};
 const ingress=await post('/api/trigger-webhooks/'+webhook.triggerId,payload,{'x-ponderosa-event-id':randomUUID()});
 const original=(await events(webhook)).find(event=>event.id===ingress.occurrenceId);
 assert.ok(original.branchExecutionId);
 const failureId=randomUUID(),failure='Restore the selected workflow folder before starting the run.';
 // Current admission is atomic. Retained dead-lettered history can still exist.
 store.sqlite.prepare(`INSERT INTO trigger_occurrences
  (id,trigger_id,occurrence_key,project_id,agent_id,scope_key,payload_json,provenance_json,trigger_snapshot_json,payload_media_type,
   input_hash,activation_config_json,state,attempts,last_error,available_at,occurred_at,created_at,updated_at,branch_id)
  SELECT ?,trigger_id,?,project_id,agent_id,scope_key,payload_json,provenance_json,trigger_snapshot_json,payload_media_type,
   input_hash,activation_config_json,'dead_lettered',1,?,available_at,occurred_at,created_at,updated_at,branch_id
  FROM trigger_occurrences WHERE id=?`).run(failureId,'retained-failure',failure,original.id);
 const replaced=await publish(webhook,gate);
 assert.equal(replaced.triggerId,undefined);
 assert.equal((await events(replaced)).length,2);

 const latest=await publish(await owner('Latest scheduled check'),gate,'schedule',scheduleConfig('run_latest'));
 const created=await delivered(latest,tick(latest,'Initial scheduled check'),'run');
 await until(async()=>{const result=await runs(latest);return result.some(run=>run.id===created.branchExecutionId&&run.state==='waiting');},'first scheduled Run waits for approval',20000);
 const combinedId=tick(latest,'Earlier waiting check');
 await delivered(latest,combinedId,'held');
 await delivered(latest,tick(latest,'Newer waiting check'),'held');
 await delivered(latest,combinedId,'combined');
 assert.equal((await runs(latest)).length,1);

 const updateOwner=await owner('Update scheduled check');
 const chat=await post('/api/branches/'+updateOwner.id+'/chats',{label:'Review team',defaultEngine:'codex'},{'idempotency-key':randomUUID()});
 const agent=await post('/api/branches/engine/projects/'+chat.projectId+'/agents',{title:'Reviewer',engine:'codex',conversationId:chat.id,idempotencyKey:randomUUID()});
 f.plans.set(agent.id,[{hold:true,output:false}]);
 const update=await publish(updateOwner,{id:'review',kind:'agent',target:{kind:'persistent_agent',ref:'reviewer'},instructions:'Review the report.'},
  'schedule',scheduleConfig('update_current'),{reviewer:agent.id});
 const originalRun=await manualRun(update);
 await until(()=>f.turns.some(turn=>turn.agentId===agent.id)&&f.sessions.has(agent.id),'controlled provider Run');
 const updated=await delivered(update,tick(update,'Acknowledged input'),'updated');
 assert.equal(updated.branchExecutionId,originalRun.id);
 loseAcknowledgement=true;
 await delivered(update,tick(update,'Unconfirmed input'),'unconfirmed');
 assert.equal((await runs(update)).length,1);

 web=await serveFixture(f);
 browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 for(const viewport of [{width:1440,height:900},{width:390,height:844},{width:320,height:640}]){
  const mobile=viewport.width<768;
  const context=await browser.newContext({viewport,isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
  const page=await context.newPage();page.setDefaultTimeout(12000);
  const errors=[],writes=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.method()==='POST'&&/\/api\/branches\/[^/]+\/executions$/.test(new URL(request.url()).pathname))writes.push(request.url())});
  await page.route('**/*',route=>new URL(route.request().url()).origin===web.origin?route.continue():route.abort());
  const activate=locator=>mobile?locator.tap():locator.click();
  const history=page.getByRole('region',{name:'Run History'}),selected=page.getByRole('region',{name:'Selected Run'});
  const dialog=page.getByRole('dialog',{name:'Trigger Events'});
  const button=(where,name)=>where.getByRole('button',{name,exact:true});
  const show=async()=>{
   if(mobile&&await selected.isVisible())await activate(button(selected,'Back to Run History'));
   await activate(button(history,'Trigger Events'));
   await dialog.getByText('See when a schedule was due, a webhook arrived, or a watched file changed, and what happened next.',{exact:true}).waitFor();
  };
  const open=async(branch,query='')=>{
   await page.goto(web.origin+'/branches?branch='+branch.id+'&tab=executions'+query);
   await page.getByRole('button',{name:'Trigger Events',includeHidden:true,exact:true}).first().waitFor({state:'attached'});
   await show();
  };
  const row=outcome=>dialog.getByRole('article').filter({has:page.getByLabel(outcome,{exact:true})});
  const evidence=where=>where.getByText('Inspect payload and provenance',{exact:true});
  try{
   await open(manual);
   await dialog.getByText('This workflow runs manually. Your manual runs are in Run History.',{exact:true}).waitFor();
   assert.equal(await dialog.getByRole('article').count(),0);
   await activate(button(dialog,'Close'));
   await history.getByText('Manual Run',{exact:true}).waitFor();

   await open(empty);
   await dialog.getByText('No automatic trigger events recorded yet.',{exact:true}).waitFor();
   assert.equal(await dialog.getByRole('article').count(),0);

   await open(replaced,'&state=completed&state=failed');
   const linked=row('Run created'),failed=row('Run could not start');
   await linked.getByText('Webhook',{exact:true}).waitFor();
   assert.equal(await linked.locator('time').getAttribute('datetime'),original.occurredAt);
   await failed.getByText(failure,{exact:true}).waitFor();
   assert.equal(await button(failed,'View run').count(),0);
   assert.equal(await dialog.getByText(/This workflow runs manually/).count(),0);
   const originalId=linked.getByText('Event: '+original.id,{exact:false});
   assert.equal(await originalId.isVisible(),false);
   await activate(evidence(linked));
   await originalId.waitFor();
   await linked.getByText('Original webhook payload',{exact:false}).waitFor();
   for(let visit=0;visit<2;visit++){
    await button(linked,'View run').focus();
    await page.keyboard.press('Enter');
    await dialog.waitFor({state:'hidden'});
    await selected.getByText('Do you approve the report?',{exact:true}).waitFor();
    await page.waitForFunction(mobile=>{
     const focus=document.activeElement;
     return mobile?focus?.getAttribute('aria-label')==='Selected Run':
      focus?.tagName==='BUTTON'&&focus.textContent==='Trigger Events'&&focus.closest('[aria-label="Run History"]');
    },mobile,{timeout:2500});
    if(mobile){
     await page.keyboard.press('Tab');
     assert.equal(await button(selected,'Back to Run History').evaluate(element=>document.activeElement===element),true);
    }
    const params=new URL(page.url()).searchParams;
    assert.equal(params.get('execution'),original.branchExecutionId);
    assert.deepEqual(params.getAll('state'),['completed','failed']);
    if(visit===0)await show();
   }
   assert.deepEqual((await runs(replaced)).map(run=>run.id),[original.branchExecutionId]);

   await open(latest);
   for(const label of ['Run created','Waiting for current run','Combined with a later check']){
    await row(label).getByText('Schedule',{exact:true}).waitFor();
    assert.ok(await row(label).locator('time').getAttribute('datetime'));
   }
   const held=row('Waiting for current run');
   assert.equal(await held.getByText('Schedule delivery',{exact:true}).isVisible(),false);
   await activate(evidence(held));
   await held.getByText('Schedule delivery',{exact:true}).waitFor();
   await held.getByText('2 scheduled events',{exact:false}).waitFor();

   await open(update);
   await row('Updated current run').getByText('Schedule',{exact:true}).waitFor();
   await row('Update unconfirmed').getByText('Schedule',{exact:true}).waitFor();
   assert.equal(await row('Run created').count(),0);
   assert.equal(await dialog.getByLabel('Completed',{exact:true}).count(),0);
   assert.deepEqual(errors,[]);
   assert.deepEqual(writes,[]);
   console.log(viewport.width+' × '+viewport.height+' passed: manual and automatic empty states, retained webhook history and failure reason, same-run View run with filters and no POST, scheduled creation, held, combined, updated and unconfirmed outcomes');
  }catch(error){await page.screenshot({path:f.root+'/trigger-events-'+viewport.width+'-failure.png'});throw error;}
  finally{await context.close();}
 }
 passed=true;
}finally{await browser?.close();await web?.close();await f.dispose(passed);}
