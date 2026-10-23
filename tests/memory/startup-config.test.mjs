import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,chmod,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadLocalMemoryConfiguration} from '../../apps/server/dist/local-memory-config.js';
const valid={chromaUrl:'http://127.0.0.1:8000',collectionPrefix:'private_branches',modelDir:'/synthetic/models',stateDirectory:'/synthetic/policy',provision:true};
async function fixture(run){const root=await mkdtemp(path.join(tmpdir(),'memory-config-'));const file=path.join(root,'memory.json');try{await writeFile(file,JSON.stringify(valid),{mode:0o600});await run(file,root);}finally{await rm(root,{recursive:true,force:true});}}
test('normal server memory remains opt-in without a configuration file',()=>{assert.equal(loadLocalMemoryConfiguration(undefined),undefined);assert.equal(loadLocalMemoryConfiguration(''),undefined);});
test('operator configuration supplies the same physical-memory options for generic Branches startup',()=>fixture(async file=>{assert.deepEqual(loadLocalMemoryConfiguration(file),valid);}));
test('legacy journal configuration is refused without rewriting or creating state',()=>fixture(async file=>{await writeFile(file,JSON.stringify({...valid,journalDirectory:'/synthetic/old-journal'}));const before=await readFile(file);assert.throws(()=>loadLocalMemoryConfiguration(file),/legacy journal/);assert.deepEqual(await readFile(file),before);}));
test('configuration refuses missing paths, relative paths, URL credentials and truthy non-boolean provisioning',()=>fixture(async file=>{
 for(const patch of [{modelDir:''},{stateDirectory:'relative'}, {chromaUrl:'http://synthetic:secret@127.0.0.1:8000'},{chromaUrl:'file:///synthetic'},{provision:'true'},{chatId:'forged-scope'}]){
  await writeFile(file,JSON.stringify({...valid,...patch}));assert.throws(()=>loadLocalMemoryConfiguration(file));
 }
 assert.throws(()=>loadLocalMemoryConfiguration('relative.json'),/absolute/);
}));
test('operator configuration rejects replaceable symlinks and writable-by-others files',()=>fixture(async(file,root)=>{
 const link=path.join(root,'link.json');await symlink(file,link);assert.throws(()=>loadLocalMemoryConfiguration(link));
 await chmod(file,0o666);assert.throws(()=>loadLocalMemoryConfiguration(file),/operator-owned/);
}));
test('operator configuration rejects oversized input before parsing',()=>fixture(async file=>{await writeFile(file,' '.repeat(16385));assert.throws(()=>loadLocalMemoryConfiguration(file),/16KiB/);}));
