import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PreferenceSaveFeedback} from '../../apps/web/src/preferenceSaveFeedback.ts';
import {WorkspacePreferencesWriter} from '../../apps/web/src/workspacePreferencesWriter.ts';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('preference failure identity survives unrelated success, explicit save and overlapping attempts',async()=>{
 const feedback=new PreferenceSaveFeedback(),errors=new Map();
 const report=(field,error)=>error===undefined?errors.delete(field):errors.set(field,error);
 const start=(patch,immediate=true)=>{const job=deferred();const done=feedback.track(patch,job.promise,report,immediate).catch(()=>{});return {...job,done};};
 const font=start({fontFamily:'sans'});font.reject(new Error('Font failed'));await font.done;
 const other=start({contextRolloverEnabled:false});other.resolve();await other.done;
 assert.equal(errors.get('fontFamily'),'Font failed');
 const explicit=start({globalInstructions:'draft'},false);assert.equal(errors.get('fontFamily'),'Font failed');explicit.resolve();await explicit.done;assert.equal(errors.get('fontFamily'),'Font failed');
 const context=start({contextRolloverEnabled:false});context.reject(new Error('Context failed'));await context.done;
 assert.equal(errors.size,2);
 const retry=start({fontFamily:'sans'});assert.equal(errors.size,2);retry.resolve();await retry.done;
 assert.deepEqual([...errors],[['contextRolloverEnabled','Context failed']]);
 const old=start({fontFamily:'sans'}),newer=start({fontFamily:'system'});newer.reject(new Error('New font failed'));await newer.done;old.resolve();await old.done;assert.equal(errors.get('fontFamily'),'New font failed');
 const oldFailure=start({fontFamily:'sans'}),newSuccess=start({fontFamily:'system'});newSuccess.resolve();await newSuccess.done;oldFailure.reject(new Error('Stale'));await oldFailure.done;assert.equal(errors.has('fontFamily'),false);
 const pendingOld=start({fontFamily:'sans'}),pendingNew=start({fontFamily:'system'});pendingOld.reject(new Error('Still unresolved'));await pendingOld.done;assert.equal(errors.get('fontFamily'),'Still unresolved');pendingNew.resolve();await pendingNew.done;assert.equal(errors.has('fontFamily'),false);
 const both=start({fontFamily:'sans',contextRolloverEnabled:true});both.reject(new Error('Both failed'));await both.done;
 const partial=start({fontFamily:'system'},false);partial.resolve();await partial.done;assert.deepEqual([...errors],[['contextRolloverEnabled','Both failed']]);
 const explicitFailure=start({contextRolloverEnabled:false},false);explicitFailure.reject(new Error('Form owns error'));await explicitFailure.done;assert.equal(errors.get('contextRolloverEnabled'),'Both failed');
});


for (const [name,initial,failed,sibling,retry,identity] of [
 ['notifications',{notifications:{directResponses:false,broadcasts:false}},
  {notifications:{directResponses:true,broadcasts:false}},
  {notifications:{directResponses:false,broadcasts:true}},
  {notifications:{directResponses:true,broadcasts:true}},'notifications.directResponses'],
 ['provider defaults',{engineDefaults:{codex:{model:'old',effort:'low'},claude:{model:'old',effort:'low'}}},
  {engineDefaults:{codex:{model:'new',effort:'low'},claude:{model:'old',effort:'low'}}},
  {engineDefaults:{codex:{model:'old',effort:'low'},claude:{model:'new',effort:'low'}}},
  {engineDefaults:{codex:{model:'new',effort:'low'},claude:{model:'new',effort:'low'}}},'engineDefaults.codex.model'],
 ['model and reasoning',{engineDefaults:{codex:{model:'old',effort:'low'}}},
  {engineDefaults:{codex:{model:'new',effort:'low'}}},
  {engineDefaults:{codex:{model:'old',effort:'high'}}},
  {engineDefaults:{codex:{model:'new',effort:'high'}}},'engineDefaults.codex.model'],
]) test(`${name}: real queue sibling success retains unsatisfied failure until retry`,async()=>{
 let canonical={revision:1,...initial},projected=canonical,writes=0;
 const feedback=new PreferenceSaveFeedback(),errors=new Map(),requests=[];
 const report=(key,error)=>error===undefined?errors.delete(key):errors.set(key,error);
 const writer=new WorkspacePreferencesWriter({read:()=>projected,publish:value=>projected=value,
  refresh:async()=>canonical,write:async patch=>{requests.push(patch);if(++writes===1)throw new Error('Exact control outage');return canonical={...canonical,...patch,revision:canonical.revision+1};}});
 const save=(patch,immediate=true)=>{const before=projected;return feedback.track(patch,writer.enqueueAndWait(patch),report,immediate,before);};
 await assert.rejects(save(failed),/Exact control outage/);
 assert.deepEqual([...errors.values()],['Exact control outage']);
 assert.deepEqual(projected,canonical,'failed write rolls back canonical projection');
 await save(sibling);
 assert.deepEqual([...errors],[[identity,'Exact control outage']]);
 assert.deepEqual(requests[1],sibling,'canonical atomic patch stays intact');
 const pending=save(retry,false);
 assert.equal(errors.get(identity),'Exact control outage','pending explicit retry retains failure');
 await pending;assert.equal(errors.size,0,'satisfying explicit retry resolves failure');
 assert.deepEqual(requests[2],retry);
});

test('nested pending retries, stale callbacks, sibling failures and explicit ownership stay independent',async()=>{
 const feedback=new PreferenceSaveFeedback(),errors=new Map();
 const report=(key,error)=>error===undefined?errors.delete(key):errors.set(key,error);
 const before={notifications:{directResponses:false,broadcasts:false}};
 const direct={notifications:{directResponses:true,broadcasts:false}};
 const start=(patch,previous=before,immediate=true)=>{const job=deferred();return {...job,done:feedback.track(patch,job.promise,report,immediate,previous).catch(()=>{})};};
 const initial=start(direct);initial.reject(new Error('Direct outage'));await initial.done;
 const retry=start(direct,direct);assert.equal(errors.get('notifications.directResponses'),'Direct outage');
 retry.resolve();await retry.done;assert.equal(errors.size,0,'retry of optimistic value still resolves its failure');
 const old=start(direct),newer=start(direct);newer.reject(new Error('New direct outage'));await newer.done;old.resolve();await old.done;
 assert.equal(errors.get('notifications.directResponses'),'New direct outage');
 const sibling=start({notifications:{directResponses:false,broadcasts:true}});sibling.reject(new Error('Broadcast outage'));await sibling.done;
 assert.equal(errors.size,2);
 const explicit=start(direct,before,false);explicit.reject(new Error('Form owned'));await explicit.done;
 assert.equal(errors.get('notifications.directResponses'),'New direct outage');
 const saved=start(direct);saved.resolve();await saved.done;
 assert.deepEqual([...errors],[['notifications.broadcasts','Broadcast outage']]);
});
