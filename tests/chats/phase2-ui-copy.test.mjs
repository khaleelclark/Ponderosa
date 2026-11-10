// Deferred source regression; not executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
const root=new URL('../../apps/web/src/components/',import.meta.url);
const read=name=>readFileSync(new URL(name,root),'utf8');
const surfaces=[
 ...['branches','lifecycle'].flatMap(folder=>readdirSync(new URL(folder+'/',root)).filter(name=>name.endsWith('.tsx')).map(name=>folder+'/'+name)),
 'ContextRecoveryPanel.tsx','GlobalMemoryTransfer.tsx','ImportAgentDialog.tsx',
 'OutputAgentApp.tsx','AssistantEntry.tsx','AssistantSettings.tsx','OutputAgentDesignation.tsx',
 'PostImportAccessReview.tsx','RequestLifecycleCard.tsx','TriggerOccurrenceAudit.tsx','TriggerSourceFields.tsx',
];
test('new controls use short static labels and hints instead of explanatory paragraphs',()=>{
 for(const name of surfaces){
  // Authored facts, server errors, policy evidence and consequential export consent
  // are retained verbatim; this guard covers UI-owned plain JSX copy only.
  for(const match of read(name).matchAll(/<(?:Typography|Alert)\b[^>]*>([^<>{}]+)</g)){
   const text=match[1].replace(/\s+/g,' ').trim();
   assert.doesNotMatch(text,/[.!?]\s+[A-Z]/,`${name}: explanatory paragraph: ${text}`);
   assert.ok(text.split(/\s+/).length<=40,`${name}: oversized hint: ${text}`);
  }
 }
});
test('short copy retains consequential warnings beside exact evidence',()=>{
 const generation=read('branches/BranchGenerationOne.tsx'),group=read('branches/BranchGroupReview.tsx');
 for(const text of ['Siblings · settled','pinned limit preserved','without replaying old effects or failed Requests','no POST retry']){
  assert.ok(generation.includes(text),text);
 }
 for(const text of ['Shared existing Project directory','no separate workspace or working copy','original Project audit access','fresh acceptance budget','unknown effects remain held','previously disclosed facts remain'])assert.ok(group.includes(text),text);
 const audit=read('branches/GroupJournalAudit.tsx');
 for(const text of ['Historical: true','currentAuthority: false','actionEligible: false','held: true','Private payloads suppressed','unknown imports held'])assert.ok(audit.includes(text),text);
 const lifecycle=read('lifecycle/LifecycleReview.tsx');
 for(const text of ['your drain testimony required','stable readback supplies no drain proof','permanently retains source pins','unknown effects held without replay'])assert.ok(lifecycle.includes(text),text);
 const portable=read('branches/BranchRuntimePackageReview.tsx');
 assert.ok(portable.includes('Inspect prior imported history before acknowledging: it may contain additional held resource exits or unavailable checkpoint data'));
 const disclosure=read('branches/BranchDisclosureReview.tsx');
 assert.ok(disclosure.includes('retry starts capture only if it never began; an uncertain capture remains held'));
 const retry=read('branches/ExecutionPanel.tsx');
 assert.ok(retry.includes('retry may duplicate file changes or external effects'));
 assert.ok(retry.includes('earlier side effects remain and may repeat'));
});


test('HTTP summaries use structured status and preserve diagnostic casing',async()=>{
 await import('../shared/web-typescript-loader.mjs');const {errorSummary,errorDetail}=await import('../../apps/web/src/workspaceAvailability.ts'),{ApiRequestError,ApiTransportError}=await import('../../apps/web/src/api/types.ts');
 const raw='request rate limit exceeded RAW miXeD gpt-5.2 /Users/ExactPath ID_abC';
 assert.equal(errorSummary(new ApiRequestError(429,raw),'Reply'),'Request Rate Limit Exceeded');assert.equal(errorSummary(new ApiRequestError(403,raw),'Reply'),'Access Denied');assert.equal(errorSummary(new ApiTransportError(raw),'Reply'),'Connection Interrupted');assert.equal(errorSummary(new Error(raw),'Reply'),'Reply Unavailable');
 for(const error of [new ApiRequestError(429,raw),new ApiTransportError(raw),new Error(raw)])assert.equal(errorDetail(error),raw,'Raw diagnostics, model names, paths and identifiers remain exact');
});
