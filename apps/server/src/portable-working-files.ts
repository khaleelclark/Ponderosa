import {AGENT_PACKAGE_MAX_BYTES,agentPackageJsonUtf8Bytes} from "@ponderosa/core";
import {encodePortableArtifactData} from "./agent-package-codec.js";
import {constants} from 'node:fs';
import {promises as fs} from '@ponderosa/native-host/fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {PortableArtifactDto,PortableWorkingLinkDto,ReviewedUserDataSelection} from '@ponderosa/core';
import {assertPortableSecretsAbsent} from './portable-secrets.js';
import {captureRetainedReviewOriginal,selectedReviewedGitStorage,exportReviewedUserData,parseReviewedUserData,recreateReviewedGit,REVIEWED_USER_DATA_PATH,type GitExportCapture} from './portable-reviewed-user-data.js';

export function portableWorkingPath(value:unknown):string {
  if(typeof value!=='string'||!value||value.includes('\\')||value.includes('\0')||value.includes(':')||value.startsWith('/')||value.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Select relative regular-file paths inside the working folder');
  if(value.split('/').some(p=>['.git','.mcp.json','.ponderosa-import-backups','.ssh','.aws','.gnupg','.codex','.claude','browser-profiles'].includes(p)||/^\.env(?:\.|$)/i.test(p)||/^(?:credentials(?:\.json)?|auth\.json|.*\.(?:pem|key|p12))$/i.test(p)))throw new Error(`Known credential/native ownership path cannot be exported: ${value}`);
  return value;
}

/** Relative symbolic targets retain their spelling, including dangling in-root targets. */
export function portableLinkTarget(link:PortableWorkingLinkDto):string {
  portableWorkingPath(link.path);
  if(!['symlink','hardlink'].includes(link.kind)||typeof link.target!=='string'||!link.target||link.target.includes('\\')||link.target.includes('\0')||link.target.includes(':')||path.posix.isAbsolute(link.target))throw new Error('Working links require relative in-root targets');
  if(link.target.length>10000)throw new Error('Working-link target exceeds its finite bound');
  for(const part of link.target.split('/'))if(part&&part!=='.'&&part!=='..')portableWorkingPath(part);
  const resolved=link.kind==='hardlink'?portableWorkingPath(link.target):path.posix.normalize(path.posix.join(path.posix.dirname(link.path),link.target));
  if(resolved!=='.')portableWorkingPath(resolved);
  if(link.mtime!==undefined&&(typeof link.mtime!=='string'||!Number.isFinite(Date.parse(link.mtime))))throw new Error('Invalid working-link timestamp');
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
    if(link.kind==='hardlink'&&!files.some(file=>file.path===link.target))throw new Error('Hardlinks require an included regular original');
    leaves.add(link.path);
  }
  const symbolic=new Map(links.filter(link=>link.kind==='symlink').map(link=>[link.path,link.target]));
  for(const link of links.filter(link=>link.kind==='symlink')){
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
export async function exportWorkingFiles(rootPath:string,selected:readonly string[],maxBytes:number,links:readonly PortableWorkingLinkDto[]=[],reviewedSelection?:ReviewedUserDataSelection,retainedOriginal?:{data:Buffer;mode?:number;mtime?:string},gitCapture?:GitExportCapture):Promise<{files:Array<{path:string;artifactRef:string;mode?:number;mtime?:string}>;artifacts:PortableArtifactDto[];bytes:number}> {
  const root=await fs.realpath(rootPath),files:Array<{path:string;artifactRef:string;mode?:number;mtime?:string}>=[],artifacts:PortableArtifactDto[]=[];
  const gitStorage=gitCapture?gitCapture.exclusions(root):reviewedSelection?.git&&reviewedSelection.source!=='retained_originals'?await selectedReviewedGitStorage(root):[];
  if(selected.some(name=>gitStorage.some(storage=>storage==='.'||name===storage||name.startsWith(storage+'/'))))throw new Error('Selected Git storage cannot also be exported as ordinary working files');
  const retained=reviewedSelection?.source==='retained_originals'?await captureRetainedReviewOriginal(root,reviewedSelection,retainedOriginal?.data??Buffer.alloc(0)):undefined;
  validateWorkingTopology([...selected.map(path=>({path})),...(reviewedSelection?[{path:REVIEWED_USER_DATA_PATH}]:[])],[],links,'passive_in_root');
  const verifyLinks=async()=>{for(const link of links){
    const name=path.join(root,link.path);
    if(await fs.realpath(path.dirname(name))!==path.dirname(name))throw new Error('Working-link parent changed');
    const stat=await fs.lstat(name,{bigint:true});
    if(link.kind==='symlink'){if(!stat.isSymbolicLink()||await fs.readlink(name)!==link.target||link.mtime!==undefined&&stat.mtime.toISOString()!==link.mtime)throw new Error('Working symlink changed during export');}
    else {const target=await fs.lstat(path.join(root,link.target),{bigint:true});if(!stat.isFile()||stat.dev!==target.dev||stat.ino!==target.ino)throw new Error('Working hardlink changed during export');}
  }};
  await verifyLinks();
  let bytes=0,wireBytes=0;
  if(selected.length>10000||new Set(selected).size!==selected.length)throw new Error('Select at most 10000 distinct working files');
  for(const item of selected){
    const relative=portableWorkingPath(item),parts=relative.split('/');
    let current=root;
    for(const part of parts){current=path.join(current,part);if((await fs.lstat(current)).isSymbolicLink())throw new Error(`Working-file symlinks are not portable originals: ${relative}`);}
    const handle=await fs.open(current,constants.O_RDONLY|constants.O_NOFOLLOW);
    let data:Buffer,mode:number,mtime:string;
    try{
      const before=await handle.stat({bigint:true});
      if(!before.isFile()||before.nlink!==BigInt(1+links.filter(link=>link.kind==='hardlink'&&link.target===relative).length)||before.size>BigInt(Math.min(maxBytes-bytes,64*1024*1024)))throw new Error(`Working file lacks a bounded complete regular-link inventory: ${relative}`);
      if(await fs.realpath(path.dirname(current))!==path.dirname(current))throw new Error('Working-file directory changed during export');
      data=Buffer.alloc(Number(before.size));let offset=0;
      while(offset<data.length){const read=await handle.read(data,offset,data.length-offset,offset);if(!read.bytesRead)throw new Error(`Working file shortened during export: ${relative}`);offset+=read.bytesRead;}
      mode=Number(before.mode)&0o777;mtime=new Date(Number(before.mtimeMs)).toISOString();
      const after=await handle.stat({bigint:true});
      if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||BigInt(data.length)!==before.size)throw new Error(`Working file changed during export: ${relative}`);
    }finally{await handle.close();}
    validateWorkingFileData(relative,data);
    for(const link of links.filter(link=>link.kind==='hardlink'&&link.target===relative))validateWorkingFileData(link.path,data);
    bytes+=data.length;if(bytes>maxBytes)throw new Error('Selected working files exceed the portable artifact limit');
    const ref=randomUUID();files.push({path:relative,artifactRef:ref,mode:mode!,mtime:mtime!});
    const artifact:PortableArtifactDto={ref,kind:'document',path:relative,summary:relative,createdAt:new Date().toISOString(),mediaType:'application/octet-stream',...await encodePortableArtifactData(data)};
    wireBytes+=agentPackageJsonUtf8Bytes(artifact);
    if(wireBytes>AGENT_PACKAGE_MAX_BYTES)throw Object.assign(new Error('Selected working files exceed the serialized package byte limit; no originals were omitted'),{statusCode:413});
    artifacts.push(artifact);
  }
  await verifyLinks();
  if(reviewedSelection){
    const data=retained?.data??Buffer.from(JSON.stringify(await exportReviewedUserData(root,reviewedSelection,gitCapture)));
    await retained?.verify();
    parseReviewedUserData(data);
    if(gitCapture&&reviewedSelection.git)gitCapture.bindReview(root,data);
    bytes+=data.length;if(bytes>maxBytes)throw new Error('Reviewed Git/provider data exceeds the portable artifact limit');
    const ref=randomUUID();files.push({path:REVIEWED_USER_DATA_PATH,artifactRef:ref,mode:retainedOriginal?.mode??0o600,...(retainedOriginal?.mtime?{mtime:retainedOriginal.mtime}:{})});
    artifacts.push({ref,kind:'document',path:REVIEWED_USER_DATA_PATH,summary:'Inert Git and provider configuration review',createdAt:new Date().toISOString(),mediaType:'application/json',dataBase64:data.toString('base64')});
  }
  return {files,artifacts,bytes};
}

/** Exclusively create a new user-selected folder. Failure retains every byte for recovery. */
export async function importWorkingFiles(destination:string,files:readonly {path:string;data:Buffer;sha256:string;mode?:number;mtime?:string}[],directories:readonly {path:string;mode:number;mtime:string}[]=[],rootMetadata?:{mode:number;mtime:string},freshRoot?:{backupRoot:string},links:readonly PortableWorkingLinkDto[]=[],cyclicLinks:'refuse'|'passive_in_root'='refuse'):Promise<void>{
  validateWorkingTopology(files,directories,links,cyclicLinks);
  const reviewedFile=files.find(file=>file.path===REVIEWED_USER_DATA_PATH);
  if(reviewedFile&&createHash('sha256').update(reviewedFile.data).digest('hex')!==reviewedFile.sha256)throw new Error('Reviewed user-data identity changed');
  const reviewedData=reviewedFile?parseReviewedUserData(reviewedFile.data):undefined;
  if(reviewedData?.recreationScope.cyclicLinks==='refuse')validateWorkingTopology(files,directories,links,'refuse');
  for(const link of links.filter(link=>link.kind==='hardlink'))validateWorkingFileData(link.path,files.find(file=>file.path===link.target)!.data);
  if(!path.isAbsolute(destination)||path.resolve(destination)!==destination)throw new Error('Choose an absolute new working-files destination');
  const parent=await fs.realpath(path.dirname(destination));
  if(parent!==path.dirname(destination))throw new Error('Working-files destination parent must be canonical');
  if(freshRoot){
    if(await fs.realpath(destination)!==destination)throw new Error('Fresh working root must be canonical');
    if(freshRoot.backupRoot!==path.join(destination,'.ponderosa-import-backups'))throw new Error('Invalid fresh-root recovery folder');
    await fs.mkdir(freshRoot.backupRoot,{mode:0o700});
    if(await fs.realpath(freshRoot.backupRoot)!==freshRoot.backupRoot)throw new Error('Recovery folder changed');
  }else await fs.mkdir(destination,{mode:0o700});
  const preserveBaseline=async(relative:string)=>{
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
  };
  try{
    for(const folder of [...directories].sort((a,b)=>a.path.split('/').length-b.path.split('/').length)){
      const relative=portableWorkingPath(folder.path);
      const target=path.join(destination,relative);
      try{await fs.mkdir(target,{mode:0o700});}catch(error){if(!freshRoot||(error as NodeJS.ErrnoException).code!=='EEXIST'||!(await fs.lstat(target)).isDirectory())throw error;}
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
      await preserveBaseline(relative);
      const handle=await fs.open(path.join(destination,relative),'wx',0o600);
      try{await handle.writeFile(file.data);if(file.mode!==undefined)await handle.chmod(file.mode&0o777);if(file.mtime)await handle.utimes(new Date(file.mtime),new Date(file.mtime));await handle.sync();}finally{await handle.close();}
    }
    for(const link of [...links].sort((a,b)=>(a.kind==='hardlink'?0:1)-(b.kind==='hardlink'?0:1))){
      const target=path.join(destination,link.path),parent=path.dirname(target);
      let current=destination;
      for(const component of link.path.split('/').slice(0,-1)){
        current=path.join(current,component);
        try{await fs.mkdir(current,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
        if(!(await fs.lstat(current)).isDirectory()||await fs.realpath(current)!==current)throw new Error('Working-link destination parent changed');
      }
      if(await fs.realpath(parent)!==parent)throw new Error('Working-link destination parent changed');
      await preserveBaseline(link.path);
      if(link.kind==='hardlink'){
        const original=path.join(destination,link.target),stat=await fs.lstat(original);
        if(!stat.isFile()||stat.isSymbolicLink()||await fs.realpath(original)!==original)throw new Error('Hardlink original changed');
        await fs.link(original,target);
      }else{
        await fs.symlink(link.target,target);
        if(link.mtime)await fs.lutimes(target,new Date(link.mtime),new Date(link.mtime));
      }
    }
    if(reviewedData){
      // Separate repository only: never overwrite this working root's native-owned .git or provider settings.
      if(reviewedData.git)await recreateReviewedGit(path.join(destination,'.ponderosa-portable-review','git-repository'),reviewedData.git);
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
    for(const folder of [...directories].sort((a,b)=>b.path.split('/').length-a.path.split('/').length)){
      const target=path.join(destination,portableWorkingPath(folder.path));
      if(await fs.realpath(target)!==target)throw new Error('Destination directory changed');
      await fs.chmod(target,folder.mode&0o777);await fs.utimes(target,new Date(folder.mtime),new Date(folder.mtime));
    }
    if(rootMetadata){await fs.chmod(destination,rootMetadata.mode&0o777);await fs.utimes(destination,new Date(rootMetadata.mtime),new Date(rootMetadata.mtime));}
  }catch(error){throw new Error(`Working-files import incomplete; retained files at ${destination}: ${(error as Error).message}`,{cause:error});}
}

/** Explicit whole-folder selection. Omit native ownership/credential paths and report every omission. */
export async function inventoryWorkingFolder(rootPath:string,reviewedSelection?:ReviewedUserDataSelection,gitCapture?:GitExportCapture):Promise<{mode:number;mtime:string;paths:string[];directories:Array<{path:string;mode:number;mtime:string}>;excludedPaths:string[];links:PortableWorkingLinkDto[]}> {
  const root=await fs.realpath(rootPath),paths:string[]=[],directories:Array<{path:string;mode:number;mtime:string}>=[],excludedPaths:string[]=[];
  const gitStorage=gitCapture?gitCapture.exclusions(root):reviewedSelection?.git&&reviewedSelection.source!=='retained_originals'?await selectedReviewedGitStorage(root):[];
  const links:PortableWorkingLinkDto[]=[],originals=new Map<string,{path:string;nlink:bigint;count:number}>();
  let entries=0;
  const walk=async(relative:string):Promise<void>=>{
    const directory=relative?path.join(root,relative):root;
    if(await fs.realpath(directory)!==directory)throw new Error('Working folder changed during inventory');
    const before=await fs.lstat(directory,{bigint:true});
    for(const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      if(++entries>10000)throw new Error('Whole working folder exceeds 10000 entries');
      const name=relative?`${relative}/${entry.name}`:entry.name;
      if(gitStorage.includes('.')||gitStorage.includes(name)){excludedPaths.push(name);continue;}
      if(name==='.ponderosa-portable-review'){
        if(reviewedSelection?.source!=='retained_originals')throw new Error('Existing imported review data requires explicit retained-original selection');
        const folder=path.join(root,name),stat=await fs.lstat(folder);
        if(!stat.isDirectory()||await fs.realpath(folder)!==folder)throw new Error('Retained review directory must be canonical');
        for(const child of await fs.readdir(folder)){
          if(!['user-data.json','git-repository','provider-files'].includes(child))throw new Error('Unknown retained review namespace contents require separate preservation');
          if(child!=='user-data.json')excludedPaths.push(`${name}/${child}`);
        }
        continue;
      }
      try{portableWorkingPath(name);}catch{excludedPaths.push(name);continue;}
      const stat=await fs.lstat(path.join(root,name),{bigint:true});
      if(stat.isSymbolicLink()){const link:PortableWorkingLinkDto={path:name,kind:'symlink',target:await fs.readlink(path.join(root,name)),mtime:stat.mtime.toISOString()};portableLinkTarget(link);links.push(link);continue;}
      if(!stat.isDirectory()&&!stat.isFile())throw new Error(`Live socket/device/FIFO has no portable regular bytes; preserve and recreate explicitly: ${name}`);
      if(stat.isDirectory()){
        directories.push({path:name,mode:Number(stat.mode)&0o777,mtime:stat.mtime.toISOString()});
        await walk(name);
      }else {
        const key=`${stat.dev}:${stat.ino}`,original=originals.get(key);
        if(original){if(original.nlink!==stat.nlink)throw new Error('Hardlink topology changed');original.count++;links.push({path:name,kind:'hardlink',target:original.path});}
        else {originals.set(key,{path:name,nlink:stat.nlink,count:1});paths.push(name);}
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
  return {mode:rootStat.mode&0o777,mtime:rootStat.mtime.toISOString(),paths,directories,excludedPaths,links};
}
