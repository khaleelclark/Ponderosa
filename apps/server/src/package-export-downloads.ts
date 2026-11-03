import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createReadStream,promises as fs} from '@ponderosa/native-host/fs';
import type {FastifyInstance,FastifyReply} from 'fastify';
import {AGENT_PACKAGE_STAGING_MAX_BYTES} from '@ponderosa/core';
import {portablePackageJsonChunks} from './agent-package-codec.js';

export const PACKAGE_EXPORT_TICKET_LIFETIME_MS=15*60_000;
export interface PackageExportDownload {downloadUrl:string;expiresAt:string;byteLength:number}
type Ticket={pathname:string;filename:string;bytes:number;expiresAt:number;readers:number;removing?:boolean;timer:ReturnType<typeof setTimeout>};
const services=new WeakMap<FastifyInstance,PackageExportDownloads>();
/** Shared Agent/Branch staging: no whole serialized package string or browser Blob. */
export class PackageExportDownloads{
 private directory?:Promise<string>;private bytes=0;private pending=0;private tickets=new Map<string,Ticket>();private closed=false;
 constructor(app:FastifyInstance){
  app.get<{Params:{token:string}}>('/api/package-exports/:token',{config:{agentPackageOperation:true}},async(request,reply)=>{
   const ticket=this.tickets.get(request.params.token);
   if(!ticket||ticket.expiresAt<=Date.now())return reply.code(410).send({error:'Package download expired. Prepare a new export.'});
   return this.stream(ticket,reply);
  });
  app.addHook('onClose',async()=>{this.closed=true;for(const ticket of this.tickets.values())clearTimeout(ticket.timer);this.tickets.clear();if(this.directory)await fs.rm(await this.directory,{recursive:true,force:true});});
 }
 private async remove(token:string,ticket:Ticket):Promise<void>{
  if(ticket.readers||ticket.removing||this.tickets.get(token)!==ticket)return;ticket.removing=true;
  try{await fs.unlink(ticket.pathname);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){ticket.removing=false;ticket.timer=setTimeout(()=>{void this.remove(token,ticket);},60_000);ticket.timer.unref();return;}}
  if(this.tickets.get(token)===ticket)this.tickets.delete(token);this.bytes-=ticket.bytes;
 }
 private stream(ticket:Ticket,reply:FastifyReply,attachment=true){
  ticket.readers++;
  const stream=createReadStream(ticket.pathname);
  stream.once('close',()=>{ticket.readers--;if(ticket.expiresAt<=Date.now()){const token=[...this.tickets].find(([,entry])=>entry===ticket)?.[0];if(token)void this.remove(token,ticket);}});
  reply.raw.once('close',()=>stream.destroy());
  if(attachment)reply.header('content-disposition',`attachment; filename="${ticket.filename}"`);
  return reply.header('cache-control','private, no-store').header('content-length',ticket.bytes).type('application/json; charset=utf-8').send(stream);
 }
 async send(value:unknown,filename:string,reply:FastifyReply,download=false,attachment=false):Promise<unknown>{
  if(this.closed||this.pending+this.tickets.size>=16)throw Object.assign(Error('Package export staging is busy; retry after an existing download expires.'),{statusCode:503});
  this.pending++;
  let pathname:string|undefined,charged=0;
  try{
   this.directory??=fs.mkdtemp(path.join(tmpdir(),'ponderosa-package-export-')).catch(error=>{this.directory=undefined;throw error;});
   pathname=path.join(await this.directory,randomBytes(24).toString('hex'));
   const handle=await fs.open(pathname,'wx',0o600);
   try{for await(const chunk of portablePackageJsonChunks(value)){const data=Buffer.from(chunk,'utf8');if(this.bytes+data.length>AGENT_PACKAGE_STAGING_MAX_BYTES)throw Object.assign(Error('Package export staging capacity is full; retry after an existing download expires.'),{statusCode:503});this.bytes+=data.length;charged+=data.length;await handle.writeFile(data);}await handle.sync();}finally{await handle.close();}
   const token=randomBytes(24).toString('hex'),expiresAt=Date.now()+PACKAGE_EXPORT_TICKET_LIFETIME_MS;
   const ticket:Ticket={pathname,filename:filename.replace(/[^A-Za-z0-9._-]/g,'_').slice(0,160)||'package.ponderosa.json',bytes:charged,expiresAt,readers:0,timer:undefined!};
   ticket.timer=setTimeout(()=>{void this.remove(token,ticket);},PACKAGE_EXPORT_TICKET_LIFETIME_MS);ticket.timer.unref();this.tickets.set(token,ticket);
   pathname=undefined;charged=0;
   if(download)return reply.header('cache-control','private, no-store').send({downloadUrl:'/api/package-exports/'+token,expiresAt:new Date(expiresAt).toISOString(),byteLength:ticket.bytes} satisfies PackageExportDownload);
   // Direct responses need no retry ticket: they release their bytes on stream close.
   clearTimeout(ticket.timer);ticket.expiresAt=0;return this.stream(ticket,reply,attachment);
  }catch(error){
   if(pathname){
    try{await fs.unlink(pathname);this.bytes-=charged;}catch(cleanup){
     if((cleanup as NodeJS.ErrnoException).code==='ENOENT')this.bytes-=charged;
     else{const token=randomBytes(24).toString('hex'),ticket:Ticket={pathname,filename:'incomplete',bytes:charged,expiresAt:0,readers:0,timer:undefined!};ticket.timer=setTimeout(()=>{void this.remove(token,ticket);},60_000);ticket.timer.unref();this.tickets.set(token,ticket);}
    }
   }else this.bytes-=charged;
   throw error;
  }
  finally{this.pending--;}
 }
}
export function packageExportDownloads(app:FastifyInstance):PackageExportDownloads{let service=services.get(app);if(!service){service=new PackageExportDownloads(app);services.set(app,service);}return service;}
