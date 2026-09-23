import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { AgentStore } from "../dist/index.js";
import { CoordinationV3RuntimeScopeAuthority } from "../dist/coordination-v3-runtime-scope-authority.js";

test("broadcast activation and organization artifacts cannot cross sibling Chats", () => {
  const root = mkdtempSync(join(tmpdir(),"chat-authority-"));
  const store = new AgentStore(root);
  try {
    const parent = store.createProject({label:"Legacy",hostPath:"/tmp/shared-source",defaultEngine:"codex"});
    const a = store.getConversation(parent.lastConversationId);
    const b = store.createConversation(parent.id,{title:"Other chat"});
    const first = store.createAgent(parent.id,{title:"First",engine:"codex",conversationId:a.id});
    const teammate = store.createAgent(parent.id,{title:"Teammate",engine:"codex",conversationId:a.id});
    const foreign = store.createAgent(parent.id,{title:"Foreign",engine:"codex",conversationId:b.id});
    const authority = new CoordinationV3RuntimeScopeAuthority(store.sqlite);
    const input = {
      projectId:parent.id,sender:{kind:"user",userId:"local-user"},intent:"broadcast",
      audience:{kind:"organization",organizationId:parent.id},
      payload:{dispatch:{conversationId:a.id}},
      activations:[{agentId:teammate.id,scopeKey:`conversation:${a.id}`}],
    };
    assert.equal(authority.runtimeCommunicationAuthorityAgrees(input),true);
    assert.equal(authority.runtimeCommunicationAuthorityAgrees({...input,activations:[{agentId:foreign.id,scopeKey:`agent:${foreign.id}`}]}),false);
    store.recordProjectArtifact({id:"owned-output",projectId:parent.id,originAgentId:first.id,agentId:first.id,
      kind:"file",path:"report.txt",summary:"Report",createdAt:new Date().toISOString(),
      mediaType:"text/plain",size:6,sha256:"a".repeat(64)});
    assert.equal(store.agentCanReadProjectArtifact(parent.id,"owned-output",teammate.id),true);
    assert.equal(store.agentCanReadProjectArtifact(parent.id,"owned-output",foreign.id),false);
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

test("legacy chat context is snapshotted once and survives independent edits and restarts", () => {
  const root = mkdtempSync(join(tmpdir(), "chat-context-"));
  let store = new AgentStore(root);
  try {
    const project = store.createProject({label:"Legacy", hostPath:"/tmp/retained-source", defaultEngine:"codex"});
    const second = store.createConversation(project.id, {title:"Second"});
    const ids = [project.lastConversationId, second.id];
    store.close();
    const parentFile = join(root,"projects",project.id,"project.json");
    const parent = JSON.parse(readFileSync(parentFile,"utf8"));
    writeFileSync(parentFile, JSON.stringify({...parent,instructions:"Inherited rule"}));
    for (const id of ids) {
      const file = join(root,"projects",project.id,"conversations",id,"conversation.json");
      const record = JSON.parse(readFileSync(file,"utf8"));
      delete record.chatOwnershipVersion; delete record.workingDirectory; delete record.instructions;
      writeFileSync(file,JSON.stringify(record));
    }
    store = new AgentStore(root);
    for (const id of ids) {
      assert.equal(store.getChatContext(id).instructions,"Inherited rule");
      assert.equal(store.getChatContext(id).hostPath,"/tmp/retained-source");
    }
    store.updateConversation(ids[0], {instructions:"Only first chat"});
    assert.equal(store.getChatContext(ids[1]).instructions,"Inherited rule");
    store.close();
    writeFileSync(parentFile,JSON.stringify({...parent,instructions:"Changed parent"}));
    store = new AgentStore(root);
    assert.equal(store.getChatContext(ids[0]).instructions,"Only first chat");
    assert.equal(store.getChatContext(ids[1]).instructions,"Inherited rule");
  } finally { store.close(); rmSync(root,{recursive:true,force:true}); }
});

test("a standalone Chat cannot become a parent for another Chat", () => {
  const root = mkdtempSync(join(tmpdir(),"chat-owned-"));
  const store = new AgentStore(root);
  try {
    const namespace = store.createProject({label:"New Chat",hostPath:"/tmp/standalone-chat",defaultEngine:"codex",chatOwned:true});
    assert.equal(store.getChatContext(namespace.lastConversationId).hostPath,"/tmp/standalone-chat");
    assert.throws(()=>store.createConversation(namespace.id,{title:"Nested"}),/separate Chat/);
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

test("startup refuses incompatible legacy ownership before converting any Chat metadata", () => {
  const root=mkdtempSync(join(tmpdir(),"chat-gate-"));
  let store=new AgentStore(root);
  try {
    const project=store.createProject({label:"Legacy",hostPath:"/tmp/preserved-source",defaultEngine:"codex"});
    const first=store.getConversation(project.lastConversationId);
    const second=store.createConversation(project.id,{title:"Second"});
    store.recordProjectArtifact({id:"unresolved",projectId:project.id,originAgentId:"missing",agentId:"missing",kind:"file",path:"report.txt",summary:"Unresolved",createdAt:new Date().toISOString(),mediaType:"text/plain",size:1,sha256:"a".repeat(64)});
    store.close();
    const files=[first,second].map(chat=>join(root,"projects",project.id,"conversations",chat.id,"conversation.json"));
    for(const file of files){const record=JSON.parse(readFileSync(file,"utf8"));delete record.chatOwnershipVersion;writeFileSync(file,JSON.stringify(record));}
    const before=files.map(file=>readFileSync(file,"utf8"));
    assert.throws(()=>new AgentStore(root),/Chat ownership migration blocked:.*artifact_without_resolvable_chat/);
    assert.deepEqual(files.map(file=>readFileSync(file,"utf8")),before);
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

test("partial migration preserves explicit context and resumes only unfinished Chats",()=>{
  const root=mkdtempSync(join(tmpdir(),"chat-resume-"));let store=new AgentStore(root);
  try{
    const project=store.createProject({label:"Legacy",hostPath:"/tmp/legacy",defaultEngine:"codex"});
    const first=store.getConversation(project.lastConversationId),second=store.createConversation(project.id,{title:"Second"});
    store.updateConversation(first.id,{instructions:"Already migrated",workingDirectory:"/tmp/independent"});
    store.close();
    const firstFile=join(root,"projects",project.id,"conversations",first.id,"conversation.json");
    const secondFile=join(root,"projects",project.id,"conversations",second.id,"conversation.json");
    const before=readFileSync(firstFile,"utf8"),record=JSON.parse(readFileSync(secondFile,"utf8"));
    delete record.chatOwnershipVersion;record.instructions="Explicit before migration";record.workingDirectory="/tmp/explicit";
    writeFileSync(secondFile,JSON.stringify(record));store=new AgentStore(root);
    assert.equal(readFileSync(firstFile,"utf8"),before);
    assert.equal(store.getChatContext(second.id).instructions,"Explicit before migration");
    assert.equal(store.getChatContext(second.id).hostPath,"/tmp/explicit");
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

for (const stopAfter of [0,1,3]) test(`migration recovers after process death at metadata boundary ${stopAfter}`,()=>{
  const root=mkdtempSync(join(tmpdir(),"chat-crash-"));let store=new AgentStore(root);
  try {
    const project=store.createProject({label:"Legacy",hostPath:"/tmp/never-moved",defaultEngine:"codex"});
    const chats=[store.getConversation(project.lastConversationId),store.createConversation(project.id,{title:"Second"}),store.createConversation(project.id,{title:"Third"})];
    store.close();
    const files=chats.map(chat=>join(root,"projects",project.id,"conversations",chat.id,"conversation.json"));
    for(const file of files){const record=JSON.parse(readFileSync(file,"utf8"));delete record.chatOwnershipVersion;delete record.instructions;writeFileSync(file,JSON.stringify(record));}
    const child=spawnSync(process.execPath,["--input-type=module","-e",`
      import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const original=fs.renameSync; let written=0;
      fs.renameSync=(from,to)=>{
        if(String(to).endsWith('/conversation.json') && ${stopAfter}===0) process.kill(process.pid,'SIGKILL');
        original(from,to);
        if(String(to).endsWith('/conversation.json') && ++written===${stopAfter}) process.kill(process.pid,'SIGKILL');
      };syncBuiltinESMExports();
      const {AgentStore}=await import(${JSON.stringify(new URL("../dist/index.js",import.meta.url).href)});
      new AgentStore(${JSON.stringify(root)});
    `],{encoding:"utf8",timeout:15000});
    assert.equal(child.signal,"SIGKILL",child.stderr);
    const committed=files.map(file=>readFileSync(file,"utf8")).filter(text=>JSON.parse(text).chatOwnershipVersion===1);
    assert.equal(committed.length,stopAfter);
    store=new AgentStore(root);
    for(const chat of chats){assert.equal(store.getChatContext(chat.id).hostPath,"/tmp/never-moved");}
    const after=files.map(file=>readFileSync(file,"utf8"));
    for(const record of committed)assert.ok(after.includes(record),"Completed receipt must not be rewritten");
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
