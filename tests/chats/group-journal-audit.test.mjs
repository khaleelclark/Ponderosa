// Deferred source; not executed.
import '../shared/web-typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {groupAuditSelectionMatches,groupAuditMatches,groupAuditProjection} from '../../apps/web/src/components/branches/groupJournalAudit.ts';
import {BranchGroupClient} from '../../packages/core/src/branch-group-client.ts';
const hash='a'.repeat(64),selection={kind:'captures',branchId:'branch',executionId:'missing source',journalKey:'actual original raw key',journalSha256:hash,custodySha256:hash};
const row={kind:'captures',branchId:'branch',executionId:'missing source',discovery:'unsupported_legacy_key',state:'capturing',ownerPresent:false,resourceCount:2,auditSelection:selection};
const value={historical:true,currentAuthority:false,actionEligible:false,held:true,selection,sourceOwnerPresent:false,state:'capturing',journalSha256:hash,evidenceSha256:hash,capture:{sources:[{checkpointId:'package0'},{checkpointId:'package1'}],receipts:[],disposition:{state:'abandoned',originalCaptureRaw:'PRIVATE SNAPSHOT'}}};
test('legacy audit accepts only the original discovered object without plaintext key reconstruction',()=>{
 assert.equal(groupAuditSelectionMatches(row),true);assert.equal(groupAuditSelectionMatches({...row,auditSelection:undefined}),false);
 for(const change of [{executionId:'other'},{kind:'admissions'},{journalSha256:'wrong'},{commandKey:'guessed plaintext'},{extra:'unsupported'}])assert.equal(groupAuditSelectionMatches({...row,auditSelection:{...selection,...change}}),false);
 assert.equal(groupAuditMatches(value,selection,2),true);
 for(const change of [{historical:false},{currentAuthority:true},{actionEligible:true},{held:false},{selection:{...selection,custodySha256:'changed'}},{journalSha256:'changed'},{evidenceSha256:'wrong'},{capture:{...value.capture,sources:value.capture.sources.slice(0,1)}}])assert.equal(groupAuditMatches({...value,...change},selection,2),false);
 assert.ok(!JSON.stringify(groupAuditProjection(value)).includes('PRIVATE SNAPSHOT'));
 assert.ok(!JSON.stringify(groupAuditProjection({...value,rawSnapshot:'PRIVATE BODY'})).includes('PRIVATE BODY'));
});
test('admission audit retains full maps and unknown imports without current authority',()=>{
 const s={...selection,kind:'admissions',commandKey:'prepare',admissionId:'admission',reservationHash:hash},r={...row,kind:'admissions',commandKey:'prepare',admissionId:'admission',auditSelection:s};
 const resources=[0,1].map(i=>({destination:{executionId:'fresh-run',resourceStepId:`fresh-step${i}`}}));
 const v={...value,selection:s,capture:undefined,reservationHash:hash,resources,idMap:{original0:'fresh0',original1:'fresh1'},agentMap:{agent0:'new0',agent1:'new1'},imports:[{sourceChatId:'chat0',operationId:'import0',status:'unknown'},{sourceChatId:'chat1',operationId:'import1',status:'preparing'}],owners:resources.map(r=>({...r.destination,present:false,commandPresent:false})),receipt:null,retirement:null};
 assert.equal(groupAuditSelectionMatches(r),true);assert.equal(groupAuditMatches(v,s,2),true);
 assert.equal(groupAuditMatches({...v,owners:v.owners.slice(0,1)},s,2),false);
 assert.equal(groupAuditMatches({...v,reservationHash:'changed'},s,2),false);
 assert.match(JSON.stringify(groupAuditProjection(v)),/unknown/);
});
test('audit adapter copies every exact query value, uses GET, and does not retry refusal',async()=>{
 const calls=[],api=new BranchGroupClient('irrelevant','irrelevant',async(path,init)=>{calls.push({path,init});throw Error('stale selector');});
 const original={...selection,journalKey:'stored journal / & =',commandKey:'original + key'};
 await assert.rejects(()=>api.journalAudit(original));assert.equal(calls.length,1);
 assert.deepEqual(Object.fromEntries(new URL(calls[0].path,'https://local').searchParams),original);
 assert.equal(calls[0].init.method,undefined);assert.equal(calls[0].init.cache,'no-store');
});
