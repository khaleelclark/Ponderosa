import {constants} from 'node:fs';
import {promises as fs} from '@ponderosa/native-host/fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {PortableArtifactDto} from '@ponderosa/core';
import {assertPortableSecretsAbsent} from './portable-secrets.js';

export function portableWorkingPath(value:unknown):string {
  if(typeof value!=='string'||!value||value.includes('\\')||value.includes('\0')||value.includes(':')||value.startsWith('/')||value.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Select relative regular-file paths inside the working folder');
  if(value.split('/').some(p=>['.git','.ssh','.aws','.gnupg','.codex','.claude','browser-profiles'].includes(p)||/^\.env(?:\.|$)/i.test(p)||/^(?:credentials(?:\.json)?|auth\.json|.*\.(?:pem|key|p12))$/i.test(p)))throw new Error(`Known credential/native ownership path cannot be exported: ${value}`);
  return value;
}

export function validateWorkingFileData(relative:string,data:Buffer):void {
  portableWorkingPath(relative);
  if(data.includes(Buffer.from('-----BEGIN PRIVATE KEY-----'))||data.includes(Buffer.from('-----BEGIN RSA PRIVATE KEY-----')))throw new Error(`Private key content cannot be exported: ${relative}`);
  if(!data.includes(0)){
    const text=data.toString('utf8');
    if(!text.includes('\uFFFD'))assertPortableSecretsAbsent(text,`Selected working file ${relative}`);
  }
  if(/\.json$/i.test(relative)){
    let parsed:unknown;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{throw new Error(`Selected JSON must be valid before secret-field inspection: ${relative}`);}
    assertPortableSecretsAbsent(parsed,`Selected working file ${relative}`);
  }
}

/** Explicit selection only; no implicit traversal of user folders or native profiles. */
export async function exportWorkingFiles(rootPath:string,selected:readonly string[],maxBytes:number):Promise<{files:Array<{path:string;artifactRef:string;mode?:number;mtime?:string}>;artifacts:PortableArtifactDto[];bytes:number}> {
  const root=await fs.realpath(rootPath),files:Array<{path:string;artifactRef:string;mode?:number;mtime?:string}>=[],artifacts:PortableArtifactDto[]=[];
  let bytes=0;
  if(selected.length>10000||new Set(selected).size!==selected.length)throw new Error('Select at most 10000 distinct working files');
  for(const item of selected){
    const relative=portableWorkingPath(item),parts=relative.split('/');
    let current=root;
    for(const part of parts){current=path.join(current,part);if((await fs.lstat(current)).isSymbolicLink())throw new Error(`Working-file symlinks are not portable originals: ${relative}`);}
    const handle=await fs.open(current,constants.O_RDONLY|constants.O_NOFOLLOW);
    let data:Buffer,mode:number,mtime:string;
    try{
      const before=await handle.stat({bigint:true});
      if(!before.isFile()||before.nlink!==1n||before.size>BigInt(Math.min(maxBytes-bytes,64*1024*1024)))throw new Error(`Working file is not a bounded single-link regular original: ${relative}`);
      if(await fs.realpath(path.dirname(current))!==path.dirname(current))throw new Error('Working-file directory changed during export');
      data=Buffer.alloc(Number(before.size));let offset=0;
      while(offset<data.length){const read=await handle.read(data,offset,data.length-offset,offset);if(!read.bytesRead)throw new Error(`Working file shortened during export: ${relative}`);offset+=read.bytesRead;}
      mode=Number(before.mode)&0o777;mtime=new Date(Number(before.mtimeMs)).toISOString();
      const after=await handle.stat({bigint:true});
      if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||BigInt(data.length)!==before.size)throw new Error(`Working file changed during export: ${relative}`);
    }finally{await handle.close();}
    validateWorkingFileData(relative,data);
    bytes+=data.length;if(bytes>maxBytes)throw new Error('Selected working files exceed the portable artifact limit');
    const ref=randomUUID();files.push({path:relative,artifactRef:ref,mode:mode!,mtime:mtime!});
    artifacts.push({ref,kind:'document',path:relative,summary:relative,createdAt:new Date().toISOString(),mediaType:'application/octet-stream',dataBase64:data.toString('base64')});
  }
  return {files,artifacts,bytes};
}

