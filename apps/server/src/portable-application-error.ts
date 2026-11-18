import {redactPortableDiagnostic} from './portable-secrets.js';
/** Keep exact causes and useful inode evidence without leaking unknown attribute/credential payloads. */
export function portableApplicationFailure(error:unknown){
 const failure=error as {message?:unknown;code?:unknown;observed?:Record<string,unknown>;cause?:unknown},raw=failure?.observed?.identity??failure?.observed;
 const identity=raw&&typeof raw==='object'?Object.fromEntries(['path','device','inode','kind','mode','mtimeNs','ownerId','groupId','parentDevice','parentInode','deviceMajor','deviceMinor'].filter(key=>Object.hasOwn(raw,key)).map(key=>[key,(raw as Record<string,unknown>)[key]])):null;
 const cause=failure?.cause as {message?:unknown;code?:unknown;name?:unknown}|undefined;
 return JSON.parse(JSON.stringify({message:redactPortableDiagnostic(error instanceof Error?error.message:String(error)),code:typeof failure?.code==='string'?failure.code:undefined,partialStatePossible:true as const,observed:raw?{identity,inventoryState:failure?.observed?.inventoryState??null}:null,...(cause?{cause:{name:typeof cause.name==='string'?cause.name:undefined,message:redactPortableDiagnostic(cause instanceof Error?cause.message:String(cause)),code:typeof cause.code==='string'?cause.code:undefined}}:{})},(_key,value)=>typeof value==='bigint'?value.toString():value)) as {message:string;code?:string;partialStatePossible:true;observed:unknown;cause?:{message:string;code?:string;name?:string}};
}
