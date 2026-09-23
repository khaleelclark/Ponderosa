import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { auditChatOwnership } from "../dist/chat-ownership-audit.js";

function fixture(run) {
  const root=mkdtempSync(join(tmpdir(),"ponderosa-chat-audit-")), path=join(root,"audit.db");
  const db=new Database(path);
  db.exec(`CREATE TABLE projects(id TEXT); CREATE TABLE conversations(id TEXT,project_id TEXT);
    CREATE TABLE agents(id TEXT,project_id TEXT,conversation_id TEXT,manager_agent_id TEXT,deleted_at TEXT);
    CREATE TABLE coordination_requests(id TEXT,requester_agent_id TEXT,recipient_agent_id TEXT);
    CREATE TABLE managed_artifact_projection(artifact_id TEXT,project_id TEXT,artifact_json TEXT,owner_kind TEXT,owner_id TEXT);
    CREATE TABLE chat_search_messages(project_id TEXT,communication_event_id TEXT,conversation_id TEXT);
    CREATE TABLE agent_presets(id TEXT);
    INSERT INTO projects VALUES ('P'); INSERT INTO conversations VALUES ('C1','P'),('C2','P');
    INSERT INTO agents VALUES ('A','P','C1',NULL,NULL),('B','P','C1','A',NULL),('D','P','C2',NULL,NULL);
    INSERT INTO coordination_requests VALUES ('R','A','B');
    INSERT INTO managed_artifact_projection VALUES ('F','P','{"originAgentId":"B"}','project','P');`);
  try { run(db,path); } finally { db.close(); rmSync(root,{recursive:true,force:true}); }
}

test("ownership preflight preserves same-chat organizations without writing the database",()=>fixture((db,path)=>{
  const before=readFileSync(path);
  const report=auditChatOwnership(path);
  assert.deepEqual(report.findings,[]);
  assert.equal(report.counts.chats,2);
  assert.equal(report.migrationImplemented,false);
  assert.deepEqual(readFileSync(path),before);
}));
test("preflight reports cross-chat relationships and orphaned artifacts rather than guessing ownership",()=>fixture((db,path)=>{
  db.exec("UPDATE agents SET manager_agent_id='A' WHERE id='D'; UPDATE coordination_requests SET recipient_agent_id='D'; DELETE FROM managed_artifact_projection;");
  db.prepare("INSERT INTO managed_artifact_projection VALUES (?,?,?,?,?)").run('orphan','P',JSON.stringify({originAgentId:'missing'}),'project','P');
  const report=auditChatOwnership(path);
  assert.deepEqual(report.findings.map(f=>f.code),['cross_chat_hierarchy','cross_chat_request','artifact_without_resolvable_chat']);
  assert.equal(report.findings[2].examples[0].artifactId,'orphan');
}));
test("malformed artifact metadata and live agents without chat ownership fail closed",()=>fixture((db,path)=>{
  db.exec("UPDATE agents SET conversation_id=NULL WHERE id='D'; UPDATE managed_artifact_projection SET artifact_json='invalid';");
  assert.deepEqual(auditChatOwnership(path).findings.map(f=>f.code),['live_agent_without_valid_chat','artifact_without_resolvable_chat']);
}));
test("opening a missing database never creates it",()=>{
  const root=mkdtempSync(join(tmpdir(),"ponderosa-chat-audit-missing-")), path=join(root,"missing.db");
  try { assert.throws(()=>auditChatOwnership(path)); assert.equal(existsSync(path),false); }
  finally { rmSync(root,{recursive:true,force:true}); }
});
test("human-authored documents resolve through communication ownership, not a fictitious agent",()=>fixture((db,path)=>{
  db.exec(`UPDATE managed_artifact_projection SET artifact_json='{"originAgentId":"local-operator"}',owner_kind='communication',owner_id='message';
    INSERT INTO chat_search_messages VALUES ('P','message','C1'),('P','message','C1');`);
  assert.deepEqual(auditChatOwnership(path).findings,[]);
  assert.equal(auditChatOwnership(path).canonicalJournalVerificationRequired,true);
  db.exec("INSERT INTO chat_search_messages VALUES ('P','message','C2');");
  assert.equal(auditChatOwnership(path).findings[0].code,'artifact_without_resolvable_chat');
}));