/** Exclusively create a new user-selected folder. Failure retains every byte for recovery. */
export async function importWorkingFiles(destination:string,files:readonly {path:string;data:Buffer;sha256:string;mode?:number;mtime?:string}[],directories:readonly {path:string;mode:number;mtime:string}[]=[],rootMetadata?:{mode:number;mtime:string}):Promise<void>{
  if(!path.isAbsolute(destination)||path.resolve(destination)!==destination)throw new Error('Choose an absolute new working-files destination');
  const parent=await fs.realpath(path.dirname(destination));
  if(parent!==path.dirname(destination))throw new Error('Working-files destination parent must be canonical');
  await fs.mkdir(destination,{mode:0o700});
  try{
    for(const folder of [...directories].sort((a,b)=>a.path.split('/').length-b.path.split('/').length)){
      const relative=portableWorkingPath(folder.path);
      const target=path.join(destination,relative);
      await fs.mkdir(target,{mode:0o700});
      if(await fs.realpath(target)!==target)throw new Error('Destination directory changed');
    }
    for(const file of files){
      const relative=portableWorkingPath(file.path),parts=relative.split('/');let dir=destination;
      for(const component of parts.slice(0,-1)){
        dir=path.join(dir,component);
        try{await fs.mkdir(dir,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
        const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(dir)!==dir)throw new Error('Working-files destination changed');
      }
      if(createHash('sha256').update(file.data).digest('hex')!==file.sha256)throw new Error('Staged working-file identity changed');
      const handle=await fs.open(path.join(destination,relative),'wx',0o600);
      try{await handle.writeFile(file.data);if(file.mode!==undefined)await handle.chmod(file.mode&0o777);if(file.mtime)await handle.utimes(new Date(file.mtime),new Date(file.mtime));await handle.sync();}finally{await handle.close();}
    }
    for(const folder of [...directories].sort((a,b)=>b.path.split('/').length-a.path.split('/').length)){
      const target=path.join(destination,portableWorkingPath(folder.path));
      if(await fs.realpath(target)!==target)throw new Error('Destination directory changed');
      await fs.chmod(target,folder.mode&0o777);await fs.utimes(target,new Date(folder.mtime),new Date(folder.mtime));
    }
    if(rootMetadata){await fs.chmod(destination,rootMetadata.mode&0o777);await fs.utimes(destination,new Date(rootMetadata.mtime),new Date(rootMetadata.mtime));}
  }catch(error){throw new Error(`Working-files import incomplete; retained files at ${destination}: ${(error as Error).message}`,{cause:error});}
}

/** Explicit whole-folder selection. Omit native ownership/credential paths and report every omission. */
export async function inventoryWorkingFolder(rootPath:string):Promise<{mode:number;mtime:string;paths:string[];directories:Array<{path:string;mode:number;mtime:string}>;excludedPaths:string[]}> {
  const root=await fs.realpath(rootPath),paths:string[]=[],directories:Array<{path:string;mode:number;mtime:string}>=[],excludedPaths:string[]=[];
  let entries=0;
  const walk=async(relative:string):Promise<void>=>{
    const directory=relative?path.join(root,relative):root;
    if(await fs.realpath(directory)!==directory)throw new Error('Working folder changed during inventory');
    const before=await fs.lstat(directory,{bigint:true});
    for(const entry of await fs.readdir(directory,{withFileTypes:true})){
      if(++entries>10000)throw new Error('Whole working folder exceeds 10000 entries');
      const name=relative?`${relative}/${entry.name}`:entry.name;
      try{portableWorkingPath(name);}catch{excludedPaths.push(name);continue;}
      const stat=await fs.lstat(path.join(root,name));
      if(stat.isSymbolicLink()||!stat.isDirectory()&&!stat.isFile())throw new Error(`Unsupported working-folder entry: ${name}`);
      if(stat.isDirectory()){
        directories.push({path:name,mode:stat.mode&0o777,mtime:stat.mtime.toISOString()});
        await walk(name);
      }else paths.push(name);
    }
    const after=await fs.lstat(directory,{bigint:true});
    if(before.dev!==after.dev||before.ino!==after.ino||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new Error('Working folder changed during inventory');
  };
  await walk('');
  const rootStat=await fs.stat(root);
  return {mode:rootStat.mode&0o777,mtime:rootStat.mtime.toISOString(),paths,directories,excludedPaths};
}
