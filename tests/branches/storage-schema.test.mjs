import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentStore } from '@ponderosa/agents';

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
  for(const table of ['branches','branch_executions','branch_step_executions','branch_gates','capability_policies','pinecone_profiles']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),table);
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
  f.complete();
});

test('canonical Agent deletion clears private Pinecone state while preserving restriction authority', t=>{
  const f=fixture(t),store=f.store;
  const project=store.createProject({label:'Profile cleanup',hostPath:f.root,defaultEngine:'codex'});
  const conversation=store.listConversations(project.id)[0];
  const agent=store.createAgent(project.id,{title:'Coordinator',engine:'codex',conversationId:conversation.id});
  const db=store.sqlite,now=new Date().toISOString();
  db.prepare('INSERT INTO pinecone_profiles(agent_id,project_id,conversation_id,guidance_version,created_at) VALUES(?,?,?,?,?)').run(agent.id,project.id,conversation.id,1,now);
  db.prepare('INSERT INTO pinecone_admission_receipts(agent_id,project_id,conversation_id,operation_key,payload_hash,result_json,created_at) VALUES(?,?,?,?,?,?,?)').run(agent.id,project.id,conversation.id,'pause','hash','{}',now);
  const policy=db.prepare('INSERT INTO capability_policies(scope_kind,scope_id,revision,restricted_capability_ids_json,updated_at) VALUES(?,?,?,?,?)');
  policy.run('agent',agent.id,1,'["browser.interact"]',now);
  policy.run('global','ponderosa',1,'["files.import_host"]',now);
  assert.equal(store.deleteAgent(agent.id),true);
  assert.equal(store.getAgent(agent.id),undefined);
  assert.equal(db.prepare('SELECT count(*) n FROM pinecone_profiles').get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM pinecone_admission_receipts').get().n,0);
  assert.equal(db.prepare("SELECT count(*) n FROM capability_policies WHERE scope_kind='agent'").get().n,1);
  assert.equal(db.prepare("SELECT count(*) n FROM capability_policies WHERE scope_kind='global'").get().n,1);
  f.complete();
});
