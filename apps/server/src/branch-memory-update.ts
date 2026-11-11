import type {InstalledBranchPackage,BranchMemoryUpdateSelectionDto,PortableChatMemorySnapshotDto,AgentPortablePackageDto} from '@ponderosa/core';
import {stableJson} from '@ponderosa/agents';
import {validateMemorySnapshot} from './portable-memory-snapshot.js';

const key=(chat:string,agent:string)=>JSON.stringify([chat,agent]);
/** Transform only the explicitly selected additive data; existing Agent context is never an import target. */
export function selectBranchMemory(pkg:InstalledBranchPackage,value:unknown,existing:Array<{chat_ref:string;agent_ref:string}>) {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['newAgents','teamChats'].includes(k)))throw Error('Choose explicit additive memory selections');
 const selection=value as BranchMemoryUpdateSelectionDto;
 if(!Array.isArray(selection.newAgents)||!Array.isArray(selection.teamChats)||selection.newAgents.length>1000||selection.teamChats.length>100)throw Error('Invalid additive memory selection');
 const old=new Set(existing.map(r=>key(r.chat_ref,r.agent_ref))),selected=new Set<string>();
 for(const a of selection.newAgents){
  if(!a||typeof a!=='object'||Object.keys(a).some(k=>!['chatRef','agentRef'].includes(k))||typeof a.chatRef!=='string'||typeof a.agentRef!=='string'||selected.has(key(a.chatRef,a.agentRef))||old.has(key(a.chatRef,a.agentRef))||!pkg.chats.find(c=>c.ref===a.chatRef)?.agents.some(n=>n.ref===a.agentRef))throw Error('Select unique new Agents only; existing Agent memory is preserved');
  selected.add(key(a.chatRef,a.agentRef));
 }
 if(selection.teamChats.some(ref=>typeof ref!=='string'||!old.has(key(ref,''))||!selection.newAgents.some(a=>a.chatRef===ref))||new Set(selection.teamChats).size!==selection.teamChats.length)throw Error('Select preserved Chats with a selected new Agent to receive team memory');
 const retained=new Set(pkg.chats.flatMap(c=>['',...c.agents.map(a=>a.ref)].map(a=>key(c.ref,a))));
 if(existing.some(r=>!retained.has(key(r.chat_ref,r.agent_ref)))||pkg.chats.some(c=>!old.has(key(c.ref,''))))throw Error('Additive memory updates preserve every existing Chat and Agent; review removals or new Chats separately');
 const incoming:Array<{chatRef:string;agentRef:string;snapshot:PortableChatMemorySnapshotDto}>=[];let excluded=0;
 for(const chat of pkg.chats){
  const team=selection.teamChats.includes(chat.ref),entries=chat.agents.flatMap(a=>a.definition.memory??[]);
  const carrier=chat.agents.find(a=>selected.has(key(chat.ref,a.ref)));
  const teams=entries.filter(e=>e.snapshot.chunks.some(r=>r.stamp.audience.endsWith(':team'))||e.snapshot.conflicts.some(r=>r.stamp.audience.endsWith(':team')));
  for(const agent of chat.agents){
   const original=agent.definition.memory??[];let memory:AgentPortablePackageDto['memory'];
   if(selected.has(key(chat.ref,agent.ref)))memory=original.map(e=>({...e,snapshot:{...e.snapshot,chunks:e.snapshot.chunks.filter(r=>!r.stamp.audience.endsWith(':team')),conflicts:e.snapshot.conflicts.filter(r=>!r.stamp.audience.endsWith(':team'))}}));
   if(team&&agent===carrier&&teams.length){
    const source=teams[0]!;
    if(teams.some(e=>e.snapshot.sourceChatId!==source.snapshot.sourceChatId||e.snapshot.signature!==source.snapshot.signature))throw Error('Team memory must have one source Chat and embedding signature');
    if(memory?.length&&memory[0]!.snapshot.sourceChatId!==source.snapshot.sourceChatId)throw Error('Selected Agent and team memory belong to different source Chats');
    if(!memory?.length){const sourceAgent=source.snapshot.agentIds[0];memory=[{agentRefs:sourceAgent?{[sourceAgent]:agent.ref}:{},snapshot:{...source.snapshot,agentIds:sourceAgent?[sourceAgent]:[],chunks:[],conflicts:[]}}];}
    const target=memory[0]!.snapshot;
    for(const kind of ['chunks','conflicts'] as const){const seen=new Map(target[kind].map(r=>[r.id,r]));for(const e of teams)for(const row of e.snapshot[kind].filter(r=>r.stamp.audience.endsWith(':team'))){const previous=seen.get(row.id);if(previous&&stableJson(previous)!==stableJson(row))throw Error('Memory source ID collision; review the source package');seen.set(row.id,row);}target[kind]=[...seen.values()];}
   }
   const before=original.reduce((n,e)=>n+e.snapshot.chunks.length+e.snapshot.conflicts.length,0);
   if(memory){for(const entry of memory){validateMemorySnapshot(entry.snapshot);incoming.push({chatRef:chat.ref,agentRef:agent.ref,snapshot:entry.snapshot});}agent.definition.memory=memory;}
   else delete agent.definition.memory;
   // Exclusions are shown explicitly; team data may have moved to its one selected carrier.
   excluded+=before;
  }
 }
 const selectedRows=incoming.reduce((n,e)=>n+e.snapshot.chunks.length+e.snapshot.conflicts.length,0);
 return {selection,incoming,excludedRows:excluded-selectedRows};
}
