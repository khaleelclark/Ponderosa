import type Database from 'better-sqlite3';
import type {Adapter,RuntimeProcessHandle} from '@ponderosa/core';
import {admitProviderStart,enableProviderStartCoverage,settleProviderStart,holdProviderStart} from '@ponderosa/agents';
import type {ProviderProcessAuthority} from './provider-process-authority.js';
import {providerProcessHandleFacade} from './provider-session-facade.js';

/** All Agent-scoped adapter entries, including recovery/readiness/non-Run commands. */
export class ProviderStartAuthority {
 private readonly operations=new Map<string,Set<Promise<unknown>>>();
 private readonly handles=new Map<string,Set<RuntimeProcessHandle>>();
 constructor(private readonly db:Database.Database,private readonly workerId:string,private readonly processes:ProviderProcessAuthority){
  enableProviderStartCoverage(db,workerId);
 }
 wrap(adapter:Adapter):Adapter {
  const start=this;
  return new Proxy(adapter,{get(target,key){
   const method=Reflect.get(target,key,target);
   if(typeof method!=='function')return method;
   if(key==='openSession')return (options:Parameters<NonNullable<Adapter['openSession']>>[0])=>start.open(options.agentId,'openSession',options,(o)=>(method as NonNullable<Adapter['openSession']>).call(target,o));
   if(key==='seed'||key==='continue')return (options:Parameters<Adapter['seed']>[0])=>({
    // Async generators can launch on the first next(), not on method invocation.
    async *[Symbol.asyncIterator](){
     const claim=admitProviderStart(start.db,start.workerId,options.agentId,String(key));
     const tracked=start.track(options.agentId,claim,options);
     try{yield* (method as Adapter['seed']).call(target,tracked.options);}
     finally{tracked.finish();}
    },
   });
   return method.bind(target);
  }});
 }
 private track<T extends {onRuntimeSpawned:(h:RuntimeProcessHandle)=>void}>(agentId:string,claim:string,options:T){
  const registrations=new Set<string>(),owned=new Set<RuntimeProcessHandle>(),durable=new Set<RuntimeProcessHandle>();let finished=false;
  let resolve!:()=>void;
  const operation=new Promise<void>(r=>{resolve=r;});
  const operations=this.operations.get(agentId)??new Set();operations.add(operation);this.operations.set(agentId,operations);
  const handles=this.handles.get(agentId)??new Set();this.handles.set(agentId,handles);
  return {options:{...options,onRuntimeSpawned:(raw:RuntimeProcessHandle)=>{
   if(finished)holdProviderStart(this.db,claim);
   let handle:RuntimeProcessHandle;
   try{
    handle=providerProcessHandleFacade(raw);handles.add(handle);owned.add(handle);this.handles.set(agentId,handles);
    const agent=this.db.prepare('SELECT project_id FROM agents WHERE id=?').get(agentId) as {project_id:string}|undefined;
    const id=this.processes.register(handle,{purpose:'admitted provider start',agentId,projectId:agent?.project_id},raw);
    if(!id)throw Error('Provider start did not retain a process lifetime');
    registrations.add(id);durable.add(handle);
   }catch(error){holdProviderStart(this.db,claim);throw error;}
   // A callback outside its adapter operation cannot retroactively settle a claim.
   if(finished){void handle.close().catch(()=>undefined);throw Error('Provider start callback arrived after operation settled');}
   options.onRuntimeSpawned(raw);
  }},finish:()=>{
   if(finished)return;finished=true;
   try{if(registrations.size)settleProviderStart(this.db,claim,this.workerId,[...registrations]);}
   finally{for(const h of owned)if(durable.has(h))handles.delete(h);if(!handles.size)this.handles.delete(agentId);operations.delete(operation);if(!operations.size)this.operations.delete(agentId);resolve();}
  }};
 }
 private async open<T extends {onRuntimeSpawned:(h:RuntimeProcessHandle)=>void},R>(agentId:string,operation:string,options:T,invoke:(o:T)=>Promise<R>):Promise<R>{
  const claim=admitProviderStart(this.db,this.workerId,agentId,operation),tracked=this.track(agentId,claim,options);
  try{return await invoke(tracked.options);}
  finally{tracked.finish();}
 }
 /** Fence is already permanent before this call; late pre-fence returns stay retained. */
 async drain(agentIds:readonly string[]):Promise<void>{
  const close=async()=>{
   const results=await Promise.allSettled(agentIds.flatMap(id=>[...(this.handles.get(id)??[])].map(async h=>{await h.close();if(h.isAlive())throw Error('Admitted provider handle remains alive');})));
   const failed=results.flatMap(r=>r.status==='rejected'?[r.reason]:[]);
   if(failed.length)throw new AggregateError(failed,'Admitted provider handles failed to drain');
  };
  await close();
  await Promise.all(agentIds.flatMap(id=>[...(this.operations.get(id)??[])]));
  await close();
  // Persist observed lifetimes before journal readback; claims survive worker loss.
  const selected=new Set(agentIds);
  await this.processes.terminateAgents(selected,'Branch admitted provider start drain');
  for(const id of agentIds)this.handles.delete(id);
 }
}
