import {AGENT_PACKAGE_MAX_BYTES,agentPackageJsonUtf8Bytes,workingFileArtifactRefs} from "@ponderosa/core";
import {verifyPortableWorkingFileParts} from "./portable-working-file-parts.js";
import {assertAgentPackageMemoryAvailable,encodePortableArtifactData,decodePortableArtifactData} from "./agent-package-codec.js";
import {LargeWorkingFileInspector} from './large-working-file-inspection.js';
import {constants,closeSync} from 'node:fs';
import {openPortableRegular} from './portable-held-regular.js';
import {applyExactFileMetadata,applyExactSymlinkMetadata,pinPortableSymlink} from '@ponderosa/native-host';
import {promises as fs} from '@ponderosa/native-host/fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import type {AgentPortablePackageDto,PortableArtifactDto,PortableWorkingLinkDto,ReviewedUserDataSelection,ReviewedMetadataActivation,ReviewedGitExternalDependencies,CanonicalGeneratedHooksProof,ReviewedGitUserData} from '@ponderosa/core';
import {applyFilesystemMetadata,planFilesystemMetadata} from './portable-filesystem-metadata.js';
import {assertPortableSecretsAbsent} from './portable-secrets.js';
import {sourcePathWithin,relativeSourcePath} from './portable-source-paths.js';
import {assertRetainedReviewNamespace,assertSafeCurrentGitEvidence,parseReviewedGitConfiguration,captureRetainedReviewOriginal,selectedReviewedGitStorage,exportReviewedUserData,parseReviewedUserData,recreateReviewedGit,REVIEWED_USER_DATA_PATH,createGitExportCapture,verifyGitExportAssociations,exportReviewedGit,validateRetainedNativeGitBinary,validateReviewedGit,type GitExportCapture} from './portable-reviewed-user-data.js';

export interface WorkingHardlinkCapture {
  originals:Map<string,{root:string;ref?:string;path:string;nlink:bigint;count:number;identity:string;paths:string[]}>;
  aliases:Array<{root:string;path:string;key:string;identity:string}>;
}
/** Runtime-only proofs issued by native writers after complete alias/readback checks. */
export interface WorkingNativeDirectoryProof {device:string;inode:string;mode:number;mtimeNs:string;ctimeNs?:string;uid?:string;gid?:string;size?:string;nlink?:string}
export interface WorkingNativeFileProof extends WorkingNativeDirectoryProof {sha256:string;expectedLinkCount:string}
export interface WorkingNativeMetadata {
 files:Map<string,WorkingNativeFileProof>;directories:Map<string,WorkingNativeDirectoryProof>;
 protectedFiles:Map<string,{mode:number;mtimeNs:string;sha256:string}>;protectedDirectories:Map<string,{mode:number;mtimeNs:string}>;
 deferredMetadata:Map<string,{kind:'file'|'directory';mode:number;mtimeNs:string;apply:(held:{fd:number;expectedDevice:bigint;expectedInode:bigint;expectedLinkCount?:bigint})=>void|Promise<void>}>;
}
export type WorkingNativeMetadataEvidence=WorkingNativeMetadata;
export type WorkingNativeMetadataSink=WorkingNativeMetadata;
export function createWorkingNativeMetadataEvidence():WorkingNativeMetadata{return {files:new Map(),directories:new Map(),protectedFiles:new Map(),protectedDirectories:new Map(),deferredMetadata:new Map()};}
function assertNativeMetadataProof(stat:{dev:bigint;ino:bigint;mode:bigint;mtimeNs:bigint;ctimeNs:bigint},proof:WorkingNativeDirectoryProof):void {
  if(!Number.isInteger(proof.mode)||proof.mode<0||proof.mode>0o7777||String(stat.dev)!==proof.device||String(stat.ino)!==proof.inode||Number(stat.mode&0o7777n)!==proof.mode||String(stat.mtimeNs)!==proof.mtimeNs||proof.ctimeNs!==undefined&&String(stat.ctimeNs)!==proof.ctimeNs)throw new Error('Native metadata proof no longer matches the held working original; preserve all aliases');
}
function queueAncestorDirectoryMetadata(target:string,mode:number,mtime:string,native?:WorkingNativeMetadata):boolean {
 if(!native||![...native.protectedFiles.keys(),...native.protectedDirectories.keys()].some(name=>name.startsWith(target+path.sep)))return false;
 const finalMode=mode&0o777,mtimeNs=String(BigInt(Date.parse(mtime))*1000000n),prior=native.deferredMetadata.get(target);
 if(prior&&(prior.kind!=='directory'||prior.mode!==finalMode||prior.mtimeNs!==mtimeNs))throw new Error('Deferred working directory metadata conflicts with another selected original');
 if(!prior)native.deferredMetadata.set(target,{kind:'directory',mode:finalMode,mtimeNs,apply:held=>{applyExactFileMetadata({...held,kind:'directory',mode:finalMode,mtimeNs:BigInt(mtimeNs)});}});
 return true;
}
export function createWorkingHardlinkCapture():WorkingHardlinkCapture{return {originals:new Map(),aliases:[]};}
function hardlinkIdentity(stat:Awaited<ReturnType<typeof fs.lstat>>|{dev:bigint;ino:bigint;nlink:bigint;mode:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint}):string{
  const value=stat as {dev:bigint;ino:bigint;nlink:bigint;mode:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint};
  return [value.dev,value.ino,value.nlink,value.mode,value.size,value.mtimeNs,value.ctimeNs].join(':');
}
export async function verifyWorkingHardlinkCapture(capture:WorkingHardlinkCapture):Promise<void>{
  for(const original of capture.originals.values())if(original.nlink!==BigInt(original.count))throw new Error('Hardlink has aliases outside all selected nonsecret roots');
  for(const alias of capture.aliases){
    const target=path.join(alias.root,alias.path);
    if(await fs.realpath(path.dirname(target))!==path.dirname(target))throw new Error('Hardlink parent changed during capture');
    const stat=await fs.lstat(target,{bigint:true});
    if(!stat.isFile()||hardlinkIdentity(stat)!==alias.identity||[stat.dev,stat.ino].join(':')!==alias.key)throw new Error('Selected hardlink alias changed during capture');
  }
}
/** Root dependencies are directed from an alias to its regular original. No destination mutation. */
export function orderWorkingRoots<T extends {ref:string;links:readonly PortableWorkingLinkDto[]}>(roots:readonly T[],nesting:NonNullable<import('@ponderosa/core').AgentPortablePackageDto['workingRootNesting']>=[]):T[]{
  const byRef=new Map(roots.map(root=>[root.ref,root])),done=new Set<string>(),pending=new Set<string>(),ordered:T[]=[];
  const visit=(root:T)=>{
    if(done.has(root.ref))return;
    if(pending.has(root.ref))throw new Error('Cyclic selected working-root nesting');
    pending.add(root.ref);
    for(const boundary of nesting.filter(boundary=>boundary.childRootRef===root.ref)){const parent=byRef.get(boundary.parentRootRef);if(!parent)throw Error('Nested child requires its included parent root');visit(parent);}
    for(const link of root.links)if(link.kind==='hardlink'&&link.targetRootRef&&!byRef.has(link.targetRootRef))throw new Error('Hardlink original lacks included root closure');
    pending.delete(root.ref);done.add(root.ref);ordered.push(root);
  };
  for(const root of roots)visit(root);
  return ordered;
}

