import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pineconeBranchPackage,discoveryGateSource,discoveryReceiptSource,PINECONE_DISCOVERY_INTERVAL} from '../src/components/pinecone/pineconeBranchPackage.js';
import {pineconeMessages,pineconeDraftKey} from '../src/components/pinecone/branchPineconeModel.js';
import {parseBranchRoute,branchRoutePath} from '../src/branchesRouting.js';

function workspace(t){const root=mkdtempSync(join(tmpdir(),'pinecone-discovery-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root}
const candidate={question:'Can the stated slow chat path avoid full-history hydration?',notify:true,claimKey:'chat-read-lightweight-existence-verified',message:'Use a lightweight existence check for the reported path. https://example.com/evidence',sources:['https://example.com/evidence'],reason:'Matches the explicit latency problem and suggests a concrete next step.'};
function run(root,source,input){return spawnSync(process.execPath,['--input-type=module','--eval',source],{cwd:root,input:JSON.stringify(input),encoding:'utf8',timeout:5000})}
test('new package enables ten-minute discovery with workers independent of the spokesperson',()=>{
  const pkg=pineconeBranchPackage('2026-10-11T00:00:00Z');
  assert.equal(pkg.triggers.discovery.enabled,true);assert.equal(pkg.triggers.discovery.sourceConfig.everyMs,PINECONE_DISCOVERY_INTERVAL);
  assert.equal(pkg.definition.policy.maxConcurrentExecutions,1);
  assert.equal(pkg.definition.steps.find(step=>step.id==='research').target.ref,'scout');
  assert.equal(pkg.definition.steps.find(step=>step.id==='review').target.ref,'reviewer');
  assert.equal(pkg.definition.steps.find(step=>step.id==='speak').target.ref,'spokesperson');
  assert.equal(pkg.definition.controls[0].otherwise,'quiet');
  assert.equal(pkg.chats[0].agents.filter(agent=>!agent.managerRef).length,1);
});
test('quiet check still records proactive question coverage',t=>{
  const root=workspace(t),result=run(root,discoveryGateSource,{question:'A related opportunity with unchanged inputs',notify:false,reason:'Checked actual sources; no supported useful finding.'});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'quiet');
  assert.equal(JSON.parse(readFileSync(join(root,'pinecone-ledger.json'))).checks[0].question,'A related opportunity with unchanged inputs');
});
test('distinct finding passes and duplicate claim is quiet only after delivery receipt',t=>{
  const root=workspace(t);assert.equal(run(root,discoveryGateSource,candidate).stdout,'notify');
  assert.equal(run(root,discoveryGateSource,candidate).stdout,'notify','No delivery receipt means no claimed announcement');
  assert.equal(run(root,discoveryReceiptSource,{}).status,0);
  assert.equal(run(root,discoveryGateSource,candidate).stdout,'quiet');
  assert.equal(run(root,discoveryGateSource,{...candidate,claimKey:'different-qualified-opportunity'}).stdout,'notify');
});
test('unsupported and malformed model output fails rather than generating a notification',t=>{
  const root=workspace(t);
  for(const value of [{notify:true}, {...candidate,sources:[]}, {...candidate,message:''}, {...candidate,question:''}, {...candidate,sources:['file:///private']}])assert.notEqual(run(root,discoveryGateSource,value).status,0);
  const malformed=spawnSync(process.execPath,['--input-type=module','--eval',discoveryGateSource],{cwd:root,input:'```json\n{}\n```',encoding:'utf8'});assert.notEqual(malformed.status,0);
});
test('corrupt or redirected ledger refuses intact',t=>{
  const root=workspace(t),outside=join(root,'outside.json');writeFileSync(outside,'{"secret":"unchanged"}');symlinkSync(outside,join(root,'pinecone-ledger.json'));
  assert.notEqual(run(root,discoveryGateSource,candidate).status,0);assert.equal(readFileSync(outside,'utf8'),'{"secret":"unchanged"}');
});
test('coverage and announced-claim retention stay bounded',t=>{
  const root=workspace(t);writeFileSync(join(root,'pinecone-ledger.json'),JSON.stringify({schema:1,checks:Array.from({length:48},()=>({question:'prior',reason:'checked',at:'old'})),announced:Array.from({length:100},(_,i)=>({key:String(i),at:'old'}))}));
  assert.equal(run(root,discoveryGateSource,candidate).status,0);assert.equal(run(root,discoveryReceiptSource,{}).status,0);
  const ledger=JSON.parse(readFileSync(join(root,'pinecone-ledger.json')));assert.equal(ledger.checks.length,48);assert.equal(ledger.announced.length,100);
});
test('texting surface preserves human DMs and spokesperson communications while excluding worker traffic',()=>{
  const rows=[{id:'human',role:'user',communicationIntent:'user_dm'},{id:'reply',role:'assistant',authorAgentId:'pinecone',communicationIntent:'user_dm'},{id:'notice',role:'assistant',authorAgentId:'pinecone',communicationIntent:'broadcast'},{id:'worker',role:'assistant',authorAgentId:'scout',communicationIntent:'collaboration'},{id:'inbound',role:'user',communicationIntent:'collaboration'}];
  assert.deepEqual(pineconeMessages(rows,'pinecone').map(row=>row.id),['human','reply','notice']);
  assert.notEqual(pineconeDraftKey('branch-a','pinecone'),pineconeDraftKey('branch-b','pinecone'));
});
test('assistant deep link stays in the Branches product',()=>{
  const path=branchRoutePath({branchId:'branch-a',tab:'pinecone'});assert.ok(path.startsWith('/branches?'));assert.deepEqual(parseBranchRoute(path.split('?')[1]),{branchId:'branch-a',tab:'pinecone'});
});
