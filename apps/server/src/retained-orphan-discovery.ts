import path from 'node:path';
import {promises as fs} from '@ponderosa/native-host/fs';
import type {LifecycleDiscoveryQuery} from '@ponderosa/core';
import {lifecycleDiscoveryPage} from './lifecycle-discovery.js';

/** Inspect names and metadata only. No file contents, hydration, moves or reconciliation. */
export async function retainedOrphanDiscovery(directory:string,query:LifecycleDiscoveryQuery){
 let names:string[];
 try{names=await fs.readdir(directory);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;names=[];}
 if(names.length>4096)throw Error('Lifecycle discovery inventory exceeds bound; orphan evidence remains preserved');
 const entries=[];
 for(const name of names){
  const stat=await fs.lstat(path.join(directory,name));
  entries.push({key:name,value:{name,byteLength:stat.size,regular:stat.isFile()&&!stat.isSymbolicLink(),state:'preserved_unresolved' as const},
   identity:{dev:stat.dev,ino:stat.ino,mode:stat.mode,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs}});
 }
 // Metadata identity binds page continuation too; the displayed row remains concise.
 const page=lifecycleDiscoveryPage('orphan-evidence',entries.map(entry=>({key:entry.key,value:{...entry.value,identity:entry.identity}})),query);
 return {...page,items:page.items.map(({identity,...entry})=>entry)};
}
