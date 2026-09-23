import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore } from "../dist/index.js";
import { assertQualification, captureSnapshot, qualifySnapshot } from "../tools/chat-ownership-qualification.mjs";
import { restoreAgentDeletionIdentities } from "../tools/restore-agent-deletion-identities.mjs";

async function fixture(run) {
  const root=mkdtempSync(join(tmpdir(),"chat-qualification-")), source=join(root,"source");
  const store=new AgentStore(source);
  const project=store.createProject({label:"Legacy",hostPath:"/tmp/untouched-source",defaultEngine:"codex"});
  const chatFile=join(source,"projects",project.id,"conversations",project.lastConversationId,"conversation.json");
  store.close();
  const chat=JSON.parse(readFileSync(chatFile,"utf8"));delete chat.chatOwnershipVersion;delete chat.workingDirectory;delete chat.instructions;
  writeFileSync(chatFile,JSON.stringify(chat));
  const baseline=join(root,"baseline.mjs");
  // Unit fixture only. Real qualification loads the actual target revision's AgentStore.
  writeFileSync(baseline,"export class AgentStore { constructor(root) { if (!root.endsWith('/rollback')) throw Error('wrong rollback root'); } close() {} }");
  try {await run({root,source,project,chatFile,baseline});}finally{rmSync(root,{recursive:true,force:true});}
}

test("offline qualification preserves history and authority across migration, restart and snapshot rollback",()=>fixture(async({root,source,baseline,chatFile})=>{
  const before=readFileSync(chatFile,"utf8"), snapshot=join(root,"snapshot");
  await captureSnapshot(source,snapshot,"baseline-revision");
  const report=await qualifySnapshot(snapshot,join(root,"verification"),baseline,"candidate-revision");
  assert.equal(report.status,"passed",report.error);
  assert.deepEqual(report.checks,{snapshotIntegrity:true,ownership:true,migration:true,restart:true,rollbackRestore:true});
  assert.equal(readFileSync(chatFile,"utf8"),before,"Original state is never opened by candidate AgentStore");
  assert.doesNotThrow(()=>assertQualification(report,"candidate-revision",snapshot));
  assert.throws(()=>assertQualification(report,"another-revision",snapshot),/different candidate/);
  assert.throws(()=>assertQualification({...report,status:"blocked"},"candidate-revision",snapshot),/blocked/);
}));

test("qualification fails closed if a captured canonical file changes",()=>fixture(async({root,source,baseline,project})=>{
  const snapshot=join(root,"snapshot");await captureSnapshot(source,snapshot,"baseline");
  const file=join(snapshot,"projects",project.id,"project.json");writeFileSync(file,readFileSync(file,"utf8")+"\n");
  const report=await qualifySnapshot(snapshot,join(root,"verification"),baseline,"candidate");
  assert.equal(report.status,"blocked");assert.match(report.error,/Snapshot files changed/);
}));

test("capture refuses a destination inside live state or an existing snapshot",()=>fixture(async({root,source})=>{
  await assert.rejects(captureSnapshot(source,join(source,"copy"),"base"),/outside live state/);
  await assert.rejects(captureSnapshot(source,root,"base"),/already exists/);
}));

