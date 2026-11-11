import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,mkdir,utimes,readFile,lstat,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {processBirthMarker} from '@ponderosa/engines';
import {recoverHostedDisplayResidue} from '../../apps/server/dist/browser-session-residue.js';

async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'display-residue-current-'));let passed=false;
 t.after(async()=>{if(passed)await rm(root,{recursive:true,force:true});else t.diagnostic(`Retained display fixture: ${root}`)});
 const sockets=path.join(root,'sockets');await mkdir(sockets);
 const reservation=path.join(root,'ponderosa-xvfb-171.lock'),claim=path.join(root,'ponderosa-xvfb-171.cleanup'),old=new Date(Date.now()-60000);
 await writeFile(reservation,'',{mode:0o600});await utimes(reservation,old,old);
 return {root,reservation,claim,old,paths:{reservationDirectory:root,xLockDirectory:root,socketDirectory:sockets,minimumAgeMs:0,trackStatus:false},pass(){passed=true}};
}

for(const partial of ['', '{"pid":'])test(`a stale ${partial?'partial':'empty'} display cleanup claim is recovered without a permanent restart blocker`,async t=>{
 const f=await fixture(t);await writeFile(f.claim,partial,{mode:0o600});await utimes(f.claim,f.old,f.old);
 await recoverHostedDisplayResidue(f.paths);
 for(const name of [f.reservation,f.claim])await assert.rejects(lstat(name),{code:'ENOENT'});f.pass();
});

test('stale-age alone cannot take over a cleanup claim whose exact owner is still alive',async t=>{
 const f=await fixture(t),record=JSON.stringify({pid:process.pid,birthMarker:processBirthMarker(process.pid)});assert.ok(JSON.parse(record).birthMarker);
 await writeFile(f.claim,record,{mode:0o600});await utimes(f.claim,f.old,f.old);
 await recoverHostedDisplayResidue(f.paths);assert.equal(await readFile(f.claim,'utf8'),record);assert.equal(await readFile(f.reservation,'utf8'),'');f.pass();
});

test('display recovery refuses a replacement symlink instead of changing its target',{skip:process.platform==='win32'?'Symbolic links require a Windows host grant':false},async t=>{
 const f=await fixture(t),target=path.join(f.root,'unrelated.txt');await writeFile(target,'Keep this',{mode:0o600});await symlink(target,f.claim);
 await assert.rejects(recoverHostedDisplayResidue(f.paths),/unowned file/);assert.equal(await readFile(target,'utf8'),'Keep this');assert.equal((await lstat(f.claim)).isSymbolicLink(),true);f.pass();
});
