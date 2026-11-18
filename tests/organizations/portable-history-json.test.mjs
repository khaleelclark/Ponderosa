import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readPortableHistoryJson,readPortableHistoryJsonAsync,writePortableHistoryJson,writePortableHistoryJsonAsync} from '../../packages/agents/dist/portable-history-json.js';
test('canonical archive parser preserves Unicode across bounded reads and writers retain authored fields',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'portable-history-json-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target=path.join(root,'archive.json'),value={source:'Original source 🐘',importedAt:'2026-11-03T00:00:00.000Z',messages:[{role:'user',text:'😀漢字\n'.repeat(100000)}],initialInstructions:'Exact setup',initialInstructionsSeparated:true};
 writePortableHistoryJson(target,value);assert.deepEqual(readPortableHistoryJson(target),value);assert.deepEqual(await readPortableHistoryJsonAsync(target),value);
 await writePortableHistoryJsonAsync(target,{...value,portableState:{workingFiles:[{path:'original',artifactRef:'exact-ref'}]}});assert.ok((await readFile(target)).length>256*1024);assert.deepEqual(await readPortableHistoryJsonAsync(target),{...value,portableState:{workingFiles:[{path:'original',artifactRef:'exact-ref'}]}});
});
