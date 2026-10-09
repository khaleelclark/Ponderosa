import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,chmodSync,readFileSync,readlinkSync,readdirSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {AgentStore,BranchStore,CoordinationV3Store,userCommunicationArtifactOwners} from '@ponderosa/agents';
import {createServer} from '../dist/app.js';
import {AssetStore} from '../dist/assets.js';
import {appendReadableArtifactReferences} from '../dist/communication-artifacts.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const longText = label => `${label}\n${'Complete private source 😀\n'.repeat(600)}TAIL_${label}`;
const ownReaders = root => readdirSync('/proc/self/fd').flatMap(fd => {
  try {const target=readlinkSync(`/proc/self/fd/${fd}`);return target.includes(root)?[{fd,target}]:[];}catch{return [];}
});

test('canonical user documents retain exact Chat/product custody and private byte authority',async()=>{
  const root=mkdtempSync(join(tmpdir(),'uac-'));chmodSync(root,0o700);
  const data=join(root,'data'),store=new AgentStore(data),coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination);
  let app,assets,starts=0,primary;const secondary=[];
  console.log('FIXTURE '+JSON.stringify({root,mode:statSync(root).mode&0o777,physicalDatabasePath:join(data,'ponderosa.db')}));
  const observations=[];
  const observe=async(label,url,options={})=>{
    const r=await app.inject({url,...options});
    const record={label,method:options.method??'GET',url,status:r.statusCode,body:r.body};observations.push(record);
    console.log('HTTP '+JSON.stringify(record));return r;
  };
  try {
    const project=store.createProject({label:'Mixed user custody',hostPath:root,defaultEngine:'codex'});
    const devChat=store.getConversation(project.lastConversationId),branch=branches.create('Custody','custody'),branchChat=store.createConversation(project.id,{title:'Branch custody'});
    store.sqlite.prepare('UPDATE conversations SET branch_id=? WHERE id=?').run(branch.id,branchChat.id);
    const survivingBranchChat=store.createConversation(project.id,{title:'Surviving Branch product anchor'});
    store.sqlite.prepare('UPDATE conversations SET branch_id=? WHERE id=?').run(branch.id,survivingBranchChat.id);
    const otherChat=store.createConversation(project.id,{title:'Unrelated Dev Chat'}),otherProject=store.createProject({label:'Unrelated Project',hostPath:root,defaultEngine:'codex'});
    const agent=(projectId,chat,title)=>store.createAgent(projectId,{title,engine:'codex',conversationId:chat});
    const recipient=agent(project.id,devChat.id,'Recipient'),sibling=agent(project.id,devChat.id,'Sibling'),other=agent(project.id,otherChat.id,'Other Chat'),foreign=agent(otherProject.id,otherProject.lastConversationId,'Other Project'),branchAgent=agent(project.id,branchChat.id,'Branch Recipient');
    // Normal domain intake/projection is exercised; the existing drained-server
    // mode prevents provider starts without minting Runs or terminal replies.
    const adapter={id:'codex',displayName:'INERT subscription custody test',listModels:()=>[],listEfforts:()=>[],run(){starts++;throw Error('Provider execution is outside this test');}};
    app=createServer({dataDir:data,store,logger:false,startDrained:true,engines:[{adapter,authStatus:async()=>({authenticated:true})}]});
    await app.ready();assets=new AssetStore(data);
    assert.equal(store.getAgent('local-operator'),undefined);
    const publish=async(agent,chat,prefix,key,broadcast=false)=>{
      const text=longText(key);
      const r=await observe(`publish ${key}`,`${prefix}/agents/${agent.id}/messages`,{method:'POST',payload:{text,idempotencyKey:key,activeRunDelivery:'queue',...(broadcast?{shareWithOrganization:true,sourceConversationId:chat.id,sourceChannel:'main'}:{})}});
      assert.equal(r.statusCode,202,r.body);
      const event=store.getCommunicationEvent(project.id,r.json().communicationEventId);assert.ok(event?.document);
      assert.equal(event.sender.kind,'user');assert.equal(event.sender.userId,'local-operator');
      assert.equal(event.conversationId,chat.id);assert.equal(event.intent,broadcast?'broadcast':'user_dm');
      const id=event.document.artifactId,artifact=store.getProjectArtifact(project.id,id),runtime=coordination.runtimeArtifact(id);
      assert.ok(artifact);assert.ok(runtime);assert.equal(artifact.agentId,'local-operator');assert.equal(artifact.originAgentId,'local-operator');
      assert.equal(runtime.originAgentId,undefined);assert.equal(runtime.executionId,undefined);
      assert.equal(event.document.id,id);assert.equal(artifact.size,Buffer.byteLength(text));assert.equal(artifact.sha256,sha(text));
      const access=store.getProjectArtifactAccess(project.id,id);
      assert.equal(access.ownerKind,'communication');assert.equal(access.ownerId,event.eventId);assert.deepEqual(access.audience,event.audience);assert.equal(access.senderAgentId,undefined);
      const download=await observe(`download ${key}`,`${prefix}/projects/${project.id}/artifacts/${id}/download`);
      assert.equal(download.statusCode,200,download.body);assert.equal(download.rawPayload.toString('utf8'),text);assert.equal(sha(download.rawPayload),sha(text));
      const wrong=await observe(`wrong product ${key}`,`${prefix==='/api'?'/api/branches/engine':'/api'}/projects/${project.id}/artifacts/${id}/download`);assert.equal(wrong.statusCode,404,wrong.body);
      console.log('CANONICAL '+JSON.stringify({key,event,artifact,runtime,access,byteLength:Buffer.byteLength(text),sha256:sha(text)}));
      return {id,event,artifact,text,prefix};
    };
    const dm=await publish(recipient,devChat,'/api','dev-private');
    const bdm=await publish(branchAgent,branchChat,'/api/branches/engine','branch-private');
    // Exercise the actual native provider-reference authorization path. This
    // grants a complete local file only after the store's real Agent checks.
    for(const [reader,allowed] of [[recipient,true],[sibling,false],[other,false],[foreign,false],[branchAgent,false]]){
      assert.equal(store.agentCanReadProjectArtifact(project.id,dm.id,reader.id),allowed);
      const prompt=appendReadableArtifactReferences({prompt:`ponderosa://artifact/${dm.id}`,projectId:project.id,agentId:reader.id,store,assets});
      const metadata=JSON.parse(prompt.split('\n').at(-1));
      if(allowed){assert.equal(readFileSync(metadata.localPath,'utf8'),dm.text);assert.equal(metadata.sha256,sha(dm.text));}
      else {assert.deepEqual(metadata,{artifactId:dm.id,available:false});assert.equal(metadata.localPath,undefined);}
      console.log('AGENT AUTHORIZATION '+JSON.stringify({reader:reader.id,chat:reader.conversationId,allowed,metadata}));
    }
    assert.equal(store.agentCanReadProjectArtifact(project.id,bdm.id,branchAgent.id),true);
    assert.equal(store.agentCanReadProjectArtifact(project.id,bdm.id,recipient.id),false);
    for(const [prefix,chat] of [['/api',devChat],['/api/branches/engine',branchChat]]){
      const page=await observe('DM excluded from catalog',`${prefix}/projects/${project.id}/artifacts?conversationId=${chat.id}&limit=1`);assert.equal(page.statusCode,200,page.body);assert.deepEqual(page.json().items,[]);
      assert.deepEqual(store.getProjectContextArtifacts(project.id,100,chat.id),[]);
    }
    const broadcast=await publish(recipient,devChat,'/api','dev-broadcast',true);
    const branchBroadcast=await publish(branchAgent,branchChat,'/api/branches/engine','branch-broadcast',true);
    const broadcast2=await publish(recipient,devChat,'/api','dev-broadcast-new',true);
    const newest=await observe('Dev pagination first',`/api/projects/${project.id}/artifacts?limit=1`);assert.deepEqual(newest.json().items.map(x=>x.id),[broadcast2.id]);assert.equal(newest.json().history.hasMore,true);
    const next=await observe('Dev pagination next',`/api/projects/${project.id}/artifacts?limit=1&cursor=${encodeURIComponent(newest.json().history.cursor)}`);assert.deepEqual(next.json().items.map(x=>x.id),[broadcast.id]);
    const branchPage=await observe('Branches catalog',`/api/branches/engine/projects/${project.id}/artifacts?conversationId=${branchChat.id}&limit=1`);assert.deepEqual(branchPage.json().items.map(x=>x.id),[branchBroadcast.id]);
    const search=await observe('canonical search',`/api/projects/${project.id}/artifacts?q=Pasted&conversationId=${devChat.id}&limit=1`);assert.deepEqual(search.json().items.map(x=>x.id),[broadcast2.id]);
    const metadata=await observe('serialized canonical artifact',`/api/projects/${project.id}/artifacts/${broadcast.id}`);assert.equal(metadata.statusCode,200,metadata.body);assert.equal(metadata.json().id,broadcast.id);
    const branchMetadata=await observe('serialized Branch artifact',`/api/branches/engine/projects/${project.id}/artifacts/${branchBroadcast.id}`);assert.equal(branchMetadata.statusCode,200,branchMetadata.body);assert.equal(branchMetadata.json().id,branchBroadcast.id);assert.ok(branchMetadata.json().downloadUrl.startsWith('/api/branches/engine/'));
    const privateMetadata=await observe('private metadata remains unavailable',`/api/projects/${project.id}/artifacts/${dm.id}`);assert.equal(privateMetadata.statusCode,404,privateMetadata.body);
    // Publishing/pinning does not change immutable audience.
    store.updateProjectArtifactVisibility(project.id,dm.id,'published',true);
    store.updateProjectArtifactVisibility(project.id,broadcast.id,'published',true);
    store.updateProjectArtifactVisibility(project.id,branchBroadcast.id,'published',true);
    assert.deepEqual(store.getProjectContextArtifacts(project.id,100,devChat.id).map(x=>x.id),[broadcast.id]);
    assert.deepEqual(store.getProjectContextArtifacts(project.id,100,branchChat.id).map(x=>x.id),[branchBroadcast.id]);
    assert.equal(store.agentCanReadProjectArtifact(project.id,broadcast.id,sibling.id),true);
    assert.equal(store.agentCanReadProjectArtifact(project.id,broadcast.id,other.id),false);
    // A present falsey execution/recovery field is malformed provenance, even
    // with otherwise exact authored/runtime records and the original bytes.
    const immutableRecords=()=>JSON.stringify({
      events:store.readCommunicationEvents(project.id),
      artifacts:store.sqlite.prepare('SELECT * FROM runtime_artifacts ORDER BY id').all(),
      communications:store.sqlite.prepare('SELECT * FROM runtime_communications ORDER BY id').all(),
    });
    const immutableBefore=immutableRecords();
    const provenanceObservation=async(label,publication,field,value)=>{
      const candidate=store.sqlite.prepare('SELECT * FROM managed_artifact_projection WHERE project_id=? AND artifact_id=?').get(project.id,publication.id);
      const events=store.readCommunicationEvents(project.id);
      const owner=userCommunicationArtifactOwners(store.sqlite,events,project.id).get(publication.id);
      const authorized=store.agentCanReadProjectArtifact(project.id,publication.id,recipient.id);
      const native=JSON.parse(appendReadableArtifactReferences({prompt:`ponderosa://artifact/${publication.id}`,projectId:project.id,agentId:recipient.id,store,assets}).split('\n').at(-1));
      const download=await observe(label,`/api/projects/${project.id}/artifacts/${publication.id}/download`);
      const catalog=await observe(`${label} catalog`,`/api/projects/${project.id}/artifacts?conversationId=${devChat.id}&limit=100`);
      const context=store.getProjectContextArtifacts(project.id,100,devChat.id);
      const record={label,field,value,publicationId:publication.id,projectId:project.id,chatId:devChat.id,readerId:recipient.id,candidate,
        canonicalEvent:events.find(event=>event.eventId===publication.event.eventId),runtime:coordination.runtimeArtifact(publication.id),
        access:store.getProjectArtifactAccess(project.id,publication.id),owner:owner??null,authorized,native,
        download:{status:download.statusCode,body:download.body,bytes:download.rawPayload.length,sha256:sha(download.rawPayload)},
        catalog:{status:catalog.statusCode,body:catalog.body},context,immutableRecordsUnchanged:immutableBefore===immutableRecords()};
      if(native.localPath){const body=readFileSync(native.localPath);record.nativeBytes={bytes:body.length,sha256:sha(body),body:body.toString('utf8')};}
      console.log('STRICT PROVENANCE '+JSON.stringify(record));
      return {record,download,catalog,context};
    };
    for(const publication of [dm,broadcast]){
      const retained=store.sqlite.prepare('SELECT * FROM managed_artifact_projection WHERE project_id=? AND artifact_id=?').get(project.id,publication.id);
      for(const [field,value] of [['executionId',null],['executionId',''],['legacyRecovery',null],['legacyRecovery',false]]){
        const label=`${publication===dm?'private':'Broadcast'} malformed ${field}=${JSON.stringify(value)}`;
        store.sqlite.prepare('UPDATE managed_artifact_projection SET artifact_json=? WHERE project_id=? AND artifact_id=?').run(JSON.stringify({...JSON.parse(retained.artifact_json),[field]:value}),project.id,publication.id);
        try{
          const {record,download,catalog,context}=await provenanceObservation(label,publication,field,value);
          assert.equal(JSON.parse(record.candidate.artifact_json)[field],value);
          assert.equal(record.immutableRecordsUnchanged,true);
          assert.equal(record.owner,null);assert.equal(record.authorized,false);
          assert.deepEqual(record.native,{artifactId:publication.id,available:false});assert.equal(record.native.localPath,undefined);
          assert.equal(download.statusCode,404,download.body);assert.equal(catalog.statusCode,200,catalog.body);
          assert.equal(catalog.json().items.some(item=>item.id===publication.id),false);
          assert.equal(context.some(item=>item.id===publication.id),false);
        }finally{
          store.sqlite.prepare('UPDATE managed_artifact_projection SET artifact_json=? WHERE project_id=? AND artifact_id=?').run(retained.artifact_json,project.id,publication.id);
        }
        const {record,download,catalog,context}=await provenanceObservation(`${label} restored`,publication,field,value);
        assert.deepEqual(record.candidate,retained);assert.equal(record.immutableRecordsUnchanged,true);
        assert.deepEqual(record.owner,{conversationId:devChat.id,product:'dev'});assert.equal(record.authorized,true);
        assert.equal(download.statusCode,200,download.body);assert.equal(download.rawPayload.toString('utf8'),publication.text);assert.equal(sha(download.rawPayload),sha(publication.text));
        assert.equal(record.nativeBytes.body,publication.text);assert.equal(record.nativeBytes.sha256,sha(publication.text));assert.equal(record.native.sha256,sha(publication.text));
        assert.equal(catalog.statusCode,200,catalog.body);
        assert.equal(catalog.json().items.some(item=>item.id===publication.id),publication===broadcast);
        assert.deepEqual(catalog.json().items.map(item=>item.id),[broadcast.id,broadcast2.id]);
        assert.deepEqual(context.map(item=>item.id),[broadcast.id]);
        assert.equal(store.agentCanReadProjectArtifact(project.id,dm.id,sibling.id),false);
        assert.equal(store.agentCanReadProjectArtifact(project.id,broadcast.id,other.id),false);
      }
    }
    // Fault injection changes only disposable managed projections. Authored
    // events/runtime rows remain immutable; every denial uses actual guards.
    const original=store.sqlite.prepare('SELECT * FROM managed_artifact_projection WHERE project_id=? AND artifact_id=?').get(project.id,dm.id);
    const restore=()=>store.sqlite.prepare('UPDATE managed_artifact_projection SET artifact_json=?,owner_kind=?,owner_id=?,audience_json=?,sender_agent_id=? WHERE project_id=? AND artifact_id=?').run(original.artifact_json,original.owner_kind,original.owner_id,original.audience_json,original.sender_agent_id,project.id,dm.id);
    for(const [label,sql,value] of [
      ['missing owner','owner_id=?','missing'],['wrong owner kind','owner_kind=?','project'],
      ['forged audience','audience_json=?',JSON.stringify({kind:'organization',organizationId:project.id})],
      ['forged sender','sender_agent_id=?',recipient.id],
      ['mismatched document','artifact_json=?',JSON.stringify({...JSON.parse(original.artifact_json),path:'forged.md'})],
      ['forged Agent origin','artifact_json=?',JSON.stringify({...JSON.parse(original.artifact_json),agentId:recipient.id,originAgentId:recipient.id})],
      ['mismatched hash','artifact_json=?',JSON.stringify({...JSON.parse(original.artifact_json),sha256:'a'.repeat(64)})],
    ]){
      store.sqlite.prepare(`UPDATE managed_artifact_projection SET ${sql} WHERE project_id=? AND artifact_id=?`).run(value,project.id,dm.id);
      try{const denied=await observe(label,`/api/projects/${project.id}/artifacts/${dm.id}/download`);assert.equal(denied.statusCode,404,denied.body);assert.equal(store.agentCanReadProjectArtifact(project.id,dm.id,recipient.id),false);}finally{restore();}
    }
    const events=store.readCommunicationEvents(project.id);
    assert.equal(userCommunicationArtifactOwners(store.sqlite,[...events,dm.event],project.id).has(dm.id),false,'ambiguous canonical document fails closed');
    const binding=store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,?,'',?,?)");binding.run(branch.id,'custody-fixture','branch-chat',branchChat.id,'staging');
    for(const state of ['staging','retiring']){
      store.sqlite.prepare('UPDATE branch_installation_resources SET state=? WHERE local_id=?').run(state,branchChat.id);
      const denied=await observe(state,`/api/branches/engine/projects/${project.id}/artifacts/${bdm.id}/download`);assert.equal(denied.statusCode,404,denied.body);
      const page=await observe(`${state} catalog`,`/api/branches/engine/projects/${project.id}/artifacts`);assert.equal(page.statusCode,200,page.body);assert.deepEqual(page.json().items,[]);
      assert.deepEqual(store.getProjectContextArtifacts(project.id,100,branchChat.id),[]);
    }
    store.sqlite.prepare("UPDATE branch_installation_resources SET state='active' WHERE local_id=?").run(branchChat.id);
    assert.equal((await observe('active restored',`/api/branches/engine/projects/${project.id}/artifacts/${bdm.id}/download`)).statusCode,200);
    let activeDeletionError;
    try{store.markConversationDeletionPending(branchChat.id);}catch(error){activeDeletionError=error;}
    const activeReceipt=store.getConversationDeletionReceipt(branchChat.id);
    console.log('ACTIVE DELETION GUARD '+JSON.stringify({error:activeDeletionError?.message??null,receipt:activeReceipt??null,resource:store.sqlite.prepare('SELECT * FROM branch_installation_resources WHERE local_id=?').all(branchChat.id)}));
    assert.equal(activeDeletionError?.message,'Remove this Chat through a reviewed Branch update and wait for existing executions to drain');
    assert.equal(activeReceipt,undefined);
    // This is the same disposable installation projection used above; retain
    // its Branch identity and sequence retirement before normal domain deletion.
    store.sqlite.prepare("UPDATE branch_installation_resources SET state='retiring' WHERE local_id=?").run(branchChat.id);
    const ownership={
      resource:store.sqlite.prepare('SELECT * FROM branch_installation_resources WHERE local_id=?').all(branchChat.id),
      executions:store.sqlite.prepare("SELECT e.* FROM branch_executions e JOIN conversations c ON e.id=c.branch_execution_id WHERE c.id=? AND e.state IN ('queued','running','waiting')").all(branchChat.id),
      references:store.sqlite.prepare("SELECT ref.*,e.state FROM branch_resource_references ref JOIN branch_executions e ON e.id=ref.execution_id WHERE ref.chat_id=? AND e.state IN ('queued','running','waiting')").all(branchChat.id),
    };
    console.log('RETIRING DELETION OWNERSHIP '+JSON.stringify(ownership));
    assert.equal(ownership.resource.length,1);assert.equal(ownership.resource[0].branch_id,branch.id);assert.equal(ownership.resource[0].state,'retiring');assert.equal(ownership.resource[0].agent_ref,'');
    assert.deepEqual(ownership.executions,[]);assert.deepEqual(ownership.references,[]);
    store.markConversationDeletionPending(branchChat.id);
    assert.equal((await observe('deletion pending',`/api/branches/engine/projects/${project.id}/artifacts/${bdm.id}/download`)).statusCode,404);
    store.deleteAgent(branchAgent.id,id=>coordination.handleAgentDeletion(id));
    store.commitConversationDeletion(branchChat.id);
    assert.equal(store.getConversation(branchChat.id),undefined);
    const historical=await observe('canonical historical Branch custody',`/api/branches/engine/projects/${project.id}/artifacts/${bdm.id}/download`);assert.equal(historical.statusCode,200,historical.body);assert.equal(sha(historical.rawPayload),sha(bdm.text));
    assert.equal((await observe('historical wrong product',`/api/projects/${project.id}/artifacts/${bdm.id}/download`)).statusCode,404);
    assert.equal(store.agentCanReadProjectArtifact(project.id,bdm.id,branchAgent.id),false);
    store.deleteAgent(sibling.id,id=>coordination.handleAgentDeletion(id));
    assert.equal(store.agentCanReadProjectArtifact(project.id,dm.id,sibling.id),false);
    store.markProjectDeletionPending(project.id);
    assert.equal((await observe('Project deletion pending',`/api/projects/${project.id}/artifacts/${dm.id}/download`)).statusCode,404);
    assert.equal(starts,0);
    console.log('REGRESSION PASS '+JSON.stringify({observations:observations.length,providerStarts:starts,actualRuns:store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,originalDefectOracle:'first normal private download must be200; base724 requires nonexistent local-operator Agent'}));
  }catch(error){primary=error;console.log('PRIMARY '+JSON.stringify({name:error.name,message:error.message,stack:error.stack}));}
  finally{
    // Await finite request ownership before normal teardown; no synthetic reply
    // or successful canonical settlement is manufactured by a DB drain.
    try {console.log('RESIDUAL '+JSON.stringify(Object.fromEntries(['scheduler_runs','agent_activations','required_reply_obligations','activation_outbox'].map(table=>[table,store.sqlite.prepare(`SELECT * FROM ${table}`).all()]))));}catch(error){secondary.push({phase:'residual',message:error.message});}
    try{assets?.close();}catch(error){secondary.push({phase:'asset reader close',message:error.message});}
    try{app?.prepareForShutdown();await app?.close();}catch(error){secondary.push({phase:'Fastify/store close',message:error.message});}
    try{store.close();}catch(error){secondary.push({phase:'store close',message:error.message});}
    const readers=ownReaders(root),body=readFileSync(join(data,'ponderosa.db'));
    console.log('SETTLED '+JSON.stringify({root,rootsPreserved:true,providerStarts:starts,primary:primary?.message??null,secondary,remainingOwnReaders:readers,databaseBytes:body.length,databaseSha256:sha(body),noHTTPListener:true}));
    const cleanupFailures=[];
    try{assert.deepEqual(secondary,[]);}catch(error){cleanupFailures.push(error);}
    try{assert.deepEqual(readers,[]);}catch(error){cleanupFailures.push(error);}
    if(cleanupFailures.length){
      console.log('CLEANUP FAILURE '+JSON.stringify(cleanupFailures.map(error=>({name:error.name,message:error.message,stack:error.stack}))));
      throw new AggregateError([...(primary?[primary]:[]),...cleanupFailures],'Custody regression or normal cleanup failed');
    }
  }
  if(primary)throw primary;
});