test("explicit recovery retains deleted creators and private audiences, archives custodians, and survives rebuild",()=>fixture(async({root,source,project,chatFile})=>{
  const chat=JSON.parse(readFileSync(chatFile,"utf8"));chat.chatOwnershipVersion=1;chat.workingDirectory="/tmp/untouched-source";writeFileSync(chatFile,JSON.stringify(chat));
  let store=new AgentStore(source);
  const agent=store.createAgent(project.id,{title:"Original author",engine:"codex",conversationId:chat.id});
  const body=Buffer.from("original bytes"),sha256=createHash("sha256").update(body).digest("hex");
  mkdirSync(join(source,"projects",project.id,"artifacts","content"),{recursive:true});
  // Historical created records can omit optional fields added by today's event projector.
  // Rebuild the managed journal first, then apply Agent events, then custody.
  const live=store.createAgent(project.id,{title:"Unaffected",engine:"codex",conversationId:chat.id});
  writeFileSync(join(source,"projects",project.id,"artifacts","content","historical-generated"),body);
  store.appendEvent(live.id,{type:"generated_artifact",artifactId:"historical-generated",executionId:"old-run",path:"old.txt",sourcePath:"/tmp/old.txt",name:"Old file",mediaType:"text/plain",size:body.length,sha256,visibility:"project"});
  for(const id of ["recovered-public","recovered-private"]) {
    writeFileSync(join(source,"projects",project.id,"artifacts","content",id),body);
    store.recordProjectArtifact({id,projectId:project.id,agentId:agent.id,originAgentId:agent.id,kind:"generated_file",path:`${id}.txt`,summary:"Original",createdAt:new Date().toISOString(),size:body.length,sha256,mediaType:"text/plain"},id.endsWith("private")?{ownerKind:"communication",ownerId:"private-original",audience:{kind:"user_agent",userId:"local-user",agentId:agent.id}}:undefined);
  }
  store.deleteAgent(agent.id);store.close();
  const journal=join(source,"projects",project.id,"artifacts","artifacts.jsonl");
  const events=readFileSync(journal,"utf8").trim().split("\n").map(line=>JSON.parse(line));
  for(const event of events) if(event.type==="created" && event.artifact.id==="historical-generated") delete event.artifact.visibility;
  writeFileSync(journal,events.map(event=>JSON.stringify(event)).join("\n")+"\n");
  store=new AgentStore(source);assert.deepEqual(store.startupProfile().recoveryIssues,[]);store.close();
  const snapshot=join(root,"snapshot");await captureSnapshot(source,snapshot,"old");
  const baseline=new URL("../dist/index.js",import.meta.url).pathname;
  const blocked=await qualifySnapshot(snapshot,join(root,"blocked"),baseline,"new");assert.equal(blocked.status,"blocked");
  const output=join(root,"recovered"),report=await qualifySnapshot(snapshot,output,baseline,"new",true);
  assert.equal(report.status,"passed",report.error);assert.equal(report.recovery.artifactCount,2);
  assert.equal(report.checks.recovery,true);assert.doesNotThrow(()=>assertQualification(report,"new",snapshot));
  store=new AgentStore(join(output,"migrated"));
  try {
    const group=report.recovery.groups[0];
    assert.equal(store.getAgent(group.custodianAgentId).archived,true);
    assert.equal(store.getProjectArtifact(project.id,"recovered-public").originAgentId,agent.id);
    const page=store.getProjectArtifactPage(project.id,{conversationId:group.chatId,limit:100});
    assert.ok(page.items.some(item=>item.id==="recovered-public"));
    assert.ok(!page.items.some(item=>item.id==="recovered-private"),"private artifacts do not become public");
    assert.equal(store.agentCanReadProjectArtifact(project.id,"recovered-private",group.custodianAgentId),false);
    store.deleteAgent(group.custodianAgentId);
    store.commitConversationDeletion(group.chatId);
    const legacyIdentity=store.sqlite.prepare(`SELECT agent_id agentId,project_id projectId,
      conversation_id conversationId,tombstone_name tombstoneName,ownership_token ownershipToken,
      created_at createdAt FROM agent_deletion_tombstones WHERE agent_id=?`).get(group.custodianAgentId);
    store.sqlite.prepare("DELETE FROM agent_deletion_tombstones WHERE agent_id=?").run(group.custodianAgentId);
    store.close();
    assert.deepEqual(restoreAgentDeletionIdentities(join(output,"migrated"),{
      version:1,entries:[legacyIdentity],
    }),{status:"validated",count:1,alreadyPresent:0});
    assert.deepEqual(restoreAgentDeletionIdentities(join(output,"migrated"),{
      version:1,entries:[legacyIdentity],
    },true),{status:"applied",count:1,alreadyPresent:0});
    assert.deepEqual(restoreAgentDeletionIdentities(join(output,"migrated"),{
      version:1,entries:[legacyIdentity],
    },true),{status:"applied",count:1,alreadyPresent:1});
    store=new AgentStore(join(output,"migrated"));
    assert.deepEqual(store.startupProfile().recoveryIssues,[],
      "deleting a recovered-files Chat must not quarantine its Project");
    assert.equal(store.getProject(project.id)?.id,project.id);
    assert.equal(store.getProjectArtifact(project.id,"recovered-public")?.originAgentId,agent.id);
    assert.equal(store.agentCanReadProjectArtifact(project.id,"recovered-public",live.id),false,
      "a deleted custodian never grants another Chat access");
    store.close();
    const markerPath=join(output,"migrated","projects",project.id,"agents",group.custodianAgentId,
      ".ponderosa-agent-deletion.json");
    const marker=JSON.parse(readFileSync(markerPath,"utf8"));marker.ownershipToken="";
    writeFileSync(markerPath,JSON.stringify(marker));
    store=new AgentStore(join(output,"migrated"));
    assert.match(store.startupProfile().recoveryIssues[0]?.detail??"",/Invalid legacy artifact custody assignment/,
      "historical custody still fails closed without its canonical deletion proof");
    store.close();
    marker.ownershipToken="different-nonempty-token";writeFileSync(markerPath,JSON.stringify(marker));
    store=new AgentStore(join(output,"migrated"));
    assert.match(store.startupProfile().recoveryIssues[0]?.detail??"",/Invalid legacy artifact custody assignment/,
      "a different nonempty token is not canonical deletion proof");
    store.close();
    const durable=store=>store.sqlite.prepare(`SELECT ownership_token,conversation_id FROM agent_deletion_tombstones
      WHERE agent_id=?`).get(group.custodianAgentId);
    store=new AgentStore(join(output,"migrated"));const authority=durable(store);store.close();
    marker.ownershipToken=authority.ownership_token;marker.conversationId=chat.id;
    writeFileSync(markerPath,JSON.stringify(marker));
    store=new AgentStore(join(output,"migrated"));
    assert.match(store.startupProfile().recoveryIssues[0]?.detail??"",/Invalid legacy artifact custody assignment/,
      "an unrelated Chat cannot replace the receipt-bound Chat");
    store.close();
    marker.conversationId=authority.conversation_id;writeFileSync(markerPath,JSON.stringify(marker));
    const agentDirectory=join(output,"migrated","projects",project.id,"agents",group.custodianAgentId);
    const replacement=join(output,"migrated","replacement-agent-audit");
    renameSync(agentDirectory,replacement);symlinkSync(replacement,agentDirectory,"dir");
    store=new AgentStore(join(output,"migrated"));
    assert.match(store.startupProfile().recoveryIssues[0]?.detail??"",/Invalid legacy artifact custody assignment/,
      "a symlinked audit directory cannot prove custody");
  }finally{store.close();}
}));

test("operator recovery refuses artifacts with missing rather than retained deleted creators",()=>fixture(async({root,source,project,chatFile,baseline})=>{
  const chat=JSON.parse(readFileSync(chatFile,"utf8"));chat.chatOwnershipVersion=1;writeFileSync(chatFile,JSON.stringify(chat));
  const store=new AgentStore(source);
  store.recordProjectArtifact({id:"unknown-author",projectId:project.id,agentId:"unknown",originAgentId:"unknown",kind:"generated_file",path:"x.txt",summary:"Original",createdAt:new Date().toISOString(),size:1,sha256:"a".repeat(64),mediaType:"text/plain"});store.close();
  const snapshot=join(root,"snapshot");await captureSnapshot(source,snapshot,"old");
  const report=await qualifySnapshot(snapshot,join(root,"blocked"),baseline,"new",true);
  assert.equal(report.status,"blocked");assert.match(report.error,/Only unresolved deleted-Agent/);
}));
