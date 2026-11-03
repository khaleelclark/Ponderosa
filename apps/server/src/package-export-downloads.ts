import {openPortableRegular} from './portable-held-regular.js';
import {createHash,randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import {constants,hasRetainedStorageAuthority,promises as fs} from '@ponderosa/native-host/fs';
import {DataDirectoryAuthority,dataDirectoryAuthoritySupported} from '@ponderosa/native-host';
import type {FastifyInstance,FastifyReply} from 'fastify';
import {AGENT_PACKAGE_MAX_BYTES,AGENT_PACKAGE_STAGING_MAX_BYTES} from '@ponderosa/core';
import {stableJson} from '@ponderosa/agents';
import {portablePackageJsonChunks} from './agent-package-codec.js';

export const PACKAGE_EXPORT_TICKET_LIFETIME_MS=15*60_000;
export interface PackageExportDownload {downloadUrl:string;expiresAt:string;byteLength:number}
type Manifest={schema:'ponderosa.package-export-ticket.v1';token:string;filename:string;bytes:number;sha256:string;createdAt:number;expiresAt:number;device:string;inode:string;requestKey?:string;selectionHash?:string};
type Ticket={pathname:string;filename:string;bytes:number;expiresAt:number;device:string;inode:string;mtimeNs:string;ctimeNs:string;readers:number;removing?:boolean;manifest?:string;manifestIdentity?:{device:string;inode:string};requestKey?:string;selectionHash?:string;timer:ReturnType<typeof setTimeout>};
const services=new WeakMap<FastifyInstance,PackageExportDownloads>();
type PortableStagingLease={authority:Promise<DataDirectoryAuthority>;refs:number};
const portableStagingLeases=new Map<string,PortableStagingLease>();
type ExportRequest={key:string;selectionHash:string;createdAt:number;phase:'preparing'|'completed';token?:string;serializing?:boolean;identity?:{device:string;inode:string}};
const tokenPattern=/^[a-f0-9]{48}$/u;
/** Shared Agent/Branch staging. Complete durable manifests retain exact bytes;
 * unconfirmed files are held and charged, never treated as completed exports. */
export class PackageExportDownloads{
 private directory?:Promise<string>;private rootHandle?:Awaited<ReturnType<typeof fs.open>>;private rootNamed?:string;private rootIdentity?:{device:string;inode:string;descriptor:boolean};private directoryHandle?:Awaited<ReturnType<typeof fs.open>>;private directoryNamed?:string;private directoryIdentity?:{device:string;inode:string};private portableLease?:{key:string;entry:PortableStagingLease};private temporaryAuthority?:DataDirectoryAuthority;private displayDirectory?:string;private bytes=0;private pending=0;private held=0;private tickets=new Map<string,Ticket>();private closed=false;private hydration?:Promise<void>;private requests=new Map<string,ExportRequest>();private activeRequests=new WeakMap<FastifyReply,ExportRequest>();
 constructor(app:FastifyInstance,private readonly dataDir?:string){
  app.get<{Params:{token:string}}>('/api/package-exports/:token',{config:{agentPackageOperation:true}},async(request,reply)=>{
   await this.ready();const ticket=this.tickets.get(request.params.token);
   if(!ticket||ticket.expiresAt<=Date.now())return reply.code(410).send({error:'Package download expired or is not confirmed. Prepare a new export.'});
   return this.stream(ticket,reply);
  });
  app.get<{Params:{key:string}}>('/api/package-export-requests/:key',{config:{agentPackageOperation:true}},async(request,reply)=>{
   await this.ready();const record=this.requests.get(request.params.key),ticket=record?.token&&this.tickets.get(record.token);
   if(!record)return reply.code(404).send({error:'Export preparation is not recorded.'});
   if(record.phase==='completed'&&ticket&&ticket.expiresAt>Date.now())return reply.header('cache-control','private, no-store').send({state:'completed',...this.descriptor(record.token!,ticket)});
   return reply.header('cache-control','private, no-store').send({state:'unconfirmed',error:'Original export preparation is unconfirmed. Its bytes are held; retry cannot capture a replacement.'});
  });
  app.addHook('onClose',async()=>{
   this.closed=true;for(const ticket of this.tickets.values())clearTimeout(ticket.timer);
   // Names can be replaced by an independent same-user writer; no automatic
   // pathname deletion is safe. Keep originals and their durable accounting.
   if(this.hydration)await this.hydration.catch(()=>undefined);
   this.tickets.clear();
   const errors:unknown[]=[];
   if(this.directoryHandle)try{await this.directoryHandle.close();}catch(error){errors.push(error);}this.directoryHandle=undefined;
   if(this.rootHandle)try{await this.rootHandle.close();}catch(error){errors.push(error);}this.rootHandle=undefined;
   try{await this.releasePortableLease();}catch(error){errors.push(error);}
   if(this.temporaryAuthority)try{this.temporaryAuthority.close();}catch(error){errors.push(error);}this.temporaryAuthority=undefined;
   if(errors.length)throw Object.assign(Error('Package export staging authority cleanup failed; retained files were preserved'),{cleanupErrors:errors});
  });
 }
 private capacityError():Error {
  return Object.assign(Error('Package export staging capacity is full or retains unconfirmed files. Review retained files at '+(this.displayDirectory??'the local package-export-downloads folder')+'; no automatic deletion is performed.'),{statusCode:503});
 }
 private reserveBytes(bytes:number):void {
  if(!Number.isSafeInteger(bytes)||bytes<0||this.bytes+bytes>AGENT_PACKAGE_STAGING_MAX_BYTES)throw this.capacityError();
  this.bytes+=bytes;
 }
 private async readManifest(handle:Awaited<ReturnType<typeof fs.open>>,pathname:string,before:{dev:bigint;ino:bigint;nlink:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint}):Promise<unknown>{
  const buffer=Buffer.alloc(8193);let length=0;
  for(;;){const read=await handle.read(buffer,length,buffer.length-length,length);length+=read.bytesRead;if(length>8192)throw Error('Export manifest exceeds its bound');if(!read.bytesRead)break;}
  const after=await handle.stat({bigint:true}),named=await fs.lstat(pathname,{bigint:true});
  if(!after.isFile()||!named.isFile()||after.nlink!==1n||named.nlink!==1n||after.dev!==before.dev||after.ino!==before.ino||named.dev!==before.dev||named.ino!==before.ino||after.size!==before.size||named.size!==before.size||after.mtimeNs!==before.mtimeNs||named.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs||named.ctimeNs!==before.ctimeNs||BigInt(length)!==before.size)throw Error('Export manifest changed during bounded read; retained without adoption');
  return JSON.parse(buffer.subarray(0,length).toString('utf8'));
 }
 private async releasePortableLease():Promise<void>{
  const lease=this.portableLease;if(!lease)return;this.portableLease=undefined;
  if(--lease.entry.refs===0){
   if(portableStagingLeases.get(lease.key)===lease.entry)portableStagingLeases.delete(lease.key);
   (await lease.entry.authority).close();
  }
 }
 private descriptor(token:string,ticket:Ticket):PackageExportDownload{return {downloadUrl:'/api/package-exports/'+token,expiresAt:new Date(ticket.expiresAt).toISOString(),byteLength:ticket.bytes};}
 private requestPath(key:string):Promise<string>{return this.directory!.then(directory=>path.join(directory,'request-'+createHash('sha256').update(key).digest('hex')+'.json'));}
 /** Claim identity before any source builder runs. A lost response/status retry
  * can return only this completed capture, never silently create another. */
 async prepare(key:unknown,identity:unknown,reply:FastifyReply,work:()=>Promise<unknown>):Promise<unknown>{
  if(key===undefined)return work();
  if(typeof key!=='string'||!/^[A-Za-z0-9-]{8,128}$/u.test(key))throw Object.assign(Error('Invalid export request identity'),{statusCode:400});
  await this.ready();const selectionHash=createHash('sha256').update(stableJson(identity)).digest('hex'),existing=this.requests.get(key);
  if(existing){
   if(existing.selectionHash!==selectionHash)throw Object.assign(Error('Original export request choices differ; prepare a new explicit export.'),{statusCode:409});
   const ticket=existing.token&&this.tickets.get(existing.token);
   if(existing.phase==='completed'&&ticket&&ticket.expiresAt>Date.now())return reply.header('cache-control','private, no-store').send(this.descriptor(existing.token!,ticket));
   throw Object.assign(Error('Original export preparation is unconfirmed or expired. Its bytes are held; retry cannot capture a replacement.'),{statusCode:409});
  }
  if(this.closed||this.pending+this.tickets.size+this.held>=16)throw this.capacityError();
  const record:ExportRequest={key,selectionHash,createdAt:Date.now(),phase:'preparing'};this.requests.set(key,record);this.held++;
  if(this.dataDir){
   const payload=Buffer.from(JSON.stringify({schema:'ponderosa.package-export-request.v1',key,selectionHash,createdAt:record.createdAt}));this.reserveBytes(payload.length);
   try{const handle=await fs.open(await this.requestPath(key),'wx',0o600);try{const stat=await handle.stat({bigint:true});record.identity={device:stat.dev.toString(),inode:stat.ino.toString()};await handle.writeFile(payload);await handle.sync();}finally{await handle.close();}await this.syncDirectory();}catch(error){this.bytes=AGENT_PACKAGE_STAGING_MAX_BYTES;if(error instanceof Error)error.message+='; unconfirmed staging is retained at '+(this.displayDirectory??'the local package-export-downloads folder');throw error;}
  }
  this.activeRequests.set(reply,record);
  // Once a durable claim exists, it is retained even for a failed source
  // builder: a name can change between identity inspection and unlink.
  try{return await work();}
  finally{this.activeRequests.delete(reply);}
 }
 private async assertDirectory():Promise<void>{
  if(this.rootNamed&&this.rootIdentity){
   const current=this.rootIdentity.descriptor?await fs.stat(this.rootNamed,{bigint:true}):await fs.lstat(this.rootNamed,{bigint:true});
   if(!current.isDirectory()||!this.rootIdentity.descriptor&&current.isSymbolicLink()||current.dev.toString()!==this.rootIdentity.device||current.ino.toString()!==this.rootIdentity.inode)throw Error('Package export data-root custody changed; preserve retained packages');
  }
  if(!this.directoryNamed||!this.directoryIdentity)return;
  const current=await fs.lstat(this.directoryNamed,{bigint:true});
  if(!current.isDirectory()||current.isSymbolicLink()||current.dev.toString()!==this.directoryIdentity.device||current.ino.toString()!==this.directoryIdentity.inode||(process.platform!=='win32'&&(current.mode&0o077n)!==0n))throw Error('Package export staging custody changed; preserve retained packages');
 }
 private async syncDirectory():Promise<void>{if(process.platform!=='win32'){await this.assertDirectory();if(this.directoryHandle)await this.directoryHandle.sync();else{const handle=await fs.open(await this.directory!,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);try{await handle.sync();}finally{await handle.close();}}}}
 private async ready():Promise<void>{
  this.hydration??=this.hydrate();await this.hydration;await this.assertDirectory();
 }
 private schedule(token:string,ticket:Ticket):void{
  ticket.timer=setTimeout(()=>{void this.remove(token,ticket);},Math.max(1,ticket.expiresAt-Date.now()));ticket.timer.unref();
 }
 private async hydrate():Promise<void>{
  this.directory??=(async()=>{
   let sourceRoot=this.dataDir;
   if(!sourceRoot){
    // Test/embedding-only temporary service. No cleanup is attempted.
    if(process.platform!=='linux'&&!dataDirectoryAuthoritySupported())throw Object.assign(Error('Package export requires qualified native directory authority on this platform'),{statusCode:503});
    const temporary=await fs.mkdtemp(path.join(tmpdir(),'ponderosa-package-export-'));
    if(process.platform==='linux')sourceRoot=temporary;
    else{this.temporaryAuthority=new DataDirectoryAuthority(temporary);sourceRoot=this.temporaryAuthority.rootPath;}
   }
   const descriptorPrefix='/proc/self/fd/',descriptorRoot=process.platform==='linux'&&sourceRoot.startsWith(descriptorPrefix)&&/^[0-9]+$/u.test(sourceRoot.slice(descriptorPrefix.length));
   let heldRoot:string;
   if(process.platform==='linux'){
    if((await fs.statfs('/proc/self/fd')).type!==0x9fa0)throw Object.assign(Error('Package export requires qualified procfs descriptor authority'),{statusCode:503});
    const before=descriptorRoot?await fs.stat(sourceRoot,{bigint:true}):await fs.lstat(sourceRoot,{bigint:true});
    if(!before.isDirectory()||!descriptorRoot&&before.isSymbolicLink())throw Error('Package export requires its original data directory');
    const real=await fs.realpath(sourceRoot);
    if(!descriptorRoot&&real!==path.resolve(sourceRoot))throw Error('Package export requires its canonical data directory');
    const rootHandle=await fs.open(descriptorRoot?sourceRoot+'/.':sourceRoot,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try{
     const held=await rootHandle.stat({bigint:true}),current=descriptorRoot?await fs.stat(sourceRoot,{bigint:true}):await fs.lstat(sourceRoot,{bigint:true}),procPath='/proc/self/fd/'+rootHandle.fd,proc=await fs.stat(procPath,{bigint:true});
     if(!held.isDirectory()||held.dev!==before.dev||held.ino!==before.ino||current.dev!==held.dev||current.ino!==held.ino||!current.isDirectory()||!descriptorRoot&&current.isSymbolicLink()||proc.dev!==held.dev||proc.ino!==held.ino)throw Error('Package export data-root custody changed');
     this.rootHandle=rootHandle;this.rootNamed=sourceRoot;this.rootIdentity={device:held.dev.toString(),inode:held.ino.toString(),descriptor:descriptorRoot};heldRoot=procPath;
     this.displayDirectory=path.join(real,'package-export-downloads');
    }catch(error){await rootHandle.close();throw error;}
   }else{
    // A portable virtual path must already be backed by the native registry.
    // Never create a staging directory through an unqualified pathname.
    if(!hasRetainedStorageAuthority(sourceRoot))throw Object.assign(Error('Package export requires a live native data-directory authority before staging'),{statusCode:503});
    heldRoot=sourceRoot;this.displayDirectory='the Ponderosa data directory’s package-export-downloads folder';
   }
   const directory=path.join(heldRoot,'package-export-downloads');await this.assertDirectory();
   try{await fs.mkdir(directory,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
   const stat=await fs.lstat(directory,{bigint:true});
   if(!stat.isDirectory()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077n)!==0n))throw Error('Package export staging must retain its private directory');
   this.directoryNamed=directory;this.directoryIdentity={device:stat.dev.toString(),inode:stat.ino.toString()};
   if(process.platform==='linux'){
    const handle=await fs.open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try{
     const held=await handle.stat({bigint:true}),current=await fs.lstat(directory,{bigint:true}),heldPath='/proc/self/fd/'+handle.fd,proc=await fs.stat(heldPath,{bigint:true});
     if(!held.isDirectory()||held.dev!==stat.dev||held.ino!==stat.ino||current.dev!==stat.dev||current.ino!==stat.ino||!current.isDirectory()||current.isSymbolicLink()||proc.dev!==held.dev||proc.ino!==held.ino)throw Error('Package export staging custody changed during allocation');
     this.directoryHandle=handle;await this.assertDirectory();return heldPath;
    }catch(error){await handle.close();this.directoryHandle=undefined;throw error;}
   }
   // The native layer derives and registers a held child root from the already
   // registered parent. Share its exclusive lease across same-process services.
   const key=stat.dev.toString()+':'+stat.ino.toString();
   let entry=portableStagingLeases.get(key);
   if(!entry){
    const authority=Promise.resolve().then(()=>new DataDirectoryAuthority(directory));
    entry={authority,refs:0};portableStagingLeases.set(key,entry);
   }
   entry.refs++;this.portableLease={key,entry};
   try{
    const authority=await entry.authority,owned=authority.rootPath,held=await fs.lstat(owned,{bigint:true});
    if(!held.isDirectory()||held.isSymbolicLink()||held.dev!==stat.dev||held.ino!==stat.ino)throw Error('Package export staging child authority changed');
    await this.assertDirectory();return owned;
   }catch(error){await this.releasePortableLease().catch(()=>undefined);throw error;}
  })();
  const directory=await this.directory;if(!this.dataDir)return;
  const names=await fs.readdir(directory),recognized=new Set<string>();
  // A normal service owns at most 16 tickets and matching request claims. Crash remnants stay held;
  // no unbounded manifest read or source recapture is admitted to resolve them.
  if(names.length>64){this.held=16;this.bytes=AGENT_PACKAGE_STAGING_MAX_BYTES;return;}
  for(const name of names){
   if(!/^[a-f0-9]{48}\.json$/u.test(name))continue;
   const manifestPath=path.join(directory,name);let handle;
   try{
    handle=await openPortableRegular(manifestPath);const before=await handle.stat({bigint:true});
    if(!before.isFile()||before.nlink!==1n||before.size>8192n)throw Error('Unconfirmed export manifest');
    const value=await this.readManifest(handle,manifestPath,before) as Manifest,token=name.slice(0,-5);
    if(value.schema!=='ponderosa.package-export-ticket.v1'||value.token!==token||!tokenPattern.test(token)||typeof value.filename!=='string'||!/^[A-Za-z0-9._-]{1,160}$/u.test(value.filename)||!Number.isSafeInteger(value.bytes)||value.bytes<0||value.bytes>AGENT_PACKAGE_MAX_BYTES||!Number.isSafeInteger(value.createdAt)||!Number.isSafeInteger(value.expiresAt)||value.expiresAt-value.createdAt!==PACKAGE_EXPORT_TICKET_LIFETIME_MS||value.createdAt>Date.now()||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/u.test(value.sha256)||typeof value.device!=='string'||typeof value.inode!=='string')throw Error('Unconfirmed export manifest');
    if((value.requestKey!==undefined||value.selectionHash!==undefined)&&(!(typeof value.requestKey==='string'&&/^[A-Za-z0-9-]{8,128}$/u.test(value.requestKey))||typeof value.selectionHash!=='string'||!/^[a-f0-9]{64}$/u.test(value.selectionHash)))throw Error('Unconfirmed export request linkage');
    if(this.tickets.size>=16||this.bytes+value.bytes+Number(before.size)>AGENT_PACKAGE_STAGING_MAX_BYTES)throw Error('Retained export staging exceeds admission');
    const pathname=path.join(directory,token+'.bytes'),payload=await openPortableRegular(pathname);
    try{
     const stat=await payload.stat({bigint:true});if(!stat.isFile()||stat.nlink!==1n||stat.size!==BigInt(value.bytes)||stat.dev.toString()!==value.device||stat.ino.toString()!==value.inode)throw Error('Export original differs from its manifest');
     const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let position=0;
     while(position<value.bytes){const read=await payload.read(buffer,0,Math.min(buffer.length,value.bytes-position),position);if(!read.bytesRead)break;hash.update(buffer.subarray(0,read.bytesRead));position+=read.bytesRead;}
     if(position!==value.bytes||(await payload.read(buffer,0,1,position)).bytesRead)throw Error('Export original exceeds or differs from its exact byte bound');
     const after=await payload.stat({bigint:true});if(hash.digest('hex')!==value.sha256||stat.size!==after.size||stat.mtimeNs!==after.mtimeNs||stat.ctimeNs!==after.ctimeNs)throw Error('Export original changed during readback');
     const ticket:Ticket={pathname,filename:value.filename,bytes:value.bytes,expiresAt:value.expiresAt,device:value.device,inode:value.inode,mtimeNs:stat.mtimeNs.toString(),ctimeNs:stat.ctimeNs.toString(),readers:0,manifest:manifestPath,manifestIdentity:{device:before.dev.toString(),inode:before.ino.toString()},...(value.requestKey?{requestKey:value.requestKey,selectionHash:value.selectionHash}:{}),timer:undefined!};
     this.bytes+=ticket.bytes+Number(before.size);this.tickets.set(token,ticket);recognized.add(name);recognized.add(token+'.bytes');this.schedule(token,ticket);
     if(value.requestKey&&!this.requests.has(value.requestKey))this.requests.set(value.requestKey,{key:value.requestKey,selectionHash:value.selectionHash!,createdAt:value.createdAt,phase:'preparing'});
    }finally{await payload.close();}
   }catch{/* Preserve unconfirmed or unrelated entries without granting a ticket. */}
   finally{await handle?.close();}
  }
  for(const name of names){
   if(!/^request-[a-f0-9]{64}\.json$/u.test(name))continue;let handle;
   try{
    handle=await openPortableRegular(path.join(directory,name));const stat=await handle.stat({bigint:true});if(!stat.isFile()||stat.nlink!==1n||stat.size>8192n)throw Error('Unconfirmed preparation record');
    const record=await this.readManifest(handle,path.join(directory,name),stat) as {schema:string;key:string;selectionHash:string;createdAt:number};
    if(record.schema!=='ponderosa.package-export-request.v1'||typeof record.key!=='string'||!/^[A-Za-z0-9-]{8,128}$/u.test(record.key)||name!=='request-'+createHash('sha256').update(record.key).digest('hex')+'.json'||typeof record.selectionHash!=='string'||!/^[a-f0-9]{64}$/u.test(record.selectionHash)||!Number.isSafeInteger(record.createdAt)||record.createdAt>Date.now())throw Error('Unconfirmed preparation record');
    const prior=this.requests.get(record.key),matching=[...this.tickets].filter(([,ticket])=>ticket.requestKey===record.key);
    if(prior&&prior.selectionHash!==record.selectionHash||matching.some(([,ticket])=>ticket.selectionHash!==record.selectionHash)||matching.length>1)throw Error('Conflicting preparation identity');
    this.reserveBytes(Number(stat.size));
    if(!prior){this.requests.set(record.key,{key:record.key,selectionHash:record.selectionHash,createdAt:record.createdAt,phase:'preparing',identity:{device:stat.dev.toString(),inode:stat.ino.toString()}});this.held++;}
    else {prior.identity={device:stat.dev.toString(),inode:stat.ino.toString()};if(matching.length===1){prior.phase='completed';prior.token=matching[0]![0];}}
    recognized.add(name);
   }catch{/* Unknown preparation is preserved without permission to recapture. */}finally{await handle?.close();}
  }
  for(const name of names)if(!recognized.has(name)){
   this.held++;try{const stat=await fs.lstat(path.join(directory,name));this.bytes=Math.min(AGENT_PACKAGE_STAGING_MAX_BYTES,this.bytes+Math.max(0,stat.size));}catch{this.held=16;}
  }
 }
 private async remove(token:string,ticket:Ticket):Promise<void>{
  if(this.closed||ticket.readers||this.tickets.get(token)!==ticket)return;
  // No currently qualified primitive can conditionally unlink the exact inode
  // if another same-user writer swaps the name. Retain and charge the ticket.
  clearTimeout(ticket.timer);ticket.removing=true;
 }
 private async stream(ticket:Ticket,reply:FastifyReply,attachment=true):Promise<unknown>{
  ticket.readers++;let handle;
  try{
   handle=await openPortableRegular(ticket.pathname);const stat=await handle.stat({bigint:true});
   if(!stat.isFile()||stat.nlink!==1n||stat.dev.toString()!==ticket.device||stat.ino.toString()!==ticket.inode||stat.size!==BigInt(ticket.bytes)||stat.mtimeNs.toString()!==ticket.mtimeNs||stat.ctimeNs.toString()!==ticket.ctimeNs)throw Error('Package download original changed; preserve its manifest for review.');
   const stream=createReadStream(ticket.pathname,{fd:handle.fd,autoClose:false}),retained=handle;handle=undefined;
   // Use Node's stream with this exact already-verified descriptor. The native
   // path wrapper opens a new descriptor; the retained handle closes its own
   // storage boundary after the last byte, cancellation or read error.
   let released=false;const release=()=>{if(released)return;released=true;void retained.close().finally(()=>{ticket.readers--;if(ticket.expiresAt<=Date.now()){const token=[...this.tickets].find(([,entry])=>entry===ticket)?.[0];if(token)void this.remove(token,ticket);}}).catch(()=>undefined);};
   stream.once('end',release);stream.once('error',release);stream.once('close',release);
   reply.raw.once('close',()=>stream.destroy());
   if(attachment)reply.header('content-disposition',`attachment; filename="${ticket.filename}"`);
   return reply.header('cache-control','private, no-store').header('content-length',ticket.bytes).type('application/json; charset=utf-8').send(stream);
  }catch(error){ticket.readers--;await handle?.close();throw error;}
 }
 async send(value:unknown,filename:string,reply:FastifyReply,download=false,attachment=false):Promise<unknown>{
  const request=this.activeRequests.get(reply);
  if(!download){
   if(this.closed)throw Object.assign(Error('Package export service is closed'),{statusCode:503});
   if(request)request.serializing=true;
   const stream=Readable.from(portablePackageJsonChunks(value));reply.raw.once('close',()=>stream.destroy());
   if(attachment)reply.header('content-disposition','attachment; filename="'+(filename.replace(/[^A-Za-z0-9._-]/g,'_').slice(0,160)||'package.ponderosa.json')+'"');
   return reply.header('cache-control','private, no-store').type('application/json; charset=utf-8').send(stream);
  }
  await this.ready();
  if(this.closed||this.pending+this.tickets.size+this.held-(request?1:0)>=16)throw this.capacityError();
  if(request)request.serializing=true;this.pending++;
  let pathname:string|undefined,manifestPath:string|undefined,charged=0,manifestIdentity:{device:string;inode:string}|undefined;
  try{
   const token=randomBytes(24).toString('hex'),directory=await this.directory!;pathname=path.join(directory,token+'.bytes');
   const handle=await fs.open(pathname,'wx+',0o600),hash=createHash('sha256');
   const identity=await(async()=>{try{
    const allocated=await handle.stat({bigint:true});if(!allocated.isFile()||allocated.nlink!==1n)throw Error('Package export allocation is not an exclusive regular file');
    for await(const chunk of portablePackageJsonChunks(value)){const data=Buffer.from(chunk,'utf8');this.reserveBytes(data.length);charged+=data.length;hash.update(data);await handle.writeFile(data);}
    await handle.sync();const before=await handle.stat({bigint:true});
    if(!before.isFile()||before.nlink!==1n||before.dev!==allocated.dev||before.ino!==allocated.ino||before.size!==BigInt(charged))throw Error('Package export changed during serialization');
    const readback=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let position=0;
    while(position<charged){const read=await handle.read(buffer,0,Math.min(buffer.length,charged-position),position);if(!read.bytesRead)break;readback.update(buffer.subarray(0,read.bytesRead));position+=read.bytesRead;}
    const after=await handle.stat({bigint:true}),named=await fs.lstat(pathname!,{bigint:true});
    if(position!==charged||readback.digest('hex')!==hash.copy().digest('hex')||!after.isFile()||!named.isFile()||after.nlink!==1n||named.nlink!==1n||after.dev!==before.dev||after.ino!==before.ino||named.dev!==before.dev||named.ino!==before.ino||after.size!==before.size||named.size!==before.size||after.mtimeNs!==before.mtimeNs||named.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs||named.ctimeNs!==before.ctimeNs)throw Error('Package export changed during readback');
    return after;
   }finally{await handle.close();}})();
   const createdAt=Date.now(),expiresAt=createdAt+PACKAGE_EXPORT_TICKET_LIFETIME_MS;
   const ticket:Ticket={pathname,filename:filename.replace(/[^A-Za-z0-9._-]/g,'_').slice(0,160)||'package.ponderosa.json',bytes:charged,expiresAt,device:identity.dev.toString(),inode:identity.ino.toString(),mtimeNs:identity.mtimeNs.toString(),ctimeNs:identity.ctimeNs.toString(),readers:0,...(request?{requestKey:request.key,selectionHash:request.selectionHash}:{}),timer:undefined!};
   if(download&&this.dataDir){
    const manifest:Manifest={schema:'ponderosa.package-export-ticket.v1',token,filename:ticket.filename,bytes:ticket.bytes,sha256:hash.digest('hex'),createdAt,expiresAt,device:ticket.device,inode:ticket.inode,...(request?{requestKey:request.key,selectionHash:request.selectionHash}:{})};
    manifestPath=path.join(directory,token+'.json');const manifestBytes=Buffer.from(JSON.stringify(manifest));this.reserveBytes(manifestBytes.length);const file=await fs.open(manifestPath,'wx',0o600);
    try{const stat=await file.stat({bigint:true});manifestIdentity={device:stat.dev.toString(),inode:stat.ino.toString()};await file.writeFile(manifestBytes);await file.sync();}finally{await file.close();}await this.syncDirectory();ticket.manifest=manifestPath;ticket.manifestIdentity=manifestIdentity;
   }
   await this.assertDirectory();this.schedule(token,ticket);this.tickets.set(token,ticket);if(request){request.phase='completed';request.token=token;this.held--;}pathname=undefined;manifestPath=undefined;charged=0;
   return reply.header('cache-control','private, no-store').send(this.descriptor(token,ticket));
  }catch(error){
   // Every allocated or uncertain name remains charged and untouched. A
   // concurrent writer may swap it after any pathname identity observation.
   if(pathname){if(!request)this.held++;this.bytes=AGENT_PACKAGE_STAGING_MAX_BYTES;if(error instanceof Error)error.message+='; partial or uncertain export staging was retained at '+(this.displayDirectory??'the local package-export-downloads folder');}
   else this.bytes-=charged;
   throw error;
  }finally{this.pending--;}
 }
}
export function packageExportDownloads(app:FastifyInstance,dataDir?:string):PackageExportDownloads{let service=services.get(app);if(!service){service=new PackageExportDownloads(app,dataDir);services.set(app,service);}return service;}
