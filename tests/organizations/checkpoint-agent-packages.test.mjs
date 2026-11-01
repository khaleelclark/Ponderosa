import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {checkpointPackageCustody} from '../../apps/server/dist/checkpoint-agent-packages.js';
import Database from 'better-sqlite3';
import {beginSourceCapture,commitSourceCapture,releaseSourceCapture} from '../../packages/agents/dist/source-capture-boundary.js';

const source={checkpointId:'checkpoint-1',sourceChatId:'chat',agentIds:['agent'],intent:{executionId:'execution',resourceStepId:'step',resourceGeneration:1,frontierSha256:'a'.repeat(64),bindingSha256:'b'.repeat(64),configurationSha256:'c'.repeat(64)}};
const portable=()=>({schema:'ponderosa.agent-package.v1',mode:'full',kind:'agent',exportedAt:'2026-11-01T00:00:00.000Z',sourceLabel:'Chat',rootRef:'agent',agents:[{ref:'agent',title:'Agent',engine:'codex',sourceChat:{ref:'chat',title:'Chat'},managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},history:[{role:'user',text:'retained original'}],artifacts:[]}]});
const fixture=async work=>{const directory=await mkdtemp(path.join(tmpdir(),'checkpoint-package-'));try{await work(directory);}finally{await rm(directory,{recursive:true,force:true});}};

test('retained package survives new service instance without source lookup and release stays released',()=>fixture(async directory=>{
  const receipt=await checkpointPackageCustody(directory).capture(source,'cut-1',async()=>portable());
  const restarted=checkpointPackageCustody(directory);
  assert.deepEqual(await restarted.inspect(source),{state:'retained',receipt});
  await assert.rejects(restarted.inspect({...source,intent:{...source.intent,resourceGeneration:2}}),/intent conflict/);
  assert.equal((await restarted.read(receipt)).agents[0].history[0].text,'retained original');
  assert.deepEqual(await restarted.capture(source,'later-cut',async()=>{throw Error('source deleted');}),receipt);
  await restarted.release(receipt);
  await checkpointPackageCustody(directory).release(receipt);
  await assert.rejects(restarted.read(receipt),/released/);
  await assert.rejects(restarted.capture(source,'later-cut',async()=>portable()),/released/);
}));
test('interrupted capture never silently recaptures a later cut',()=>fixture(async directory=>{
  const custody=checkpointPackageCustody(directory);
  await assert.rejects(custody.capture(source,'cut-1',async()=>{throw Error('interruption');}),/interruption/);
  let called=false;
  await assert.rejects(checkpointPackageCustody(directory).capture(source,'cut-2',async()=>{called=true;return portable();}),/interrupted/);
  assert.equal(called,false);
  assert.equal((await custody.inspect(source)).state,'failed');
}));
test('digest length and source membership are required before retained import',()=>fixture(async directory=>{
  const custody=checkpointPackageCustody(directory),receipt=await custody.capture(source,'cut-1',async()=>portable());
  await assert.rejects(custody.read({...receipt,agentIds:['other']}),/receipt/);
  const key=createHash('sha256').update(source.checkpointId).digest('hex');
  await appendFile(path.join(directory,'checkpoint-package-custody',`${key}.payload`),' ');
  await assert.rejects(custody.read(receipt),/bytes unavailable or changed/);
}));
test('a source write during export cannot publish a retained custody receipt',()=>fixture(async directory=>{
  const db=new Database(':memory:'),custody=checkpointPackageCustody(directory);db.exec('CREATE TABLE source(value TEXT)');
  const token=beginSourceCapture(db);
  try{
    await assert.rejects(custody.capture(source,token.boundaryId,async()=>{db.exec("INSERT INTO source VALUES('changed')");return portable();},publish=>commitSourceCapture(token,publish)),/source changed/);
    const state=await custody.inspect(source);assert.equal(state.state,'failed');assert.equal(state.reason,'source_changed');
  }finally{releaseSourceCapture(token);db.close();}
}));