/** Typed selected-root boundaries preserve directories without visiting their bytes twice. */
export function validateWorkingRootNesting(refs:ReadonlySet<string>,nesting:NonNullable<import('@ponderosa/core').AgentPortablePackageDto['workingRootNesting']>,destinations?:Readonly<Record<string,string>>):void{
 if(!Array.isArray(nesting)||nesting.length>10000)throw Error('Invalid selected working-root nesting');
 const parents=new Map<string,{parentRootRef:string;childRootRef:string;path:string}>();
 for(const boundary of nesting){
  if(!boundary||typeof boundary!=='object'||Object.keys(boundary).some(key=>!['parentRootRef','childRootRef','path'].includes(key))||!refs.has(boundary.parentRootRef)||!refs.has(boundary.childRootRef)||boundary.parentRootRef===boundary.childRootRef||parents.has(boundary.childRootRef)||typeof boundary.path!=='string'||!boundary.path||boundary.path.length>4096||/[\\:\x00-\x1f\x7f]/.test(boundary.path)||boundary.path.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Selected child root needs one canonical relative boundary and included parent');
  parents.set(boundary.childRootRef,boundary);
 }
 for(const ref of refs){const seen=new Set<string>();let current=ref;while(parents.has(current)){if(seen.has(current))throw Error('Cyclic selected working-root nesting');seen.add(current);current=parents.get(current)!.parentRootRef;}}
 if(!destinations)return;
 const entries=Object.entries(destinations);
 if(entries.length!==refs.size||entries.some(([ref,name])=>!refs.has(ref)||typeof name!=='string'||!path.isAbsolute(name)||path.resolve(name)!==name))throw Error('Exact canonical destination for every selected working root required');
 for(const boundary of nesting)if(destinations[boundary.childRootRef]!==path.join(destinations[boundary.parentRootRef]!,...boundary.path.split('/')))throw Error('Nested working-root destinations must preserve the exact selected child boundary');
 const ancestor=(child:string,parent:string)=>{let current=child;while(parents.has(current)){current=parents.get(current)!.parentRootRef;if(current===parent)return true;}return false;};
 for(const [ref,name]of entries)for(const [otherRef,other]of entries)if(ref!==otherRef&&(name===other||name.startsWith(other+path.sep)&&!ancestor(ref,otherRef)))throw Error('Working-root destination overlap lacks its exact selected boundary');
}

export function portableWorkingPath(value:unknown):string {
  if(typeof value!=='string'||!value||value.includes('\\')||value.includes('\0')||value.includes(':')||value.startsWith('/')||value.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Select relative regular-file paths inside the working folder');
  if(value.split('/').some(p=>['.git','.mcp.json','.ponderosa-import-backups','.ssh','.aws','.gnupg','.codex','.claude','browser-profiles'].includes(p)||/^\.env(?:\.|$)/i.test(p)||/^(?:credentials(?:\.json)?|auth\.json|.*\.(?:pem|key|p12))$/i.test(p)))throw new Error(`Known credential/native ownership path cannot be exported: ${value}`);
  return value;
}

/** Relative symbolic targets retain their spelling, including dangling in-root targets. */
export function portableLinkTarget(link:PortableWorkingLinkDto):string {
  portableWorkingPath(link.path);
  if(!['symlink','hardlink'].includes(link.kind)||typeof link.target!=='string'||!link.target||link.target.includes('\\')||link.target.includes('\0')||link.target.includes(':')||path.posix.isAbsolute(link.target))throw new Error('Working links require relative in-root targets');
  if(link.sourceTarget!==undefined&&(link.kind!=='symlink'||typeof link.sourceTarget!=='string'||!link.sourceTarget||link.sourceTarget.length>10000||/[\x00-\x1f\x7f]/.test(link.sourceTarget)))throw new Error('Invalid original symbolic target');
  if(link.mtime!==undefined&&(typeof link.mtime!=='string'||!Number.isFinite(Date.parse(link.mtime))))throw new Error('Invalid working-link timestamp');
  if(link.targetRootRef!==undefined){
    if(!['symlink','hardlink'].includes(link.kind)||typeof link.targetRootRef!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(link.targetRootRef)||link.kind==='symlink'&&!link.sourceTarget)throw new Error('Mapped links require an included target root and original target');
    if(link.target.length>10000)throw new Error('Working-link target exceeds its finite bound');
    if(link.target!=='.')portableWorkingPath(link.target);
    return link.target;
  }
  if(link.target.length>10000)throw new Error('Working-link target exceeds its finite bound');
  for(const part of link.target.split('/'))if(part&&part!=='.'&&part!=='..')portableWorkingPath(part);
  const resolved=link.kind==='hardlink'?portableWorkingPath(link.target):path.posix.normalize(path.posix.join(path.posix.dirname(link.path),link.target));
  if(resolved!=='.')portableWorkingPath(resolved);
  return resolved;
}

/** Validate before any destination write. Links are leaves, never traversed during installation. */
export function validateWorkingTopology(files:readonly {path:string}[],directories:readonly {path:string}[],links:readonly PortableWorkingLinkDto[],cyclicLinks:'refuse'|'passive_in_root'='refuse'):void {
  if(!['refuse','passive_in_root'].includes(cyclicLinks))throw new Error('Unsupported working-link cycle policy');
  if(files.length+directories.length+links.length>10000)throw new Error('Working-folder topology exceeds 10000 entries');
  const leaves=new Set(files.map(file=>portableWorkingPath(file.path))),folders=new Set(directories.map(dir=>portableWorkingPath(dir.path)));
  if(leaves.size!==files.length||folders.size!==directories.length)throw new Error('Duplicate working-folder paths');
  for(const link of links){
    portableLinkTarget(link);
    if(leaves.has(link.path)||folders.has(link.path))throw new Error('Conflicting working-link path');
    if(link.kind==='hardlink'&&!link.targetRootRef&&!files.some(file=>file.path===link.target))throw new Error('Hardlinks require an included regular original');
    leaves.add(link.path);
  }
  const symbolic=new Map(links.filter(link=>link.kind==='symlink'&&!link.targetRootRef).map(link=>[link.path,link.target]));
  for(const link of links.filter(link=>link.kind==='symlink'&&!link.targetRootRef)){
    const pending=[...path.posix.dirname(link.path).split('/').filter(p=>p!=='.'),...link.target.split('/')],resolved:string[]=[];
    let expansions=0,steps=0;const states=new Set<string>();
    while(pending.length){
      if(++steps>10000)throw new Error('Working symlink resolution exceeds its finite bound');
      const part=pending.shift()!;if(!part||part==='.')continue;
      if(part==='..'){if(!resolved.length)throw new Error('Working symlink chain leaves the selected root');resolved.pop();continue;}
      portableWorkingPath(part);
      resolved.push(part);const target=symbolic.get(resolved.join('/'));
      if(target!==undefined){
        // A repeated link alone is insufficient: a growing suffix may still escape.
        const state=JSON.stringify([resolved,pending]);
        if(state.length>10000||++expansions>10000)throw new Error('Working symlink resolution exceeds its finite bound');
        if(states.has(state)){if(cyclicLinks!=='passive_in_root')throw new Error('Cyclic working symlinks require explicit passive in-root preservation');break;}
        states.add(state);resolved.pop();pending.unshift(...target.split('/'));
      }
    }
    if(resolved.length)portableWorkingPath(resolved.join('/'));
  }
  for(const name of [...leaves,...folders]){
    if(leaves.has(name)&&folders.has(name)||name.split('/').slice(0,-1).some((_,i)=>leaves.has(name.split('/').slice(0,i+1).join('/'))))throw new Error('Working files and links cannot be parent folders');
  }
}

/** Resolve mapped symbolic graphs without touching a source or destination path. */
export function validateMappedWorkingLinks(roots:readonly {ref:string;links:readonly PortableWorkingLinkDto[];cyclicLinks?:'refuse'|'passive_in_root'}[]):void{
  const graph=new Map(roots.map(root=>[root.ref,new Map(root.links.filter(link=>link.kind==='symlink').map(link=>[link.path,link]))]));
  if(graph.size!==roots.length)throw new Error('Duplicate symbolic root graph');
  for(const root of roots)for(const original of root.links.filter(link=>link.kind==='symlink')){
    let ref=root.ref,resolved:string[]=[];
    const pending=original.path.split('/'),states=new Set<string>();let steps=0;
    while(pending.length){
      if(++steps>10000)throw new Error('Mapped symbolic graph exceeds its finite bound');
      const part=pending.shift()!;
      if(!part||part==='.')continue;
      if(part==='..'){if(!resolved.length)throw new Error('Mapped symbolic chain leaves all selected roots');resolved.pop();continue;}
      portableWorkingPath(part);resolved.push(part);
      const link=graph.get(ref)?.get(resolved.join('/'));if(!link)continue;
      const state=JSON.stringify([ref,resolved,pending]);
      if(state.length>10000)throw new Error('Mapped symbolic graph exceeds its finite bound');
      if(states.has(state)){if(root.cyclicLinks!=='passive_in_root')throw new Error('Cyclic mapped symbolic links require explicit passive preservation');break;}
      states.add(state);
      if(link.targetRootRef){
        if(!graph.has(link.targetRootRef))throw new Error('Mapped symbolic target lacks included root closure');
        ref=link.targetRootRef;resolved=[];
      }else resolved.pop();
      pending.unshift(...link.target.split('/'));
    }
  }
}

export function validateWorkingFileData(relative:string,data:Buffer):void {
  portableWorkingPath(relative);
  if(data.length>64*1024*1024){
    const inspector=new LargeWorkingFileInspector(relative,data.length);
    for(let offset=0;offset<data.length;offset+=1024*1024)inspector.write(data.subarray(offset,Math.min(data.length,offset+1024*1024)));
    inspector.finish();return;
  }
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

type GeneratedNode={path:string;kind:'directory'|'file'|'symlink';mode:number;mtimeNs:string;sha256?:string;target?:string;device:string;inode:string;ctimeNs:string};
type GeneratedObservation={name:'git-repository'|'provider-files';state:'absent'|'matches-original';nodes:Omit<GeneratedNode,'device'|'inode'|'ctimeNs'>[]};
async function generatedTree(root:string,expected?:GeneratedNode[],normalize?:(relative:string,data:Buffer)=>Buffer):Promise<GeneratedNode[]>{
  const entries:GeneratedNode[]=[],allowed=expected?new Map(expected.map(item=>[item.path,item])):undefined;let total=0;
  const visit=async(relative:string)=>{
    if(entries.length>=10000)throw new Error('Generated review evidence exceeds its inventory bound');
    const target=relative?path.join(root,...relative.split('/')):root;
    const before=await fs.lstat(target,{bigint:true}),base={path:relative,mode:Number(before.mode&0o7777n),mtimeNs:before.mtimeNs.toString(),device:before.dev.toString(),inode:before.ino.toString(),ctimeNs:before.ctimeNs.toString()};
    const prior=allowed?.get(relative);if(allowed&&!prior)throw new Error('Generated review contents changed; source remains unchanged');
    if(before.isDirectory()&&!before.isSymbolicLink()){
      entries.push({...base,kind:'directory'});
      const names=(await fs.readdir(target)).sort();if(names.length>10000)throw new Error('Generated review evidence exceeds its inventory bound');
      for(const name of names){if(!name||name==='.'||name==='..'||name.includes('/')||name.includes('\\'))throw new Error('Generated review contains unsupported names');await visit(relative?relative+'/'+name:name);}
    }else if(before.isFile()&&!before.isSymbolicLink()){
      if(before.nlink!==1n||before.size>64n*1024n*1024n)throw new Error('Generated review contains unsupported file aliases or sizes');
      total+=Number(before.size);if(total>64*1024*1024)throw new Error('Generated review evidence exceeds its byte bound');
      const handle=await openPortableRegular(target);let data:Buffer;
      try{const opened=await handle.stat({bigint:true});if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)throw new Error('Generated review changed during inspection');
        data=Buffer.alloc(Number(opened.size));let offset=0;while(offset<data.length){const read=await handle.read(data,offset,data.length-offset,offset);if(!read.bytesRead)throw new Error('Generated review changed during inspection');offset+=read.bytesRead;}
        const after=await handle.stat({bigint:true});if(opened.dev!==after.dev||opened.ino!==after.ino||opened.size!==after.size||opened.mtimeNs!==after.mtimeNs||opened.ctimeNs!==after.ctimeNs)throw new Error('Generated review changed during inspection');
      }finally{await handle.close();}
      entries.push({...base,kind:'file',sha256:createHash('sha256').update(normalize?normalize(relative,data):data).digest('hex')});
    }else if(before.isSymbolicLink())entries.push({...base,kind:'symlink',target:await fs.readlink(target)});
    else throw new Error('Generated review contains unsupported special nodes');
    const after=await fs.lstat(target,{bigint:true});if(before.dev!==after.dev||before.ino!==after.ino||before.mode!==after.mode||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new Error('Generated review changed during inspection');
  };
  await visit('');
  if(allowed&&(entries.length!==expected!.length||entries.some(item=>!allowed.has(item.path))))throw new Error('Generated review contents changed; source remains unchanged');
  return entries;
}
async function captureGeneratedOriginalProof(review:string,original:Buffer):Promise<{observations:GeneratedObservation[];verify:()=>Promise<void>}>{
  const value=parseReviewedUserData(original),names=['git-repository','provider-files'] as const;
  const parent=await fs.realpath(tmpdir()),scratch=await fs.mkdtemp(path.join(parent,'ponderosa-retained-compare-'));
  const issued=await fs.lstat(scratch,{bigint:true});
  const expected=new Map<string,GeneratedNode[]>(),observations:GeneratedObservation[]=[],guards=new Map<string,string>();
  try{
    for(const name of names){
      const actual=path.join(review,name);let present=true;
      try{await fs.lstat(actual);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')present=false;else throw error;}
      if(!present){observations.push({name,state:'absent',nodes:[]});guards.set(name,'absent');continue;}
      const target=path.join(scratch,name);
      if(name==='git-repository'){
        if(!value.git)throw new Error('Generated Git review lacks its canonical original');
        await recreateReviewedGit(target,value.git);
      }else{
        if(!value.providerFiles.length&&!value.providerDirectories.length)throw new Error('Generated provider review lacks its canonical original');
        await fs.mkdir(target,{mode:0o700});const manifest=[];
        for(const [index,file] of value.providerFiles.entries()){
          const reviewFile=`${index}.review`;await fs.writeFile(path.join(target,reviewFile),Buffer.from(file.dataBase64,'base64'),{flag:'wx',mode:0o600});
          manifest.push({path:file.path,reviewFile,removedSecretFields:file.removedSecretFields,...(file.metadata?{metadata:file.metadata}:{})});
        }
        await fs.writeFile(path.join(target,'manifest.json'),JSON.stringify({activation:'inert_review_only',files:manifest,directories:value.providerDirectories},null,2),{flag:'wx',mode:0o600});
      }
      // The inert selected-worktree review contains one generated absolute
      // worktree path. Compare the exact known generated scratch spelling as
      // the corresponding actual review path; every other byte stays exact.
      const normalize=(relative:string,data:Buffer)=>{
        if(name!=='git-repository'||relative!=='.ponderosa-review-git/worktrees/selected/config.worktree')return data;
        const generated=(destination:string)=>Buffer.from('[core]\n\tbare = false\n\tworktree = '+JSON.stringify(destination)+'\n');
        if(!data.equals(generated(target)))throw new Error('Generated review configuration differs');
        return generated(actual);
      };
      const baseline=await generatedTree(target,undefined,normalize),current=await generatedTree(actual,baseline);expected.set(name,baseline);
      if(current.some((item,index)=>item.path!==baseline[index]?.path||item.kind!==baseline[index]?.kind||item.sha256!==baseline[index]?.sha256||item.target!==baseline[index]?.target))throw new Error('Generated review contains changed user data; source remains unchanged');
      observations.push({name,state:'matches-original',nodes:current.map(({device,inode,ctimeNs,...node})=>node)});
      guards.set(name,JSON.stringify(current));
    }
  }finally{
    const current=await fs.lstat(scratch,{bigint:true});
    if(current.dev!==issued.dev||current.ino!==issued.ino||!current.isDirectory()||await fs.realpath(scratch)!==scratch)throw new Error('Temporary Git comparison changed; its files were preserved');
    await fs.rm(scratch,{recursive:true,force:false});
  }
  return {observations,verify:async()=>{
    for(const name of names){
      const root=path.join(review,name),guard=guards.get(name)!;
      if(guard==='absent'){try{await fs.lstat(root);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}throw new Error('Generated review changed during export; source remains unchanged');}
      const current=await generatedTree(root,expected.get(name));
      if(JSON.stringify(current)!==guard)throw new Error('Generated review changed during export; source remains unchanged');
    }
  }};
}

// Historical evidence only: these files are never used as native Git authority.
const CURRENT_GIT_EVIDENCE='.ponderosa-portable-review/current-git-evidence';
const CURRENT_GIT_MANIFEST=CURRENT_GIT_EVIDENCE+'/manifest.json';
const CURRENT_GIT_NAMES=['external-git','native-git-common','current-git-evidence'] as const;
type CurrentGitName=typeof CURRENT_GIT_NAMES[number];
type CurrentGitNamespace={name:CurrentGitName;rootMode:number;rootMtime:string;directories:Array<{path:string;mode:number;mtime:string}>;links:PortableWorkingLinkDto[];files:Array<{path:string;sha256:string;mode:number;mtime:string}>};
type CurrentGitManifest={version:1;originalSha256:string;namespaces:CurrentGitNamespace[];generatedObservations:GeneratedObservation[];nativeGit?:ReviewedGitUserData};
function opaqueGitBytes(data:Buffer):boolean{if(data.includes(0))return true;try{new TextDecoder('utf-8',{fatal:true}).decode(data);return false;}catch{return true;}}
function nestedNativeConfig(name:string):boolean{return /^(?:current-git-evidence\/)*native-git-common\/worktrees\/imported\/config\.worktree$/.test(name);}
function inspectCurrentGitFile(name:string,data:Buffer):void {
  try{if(data.includes(0))throw new Error();new TextDecoder('utf-8',{fatal:true}).decode(data);}
  catch{throw new Error('Current retained Git evidence includes opaque binary data that cannot be inspected; export is held and source files remain in place');}
  try{
    validateWorkingFileData(name,data);assertSafeCurrentGitEvidence(data);
    if(/(?:^|\/)(?:config|config\.worktree)$/i.test(name)){
      const safe=parseReviewedGitConfiguration(data).data;
      if(!safe.equals(data))throw new Error('excluded');
    }
  }catch{throw new Error('Current retained Git evidence contains unsupported or recognizable credential data; source remains unchanged');}
}
/** A binary external review file is supported only when the unchanged,
 * original dependency manifest maps it to an indexed regular blob in that
 * exact repository's current validated review. This is inert evidence. */
function validateRetainedExternalGitBinary(original:Buffer,files:readonly {path:string;data:Buffer}[]):void {
  const dependencies=parseReviewedUserData(original).gitExternalDependencies;
  if(!dependencies)throw new Error('External Git evidence lacks original dependencies');
  const paths=new Map(files.map(file=>[file.path,file.data]));
  if(paths.size!==files.length)throw new Error('Duplicate external Git evidence');
  let ordinal=0;
  const originals:Array<{sourcePath:string;reviewFile:string;mode?:number;mtimeNs?:string;removedSecretFields?:boolean}>=[];
  const next=(sourcePath:string,metadata?:{mode?:number;mtimeNs?:string;removedSecretFields?:boolean})=>{
    const reviewFile=String(ordinal++).padStart(6,'0')+'.review';originals.push({sourcePath,reviewFile,...metadata});return reviewFile;
  };
  const inputs=dependencies.files.map(file=>({file,reviewFile:next(file.sourcePath,{mode:file.mode,mtimeNs:file.mtimeNs,...(file.removedSecretFields?{removedSecretFields:true}:{})})}));
  const repositories=(dependencies.repositories??[]).map(repo=>{
    const metadataFile=next(repo.sourcePath+' [Git metadata]');
    const originals=repo.originals.map(original=>{const sourcePath=repo.sourcePath+' / '+original.path;return {sourcePath,reviewFile:next(sourcePath,{...(original.metadata??{}),removedSecretFields:original.removedSecretFields})};});
    return {repo,metadataFile,originals};
  });
  const expected={activation:'inert_review_only',description:'The numbered .review files contain original Git dependency bytes. Paths and links are historical evidence only.',sourceWorkingRoot:dependencies.sourceWorkingRoot,files:originals,directories:dependencies.directories,links:dependencies.links,absentPaths:dependencies.absentPaths,omittedPaths:dependencies.omittedPaths,bindings:dependencies.bindings,repositories:repositories.map(({repo,metadataFile,originals})=>({sourcePath:repo.sourcePath,metadataFile,originals}))};
  const manifest=paths.get('manifest.json');
  if(!manifest||!manifest.equals(Buffer.from(JSON.stringify(expected,null,2))))throw new Error('External Git original association differs');
  const inputsByFile=new Map(inputs.map(input=>[input.reviewFile,input]));
  const graphCache=new Map<string,{index:Map<string,ReviewedGitUserData['index']>;objects:Map<string,ReviewedGitUserData['objects'][number]>}>();
  for(const {path:name,data} of files){
    if(!opaqueGitBytes(data))continue;
    const input=inputsByFile.get(name);
    if(!input)throw new Error('Unsupported binary external Git file');
    let qualified=false;
    for(const candidate of repositories){
      if(!sourcePathWithin(candidate.repo.sourcePath,input.file.sourcePath)||candidate.repo.sourcePath===input.file.sourcePath)continue;
      let reviewed=graphCache.get(candidate.metadataFile);
      if(!reviewed){
        const bytes=paths.get(candidate.metadataFile);if(!bytes)throw new Error('External Git repository review is missing');
        let graph:ReviewedGitUserData;
        try{graph=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as ReviewedGitUserData;validateReviewedGit(graph);}catch{throw new Error('External Git repository review is invalid');}
        if(!graph.configurationSourceDirectories||!candidate.repo.git.configurationSourceDirectories||JSON.stringify(graph.configurationSourceDirectories)!==JSON.stringify(candidate.repo.git.configurationSourceDirectories))throw new Error('External Git repository source association differs');
        const index=new Map<string,ReviewedGitUserData['index']>(),objects=new Map<string,ReviewedGitUserData['objects'][number]>();
        for(const entry of graph.index){const entries=index.get(entry.path)??[];entries.push(entry);index.set(entry.path,entries);}
        for(const object of graph.objects){assertSafeCurrentGitEvidence(Buffer.from(object.dataBase64,'base64'));objects.set(object.oid,object);}
        reviewed={index,objects};graphCache.set(candidate.metadataFile,reviewed);
      }
      const relative=relativeSourcePath(candidate.repo.sourcePath,input.file.sourcePath),matches=reviewed.index.get(relative)??[];
      if(matches.length!==1||matches[0]!.stage!==0||!['100644','100755'].includes(matches[0]!.mode))continue;
      const blob=reviewed.objects.get(matches[0]!.oid);
      if(blob&&blob.type!=='blob')continue;
      if(blob&&Buffer.from(blob.dataBase64,'base64').equals(data)){assertSafeCurrentGitEvidence(data);qualified=true;break;}
    }
    if(!qualified)throw new Error('External Git binary is not an indexed validated repository blob');
  }
}
async function captureExactRetainedNativeGit(root:string):Promise<ReviewedGitUserData>{
  if(process.platform!=='linux')throw new Error('Retained native Git binary capture requires held Linux roots');
  const common='.ponderosa-portable-review/native-git-common',privatePath=common+'/worktrees/imported';
  const handle=await fs.open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{
    const owner=(await handle.stat({bigint:true})).uid;
    const bindings=[
      {id:'common',worktreeRootRef:'work',storageRootRef:'work',relativePath:common,role:'common' as const,worktreePath:root,storagePath:root},
      {id:'private',worktreeRootRef:'work',storageRootRef:'work',relativePath:privatePath,role:'private' as const,worktreePath:root,storagePath:root},
    ];
    const capture=createGitExportCapture([{pathname:root,ref:'work',handle,owner}],bindings);
    try{
      await verifyGitExportAssociations(capture);
      const result=await exportReviewedGit(root,capture);
      if(!result||result.git.configurationSourceDirectories?.common!==path.join(root,common)||result.git.configurationSourceDirectories?.private!==path.join(root,privatePath))throw new Error('Retained native Git association differs');
      await capture.verify();return result.git;
    }finally{await capture.close();}
  }finally{await handle.close();}
}
async function captureRetainedGitCurrent(root:string,original:Buffer,maxBytes:number):Promise<{files:Array<import("@ponderosa/core").PortableWorkingFileDto>;artifacts:PortableArtifactDto[];bytes:number;verify:()=>Promise<void>}|undefined>{
  const review=path.join(root,'.ponderosa-portable-review');
  const present:CurrentGitName[]=[];
  for(const name of CURRENT_GIT_NAMES){
    const target=path.join(review,name);let stat;
    try{stat=await fs.lstat(target,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw new Error('Current retained Git evidence cannot be inspected; source remains unchanged');}
    try{if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(target)!==target)throw new Error();}
    catch{throw new Error('Current retained Git evidence cannot be inspected; source remains unchanged');}
    present.push(name);
  }
  let generated:Awaited<ReturnType<typeof captureGeneratedOriginalProof>>;
  try{generated=await captureGeneratedOriginalProof(review,original);}catch{throw new Error('Generated review contents changed or could not be verified; source remains unchanged');}
  const originalSha256=createHash('sha256').update(original).digest('hex');
  const collect=async()=>{
    const namespaces:CurrentGitNamespace[]=[],outFiles:Array<import("@ponderosa/core").PortableWorkingFileDto>=[],artifacts:PortableArtifactDto[]=[];
    let bytes=0;const nativeFiles:Array<{path:string;data:Buffer}>=[],externalFiles:Array<{path:string;data:Buffer}>=[],nestedFiles:Array<{path:string;data:Buffer;sha256:string;mode?:number}>=[];let hasNativeBinary=false,hasExternalBinary=false;
    for(const name of present){
      const target=path.join(review,name);let inventory:WorkingFolderInventory,captured:Awaited<ReturnType<typeof exportWorkingFiles>>;
      try{inventory=await inventoryWorkingFolder(target);if(inventory.excludedPaths.length||inventory.persistentPaths.length)throw new Error('excluded');captured=await exportWorkingFiles(target,inventory.paths,maxBytes-bytes,inventory.links,undefined,undefined,undefined,undefined,inventory);}
      catch{throw new Error('Current retained Git evidence cannot be safely captured; source remains unchanged');}
      bytes+=captured.bytes;
      const byRef=new Map(captured.artifacts.map(item=>[item.ref,item]));
      const entries:CurrentGitNamespace['files']=[];
      for(const file of captured.files){
        const parts=workingFileArtifactRefs(file).map(ref=>byRef.get(ref));
        if(parts.some(artifact=>!artifact))throw new Error('Current retained Git artifact is missing');
        // Account for all retained originals captured so far as well as this
        // whole-file reconstruction. The verifier runs a second collect while
        // the first snapshot remains resident, so admission is rechecked there.
        if(file.parts)assertAgentPackageMemoryAvailable(bytes+file.parts.byteLength);
        const bodies:Buffer[]=[];
        for(const artifact of parts)bodies.push((await decodePortableArtifactData(artifact!)).data);
        const verified=verifyPortableWorkingFileParts(file,bodies);
        const decoded={data:bodies.length===1?bodies[0]!:Buffer.concat(bodies,verified.byteLength),sha256:verified.sha256};
        const opaque=opaqueGitBytes(decoded.data);
        if(name==='native-git-common'){nativeFiles.push({path:file.path,data:decoded.data});if(opaque||file.path==='worktrees/imported/config.worktree')hasNativeBinary=true;}
        if(name==='external-git'){externalFiles.push({path:file.path,data:decoded.data});if(opaque)hasExternalBinary=true;}
        if(name==='current-git-evidence')nestedFiles.push({path:CURRENT_GIT_EVIDENCE+'/'+file.path,data:decoded.data,sha256:decoded.sha256,mode:file.mode});
        if(opaque&&name!=='native-git-common'&&name!=='current-git-evidence'&&name!=='external-git')throw new Error('Current retained Git evidence includes opaque binary data that cannot be inspected; export is held and source files remain in place');
        if(!opaque&&!(name==='native-git-common'&&file.path==='worktrees/imported/config.worktree')&&!(name==='current-git-evidence'&&nestedNativeConfig(file.path)))inspectCurrentGitFile(file.path,decoded.data);
        entries.push({path:file.path,sha256:decoded.sha256,mode:file.mode??0o600,mtime:file.mtime??inventory.mtime});
        const output=CURRENT_GIT_EVIDENCE+'/'+name+'/'+file.path;
        outFiles.push({path:output,artifactRef:file.artifactRef,mode:0o600,...(file.parts?{parts:file.parts}:{})});
        for(const artifact of parts)artifacts.push(file.parts?artifact!:{...artifact!,path:output,summary:'Inert retained Git current evidence'});
      }
      namespaces.push({name,rootMode:inventory.mode,rootMtime:inventory.mtime,directories:inventory.directories,links:inventory.links,files:entries});
    }
    return {namespaces,outFiles,artifacts,bytes,nativeFiles,hasNativeBinary,externalFiles,hasExternalBinary,nestedFiles,hasNestedEvidence:present.includes('current-git-evidence')};
  };
  const captured=await collect();
  const qualify=async(snapshot:typeof captured)=>{
    if(snapshot.hasExternalBinary){try{validateRetainedExternalGitBinary(original,snapshot.externalFiles);}catch{throw new Error('External Git binary evidence cannot be validated; export is held and source files remain in place');}}
    if(snapshot.hasNestedEvidence){try{validateRetainedGitCurrent(snapshot.nestedFiles,original);}catch(error){if(error instanceof RetainedGitEvidenceWorkLimit)throw error;throw new Error('Prior retained Git evidence cannot be validated; export is held and source files remain in place');}}
    if(!snapshot.hasNativeBinary)return undefined;
    try{const git=await captureExactRetainedNativeGit(root);validateRetainedNativeGitBinary(git,snapshot.nativeFiles);return git;}
    catch{throw new Error('Current retained Git binary data cannot be validated; export is held and source files remain in place');}
  };
  const nativeGit=await qualify(captured);
  const verifyGenerated=async()=>{try{await generated.verify();}catch{throw new Error('Generated review contents changed or could not be verified; source remains unchanged');}};
  const verify=async()=>{await verifyGenerated();const check=await collect();if(JSON.stringify(captured.namespaces)!==JSON.stringify(check.namespaces)||JSON.stringify(nativeGit)!==JSON.stringify(await qualify(check)))throw new Error('Current retained Git evidence changed during capture; source remains unchanged');await verifyGenerated();};
  await verify();
  const manifest:CurrentGitManifest={version:1,originalSha256,namespaces:captured.namespaces,generatedObservations:generated.observations,...(nativeGit?{nativeGit}:{})};
  const data=Buffer.from(JSON.stringify(manifest));if(captured.bytes+data.length>maxBytes)throw new Error('Current retained Git evidence exceeds the portable artifact limit');
  const ref=randomUUID();captured.outFiles.push({path:CURRENT_GIT_MANIFEST,artifactRef:ref,mode:0o600});
  captured.artifacts.push({ref,kind:'document',path:CURRENT_GIT_MANIFEST,summary:'Inert retained Git current evidence manifest',createdAt:new Date().toISOString(),mediaType:'application/json',...await encodePortableArtifactData(data)});
  return {files:captured.outFiles,artifacts:captured.artifacts,bytes:captured.bytes+data.length,verify};
}
class RetainedGitEvidenceWorkLimit extends Error {
  constructor(){super('Retained Git evidence exceeds existing package validation work bounds; source data remains unchanged');}
}
function validateRetainedGitCurrent(files:readonly {path:string;data:Buffer;sha256:string;mode?:number}[],original?:Buffer,budget={entries:0,bytes:0}):Array<{path:string;mode:number;mtime:string}>{
  budget.entries+=files.length;for(const file of files)budget.bytes+=file.data.length;
  if(budget.entries>10000||budget.bytes>AGENT_PACKAGE_MAX_BYTES)throw new RetainedGitEvidenceWorkLimit();
  const evidence=files.filter(file=>file.path===CURRENT_GIT_EVIDENCE||file.path.startsWith(CURRENT_GIT_EVIDENCE+'/'));
  if(!evidence.length)return [];
  const manifestFile=evidence.find(file=>file.path===CURRENT_GIT_MANIFEST);
  if(!manifestFile||!original||manifestFile.mode!==0o600||createHash('sha256').update(manifestFile.data).digest('hex')!==manifestFile.sha256)throw new Error('Current retained Git evidence lacks its exact original association');
  let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifestFile.data));}catch{throw new Error('Current retained Git evidence manifest is invalid');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Current retained Git evidence manifest is invalid');
  const manifest=value as CurrentGitManifest;
  if(JSON.stringify(Object.keys(manifest).sort())!==JSON.stringify(manifest.nativeGit?['generatedObservations','namespaces','nativeGit','originalSha256','version']:['generatedObservations','namespaces','originalSha256','version'])||manifest.version!==1||manifest.originalSha256!==createHash('sha256').update(original).digest('hex')||!Array.isArray(manifest.namespaces)||manifest.namespaces.length>3)throw new Error('Current retained Git evidence association differs');
  if(!Array.isArray(manifest.generatedObservations)||manifest.generatedObservations.length!==2||manifest.generatedObservations.some((item,index)=>!item||item.name!==['git-repository','provider-files'][index]||!['absent','matches-original'].includes(item.state)||!Array.isArray(item.nodes)||item.nodes.length>10000||item.state==='absent'&&item.nodes.length!==0))throw new Error('Generated review evidence is invalid');
  assertPortableSecretsAbsent(manifest.generatedObservations,'Generated review evidence');
  const expected=new Set([CURRENT_GIT_MANIFEST]),names=new Set<string>(),dirs:Array<{path:string;mode:number;mtime:string}>=[],nativeFiles:Array<{path:string;data:Buffer}>=[],externalFiles:Array<{path:string;data:Buffer}>=[],nestedFiles:Array<{path:string;data:Buffer;sha256:string;mode?:number}>=[];let hasNativeBinary=false,hasExternalBinary=false,hasNestedEvidence=false;
  const epoch=new Date(0).toISOString();dirs.push({path:'.ponderosa-portable-review',mode:0o700,mtime:epoch},{path:CURRENT_GIT_EVIDENCE,mode:0o700,mtime:epoch});
  for(const ns of manifest.namespaces){
    if(!ns||!CURRENT_GIT_NAMES.includes(ns.name)||names.has(ns.name)||!Array.isArray(ns.files)||!Array.isArray(ns.directories)||!Array.isArray(ns.links)||!Number.isInteger(ns.rootMode)||typeof ns.rootMtime!=='string'||!Number.isFinite(Date.parse(ns.rootMtime)))throw new Error('Current retained Git evidence namespace is invalid');
    names.add(ns.name);if(ns.name==='current-git-evidence')hasNestedEvidence=true;const base=CURRENT_GIT_EVIDENCE+'/'+ns.name;dirs.push({path:base,mode:0o700,mtime:epoch});
    validateWorkingTopology(ns.files,ns.directories,ns.links,'passive_in_root');
    for(const directory of ns.directories){if(!Number.isInteger(directory.mode)||directory.mode<0||directory.mode>0o7777||typeof directory.mtime!=='string'||!Number.isFinite(Date.parse(directory.mtime)))throw new Error('Current retained Git directory evidence is invalid');dirs.push({path:base+'/'+portableWorkingPath(directory.path),mode:0o700,mtime:epoch});}
    for(const item of ns.files){
      if(!item||typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256)||!Number.isInteger(item.mode)||item.mode<0||item.mode>0o7777||typeof item.mtime!=='string'||!Number.isFinite(Date.parse(item.mtime)))throw new Error('Current retained Git file evidence is invalid');
      const full=base+'/'+portableWorkingPath(item.path),file=evidence.find(candidate=>candidate.path===full);
      if(expected.has(full)||!file||file.mode!==0o600||file.sha256!==item.sha256||createHash('sha256').update(file.data).digest('hex')!==item.sha256)throw new Error('Current retained Git evidence bytes differ');
      const opaque=opaqueGitBytes(file.data);
      if(ns.name==='native-git-common'){nativeFiles.push({path:item.path,data:file.data});if(opaque||item.path==='worktrees/imported/config.worktree')hasNativeBinary=true;}
      if(ns.name==='external-git'){externalFiles.push({path:item.path,data:file.data});if(opaque)hasExternalBinary=true;}
      if(ns.name==='current-git-evidence')nestedFiles.push({path:CURRENT_GIT_EVIDENCE+'/'+item.path,data:file.data,sha256:file.sha256,mode:file.mode});
      if(opaque&&ns.name!=='native-git-common'&&ns.name!=='current-git-evidence'&&ns.name!=='external-git')throw new Error('Unsupported opaque retained Git evidence');
      if(!opaque&&!(ns.name==='native-git-common'&&item.path==='worktrees/imported/config.worktree')&&!(ns.name==='current-git-evidence'&&nestedNativeConfig(item.path)))inspectCurrentGitFile(item.path,file.data);expected.add(full);
    }
  }
  if(evidence.length!==expected.size||evidence.some(file=>!expected.has(file.path)))throw new Error('Current retained Git evidence inventory differs');
  if(Boolean(manifest.nativeGit)!==hasNativeBinary)throw new Error('Retained native Git binary proof differs');
  if(manifest.nativeGit)validateRetainedNativeGitBinary(manifest.nativeGit,nativeFiles);
  if(hasExternalBinary)validateRetainedExternalGitBinary(original!,externalFiles);
  if(hasNestedEvidence)validateRetainedGitCurrent(nestedFiles,original,budget);
  return dirs;
}

/** Explicit selection only; no implicit traversal of user folders or native profiles. */
export async function exportWorkingFiles(rootPath:string,selected:readonly string[],maxBytes:number,links:readonly PortableWorkingLinkDto[]=[],reviewedSelection?:ReviewedUserDataSelection,retainedOriginal?:{data:Buffer;mode?:number;mtime?:string;canonicalGeneratedHooksProof?:CanonicalGeneratedHooksProof},gitCapture?:GitExportCapture,rootMappings?:ReadonlyMap<string,string>,capturedInventory?:WorkingFolderInventory):Promise<{files:Array<{path:string;artifactRef:string;mode?:number;mtime?:string;parts?:{schema:'ponderosa.working-file-parts.v1';refs:string[];byteLength:number;sha256:string}}>;artifacts:PortableArtifactDto[];bytes:number;verify?:()=>Promise<void>}> {
  const root=await fs.realpath(rootPath),files:Array<{path:string;artifactRef:string;mode?:number;mtime?:string;parts?:{schema:'ponderosa.working-file-parts.v1';refs:string[];byteLength:number;sha256:string}}>=[],artifacts:PortableArtifactDto[]=[];
  const gitStorage=gitCapture?gitCapture.exclusions(root):reviewedSelection?.git&&reviewedSelection.source!=='retained_originals'?await selectedReviewedGitStorage(root):[];
  if(selected.some(name=>gitStorage.some(storage=>storage==='.'||name===storage||name.startsWith(storage+'/'))))throw new Error('Selected Git storage cannot also be exported as ordinary working files');
  const retained=reviewedSelection?.source==='retained_originals'?await captureRetainedReviewOriginal(root,reviewedSelection,retainedOriginal?.data??Buffer.alloc(0),retainedOriginal?.canonicalGeneratedHooksProof,true):undefined;
  const current=retained?await captureRetainedGitCurrent(root,retained.data,maxBytes):undefined;
  validateWorkingTopology([...selected.map(path=>({path})),...(reviewedSelection?[{path:REVIEWED_USER_DATA_PATH}]:[]),...(current?.files??[])],[],links,'passive_in_root');
  const verifyLinks=async()=>{for(const link of links){
    const name=path.join(root,link.path);
    if(await fs.realpath(path.dirname(name))!==path.dirname(name))throw new Error('Working-link parent changed');
    const stat=await fs.lstat(name,{bigint:true});
    if(link.kind==='symlink'){if(!stat.isSymbolicLink()||await fs.readlink(name)!==(link.sourceTarget??link.target)||link.mtime!==undefined&&stat.mtime.toISOString()!==link.mtime)throw new Error('Working symlink changed during export');}
    else {const originalRoot=link.targetRootRef?[...(rootMappings??new Map())].find(([,ref])=>ref===link.targetRootRef)?.[0]:root;if(!originalRoot)throw new Error('Hardlink source root is not selected');const target=await fs.lstat(path.join(originalRoot,link.target),{bigint:true});if(!stat.isFile()||stat.dev!==target.dev||stat.ino!==target.ino)throw new Error('Working hardlink changed during export');}
  }};
  await verifyLinks();
  let bytes=0,wireBytes=0;
  if(selected.length>10000||new Set(selected).size!==selected.length)throw new Error('Select at most 10000 distinct working files');
  for(const item of selected){
    const relative=portableWorkingPath(item),parts=relative.split('/');
    let current=root;
    for(const part of parts){current=path.join(current,part);if((await fs.lstat(current)).isSymbolicLink())throw new Error(`Working-file symlinks are not portable originals: ${relative}`);}
    const handle=await openPortableRegular(current);
    let data:Buffer,mode:number,mtime:string;
    try{
      const before=await handle.stat({bigint:true});
      if(!before.isFile()||before.nlink!==(capturedInventory?.linkCounts.get(relative)??BigInt(1+links.filter(link=>link.kind==='hardlink'&&!link.targetRootRef&&link.target===relative).length))||before.size>BigInt(maxBytes-bytes))throw new Error(`Working file lacks a bounded complete regular-link inventory: ${relative}`);
      if(await fs.realpath(path.dirname(current))!==path.dirname(current))throw new Error('Working-file directory changed during export');
      // Import already uses this budget for retained decoded originals. Apply
      // the same admission before allocating an extended export original.
      if(before.size>64n*1024n*1024n)assertAgentPackageMemoryAvailable(Number(before.size));
      data=Buffer.alloc(Number(before.size));let offset=0;
      while(offset<data.length){const read=await handle.read(data,offset,data.length-offset,offset);if(!read.bytesRead)throw new Error(`Working file shortened during export: ${relative}`);offset+=read.bytesRead;}
      if((before.mode&0o7000n)!==0n&&!reviewedSelection?.extendedMetadata)throw new Error('Select filesystem metadata to preserve special POSIX mode bits');
      mode=Number(before.mode)&0o777;mtime=new Date(Number(before.mtimeMs)).toISOString();
      const after=await handle.stat({bigint:true});
      if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||BigInt(data.length)!==before.size)throw new Error(`Working file changed during export: ${relative}`);
    }finally{await handle.close();}
    validateWorkingFileData(relative,data);
    for(const alias of capturedInventory?.validationPaths.get(relative)??[])validateWorkingFileData(alias,data);
    for(const link of links.filter(link=>link.kind==='hardlink'&&link.target===relative))validateWorkingFileData(link.path,data);
    bytes+=data.length;if(bytes>maxBytes)throw new Error('Selected working files exceed the portable artifact limit');
    if(data.length<=64*1024*1024){
      const ref=randomUUID();files.push({path:relative,artifactRef:ref,mode:mode!,mtime:mtime!});
      const artifact:PortableArtifactDto={ref,kind:'document',path:relative,summary:relative,createdAt:new Date().toISOString(),mediaType:'application/octet-stream',...await encodePortableArtifactData(data)};
      wireBytes+=agentPackageJsonUtf8Bytes(artifact);
      if(wireBytes>AGENT_PACKAGE_MAX_BYTES)throw Object.assign(new Error('Selected working files exceed the serialized package byte limit; no originals were omitted'),{statusCode:413});
      artifacts.push(artifact);
    }else{
      // One logical original, transported as existing bounded artifact parts.
      // The media type and summary identify each as partial transport data.
      const chunkSize=32*1024*1024,refs:string[]=[],count=Math.ceil(data.length/chunkSize),createdAt=new Date().toISOString();
      for(let index=0;index<count;index++){
        const ref=randomUUID();refs.push(ref);
        const artifact:PortableArtifactDto={ref,kind:'document',path:'portable-working-part/'+ref,summary:'Transport part '+(index+1)+' of '+count+' for working file '+relative+'; not a complete file',createdAt,mediaType:'application/vnd.ponderosa.working-file-part.v1',...await encodePortableArtifactData(data.subarray(index*chunkSize,Math.min(data.length,(index+1)*chunkSize)))};
        wireBytes+=agentPackageJsonUtf8Bytes(artifact);
        if(wireBytes>AGENT_PACKAGE_MAX_BYTES)throw Object.assign(new Error('Selected working files exceed the serialized package byte limit; no originals were omitted'),{statusCode:413});
        artifacts.push(artifact);
      }
      files.push({path:relative,artifactRef:refs[0]!,mode:mode!,mtime:mtime!,parts:{schema:'ponderosa.working-file-parts.v1',refs,byteLength:data.length,sha256:createHash('sha256').update(data).digest('hex')}});
    }
  }
  await verifyLinks();
  if(current){
    bytes+=current.bytes;if(bytes>maxBytes)throw new Error('Current retained Git evidence exceeds the portable artifact limit');
    for(const artifact of current.artifacts){wireBytes+=agentPackageJsonUtf8Bytes(artifact);if(wireBytes>AGENT_PACKAGE_MAX_BYTES)throw new Error('Current retained Git evidence exceeds the package limit');}
    files.push(...current.files);artifacts.push(...current.artifacts);
  }
  if(reviewedSelection){
    const data=retained?.data??Buffer.from(JSON.stringify(await exportReviewedUserData(root,reviewedSelection,gitCapture,rootMappings,capturedInventory)));
    await retained?.verify();
    parseReviewedUserData(data);
    if(gitCapture&&reviewedSelection.git)gitCapture.bindReview(root,data);
    bytes+=data.length;if(bytes>maxBytes)throw new Error('Reviewed Git/provider data exceeds the portable artifact limit');
    const ref=randomUUID();files.push({path:REVIEWED_USER_DATA_PATH,artifactRef:ref,mode:retainedOriginal?.mode??0o600,...(retainedOriginal?.mtime?{mtime:retainedOriginal.mtime}:{})});
    artifacts.push({ref,kind:'document',path:REVIEWED_USER_DATA_PATH,summary:'Inert Git and provider configuration review',createdAt:new Date().toISOString(),mediaType:'application/json',dataBase64:data.toString('base64')});
  }
  const verify=retained?async()=>{await retained.verify();await current?.verify();await retained.verify();}:undefined;
  await verify?.();return {files,artifacts,bytes,...(verify?{verify}:{})};
}

