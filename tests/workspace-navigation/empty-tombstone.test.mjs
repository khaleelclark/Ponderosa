import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {removeEmptyTombstone} from '../../apps/server/dist/empty-tombstone.js';

test('owned cleanup removes an empty tombstone but preserves unexpected user content',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'empty-tombstone-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const empty=path.join(root,'empty'),populated=path.join(root,'populated');
 for(const directory of [empty,populated]){await mkdir(directory);await writeFile(path.join(directory,'.owner'),'owned');}
 await writeFile(path.join(populated,'user.txt'),'user bytes');
 await assert.rejects(removeEmptyTombstone(populated,'.owner'),/preserved unexpected files/);
 assert.equal(await readFile(path.join(populated,'user.txt'),'utf8'),'user bytes');assert.equal(await readFile(path.join(populated,'.owner'),'utf8'),'owned');
 await removeEmptyTombstone(empty,'.owner');await assert.rejects(access(empty),{code:'ENOENT'});
});
