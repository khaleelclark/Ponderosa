import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import test from 'node:test';
import {mkdtempSync,mkdirSync,readFileSync,renameSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {AgentStore} from '@ponderosa/agents';
import {initializePredecessorSchema} from '../../packages/agents/dist/db.js';
const require=createRequire(new URL('../../packages/agents/package.json',import.meta.url));
const Database=require('better-sqlite3');
const versions=['0027_schedule_work_lookup.sql','0028_capability_policy_history.sql','0029_assistant_workspace.sql','0030_agent_run_pauses.sql','0031_branch_initial_checkpoints.sql','0032_branch_unit_snapshots.sql','0033_branch_checkpoint_invocations.sql','0042_destination_retained_sources.sql','0043_package_export_cache.sql','0044_memory_scope_provisioning.sql','0045_agent_import_submission_intents.sql','0046_retained_coordination_cut_sources.sql'];
const quote=name=>'"'+name.replaceAll('"','""')+'"';

const cases=[...versions.map(version=>({version,shape:'current-prefix'})),
 ...['ui096','ui096-foreign','ui096-partial'].map(shape=>({version:'0027_schedule_work_lookup.sql',shape}))];
for(const {version,shape} of cases)test(`populated exact additive predecessor ${version} ${shape} admission preserves Agent data`,async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'additive-upgrade-')),data=path.join(root,'data'),work=path.join(root,'work');mkdirSync(work);
 let passed=false;t.after(()=>{if(passed)rmSync(root,{recursive:true,force:true});else t.diagnostic(`Retained: ${root}`);});
 let store=new AgentStore(data);const project=store.createProject({label:'Preserved',hostPath:work,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Preserved Chat'}),agent=store.createAgent(project.id,{title:'Preserved Agent',role:'Keep role',speed:'standard',engine:'codex',conversationId:chat.id});
 store.setImportedHistory(agent.id,'Preserved source',[{role:'user',text:'Exact history 😀'}]);
 const eventId=randomUUID();
 store.appendCommunicationEvent({schemaVersion:2,eventId,projectId:project.id,conversationId:chat.id,sender:{kind:'user',userId:'local'},intent:'broadcast',audience:{kind:'organization',organizationId:project.id},text:'Evergreen audit proof',createdAt:'2026-10-24T00:00:00.000Z'});
 store.close();
 const filename=path.join(data,'ponderosa.db'),marker=readFileSync(path.join(data,'.ponderosa-layout-version'),'utf8'),source=new Database(filename),older=new Database(':memory:');
 try{
  initializePredecessorSchema(older,version);
  // The published ui096 0027 schema predates native_task_stops; the baseline
  // later gained it even for reconstructed historical prefixes.
  if(shape.startsWith('ui096'))older.exec('DROP TABLE native_task_stops');
  if(shape==='ui096-partial')older.exec('DROP TABLE coordination_requests');
  older.exec(source.prepare("SELECT sql FROM sqlite_master WHERE name='_state_generation'").get().sql);
  older.pragma('foreign_keys=OFF');
  // The predecessor initializer seeds this bookkeeping row. Replace that
  // fixture-only default with the source's actual generation data.
  older.prepare('DELETE FROM collection_generations').run();
  const tableTypes=new Map(older.pragma('table_list').filter(row=>row.schema==='main').map(row=>[row.name,row.type]));
  older.transaction(()=>{
   const tables=older.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='_schema_version'").all();
   tables.sort((a,b)=>Number(a.name==='collection_generations')-Number(b.name==='collection_generations'));
   for(const {name} of tables){
    const type=tableTypes.get(name);if(type==='shadow')continue;
    // Earlier inserts fire generation triggers; copy the source bookkeeping last.
    if(name==='collection_generations')older.prepare('DELETE FROM collection_generations').run();
    const rows=source.prepare(`SELECT ${type==='virtual'||name==='compaction_history_messages'?'rowid AS __fixture_rowid,':''}* FROM ${quote(name)}`).all();
    for(const row of rows){
     const keys=Object.keys(row),columns=keys.map(k=>k==='__fixture_rowid'?'rowid':k);
     try{older.prepare(`INSERT INTO ${quote(name)}(${columns.map(quote).join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));}
     catch(error){throw new Error(`Cannot copy predecessor fixture table ${name}: ${error.message}`,{cause:error});}
    }
   }
  })();
  assert.equal(older.prepare("SELECT communication_event_id FROM compaction_history_fts WHERE compaction_history_fts MATCH 'evergreen'").get().communication_event_id,eventId,'The nonempty source index was copied through its virtual table');
  if(shape==='ui096-foreign')older.exec('CREATE TABLE foreign_authority (id TEXT PRIMARY KEY)');
  await older.backup(path.join(root,'predecessor.db'));
 }finally{older.close();source.close();}
 renameSync(path.join(root,'predecessor.db'),filename);
 if(shape==='ui096-foreign'||shape==='ui096-partial'){
  const hash=()=>createHash('sha256').update(readFileSync(filename)).digest('hex'),before=hash();
  assert.throws(()=>new AgentStore(data),/unsupported or incomplete current state/);
  assert.equal(hash(),before,'refused predecessor bytes remain unchanged');
  passed=true;return;
 }
 store=new AgentStore(data);
 try{
  assert.equal(store.getAgent(agent.id).role,'Keep role');assert.equal(store.getAgent(agent.id).speed,'standard');assert.equal(store.getProject(project.id).label,'Preserved');
  assert.equal(store.getImportedHistory(agent.id).messages[0].text,'Exact history 😀');
  const found=store.sqlite.prepare("SELECT communication_event_id,text FROM compaction_history_fts WHERE compaction_history_fts MATCH 'evergreen'").get();
  assert.deepEqual(found,{communication_event_id:eventId,text:'Evergreen audit proof'});
  assert.ok(store.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='provider_context_recovery_requests'").get());
  assert.ok(store.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_exposure_runs'").get());
  assert.equal(store.sqlite.prepare("SELECT count(*) AS n FROM memory_exposure_runs").get().n,0);
  assert.equal(readFileSync(path.join(data,'.ponderosa-layout-version'),'utf8'),marker);
 }finally{store.close();}
 passed=true;
});