export interface WorkingDirectoryIdentity {device:string;inode:string}
/** Original directories observed during the byte phase, never late-phase observations. */
export interface WorkingRootIdentity extends WorkingDirectoryIdentity {directories?:Readonly<Record<string,WorkingDirectoryIdentity>>;backupDirectory?:WorkingDirectoryIdentity}
/** Resolve only a directory issued by the original byte phase. Does not inspect the host. */
export function workingDirectoryIdentity(rootPath:string,issued:WorkingRootIdentity,targetPath:string):WorkingRootIdentity {
  if(!path.isAbsolute(rootPath)||path.resolve(rootPath)!==rootPath||!path.isAbsolute(targetPath)||path.resolve(targetPath)!==targetPath)throw new Error('Directory custody requires canonical destination paths');
  if(!issued||![issued.device,issued.inode].every(value=>typeof value==='string'&&/^(?:0|[1-9][0-9]{0,31})$/.test(value)))throw new Error('Invalid issued working-root identity');
  const relative=path.relative(rootPath,targetPath);
  if(relative==='')return {...issued};
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('Directory custody target is outside its original root');
  const key=relative.split(path.sep).join('/');
  if(portableWorkingPath(key)!==key||!issued.directories||!Object.hasOwn(issued.directories,key))throw new Error('Contained directory has no original byte-phase custody');
  const proof=issued.directories[key]!;
  if(![proof.device,proof.inode].every(value=>typeof value==='string'&&/^(?:0|[1-9][0-9]{0,31})$/.test(value)))throw new Error('Invalid issued contained-directory identity');
  const descendants=Object.fromEntries(Object.entries(issued.directories).filter(([relative])=>relative.startsWith(key+'/')).map(([relative,identity])=>[relative.slice(key.length+1),identity]));
  return {device:proof.device,inode:proof.inode,...(Object.keys(descendants).length?{directories:Object.freeze(descendants)}:{})};
}
async function observedWorkingRootIdentity(destination:string):Promise<WorkingRootIdentity>{
  const stat=await fs.lstat(destination,{bigint:true});
  if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(destination)!==destination)throw new Error('Imported working root is not canonical');
  return {device:stat.dev.toString(),inode:stat.ino.toString()};
}
/** Locally issued identity only. A later phase never upgrades a new observation into custody. */
export async function assertWorkingRootIdentity(destination:string,expected:WorkingRootIdentity):Promise<void>{
  if(!expected||typeof expected.device!=='string'||typeof expected.inode!=='string'||![expected.device,expected.inode].every(value=>/^(?:0|[1-9][0-9]{0,31})$/.test(value)))throw new Error('Invalid issued working-root identity');
  const actual=await observedWorkingRootIdentity(destination);
  if(actual.device!==expected.device||actual.inode!==expected.inode)throw Object.assign(new Error('Imported working-root identity changed; preserve original and replacement folders'),{code:'ERR_WORKING_ROOT_IDENTITY',expected,observed:actual});
}

