// Deferred focused authority fixture; not provider/SQLite end-to-end qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {voiceMemoryExposure} from '../../apps/server/dist/voice-memory-exposure.js';
test('Request drafts retain packet, attached lineage and live memory fences',async()=>{
 const manifest={schemaVersion:3,conversationId:'chat',memorySessionResetSeq:0,memoryScopes:[],sources:[],activationIds:['activation'],communicationEventIds:[]};
 let lineage=true,memory=true;
 const ports={opts:{localMemory:{}},unavailable:()=>false,validateMemory:async()=>memory,store:{sqlite:{prepare:sql=>({get:(...args)=>{
  if(sql.includes('request_source_lineage'))return lineage&&JSON.parse(args.at(-1)).includes('activation')?{found:1}:undefined;
  if(sql.includes('SELECT agent_id,project_id FROM scheduler_runs'))return {agent_id:'agent',project_id:'project'};
  if(sql.includes('FROM provider_inputs'))return {scheduler_run_id:'run',agent_id:'agent',project_id:'project',provider_prompt:'packet',prompt_hash:createHash('sha256').update('packet').digest('hex'),source_manifest_json:JSON.stringify(manifest)};
  if(sql.includes("type='session_reset'"))return {seq:0};
  return {found:1,project_id:'project',branch_id:null,branch_execution_id:null};
 }})}}};
 const scope={agentId:'agent',projectId:'project',conversationId:'chat',messageId:'request',runId:'run',sourceKind:'request'};
 assert.equal((await voiceMemoryExposure(ports,scope)).state,'valid');
 lineage=false;assert.equal((await voiceMemoryExposure(ports,scope)).state,'invalid');lineage=true;
 manifest.activationIds=[];assert.equal((await voiceMemoryExposure(ports,scope)).state,'invalid');manifest.activationIds=['activation'];
 memory=false;assert.equal((await voiceMemoryExposure(ports,scope)).state,'invalid');memory=true;
 manifest.memorySessionResetSeq=1;assert.equal((await voiceMemoryExposure(ports,scope)).state,'invalid');
});
