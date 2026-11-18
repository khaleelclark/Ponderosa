import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

// A receipt binds reviewed bytes; it does not create permission to run qualification.
export const inputManifestDigest=inputs=>sha256(JSON.stringify(inputs.map(({path,sha256})=>({path,sha256})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)));
export async function verifyAcceptedMethod(path,expectedHash,requiredPaths,expectedHead){
 assert(typeof expectedHead==='string'&&/^[a-f0-9]{40}$/.test(expectedHead),'Separate manager-pinned reviewed head required');
 const bytes=await readFile(path);assert.equal(sha256(bytes),expectedHash,'Pin actual accepted receipt bytes');
 const value=JSON.parse(bytes);assert.equal(value.decision,'ACCEPT');assert.equal(value.scope,'METHOD');
 const paths=value.inputs.map(r=>r.path);assert.equal(new Set(paths).size,paths.length,'No duplicate reviewed input paths');
 const digest=inputManifestDigest(value.inputs);
 const reviewBytes=await readFile(value.review.path);assert.equal(sha256(reviewBytes),value.review.sha256,'Bind actual independent structured decision bytes');
 const decision=JSON.parse(reviewBytes);assert.deepEqual(Object.keys(decision).sort(),['decision','inputManifestSha256','reviewedHead','schemaVersion','scope'].sort(),'Structured METHOD decision only; prose or mixed decisions cannot confer acceptance');
 assert.equal(decision.schemaVersion,1);assert.equal(decision.scope,'METHOD');assert.equal(decision.decision,'ACCEPT');assert.equal(decision.reviewedHead,expectedHead);assert.equal(decision.inputManifestSha256,digest,'Decision must bind exact enumerated input manifest');
 assert(value.go32?.authorizedBy&&value.go32?.communicationReference,'Separate explicit GO32 authority reference required');
 for(const required of requiredPaths)assert(paths.includes(required),'Missing reviewed input '+required);
 for(const record of value.inputs)assert.equal(sha256(await readFile(record.path)),record.sha256,'Reviewed input drift '+record.path);
 return {receipt:{path,sha256:expectedHash},review:value.review,decision,go32:value.go32,inputs:value.inputs,inputScope:'enumerated file bytes only; execution tools/dependencies and source-to-build provenance NOT established'};
}

export async function finalizeLedger(ledger,rows,persist,cleanups){
 ledger.cleanup=[];
 for(const [name,close] of cleanups){try{await close();ledger.cleanup.push({name,status:'complete',at:Date.now()});}catch(error){ledger.cleanup.push({name,status:'failed',at:Date.now(),error:String(error)});ledger.status='failed';}}
 for(const row of rows)if(!['complete','failed'].includes(row.status)){row.status='not-run';row.terminalReason=ledger.error??'Earlier setup/cell failure';row.terminalAt=Date.now();}
 ledger.terminalAt=Date.now();await persist();
 assert(ledger.status!=='failed','Qualification failed; retained terminal ledger');
}
