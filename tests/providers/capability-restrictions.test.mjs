import assert from "node:assert/strict";
import test from "node:test";
import { claudeCapabilityRestrictionArgs } from "../../packages/engines/dist/claude-stream-session.js";
import { codexCapabilityRuntimeOptions } from "../../packages/engines/dist/codex-app-server.js";

const restrictions = {
  restrictedCapabilityIds: ["provider.filesystem_write", "connector:codex:job-tracker"],
  restrictedConnectorNames: ["job-tracker"],
  filesystemWriteRestricted: true,
};

test("Codex restrictions narrow the sandbox and disable the connector in both provider namespaces", () => {
  assert.deepEqual(codexCapabilityRuntimeOptions("workspace-write", restrictions), {
    sandboxMode: "read-only",
    config: {
      apps: { "job-tracker": { enabled: false } },
      mcp_servers: { "job-tracker": { enabled: false } },
    },
  });
  assert.deepEqual(codexCapabilityRuntimeOptions("workspace-write", undefined), {
    sandboxMode: "workspace-write",
  });
});

test("Claude restrictions become explicit provider-native tool denies", () => {
  assert.deepEqual(claudeCapabilityRestrictionArgs(restrictions), [
    "--disallowedTools",
    "Bash,Edit,NotebookEdit,Write,mcp__job-tracker",
  ]);
  assert.deepEqual(claudeCapabilityRestrictionArgs(undefined), []);
});

// Exercise the actual adapter transports with inert local executables. No CLI
// login, provider account, model turn, shell command or network is involved.
const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');
const {tmpdir}=await import('node:os');
const path=await import('node:path');
const {randomUUID}=await import('node:crypto');
const {CodexAppServerSession}=await import('../../packages/engines/dist/codex-app-server.js');
const {ClaudeStreamSession}=await import('../../packages/engines/dist/claude-stream-session.js');
const {until}=await import('../shared/fixture.mjs');

for(const resumed of [false,true])test(`Codex ${resumed?'resume':'start'} transports the restricted sandbox and disabled connector configuration`,{timeout:20000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'codex-restriction-wire-')),handles=[];let session,passed=false;
 t.after(async()=>{try{await session?.close();for(const handle of handles){await handle.close();assert.equal(handle.isAlive(),false)}}finally{if(passed)await rm(root,{recursive:true,force:true});else t.diagnostic(`Retained adapter fixture: ${root}`)}});
 await writeFile(path.join(root,'app-server'),`const fs=require('node:fs'),readline=require('node:readline');fs.writeFileSync('argv.json',JSON.stringify(process.argv.slice(2)));const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{const call=JSON.parse(line);fs.appendFileSync('rpc.jsonl',line+'\\n');if(call.id!==undefined)process.stdout.write(JSON.stringify({id:call.id,result:call.method.startsWith('thread/')?{thread:{id:'fixture-thread'}}:{}})+'\\n')});`);
 session=await CodexAppServerSession.open({bin:process.execPath,signal:new AbortController().signal,agentId:randomUUID(),cwd:root,history:[],sandboxMode:'workspace-write',killGraceMs:100,capabilityRestrictions:restrictions,...(resumed?{resumeSessionId:'fixture-thread'}:{}),onRuntimeSpawned:handle=>handles.push(handle)});
 const calls=(await readFile(path.join(root,'rpc.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),call=calls.find(item=>item.method===(resumed?'thread/resume':'thread/start'));
 assert.equal(call.params.sandbox,'read-only');assert.deepEqual(call.params.config,{apps:{'job-tracker':{enabled:false}},mcp_servers:{'job-tracker':{enabled:false}}});assert.equal(call.params.approvalPolicy,'never');
 const argv=JSON.parse(await readFile(path.join(root,'argv.json'),'utf8'));assert.ok(argv.includes('sandbox_mode="read-only"'));assert.equal(calls.some(item=>item.method==='turn/start'),false);passed=true;
});

test('Claude launches with one combined deny list so baseline and policy restrictions cannot overwrite each other',{timeout:20000,skip:process.platform==='win32'?'POSIX executable fixture; option translation remains platform-independent':false},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'claude-restriction-wire-')),handles=[];let session,passed=false;
 t.after(async()=>{try{await session?.close();for(const handle of handles){await handle.close();assert.equal(handle.isAlive(),false)}}finally{if(passed)await rm(root,{recursive:true,force:true});else t.diagnostic(`Retained adapter fixture: ${root}`)}});
 const bin=path.join(root,'inert-claude');await writeFile(bin,"#!/usr/bin/env node\nrequire('node:fs').writeFileSync('argv.json',JSON.stringify(process.argv.slice(2)));process.stdin.resume();",{mode:0o700});
 session=new ClaudeStreamSession({bin,signal:new AbortController().signal,agentId:randomUUID(),cwd:root,history:[],permissionMode:'bypassPermissions',killGraceMs:100,capabilityRestrictions:restrictions,environment:{PATH:path.dirname(process.execPath)+path.delimiter+(process.env.PATH??'')},onRuntimeSpawned:handle=>handles.push(handle)});
 const argv=await until(async()=>{try{return JSON.parse(await readFile(path.join(root,'argv.json'),'utf8'))}catch{return false}},'inert adapter startup');
 assert.equal(argv.filter(value=>value==='--disallowedTools').length,1);const denied=argv[argv.indexOf('--disallowedTools')+1].split(',').sort();assert.deepEqual(denied,['AskUserQuestion','Bash','Edit','NotebookEdit','Write','mcp__job-tracker'].sort());passed=true;
});
