import path from 'node:path';
import {createHash} from 'node:crypto';
import {constants,promises as fs} from '@ponderosa/native-host/fs';
import type {WorkingRootIdentity,WorkingNativeMetadata} from './portable-working-files.js';
import {openPortableRegular} from './portable-held-regular.js';
import {getNativeGitExternalGraph} from './portable-git-external-application.js';
import type {NativeReviewedGitConfiguration} from './portable-reviewed-user-data.js';
import type {CanonicalGeneratedHooksProof,GeneratedHookIdentity} from '@ponderosa/core';

export type LocalGeneratedHooksProof=Omit<CanonicalGeneratedHooksProof,'operationId'|'sourceOriginalSha256'>;
export interface ImportedNativeSnapshot {snapshot:string;external:ImportedNativeExternalProof;generatedHooks?:LocalGeneratedHooksProof}

export interface ImportedNativeGitStorage {
 gitDir:string;commonDir:string;moduleGitDirs:string[];
 modulePointers:Array<{path:string;gitDir:string}>;
 moduleLayouts:Array<{worktreePath:string;gitDir:string;commonDir:string}>;
}
export interface ImportedNativeExternalProof {
 rootMetadata?:Array<{path:string;root:string;mode:number;mtimeNs:string}>;
 absentPaths:Array<{path:string;root:string}>;
 directories:Array<{path:string;root:string;mode:number;mtimeNs:string}>;
 files:Array<{path:string;root:string;sha256:string;size:number;mode:number;mtimeNs:string}>;
 links:Array<{path:string;target:string;root:string;targetRoot:string;kind:'symlink'|'hardlink';text:string;mtimeNs?:string}>;
}
const nativeKey=(name:string)=>process.platform==='win32'?name.toLowerCase():name;
const within=(root:string,name:string)=>nativeKey(name)===nativeKey(root)||nativeKey(name).startsWith(nativeKey(root)+path.sep);
const inode=(stat:{dev:bigint;ino:bigint})=>stat.dev.toString()+':'+stat.ino.toString();
const unchanged=(a:{dev:bigint;ino:bigint;size:bigint;mode:bigint;mtimeNs:bigint;ctimeNs:bigint;nlink:bigint},b:typeof a)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mode===b.mode&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&a.nlink===b.nlink;
const generatedIdentity=(stat:{dev:bigint;ino:bigint;mode:bigint;nlink:bigint;uid:bigint;gid:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint}):GeneratedHookIdentity=>({device:String(stat.dev),inode:String(stat.ino),mode:String(stat.mode),nlink:String(stat.nlink),uid:String(stat.uid),gid:String(stat.gid),size:String(stat.size),mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs)});

/** Planner paths, not Git's mutable config/includes, identify native storage. */
export function importedNativeGitStorage(rootPath:string,configuration?:NativeReviewedGitConfiguration,storage?:{gitDir:string;commonDir:string}):ImportedNativeGitStorage {
 const result:ImportedNativeGitStorage={gitDir:storage?.gitDir??path.join(rootPath,'.git'),commonDir:storage?.commonDir??path.join(rootPath,'.git'),moduleGitDirs:[],modulePointers:[],moduleLayouts:[]};
 const visit=(config:NativeReviewedGitConfiguration|undefined,depth:number):void=>{
  if(depth>32)throw new Error('Native Git module pointer proof exceeds its nesting bound');
  for(const module of config?.modules??[]){const layout=module.layout;if(layout&&(!module.initialized||layout.commonDir!==module.gitDir))throw new Error('Native module layout differs from its issued common/private storage');const gitDir=layout?.privateDir??module.gitDir,commonDir=layout?.commonDir??module.gitDir;result.moduleGitDirs.push(commonDir,gitDir);if(module.initialized)result.modulePointers.push({path:path.join(module.worktreePath,'.git'),gitDir});if(layout)result.moduleLayouts.push({worktreePath:module.worktreePath,gitDir,commonDir});visit(module.configuration,depth+1);}
 };
 visit(configuration,0);
 const pointers=new Map<string,{path:string;gitDir:string}>();for(const pointer of result.modulePointers){const key=nativeKey(pointer.path),prior=pointers.get(key);if(prior&&nativeKey(prior.gitDir)!==nativeKey(pointer.gitDir))throw new Error('Conflicting planned native module pointer ownership');if(!prior)pointers.set(key,pointer);}
 result.moduleGitDirs=[...new Map(result.moduleGitDirs.map(name=>[nativeKey(name),name])).values()].sort();result.modulePointers=[...pointers.values()].sort((a,b)=>a.path.localeCompare(b.path));
 return result;
}

