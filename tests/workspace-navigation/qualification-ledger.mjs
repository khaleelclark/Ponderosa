import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

// A receipt binds reviewed bytes; it does not create permission to run qualification.
export async function verifyAcceptedMethod(path,expectedHash,requiredPaths){
 const bytes=await readFile(path);assert.equal(sha256(bytes),expectedHash,'Pin actual accepted receipt bytes');
 const value=JSON.parse(bytes);assert.equal(value.decision,'ACCEPT');assert.equal(value.scope,'METHOD');
 const reviewBytes=await readFile(value.review.path);assert.equal(sha256(reviewBytes),value.review.sha256,'Bind actual independent review bytes');assert(/^ACCEPT(?:\s|$)/m.test(reviewBytes.toString('utf8')),'Independent review must explicitly ACCEPT; no REQUEST_CHANGES receipt');
 assert(value.go32?.authorizedBy&&value.go32?.communicationReference,'Separate explicit GO32 authority reference required');
 const paths=value.inputs.map(r=>r.path);assert.equal(new Set(paths).size,paths.length,'No duplicate reviewed input paths');
 for(const required of requiredPaths)assert(paths.includes(required),'Missing reviewed input '+required);
 for(const record of value.inputs)assert.equal(sha256(await readFile(record.path)),record.sha256,'Reviewed input drift '+record.path);
 return {receipt:{path,sha256:expectedHash},review:value.review,go32:value.go32,inputs:value.inputs};
}

export async function finalizeLedger(ledger,rows,persist,cleanups){
 ledger.cleanup=[];
 for(const [name,close] of cleanups){try{await close();ledger.cleanup.push({name,status:'complete',at:Date.now()});}catch(error){ledger.cleanup.push({name,status:'failed',at:Date.now(),error:String(error)});ledger.status='failed';}}
 for(const row of rows)if(!['complete','failed'].includes(row.status)){row.status='not-run';row.terminalReason=ledger.error??'Earlier setup/cell failure';row.terminalAt=Date.now();}
 ledger.terminalAt=Date.now();await persist();
 assert(ledger.status!=='failed','Qualification failed; retained terminal ledger');
}
