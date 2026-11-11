import '../shared/web-typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {foreignCommandStorageKey,foreignReceiptMatches,foreignReviewMatches,readForeignCommand} from '../../apps/web/src/components/branches/branchForeignContinuation.ts';
const sha='a'.repeat(64),selection={planId:'plan',sourceExecutionId:'source',checkpointKey:'checkpoint',checkpointSha256:sha};
const review={schema:'ponderosa.branch-foreign-review.v1',branchId:'branch',importedExecutionId:'held',selection,reviewSha256:sha,custody:'not_applicable',engine:'node',secretChoice:'none',accessChoice:'current_destination'};
const command={...selection,commandKey:'original',reviewSha256:sha,acceptCurrentAuthority:true};
test('review and receipt bind exact owner, checkpoint hash and original authority command',()=>{
 assert.ok(foreignReviewMatches(review,'branch','held',selection));
 for(const patch of [{branchId:'other'},{importedExecutionId:'other'},{selection:{...selection,checkpointSha256:'b'.repeat(64)}},{custody:'unknown'},{engine:'shell'},{secretChoice:'source'}])assert.equal(foreignReviewMatches({...review,...patch},'branch','held',selection),false);
 const receipt={schema:'ponderosa.branch-foreign-continuation.v1',branchId:'branch',importedExecutionId:'held',executionId:'fresh',commandKey:'original',review};
 assert.ok(foreignReceiptMatches(receipt,'branch','held',command));
 for(const patch of [{commandKey:'new'},{executionId:'held'},{review:{...review,reviewSha256:'b'.repeat(64)}}])assert.equal(foreignReceiptMatches({...receipt,...patch},'branch','held',command),false);
});
test('retained command is exact, scope-bound and corrupt storage fails closed',()=>{
 assert.deepEqual(readForeignCommand(JSON.stringify(command),'plan','source'),command);
 assert.equal(readForeignCommand(null,'plan','source'),undefined);
 for(const value of ['{','null',JSON.stringify({...command,planId:'other'}),JSON.stringify({...command,acceptCurrentAuthority:false}),JSON.stringify({...command,checkpointSha256:'bad'}),JSON.stringify({...command,extra:true})])assert.throws(()=>readForeignCommand(value,'plan','source'));
 const key=foreignCommandStorageKey('http://one','branches','branch','held');
 for(const args of [['http://two','branches','branch','held'],['http://one','dev','branch','held'],['http://one','branches','other','held'],['http://one','branches','branch','other']])assert.notEqual(foreignCommandStorageKey(...args),key);
});