export interface ImportedNativeGitCustody {
 roots:Readonly<Record<string,WorkingRootIdentity>>;
 directories?:ReadonlyMap<string,{device:string;inode:string}>;
 metadataPending?:boolean;
}

/** Observe only owned native metadata and the exact compiled external alias graph.
 * No hooks, filters, Git config or outside alias targets are evaluated. */
export async function snapshotImportedNativeGit(rootPath:string,allowedRoots:readonly string[],storage:ImportedNativeGitStorage,configuration?:NativeReviewedGitConfiguration,expectedExternal?:ImportedNativeExternalProof,custody?:ImportedNativeGitCustody):Promise<ImportedNativeSnapshot> {
 const assertOwned=(name:string)=>{if(!path.isAbsolute(name)||path.resolve(name)!==name||!allowedRoots.some(root=>within(root,name)))throw new Error('Native Git proof path is outside its exact locally owned root closure');};
 for(const root of allowedRoots)if(!path.isAbsolute(root)||path.resolve(root)!==root)throw new Error('Native Git proof roots are not canonical');
 assertOwned(rootPath);assertOwned(storage.gitDir);assertOwned(storage.commonDir);for(const name of storage.moduleGitDirs)assertOwned(name);
 if(!custody||!Object.keys(custody.roots).length)throw new Error('Native snapshot requires its original issued root custody');
 const issued=new Map<string,{path:string;device:string;inode:string}>(),rootNames=Object.keys(custody.roots).sort((a,b)=>b.length-a.length);
 const addIssued=(name:string,proof:{device:string;inode:string})=>{assertOwned(name);const key=nativeKey(name),prior=issued.get(key);if(prior&&(prior.device!==proof.device||prior.inode!==proof.inode))throw new Error('Original and writer-issued native directory custody disagree');issued.set(key,{path:name,device:proof.device,inode:proof.inode});};
 for(const [root,identity] of Object.entries(custody.roots)){
  addIssued(root,identity);
  for(const [relative,proof] of Object.entries(identity.directories??{})){if(!relative||path.isAbsolute(relative)||relative.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('Invalid original byte-phase directory proof');addIssued(path.join(root,...relative.split('/')),proof);}
 }
 for(const [name,proof] of custody.directories??[])addIssued(name,proof);
 const checkIssued=async(name:string)=>{const proof=issued.get(nativeKey(name));if(!proof)throw new Error('Native storage ancestry has no original or writer-issued directory proof');const stat=await fs.lstat(proof.path,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev.toString()!==proof.device||stat.ino.toString()!==proof.inode||await fs.realpath(proof.path)!==proof.path)throw new Error('Native original or writer-issued directory custody changed before/during seal');};
 const checkAncestry=async(name:string)=>{const owner=rootNames.find(root=>within(root,name));if(!owner)throw new Error('Native storage has no original root');let current=owner;await checkIssued(current);for(const part of path.relative(owner,name).split(path.sep).filter(Boolean)){current=path.join(current,part);await checkIssued(current);}};
 const anchorDirectories=new Set([rootPath,storage.gitDir,storage.commonDir,...storage.moduleGitDirs,...storage.modulePointers.map(pointer=>path.dirname(pointer.path))]);

 const graph=expectedExternal??(()=>{const value=getNativeGitExternalGraph(configuration,{gitDir:storage.commonDir,privateDir:storage.gitDir,worktreePath:rootPath});return {rootMetadata:(value.rootMetadata??[]).map(node=>({...node})),absentPaths:(value.absentPaths??[]).map(node=>({...node})),directories:value.directories.map(node=>({...node})),files:value.files.map(({data,...node})=>({...node,size:data.length,sha256:createHash('sha256').update(data).digest('hex')})),links:value.links.map(node=>({...node}))};})();
 const directories=new Map([...graph.directories,...(graph.rootMetadata??[])].map(node=>[nativeKey(node.path),node])),files=new Map(graph.files.map(node=>[nativeKey(node.path),node])),links=new Map(graph.links.map(node=>[nativeKey(node.path),node]));
 const absentPaths=new Map((graph.absentPaths??[]).map(node=>[nativeKey(node.path),node]));
 const declared=new Set([...directories.keys(),...files.keys(),...links.keys(),...absentPaths.keys()]);
 for(const node of [...graph.directories,...graph.files,...graph.links,...(graph.absentPaths??[])]){assertOwned(node.root);assertOwned(node.path);if(!within(node.root,node.path)||node.root===node.path)throw new Error('External native node has no contained context');}
 for(const node of graph.rootMetadata??[]){assertOwned(node.path);if(nativeKey(node.root)!==nativeKey(node.path))throw new Error('External root metadata differs from its exact issued root');anchorDirectories.add(node.path);}
 for(const link of graph.links){assertOwned(link.targetRoot);assertOwned(link.target);if(!within(link.targetRoot,link.target)||!declared.has(nativeKey(link.target))||link.kind==='hardlink'&&!files.has(nativeKey(link.target)))throw new Error('External native alias is not closed over declared owned nodes');}
 for(const node of [...graph.directories,...graph.files,...graph.links,...(graph.absentPaths??[])])anchorDirectories.add(node.root);
 for(const node of [...graph.directories,...graph.files,...graph.links])await checkAncestry(path.dirname(node.path));
 const generatedNamespace=path.join(rootPath,'.ponderosa-portable-review','active-git-hooks'),generatedLinks=graph.links.filter(link=>link.kind==='symlink'&&nativeKey(path.dirname(link.path))===nativeKey(generatedNamespace));
 const generatedNodes=new Map<string,GeneratedHookIdentity>();
 if(generatedLinks.length){
  if(generatedLinks.some(link=>!/^[a-f0-9]{64}$/.test(path.basename(link.path))))throw new Error('Generated native hook name differs from its compiled view');
  await checkAncestry(generatedNamespace);anchorDirectories.add(generatedNamespace);
  const names=(await fs.readdir(generatedNamespace)).sort(),expected=generatedLinks.map(link=>path.basename(link.path)).sort();
  if(JSON.stringify(names)!==JSON.stringify(expected))throw new Error('Generated native hook namespace contains unexpected names');
 }
 for(const name of anchorDirectories)await checkAncestry(name);
 const checkAnchors=async()=>{for(const name of rootNames)await checkIssued(name);for(const name of anchorDirectories)await checkIssued(name);};
 await checkAnchors();
 const hardlinkTargets=new Map<string,string>(),expectedCounts=new Map<string,bigint>();
 for(const file of graph.files)expectedCounts.set(nativeKey(file.path),1n);
 for(const link of graph.links)if(link.kind==='hardlink'){hardlinkTargets.set(nativeKey(link.path),nativeKey(link.target));expectedCounts.set(nativeKey(link.target),(expectedCounts.get(nativeKey(link.target))??1n)+1n);}
 const pointerTargets=new Map(storage.modulePointers.map(item=>[item.path,{target:item.gitDir,prefix:'gitdir: '}]));
 const nativePointer=path.join(rootPath,'.git');
 if(storage.gitDir!==nativePointer)pointerTargets.set(nativePointer,{target:storage.gitDir,prefix:'gitdir: '});
 if(storage.gitDir!==storage.commonDir){pointerTargets.set(path.join(storage.gitDir,'commondir'),{target:storage.commonDir,prefix:''});pointerTargets.set(path.join(storage.gitDir,'gitdir'),{target:nativePointer,prefix:''});}
 for(const module of storage.moduleLayouts??[]){pointerTargets.set(path.join(module.gitDir,'commondir'),{target:module.commonDir,prefix:''});pointerTargets.set(path.join(module.gitDir,'gitdir'),{target:path.join(module.worktreePath,'.git'),prefix:''});}
 for(const [name,value] of pointerTargets){assertOwned(name);assertOwned(value.target);if(links.has(nativeKey(name)))throw new Error('Native repository pointers cannot become external aliases');}
 const plannedChildren=new Map<string,Set<string>>();
 for(const directory of graph.directories)for(const planned of [...storage.moduleGitDirs,storage.gitDir,storage.commonDir,...pointerTargets.keys()]){
  if(!within(directory.path,planned)||nativeKey(directory.path)===nativeKey(planned))continue;
  let current=directory.path;
  for(const part of path.relative(directory.path,planned).split(path.sep).filter(Boolean)){
   if([storage.gitDir,storage.commonDir,...storage.moduleGitDirs].some(root=>nativeKey(root)===nativeKey(current)))break;
   const child=path.join(current,part),key=nativeKey(current),allowed=plannedChildren.get(key)??new Set<string>();allowed.add(nativeKey(child));plannedChildren.set(key,allowed);current=child;
  }
 }
 const root=await fs.lstat(rootPath,{bigint:true});if(!root.isDirectory()||root.isSymbolicLink()||await fs.realpath(rootPath)!==rootPath)throw new Error('Imported Git root changed');
 const storageDirectories=new Set([storage.gitDir,storage.commonDir,...storage.moduleGitDirs].map(nativeKey));
 const entries:unknown[]=[{path:rootPath,device:root.dev,inode:root.ino}],seen=new Set<string>(),regular=new Map<string,{identity:string;nlink:bigint;path:string;observed:Parameters<typeof unchanged>[0]}>();let count=0;
 const recorded=new Set<string>(),symbolicObservations=new Map<string,Parameters<typeof unchanged>[0]>(),directoryObservations:Array<{path:string;device:bigint;inode:bigint;names:string[];observed:Parameters<typeof unchanged>[0]}> = [];
 for(const node of graph.rootMetadata??[]){await checkAncestry(node.path);const stat=await fs.lstat(node.path,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||!custody.metadataPending&&(Number(stat.mode&0o7777n)!==node.mode||String(stat.mtimeNs)!==node.mtimeNs))throw new Error('External issued root metadata differs');entries.push({path:node.path,kind:'root-metadata',device:stat.dev,inode:stat.ino,mode:stat.mode,mtimeNs:stat.mtimeNs});recorded.add(nativeKey(node.path));}
 const checkAbsence=async(name:string)=>{
  const owner=rootNames.find(root=>within(root,name));if(!owner)throw new Error('Native negative evidence has no issued root');let parent=owner;await checkIssued(parent);
  const parts=path.relative(owner,name).split(path.sep).filter(Boolean);
  for(let index=0;index<parts.length;index++){
   const next=path.join(parent,parts[index]!);let stat;
   try{stat=await fs.lstat(next,{bigint:true});}catch(error){if((error as {code?:string}).code==='ENOENT')return;throw error;}
   if(index===parts.length-1)throw new Error('Captured native negative-evidence target is no longer absent');
   if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Native negative evidence parent is not its issued directory');await checkIssued(next);parent=next;
  }
  throw new Error('Native negative evidence cannot name its root');
 };
 for(const node of graph.absentPaths??[]){await checkAbsence(node.path);entries.push({path:node.path,kind:'absent'});recorded.add(nativeKey(node.path));}
 const inspect=async(name:string):Promise<void>=>{
  if(seen.has(nativeKey(name)))return;seen.add(nativeKey(name));assertOwned(name);if(++count>30000)throw new Error('Imported Git inventory exceeds its bound');
  if(absentPaths.has(nativeKey(name)))throw new Error('Captured native negative-evidence target became present');
  if(issued.has(nativeKey(name)))await checkIssued(name);
  const stat=await fs.lstat(name,{bigint:true}),link=links.get(nativeKey(name)),file=files.get(nativeKey(name)),directory=directories.get(nativeKey(name));
  if(storageDirectories.has(nativeKey(name))&&!stat.isDirectory())throw new Error('Planned native Git storage is not its exact directory');
  if(link?.kind==='symlink'){
   if(!stat.isSymbolicLink()||stat.nlink!==1n)throw new Error('Declared native symlink identity or link count changed');
   const text=await fs.readlink(name),after=await fs.lstat(name,{bigint:true});
   if(text!==link.text||nativeKey(path.resolve(path.dirname(name),text))!==nativeKey(link.target)||!unchanged(stat,after)||link.mtimeNs!==undefined&&stat.mtimeNs.toString()!==link.mtimeNs)throw new Error('Declared native symlink target, timestamp or identity changed');
   if(generatedLinks.some(view=>nativeKey(view.path)===nativeKey(name)))generatedNodes.set(nativeKey(name),generatedIdentity(stat));
   entries.push({path:name,device:stat.dev,inode:stat.ino,kind:'symlink',target:text,mode:stat.mode,mtimeNs:stat.mtimeNs});recorded.add(nativeKey(name));symbolicObservations.set(name,stat);return;
  }
  if(stat.isSymbolicLink())throw new Error('Unexpected native symlink is outside the declared owned graph');
  if(stat.isDirectory()){
   if(file||link||pointerTargets.has(name)||await fs.realpath(name)!==name)throw new Error('Native directory type or canonical identity changed');
   if(!custody.metadataPending&&directory&&((Number(stat.mode)&0o7777)!==directory.mode||stat.mtimeNs.toString()!==directory.mtimeNs))throw new Error('Declared external directory metadata changed');
   const held=await fs.open(name,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);
   try{
    const before=await held.stat({bigint:true});if(before.dev!==stat.dev||before.ino!==stat.ino||!before.isDirectory())throw new Error('Native directory was replaced before observation');
    const names=(await fs.readdir(name)).sort();entries.push({path:name,device:stat.dev,inode:stat.ino,kind:'directory'});if(nativeKey(name)===nativeKey(generatedNamespace))generatedNodes.set(nativeKey(name),generatedIdentity(stat));
    for(const child of names){const target=path.join(name,child);if((directory&&!storageDirectories.has(nativeKey(name))||plannedChildren.has(nativeKey(name)))&&!declared.has(nativeKey(target))&&!plannedChildren.get(nativeKey(name))?.has(nativeKey(target)))throw new Error('Unexpected entry inside the declared external native graph');await inspect(target);}
    const after=await held.stat({bigint:true}),current=await fs.lstat(name,{bigint:true});
    if(before.dev!==after.dev||before.ino!==after.ino||before.dev!==current.dev||before.ino!==current.ino||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||await fs.realpath(name)!==name)throw new Error('Native directory changed during observation');
    directoryObservations.push({path:name,device:stat.dev,inode:stat.ino,names,observed:stat});
   }finally{await held.close();}
   if(directory)recorded.add(nativeKey(name));return;
  }
  const original=hardlinkTargets.get(nativeKey(name))??(file?nativeKey(name):undefined),expectedCount=original?expectedCounts.get(original)!:1n;
  if(!stat.isFile()||directory||link&&link.kind!=='hardlink'||stat.nlink!==expectedCount||stat.size>33554432n||await fs.realpath(path.dirname(name))!==path.dirname(name))throw new Error('Native file is not an exact exclusive or declared hardlinked regular original');
  const handle=await openPortableRegular(name);
  try{
   const before=await handle.stat({bigint:true});if(!before.isFile()||!unchanged(stat,before))throw new Error('Native regular original was replaced before its pinned data read');
   const hash=createHash('sha256'),buffer=Buffer.alloc(64*1024),pointer=pointerTargets.get(name),parts:Buffer[]=[];let offset=0;
   if(pointer&&before.size>4096n)throw new Error('Native repository pointer exceeds its bound');
   while(offset<Number(before.size)){const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,Number(before.size)-offset),offset);if(!bytesRead)throw new Error('Native regular original shortened during read');const bytes=buffer.subarray(0,bytesRead);hash.update(bytes);if(pointer)parts.push(Buffer.from(bytes));offset+=bytesRead;}
   const sha256=hash.digest('hex'),after=await handle.stat({bigint:true}),current=await fs.lstat(name,{bigint:true});
   if(!unchanged(before,after)||!unchanged(before,current))throw new Error('Native regular original changed during its pinned read');
   if(file&&(sha256!==file.sha256||Number(before.size)!==file.size||!custody.metadataPending&&((Number(before.mode)&0o7777)!==file.mode||before.mtimeNs.toString()!==file.mtimeNs)))throw new Error('Declared external native original bytes or metadata changed');
   if(pointer){let text=Buffer.concat(parts).toString('utf8');if(text.endsWith('\n'))text=text.slice(0,-1);if(!text.startsWith(pointer.prefix))throw new Error('Native repository pointer syntax changed');const target=text.slice(pointer.prefix.length);if(!target||/[\0\r\n]/.test(target)||nativeKey(path.resolve(path.dirname(name),target))!==nativeKey(pointer.target))throw new Error('Native repository pointer differs from its exact planned storage');}
   entries.push({path:name,device:before.dev,inode:before.ino,kind:'file',nlink:before.nlink,mode:before.mode,mtimeNs:before.mtimeNs,sha256});regular.set(nativeKey(name),{identity:inode(before),nlink:before.nlink,path:name,observed:before});if(file||link)recorded.add(nativeKey(name));
  }finally{await handle.close();}
 };
 await inspect(nativePointer);await inspect(storage.commonDir);await inspect(storage.gitDir);
 if(generatedLinks.length)await inspect(generatedNamespace);
 for(const name of storage.moduleGitDirs)await inspect(name);
 for(const pointer of storage.modulePointers)await inspect(pointer.path);
 for(const node of [...graph.directories,...graph.files,...graph.links].sort((a,b)=>a.path.localeCompare(b.path)))await inspect(node.path);
 for(const name of declared)if(!recorded.has(name))throw new Error('Declared external native graph is incomplete');
 for(const link of graph.links)if(link.kind==='hardlink'){const original=regular.get(nativeKey(link.target)),alias=regular.get(nativeKey(link.path));if(!original||!alias||original.identity!==alias.identity||original.nlink!==expectedCounts.get(nativeKey(link.target))||alias.nlink!==original.nlink)throw new Error('Declared native hardlink group identity/count differs');}
 for(const [name] of pointerTargets)if(!regular.has(nativeKey(name)))throw new Error('Native pointer original is absent');
 for(const value of regular.values())if(!unchanged(value.observed,await fs.lstat(value.path,{bigint:true})))throw new Error('Native regular identity or complete hardlink count changed before proof completion');
 for(const [name,observed] of symbolicObservations)if(!unchanged(observed,await fs.lstat(name,{bigint:true}))||await fs.readlink(name)!==links.get(nativeKey(name))!.text)throw new Error('Declared native symlink changed before proof completion');
 for(const observed of directoryObservations){const current=await fs.lstat(observed.path,{bigint:true});if(!current.isDirectory()||!unchanged(observed.observed,current)||current.dev!==observed.device||current.ino!==observed.inode||await fs.realpath(observed.path)!==observed.path||JSON.stringify((await fs.readdir(observed.path)).sort())!==JSON.stringify(observed.names))throw new Error('Native directory inventory changed before proof completion');}
 for(const node of graph.absentPaths??[])await checkAbsence(node.path);
 await checkAnchors();for(const name of anchorDirectories)await checkAncestry(name);
 const after=await fs.lstat(rootPath,{bigint:true});if(root.dev!==after.dev||root.ino!==after.ino)throw new Error('Imported Git root replaced');
 let generatedHooks:LocalGeneratedHooksProof|undefined;
 if(generatedLinks.length){const namespace=generatedNodes.get(nativeKey(generatedNamespace));if(!namespace)throw new Error('Generated native hook namespace was not included in its readable seal');generatedHooks={schema:'ponderosa.generated-hook-namespace.v1',root:{device:String(root.dev),inode:String(root.ino)},namespace,links:generatedLinks.map(link=>{const identity=generatedNodes.get(nativeKey(link.path));if(!identity)throw new Error('Generated native hook link was not included in its readable seal');return {name:path.basename(link.path),text:link.text,identity};}).sort((a,b)=>a.name.localeCompare(b.name))};}
 return {snapshot:JSON.stringify(entries,(_key,value)=>typeof value==='bigint'?value.toString():value),external:graph,...(generatedHooks?{generatedHooks}:{})};
}

