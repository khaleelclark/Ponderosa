import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,readFileSync,renameSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {AgentStore} from '@ponderosa/agents';
import {initializePredecessorSchema} from '../../packages/agents/dist/db.js';
const require=createRequire(new URL('../../packages/agents/package.json',import.meta.url));
const Database=require('better-sqlite3');
const versions=['0027_schedule_work_lookup.sql','0028_capability_policy_history.sql','0029_assistant_workspace.sql','0030_agent_run_pauses.sql','0031_branch_initial_checkpoints.sql','0032_branch_unit_snapshots.sql','0033_branch_checkpoint_invocations.sql'];
const quote=name=>'"'+name.replaceAll('"','""')+'"';

for(const version of versions)test(`populated exact additive predecessor ${version} upgrades without changing Agent data`,async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'additive-upgrade-')),data=path.join(root,'data'),work=path.join(root,'work');mkdirSync(work);
 let passed=false;t.after(()=>{if(passed)rmSync(root,{recursive:true,force:true});else t.diagnostic(`Retained: ${root}`);});
 let store=new AgentStore(data);const project=store.createProject({label:'Preserved',hostPath:work,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Preserved Chat'}),agent=store.createAgent(project.id,{title:'Preserved Agent',role:'Keep role',speed:'standard',engine:'codex',conversationId:chat.id});
 store.setImportedHistory(agent.id,'Preserved source',[{role:'user',text:'Exact history 😀'}]);store.close();
 const filename=path.join(data,'ponderosa.db'),marker=readFileSync(path.join(data,'.ponderosa-layout-version'),'utf8'),source=new Database(filename),older=new Database(':memory:');
 try{
  initializePredecessorSchema(older,version);
  older.exec(source.prepare("SELECT sql FROM sqlite_master WHERE name='_state_generation'").get().sql);
  older.pragma('foreign_keys=OFF');
  older.transaction(()=>{
   for(const {name} of older.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='_schema_version'").all()){
    const rows=source.prepare(`SELECT * FROM ${quote(name)}`).all();
    for(const row of rows){const keys=Object.keys(row);older.prepare(`INSERT INTO ${quote(name)}(${keys.map(quote).join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));}
   }
  })();
  await older.backup(path.join(root,'predecessor.db'));
 }finally{older.close();source.close();}
 renameSync(path.join(root,'predecessor.db'),filename);
 store=new AgentStore(data);
 try{
  assert.equal(store.getAgent(agent.id).role,'Keep role');assert.equal(store.getAgent(agent.id).speed,'standard');assert.equal(store.getProject(project.id).label,'Preserved');
  assert.equal(store.getImportedHistory(agent.id).messages[0].text,'Exact history 😀');
  assert.ok(store.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='provider_context_recovery_requests'").get());
  assert.equal(readFileSync(path.join(data,'.ponderosa-layout-version'),'utf8'),marker);
 }finally{store.close();}
 passed=true;
});
