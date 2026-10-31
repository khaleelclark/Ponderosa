import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentStore } from '@ponderosa/agents';
import Database from 'better-sqlite3';
import {DataDirectoryAuthority} from '@ponderosa/native-host';
import {storageDatabaseFilename} from '@ponderosa/native-host/sqlite-storage';
import {initializeCurrentDatabase} from '../../packages/agents/dist/db.js';

function fixture(t) {
  const root=mkdtempSync(path.join(tmpdir(),'branches-current-schema-'));
  const data=path.join(root,'data');
  let store=new AgentStore(data),complete=false;
  t.after(()=>{store.close();if(complete)rmSync(root,{recursive:true,force:true});else t.diagnostic(`Retained failed fixture: ${root}`);});
  return {root,get store(){return store},reopen(){store.close();store=new AgentStore(data)},complete(){complete=true}};
}

test('Branch storage survives reopening without restoring archive or direct-Agent Automation authority', t=>{
  const f=fixture(t),db=f.store.sqlite;
  const generation=db.prepare('SELECT generation_id FROM _state_generation').get().generation_id;
  for(const table of ['branches','branch_executions','branch_step_executions','branch_gates','capability_policies']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),table);
  }
  for(const table of ['pinecone_profiles','pinecone_admission_receipts']) {
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table),undefined,'unused preview storage must not enter the current database');
  }
  for(const table of ['agents','conversations']) {
    assert.equal(db.prepare(`PRAGMA table_info(${table})`).all().some(column=>column.name==='archived'),false,'archive is not part of the current format');
  }
  const id=randomUUID(),now=new Date().toISOString();
  db.prepare('INSERT INTO branches(id,chat_id,name,active_version_id,binding_revision_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,'','Schema check','','',now,now);
  const insert=db.prepare(`INSERT INTO trigger_definitions(id,project_id,conversation_id,agent_id,branch_id,name,instructions,source_kind,source_config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  const values=(agent,branch)=>[randomUUID(),'','',agent,branch,'Schedule','','schedule',JSON.stringify({scheduleKind:'interval',everyMs:600000,startsAt:now}),now,now];
  assert.throws(()=>insert.run(...values('unowned-agent',null)),/NOT NULL|CHECK/,'a workflow trigger cannot grant direct Agent-run authority');
  assert.throws(()=>insert.run(...values(null,randomUUID())),/FOREIGN KEY/,'a trigger must belong to an existing Branch');
  insert.run(...values(null,id));
  assert.equal(db.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);
  f.reopen();
  assert.equal(f.store.sqlite.prepare('SELECT generation_id FROM _state_generation').get().generation_id,generation);
  assert.equal(f.store.sqlite.prepare('SELECT branch_id FROM trigger_definitions').get().branch_id,id);
  for(const [index,columns] of [['scheduler_run_activations_by_activation',['activation_id','run_id']],['scheduler_steering_recoveries_by_run',['run_id']]]) {
    assert.deepEqual(f.store.sqlite.prepare(`PRAGMA index_info(${index})`).all().map(column=>column.name),columns);
  }
  // Older schemas retain the shipped refusal boundary. Qualify the explicit
  // offline extension on a separate copy, never silently migrate on startup.
  f.store.sqlite.transaction(()=>{
    f.store.sqlite.exec('DROP INDEX scheduler_run_activations_by_activation; DROP INDEX scheduler_steering_recoveries_by_run;');
    f.store.sqlite.prepare("DELETE FROM _schema_version WHERE name='0027_schedule_work_lookup.sql'").run();
  })();
  f.store.close();
  const data=path.join(f.root,'data'),sourceBytes=readFileSync(path.join(data,'ponderosa.db'));
  assert.throws(()=>f.reopen(),/unsupported or incomplete current state/);
  assert.deepEqual(readFileSync(path.join(data,'ponderosa.db')),sourceBytes);
  const sourceAuthority=new DataDirectoryAuthority(data),converted=path.join(f.root,'converted');
  try{cpSync(data,converted,{recursive:true})}finally{sourceAuthority.close()}
  const targetAuthority=new DataDirectoryAuthority(converted);
  try{
    const offline=new Database(storageDatabaseFilename(path.join(targetAuthority.rootPath,'ponderosa.db')));
    try{initializeCurrentDatabase(offline)}finally{offline.close()}
  }finally{targetAuthority.close()}
  for(let reopen=0;reopen<2;reopen++){
    const admitted=new AgentStore(converted);
    try{
      assert.equal(admitted.sqlite.prepare('SELECT generation_id FROM _state_generation').get().generation_id,generation);
      assert.equal(admitted.sqlite.prepare('SELECT branch_id FROM trigger_definitions').get().branch_id,id);
      assert.equal(admitted.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('scheduler_run_activations_by_activation','scheduler_steering_recoveries_by_run')").get().n,2);
      assert.equal(admitted.sqlite.prepare("SELECT COUNT(*) n FROM _schema_version WHERE name='0027_schedule_work_lookup.sql'").get().n,1);
    }finally{admitted.close()}
  }
  assert.deepEqual(readFileSync(path.join(data,'ponderosa.db')),sourceBytes);
  f.complete();
});
