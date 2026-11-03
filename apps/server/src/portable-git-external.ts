import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {promises as fs} from '@ponderosa/native-host/fs';
import {DataDirectoryReadReference} from '@ponderosa/native-host';
import {homedir} from 'node:os';
import path from 'node:path';
import type {ReviewedGitExternalDependencies,ReviewedGitUserData,ReviewedUserData} from '@ponderosa/core';
import {withoutPortableSecrets} from './portable-secrets.js';
import {openPortableRegular} from './portable-held-regular.js';
import {serializeSourcePath,sourcePathAbsolute,normalizeSourcePath,resolveSourcePath,relativeSourcePath,sourcePathWithin,sourcePathKey} from './portable-source-paths.js';

type Configuration={data:Buffer;items:ReviewedGitUserData['configurationReview']};
type Readers={parseConfiguration:(data:Buffer)=>Configuration;exportGit:(root:string)=>Promise<{git:ReviewedGitUserData;gitOriginals:ReviewedUserData['providerFiles']}|undefined>};
const maxBytes=32*1024*1024,maxEntries=10000;
const stamp=(stat:{dev:bigint;ino:bigint;mode:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint})=>[stat.dev,stat.ino,stat.mode,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
const privatePath=(name:string)=>name.split(/[\\/]/).some(part=>['.ssh','.aws','.gnupg','browser-profiles'].includes(part.toLowerCase())||/^\.env(?:\.|$)/i.test(part)||/^(?:credentials(?:\.json)?|auth\.json|.*\.p12)$/i.test(part));
async function readBounded(handle:Awaited<ReturnType<typeof fs.open>>,size:bigint):Promise<Buffer>{
  if(size<0n||size>BigInt(maxBytes))throw new Error('Configured Git dependency exceeds its read bound');
  const data=Buffer.alloc(Number(size)+1);let position=0;
  while(position<data.length){const read=await handle.read(data,position,data.length-position,position);if(!read.bytesRead)break;position+=read.bytesRead;}
  if(position!==Number(size))throw new Error('Configured Git dependency changed size during bounded read');
  return data.subarray(0,position);
}
const openDependency=(name:string)=>process.platform==='linux'?openPortableRegular(name):fs.open(name,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
/** Git expands its own named-user/install-prefix syntax from captured config
 * bytes. --no-includes and stdin prevent reads of referenced source configs. */
async function expandNativeConfigurationPath(data:Buffer,key:string,ordinal:number,cwd:string):Promise<string>{
  const values=await new Promise<Buffer>((resolve,reject)=>{
    const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('GIT_')));
    const child=spawn('git',['config','--no-includes','--file','-','--path','--null','--get-all',key],{cwd,env:{...env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0'},stdio:['pipe','pipe','pipe'],windowsHide:true});
    const chunks:Buffer[]=[];let size=0,settled=false;
    const fail=(cause:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);child.kill();reject(Object.assign(new Error('Git could not prove configured source path expansion',{cause}),{code:'ERR_GIT_SOURCE_PATH_EXPANSION'}));};
    const timer=setTimeout(()=>fail(new Error('Native Git path expansion exceeded 30 seconds')),30000);
    child.on('error',fail);child.stdin.on('error',fail);child.stderr.resume();
    child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1024*1024)fail(new Error('Native Git path expansion exceeded its output bound'));else chunks.push(chunk);});
    child.on('close',(code,signal)=>{if(settled)return;settled=true;clearTimeout(timer);if(code!==0)reject(Object.assign(new Error('Git rejected the captured source path expansion'),{code:'ERR_GIT_SOURCE_PATH_EXPANSION',exitCode:code,signal}));else resolve(Buffer.concat(chunks));});
    child.stdin.end(data);
  });
  const rows=values.toString('utf8').split('\0');if(rows.at(-1)==='')rows.pop();const value=rows[ordinal];
  if(value===undefined||!Buffer.from(values.toString('utf8')).equals(values)||!path.isAbsolute(value)||Buffer.byteLength(value)>4096||/[\x00-\x1f\x7f]/.test(value))throw new Error('Native Git did not produce one exact absolute portable source expansion');
  return value;
}

