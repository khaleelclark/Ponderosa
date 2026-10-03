import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {AgentStore} from '@ponderosa/agents';
import {spawnContainedCli} from '../../../packages/engines/dist/contained-spawn.js';
import {runtimeProcessHandle} from '../../../packages/engines/dist/process-termination.js';
import {ProviderProcessAuthority} from '../dist/provider-process-authority.js';

test('scope identity is durable across restart, cancellation, deletion and drain; wrong ownership retains retryable authority', {skip:process.platform!=='linux'||!process.env.PONDEROSA_TEST_PRIVATE_SLICE,timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'scope-ledger-')),slice=process.env.PONDEROSA_TEST_PRIVATE_SLICE,parent=`spec3-ledger-${randomUUID()}.service`;
 let store=new AgentStore(root),authority=new ProviderProcessAuthority(store.sqlite,'old-worker'),handles=[];
 execFileSync('systemd-run',['--user','--quiet',`--unit=${parent}`,`--slice=${slice}`,'--property=RuntimeMaxSec=40','/bin/sleep','40']);
 try{
  for(const boundary of ['restart','cancel','agent-delete','project-delete','drain','failed-cleanup']){
   const file=join(root,`${boundary}.json`),script=join(root,`${boundary}.mjs`);
   await writeFile(script,`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const c=spawn(process.execPath,['-e','globalThis.memory=Buffer.alloc(16*1024*1024,1);setTimeout(()=>{},30000)'],{detached:true,stdio:'ignore'});writeFileSync(${JSON.stringify(file)},JSON.stringify({pid:c.pid}));c.unref();`);
   const {child}=spawnContainedCli({bin:process.execPath,args:[script],cwd:root,env:{PATH:process.env.PATH,HOME:root,XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR},stdin:'ignore'},{PONDEROSA_AGENT_SCOPE_MODE:'systemd',PONDEROSA_AGENT_PARENT_UNIT:parent,PONDEROSA_AGENT_WORKLOAD_SLICE:slice});
   const handle=runtimeProcessHandle(child,{label:boundary,termGraceMs:100,killConfirmationMs:100});handles.push(handle);
   authority.register(handle,{purpose:'persistent provider runtime',projectId:'project',agentId:'agent',runId:boundary});
   for(let i=0;i<100;i++){try{await readFile(file);break;}catch{await delay(20);}}
   await delay(100);assert.equal(authority.count(),1);
   const row=store.sqlite.prepare('SELECT scope_json FROM provider_process_authority').get();assert.deepEqual(JSON.parse(row.scope_json),handle.processIdentity.scope);
   // Retention alone must not eagerly close an accepted session/workload.
   assert.equal(handle.isAlive(),true);
   if(boundary==='restart'){store.close();store=new AgentStore(root);authority=new ProviderProcessAuthority(store.sqlite,'new-worker');await authority.recoverPreviousWorkers();}
   else if(boundary==='cancel')await authority.terminateRun(boundary);
   else if(boundary==='agent-delete')await authority.terminateAgents(new Set(['agent']),'delete');
   else if(boundary==='project-delete')await authority.terminateProject('project','delete');
   else if(boundary==='drain')await authority.terminateAgents(new Set(['agent']),'deployment drain');
   else{
    store.sqlite.prepare('UPDATE provider_process_authority SET scope_json=?').run(JSON.stringify({...handle.processIdentity.scope,authorityId:randomUUID()}));
    await assert.rejects(authority.terminateRun(boundary),/authority pending/);assert.equal(authority.count(),1);
    store.sqlite.prepare('UPDATE provider_process_authority SET scope_json=?').run(row.scope_json);await authority.terminateRun(boundary);
   }
   assert.equal(authority.count(),0);await handle.close();assert.equal(handle.isAlive(),false);
  }
 }finally{for(const handle of handles)await handle.close();execFileSync('systemctl',['--user','stop',parent]);store.close();await rm(root,{recursive:true,force:true});}
});
