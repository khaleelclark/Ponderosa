import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {AgentStore,openDb} from '../dist/index.js';
import {openHistoricalDb} from './fixtures/pinecone-legacy/open.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const base='9afdf1f2cbf21effa5372c693af99bf3fd599925';
const snapshot={id:'builtin:pinecone:1',name:'Pinecone',description:'Synthetic',engine:'codex',guidance:'Synthetic bounded instructions'};
const create=(store,p,c,key='cone')=>store.createAgent(p,{experience:'pinecone',title:'Pinecone',engine:'codex',conversationId:c,idempotencyKey:key},undefined,undefined,snapshot);

test('fresh schema and a populated exact-9afdf schema upgrade preserve ordinary data without backfill',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pinecone-upgrade-'));
 try {
  const file=join(dir,'populated.sqlite');
  let {client}=openHistoricalDb(base,file);
  assert.equal(client.prepare("SELECT 1 FROM sqlite_master WHERE name='pinecone_profiles'").get(),undefined);
  client.prepare("INSERT INTO projects(id,label,host_path,created_at,default_engine) VALUES('p','Existing','/tmp/existing','2026-01-01','codex')").run();
  client.prepare("INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES('c','p','Existing','2026-01-01','2026-01-01')").run();
  client.prepare("INSERT INTO agents(id,project_id,conversation_id,title,handle,active_engine,created_at,updated_at,working_copy_json) VALUES('a','p','c','Ordinary','ordinary','codex','2026-01-01','2026-01-01','{}')").run();
  const before=client.prepare('SELECT * FROM agents').all();client.close();
  ({client}=openDb(file));assert.deepEqual(client.prepare('SELECT * FROM agents').all(),before);assert.equal(client.prepare('SELECT count(*) n FROM pinecone_profiles').get().n,0);
  assert.ok(client.prepare("SELECT 1 FROM _schema_version WHERE name='0037_pinecone_profiles.sql'").get());assert.deepEqual(client.pragma('foreign_key_check'),[]);client.close();
  const fresh=openDb(join(dir,'fresh.sqlite'));assert.equal(fresh.client.prepare('SELECT count(*) n FROM pinecone_profiles').get().n,0);assert.ok(fresh.client.prepare("SELECT 1 FROM _schema_version WHERE name='0037_pinecone_profiles.sql'").get());fresh.client.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

for(const phase of ['before_commit','after_commit'])test(`actual process crash ${phase} recovers owned staging and atomic profile identity`,()=>{
 const dir=mkdtempSync(join(tmpdir(),'pinecone-crash-'));let store=new AgentStore(dir);
 try {
  const p=store.createProject({label:'Synthetic',hostPath:dir,defaultEngine:'codex'}),c=store.createConversation(p.id,{title:'Synthetic'});store.close();
  const script=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {AgentStore} from ${JSON.stringify(pathToFileURL(join(root,'packages/agents/dist/index.js')).href)};
const store=new AgentStore(${JSON.stringify(dir)});${phase==='before_commit'?`store.sqlite.function('fixture_crash',()=>process.exit(71));store.sqlite.exec("CREATE TRIGGER crash_profile BEFORE INSERT ON pinecone_profiles BEGIN SELECT fixture_crash(); END");`:`const original=fs.renameSync;fs.renameSync=(from,to)=>{if(String(from).endsWith('.creating'))process.exit(72);return original(from,to);};syncBuiltinESMExports();`}
store.createAgent(${JSON.stringify(p.id)},{experience:'pinecone',title:'Pinecone',engine:'codex',conversationId:${JSON.stringify(c.id)},idempotencyKey:'crash'},undefined,undefined,${JSON.stringify(snapshot)});`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:root,encoding:'utf8',timeout:10000});assert.equal(result.status,phase==='before_commit'?71:72,result.stderr);
  store=new AgentStore(dir);if(phase==='before_commit')store.sqlite.exec('DROP TRIGGER crash_profile');
  const n=phase==='before_commit'?0:1;assert.equal(store.sqlite.prepare('SELECT count(*) n FROM pinecone_profiles').get().n,n);assert.equal(store.listAgents(p.id).length,n);assert.equal(store.sqlite.prepare("SELECT count(*) n FROM capability_policies WHERE scope_kind='agent' AND restricted_capability_ids_json='[\"agents.create_managed\"]' AND revision=1").get().n,n);
  if(n){const agent=store.listAgents(p.id)[0];assert.ok(store.getPineconeProfile(agent.id));assert.ok(existsSync(join(dir,'projects',p.id,'agents',agent.id,'agent.json')));store.rebuildProjections();assert.ok(store.getPineconeProfile(agent.id));}
  assert.equal(readdirSync(join(dir,'projects',p.id,'agents')).filter(name=>name.includes('.creating')||name.startsWith('.agent-creation-')).length,0);assert.deepEqual(store.sqlite.pragma('foreign_key_check'),[]);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('canonical store denies fabricated managed/opening identities and deletes profile on Project cleanup',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pinecone-store-')),store=new AgentStore(dir);
 try{
  const p=store.createProject({label:'Synthetic',hostPath:dir,defaultEngine:'codex'}),c=store.createConversation(p.id,{title:'Synthetic'});
  for(const extra of [{initialMessage:''},{managerAgentId:'a'},{presetId:'custom'},{draftAttachmentIds:[]},{managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}}])assert.throws(()=>store.createAgent(p.id,{experience:'pinecone',title:'Pinecone',engine:'codex',conversationId:c.id,idempotencyKey:'fabrication',...extra},undefined,undefined,snapshot),/empty creation/);
  assert.throws(()=>store.createAgent(p.id,{experience:'pinecone',title:'Pinecone',engine:'codex',conversationId:c.id,idempotencyKey:'fabrication'},{agentId:'parent',executionId:'run',prompt:'work'},undefined,snapshot),/empty creation/);
  const ordinary=store.createAgent(p.id,{title:'Ordinary',engine:'codex',conversationId:c.id,idempotencyKey:'ordinary'});
  assert.throws(()=>create(store,p.id,c.id,'ordinary'),/different experience/);assert.equal(store.getPineconeProfile(ordinary.id),undefined);
  const agent=create(store,p.id,c.id);assert.throws(()=>create(store,p.id,c.id,'other'),/already has Pinecone/);store.rebuildProjections();assert.equal(store.getPineconeProfile(agent.id).agentId,agent.id);
  store.deleteAgent(agent.id);store.deleteAgent(ordinary.id);const receipt=store.commitConversationDeletion(c.id);assert.ok(receipt);
  store.finishConversationDeletionStorageCleanup(receipt);store.markConversationDeletionServerCleanupComplete(c.id);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM pinecone_profiles').get().n,0);
  const cleanupProject=store.createProject({label:'Independent Project cleanup',hostPath:dir,defaultEngine:'codex'});
  const nextChat=store.createConversation(cleanupProject.id,{title:'Project cleanup'});create(store,cleanupProject.id,nextChat.id,'project-cleanup');
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM pinecone_profiles').get().n,1);
  assert.equal(store.deleteProject(cleanupProject.id),true);assert.equal(store.sqlite.prepare('SELECT count(*) n FROM pinecone_profiles').get().n,0);assert.deepEqual(store.sqlite.pragma('foreign_key_check'),[]);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('only new Pinecones seed the existing policy transaction; Allow, replay and reopen never reseed',async()=>{
 const {CapabilityPolicyStore,CAPABILITY_IDS}=await import('../dist/index.js').then(async agents=>({...agents,...await import('@ponderosa/core')}));
 const dir=mkdtempSync(join(tmpdir(),'pinecone-default-'));let store=new AgentStore(dir);
 try{
  const p=store.createProject({label:'Default',hostPath:dir,defaultEngine:'codex'}),c=store.getConversation(p.lastConversationId);
  const ordinary=store.createAgent(p.id,{title:'Ordinary',engine:'codex',conversationId:c.id});let policies=new CapabilityPolicyStore(store.sqlite);assert.equal(policies.get('agent',ordinary.id),undefined);
  const a=create(store,p.id,c.id);assert.deepEqual(policies.get('agent',a.id).restrictedCapabilityIds,[CAPABILITY_IDS.managedAgentCreate]);assert.equal(policies.get('agent',a.id).revision,1);
  const allowed=policies.put({scopeKind:'agent',scopeId:a.id,expectedRevision:1,restrictedCapabilityIds:[]});assert.equal(create(store,p.id,c.id).id,a.id);assert.deepEqual(policies.get('agent',a.id),allowed);
  store.close({checkpointWrites:true});store=new AgentStore(dir);policies=new CapabilityPolicyStore(store.sqlite);assert.deepEqual(policies.get('agent',a.id),allowed);
  // Existing profile with no policy stays absent; startup and replay do not backfill.
  store.sqlite.prepare("DELETE FROM capability_policies WHERE scope_kind='agent' AND scope_id=?").run(a.id);store.rebuildProjections();assert.equal(create(store,p.id,c.id).id,a.id);assert.equal(policies.get('agent',a.id),undefined);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('policy seed failure rolls back Agent, profile, reservation, policy and owned staging',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pinecone-policy-failure-')),store=new AgentStore(dir);
 try{const p=store.createProject({label:'Failure',hostPath:dir,defaultEngine:'codex'}),c=store.getConversation(p.lastConversationId);
  store.sqlite.exec("CREATE TRIGGER fail_pinecone_policy BEFORE INSERT ON capability_policies BEGIN SELECT RAISE(FAIL,'policy seed fixture'); END");
  assert.throws(()=>create(store,p.id,c.id),/policy seed fixture/);for(const table of ['agents','pinecone_profiles','capability_policies','agent_handle_reservations'])assert.equal(store.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  assert.equal(readdirSync(join(dir,'projects',p.id,'agents')).length,0);store.sqlite.exec('DROP TRIGGER fail_pinecone_policy');assert.ok(create(store,p.id,c.id));
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
