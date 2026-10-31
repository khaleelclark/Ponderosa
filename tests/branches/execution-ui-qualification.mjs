// Real loopback API + built UI + canonical disposable workflows. Providers are
// the existing controlled adapters: this does not qualify subscription access.
import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';

export async function startExecutionQualification({web=fileURLToPath(new URL('../../apps/web/dist/',import.meta.url)),manifestPath,historyRuns=105}={}){
 if(!Number.isSafeInteger(historyRuns)||historyRuns<101||historyRuns>150)throw Error('Use 101–150 history runs for the off-page check.');
 web=path.resolve(web);await readFile(path.join(web,'index.html'));
 const [{fixture,until},{AgentStore,BranchStore,CoordinationV3Store}]=await Promise.all([import('../shared/fixture.mjs'),import('../../packages/agents/dist/index.js')]);
 let store,server,stopping=false,manifest,loseSteeringAcknowledgement=false;
 const f=await fixture({diagnosticProvider:true,storeFactory:dir=>(store=new AgentStore(dir)),steeringResponse:()=>{if(loseSteeringAcknowledgement)throw new Error('Controlled unconfirmed scheduled update');return {status:'accepted'}}}),requests=[];
 const branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
 const inspect=()=>({executionCount:store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,providerRunCount:store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs').get().n,states:store.sqlite.prepare('SELECT state,COUNT(*) n FROM branch_executions GROUP BY state').all()});
 const onSignal=()=>void stop().then(()=>process.exit(0),error=>{console.error(error);process.exitCode=1});
 const stop=async()=>{if(stopping)return;stopping=true;process.removeListener('SIGTERM',onSignal);process.removeListener('SIGINT',onSignal);const final={...manifest,stoppedAt:new Date().toISOString(),beforeStop:inspect()};server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));await f.dispose(false);await writeFile(path.join(f.root,'execution-ui-stopped.json'),JSON.stringify({...final,ownedProviderExitObserved:true},null,2)+'\n');};
 process.once('SIGTERM',onSignal);process.once('SIGINT',onSignal);
 try{
  const create=async name=>f.ok(await f.api('POST','/api/branches',{name,idempotencyKey:randomUUID()}));
  const gate=(id,label)=>({id,label,kind:'human_gate',prompt:`${label}: approve this document or explain what needs to change.`,editable:true});
  const definition=(name,steps,edges=[],controls=[],entry=steps[0].id)=>({schema:'ponderosa.branch.v1',name,trigger:{kind:'manual'},entry,steps,controls,edges,policy:{maxConcurrentExecutions:10,maxPathInstances:1000,maxStepInvocations:1000,failure:{action:'stop'}}});
  const publish=async(owner,graph,bindings={agents:{},directories:{}})=>f.ok(await f.api('POST','/api/branches/deploy',{branchId:owner.id,expectedVersionId:owner.versionId??'',chatId:'',idempotencyKey:randomUUID(),definition:graph,bindings}));
  const run=async(owner,input)=>f.ok(await f.api('POST',`/api/branches/${owner.id}/executions`,{occurrenceKey:randomUUID(),input}));
  const waitingGates=id=>store.sqlite.prepare("SELECT g.id,g.revision,s.step_id FROM branch_gates g JOIN branch_step_executions s ON s.id=g.step_execution_id WHERE s.execution_id=? AND g.state='waiting' ORDER BY g.rowid").all(id);
  const approve=(row,output)=>branches.resolveGate(row.id,{commandKey:randomUUID(),expectedRevision:row.revision,decision:'approve',output});
  const settleReview=(execution,output)=>{for(let i=0;i<20;i++){branches.advance();const current=branches.execution(execution.id);if(current.state==='completed')return current;for(const row of waitingGates(execution.id))approve(row,output);}throw Error(`Review did not complete: ${execution.id}`)};

  const owner=await create('Document Review'),graph=definition(owner.name,[gate('check-document','Check Document'),gate('review-recommendation','Review Recommendation'),gate('send-document','Send Approved Document')],[{id:'checked',from:'check-document',to:'review-recommendation',on:'approved'},{id:'reviewed',from:'review-recommendation',to:'send-document',on:'approved'}]);
  let documentReview=await publish(owner,graph);const originalVersionId=documentReview.versionId,completed=[];
  const fullResult='# Document Review Complete\n\nThe document is approved for publication.\n\n'+Array.from({length:100},(_,i)=>`Review note ${i+1}: checked the source, confirmed the recommendation, and retained the approval.`).join('\n');
  for(let i=0;i<historyRuns;i++){
   const execution=await run(documentReview,`Document ${String(i+1).padStart(3,'0')}: Quarterly Project Update\nCheck the facts, approve the recommendation, and send the final copy.`);
   completed.push(settleReview(execution,i===historyRuns-1?fullResult:`Document ${i+1} approved. The facts were checked, the recommendation was reviewed, and the final copy is ready.`));
  }
  // Existing runs keep their accepted version; the current editor has one
  // deliberately different label for the pinned-version inspection check.
  documentReview=await publish(documentReview,{...graph,steps:graph.steps.map(step=>step.id==='send-document'?{...step,label:'Archive Approved Document — Current Version'}:step)});
  const needsReview=await run(documentReview,'Document 106: Team Handbook Update\nPlease review the updated time-off policy.');branches.advance();
  assert.ok(waitingGates(needsReview.id).length);
  const firstPage=f.ok(await f.api('GET',`/api/branches/${documentReview.id}/executions`));assert.equal(firstPage.length,100);assert.ok(!firstPage.some(row=>row.id===completed[0].id),'Oldest accepted run must really be outside the loaded page');

  // Two real paths: one old approval remains unresolved while the other loops
  // through 100 newer resolved approvals. No SQL state writes manufacture this.
  const auditOwner=await create('Document Review — Approval Audit'),auditGraph=definition(auditOwner.name,[gate('legal-review','Legal Review'),gate('copy-review','Review Another Copy')],[{id:'legal',from:'parallel-review',to:'legal-review',on:'selected'},{id:'copy',from:'parallel-review',to:'copy-review',on:'selected'},{id:'legal-approved',from:'legal-review',to:'all-reviewed',on:'approved'},{id:'review-next',from:'copy-review',to:'copy-review',on:'approved',loop:true},{id:'copies-finished',from:'copy-review',to:'all-reviewed',on:'rejected'}],[{id:'parallel-review',label:'Parallel Document Reviews',kind:'fork',joinId:'all-reviewed'},{id:'all-reviewed',label:'All Reviews Finished',kind:'join',forkId:'parallel-review',mode:'all',remainder:'finish',inputOrder:['legal','copy']}],'parallel-review');
  const approvalAudit=await publish(auditOwner,auditGraph),settings=f.ok(await f.api('GET',`/api/branches/${approvalAudit.id}/settings`));
  f.ok(await f.api('PUT',`/api/branches/${approvalAudit.id}/settings`,{configuration:{...settings.configuration,limits:{...settings.configuration.limits,maxLoopIterations:500,maxTraversals:1000}},revision:settings.revision}));
  const auditRun=await run(approvalAudit,'Review the legal language while checking successive document copies.');branches.advance();
  const oldPending=waitingGates(auditRun.id).find(row=>row.step_id==='legal-review');assert.ok(oldPending);
  for(let i=0;i<100;i++){branches.advance();const row=waitingGates(auditRun.id).find(row=>row.step_id==='copy-review');assert.ok(row,`Copy review ${i+1} must be canonically waiting`);approve(row,`Copy ${i+1} checked; review the next copy.`)}branches.advance();
  const boundedAudit=branches.detail(auditRun.id);assert.ok(!boundedAudit.gates.some(row=>row.id===oldPending.id),'Old legal approval must be beyond the first 100 gates');assert.equal(waitingGates(auditRun.id).length,2);assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM branch_gates g JOIN branch_step_executions s ON s.id=g.step_execution_id WHERE s.execution_id=? AND g.state='resolved'").get(auditRun.id).n,100);

  const assisted=[];
  for(const engine of ['codex','claude']){
   const agentOwner=await create(`Document Review — ${engine==='codex'?'Codex':'Claude'} Assistant`),chat=f.ok(await f.api('POST',`/api/branches/${agentOwner.id}/chats`,{label:'Document Review Team',defaultEngine:engine},{'idempotency-key':randomUUID()}));
   const agent=f.ok(await f.api('POST',`/api/branches/engine/projects/${chat.projectId}/agents`,{title:'Document Reviewer',engine,conversationId:chat.id,idempotencyKey:randomUUID()}));
   const firstFails=engine==='codex';f.plans.set(agent.id,[{output:false,run:async session=>{const result=await session.tool('ponderosa_update_request',{kind:firstFails?'failed':'completed',text:firstFails?'The document is missing a signed approval page.':'The document is checked and ready for the editor.'});assert.equal(result.success,true,result.text)}},{hold:true,output:false}]);
   const deployed=await publish(agentOwner,definition(agentOwner.name,[{id:'review-document',label:'Review Document',kind:'agent',target:{kind:'persistent_agent',ref:'reviewer'},instructions:'Read the submitted document and report a clear review outcome.'}]),{agents:{reviewer:agent.id},directories:{}});
   const settled=await run(deployed,'Check the approval page in the project update.');await until(()=>branches.execution(settled.id).state===(firstFails?'failed':'completed'),'controlled provider outcome',20_000);
   const active=await run(deployed,'Read the handbook carefully. This controlled review stays active until the fixture closes.');await until(()=>f.turns.filter(turn=>turn.agentId===agent.id).length===2&&f.sessions.get(agent.id),'controlled held provider turn',20_000);
   assisted.push({engine,branch:deployed,chat,agent,settled:branches.execution(settled.id),active:branches.execution(active.id)});
  }

  const publisher=assisted.find(item=>item.engine==='claude'),reportBytes=Buffer.from('Document review approved.\nExact captured report: résumé 😀\n');
  await writeFile(path.join(publisher.chat.workingDirectory,'approved-report.txt'),reportBytes);
  const artifact=f.ok(await f.tool(f.sessions.get(publisher.agent.id),'ponderosa_import_file',{path:'approved-report.txt'})).artifact;
  assert.deepEqual((await f.api('GET',artifact.downloadUrl)).rawBody,reportBytes);
  const generated=await run(documentReview,'Document 107: review the generated report.');
  const generatedResult=settleReview(generated,`# Approved Report\n\nThe review is complete. [Download approved report](${artifact.downloadUrl})`);
  const decisions=[];
  for(const item of assisted){
   f.plans.set(item.agent.id,[{output:false,run:async session=>{const result=await session.tool('ponderosa_update_request',{kind:'completed',text:'The requested review is complete, using your selected priority.'});assert.equal(result.success,true,result.text)}}]);
   const decision=f.ok(await f.tool(f.sessions.get(item.agent.id),'ponderosa_decision',{question:'Should I prioritize factual accuracy or writing style?',mode:'text',blocking:true}));
   decisions.push({engine:item.engine,runId:item.active.id,decisionId:decision.id});
  }

  // A peer Gate resolution changes the Run while another, independently owned
  // Decision answer is being edited. Both paths use their actual canonical owners.
  const retentionOwner=await create('Document Review — Decision Draft Retention'),retentionChat=f.ok(await f.api('POST',`/api/branches/${retentionOwner.id}/chats`,{label:'Decision Draft Retention Team',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
  const retentionAgent=f.ok(await f.api('POST',`/api/branches/engine/projects/${retentionChat.projectId}/agents`,{title:'Agent B — Approval Note',engine:'codex',conversationId:retentionChat.id,idempotencyKey:randomUUID()}));
  f.plans.set(retentionAgent.id,[{hold:true,output:false}]);
  const retentionBranch=await publish(retentionOwner,definition(retentionOwner.name,[gate('gate-a','Gate A — Independent Review'),{id:'agent-b',label:'Agent B — Write Approval Note',kind:'agent',target:{kind:'persistent_agent',ref:'agent-b'},instructions:'Ask for the wording of the approval note, then complete the canonical workflow Request after the answer.'}],[{id:'gate-path',from:'parallel-review',to:'gate-a',on:'selected'},{id:'agent-path',from:'parallel-review',to:'agent-b',on:'selected'},{id:'gate-finished',from:'gate-a',to:'all-finished',on:'approved'},{id:'agent-finished',from:'agent-b',to:'all-finished',on:'success'}],[{id:'parallel-review',label:'Independent Reviews',kind:'fork',joinId:'all-finished'},{id:'all-finished',label:'Both Reviews Finished',kind:'join',forkId:'parallel-review',mode:'all',remainder:'finish',inputOrder:['gate-path','agent-path']}],'parallel-review'),{agents:{'agent-b':retentionAgent.id},directories:{}});
  const retentionRun=await run(retentionBranch,'Review this document in parallel. Keep the approval-note answer draft while another reviewer approves Gate A.');branches.advance();
  const retentionSession=await until(()=>f.turns.some(turn=>turn.agentId===retentionAgent.id)&&f.sessions.get(retentionAgent.id),'Decision retention provider turn',20_000),retentionGate=waitingGates(retentionRun.id).find(row=>row.step_id==='gate-a');assert.ok(retentionGate);
  const retentionDecision=f.ok(await f.tool(retentionSession,'ponderosa_decision',{mode:'text',question:'What wording should Agent B use in the final approval note? You may attach the reviewed document.',blocking:true,idempotencyKey:randomUUID()}));
  // The existing controlled adapter records active-run steering; emulate its
  // provider response only after the canonical Decision has actually resolved.
  void until(async()=>{if(stopping)return true;await delay(100);if(stopping)return true;return f.ok(await f.api('GET',`/api/branches/engine/decisions?agentId=${retentionAgent.id}`)).some(row=>row.id===retentionDecision.id&&row.status==='resolved')},'Decision B answer',60*60_000).then(async()=>{if(stopping)return;const result=await retentionSession.tool('ponderosa_update_request',{kind:'completed',text:'Agent B completed the approval note using the accepted Decision answer.'});assert.equal(result.success,true,result.text);retentionSession.finish()}).catch(error=>{if(stopping)return;console.error(error);void stop().finally(()=>{process.exitCode=1})});

  const budgetOwner=await create('Document Review — Automatic Approval Budget'),future={scheduleKind:'once',at:'2099-01-01T00:00:00.000Z'},budgetGraph={...definition(budgetOwner.name,[gate('approve','Approve Incoming Document')]),trigger:{kind:'schedule',configRef:'schedule'}};
  const budgetBranch=await publish(budgetOwner,budgetGraph,{agents:{},directories:{},triggers:{schedule:{enabled:true,sourceConfig:future}}}),observed=f.ok(await f.api('GET',`/api/branches/${budgetBranch.id}/execution-budget`));
  f.ok(await f.api('PUT',`/api/branches/${budgetBranch.id}/execution-budget`,{commandKey:randomUUID(),expectedRevision:observed.revision,expectedPeriodId:observed.periodId,policy:{limit:1,period:'lifetime'},acknowledgeNewPeriod:true}));
  const record=label=>{const receipt=branches.triggers.recordTriggerOccurrence({triggerId:budgetBranch.triggerId,occurrenceKey:randomUUID(),payload:{document:label},provenance:{source:'qualification_schedule',contentInjected:false}});return branches.triggers.getTriggerOccurrence(receipt.occurrenceId)};
  const charged=record('First incoming document');branches.advance();const queuedEvent=record('Second incoming document');branches.advance();assert.ok(branches.execution(queuedEvent.branchExecutionId).budgetWait);
  const callerOwner=await create('Document Review — Calls Approval Queue'),caller=await publish(callerOwner,definition(callerOwner.name,[{id:'approval-queue',label:'Use Approval Queue',kind:'branch_call',branchRef:'approval'}]),{agents:{},directories:{},branches:{approval:budgetBranch.id}}),callerRun=await run(caller,'Send the final document to the approval queue.');branches.advance();branches.advance();
  const called=await until(()=>branches.listExecutions(budgetBranch.id).find(row=>row.parentExecutionId===callerRun.id&&row.budgetWait),'called-Branch budget wait');

  const eventsOwner=await create('Document Review — Earlier Scheduled Events'),eventsScheduled=await publish(eventsOwner,{...definition(eventsOwner.name,[gate('review','Review Scheduled Document')]),trigger:{kind:'schedule',configRef:'schedule'}},{agents:{},directories:{},triggers:{schedule:{enabled:true,sourceConfig:future}}});
  const historical=branches.triggers.recordTriggerOccurrence({triggerId:eventsScheduled.triggerId,occurrenceKey:randomUUID(),payload:{document:'Earlier scheduled handbook'},provenance:{source:'qualification_schedule',contentInjected:false}});branches.advance();
  const eventsManual=await publish(eventsScheduled,definition(eventsOwner.name,[gate('review','Review Scheduled Document')]));assert.equal(eventsManual.triggerId,undefined);assert.ok(branches.triggers.getTriggerOccurrence(historical.occurrenceId));
  const retainedEventRead=await f.api('GET',`/api/branches/${eventsManual.id}/trigger/occurrences`);
  const normal=await f.createChat('Normal Ponderosa — Document Review'),normalAgent=await f.createIdleAgent(normal,'Helpful Document Reviewer');
  const preferences=f.ok(await f.api('GET','/api/branches/engine/workspace/preferences'));
  f.ok(await f.api('PATCH','/api/branches/engine/workspace/preferences',{branchFolders:[{id:randomUUID(),name:'Document Review Examples',expanded:true,branchIds:[documentReview.id,approvalAudit.id,...assisted.map(item=>item.branch.id),budgetBranch.id,caller.id,eventsManual.id]}],branchFoldersRevision:preferences.revision,starredResourceIds:[`branch:${documentReview.id}`]}));

  const pendingOwner=await create('Scheduled Document Review — Existing Queue');
  const repeating={scheduleKind:'interval',everyMs:60000,startsAt:'2099-01-01T00:00:00.000Z'};
  const pendingBranch=await publish(pendingOwner,{...definition(pendingOwner.name,[gate('review','Approve Scheduled Document')]),trigger:{kind:'schedule',configRef:'schedule'},policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},{agents:{},directories:{},triggers:{schedule:{enabled:true,sourceConfig:repeating}}});
  const pendingBudget=f.ok(await f.api('GET',`/api/branches/${pendingBranch.id}/execution-budget`));
  f.ok(await f.api('PUT',`/api/branches/${pendingBranch.id}/execution-budget`,{commandKey:randomUUID(),expectedRevision:pendingBudget.revision,expectedPeriodId:pendingBudget.periodId,policy:{limit:1,period:'lifetime'},acknowledgeNewPeriod:true}));
  for(let i=0;i<40;i++){branches.triggers.recordTriggerOccurrence({triggerId:pendingBranch.triggerId,occurrenceKey:randomUUID(),payload:{document:`Queued document ${i+1}`},provenance:{source:'qualification_schedule'}});if(i===0)branches.advance()}
  const pendingCounts=f.ok(await f.api('GET',`/api/branches/${pendingBranch.id}/lifecycle`)).runCounts;
  assert.deepEqual(pendingCounts,{running:0,waiting:1,queued:39});

  const updateOwner=await create('Scheduled Document Review — Unconfirmed Update');
  const updateChat=f.ok(await f.api('POST',`/api/branches/${updateOwner.id}/chats`,{label:'Scheduled Review Team',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
  const updateAgent=f.ok(await f.api('POST',`/api/branches/engine/projects/${updateChat.projectId}/agents`,{title:'Scheduled Reviewer',engine:'codex',conversationId:updateChat.id,idempotencyKey:randomUUID()}));
  f.plans.set(updateAgent.id,[{hold:true,output:false}]);
  const updateBranch=await publish(updateOwner,{...definition(updateOwner.name,[{id:'review',label:'Review Latest Document',kind:'agent',target:{kind:'persistent_agent',ref:'reviewer'},instructions:'Review the latest scheduled document.'}]),trigger:{kind:'schedule',configRef:'schedule'}},{agents:{reviewer:updateAgent.id},directories:{},triggers:{schedule:{enabled:true,sourceConfig:{...repeating,whenRunning:'update_current'}}}});
  const updateRun=await run(updateBranch,'Original scheduled document');
  await until(()=>f.sessions.get(updateAgent.id),'scheduled reviewer is working');
  const checkAt=new Date().toISOString();branches.triggers.updateTriggerDefinition(updateBranch.triggerId,{nextFireAt:checkAt});
  loseSteeringAcknowledgement=true;
  const uncertainCheck=branches.triggers.recordScheduledTriggerOccurrence({triggerId:updateBranch.triggerId,expectedNextFireAt:checkAt,nextFireAt:repeating.startsAt,lastFiredAt:checkAt,occurrenceKey:randomUUID(),payload:{scheduledTimes:[checkAt],missedCount:1,document:'Latest quarterly update'},provenance:{source:'qualification_schedule'},now:checkAt});
  await until(()=>branches.triggers.getTriggerOccurrence(uncertainCheck.occurrenceId).schedule.delivery==='unconfirmed','scheduled update has durable uncertainty');
  loseSteeringAcknowledgement=false;

  const api=await f.listen();
  const mime={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml','.json':'application/json','.webmanifest':'application/manifest+json'};
  server=createServer(async(req,res)=>{try{
   const url=new URL(req.url,'http://localhost');
   if(url.pathname==='/api/__qualification/state'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({manifest,current:inspect(),requests}));return;}
   if(url.pathname.startsWith('/api/')){
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);
    const upstream=await fetch(api+req.url,{method:req.method,headers:{...Object.fromEntries(Object.entries(req.headers).filter(([name])=>!['host','connection','content-length','accept-encoding'].includes(name))),host:new URL(api).host,...(req.headers.origin===`http://${req.headers.host}`?{origin:new URL(api).origin}:{})},...(bytes.length?{body:bytes}:{})});
    requests.push({method:req.method,path:req.url,status:upstream.status});if(requests.length>1500)requests.shift();res.writeHead(upstream.status,Object.fromEntries([...upstream.headers].filter(([name])=>!['transfer-encoding','connection','content-encoding','content-length'].includes(name))));
    if(upstream.body){const stream=Readable.fromWeb(upstream.body);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res)}else res.end();return;
   }
   if(['/sw.js','/register-sw.js'].includes(url.pathname)){res.writeHead(404);res.end();return;}
   const target=path.resolve(web,decodeURIComponent(url.pathname).replace(/^\//,''));if(target!==web&&!target.startsWith(web+path.sep)){res.writeHead(404);res.end();return;}
   let bytes,file=target;try{bytes=await readFile(file)}catch{file=path.join(web,'index.html');bytes=await readFile(file)}res.writeHead(200,{'content-type':mime[path.extname(file)]??'application/octet-stream','cache-control':'no-store'});res.end(bytes);
  }catch(error){if(!res.headersSent)res.writeHead(500);res.end(String(error))}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`,view=(branch,executionId,tab='executions')=>origin+`/branches?${new URLSearchParams({branch:branch.id,tab,...(executionId?{execution:executionId}:{})})}`;
  manifest={ready:true,pid:process.pid,origin,root:f.root,web,providerMode:'controlled fixture adapters; no external provider account',documentReview:{branch:documentReview,originalVersionId,currentVersionId:documentReview.versionId,historyRuns,oldestRunId:completed[0].id,fullResultRunId:completed.at(-1).id,reviewRunId:needsReview.id,url:view(documentReview,needsReview.id),offPageUrl:view(documentReview,completed[0].id),workflowUrl:view(documentReview,undefined,'workflow'),draftEditingInstructions:'Rename Check Document in Workflow without saving. Run Workflow must identify Run Published Workflow; historical Run Graph must retain the accepted version.'},approvalAudit:{branch:approvalAudit,runId:auditRun.id,oldPendingGateId:oldPending.id,resolvedGates:100,pendingGates:2,oldPendingOutsideFirstPage:true,url:view(approvalAudit,auditRun.id)},assisted:assisted.map(item=>({...item,activeUrl:view(item.branch,item.active.id),settledUrl:view(item.branch,item.settled.id)})),budget:{branch:budgetBranch,chargedRunId:charged.branchExecutionId,queuedRunId:queuedEvent.branchExecutionId,url:view(budgetBranch,queuedEvent.branchExecutionId),caller,callerRunId:callerRun.id,calledRunId:called.id,callerUrl:view(caller,callerRun.id)},decisions,generatedResult:{runId:generatedResult.id,url:view(documentReview,generatedResult.id),artifact},retainedEvents:{branch:eventsManual,historicalTriggerId:eventsScheduled.triggerId,occurrenceId:historical.occurrenceId,readStatus:retainedEventRead.status,url:view(eventsManual,undefined)},normal:{chat:normal,agent:normalAgent,url:origin+`/projects/${normal.projectId}/chats/${normal.id}`},initial:inspect()};
  manifest.decisionDraftRetention={branch:retentionBranch,runId:retentionRun.id,url:view(retentionBranch,retentionRun.id),chat:retentionChat,agent:retentionAgent,decisionB:retentionDecision,gateA:{id:retentionGate.id,revision:retentionGate.revision,resolvePath:`/api/branch-gates/${retentionGate.id}/resolve`,resolveBody:{commandKey:randomUUID(),expectedRevision:retentionGate.revision,decision:'approve',output:'Gate A approved by another reviewer.'}},answerPath:`/api/branches/engine/decisions/${retentionDecision.id}/respond`,instructions:'Open Decision B and type/attach an answer. Resolve Gate A independently through its API, then verify the Decision B dialog and draft remain mounted before submitting the answer.'};
  manifest.scheduledRuns={pending:{branch:pendingBranch,counts:pendingCounts,url:view(pendingBranch,undefined),workflowUrl:view(pendingBranch,undefined,'workflow')},uncertain:{branch:updateBranch,runId:updateRun.id,occurrenceId:uncertainCheck.occurrenceId,url:view(updateBranch,updateRun.id)},emptyWorkflowUrl:view(await create('Scheduled Document Review — New Workflow'),undefined,'workflow')};
  const encoded=JSON.stringify(manifest,null,2)+'\n';await writeFile(path.join(f.root,'execution-ui-fixture.json'),encoded);if(manifestPath)await writeFile(path.resolve(manifestPath),encoded);console.log(JSON.stringify(manifest));
  return {manifest,stop};
 }catch(error){await writeFile(path.join(f.root,'execution-ui-setup-error.json'),JSON.stringify({error:String(error),stack:error.stack},null,2)+'\n');await stop();throw error}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {values}=parseArgs({options:{web:{type:'string'},manifest:{type:'string'}}});await startExecutionQualification({web:values.web,manifestPath:values.manifest});
}