/** Controlled final metadata changes do not require a forbidden content reopen.
 * Each update is bound to the readable seal's exact inode/hash/count and the
 * native finalizer's just-observed result. Later verification always rereads. */
export function finalizeImportedNativeSnapshot(observed:ImportedNativeSnapshot,metadata:WorkingNativeMetadata):ImportedNativeSnapshot {
 const entries=JSON.parse(observed.snapshot) as Array<Record<string,unknown>>,files=new Map([...metadata.files].map(([name,value])=>[nativeKey(name),value])),directories=new Map([...metadata.directories].map(([name,value])=>[nativeKey(name),value]));
 const byPath=new Map<string,Record<string,unknown>>();
 for(const entry of entries){
  const name=String(entry.path),key=nativeKey(name);byPath.set(key,entry);
  const file=files.get(key);if(file&&entry.kind==='file'){
   if(String(entry.device)!==file.device||String(entry.inode)!==file.inode||entry.sha256!==file.sha256||String(entry.nlink)!==file.expectedLinkCount)throw new Error('Final native file metadata no longer matches the readable owned seal');
   entry.mode=((BigInt(String(entry.mode))&~0o7777n)|BigInt(file.mode)).toString();entry.mtimeNs=file.mtimeNs;
  }
  const directory=directories.get(key);if(directory&&(entry.kind==='directory'||entry.kind==='root-metadata'||entry.kind===undefined)){
   if(String(entry.device)!==directory.device||String(entry.inode)!==directory.inode)throw new Error('Final native directory metadata no longer matches the readable owned seal');
   if(entry.kind==='root-metadata'){entry.mode=((BigInt(String(entry.mode))&~0o7777n)|BigInt(directory.mode)).toString();entry.mtimeNs=directory.mtimeNs;}
  }
 }
 for(const file of observed.external.files){const proof=files.get(nativeKey(file.path)),entry=byPath.get(nativeKey(file.path));if(!proof||!entry||proof.sha256!==file.sha256||proof.mode!==file.mode||proof.mtimeNs!==file.mtimeNs||String(entry.device)!==proof.device||String(entry.inode)!==proof.inode)throw new Error('External native original lacks exact final metadata readback');}
 for(const directory of [...observed.external.directories,...(observed.external.rootMetadata??[])]){const proof=directories.get(nativeKey(directory.path)),entry=byPath.get(nativeKey(directory.path));if(!proof||!entry||proof.mode!==directory.mode||proof.mtimeNs!==directory.mtimeNs||String(entry.device)!==proof.device||String(entry.inode)!==proof.inode)throw new Error('External native directory lacks exact final metadata readback');}
 let generatedHooks=observed.generatedHooks;
 if(generatedHooks){
  generatedHooks=structuredClone(generatedHooks);const namespacePath=path.join(String(entries[0]!.path),'.ponderosa-portable-review','active-git-hooks'),proof=directories.get(nativeKey(namespacePath));
  if(proof){
   if(generatedHooks.namespace.device!==proof.device||generatedHooks.namespace.inode!==proof.inode||proof.ctimeNs===undefined)throw new Error('Final generated hook namespace no longer matches its exact readable/readback seal');
   generatedHooks.namespace.mode=((BigInt(generatedHooks.namespace.mode)&~0o7777n)|BigInt(proof.mode)).toString();generatedHooks.namespace.mtimeNs=proof.mtimeNs;generatedHooks.namespace.ctimeNs=proof.ctimeNs;
   const full=proof as typeof proof&{uid?:string;gid?:string;size?:string;nlink?:string};
   if(metadata.deferredMetadata.has(namespacePath)&&![full.uid,full.gid,full.size,full.nlink].every(value=>typeof value==='string'))throw new Error('Generated hook namespace selected attributes lack complete final identity readback');
   for(const name of ['uid','gid','size','nlink'] as const)if(full[name]!==undefined)generatedHooks.namespace[name]=full[name]!;
  }
  if(metadata.deferredMetadata.has(namespacePath)&&!proof)throw new Error('Generated hook namespace selected metadata lacks exact final readback');
 }
 return {snapshot:JSON.stringify(entries),external:observed.external,...(generatedHooks?{generatedHooks}:{})};
}
