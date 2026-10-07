import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import Database from 'better-sqlite3';
const schema=name=>readFileSync(new URL(`../src/schema/${name}`,import.meta.url),'utf8');
test('Branch destination migration preserves existing trigger definitions, occurrences, bursts and collection hooks',()=>{
 const db=new Database(':memory:');
 try {
  db.exec(schema('0000_current_schema.sql'));db.exec(schema('0003_collection_generations.sql'));db.exec(schema('0013_branches.sql'));db.exec(schema('0014_branch_workflows.sql'));
  db.prepare(`INSERT INTO trigger_definitions(id,project_id,conversation_id,agent_id,name,instructions,source_kind,source_config_json,enabled,created_at,updated_at) VALUES('t','p','c','a','Legacy','Work','filesystem','{}',1,'now','now')`).run();
  db.prepare(`INSERT INTO trigger_occurrences(id,trigger_id,occurrence_key,project_id,agent_id,scope_key,payload_json,provenance_json,input_hash,activation_config_json,state,available_at,occurred_at,created_at,updated_at) VALUES('o','t','key','p','a','conversation:c','{"value":1}','{"source":"test"}','hash','{}','pending','now','now','now','now')`).run();
  db.prepare(`INSERT INTO trigger_filesystem_bursts(trigger_id,occurrence_key,project_id,agent_id,started_at,last_at,event_count,changes_json,dropped_path_event_count,updated_at) VALUES('t','burst','p','a','now','now',1,'[]',0,'now')`).run();
  const before=Object.fromEntries(['trigger_definitions','trigger_occurrences','trigger_filesystem_bursts'].map(table=>[table,db.prepare(`SELECT * FROM ${table}`).get()]));
  db.exec(schema('0015_branch_trigger_destinations.sql'));
  for(const [table,row] of Object.entries(before)){
   const after=db.prepare(`SELECT * FROM ${table}`).get();for(const [key,value]of Object.entries(row))assert.deepEqual(after[key],value,`${table}.${key}`);
   assert.equal(after.branch_id,null);
  }
  const generation=db.prepare("SELECT generation FROM collection_generations WHERE name='triggers'").get().generation;
  db.prepare("UPDATE trigger_definitions SET name='Changed' WHERE id='t'").run();
  assert.equal(db.prepare("SELECT generation FROM collection_generations WHERE name='triggers'").get().generation,generation+1);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
 }finally{db.close()}
});