/** Keep configured Git originals accessible for inspection without activating
 * hooks, links, configuration or any historical source path. */
export async function materializeGitExternalReview(folder:string,data:ReviewedGitExternalDependencies,checkRoot:()=>Promise<void>,parentIdentity:WorkingDirectoryIdentity):Promise<void>{
  await checkRoot();
  const parent=path.dirname(folder);
  await assertWorkingRootIdentity(parent,parentIdentity);
  const parentHandle=await fs.open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  let folderHandle:Awaited<ReturnType<typeof fs.open>>|undefined,primary:unknown;
  try{
  const held=await parentHandle.stat({bigint:true});
  if(held.dev.toString()!==parentIdentity.device||held.ino.toString()!==parentIdentity.inode)throw new Error('Git review parent identity changed');
  if(process.platform==='linux'&&(await fs.statfs('/proc/self/fd')).type!==0x9fa0)throw new Error('Qualified procfs descriptor access is unavailable');
  const heldParent=process.platform==='linux'?'/proc/self/fd/'+parentHandle.fd:parent;
  if(process.platform==='linux'){const proc=await fs.stat(heldParent,{bigint:true});if(proc.dev!==held.dev||proc.ino!==held.ino)throw new Error('Held Git review parent is unavailable');}
  await fs.mkdir(path.join(heldParent,path.basename(folder)),{mode:0o700});
  const identity=await observedWorkingRootIdentity(folder);
  folderHandle=await fs.open(path.join(heldParent,path.basename(folder)),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  const opened=await folderHandle.stat({bigint:true});if(opened.dev.toString()!==identity.device||opened.ino.toString()!==identity.inode)throw new Error('Git review directory identity changed');
  const heldFolder=process.platform==='linux'?'/proc/self/fd/'+folderHandle.fd:folder;
  if(process.platform==='linux'){const proc=await fs.stat(heldFolder,{bigint:true});if(proc.dev!==opened.dev||proc.ino!==opened.ino)throw new Error('Held Git review directory is unavailable');}
  const check=async()=>{await checkRoot();await assertWorkingRootIdentity(parent,parentIdentity);await assertWorkingRootIdentity(folder,identity);};
  const originals:Array<{sourcePath:string;reviewFile:string;mode?:number;mtimeNs?:string;removedSecretFields?:boolean}>=[],repositories:Array<{sourcePath:string;metadataFile:string;originals:Array<{sourcePath:string;reviewFile:string}>}>=[];
  const write=async(data:Buffer,sourcePath:string,metadata?:{mode?:number;mtimeNs?:string;removedSecretFields?:boolean})=>{
    await check();
    const reviewFile=String(originals.length).padStart(6,'0')+'.review';
    const handle=await fs.open(path.join(heldFolder,reviewFile),'wx',0o600);
    try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}
    await check();
    originals.push({sourcePath,reviewFile,...metadata});
    return reviewFile;
  };
  for(const file of data.files)await write(Buffer.from(file.dataBase64,'base64'),file.sourcePath,{mode:file.mode,mtimeNs:file.mtimeNs,...(file.removedSecretFields?{removedSecretFields:true}:{})});
  for(const repo of data.repositories??[]){
    const metadataFile=await write(Buffer.from(JSON.stringify(repo.git,null,2)),repo.sourcePath+' [Git metadata]');
    const files:Array<{sourcePath:string;reviewFile:string}>=[];
    for(const original of repo.originals){
      const sourcePath=repo.sourcePath+' / '+original.path;
      files.push({sourcePath,reviewFile:await write(Buffer.from(original.dataBase64,'base64'),sourcePath,{...(original.metadata??{}),removedSecretFields:original.removedSecretFields})});
    }
    repositories.push({sourcePath:repo.sourcePath,metadataFile,originals:files});
  }
  await check();
  const manifest={activation:'inert_review_only',description:'The numbered .review files contain original Git dependency bytes. Paths and links are historical evidence only.',sourceWorkingRoot:data.sourceWorkingRoot,files:originals,directories:data.directories,links:data.links,absentPaths:data.absentPaths,omittedPaths:data.omittedPaths,bindings:data.bindings,repositories};
  const handle=await fs.open(path.join(heldFolder,'manifest.json'),'wx',0o600);
  try{await handle.writeFile(JSON.stringify(manifest,null,2));await handle.sync();}finally{await handle.close();}
  await check();
  }catch(error){primary=error;throw error;}
  finally{
    const cleanup:unknown[]=[];
    if(folderHandle)try{await folderHandle.close();}catch(error){cleanup.push(error);}
    try{await parentHandle.close();}catch(error){cleanup.push(error);}
    if(cleanup.length)throw Object.assign(new Error('Git review handle cleanup failed; preserve all created files',{cause:primary??cleanup[0]}),{code:(primary as {code?:string}|undefined)?.code??'ERR_GIT_REVIEW_CLEANUP',partialStatePossible:true,cleanupErrors:cleanup});
  }
}