/** Explicit current capture only. The corresponding import consumes these bytes, never these host paths. */
export async function captureGitExternalDependencies(root:string,git:ReviewedGitUserData,allowExternal:boolean,readers:Readers):Promise<ReviewedGitExternalDependencies|undefined> {
  const result:ReviewedGitExternalDependencies={version:1,sourceWorkingRoot:serializeSourcePath(root),files:[],directories:[],links:[],absentPaths:[],omittedPaths:[],bindings:[]};
  const configurationDirectories=git.configurationSourceDirectories;
  const common=configurationDirectories?.common??serializeSourcePath(path.join(root,'.git')),privateDir=configurationDirectories?.private??common;
  const selected=[serializeSourcePath(root),common,privateDir];
  const files=new Map<string,{record:ReviewedGitExternalDependencies['files'][number];raw:Buffer}>(),directories=new Map<string,ReviewedGitExternalDependencies['directories'][number]>(),visited=new Set<string>(),configurations=new Set<string>(),identities=new Map<string,{native:string;stamp:string;hash?:string;target?:string}>(),inodes=new Map<string,string>();
  const pins=new Map<string,{native:string;handle?:Awaited<ReturnType<typeof fs.open>>;reference?:DataDirectoryReadReference;path:string;stamp:string}>();
  const repositories=new Map<string,{native:string;git:ReviewedGitUserData;originals:ReviewedUserData['providerFiles']}>(),knownRepositories=new Set([sourcePathKey(serializeSourcePath(root))]),knownModules=new Set<string>();
  const configurationAbsences=new Set<string>();
  let bytes=0,entries=0;
  const allowed=(name:string)=>allowExternal||selected.some(parent=>sourcePathWithin(parent,name));
  const pin=async(native:string)=>{
    const canonical=await fs.realpath(native);if(privatePath(serializeSourcePath(canonical)))throw new Error('Git dependency parent resolves into excluded credential storage');const prior=pins.get(canonical);if(prior)return prior;
    const before=await fs.lstat(canonical,{bigint:true});if(!before.isDirectory())throw new Error('Git dependency parent is not a directory: '+canonical);
    const held:typeof pins extends Map<string,infer T>?T:never={native:canonical,path:canonical,stamp:stamp(before)};
    // Ownership begins before the first fallible descriptor inspection.
    pins.set(canonical,held);
    if(process.platform==='linux'){held.handle=await fs.open(canonical,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);held.path='/proc/self/fd/'+held.handle.fd;}
    else{held.reference=new DataDirectoryReadReference(canonical);held.path=held.reference.rootPath;}
    const observed=held.handle?await held.handle.stat({bigint:true}):await fs.lstat(held.path,{bigint:true});if(observed.dev!==before.dev||observed.ino!==before.ino)throw new Error('Git dependency parent changed while acquiring its read reference');
    return held;
  };
  const checkParents=async()=>{for(const held of pins.values()){const current=await fs.lstat(held.native,{bigint:true}),retained=held.handle?await held.handle.stat({bigint:true}):await fs.lstat(held.path,{bigint:true});if(current.dev!==retained.dev||current.ino!==retained.ino||!current.isDirectory()||await fs.realpath(held.native)!==held.native)throw new Error('Git dependency parent membership changed: '+held.native);}};
  const safeData=(data:Buffer,name=''):Buffer=>{
    const text=data.toString('utf8');
    if(/-----BEGIN (?:(?:[A-Z0-9]+ )*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/.test(text))throw new Error('Configured Git dependency contains a private key; re-enter it on the destination');
    if(/\.(?:key|pem)$/i.test(name)&&!/-----BEGIN (?:RSA )?PUBLIC KEY-----|-----BEGIN CERTIFICATE-----/.test(text))throw new Error('Configured Git key material must be re-entered on the destination; public PEM certificates and keys are supported');
    if(!Buffer.from(text).equals(data)||!/^\s*[\[{]/.test(text))return data;
    try{const value=JSON.parse(text),safe=withoutPortableSecrets(value,maxBytes);return JSON.stringify(value)===JSON.stringify(safe)?data:Buffer.from(JSON.stringify(safe,null,2)+'\n');}catch(error){if(error instanceof SyntaxError)return data;throw error;}
  };
  const moduleRoots=(value:ReviewedGitUserData)=>{for(const module of value.modules??[]){knownModules.add(sourcePathKey(module.source.worktreePath));moduleRoots(module.git);}};moduleRoots(git);
  const nativeName=(name:string)=>process.platform==='win32'?path.win32.normalize(name):name;
  const capturedFile=(name:string)=>{
    let current=name;const seen=new Set<string>();
    for(let depth=0;depth<128;depth++){
      const key=sourcePathKey(current);if(seen.has(key))return undefined;seen.add(key);
      const file=files.get(key);if(file)return file;
      const link=[...result.links].filter(link=>sourcePathWithin(link.sourcePath,current)).sort((a,b)=>b.sourcePath.length-a.sourcePath.length)[0];
      if(!link)return undefined;current=resolveSourcePath(link.targetSourcePath,relativeSourcePath(link.sourcePath,current));
    }
    throw new Error('Git dependency alias chain exceeds its documented bound');
  };
  // Retain actual parent-link nodes so a literal config path can be proved against
  // the canonical leaf without inventing a whole-path alias.
  const observeParentAliases=async(native:string):Promise<void>=>{
    const absolute=path.resolve(path.dirname(native));let cursor=path.parse(absolute).root,pending=absolute.slice(cursor.length).split(path.sep).filter(Boolean),hops=0;
    while(pending.length){
      const part=pending.shift()!,parent=await pin(cursor),candidate=path.join(parent.path,part),named=path.join(parent.native,part);
      let stat;try{stat=await fs.lstat(candidate,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
      if(stat.isSymbolicLink()){
        if(++hops>128)throw new Error('Git dependency parent alias chain exceeds its bound');
        const raw=await fs.readlink(candidate),target=path.resolve(parent.native,raw),source=serializeSourcePath(named),key=sourcePathKey(source);
        if(privatePath(serializeSourcePath(target)))throw new Error('Configured Git dependency parent resolves into excluded credential storage');
        if(!visited.has(key)){if(++entries>maxEntries)throw new Error('Git dependency inventory exceeds 10000 entries');visited.add(key);result.links.push({sourcePath:source,targetSourcePath:serializeSourcePath(target),kind:'symlink',mtimeNs:stat.mtimeNs.toString()});identities.set(key,{native:named,stamp:stamp(stat),target:raw});}
        const full=path.resolve(target,...pending);cursor=path.parse(full).root;pending=full.slice(cursor.length).split(path.sep).filter(Boolean);
      }else{if(!stat.isDirectory())throw new Error('Configured Git dependency parent is not a directory');cursor=named;}
    }
  };
  const walk=async(native:string,asConfiguration=false,wholeDirectory=false,depth=0):Promise<string|undefined>=>{
    if(depth>128)throw new Error('Git dependency link/directory nesting exceeds its documented bound');
    const source=serializeSourcePath(path.resolve(native));
    if(Buffer.byteLength(source)>4096||/[\x00-\x1f\x7f]/.test(source))throw new Error('Configured Git dependency path exceeds its portable provenance bound');
    if(privatePath(source)){result.omittedPaths.push(source);return undefined;}
    if(!allowed(source)){result.omittedPaths.push(source);return undefined;}
    await observeParentAliases(native);
    let parent;try{parent=await pin(path.dirname(native));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){result.absentPaths.push(source);return source;}throw error;}
    const target=path.join(parent.path,path.basename(native)),canonical=serializeSourcePath(path.join(parent.native,path.basename(native)));
    if(privatePath(canonical)||!allowed(canonical)){result.omittedPaths.push(canonical);return undefined;}
    let before;try{before=await fs.lstat(target,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){result.absentPaths.push(canonical);return canonical;}throw error;}
    if(++entries>maxEntries)throw new Error('Git dependency inventory exceeds 10000 entries');
    const key=sourcePathKey(canonical);
    if(before.isSymbolicLink()){
      const raw=await fs.readlink(target),destination=serializeSourcePath(path.resolve(parent.native,raw));
      if(Buffer.byteLength(raw)>4096)throw new Error('Git dependency symbolic target exceeds its bound');
      if(!visited.has(key)){visited.add(key);result.links.push({sourcePath:canonical,targetSourcePath:destination,kind:'symlink',mtimeNs:before.mtimeNs.toString()});identities.set(key,{native:path.join(parent.native,path.basename(native)),stamp:stamp(before),target:raw});
        await walk(nativeName(destination),asConfiguration,wholeDirectory,depth+1);}
      else if(asConfiguration){const existing=capturedFile(canonical);if(existing&&!existing.record.config){const parsed=readers.parseConfiguration(existing.raw);existing.record.dataBase64=parsed.data.toString('base64');existing.record.config=true;if(!parsed.data.equals(existing.raw))existing.record.removedSecretFields=true;}}
      return canonical;
    }
    if(before.isDirectory()){
      const existing=directories.get(key);if(existing){if(wholeDirectory)existing.root=true;return existing.sourcePath;}
      const record={sourcePath:canonical,mode:Number(before.mode&0o7777n),mtimeNs:before.mtimeNs.toString(),...(wholeDirectory?{root:true as const}:{})};directories.set(key,record);result.directories.push(record);
      identities.set(key,{native:path.join(parent.native,path.basename(native)),stamp:stamp(before)});
      const held=await pin(path.join(parent.native,path.basename(native))),names=(await fs.readdir(held.path)).sort();
      if(names.length+entries>maxEntries)throw new Error('Git dependency inventory exceeds 10000 entries');
      if(!names.includes('.git')&&['HEAD','config','objects'].every(name=>names.includes(name)))throw new Error('Configured dependency contains a bare Git repository; a typed bare repository capsule is required before transporting its configuration');
      if(names.includes('.git')&&!knownRepositories.has(sourcePathKey(canonical))&&!knownModules.has(sourcePathKey(canonical))){
        const repository=await readers.exportGit(path.join(parent.native,path.basename(native)));
        if(!repository)throw new Error('Configured dependency Git repository cannot be captured: '+canonical);
        if((bytes+=Buffer.byteLength(JSON.stringify(repository)))>maxBytes)throw new Error('Configured Git repository dependencies exceed the 32 MiB capture memory bound');
        repositories.set(canonical,{native:path.join(parent.native,path.basename(native)),git:repository.git,originals:repository.gitOriginals});knownRepositories.add(sourcePathKey(canonical));moduleRoots(repository.git);
        await inspectRepositoryConfiguration(repository.git,path.join(parent.native,path.basename(native)),0);
      }
      for(const name of names){if(name==='.git')continue;await walk(path.join(held.native,name),false,wholeDirectory,depth+1);}
      const after=await fs.lstat(target,{bigint:true});if(stamp(after)!==stamp(before))throw new Error('Git dependency directory changed during capture: '+canonical);
      return canonical;
    }
    if(!before.isFile())throw new Error('Configured Git dependency is not a persistent regular file or directory: '+canonical);
    const existing=files.get(key)??capturedFile(canonical);
    if(existing){if(asConfiguration&&!existing.record.config){const parsed=readers.parseConfiguration(existing.raw);existing.record.dataBase64=parsed.data.toString('base64');existing.record.config=true;if(!parsed.data.equals(existing.raw))existing.record.removedSecretFields=true;}return canonical;}
    if(before.size>BigInt(asConfiguration?1024*1024:maxBytes))throw new Error('Configured Git dependency file exceeds its byte bound: '+canonical);
    const handle=await openDependency(target);
    let raw:Buffer;
    try{const observed=await handle.stat({bigint:true});if(!observed.isFile()||stamp(observed)!==stamp(before))throw new Error('Git dependency file changed before reading');raw=await readBounded(handle,before.size);const after=await handle.stat({bigint:true});if(stamp(after)!==stamp(before))throw new Error('Git dependency file changed while reading');}finally{await handle.close();}
    if((bytes+=raw.length)>maxBytes)throw new Error('Configured Git dependencies exceed the 32 MiB capture memory bound');
    const data=asConfiguration?readers.parseConfiguration(raw).data:safeData(raw,canonical),inode=[before.dev,before.ino].join(':'),alias=before.nlink>1n?inodes.get(inode):undefined;
    if(alias){result.links.push({sourcePath:canonical,targetSourcePath:alias,kind:'hardlink'});const original=files.get(sourcePathKey(alias));if(asConfiguration&&original){original.record.config=true;original.record.dataBase64=data.toString('base64');if(!data.equals(raw))original.record.removedSecretFields=true;}}else{
      inodes.set(inode,canonical);const record={sourcePath:canonical,dataBase64:data.toString('base64'),mode:Number(before.mode&0o7777n),mtimeNs:before.mtimeNs.toString(),...(asConfiguration?{config:true as const}:{}),...(!data.equals(raw)?{removedSecretFields:true as const}:{})};files.set(key,{record,raw});result.files.push(record);
    }
    identities.set(key,{native:path.join(parent.native,path.basename(native)),stamp:stamp(before),hash:createHash('sha256').update(raw).digest('hex')});return canonical;
  };
  const inspectConfiguration=async(items:ReviewedGitUserData['configurationReview'],configurationPath:string,worktree:string,gitdir:string,depth:number,configurationData:Buffer):Promise<void>=>{
    if(depth>10)throw new Error('Configured Git includes exceed the native ten-level limit');
    const ordinals=new Map<string,number>();
    for(const item of items){
      const key=item.key,ordinal=ordinals.get(key)??0;ordinals.set(key,ordinal+1);
      const lower=item.key.toLowerCase(),kind=/^(?:include|includeif\..+)\.path$/.test(lower)?'include':lower==='core.hookspath'?'hooks':lower==='core.attributesfile'?'attributes':lower==='core.excludesfile'?'excludes':undefined;
      if(!kind)continue;
      const raw=item.value;if(raw==='/dev/null')continue;
      const expanded=/^~[^/]/.test(raw)||raw.startsWith('%(prefix)')?await expandNativeConfigurationPath(configurationData,item.key,ordinal,root):raw==='~'||raw.startsWith('~/')?path.join(homedir(),raw.slice(2)):raw;
      const contexts=kind==='include'?[{context:'config' as const,base:path.dirname(configurationPath)}]:kind==='hooks'&&!path.isAbsolute(expanded)?[{context:'worktree' as const,base:worktree},{context:'gitdir' as const,base:gitdir}]:[{context:'worktree' as const,base:worktree}];
      for(const {context,base} of contexts){
        const target=path.resolve(base,expanded),resolved=await walk(target,kind==='include',kind==='hooks',depth);
        const resolvedPath=resolved??serializeSourcePath(target);result.bindings.push({kind,sourceConfigPath:serializeSourcePath(configurationPath),rawValue:raw,resolvedPath,contextSourcePath:serializeSourcePath(base),context});
        if(result.bindings.length>1000)throw new Error('Configured Git dependency references exceed their bound');
        if(kind==='include'&&resolved){
          const file=capturedFile(resolved),contextKey=[sourcePathKey(resolved),sourcePathKey(serializeSourcePath(worktree)),sourcePathKey(serializeSourcePath(gitdir))].join('\0');if(file&&!configurations.has(contextKey)){configurations.add(contextKey);const parsed=readers.parseConfiguration(file.raw);await inspectConfiguration(parsed.items,nativeName(resolved),worktree,gitdir,depth+1,parsed.data);}
        }
      }
    }
  };
  const inspectRepositoryConfiguration=async(value:ReviewedGitUserData,worktree:string,depth:number)=>{
    if(depth>32)throw new Error('Configured Git repository nesting exceeds its documented bound');
    const dirs=value.configurationSourceDirectories,commonNative=nativeName(dirs?.common??serializeSourcePath(path.join(worktree,'.git'))),privateNative=nativeName(dirs?.private??serializeSourcePath(commonNative));
    const hooks=path.join(commonNative,'hooks'),resolved=await walk(hooks,false,true,depth);
    result.bindings.push({kind:'hooks',sourceConfigPath:serializeSourcePath(path.join(commonNative,'config')),rawValue:'hooks',resolvedPath:resolved??serializeSourcePath(hooks),contextSourcePath:serializeSourcePath(commonNative),context:'gitdir',default:true});
    for(const [name,directory,items] of [['config',commonNative,value.configurationReview.filter(item=>!item.source)],['config.worktree',privateNative,value.configurationReview.filter(item=>!!item.source)]] as const){
      const original=value.configurationOriginalReview.find(item=>item.path===name),native=path.join(directory,name);if(!original)throw new Error('Configured Git path capture requires its exact declaring original');
      const data=original.dataBase64===null?Buffer.alloc(0):Buffer.from(original.dataBase64,'base64'),parent=await pin(directory),target=path.join(parent.path,name);
      if(original.dataBase64===null){try{await fs.lstat(target);throw new Error('Previously absent declaring Git configuration appeared');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}configurationAbsences.add(native);}
      else{const handle=await openDependency(target);try{const before=await handle.stat({bigint:true});if(!before.isFile()||before.size>1024n*1024n)throw new Error('Declaring Git configuration is not a bounded regular original');const raw=await readBounded(handle,before.size);if(stamp(await handle.stat({bigint:true}))!==stamp(before)||!readers.parseConfiguration(raw).data.equals(data))throw new Error('Declaring Git configuration changed before dependency capture');identities.set(sourcePathKey(serializeSourcePath(native)),{native,stamp:stamp(before),hash:createHash('sha256').update(raw).digest('hex')});}finally{await handle.close();}}
      await inspectConfiguration(items,native,worktree,privateNative,0,data);
    }
    for(const module of value.modules??[]){await inspectRepositoryConfiguration(module.git,nativeName(module.source.worktreePath),depth+1);if(module.source.initialized&&!selected.some(root=>sourcePathWithin(root,module.source.worktreePath)))await walk(nativeName(module.source.worktreePath),false,true,depth+1);}
  };
  let failure:unknown;
  try{
    await inspectRepositoryConfiguration(git,root,0);
    for(const [source,evidence] of identities){
      await checkParents();const current=await fs.lstat(evidence.native,{bigint:true});if(stamp(current)!==evidence.stamp)throw new Error('Configured Git dependency changed after capture: '+source);
      if(evidence.target!==undefined&&await fs.readlink(evidence.native)!==evidence.target)throw new Error('Configured Git link changed after capture');
      if(evidence.hash){const parent=await pin(path.dirname(evidence.native)),handle=await openDependency(path.join(parent.path,path.basename(evidence.native)));try{const stat=await handle.stat({bigint:true});if(!stat.isFile()||stamp(stat)!==evidence.stamp)throw new Error('Configured Git file identity changed after capture');const data=await readBounded(handle,stat.size);if(stamp(await handle.stat({bigint:true}))!==evidence.stamp||createHash('sha256').update(data).digest('hex')!==evidence.hash)throw new Error('Configured Git file identity changed after capture');}finally{await handle.close();}}
    }
    for(const [source,repository] of repositories){const current=await readers.exportGit(repository.native);if(!current||JSON.stringify(current.git)!==JSON.stringify(repository.git)||JSON.stringify(current.gitOriginals)!==JSON.stringify(repository.originals))throw new Error('Configured dependency repository changed during capture: '+source);}
    for(const source of result.absentPaths)try{await fs.lstat(nativeName(source));throw new Error('An absent configured Git dependency appeared during capture');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    for(const source of configurationAbsences)try{await fs.lstat(source);throw new Error('An absent declaring Git configuration appeared during dependency capture');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    result.absentPaths=[...new Set(result.absentPaths)];result.omittedPaths=[...new Set(result.omittedPaths)];
    if(result.files.length+result.directories.length+result.links.length+result.absentPaths.length+result.omittedPaths.length>maxEntries)throw new Error('Configured Git dependency dispositions exceed 10000 entries');
    if(repositories.size)result.repositories=[...repositories].map(([sourcePath,value])=>({sourcePath,git:value.git,originals:value.originals}));
  }catch(error){failure=error;}
  finally{const cleanup:unknown[]=[];for(const held of [...pins.values()].reverse()){try{await held.handle?.close();}catch(error){cleanup.push(error);}try{held.reference?.close();}catch(error){cleanup.push(error);}}if(cleanup.length)failure=Object.assign(new Error((failure instanceof Error?failure.message+'; ':'')+'Git dependency read-reference cleanup failed',{cause:failure??cleanup[0]}),{code:(failure as {code?:string}|undefined)?.code??'ERR_GIT_DEPENDENCY_CLEANUP',cleanupErrors:cleanup});}
  if(failure)throw failure;
  return result.bindings.length?result:undefined;
}

/** Schema/hash validation is independent of the current host; these paths are inert provenance. */
export function validateGitExternalDependencies(
  value:ReviewedGitExternalDependencies,
  readers:Pick<Readers,'parseConfiguration'>,
  validateGit:(git:ReviewedGitUserData)=>void,
  validateOriginals:(git:ReviewedGitUserData,originals:ReviewedUserData['providerFiles'])=>void,
  ownerGit:ReviewedGitUserData,
  allowExternal=false,
):void {
  function fail(message:string):never{throw new Error(message);}
  const exact=(object:unknown,required:string[],optional:string[]=[])=>{
    if(!object||typeof object!=='object'||Array.isArray(object)||required.some(key=>!Object.hasOwn(object,key))||Object.keys(object).some(key=>![...required,...optional].includes(key)))fail('Unexpected configured Git dependency fields');
  };
  const source=(name:string)=>{
    if(typeof name!=='string'||!sourcePathAbsolute(name)||normalizeSourcePath(name)!==name||Buffer.byteLength(name)>4096||/[\x00-\x1f\x7f]/.test(name))fail('Invalid configured Git source provenance');
  };
  const metadata=(node:{mode:number;mtimeNs:string})=>{
    if(!Number.isInteger(node.mode)||node.mode<0||node.mode>0o7777||typeof node.mtimeNs!=='string'||!/^(?:0|-?[1-9][0-9]{0,20})$/.test(node.mtimeNs))fail('Invalid configured Git dependency metadata');
  };
  exact(value,['version','sourceWorkingRoot','files','directories','links','absentPaths','omittedPaths','bindings'],['repositories']);
  source(value.sourceWorkingRoot);
  if(value.version!==1||typeof allowExternal!=='boolean'||![value.files,value.directories,value.links,value.absentPaths,value.omittedPaths,value.bindings].every(Array.isArray)||value.files.length+value.directories.length+value.links.length+value.absentPaths.length+value.omittedPaths.length>maxEntries||value.bindings.length>1000)fail('Configured Git dependency inventory exceeds its format bound');
  type Node={source:string;kind:'file'|'directory'|'symlink'|'hardlink'|'absent'|'omitted';target?:string;file?:ReviewedGitExternalDependencies['files'][number]};
  const nodes=new Map<string,Node>();let bytes=0;
  const add=(node:Node)=>{const key=sourcePathKey(node.source);if(nodes.has(key))fail('Configured Git source has conflicting or duplicate dispositions');nodes.set(key,node);};
  for(const file of value.files){
    exact(file,['sourcePath','dataBase64','mode','mtimeNs'],['config','removedSecretFields']);source(file.sourcePath);metadata(file);
    if(privatePath(file.sourcePath)||file.config!==undefined&&file.config!==true||file.removedSecretFields!==undefined&&file.removedSecretFields!==true||typeof file.dataBase64!=='string'||file.dataBase64.length>Math.ceil(maxBytes/3)*4)fail('Invalid configured Git dependency file');
    const data=Buffer.from(file.dataBase64,'base64');
    if(data.toString('base64')!==file.dataBase64||(bytes+=data.length)>maxBytes)fail('Configured Git dependency bytes exceed their bound');
    if(file.config){
      if(data.length>1024*1024||!readers.parseConfiguration(data).data.equals(data))fail('Included Git configuration retains excluded fields or exceeds its bound');
    }else{
      const text=data.toString('utf8');
      if(/-----BEGIN (?:(?:[A-Z0-9]+ )*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/.test(text))fail('Configured Git data retains private key material');
      if(/\.(?:key|pem)$/i.test(file.sourcePath)&&!/-----BEGIN (?:RSA )?PUBLIC KEY-----|-----BEGIN CERTIFICATE-----/.test(text))fail('Configured Git key material must be re-entered on the destination');
      if(Buffer.from(text).equals(data)&&/^\s*[\[{]/.test(text)){
        try{const parsed=JSON.parse(text);if(JSON.stringify(withoutPortableSecrets(parsed,maxBytes))!==JSON.stringify(parsed))fail('Configured Git data retains credential fields');}
        catch(error){if(!(error instanceof SyntaxError))throw error;}
      }
    }
    add({source:file.sourcePath,kind:'file',file});
  }
  for(const directory of value.directories){
    exact(directory,['sourcePath','mode','mtimeNs'],['root']);source(directory.sourcePath);metadata(directory);
    if(privatePath(directory.sourcePath)||directory.root!==undefined&&directory.root!==true)fail('Invalid configured Git dependency directory');
    add({source:directory.sourcePath,kind:'directory'});
  }
  const directoryRecords=new Map(value.directories.map(node=>[sourcePathKey(node.sourcePath),node] as const));
  for(const link of value.links){
    exact(link,['sourcePath','targetSourcePath','kind'],['mtimeNs']);source(link.sourcePath);source(link.targetSourcePath);
    if(privatePath(link.sourcePath)||!['symlink','hardlink'].includes(link.kind)||link.mtimeNs!==undefined&&(typeof link.mtimeNs!=='string'||!/^(?:0|-?[1-9][0-9]{0,20})$/.test(link.mtimeNs)))fail('Invalid configured Git dependency link');
    add({source:link.sourcePath,kind:link.kind,target:link.targetSourcePath});
  }
  for(const [kind,paths] of [['absent',value.absentPaths],['omitted',value.omittedPaths]] as const)for(const name of paths){source(name);add({source:name,kind});}
  // Lookup only represented ancestors, rather than comparing every node pair.
  const ordered=[...nodes.values()];
  const ancestors=(name:string):string[]=>{
    const key=sourcePathKey(name),result:string[]=[];
    for(let offset=key.lastIndexOf('/');offset>=0;offset=key.lastIndexOf('/',offset-1)){
      const prefix=key.slice(0,offset);result.push(prefix,prefix+'/');if(offset===0)break;
    }
    return result;
  };
  for(const node of ordered)for(const key of ancestors(node.source)){
    const parent=nodes.get(key);
    if(parent&&parent!==node&&parent.kind!=='directory'&&sourcePathWithin(parent.source,node.source)&&(!['absent','omitted'].includes(parent.kind)||!['absent','omitted'].includes(node.kind)))fail('Configured Git topology has a non-directory parent');
  }
  const namespace=(name:string)=>/^(?:[a-z]:|\/\/)/i.test(name)?'windows':'posix';
  const nodeKeys={posix:[...nodes.keys()].filter(name=>namespace(name)==='posix').sort(),windows:[...nodes.keys()].filter(name=>namespace(name)==='windows').sort()};
  const descendant=(name:string,keys=nodeKeys[namespace(name) as 'posix'|'windows'])=>{
    const key=sourcePathKey(name),prefix=key.endsWith('/')?key:key+'/';let low=0,high=keys.length;
    while(low<high){const mid=(low+high)>>>1;if(keys[mid]!<prefix)low=mid+1;else high=mid;}
    return keys[low]?.startsWith(prefix)===true;
  };
  type Resolution={source:string;kind:'file'|'directory'|'absent'|'omitted'|'cycle'|'missing';file?:ReviewedGitExternalDependencies['files'][number];aliases:string[]};
  const resolve=(name:string):Resolution=>{
    let current=name;const seen=new Set<string>(),aliases:string[]=[];
    for(let depth=0;depth<128;depth++){
      const key=sourcePathKey(current);if(seen.has(key))return {source:current,kind:'cycle',aliases};seen.add(key);
      const node=nodes.get(key);
      if(node&&node.kind!=='symlink'&&node.kind!=='hardlink')return {source:node.source,kind:node.kind,file:node.file,aliases};
      const link=node??ancestors(current).map(key=>nodes.get(key)).find(candidate=>candidate&&(candidate.kind==='symlink'||candidate.kind==='hardlink')&&sourcePathWithin(candidate.source,current));
      if(link){
        const suffix=relativeSourcePath(link.source,current);
        if(link.kind==='hardlink'&&suffix)fail('Configured Git hardlink cannot be a directory prefix');
        aliases.push(link.source);current=resolveSourcePath(link.target!,suffix);continue;
      }
      // A transit directory need not carry fabricated source metadata. Its
      // represented descendant proves it is only a required container.
      if(descendant(current))return {source:current,kind:'directory',aliases};
      return {source:current,kind:'missing',aliases};
    }
    return fail('Configured Git alias chain exceeds its bounded graph');
  };
  for(const link of value.links){
    const resolved=resolve(link.sourcePath);
    if(link.kind==='hardlink'&&resolved.kind!=='file')fail('Configured Git hardlink requires a real represented regular target');
    if(link.kind==='symlink'&&resolved.kind==='missing')fail('Configured Git symlink target is outside its represented graph');
  }
  const repositoryRoots=new Set<string>(),repositories=value.repositories??[];
  type Claim={source:string;whole:boolean;aliases:string[]};
  const ownerOrigin=sourcePathKey(value.sourceWorkingRoot),originClaims=new Map<string,Claim[]>();
  const claimOrigin=(origin:string,source:string,whole:boolean,aliases:string[]=[])=>{const list=originClaims.get(origin)??[];list.push({source,whole,aliases});originClaims.set(origin,list);};
  if(!Array.isArray(repositories)||repositories.length>1000)fail('Invalid dependency Git repository set');
  const scopes=new Set<string>([value.sourceWorkingRoot]);
  type Context={configuration:string;worktree:string;common:string;privateDir:string;home?:string;items:ReviewedGitUserData['configurationReview'];includeDepth:number;origin:string};
  const queue:Context[]=[],contexts=new Map<string,string>(),defaults:Array<{configuration:string;common:string;origin:string}>=[];
  let repositoryCount=0;
  const addRepository=(git:ReviewedGitUserData,worktree:string,depth=0,origin=ownerOrigin)=>{
    if(depth>32||++repositoryCount>1000)fail('Configured Git repository configuration graph exceeds its bound');
    source(worktree);const dirs=git.configurationSourceDirectories;
    if(!dirs)fail('Configured Git dependencies require original configuration directory provenance');
    source(dirs.common);source(dirs.private);if(dirs.home!==undefined)source(dirs.home);
    scopes.add(worktree);scopes.add(dirs.common);scopes.add(dirs.private);
    for(const [name,directory,tag] of [['config',dirs.common,undefined],['config.worktree',dirs.private,'config.worktree']] as const){
      const configuration=resolveSourcePath(directory,name),original=git.configurationOriginalReview.find(item=>item.path===name);
      if(!original)fail('Configured Git dependency lacks its exact declaring configuration original');
      const items=original.dataBase64===null?[]:readers.parseConfiguration(Buffer.from(original.dataBase64,'base64')).items;
      const declared=git.configurationReview.filter(item=>item.source===tag).map(({source:_source,...item})=>item);
      if(JSON.stringify(items)!==JSON.stringify(declared))fail('Configured Git declaring items differ from their exact original');
      enqueue({configuration,worktree,common:dirs.common,privateDir:dirs.private,home:dirs.home,items,includeDepth:0,origin});
    }
    defaults.push({configuration:resolveSourcePath(dirs.common,'config'),common:dirs.common,origin});
    for(const module of git.modules??[]){if(module.source.initialized&&nodes.get(sourcePathKey(module.source.worktreePath))?.kind==='directory')claimOrigin(origin,module.source.worktreePath,true);addRepository(module.git,module.source.worktreePath,depth+1,origin);}
  };
  const enqueue=(context:Context)=>{
    const key=JSON.stringify([sourcePathKey(context.configuration),sourcePathKey(context.worktree),sourcePathKey(context.common),sourcePathKey(context.privateDir),context.origin]);
    const contents=JSON.stringify(context.items),previous=contexts.get(key);
    if(previous!==undefined){if(previous!==contents)fail('Configured Git source context has conflicting declaring originals');return;}
    if(context.includeDepth>10||contexts.size>=10000)fail('Configured Git include-context graph exceeds its bound');contexts.set(key,contents);queue.push(context);
  };
  addRepository(ownerGit,value.sourceWorkingRoot);
  const selectedScopes=[...scopes];
  for(const repository of repositories){
    exact(repository,['sourcePath','git','originals']);source(repository.sourcePath);const key=sourcePathKey(repository.sourcePath);
    if(repositoryRoots.has(key)||[...scopes].some(scope=>sourcePathKey(scope)===key)||nodes.get(key)?.kind!=='directory')fail('Dependency Git repositories require unique represented directory roots');
    if(!allowExternal&&!selectedScopes.some(root=>sourcePathWithin(root,repository.sourcePath)))fail('Unselected external Git repository dependency');
    repositoryRoots.add(key);validateGit(repository.git);
    if(!Array.isArray(repository.originals)||(bytes+=Buffer.byteLength(JSON.stringify(repository)))>maxBytes)fail('Invalid dependency repository originals or byte bound');
    validateOriginals(repository.git,repository.originals);addRepository(repository.git,repository.sourcePath,0,key);
  }
  const bindings=new Map<string,Array<{binding:ReviewedGitExternalDependencies['bindings'][number];index:number}>>(),used=new Set<number>(),claimedExact=new Set<string>(),claimedFull=new Set<string>(),claimedAliases=new Set<string>();
  const claim=(name:string,whole=false)=>{const key=sourcePathKey(name),set=whole?claimedFull:claimedExact,before=set.size;set.add(key);return set.size!==before;};
  const isClaimed=(name:string)=>{const key=sourcePathKey(name);return claimedExact.has(key)||claimedFull.has(key)||ancestors(name).some(parent=>claimedFull.has(parent));};
  const bindingKey=(kind:string,configuration:string,raw:string,context:string,base:string,defaultHook=false)=>JSON.stringify([kind,sourcePathKey(configuration),raw,context,sourcePathKey(base),defaultHook]);
  for(const [index,binding] of value.bindings.entries()){
    exact(binding,['kind','sourceConfigPath','rawValue','resolvedPath','contextSourcePath','context'],['default']);source(binding.sourceConfigPath);source(binding.resolvedPath);source(binding.contextSourcePath);
    if(!['include','hooks','attributes','excludes'].includes(binding.kind)||!['config','worktree','gitdir'].includes(binding.context)||typeof binding.rawValue!=='string'||Buffer.byteLength(binding.rawValue)>4096||/[\x00\r\n]/.test(binding.rawValue)||binding.default!==undefined&&(binding.default!==true||binding.kind!=='hooks'||binding.context!=='gitdir'))fail('Invalid configured Git dependency binding');
    const key=bindingKey(binding.kind,binding.sourceConfigPath,binding.rawValue,binding.context,binding.contextSourcePath,binding.default===true),list=bindings.get(key)??[];list.push({binding,index});bindings.set(key,list);
  }
  const consume=(kind:string,configuration:string,raw:string,context:'config'|'worktree'|'gitdir',base:string,expanded:string,repository?:Context,defaultHook=false,origin=repository?.origin??ownerOrigin)=>{
    const matches=bindings.get(bindingKey(kind,configuration,raw,context,base,defaultHook));
    if(!matches?.length)fail('Configured Git declaration is missing its exact dependency binding');
    const special=/^~[^/]/.test(raw)||raw.startsWith('%(prefix)'),literal=special?matches[0]!.binding.resolvedPath:resolveSourcePath(base,expanded),expected=resolve(literal);
    if(['cycle','missing'].includes(expected.kind))fail('Configured Git binding requires a real or explicit absent/omitted target');
    if((kind==='include'||kind==='attributes'||kind==='excludes')&&expected.kind==='directory'||kind==='hooks'&&expected.kind==='file')fail('Configured Git dependency kind differs from its represented target');
    if(kind==='include'&&expected.kind==='file'&&!expected.file?.config)fail('Configured Git include target is not a validated configuration original');
    for(const {binding,index} of matches){
      const target=resolve(binding.resolvedPath);
      if(target.kind!==expected.kind||sourcePathKey(target.source)!==sourcePathKey(expected.source))fail('Configured Git binding target differs from its literal context and aliases');
      used.add(index);for(const alias of [...expected.aliases,...target.aliases])claimedAliases.add(sourcePathKey(alias));
    }
    claim(expected.source,kind==='hooks'&&expected.kind==='directory');
    claimOrigin(origin,expected.source,kind==='hooks'&&expected.kind==='directory',[...expected.aliases,...matches.flatMap(({binding})=>resolve(binding.resolvedPath).aliases)]);
    if(kind==='include'&&expected.kind==='file'&&repository){
      const items=readers.parseConfiguration(Buffer.from(expected.file!.dataBase64,'base64')).items;
      // Preserve the producer's exact resolved configuration context; bytes are
      // resolved only through represented aliases, never through the current host.
      for(const {binding} of matches)enqueue({...repository,configuration:binding.resolvedPath,items,includeDepth:repository.includeDepth+1});
    }
  };
  for(const context of defaults)consume('hooks',context.configuration,'hooks','gitdir',context.common,'hooks',undefined,true,context.origin);
  for(let offset=0;offset<queue.length;offset++){
    const repository=queue[offset]!;
    for(const item of repository.items){
      const lower=item.key.toLowerCase(),kind=/^(?:include|includeif\..+)\.path$/.test(lower)?'include':lower==='core.hookspath'?'hooks':lower==='core.attributesfile'?'attributes':lower==='core.excludesfile'?'excludes':undefined;
      if(!kind||item.value==='/dev/null')continue;
      let expanded=item.value;const special=/^~[^/]/.test(expanded)||expanded.startsWith('%(prefix)');
      if(expanded==='~'||expanded.startsWith('~/')){if(!repository.home)fail('Configured Git tilde path lacks original home provenance');expanded=resolveSourcePath(repository.home,expanded.slice(2));}
      if(kind==='include')consume(kind,repository.configuration,item.value,'config',resolveSourcePath(repository.configuration,'..'),expanded,repository);
      else if(kind==='hooks'&&!special&&!sourcePathAbsolute(expanded)){
        consume(kind,repository.configuration,item.value,'worktree',repository.worktree,expanded,repository);
        consume(kind,repository.configuration,item.value,'gitdir',repository.privateDir,expanded,repository);
      }else consume(kind,repository.configuration,item.value,'worktree',repository.worktree,expanded,repository);
    }
  }
  if(used.size!==value.bindings.length)fail('Configured Git binding has no exact declaring configuration/context proof');
  // Whole initialized module working trees are an explicit part of the captured
  // repository graph, independently of their configuration dependency bindings.
  const claimModules=(git:ReviewedGitUserData)=>{for(const module of git.modules??[]){if(module.source.initialized&&nodes.get(sourcePathKey(module.source.worktreePath))?.kind==='directory')claim(module.source.worktreePath,true);claimModules(module.git);}};
  claimModules(ownerGit);for(const repository of repositories)claimModules(repository.git);
  const expandClaims=(exact:Set<string>,full:Set<string>,aliases:Set<string>)=>{
    const included=(name:string)=>{const key=sourcePathKey(name);return exact.has(key)||full.has(key)||ancestors(name).some(parent=>full.has(parent));};
    for(let pass=0;pass<=128;pass++){
      let changed=false;
      for(const link of value.links){
        if(!included(link.sourcePath)&&!aliases.has(sourcePathKey(link.sourcePath)))continue;
        const target=resolve(link.sourcePath);
        for(const alias of target.aliases){const before=aliases.size;aliases.add(sourcePathKey(alias));changed||=aliases.size!==before;}
        const directory=directoryRecords.get(sourcePathKey(target.source)),set=target.kind==='directory'&&directory?.root===true?full:exact,key=sourcePathKey(target.source),before=set.size;set.add(key);changed||=set.size!==before;
      }
      if(!changed)return;if(pass===128)fail('Configured Git dependency closure exceeds its bounded alias graph');
    }
  };
  expandClaims(claimedExact,claimedFull,claimedAliases);
  // A capsule cannot authorize itself through its own default hooks/config, and
  // two disconnected capsules cannot authorize one another. Begin at the owner.
  const trustedExact=new Set<string>(),trustedFull=new Set<string>(),trustedAliases=new Set<string>(),trusted=new Set<string>([ownerOrigin]);
  const mergeOrigin=(origin:string)=>{for(const record of originClaims.get(origin)??[]){(record.whole?trustedFull:trustedExact).add(sourcePathKey(record.source));for(const alias of record.aliases)trustedAliases.add(sourcePathKey(alias));}expandClaims(trustedExact,trustedFull,trustedAliases);};
  const reachable=(name:string)=>{const key=sourcePathKey(name);return trustedExact.has(key)||trustedFull.has(key)||ancestors(name).some(parent=>trustedFull.has(parent));};
  mergeOrigin(ownerOrigin);
  for(let pass=0;pass<32;pass++){
    const additions=repositories.filter(repository=>!trusted.has(sourcePathKey(repository.sourcePath))&&reachable(repository.sourcePath));
    for(const repository of additions){const key=sourcePathKey(repository.sourcePath);trusted.add(key);mergeOrigin(key);}
    if(trusted.size===repositories.length+1)break;if(!additions.length||pass===31)fail('Configured Git repository capsule is disconnected or exceeds its bounded dependency graph');
  }
  const claimedKeys=[...new Set([...claimedExact,...claimedFull,...claimedAliases])],claimedByNamespace={posix:claimedKeys.filter(name=>namespace(name)==='posix').sort(),windows:claimedKeys.filter(name=>namespace(name)==='windows').sort()};
  const inSelectedScope=(name:string)=>selectedScopes.some(root=>sourcePathWithin(root,name));
  for(const node of ordered){
    const claimed=isClaimed(node.source)||claimedAliases.has(sourcePathKey(node.source));
    const container=node.kind==='directory'&&descendant(node.source,claimedByNamespace[namespace(node.source) as 'posix'|'windows']);
    if(!claimed&&!container)fail('Configured Git data is disconnected from its declared dependency closure');
    if(!allowExternal&&!inSelectedScope(node.source)){
      const directory=directoryRecords.get(sourcePathKey(node.source));
      const transit=node.kind==='directory'&&container&&directory?.root!==true||node.kind==='symlink'&&claimedAliases.has(sourcePathKey(node.source));
      if(!transit&&node.kind!=='absent'&&node.kind!=='omitted')fail('Unselected external Git dependency payload');
    }
  }
}
