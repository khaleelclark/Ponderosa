// Deferred source fixtures; execution requires separate authorization.
import '../shared/web-typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeBoundaryValid,nativeHistoryHash,nativeInventoryValid,nativeSavedCommandValid,nativeReceiptMatches,nativeFactValid,nativePreviewFresh,nativeTrackingValid} from '../../apps/web/src/components/nativeHistory.ts';
const boundary={agentId:'source',projectId:'project',conversationId:'chat',engine:'claude',sessionId:'native-source',runId:'completed-run',fence:9,toolContractHash:'a'.repeat(64),rootPath:'/work'};
const agent={id:'source',projectId:'project',conversationId:'chat',activeEngine:'claude',workingCopy:{state:'ready',rootPath:'/work'}};
const fact={path:'/work/file.txt',ancestors:[['/work',1,2,493,1000,1000]],type:'file',dev:1,ino:3,mode:420,uid:1000,gid:1000,size:20,hash:'b'.repeat(64)};
const inventory=async()=>({boundary,boundaryHash:await nativeHistoryHash(boundary),held:false,catalog:{sessionId:boundary.sessionId,trackingEnabled:true,fileRewindSupported:true,transcriptForkSupported:true,checkpoints:[{sessionId:boundary.sessionId,messageId:'checkpoint'}],forkPoints:['cut']},eligibleTargets:[{agentId:'empty-target'}]});
const make=async(operation,patch={})=>{const i=await inventory();return {boundary,body:{operation,idempotencyKey:`original-${operation}`,boundaryHash:i.boundaryHash,...(operation==='preview'?{checkpointId:'checkpoint'}:operation==='fork'?{targetAgentId:'empty-target',throughId:'cut',acknowledgeHistoryCopy:true}:{}),...patch}};};
const receipt=async(command,state='completed',result)=>({id:'receipt',key:command.body.idempotencyKey,kind:command.body.operation,boundary,inputHash:await nativeHistoryHash({boundary,kind:command.body.operation,input:command.body}),requestHash:await nativeHistoryHash(command.body),createdAt:'2026-11-01T00:00:00Z',state,...(result?{result}:{})});
const previewResult=async()=>({boundaryHash:(await inventory()).boundaryHash,native:{sessionId:boundary.sessionId,messageId:'checkpoint',dryRun:true,outcome:'completed',canRewind:true,filesChanged:['file.txt'],insertions:1,deletions:2,skippedLinks:0},facts:[fact]});
test('catalog binds actual owner, hash, supported IDs and server-only empty-target inventory',async()=>{
 const i=await inventory();assert.ok(nativeBoundaryValid(boundary));assert.ok(await nativeInventoryValid(i,agent));
 for(const patch of [{boundaryHash:'c'.repeat(64)},{boundary:{...boundary,conversationId:'foreign'}},{catalog:{...i.catalog,sessionId:'foreign'}},{catalog:{...i.catalog,checkpoints:[{sessionId:'foreign',messageId:'checkpoint'}]}},{eligibleTargets:[{agentId:'source'}]},{eligibleTargets:[{agentId:'empty-target'},{agentId:'empty-target'}]}])assert.equal(await nativeInventoryValid({...i,...patch},agent),false);
 const codex={...boundary,engine:'codex'},codexInventory={...i,boundary:codex,boundaryHash:await nativeHistoryHash(codex),catalog:{...i.catalog,fileRewindSupported:false}};
 assert.ok(await nativeInventoryValid(codexInventory,{...agent,activeEngine:'codex'}));assert.equal(await nativeInventoryValid({...codexInventory,catalog:{...i.catalog,fileRewindSupported:true}},{...agent,activeEngine:'codex'}),false);
});
test('exact original request/input hashes and all physical fields survive key readback',async()=>{
 const command=await make('preview'),r=await receipt(command,'completed',await previewResult());assert.ok(nativeSavedCommandValid(command,'source'));assert.ok(await nativeReceiptMatches(command,r));assert.ok(nativeFactValid(fact));
 for(const patch of [{key:'new'},{requestHash:'c'.repeat(64)},{inputHash:'c'.repeat(64)},{boundary:{...boundary,fence:10}},{state:'prepared'},{result:{...r.result,native:{...r.result.native,sessionId:'other'}}},{result:{...r.result,facts:[{...fact,hash:'bad'}]}},{result:{...r.result,facts:[{...fact,path:'/outside/file.txt'}]}},{result:{...r.result,native:{...r.result.native,skippedLinks:-1}}}])assert.equal(await nativeReceiptMatches(command,{...r,...patch}),false);
 assert.ok(await nativeReceiptMatches(command,await receipt(command,'started')),'unconfirmed started stays readable, never success');
 assert.equal(nativeSavedCommandValid({...command,body:{...command.body,force:true}},'source'),false);
 const i=await inventory(),start=Date.parse(r.createdAt);assert.ok(nativePreviewFresh(r,i,'checkpoint',start+60000));assert.equal(nativePreviewFresh(r,i,'checkpoint',start+60001),false);assert.equal(nativePreviewFresh(r,{...i,held:true},'checkpoint',start),false);assert.equal(nativePreviewFresh(r,i,'other',start),false);
});
test('rewind receipt remains bound to original dry-run, physical preview and checkpoint',async()=>{
 const preview=await make('preview'),p=await receipt(preview,'completed',await previewResult()),command={...await make('rewind',{checkpointId:'checkpoint',previewKey:preview.body.idempotencyKey,acknowledgeFileChanges:true}),preview:{body:preview.body,receipt:p}};
 const result={boundaryHash:command.body.boundaryHash,native:{sessionId:boundary.sessionId,messageId:'checkpoint',dryRun:false,outcome:'completed',canRewind:true}};
 assert.ok(await nativeReceiptMatches(command,await receipt(command,'completed',result)));
 const changed={...command,preview:{...command.preview,receipt:{...p,result:{...p.result,native:{...p.result.native,canRewind:false}}}}};assert.equal(await nativeReceiptMatches(changed,await receipt(command,'completed',result)),false);
});
test('fork preparation is not native acceptance or work; exact target/cut/fresh ID and Run fence stay bound',async()=>{
 const command=await make('fork'),prepared={...await receipt(command,'prepared'),targetAgentId:'empty-target',throughId:'cut',newSessionId:'reserved-native'};
 assert.ok(await nativeReceiptMatches(command,prepared));assert.ok(await nativeReceiptMatches(command,{...prepared,state:'cancelled'}));
 const opened={...prepared,state:'opened',targetRunId:'real-human-run',targetFence:11,newSessionId:'observed-native',result:{nativeSessionId:'observed-native',contextAccepted:false,replayAuthorized:false}};
 assert.ok(await nativeReceiptMatches(command,opened));
 for(const patch of [{targetAgentId:'other'},{throughId:'other'},{newSessionId:boundary.sessionId},{state:'completed'},{state:'opened'},{targetFence:3},{result:{nativeSessionId:'other',contextAccepted:true,replayAuthorized:true}}])assert.equal(await nativeReceiptMatches(command,{...prepared,...patch}),false);
});
test('future tracking preference never implies current-session tracking or backups',()=>{
 assert.ok(nativeTrackingValid({preference:{enabled:true,appliesTo:'next_native_session'}}));assert.ok(nativeTrackingValid({preference:{enabled:false,appliesTo:'next_native_session'},currentSession:{sessionId:'retained',trackingEnabled:true}}));
 for(const value of [{preference:{enabled:true,appliesTo:'current_session'}},{preference:{enabled:'false',appliesTo:'next_native_session'}},{preference:{enabled:false,appliesTo:'next_native_session'},currentSession:{sessionId:'retained'}}])assert.equal(nativeTrackingValid(value),false);
});
