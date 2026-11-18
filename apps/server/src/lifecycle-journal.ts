import path from 'node:path';
import type Database from 'better-sqlite3';
import fs from '@ponderosa/native-host/fs';
import {createHash,randomUUID} from 'node:crypto';
import {stableJson} from '@ponderosa/agents';
export const lifecycleHash=(value:unknown)=>createHash('sha256').update(stableJson(value)).digest('hex');
/** Private, immutable evidence. A failed database commit leaves a resumable hold, never permission. */
export function lifecycleJournal(directory:string,db:Database.Database){
 fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const owned=fs.lstatSync(directory);if(!owned.isDirectory()||owned.isSymbolicLink()||(owned.mode&0o077))throw Error('Lifecycle journal must be private');
 const sync=(file:string)=>{if(process.platform!=='win32'){const fd=fs.openSync(file,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}};
 sync(path.dirname(directory));
 const file=(key:string)=>path.join(directory,`${lifecycleHash(key)}.json`);
 const read=(key:string):any=>{try{const target=file(key),stat=fs.lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>4*1024*1024)throw Error('Lifecycle evidence is not bounded owned data');const bytes=fs.readFileSync(target,'utf8'),value=JSON.parse(bytes);if(stableJson(value)!==bytes||value.sha256!==lifecycleHash(value.evidence))throw Error('Lifecycle evidence integrity failure');return value.evidence;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}};
 return {read,write(key:string,evidence:unknown){if(!db.inTransaction)throw Error('Lifecycle publication requires canonical owner transaction');const prior=read(key);if(prior!==undefined){if(stableJson(prior)!==stableJson(evidence))throw Error('Lifecycle command conflict');return prior;}
  const bytes=stableJson({evidence,sha256:lifecycleHash(evidence)});if(Buffer.byteLength(bytes)>4*1024*1024)throw Error('Lifecycle journal exceeds bound');
  const temporary=path.join(directory,`${randomUUID()}.tmp`),fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  // Every writer holds the same SQLite owner lock; rename publishes complete bytes atomically.
  fs.renameSync(temporary,file(key));
  sync(directory);return evidence;
 }};
}
