import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,chmod,symlink,link,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore} from '@ponderosa/agents';
import {LocalMemoryService} from '../../apps/server/dist/local-memory.js';
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

async function admittedFixture(run){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'memory-admitted-root-'))),dataDir=path.join(root,'data'),store=new AgentStore(dataDir),admission=store.stateAdmission();
 const inference={signature:'synthetic-authority-check',async embed(){throw Error('No inference expected');},async rerank(){throw Error('No inference expected');},async close(){}};
 const ports={store,opts:{dataDir:admission.dataDir,localMemory:{stateDirectory:path.join(root,'policy'),chromaUrl:'http://127.0.0.1:1',collectionPrefix:'synthetic_authority_check',modelDir:root,provision:true}},capabilities:new Map(),activeRuns:new Map(),ownsRun:()=>false};
 try{await run({root,dataDir,ports,inference});}finally{admission.close();store.close();await rm(root,{recursive:true,force:true});}
}

test('Local Memory initializes its policy against the held canonical root without starting inference or Chroma',()=>admittedFixture(async({ports,inference})=>{
 const memory=new LocalMemoryService(ports,inference);
 try{assert.match(memory.principalId,/^[0-9a-f-]{36}$/);assert.equal(memory.policy.open,true);}finally{await memory.close();}
 ports.opts.localMemory.provision=false;
 const reopened=new LocalMemoryService(ports,inference);
 try{assert.equal(reopened.principalId,memory.principalId);}finally{await reopened.close();}
}));

test('Local Memory refuses policy state inside the physical admitted data directory',()=>admittedFixture(async({dataDir,ports,inference})=>{
 for(const stateDirectory of [dataDir,path.join(dataDir,'policy')]){
  ports.opts.localMemory.stateDirectory=stateDirectory;
  assert.throws(()=>new LocalMemoryService(ports,inference),/outside canonical dataDir/);
 }
}));

test('Local Memory preserves private external-policy and explicit provisioning checks',()=>admittedFixture(async({root,ports,inference})=>{
 const stateDirectory=path.join(root,'external-policy');await mkdir(stateDirectory,{mode:0o700});
 ports.opts.localMemory={...ports.opts.localMemory,stateDirectory,provision:false};
 assert.throws(()=>new LocalMemoryService(ports,inference),/explicit provision/);
}));

test('Local Memory excludes the held physical root after its display path is renamed and replaced',()=>admittedFixture(async({root,dataDir,ports,inference})=>{
 const moved=path.join(root,'moved-data');await rename(dataDir,moved);await mkdir(dataDir);
 ports.opts.reportedDataDir=dataDir;
 ports.opts.localMemory.stateDirectory=path.join(moved,'policy');
 assert.throws(()=>new LocalMemoryService(ports,inference),/outside canonical dataDir/);
}));

test('Local Memory still refuses policy aliases, broad permissions and hard-linked databases',()=>admittedFixture(async({root,ports,inference})=>{
 const stateDirectory=ports.opts.localMemory.stateDirectory;await mkdir(stateDirectory,{mode:0o700});
 const alias=path.join(root,'alias');await symlink(stateDirectory,alias);
 ports.opts.localMemory.stateDirectory=alias;
 assert.throws(()=>new LocalMemoryService(ports,inference),/aliases unsupported/);
 ports.opts.localMemory.stateDirectory=stateDirectory;
 await chmod(stateDirectory,0o755);
 assert.throws(()=>new LocalMemoryService(ports,inference),/must be private/);
 await chmod(stateDirectory,0o700);
 const memory=new LocalMemoryService(ports,inference);await memory.close();
 await link(path.join(stateDirectory,'host-policy.sqlite'),path.join(root,'linked-policy.sqlite'));
 assert.throws(()=>new LocalMemoryService(ports,inference),/private regular file/);
}));