/** Exclusively create a new user-selected folder. Failure retains every byte for recovery. */
/** Shared link phase; global root imports call this only after every original exists. */
async function placeWorkingLinks(destination:string,links:readonly PortableWorkingLinkDto[],rootDestinations:Readonly<Record<string,string>>|undefined,preserveBaseline:(relative:string)=>Promise<void>,assertCurrent?:()=>Promise<void>,exactSymlinkTimestamps=false):Promise<void>{
    for(const link of [...links].sort((a,b)=>(a.kind==='hardlink'?0:1)-(b.kind==='hardlink'?0:1))){
      const mappedRoot=link.targetRootRef?rootDestinations?.[link.targetRootRef]:undefined;
      if(link.targetRootRef&&!mappedRoot)throw new Error('Working-link target root is missing from the selected destination map');
      await assertCurrent?.();
      const target=path.join(destination,link.path),parent=path.dirname(target);
      let current=destination;
      for(const component of link.path.split('/').slice(0,-1)){
        current=path.join(current,component);
        await assertCurrent?.();
        try{await fs.mkdir(current,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
        if(!(await fs.lstat(current)).isDirectory()||await fs.realpath(current)!==current)throw new Error('Working-link destination parent changed');
      }
      if(await fs.realpath(parent)!==parent)throw new Error('Working-link destination parent changed');
      await preserveBaseline(link.path);
      if(link.kind==='hardlink'){
        const original=path.join(mappedRoot??destination,link.target),stat=await fs.lstat(original);
        if(!stat.isFile()||stat.isSymbolicLink()||await fs.realpath(original)!==original)throw new Error('Hardlink original changed');
        if(stat.dev!==(await fs.lstat(parent)).dev)throw new Error('Mapped hardlink destinations must use the same filesystem; partial originals retained');
        await fs.link(original,target);
      }else{
        const symbolicTarget=mappedRoot?path.relative(parent,link.target==='.'?mappedRoot:path.join(mappedRoot,link.target)):link.target;
        await fs.symlink(symbolicTarget||'.',target);
        if(link.mtime){
          if(exactSymlinkTimestamps&&process.platform!=='linux')throw new Error('Exact final symbolic-link timestamps require Linux native metadata support; files and links are retained');
          if(process.platform!=='linux'&&!exactSymlinkTimestamps)await fs.lutimes(target,new Date(link.mtime),new Date(link.mtime));
          else{
            // The package declares millisecond timestamps. Date/lutimes can round
            // below that boundary and lose another millisecond on each export.
            const heldParent=await fs.open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
            let descriptor:number|undefined,fallback=false;
            try{
              const parentStat=await heldParent.stat({bigint:true}),before=await fs.lstat(target,{bigint:true}),mtimeNs=String(BigInt(Date.parse(link.mtime))*1000000n);
              descriptor=pinPortableSymlink({parentFd:heldParent.fd,leaf:path.basename(target),expectedParentDevice:parentStat.dev,expectedParentInode:parentStat.ino,expectedDevice:before.dev,expectedInode:before.ino}).fd;
              applyExactSymlinkMetadata({fd:descriptor,expectedDevice:before.dev,expectedInode:before.ino,mtimeNs});
              const after=await fs.lstat(target,{bigint:true});
              if(after.dev!==before.dev||after.ino!==before.ino||after.mtimeNs!==BigInt(mtimeNs)||await fs.readlink(target)!==(symbolicTarget||'.'))throw new Error('Working symlink timestamp or identity changed');
            }catch(error){
              // Only these capability failures prove that metadata was not
              // attempted. Never replay after a partial or identity failure.
              if(!exactSymlinkTimestamps&&['MODULE_NOT_FOUND','ERR_DLOPEN_FAILED','ERR_PORTABLE_SYMLINK_PIN_UNSUPPORTED','ERR_EXACT_SYMLINK_METADATA_UNSUPPORTED'].includes((error as NodeJS.ErrnoException).code??''))fallback=true;
              else throw error;
            }finally{if(descriptor!==undefined)closeSync(descriptor);await heldParent.close();}
            if(fallback)await fs.lutimes(target,new Date(link.mtime),new Date(link.mtime));
          }
          if((await fs.lstat(target,{bigint:true})).mtime.toISOString()!==link.mtime)throw Object.assign(new Error('Symbolic-link timestamp could not be restored exactly; files and links are retained'),{code:'ERR_WORKING_SYMLINK_TIMESTAMP_INEXACT',partialStatePossible:true});
        }
      }
    }
}
async function preserveWorkingBaseline(destination:string,relative:string,freshRoot?:{backupRoot:string}):Promise<void>{
    if(freshRoot){
        const target=path.join(destination,relative);
        let stat;try{stat=await fs.lstat(target);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        if(stat){
          if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error('Fresh baseline path is not a regular original');
          // Preserve even racing local bytes; never unlink a displaced baseline.
          const backup=path.join(freshRoot.backupRoot,randomUUID());
          await fs.writeFile(backup+'.path.json',JSON.stringify({path:relative}),{flag:'wx',mode:0o600});
          await fs.rename(target,backup);
        }
      }

}

/** Existing imported root only. A collision preserves the observed entry and refuses, never overwrites it. */
export async function importWorkingLinks(destination:string,links:readonly PortableWorkingLinkDto[],rootDestinations?:Readonly<Record<string,string>>,freshRoot?:{backupRoot:string},expectedIdentity?:WorkingRootIdentity,exactSymlinkTimestamps=false):Promise<void>{
 if(await fs.realpath(destination)!==destination)throw new Error('Imported link root changed');
 for(const link of links){portableLinkTarget(link);if(link.targetRootRef&&!rootDestinations?.[link.targetRootRef])throw new Error('Mapped link target root is missing');}
 const identity=expectedIdentity??await observedWorkingRootIdentity(destination);
 await assertWorkingRootIdentity(destination,identity);
 if(freshRoot&&(freshRoot.backupRoot!==path.join(destination,'.ponderosa-import-backups')||await fs.realpath(freshRoot.backupRoot)!==freshRoot.backupRoot))throw new Error('Fresh link recovery folder changed');
 const check=()=>assertWorkingRootIdentity(destination,identity);
 await check();
 await placeWorkingLinks(destination,links,rootDestinations,async relative=>{await check();await preserveWorkingBaseline(destination,relative,freshRoot);},check,exactSymlinkTimestamps);
 await check();
}

export async function importWorkingFiles(destination:string,files:readonly {path:string;data:Buffer;sha256:string;mode?:number;mtime?:string}[],directories:readonly {path:string;mode:number;mtime:string}[]=[],rootMetadata?:{mode:number;mtime:string},freshRoot?:{backupRoot:string;identity?:WorkingRootIdentity},links:readonly PortableWorkingLinkDto[]=[],cyclicLinks:'refuse'|'passive_in_root'='refuse',metadataActivation?:ReviewedMetadataActivation,deferMetadataApplication=false,rootDestinations?:Readonly<Record<string,string>>,deferLinks=false):Promise<WorkingRootIdentity>{
  validateWorkingTopology(files,directories,links,cyclicLinks);
  for(const link of links)if(link.targetRootRef){
    const targetRoot=rootDestinations?.[link.targetRootRef];
    if(!targetRoot||!path.isAbsolute(targetRoot)||path.resolve(targetRoot)!==targetRoot)throw new Error('Mapped links require explicit final-root destinations before import');
  }
  const reviewedFile=files.find(file=>file.path===REVIEWED_USER_DATA_PATH);
  if(reviewedFile&&createHash('sha256').update(reviewedFile.data).digest('hex')!==reviewedFile.sha256)throw new Error('Reviewed user-data identity changed');
  const reviewedData=reviewedFile?parseReviewedUserData(reviewedFile.data):undefined;
  const extraDirs=validateRetainedGitCurrent(files,reviewedFile?.data);
  const existingDirs=new Set(directories.map(directory=>directory.path));
  const allDirectories=[...directories,...extraDirs.filter(directory=>!existingDirs.has(directory.path))];
  validateWorkingTopology(files,allDirectories,links,cyclicLinks);
  if(metadataActivation){
    if(!reviewedData?.filesystemMetadata)throw new Error('Metadata activation requires the original per-node evidence');
    planFilesystemMetadata(reviewedData.filesystemMetadata,reviewedData.selection,metadataActivation);
    const originals=new Map<string,string>([['.','directory']]);
    for(const directory of directories)originals.set(directory.path,'directory');
    for(const file of files)if(file.path!==REVIEWED_USER_DATA_PATH)originals.set(file.path,'file');
    if(reviewedData.selection.extendedMetadata&&originals.size!==reviewedData.filesystemMetadata.nodes.length)throw new Error('Complete working-node metadata evidence is required');
    for(const node of reviewedData.filesystemMetadata.nodes)if(originals.get(node.path)!==node.kind)throw new Error('Metadata node differs from the included working originals');
  }
  if(reviewedData?.recreationScope.cyclicLinks==='refuse')validateWorkingTopology(files,directories,links,'refuse');
  for(const link of links.filter(link=>link.kind==='hardlink'&&!link.targetRootRef))validateWorkingFileData(link.path,files.find(file=>file.path===link.target)!.data);
  if(!path.isAbsolute(destination)||path.resolve(destination)!==destination)throw new Error('Choose an absolute new working-files destination');
  const parent=await fs.realpath(path.dirname(destination));
  if(parent!==path.dirname(destination))throw new Error('Working-files destination parent must be canonical');
  let issuedIdentity:WorkingRootIdentity;
  if(freshRoot){
    if(await fs.realpath(destination)!==destination)throw new Error('Fresh working root must be canonical');
    if(freshRoot.backupRoot!==path.join(destination,'.ponderosa-import-backups'))throw new Error('Invalid fresh-root recovery folder');
    issuedIdentity=freshRoot.identity??await observedWorkingRootIdentity(destination);
    await assertWorkingRootIdentity(destination,issuedIdentity);
    await fs.mkdir(freshRoot.backupRoot,{mode:0o700});
    const backup=await fs.lstat(freshRoot.backupRoot,{bigint:true});
    issuedIdentity={...issuedIdentity,backupDirectory:{device:String(backup.dev),inode:String(backup.ino)}};
    if(await fs.realpath(freshRoot.backupRoot)!==freshRoot.backupRoot)throw new Error('Recovery folder changed');
  }else{await fs.mkdir(destination,{mode:0o700});issuedIdentity=await observedWorkingRootIdentity(destination);}
  const directoryIdentities:Record<string,WorkingDirectoryIdentity>=Object.create(null);
  const rememberDirectory=async(relative:string,target:string):Promise<void>=>{
    await assertWorkingRootIdentity(destination,issuedIdentity);
    const observed=await observedWorkingRootIdentity(target),prior=directoryIdentities[relative];
    if(prior&&(prior.device!==observed.device||prior.inode!==observed.inode))throw new Error('Working directory changed during its original byte phase');
    directoryIdentities[relative]=observed;
  };
  const checkRoot=()=>assertWorkingRootIdentity(destination,issuedIdentity);
  const preserveBaseline=(relative:string)=>preserveWorkingBaseline(destination,relative,freshRoot);
  try{
    await checkRoot();
    for(const folder of [...allDirectories].sort((a,b)=>a.path.split('/').length-b.path.split('/').length)){
      await checkRoot();
      const relative=portableWorkingPath(folder.path);
      const target=path.join(destination,relative);
      try{await fs.mkdir(target,{mode:0o700});}catch(error){if(!freshRoot||(error as NodeJS.ErrnoException).code!=='EEXIST'||!(await fs.lstat(target)).isDirectory())throw error;}
      if(await fs.realpath(target)!==target)throw new Error('Destination directory changed');
      await rememberDirectory(relative,target);
    }
    for(const file of files){
      await checkRoot();
      const relative=portableWorkingPath(file.path),parts=relative.split('/');let dir=destination;
      for(const component of parts.slice(0,-1)){
        dir=path.join(dir,component);
        try{await fs.mkdir(dir,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
        const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(dir)!==dir)throw new Error('Working-files destination changed');
        await rememberDirectory(path.relative(destination,dir).split(path.sep).join('/'),dir);
      }
      if(createHash('sha256').update(file.data).digest('hex')!==file.sha256)throw new Error('Staged working-file identity changed');
      await preserveBaseline(relative);
      const handle=await fs.open(path.join(destination,relative),'wx',0o600);
      try{await handle.writeFile(file.data);await handle.sync();}finally{await handle.close();}
    }
    if(!deferLinks)await placeWorkingLinks(destination,links,rootDestinations,preserveBaseline,checkRoot);
    if(reviewedData){
      // Separate repository only: never overwrite this working root's native-owned .git or provider settings.
      if(reviewedData.git)await recreateReviewedGit(path.join(destination,'.ponderosa-portable-review','git-repository'),reviewedData.git);
      if(reviewedData.gitExternalDependencies)await materializeGitExternalReview(path.join(destination,'.ponderosa-portable-review','external-git'),reviewedData.gitExternalDependencies,checkRoot,directoryIdentities['.ponderosa-portable-review']!);
      if(reviewedData.providerFiles.length||reviewedData.providerDirectories.length){
        const folder=path.join(destination,'.ponderosa-portable-review','provider-files');await fs.mkdir(folder,{mode:0o700});
        const manifest=[];
        for(const [index,file] of reviewedData.providerFiles.entries()){
          const reviewFile=`${index}.review`;
          await fs.writeFile(path.join(folder,reviewFile),Buffer.from(file.dataBase64,'base64'),{flag:'wx',mode:0o600});
          manifest.push({path:file.path,reviewFile,removedSecretFields:file.removedSecretFields,...(file.metadata?{metadata:file.metadata}:{})});
        }
        await fs.writeFile(path.join(folder,'manifest.json'),JSON.stringify({activation:'inert_review_only',files:manifest,directories:reviewedData.providerDirectories},null,2),{flag:'wx',mode:0o600});
      }
    }
    // Check original directory names before publishing custody. Final metadata
    // may intentionally remove traversal permission, so this precedes it.
    for(const relative of Object.keys(directoryIdentities))await rememberDirectory(relative,path.join(destination,relative));
    issuedIdentity={device:issuedIdentity.device,inode:issuedIdentity.inode,directories:Object.freeze({...directoryIdentities}),...(issuedIdentity.backupDirectory?{backupDirectory:issuedIdentity.backupDirectory}:{})};
    if(!deferMetadataApplication)await finalizeWorkingFolderMetadata(destination,files,allDirectories,rootMetadata,links,metadataActivation,undefined,issuedIdentity);
    await checkRoot();
    return issuedIdentity;
  }catch(error){throw Object.assign(new Error(`Working-files import incomplete; retained files at ${destination}: ${(error as Error).message}`,{cause:error}),{code:(error as {code?:string}).code??'ERR_WORKING_FILES_IMPORT_PARTIAL',partialStatePossible:true,observed:(error as {observed?:unknown}).observed??null});}
}

/** Final ordinary/native metadata, after all root contents and cross-root aliases exist. */
export async function finalizeWorkingFolderMetadata(destination:string,files:Parameters<typeof importWorkingFiles>[1],directories:Parameters<typeof importWorkingFiles>[2],rootMetadata:Parameters<typeof importWorkingFiles>[3],links:readonly PortableWorkingLinkDto[]=[],activation?:ReviewedMetadataActivation,expectedLinkCounts?:ReadonlyMap<string,bigint>,expectedIdentity?:WorkingRootIdentity,nativeMetadata?:WorkingNativeMetadataEvidence):Promise<void>{
  const identity=expectedIdentity??await observedWorkingRootIdentity(destination),checkRoot=()=>assertWorkingRootIdentity(destination,identity);
  await checkRoot();
  const original=files.find(file=>file.path===REVIEWED_USER_DATA_PATH);
  const reviewed=original?parseReviewedUserData(original.data):undefined;
  const finalLinkCounts=new Map(expectedLinkCounts);
  for(const file of files){const target=path.join(destination,file.path),plan=nativeMetadata?.protectedFiles.get(target),proof=nativeMetadata?.files.get(target);if(plan&&plan.sha256!==file.sha256)throw new Error('Protected native and working original bytes disagree');if(proof){if(!/^[1-9][0-9]*$/.test(proof.expectedLinkCount)||proof.sha256!==file.sha256)throw new Error('Native and working original bytes or declared alias census disagree');finalLinkCounts.set(file.path,BigInt(proof.expectedLinkCount));}}
  for(const relative of [...files.map(file=>file.path),...links.filter(link=>link.kind==='hardlink').map(link=>link.path)]){const target=path.join(destination,relative),proof=nativeMetadata?.files.get(target);if(!proof)continue;await checkRoot();if(await fs.realpath(path.dirname(target))!==path.dirname(target))throw new Error('Native working alias parent changed');const handle=await openPortableRegular(target,'metadata');try{const stat=await handle.stat({bigint:true});assertNativeMetadataProof(stat,proof);if(!stat.isFile()||String(stat.nlink)!==proof.expectedLinkCount)throw new Error('Native working alias identity or complete declared census changed');}finally{await handle.close();}}
  // Exact user metadata may add ACL/principal choices, but cannot conflict with
  // native Git evidence for the same physical source original.
  if(activation&&reviewed?.selection.extendedMetadata)for(const node of reviewed.filesystemMetadata?.nodes??[]){const target=node.path==='.'?destination:path.join(destination,node.path),proof=node.kind==='file'?(nativeMetadata?.protectedFiles.get(target)??nativeMetadata?.files.get(target)):(nativeMetadata?.protectedDirectories.get(target)??nativeMetadata?.directories.get(target));if(proof&&(node.mode!==proof.mode||node.mtimeNs!==proof.mtimeNs))throw new Error('Selected filesystem and native Git metadata originals disagree');}
  if(activation){
    if(!original||createHash('sha256').update(original.data).digest('hex')!==original.sha256||!reviewed?.filesystemMetadata)throw new Error('Final metadata original changed or is absent');
    await checkRoot();
    await applyFilesystemMetadata(destination,reviewed.filesystemMetadata,reviewed.selection,activation,links,finalLinkCounts,nativeMetadata);
  }
  if(!activation||!reviewed?.selection.extendedMetadata){
    for(const file of files){
      await checkRoot();
      const target=path.join(destination,portableWorkingPath(file.path));
      // The shared native callback still owns readable descriptors for these
      // exact originals. It verifies bytes/aliases before final selected modes.
      if(nativeMetadata?.protectedFiles.has(target))continue;
      if(await fs.realpath(path.dirname(target))!==path.dirname(target))throw new Error('Final working-file parent changed');
      const proof=nativeMetadata?.files.get(target),sealed=proof?.ctimeNs!==undefined,handle=await openPortableRegular(target,sealed?'metadata':'read');
      try{
        const before=await handle.stat({bigint:true}),expectedLinks=finalLinkCounts.get(file.path)??BigInt(1+links.filter(link=>link.kind==='hardlink'&&!link.targetRootRef&&link.target===file.path).length);
        if(!before.isFile()||before.size!==BigInt(file.data.length)||before.nlink!==expectedLinks)throw new Error('Final working-file identity, size or complete aliases differ');
        if(sealed)assertNativeMetadataProof(before,proof!);
        const hash=createHash('sha256'),buffer=Buffer.alloc(Math.min(file.data.length||1,65536));let offset=0;
        while(!sealed&&offset<file.data.length){const read=await handle.read(buffer,0,Math.min(buffer.length,file.data.length-offset),offset);if(!read.bytesRead)throw new Error('Final working file shortened');hash.update(buffer.subarray(0,read.bytesRead));offset+=read.bytesRead;}
        const after=await handle.stat({bigint:true});
        if(!sealed&&hash.digest('hex')!==file.sha256||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new Error('Final working-file content changed; preserve current bytes');
        await checkRoot();
        if(proof)assertNativeMetadataProof(after,proof);
        else{if(file.mode!==undefined)await handle.chmod(file.mode&0o777);if(file.mtime)await handle.utimes(new Date(file.mtime),new Date(file.mtime));}
        if(!sealed)await handle.sync();
      }finally{await handle.close();}
    }
    for(const folder of [...(directories??[])].sort((a,b)=>b.path.split('/').length-a.path.split('/').length)){
      await checkRoot();
      const target=path.join(destination,portableWorkingPath(folder.path));
      if(nativeMetadata?.protectedDirectories.has(target))continue;
      if(queueAncestorDirectoryMetadata(target,folder.mode,folder.mtime,nativeMetadata))continue;
      if(await fs.realpath(target)!==target)throw new Error('Destination directory changed');
      const handle=await fs.open(target,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      try{const proof=nativeMetadata?.directories.get(target);if(proof)assertNativeMetadataProof(await handle.stat({bigint:true}),proof);else{await handle.chmod(folder.mode&0o777);await handle.utimes(new Date(folder.mtime),new Date(folder.mtime));}}finally{await handle.close();}
    }
    if(rootMetadata){
      await checkRoot();
      if(nativeMetadata?.protectedDirectories.has(destination)||queueAncestorDirectoryMetadata(destination,rootMetadata.mode,rootMetadata.mtime,nativeMetadata)){await checkRoot();return;}
      if(await fs.realpath(destination)!==destination)throw new Error('Destination root changed');
      const handle=await fs.open(destination,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      try{const proof=nativeMetadata?.directories.get(destination);if(proof)assertNativeMetadataProof(await handle.stat({bigint:true}),proof);else{await handle.chmod(rootMetadata.mode&0o777);await handle.utimes(new Date(rootMetadata.mtime),new Date(rootMetadata.mtime));}}finally{await handle.close();}
    }
  }
  await checkRoot();
}
export function workingLinkCounts(ref:string,roots:readonly {ref:string;links:readonly PortableWorkingLinkDto[]}[]):Map<string,bigint>{
  const counts=new Map<string,bigint>();
  for(const root of roots)for(const link of root.links)if(link.kind==='hardlink'&&(link.targetRootRef??root.ref)===ref)counts.set(link.target,(counts.get(link.target)??1n)+1n);
  return counts;
}

/** Hash-bound package declarations only: never discover aliases from current nlink. */
export function workingNativeAliasEvidence(pkg:AgentPortablePackageDto,destinations:Readonly<Record<string,string>>):{aliases:Array<{path:string;target:string;root:string;targetRoot:string}>}{
  if(pkg.mode!=='full')throw new Error('Native alias evidence requires whole working-folder originals');
  const refs=new Set(pkg.agents.filter(node=>node.workingFolder||node.workingFiles?.length).map(node=>node.workingRootRef??node.ref));
  validateWorkingRootNesting(refs,pkg.workingRootNesting??[],destinations);
  const regular=new Set<string>(),links=new Map<string,{rootRef:string;link:PortableWorkingLinkDto}>(),folders=new Set<string>();
  const key=(ref:string,name:string)=>JSON.stringify([ref,name]);
  for(const node of pkg.agents){
    const ref=node.workingRootRef??node.ref;if(!refs.has(ref))continue;
    for(const file of node.workingFiles??[]){const name=portableWorkingPath(file.path),id=key(ref,name);if(links.has(id)||folders.has(id))throw new Error('Native alias original conflicts with working topology');regular.add(id);}
    for(const directory of node.workingFolder?.directories??[]){const id=key(ref,portableWorkingPath(directory.path));if(regular.has(id)||links.has(id))throw new Error('Native alias folder conflicts with working topology');folders.add(id);}
    for(const link of node.workingFolder?.links??[]){portableLinkTarget(link);const id=key(ref,link.path),prior=links.get(id);if(regular.has(id)||folders.has(id)||prior&&JSON.stringify(prior.link)!==JSON.stringify(link))throw new Error('Native alias declarations conflict');links.set(id,{rootRef:ref,link});}
  }
  if(regular.size+folders.size+links.size>10000*refs.size)throw new Error('Native working alias closure exceeds its selected-root format bound');
  const aliases:Array<{path:string;target:string;root:string;targetRoot:string}>=[],physicalNames=new Set<string>();
  for(const {rootRef,link} of links.values()){
    if(link.kind!=='hardlink')continue;
    let targetRef=link.targetRootRef??rootRef,target=link.target;const seen=new Set<string>();
    for(let depth=0;;depth++){
      const id=key(targetRef,target);if(depth>10000||seen.has(id))throw new Error('Native working hardlink chain is cyclic or exceeds its finite bound');seen.add(id);
      if(!refs.has(targetRef))throw new Error('Native working hardlink target root is not included');
      if(regular.has(id))break;
      const next=links.get(id);if(!next||next.link.kind!=='hardlink')throw new Error('Native working hardlink requires a transported regular original');
      targetRef=next.link.targetRootRef??next.rootRef;target=next.link.target;
    }
    const name=path.join(destinations[rootRef]!,link.path),original=path.join(destinations[targetRef]!,target);
    if(name===original||physicalNames.has(name))throw new Error('Native working alias has duplicate physical destination names');physicalNames.add(name);
    aliases.push({path:name,target:original,root:destinations[rootRef]!,targetRoot:destinations[targetRef]!});
  }
  return {aliases};
}

/** Explicit whole-folder selection. Omit native ownership/credential paths and report every omission. */
export interface WorkingFolderInventory {mode:number;mtime:string;paths:string[];directories:Array<{path:string;mode:number;mtime:string}>;excludedPaths:string[];links:PortableWorkingLinkDto[];persistentPaths:string[];linkCounts:Map<string,bigint>;validationPaths:Map<string,string[]>}
export async function inventoryWorkingFolder(rootPath:string,reviewedSelection?:ReviewedUserDataSelection,gitCapture?:GitExportCapture,rootMappings?:ReadonlyMap<string,string>,sharedHardlinks?:WorkingHardlinkCapture,selectedChildRoots:readonly string[]=[]):Promise<WorkingFolderInventory> {
  const root=await fs.realpath(rootPath),paths:string[]=[],directories:Array<{path:string;mode:number;mtime:string}>=[],excludedPaths:string[]=[];
  const gitStorage=gitCapture?gitCapture.exclusions(root):reviewedSelection?.git&&reviewedSelection.source!=='retained_originals'?await selectedReviewedGitStorage(root):[];
  const persistentPaths:string[]=[],links:PortableWorkingLinkDto[]=[],linkCounts=new Map<string,bigint>(),validationPaths=new Map<string,string[]>(),originals=new Map<string,{path:string;nlink:bigint;count:number}>();
  let entries=0;
  const walk=async(relative:string):Promise<void>=>{
    const directory=relative?path.join(root,relative):root;
    if(await fs.realpath(directory)!==directory)throw new Error('Working folder changed during inventory');
    const before=await fs.lstat(directory,{bigint:true});
    for(const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      if(++entries>10000)throw new Error('Whole working folder exceeds 10000 entries');
      const name=relative?`${relative}/${entry.name}`:entry.name;
      if(selectedChildRoots.includes(name)){excludedPaths.push(name);continue;}
      if(gitStorage.includes('.')||gitStorage.includes(name)){excludedPaths.push(name);continue;}
      if(name==='.ponderosa-portable-review'){
        if(reviewedSelection?.source!=='retained_originals')throw new Error('Existing imported review data requires explicit retained-original selection');
        const folder=path.join(root,name),stat=await fs.lstat(folder);
        if(!stat.isDirectory()||await fs.realpath(folder)!==folder)throw new Error('Retained review directory must be canonical');
        // Hook aliases are excluded only after export verifies their complete canonical local proof.
        // Other generated native namespaces still refuse; they can contain changed user data.
        const children=await fs.readdir(folder);assertRetainedReviewNamespace(children,true);
        for(const child of children)if(!['user-data.json','external-git','native-git-common','current-git-evidence'].includes(child))excludedPaths.push(`${name}/${child}`);
        continue;
      }
      try{portableWorkingPath(name);}catch{excludedPaths.push(name);continue;}
      const stat=await fs.lstat(path.join(root,name),{bigint:true});
      if(!stat.isSymbolicLink()&&(stat.mode&0o7000n)!==0n&&!reviewedSelection?.extendedMetadata)throw new Error('Select filesystem metadata to preserve setgid/sticky/setuid mode semantics');
      if(stat.isSymbolicLink()){
        const sourceTarget=await fs.readlink(path.join(root,name)),link:PortableWorkingLinkDto={path:name,kind:'symlink',target:sourceTarget,mtime:stat.mtime.toISOString()};
        const absolute=path.isAbsolute(sourceTarget),escapes=!absolute&&path.relative(root,path.resolve(path.dirname(path.join(root,name)),sourceTarget)).split(path.sep)[0]==='..';
        if(absolute||escapes){
          // Relocate only canonical absolute targets or leading-parent sibling paths.
          // Resolving an internal "a/../" would wrongly normalize through a symlink.
          const rest=sourceTarget.replace(/^(?:\.\.\/)+/,'');
          if(absolute?path.normalize(sourceTarget)!==sourceTarget:rest.split('/').some(part=>part==='.'||part==='..'))throw new Error('Mapped symbolic target requires canonical path components');
          const resolved=path.resolve(path.dirname(path.join(root,name)),sourceTarget);
          const candidates=[...new Map<string,string|undefined>([[root,undefined],...(rootMappings??new Map<string,string>())]).entries()].filter(([selected])=>resolved===selected||resolved.startsWith(selected+path.sep)).sort((a,b)=>b[0].length-a[0].length);
          const chosen=candidates[0];
          if(!chosen)throw new Error('Symbolic target leaves all explicitly selected roots');
          link.sourceTarget=sourceTarget;
          if(chosen[0]!==root){if(!chosen[1])throw new Error('Mapped symbolic target lacks a final root reference');link.targetRootRef=chosen[1];link.target=path.relative(chosen[0],resolved)||'.';}
          else link.target=path.relative(path.dirname(path.join(root,name)),resolved)||'.';
        }
        portableLinkTarget(link);links.push(link);continue;
      }
      if(!stat.isDirectory()&&!stat.isFile()){
        if(reviewedSelection?.persistentNodes&&(stat.isFIFO()&&reviewedSelection.persistentNodes.fifo||reviewedSelection.persistentNodes.evidenceOnly)){
          persistentPaths.push(name);continue;
        }
        throw new Error(`Live socket/device/FIFO has no portable regular bytes; preserve and recreate explicitly: ${name}`);
      }
      if(stat.isDirectory()){
        directories.push({path:name,mode:Number(stat.mode)&0o777,mtime:stat.mtime.toISOString()});
        await walk(name);
      }else {
        const key=`${stat.dev}:${stat.ino}`,original=sharedHardlinks?.originals.get(key)??originals.get(key);
        if(sharedHardlinks){
          sharedHardlinks.aliases.push({root,path:name,key,identity:hardlinkIdentity(stat)});
          const shared=sharedHardlinks.originals.get(key);
          if(shared){
            if(shared.nlink!==stat.nlink||shared.identity!==hardlinkIdentity(stat))throw new Error('Selected hardlink topology changed');
            shared.count++;shared.paths.push(name);
            links.push({path:name,kind:'hardlink',target:shared.path,...(shared.root!==root?{targetRootRef:shared.ref}:{})});
          }else{
            const ref=rootMappings?.get(root);if(!ref)throw new Error('Shared hardlinks require final root references');
            const validationAliases=[name];validationPaths.set(name,validationAliases);
            sharedHardlinks.originals.set(key,{root,ref,path:name,nlink:stat.nlink,count:1,identity:hardlinkIdentity(stat),paths:validationAliases});
            linkCounts.set(name,stat.nlink);paths.push(name);
          }
        }else if(original){if(original.nlink!==stat.nlink)throw new Error('Hardlink topology changed');original.count++;links.push({path:name,kind:'hardlink',target:original.path});}
        else {originals.set(key,{path:name,nlink:stat.nlink,count:1});linkCounts.set(name,stat.nlink);paths.push(name);}
      }
    }
    const after=await fs.lstat(directory,{bigint:true});
    if(before.dev!==after.dev||before.ino!==after.ino||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new Error('Working folder changed during inventory');
  };
  if(!gitStorage.includes('.'))await walk('');
  for(const original of originals.values())if(original.nlink!==BigInt(original.count))throw new Error(`Hardlink has aliases outside the selected nonsecret root; include a complete root or preserve separately: ${original.path}`);
  for(const link of links)if(link.target.split('/').includes('.ponderosa-portable-review'))throw new Error('Working links cannot traverse the inactive review namespace');
  validateWorkingTopology(paths.map(path=>({path})),directories,links,'passive_in_root');
  const rootStat=await fs.stat(root);
  if((rootStat.mode&0o7000)!==0&&!reviewedSelection?.extendedMetadata)throw new Error('Select filesystem metadata to preserve working-root special POSIX mode bits');
  return {mode:rootStat.mode&0o777,mtime:rootStat.mtime.toISOString(),paths,directories,excludedPaths,links,persistentPaths,linkCounts,validationPaths};
}
