import {createHash,randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import type Database from 'better-sqlite3';
import type {FastifyInstance,FastifyReply} from 'fastify';
import {AGENT_PACKAGE_MAX_BYTES,AGENT_PACKAGE_STAGING_MAX_BYTES} from '@ponderosa/core';
import {stableJson} from '@ponderosa/agents';
import {portablePackageJsonChunks} from './agent-package-codec.js';
import type {PackageExportDownloads,PackageExportDownload} from './package-export-downloads.js';

const LIFETIME=15*60_000, CHUNK=1024*1024, MAX_ACTIVE=16, MAX_CLAIMS=1_000_000;
const MAX_CHUNKS=Math.floor(AGENT_PACKAGE_STAGING_MAX_BYTES/CHUNK);
const tokenPattern=/^[a-f0-9]{48}$/u,hashPattern=/^[a-f0-9]{64}$/u;
type Claim={request_key:string;selection_hash:string;created_at:number;status:'preparing'|'completed'|'expired';response_kind:'json'|'download'|null;ticket_token:string|null};
type Ticket={token:string;claim_key:string|null;filename:string;created_at:number;expires_at:number;status:'writing'|'verifying'|'completed'|'removing';bytes:number;chunk_count:number;sha256:string|null};
type Chunk={ordinal:number;slot:number;length:number;sha256:string};
export interface ExportPool {
 size():number;
 allocatedBytes():number;
 read(offset:number,length:number):Buffer;
 write(offset:number,bytes:Buffer):void;
 sync():void;
 assert():void;
 close():void;
}
function readChunk(pool:ExportPool,row:Chunk|undefined):Buffer {
 if(!row||!Number.isSafeInteger(row.slot)||row.slot<0||row.slot>=MAX_CHUNKS||!Number.isSafeInteger(row.length)||row.length<1||row.length>CHUNK||!hashPattern.test(row.sha256))throw error('Stored export slot metadata differs; retained without replay.',409);
 const bytes=pool.read(row.slot*CHUNK,row.length);
 if(!Buffer.isBuffer(bytes)||bytes.length!==row.length||createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw error('Stored export bytes differ; retained without replay.',409);
 return bytes;
}
type Active={key:string;selectionHash:string;serializing:boolean};
const error=(message:string,statusCode:number)=>Object.assign(new Error(message),{statusCode});
const filename=(value:string)=>value.replace(/[^A-Za-z0-9._-]/g,'_').slice(0,160)||'package.ponderosa.json';

/** Durable bounded export bytes live in the already-admitted canonical SQLite
 * authority. Unknown claims, writes and reader leases remain held. */
export class SqlitePackageExportDownloads {
 private closed=false;
 private readonly active=new WeakMap<FastifyReply,Active>();
 constructor(app:FastifyInstance,private readonly db:Database.Database,private readonly legacy:PackageExportDownloads,private readonly pool:ExportPool){
  // The exact current schema is admitted/migrated before this service exists.
  // Never create tables at runtime or adopt an unverified independent DB.
  for(const table of ['package_export_pool','package_export_claims','package_export_tickets','package_export_chunks','package_export_readers'])db.prepare('SELECT 1 FROM '+table+' LIMIT 0').all();
  const synchronous=db.pragma('synchronous',{simple:true}) as number;if(synchronous!==2&&synchronous!==3)throw new Error('Durable export cache requires SQLite FULL synchronous mode');
  app.get<{Params:{token:string}}>('/api/package-exports/:token',{config:{agentPackageOperation:true}},async(request,reply)=>{
   const ticket=this.ticket(request.params.token);
   if(ticket)return this.stream(ticket,reply,true);
   const old=await this.legacy.downloadExisting(request.params.token,reply);
   return old??reply.code(410).send({error:'Package download expired or is not confirmed. Prepare a new export.'});
  });
  app.get<{Params:{key:string}}>('/api/package-export-requests/:key',{config:{agentPackageOperation:true}},async(request,reply)=>{
   const claim=this.claim(request.params.key);
   if(claim){
    const ticket=claim.ticket_token&&this.ticket(claim.ticket_token);
    if(claim.status==='completed'&&ticket&&ticket.expires_at>Date.now())return reply.header('cache-control','private, no-store').send({state:'completed',...this.descriptor(ticket)});
    return reply.header('cache-control','private, no-store').send({state:'unconfirmed',error:claim.status==='expired'||ticket&&ticket.expires_at<=Date.now()?'Original export expired. Prepare a new export.':'Original export preparation is unconfirmed. Its bytes are held; retry cannot capture a replacement.'});
   }
   const old=await this.legacy.requestExisting(request.params.key,reply);
   return old??reply.code(404).send({error:'Export preparation is not recorded.'});
  });
  app.addHook('onClose',async()=>{
   // A reader is released only by its own stream terminal event. If shutdown
   // leaves its outcome unknown, retain that durable lease across restart.
   this.closed=true;this.pool.close();
  });
 }
 private claim(key:string):Claim|undefined{return this.db.prepare('SELECT * FROM package_export_claims WHERE request_key=?').get(key) as Claim|undefined;}
 private ticket(token:string):Ticket|undefined{
  if(!tokenPattern.test(token))return;
  const row=this.db.prepare("SELECT * FROM package_export_tickets WHERE token=? AND status='completed'").get(token) as Ticket|undefined;
  if(!row||!/^[A-Za-z0-9._-]{1,160}$/u.test(row.filename)||!hashPattern.test(row.sha256??'')||!Number.isSafeInteger(row.bytes)||row.bytes<0||row.bytes>AGENT_PACKAGE_MAX_BYTES||!Number.isSafeInteger(row.chunk_count)||row.chunk_count<0||row.chunk_count>MAX_CHUNKS||!Number.isSafeInteger(row.expires_at)||row.expires_at<0||row.expires_at>8_640_000_000_000_000||!Number.isSafeInteger(row.created_at)||row.created_at<0)return;
  return row;
 }
 private descriptor(row:Ticket):PackageExportDownload{return {downloadUrl:'/api/package-exports/'+row.token,expiresAt:new Date(row.expires_at).toISOString(),byteLength:row.bytes};}
 private reclaim():void{
  const expired=this.db.prepare("SELECT token,claim_key FROM package_export_tickets t WHERE status='completed' AND expires_at<=? AND NOT EXISTS(SELECT 1 FROM package_export_readers r WHERE r.token=t.token) ORDER BY expires_at LIMIT 16").all(Date.now()) as Array<{token:string;claim_key:string|null}>;
  for(const row of expired){
   // The rows and only those rows are app-owned cache, never a pathname.
   const changed=this.db.prepare("UPDATE package_export_tickets SET status='removing' WHERE token=? AND status='completed' AND NOT EXISTS(SELECT 1 FROM package_export_readers WHERE token=?)").run(row.token,row.token);
   if(changed.changes!==1)throw error('Export cleanup identity changed; records remain held.',409);
   if(row.claim_key)this.db.prepare("UPDATE package_export_claims SET status='expired',ticket_token=NULL WHERE request_key=? AND ticket_token=? AND status='completed'").run(row.claim_key,row.token);
   this.db.prepare('DELETE FROM package_export_chunks WHERE token=?').run(row.token);
   this.db.prepare("DELETE FROM package_export_tickets WHERE token=? AND status='removing'").run(row.token);
  }
 }
 private usage():{slots:number;bytes:number;claims:number}{
  const count=(this.db.prepare('SELECT count(*) n FROM (SELECT 1 FROM package_export_chunks LIMIT ?)').get(MAX_CHUNKS+1) as {n:number}).n;
  if(count>MAX_CHUNKS)throw error('Export cache chunk accounting exceeds its bound; retained records are held.',503);
  const row=this.db.prepare("SELECT (SELECT count(*) FROM package_export_tickets) + (SELECT count(*) FROM package_export_claims WHERE status='preparing' AND ticket_token IS NULL) AS slots, coalesce((SELECT sum(bytes) FROM package_export_tickets),0) AS bytes, (SELECT count(*) FROM package_export_claims) AS claims, coalesce((SELECT sum(length) FROM package_export_chunks),0) AS chunkBytes").get() as {slots:number;bytes:number;claims:number;chunkBytes:number};
  if(![row.slots,row.bytes,row.claims,row.chunkBytes].every(Number.isSafeInteger)||row.slots<0||row.bytes<0||row.claims<0||row.chunkBytes!==row.bytes)throw error('Export cache accounting is unavailable; retained records are held.',503);
  return row;
 }
 private walHeadroom():void{
  // Completed rows can be reclaimed logically, but a pinned reader can keep
  // SQLite WAL pages alive. Refuse before our next batch if outstanding WAL
  // already consumes the bounded staging budget. Other app data is never deleted.
  // Reserve a GiB for the application and at least 64 MiB for the next
  // 16 MiB batch, allowing for database and WAL amplification. This is an
  // observation, not a reservation against unrelated concurrent writers.
  if(this.legacy.availableExportBytes(this.db.name)<BigInt(1024+64)*1024n*1024n)throw error('Export storage has insufficient free space; retained data was preserved.',503);
  const page=this.db.pragma('page_size',{simple:true}) as number;
  const rows=this.db.pragma('wal_checkpoint(PASSIVE)') as Array<{busy:number;log:number;checkpointed:number}>;
  const state=rows[0];if(!state||state.log<0)return; // memory/rollback DB has no WAL
  const outstanding=Math.max(0,state.log-state.checkpointed)*page;
  if(!Number.isSafeInteger(outstanding)||outstanding>AGENT_PACKAGE_STAGING_MAX_BYTES-16*CHUNK)throw error('Export cache WAL is full or held by another reader; close the reader and retry with a new export.',503);
 }
 private capacity(legacy:{slots:number;bytes:number},extraSlots:number,extraBytes:number,checkClaims=false,newHighWater=0):void{
  const current=this.usage();
  const marker=this.db.prepare("SELECT high_water FROM package_export_pool WHERE singleton=1 AND state='ready'").get() as {high_water:number}|undefined;
  const size=this.pool.size(),allocated=this.pool.allocatedBytes();
  if(!marker||!Number.isSafeInteger(marker.high_water)||marker.high_water<0||marker.high_water>AGENT_PACKAGE_STAGING_MAX_BYTES||!Number.isSafeInteger(size)||size<0||size>AGENT_PACKAGE_STAGING_MAX_BYTES||size>marker.high_water||!Number.isSafeInteger(allocated)||allocated<0)throw error('Export pool accounting is unknown; retained records remain held.',503);
  const charged=Math.max(marker.high_water,Math.ceil(size/CHUNK)*CHUNK,Math.ceil(allocated/CHUNK)*CHUNK,newHighWater,current.bytes+extraBytes);
  if(current.slots+legacy.slots+extraSlots>MAX_ACTIVE||charged+legacy.bytes>AGENT_PACKAGE_STAGING_MAX_BYTES||checkClaims&&current.claims>=MAX_CLAIMS)
   throw error('Export capacity is full or retained for an unconfirmed operation; review the package-export staging records before preparing another export.',503);
 }
 private transaction<T>(fn:()=>T):T{return this.db.transaction(fn).immediate();}
 async prepare(key:unknown,identity:unknown,reply:FastifyReply,work:()=>Promise<unknown>):Promise<unknown>{
  if(key===undefined)return work();
  if(typeof key!=='string'||!/^[A-Za-z0-9-]{8,128}$/u.test(key))throw error('Invalid export request identity',400);
  const selectionHash=createHash('sha256').update(stableJson(identity)).digest('hex');
  const old=await this.legacy.lookupRequest(key);
  if(old){
   if(old.selectionHash!==selectionHash)throw error('Original export request choices differ; prepare a new explicit export.',409);
   if(old.ticket&&Date.parse(old.ticket.expiresAt)>Date.now())return reply.header('cache-control','private, no-store').send(old.ticket);
   throw error('Original export preparation is unconfirmed or expired. Its bytes are held; retry cannot capture a replacement.',409);
  }
  const retained=await this.legacy.retainedUsage();
  this.pool.assert();
  let previous:Claim|undefined;
  this.transaction(()=>{
   this.reclaim();previous=this.claim(key);
   if(previous){if(previous.selection_hash!==selectionHash)throw error('Original export request choices differ; prepare a new explicit export.',409);return;}
   if(this.closed)throw error('Package export service is closed',503);
   this.capacity(retained,1,0,true);
   this.db.prepare("INSERT INTO package_export_claims(request_key,selection_hash,created_at,status) VALUES(?,?,?,'preparing')").run(key,selectionHash,Date.now());
  });
  if(previous){
   const ticket=previous.ticket_token&&this.ticket(previous.ticket_token);
   if(previous.status==='completed'&&ticket&&ticket.expires_at>Date.now()){
    if(previous.response_kind==='json')return this.stream(ticket,reply,false);
    return reply.header('cache-control','private, no-store').send(this.descriptor(ticket));
   }
   throw error('Original export preparation is unconfirmed or expired. Its bytes are held; retry cannot capture a replacement.',409);
  }
  const active={key,selectionHash,serializing:false};this.active.set(reply,active);
  try{
   const result=await work();
   if(!active.serializing&&reply.statusCode>=400)this.db.prepare("DELETE FROM package_export_claims WHERE request_key=? AND selection_hash=? AND status='preparing' AND ticket_token IS NULL").run(key,selectionHash);
   return result;
  }catch(failure){
   if(!active.serializing)try{this.db.prepare("DELETE FROM package_export_claims WHERE request_key=? AND selection_hash=? AND status='preparing' AND ticket_token IS NULL").run(key,selectionHash);}catch{/* Preserve unknown claim. */}
   throw failure;
  }finally{this.active.delete(reply);}
 }
 async send(value:unknown,name:string,reply:FastifyReply,download=false,attachment=false):Promise<unknown>{
  const request=this.active.get(reply);
  if(!download&&!request){
   if(this.closed)throw error('Package export service is closed',503);
   // Preflight the exact serializer without buffering the package, before headers.
   for await(const _chunk of portablePackageJsonChunks(value)){/* byte bound is checked by the serializer */}
   const stream=Readable.from(portablePackageJsonChunks(value));reply.raw.once('close',()=>stream.destroy());
   if(attachment)reply.header('content-disposition','attachment; filename="'+filename(name)+'"');
   return reply.header('cache-control','private, no-store').type('application/json; charset=utf-8').send(stream);
  }
  const retained=await this.legacy.retainedUsage(),token=randomBytes(24).toString('hex'),createdAt=Date.now(),kind=download?'download':'json';
  this.pool.assert();this.walHeadroom();
  this.transaction(()=>{
   this.reclaim();if(this.closed)throw error('Package export service is closed',503);
   this.capacity(retained,request?0:1,0);
   if(request){
    const claim=this.claim(request.key);
    if(!claim||claim.status!=='preparing'||claim.selection_hash!==request.selectionHash||claim.ticket_token)throw error('Original export claim changed; preserve its records.',409);
   }
   this.db.prepare("INSERT INTO package_export_tickets(token,claim_key,filename,created_at,expires_at,status,bytes,chunk_count) VALUES(?,?,?,?,0,'writing',0,0)").run(token,request?.key??null,filename(name),createdAt);
   if(request)this.db.prepare('UPDATE package_export_claims SET ticket_token=?,response_kind=? WHERE request_key=?').run(token,kind,request.key);
  });
  if(request)request.serializing=true;
  const totalHash=createHash('sha256');let size=0,ordinal=0,pieces:Buffer[]=[],pending=0;
  const flush=()=>{
   if(!pending)return;
   const bytes=Buffer.concat(pieces,pending),digest=createHash('sha256').update(bytes).digest('hex');
   if(size+bytes.length>AGENT_PACKAGE_MAX_BYTES)throw error('Package export exceeds its byte limit.',413);
   if(ordinal%16===0)this.walHeadroom();
   let slot=0;
   this.transaction(()=>{
    const ticket=this.db.prepare("SELECT bytes,chunk_count FROM package_export_tickets WHERE token=? AND status='writing'").get(token) as {bytes:number;chunk_count:number}|undefined;
    if(!ticket||ticket.bytes!==size||ticket.chunk_count!==ordinal)throw error('Export capture identity changed; partial bytes remain held.',409);
    const occupied=this.db.prepare('SELECT slot FROM package_export_chunks ORDER BY slot').all() as Array<{slot:number}>;
    for(const item of occupied){if(!Number.isSafeInteger(item.slot)||item.slot<slot||item.slot>=MAX_CHUNKS)throw error('Export slot accounting is invalid; records remain held.',503);if(item.slot===slot)slot++;}
    if(slot>=MAX_CHUNKS)throw error('Export slot capacity is full; retained records remain held.',503);
    const highWater=(slot+1)*CHUNK;
    this.capacity(retained,0,bytes.length,false,highWater);
    this.db.prepare("UPDATE package_export_pool SET high_water=max(high_water,?) WHERE singleton=1 AND state='ready'").run(highWater);
    // Reserve and charge the extent durably before touching its bytes.
    this.db.prepare('INSERT INTO package_export_chunks(token,ordinal,slot,length,sha256) VALUES(?,?,?,?,?)').run(token,ordinal,slot,bytes.length,digest);
    this.db.prepare('UPDATE package_export_tickets SET bytes=?,chunk_count=? WHERE token=?').run(size+bytes.length,ordinal+1,token);
   });
   this.pool.assert();this.pool.write(slot*CHUNK,bytes);this.pool.sync();this.pool.assert();
   totalHash.update(bytes);size+=bytes.length;ordinal++;pieces=[];pending=0;
  };
  try{
   for await(const text of portablePackageJsonChunks(value)){
    const bytes=Buffer.from(text,'utf8');let offset=0;
    while(offset<bytes.length){const length=Math.min(CHUNK-pending,bytes.length-offset);pieces.push(bytes.subarray(offset,offset+length));pending+=length;offset+=length;if(pending===CHUNK)flush();}
    // Allow other requests and abort handling between bounded batches.
    if(ordinal%16===0)await new Promise<void>(resolve=>setImmediate(resolve));
   }
   flush();
   this.transaction(()=>{
    const frozen=this.db.prepare("UPDATE package_export_tickets SET status='verifying' WHERE token=? AND status='writing' AND bytes=? AND chunk_count=?").run(token,size,ordinal);
    if(frozen.changes!==1)throw error('Export capture identity changed; partial bytes remain held.',409);
   });
   const expected=totalHash.digest('hex'),readback=createHash('sha256');let observed=0;
   for(let i=0;i<ordinal;i++){
    const chunk=this.db.prepare('SELECT ordinal,slot,length,sha256 FROM package_export_chunks WHERE token=? AND ordinal=?').get(token,i) as Chunk|undefined;
    const bytes=readChunk(this.pool,chunk);observed+=bytes.length;readback.update(bytes);
    if(i%16===15)await new Promise<void>(resolve=>setImmediate(resolve));
   }
   if(observed!==size||readback.digest('hex')!==expected)throw error('Export capture digest differs; partial bytes remain held.',409);
   const expiresAt=Date.now()+LIFETIME;
   this.transaction(()=>{
    const changed=this.db.prepare("UPDATE package_export_tickets SET status='completed',sha256=?,expires_at=? WHERE token=? AND status='verifying' AND bytes=? AND chunk_count=?").run(expected,expiresAt,token,size,ordinal);
    if(changed.changes!==1)throw error('Export capture receipt changed; partial bytes remain held.',409);
    if(request){
     const completed=this.db.prepare("UPDATE package_export_claims SET status='completed' WHERE request_key=? AND selection_hash=? AND status='preparing' AND ticket_token=?").run(request.key,request.selectionHash,token);
     if(completed.changes!==1)throw error('Export claim changed; partial bytes remain held.',409);
    }
   });
   const ticket=this.ticket(token);if(!ticket)throw error('Completed export receipt is unavailable.',503);
   if(download)return reply.header('cache-control','private, no-store').send(this.descriptor(ticket));
   return this.stream(ticket,reply,attachment);
  }catch(failure){
   if(failure instanceof Error)failure.message+='; the unconfirmed export is held without replay';
   throw failure;
  }
 }
 private async stream(ticket:Ticket,reply:FastifyReply,attachment:boolean):Promise<unknown>{
  const reader=randomBytes(24).toString('hex');
  this.transaction(()=>{
   const current=this.ticket(ticket.token);
   if(!current||current.expires_at<=Date.now())throw error('Package download expired or is not confirmed. Prepare a new export.',410);
   const summary=this.db.prepare('SELECT count(*) count,coalesce(sum(length),0) bytes FROM package_export_chunks WHERE token=?').get(ticket.token) as {count:number;bytes:number};
   if(summary.count!==current.chunk_count||summary.bytes!==current.bytes)throw error('Stored export chunk inventory differs; the original remains held.',409);
   this.db.prepare('INSERT INTO package_export_readers(reader_id,token,started_at) VALUES(?,?,?)').run(reader,ticket.token,Date.now());
  });
  let released=false;
  const release=()=>{
   if(released)return;released=true;
   try{this.db.prepare('DELETE FROM package_export_readers WHERE reader_id=? AND token=?').run(reader,ticket.token);}catch{/* A durable uncertain lease is held. */}
  };
  const db=this.db;
  let disconnected=false;
  const onClose=()=>{disconnected=true;};
  reply.raw.once('close',onClose);
  try{
   const whole=createHash('sha256');let total=0;
   for(let i=0;i<ticket.chunk_count;i++){
    if(disconnected)throw error('Download connection closed before verification.',409);
    const chunk=db.prepare('SELECT ordinal,slot,length,sha256 FROM package_export_chunks WHERE token=? AND ordinal=?').get(ticket.token,i) as Chunk|undefined;
    const bytes=readChunk(this.pool,chunk);total+=bytes.length;whole.update(bytes);
    if(i%16===15)await new Promise<void>(resolve=>setImmediate(resolve));
   }
   if(disconnected||total!==ticket.bytes||whole.digest('hex')!==ticket.sha256)throw error('Stored export digest differs; the original remains held.',409);
  }catch(failure){reply.raw.off('close',onClose);release();throw failure;}
  reply.raw.off('close',onClose);
  const pool=this.pool;
  async function* bytes(){
   let total=0;const whole=createHash('sha256');
   for(let i=0;i<ticket.chunk_count;i++){
    const row=db.prepare('SELECT ordinal,slot,length,sha256 FROM package_export_chunks WHERE token=? AND ordinal=?').get(ticket.token,i) as Chunk|undefined;
    const bytes=readChunk(pool,row);total+=bytes.length;whole.update(bytes);yield bytes;
   }
   if(total!==ticket.bytes||whole.digest('hex')!==ticket.sha256)throw new Error('Stored export digest differs; the download is incomplete.');
  }
  const stream=Readable.from(bytes());stream.once('end',release);stream.once('error',release);stream.once('close',release);reply.raw.once('close',()=>stream.destroy());
  if(attachment)reply.header('content-disposition','attachment; filename="'+ticket.filename+'"');
  return reply.header('cache-control','private, no-store').header('content-length',ticket.bytes).type('application/json; charset=utf-8').send(stream);
 }
}
