import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {applyExactFileMetadata} from '@ponderosa/native-host';
import {promises as fs} from '@ponderosa/native-host/fs';
import path from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {crc32,deflateSync,inflateSync} from 'node:zlib';
import type {ReviewedGitUserData,ReviewedUserData,ReviewedUserDataSelection,ReviewedUserDataActivation,ReviewedMetadataActivation,GitStorageSelection,PortableGitStorageBinding} from '@ponderosa/core';
import {assertPortableSecretsAbsent,isPortableSecretField,redactPortableDiagnostic,withoutPortableSecrets} from './portable-secrets.js';

import {captureFilesystemMetadata,validateFilesystemMetadata} from './portable-filesystem-metadata.js';

const sourceFs=fs;
type GitSourceFs=Pick<typeof sourceFs,'lstat'|'realpath'|'open'|'readdir'>;

export const REVIEWED_USER_DATA_PATH='.ponderosa-portable-review/user-data.json';
const limit=32*1024*1024;
const recreationScope={absoluteLinks:'refuse',crossRootLinks:'refuse',cyclicLinks:'passive_in_root',specialNodes:'refuse',acl:'not_inspected_preserve_source',xattrs:'not_inspected_preserve_source'} as const;

function fields(value:unknown,required:readonly string[],optional:readonly string[]=[]):void {
  if(!value||typeof value!=='object'||Array.isArray(value)||required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>![...required,...optional].includes(key)))throw new Error('Unexpected or missing reviewed user-data fields');
}
export function validateReviewedUserDataSelection(value:unknown):asserts value is ReviewedUserDataSelection {
  fields(value,['git','harness'],['source','extendedMetadata','persistentNodes']);
  const selection=value as ReviewedUserDataSelection;
  if(selection.source!==undefined&&!['live','retained_originals'].includes(selection.source))throw new Error('Choose live or retained-original review data');
  if(typeof selection.git!=='boolean'||typeof selection.harness!=='boolean')throw new Error('Git and harness selections must be explicit booleans');
  for(const [family,keys] of [['extendedMetadata',['userXattrs','posixAcl']],['persistentNodes',['fifo','evidenceOnly']]] as const){
    const choice=selection[family];
    if(choice!==undefined){
      fields(choice,keys);
      if(keys.some(key=>typeof (choice as Record<string,unknown>)[key]!=='boolean')||!keys.some(key=>(choice as Record<string,unknown>)[key]===true))throw new Error('Choose at least one explicit metadata family; omit unused families');
    }
  }
  if(!selection.git&&!selection.harness&&!selection.extendedMetadata&&!selection.persistentNodes)throw new Error('Select at least one reviewed user-data family');
}

function portableBindingIdentity(value:unknown):asserts value is string {
  if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))throw new Error('Invalid portable binding identity');
}
function storageRelativePath(value:unknown):asserts value is string {
  if(value==='.')return; // The explicitly selected storage root itself.
  if(typeof value!=='string'||!value||Buffer.byteLength(value)>4096||value.includes('\\')||value.includes(':')||value.split('/').some(part=>!part||part==='.'||part==='..'||/[\x00-\x1f\x7f]/.test(part)))throw new Error('Git storage requires a canonical contained relative path');
}
/** Structural selection only; callers still establish current whole-root access and association proof. */
export function validateGitStorageSelections(value:unknown):asserts value is GitStorageSelection[] {
  if(!Array.isArray(value)||!value.length||value.length>1000)throw new Error('Select a bounded nonempty Git storage binding set');
  const ids=new Set<string>(),roles=new Set<string>();
  for(const binding of value as GitStorageSelection[]){
    fields(binding,['id','worktreeAgentId','storageAgentId','relativePath','role']);
    for(const id of [binding.id,binding.worktreeAgentId,binding.storageAgentId])portableBindingIdentity(id);
    storageRelativePath(binding.relativePath);
    const role=JSON.stringify([binding.worktreeAgentId,binding.role,binding.role==='module'?binding.id:'']);
    if(!['common','private','module'].includes(binding.role)||ids.has(binding.id)||roles.has(role))throw new Error('Duplicate or invalid Git storage selection');
    ids.add(binding.id);roles.add(role);
  }
}
/** Imported topology is inert. No imported root identity establishes a current source/destination grant. */
export function validatePortableGitStorageBindings(value:unknown,rootRefs:ReadonlySet<string>):asserts value is PortableGitStorageBinding[] {
  if(!Array.isArray(value)||!value.length||value.length>1000)throw new Error('Invalid portable Git storage binding set');
  const ids=new Set<string>(),roles=new Set<string>(),locations=new Map<string,string>();
  for(const binding of value as PortableGitStorageBinding[]){
    fields(binding,['id','worktreeRootRef','storageRootRef','relativePath','role'],['capture']);
    for(const id of [binding.id,binding.worktreeRootRef,binding.storageRootRef])portableBindingIdentity(id);
    storageRelativePath(binding.relativePath);
    const role=JSON.stringify([binding.worktreeRootRef,binding.role,binding.role==='module'?binding.id:'']);
    if(!['common','private','module'].includes(binding.role)||!rootRefs.has(binding.worktreeRootRef)||!rootRefs.has(binding.storageRootRef)||ids.has(binding.id)||roles.has(role))throw new Error('Git association lacks unique final-root closure');
    const location=JSON.stringify([binding.storageRootRef,binding.relativePath]),prior=locations.get(location);
    if(prior!==undefined&&prior!==binding.role)throw new Error('Conflicting portable Git storage roles');
    if(binding.capture!==undefined){
      const proof=binding.capture;fields(proof,['version','currentAuthority','roots','records'],['reviewSha256']);
      if(proof.reviewSha256!==undefined&&(typeof proof.reviewSha256!=='string'||!/^[a-f0-9]{64}$/.test(proof.reviewSha256)))throw new Error('Invalid Git review original hash');
      if(proof.version!==1||proof.currentAuthority!==false||!Array.isArray(proof.roots)||!proof.roots.length||proof.roots.length>3||!Array.isArray(proof.records)||!proof.records.length||proof.records.length>12)throw new Error('Invalid inert Git capture provenance');
      const roots=new Set<string>(),paths=new Set<string>(),records=new Set<string>();
      for(const root of proof.roots){
        fields(root,['rootRef','sourcePath','identity']);portableBindingIdentity(root.rootRef);
        if(!rootRefs.has(root.rootRef)||roots.has(root.rootRef)||typeof root.sourcePath!=='string'||!root.sourcePath.startsWith('/')||path.posix.normalize(root.sourcePath)!==root.sourcePath||Buffer.byteLength(root.sourcePath)>4096||/[\x00-\x1f\x7f]/.test(root.sourcePath)||paths.has(root.sourcePath))throw new Error('Git capture provenance lacks unique final root closure');
        if(typeof root.identity!=='string'||!/^[0-9]+(?::[0-9]+){4}:-?[0-9]+:-?[0-9]+$/.test(root.identity))throw new Error('Invalid captured selected-root identity');
        roots.add(root.rootRef);paths.add(root.sourcePath);
      }
      if(!roots.has(binding.worktreeRootRef)||!roots.has(binding.storageRootRef))throw new Error('Git binding differs from its captured root closure');
      let bytes=0;
      for(const record of proof.records){
        fields(record,['rootRef','relativePath','identity'],['dataBase64','absent','moduleWorktree']);storageRelativePath(record.relativePath);
        const key=JSON.stringify([record.rootRef,record.relativePath]);
        if(!roots.has(record.rootRef)||records.has(key)||typeof record.identity!=='string'||(record.absent===true?record.identity!==''||record.dataBase64!==undefined:record.absent!==undefined||!/^[0-9]+(?::[0-9]+){4}:-?[0-9]+:-?[0-9]+$/.test(record.identity)))throw new Error('Invalid or duplicate Git association original identity');
        if(record.dataBase64!==undefined){
          if(typeof record.dataBase64!=='string'||record.dataBase64.length>5464)throw new Error('Invalid bounded Git association encoding');
          const data=Buffer.from(record.dataBase64,'base64');bytes+=data.length;
          if(data.length>4096||data.toString('base64')!==record.dataBase64||bytes>12288)throw new Error('Invalid bounded Git association original bytes');
          safeText(text(data),'Git association original');
        }
        if(record.moduleWorktree!==undefined){
          fields(record.moduleWorktree,['value','sha256']);
          if(binding.role!=='module'||record.dataBase64!==undefined||record.absent||typeof record.moduleWorktree.value!=='string'||!record.moduleWorktree.value||Buffer.byteLength(record.moduleWorktree.value)>4096||/[\\\0\r\n]/.test(record.moduleWorktree.value)||!/^[a-f0-9]{64}$/.test(record.moduleWorktree.sha256))throw new Error('Invalid selected module worktree configuration proof');
          safeText(record.moduleWorktree.value,'Module worktree path');
        }
        records.add(key);
      }
      for(const relativePath of ['.git'])if(!proof.records.some(record=>record.rootRef===binding.worktreeRootRef&&record.relativePath===relativePath&&record.dataBase64!==undefined))throw new Error('Git capture lacks selected worktree pointer original');
      for(const name of ['gitdir','commondir'])if(binding.role==='private'&&!proof.records.some(record=>record.rootRef===binding.storageRootRef&&record.relativePath===(binding.relativePath==='.'?name:binding.relativePath+'/'+name)&&record.dataBase64!==undefined))throw new Error('Git capture lacks reciprocal private association originals');
    }
    locations.set(location,binding.role);ids.add(binding.id);roles.add(role);
  }
  for(const binding of value as PortableGitStorageBinding[]){
    if(!binding.capture)continue;
    if(binding.role==='module'){
      const proof=binding.capture,source=(ref:string)=>proof.roots.find(root=>root.rootRef===ref)!.sourcePath;
      const storage=path.posix.join(source(binding.storageRootRef),binding.relativePath),worktree=source(binding.worktreeRootRef);
      const original=proof.records.find(record=>record.rootRef===binding.worktreeRootRef&&record.relativePath==='.git');
      const pointer=original?.dataBase64?text(Buffer.from(original.dataBase64,'base64')).replace(/\n$/,''):'';
      const config=proof.records.filter(record=>record.moduleWorktree);
      if(!pointer.startsWith('gitdir: ')||/[\0\r\n]/.test(pointer)||path.posix.resolve(worktree,pointer.slice(8))!==storage||config.length!==1||path.posix.join(source(config[0]!.rootRef),config[0]!.relativePath)!==path.posix.join(storage,'config')||path.posix.resolve(storage,config[0]!.moduleWorktree!.value)!==worktree)throw new Error('Selected module pointer and core.worktree proof differ');
      for(const target of [worktree,storage])if(!proof.records.some(record=>!record.absent&&record.dataBase64===undefined&&!record.moduleWorktree&&path.posix.join(source(record.rootRef),record.relativePath)===target))throw new Error('Module capture lacks held directory proof');
      for(const name of ['gitdir','commondir'])if(!proof.records.some(record=>record.absent===true&&path.posix.join(source(record.rootRef),record.relativePath)===path.posix.join(storage,name)))throw new Error('Module capture lacks explicit association absences');
      continue;
    }
    const peer=(value as PortableGitStorageBinding[]).find(other=>other.worktreeRootRef===binding.worktreeRootRef&&other.role===(binding.role==='common'?'private':'common'));
    if(!peer?.capture||JSON.stringify(peer.capture)!==JSON.stringify(binding.capture))throw new Error('Captured Git association requires a complete matching common/private proof pair');
    if(binding.role!=='private')continue;
    const proof=binding.capture,source=(ref:string)=>proof.roots.find(root=>root.rootRef===ref)!.sourcePath;
    const privatePath=path.posix.join(source(binding.storageRootRef),binding.relativePath),commonPath=path.posix.join(source(peer.storageRootRef),peer.relativePath),worktreePath=source(binding.worktreeRootRef);
    const original=(rootRef:string,relativePath:string)=>{
      const record=proof.records.find(record=>record.rootRef===rootRef&&record.relativePath===relativePath);
      if(!record?.dataBase64)throw new Error('Missing reciprocal Git association original');
      const raw=text(Buffer.from(record.dataBase64,'base64'));
      if(!raw||/[\0\r]/.test(raw)||raw.replace(/\n$/,'').includes('\n'))throw new Error('Malformed Git association original');
      return raw.replace(/\n$/,'');
    };
    const directoryOriginal=(target:string)=>proof.records.some(record=>!record.absent&&record.dataBase64===undefined&&path.posix.join(source(record.rootRef),record.relativePath)===target);
    if(![worktreePath,privatePath,commonPath,path.posix.join(commonPath,'worktrees')].every(directoryOriginal))throw new Error('Captured Git topology lacks held directory evidence');
    for(const name of ['gitdir','commondir'])if(!proof.records.some(record=>record.absent===true&&path.posix.join(source(record.rootRef),record.relativePath)===path.posix.join(commonPath,name)))throw new Error('Captured common Git topology lacks explicit association absence evidence');
    const gitfile=original(binding.worktreeRootRef,'.git');
    const inPrivate=(name:string)=>binding.relativePath==='.'?name:binding.relativePath+'/'+name;
    if(!gitfile.startsWith('gitdir: ')||path.posix.resolve(worktreePath,gitfile.slice(8))!==privatePath||path.posix.resolve(privatePath,original(binding.storageRootRef,inPrivate('commondir')))!==commonPath||path.posix.resolve(privatePath,original(binding.storageRootRef,inPrivate('gitdir')))!==path.posix.join(worktreePath,'.git')||path.posix.dirname(privatePath)!==path.posix.join(commonPath,'worktrees')||worktreePath===commonPath||worktreePath===privatePath||path.posix.basename(privatePath).startsWith('.'))throw new Error('Git capture original pointers differ from their common/private final-root topology');
  }
}
/** Compare historical source evidence after portable refs/IDs have been deterministically remapped. */
export function gitBindingSourceEvidence(binding:PortableGitStorageBinding):string {
  const proof=binding.capture;if(!proof)throw new Error('Missing Git association capture evidence');
  const source=(ref:string)=>{const root=proof.roots.find(root=>root.rootRef===ref);if(!root)throw new Error('Git source evidence lacks root closure');return root.sourcePath;};
  return JSON.stringify([source(binding.worktreeRootRef),source(binding.storageRootRef),binding.relativePath,binding.role,
    proof.roots.map(root=>({sourcePath:root.sourcePath,identity:root.identity})).sort((a,b)=>a.sourcePath<b.sourcePath?-1:a.sourcePath>b.sourcePath?1:0),
    proof.records.map(record=>({sourcePath:source(record.rootRef),relativePath:record.relativePath,identity:record.identity,...(record.dataBase64!==undefined?{dataBase64:record.dataBase64}:{}),...(record.absent?{absent:true}:{}),...(record.moduleWorktree?{moduleWorktree:record.moduleWorktree}:{})})),
  ]);
}

export function validateReviewedMetadataActivation(value:unknown):asserts value is ReviewedMetadataActivation {
  fields(value,['sourceQualifier','destinationQualifier','principalMappings','replaceInheritedUserAndPosixAcl','rootRefs','fifo']);
  const activation=value as ReviewedMetadataActivation;
  for(const qualifier of [activation.sourceQualifier,activation.destinationQualifier])if(typeof qualifier!=='string'||!qualifier||qualifier.trim()!==qualifier||Buffer.byteLength(qualifier)>256||/[\x00-\x1f\x7f]/.test(qualifier))throw new Error('Invalid metadata provenance qualifier');
  if(activation.replaceInheritedUserAndPosixAcl!==true||typeof activation.fifo!=='boolean'||!Array.isArray(activation.rootRefs)||!activation.rootRefs.length||activation.rootRefs.length>10000)throw new Error('Choose explicit combined metadata replacement and final working roots');
  for(const ref of activation.rootRefs)portableBindingIdentity(ref);
  if(new Set(activation.rootRefs).size!==activation.rootRefs.length)throw new Error('Duplicate metadata working roots');
  if(!Array.isArray(activation.principalMappings)||activation.principalMappings.length>10000)throw new Error('Invalid metadata principal map');
  const source=new Set<string>(),destination=new Set<string>();
  for(const mapping of activation.principalMappings){
    fields(mapping,['sourceQualifier','kind','sourceId','destinationId']);
    if(mapping.sourceQualifier!==activation.sourceQualifier||!['user','group'].includes(mapping.kind))throw new Error('Metadata principal map has a foreign qualifier or kind');
    for(const id of [mapping.sourceId,mapping.destinationId])if(typeof id!=='string'||!/^(?:0|[1-9][0-9]{0,9})$/.test(id)||Number(id)>4294967294)throw new Error('Metadata principal IDs must be canonical unsigned decimal IDs');
    const from=JSON.stringify([mapping.kind,mapping.sourceId]),to=JSON.stringify([mapping.kind,mapping.destinationId]);
    if(source.has(from)||destination.has(to))throw new Error('Duplicate or collapsing metadata principal map');
    source.add(from);destination.add(to);
  }
}

/** The caller still binds this human choice to original evidence and a fresh destination. */
export function requireReviewedMetadataApplication(value:unknown):asserts value is ReviewedMetadataActivation {
  validateReviewedMetadataActivation(value);
}
export function validateReviewedUserDataActivation(value:unknown):asserts value is ReviewedUserDataActivation {
  fields(value,['git','harness'],['gitPathMappings']);
  const activation=value as ReviewedUserDataActivation;
  if(typeof activation.git!=='boolean'||typeof activation.harness!=='boolean'||!activation.git&&!activation.harness)throw new Error('Choose explicit Git or harness activation');
  if(activation.gitPathMappings!==undefined){
    if(!activation.git||!Array.isArray(activation.gitPathMappings)||!activation.gitPathMappings.length||activation.gitPathMappings.length>1000)throw new Error('Choose a bounded nonempty Git path mapping set');
    const sources=new Set<string>();
    for(const mapping of activation.gitPathMappings){
      fields(mapping,['source','destination']);
      for(const name of [mapping.source,mapping.destination])if(typeof name!=='string'||!path.posix.isAbsolute(name)||path.posix.normalize(name)!==name||Buffer.byteLength(name)>4096||/[\\\x00-\x1f\x7f]/.test(name))throw new Error('Git path mappings require canonical absolute paths');
      if(sources.has(mapping.source))throw new Error('Duplicate Git source path mapping');sources.add(mapping.source);
    }
  }
}

/** Values stay native configuration; only explicit whole path prefixes relocate. */
export function reviewedGitConfiguration(value:ReviewedUserData,activation:ReviewedUserDataActivation,includeOverrides:ReadonlyMap<string,string>=new Map(),sourceDirectories?:{common:string;private:string;home?:string}):{common:Buffer;private:Buffer|null;targets:string[];includes:Array<{source:string;destination:string}>} {
  const mappings=[...(activation.gitPathMappings??[])].sort((a,b)=>b.source.length-a.source.length),targets:string[]=[],includes:Array<{source:string;destination:string}>=[];
  const map=(source:string):string=>{
    const match=mappings.find(mapping=>source===mapping.source||source.startsWith((mapping.source==='/'?'':mapping.source)+'/'));
    if(!match)throw new Error('Choose an imported destination mapping for Git path: '+source);
    return path.posix.join(match.destination,path.posix.relative(match.source,source));
  };
  const sourceDirectory=(worktree:boolean):string=>{
    const directory=(sourceDirectories??value.git?.configurationSourceDirectories)?.[worktree?'private':'common'];
    if(directory)return directory;
    const binding=value.associationReview?.find(binding=>binding.role===(worktree?'private':'common'));
    const root=binding?.capture?.roots.find(root=>root.rootRef===binding.storageRootRef);
    if(!binding||!root)throw new Error('Relative external Git includes require captured source-directory provenance; use a new full mapped export');
    return path.posix.join(root.sourcePath,binding.relativePath);
  };
  const expandHome=(name:string):string=>{
    if(!name.startsWith('~'))return name;
    const home=(sourceDirectories??value.git?.configurationSourceDirectories)?.home;
    if(!home||name!=='~'&&!name.startsWith('~/'))throw new Error('Git home-based paths require captured source home provenance');
    return path.posix.join(home,name.slice(2));
  };
  const render=(worktree:boolean):Buffer=>{
    const rows:string[]=[];
    for(const original of value.git!.configurationReview.filter(item=>!!item.source===worktree)){
      let key=original.key,setting=original.value;
      const conditional=/^includeif\.(gitdir\/i:|gitdir:)(.+)\.path$/i.exec(key);
      if(conditional){
        const suffix=conditional[2]!.endsWith('/**')?'/**':conditional[2]!.endsWith('/')?'/':'';
        let condition=expandHome(conditional[2]!.slice(0,suffix? -suffix.length:undefined));
        if(condition.startsWith('./'))condition=path.posix.resolve(sourceDirectory(worktree),condition);
        if(path.posix.isAbsolute(condition))key='includeif.'+conditional[1]+map(condition)+suffix+'.path';
      }
      const include=/^(?:include|includeif\..+)\.path$/i.test(key);
      const pathSetting=include||/^core\.(?:hookspath|attributesfile|excludesfile)$/i.test(key)||/^(?:remote|submodule)\..+\.url$/i.test(key)&&setting.startsWith('/');
      if(pathSetting&&setting!=='/dev/null'){
        setting=expandHome(setting);
        const source=include?(path.posix.isAbsolute(setting)?setting:path.posix.resolve(sourceDirectory(worktree),setting)):setting;
        if(path.posix.isAbsolute(setting))setting=map(setting);
        else if(include)setting=map(source);
        targets.push(setting);
        if(include){includes.push({source,destination:setting});setting=includeOverrides.get(setting)??setting;}
      }
      const parts=key.split('.'),section=parts.shift()!,variable=parts.pop()!,subsection=parts.join('.');
      const quote=(text:string)=>'"'+text.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,'\\n').replace(/\t/g,'\\t').replace(/\x08/g,'\\b')+'"';
      rows.push('['+section+(subsection?' '+quote(subsection):'')+']\n\t'+variable+(original.implicitBoolean?'':' = '+quote(setting))+'\n');
    }
    return Buffer.from(rows.join(''));
  };
  const common=render(false),privateConfig=value.git!.configurationOriginalReview[1]!.dataBase64===null?null:render(true);
  return {common,private:privateConfig,targets,includes};
}

/** The same lexical/secret normalization used for the captured native configuration. */
export function parseReviewedGitConfiguration(data:Buffer):{data:Buffer;items:ReviewedGitUserData['configurationReview']} {
  if(data.length>1024*1024)throw new Error('Included Git configuration exceeds its byte bound');
  const safe=configSource(data).safe,parsed=configSource(safe);return {data:safe,items:parsed.items};
}

/** Validate the authoritative artifact before planning any native mutation. */
export function planReviewedUserDataActivation(data:Buffer,sha256:string,activation:ReviewedUserDataActivation,mapped=false):ReviewedUserData {
  validateReviewedUserDataActivation(activation);
  if(createHash('sha256').update(data).digest('hex')!==sha256)throw new Error('Reviewed activation original identity changed');
  const value=parseReviewedUserData(data);
  if(activation.git&&!value.selection.git||activation.harness&&!value.selection.harness)throw new Error('Activated family is absent from the authoritative original');
  if(activation.git)validateNativeGitSelection(value,mapped);
  const hasPosixMetadata=(git:ReviewedGitUserData):boolean=>reviewedGitModules(git).some(module=>module.originals.some(file=>file.metadata)||hasPosixMetadata(module.git));
  if(activation.git&&process.platform==='win32'&&(value.providerFiles.some(file=>gitReviewOriginal(file.path)&&file.metadata)||hasPosixMetadata(value.git!)))throw new Error('Windows cannot apply captured POSIX Git-original mode bits; choose inert recovery or a compatible destination');
  if(activation.harness&&process.platform==='win32')throw new Error('Exact provider POSIX metadata is unsupported on Windows');
  if(activation.harness&&!value.providerFiles.some(file=>!gitReviewOriginal(file.path))&&!value.providerDirectories.length)throw new Error('No selected harness originals are present');
  const paths=value.providerFiles.filter(file=>!gitReviewOriginal(file.path)).map(file=>file.path);
  if(paths.some(name=>paths.some(other=>name!==other&&other.startsWith(name+'/'))))throw new Error('Provider originals cannot be file parents');
  return value;
}

export async function assertReviewedProviderDestination(root:string,value:ReviewedUserData):Promise<void> {
  if(!path.isAbsolute(root)||path.resolve(root)!==root||await fs.realpath(root)!==root)throw new Error('Native provider destination must be canonical');
  for(const name of new Set([...value.providerDirectories.map(directory=>directory.path),...value.providerFiles.filter(file=>!gitReviewOriginal(file.path)).map(file=>file.path)].map(name=>name.split('/')[0]!))){
    try{await fs.lstat(path.join(root,name));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    throw new Error('Native provider destination already exists: '+name);
  }
}

/** Only semantics recreated by the before-initialization Shared-root writer. */
function validateNativeGitSelection(value:ReviewedUserData,mapped=false):void {
  if(value.associationReview&&!mapped)throw new Error('Mapped Git requires the complete explicit fresh destination root map');
  const git=value.git;if(!git)throw new Error('Native Git original is missing');
  if(git.configurationOriginalReview[0]!.dataBase64===null||git.configurationReview.some(item=>/^extensions\./i.test(item.key)&&!['extensions.objectformat','extensions.refstorage','extensions.worktreeconfig','extensions.relativeworktrees'].includes(item.key.toLowerCase())))throw new Error('Unsupported native Git repository format declarations');
  const versions=git.configurationReview.filter(item=>!item.source&&item.key.toLowerCase()==='core.repositoryformatversion'),formats=git.configurationReview.filter(item=>!item.source&&item.key.toLowerCase()==='extensions.objectformat');
  if(versions.length!==1||versions[0]!.implicitBoolean||!['0','1'].includes(versions[0]!.value)||formats.length>1||formats.some(item=>item.value!==git.format)||(git.reftableReview||formats.length)&&versions[0]!.value!=='1'||git.format==='sha256'&&formats.length!==1)throw new Error('Native Git format declarations differ from verified storage');
  for(const key of ['core.bare','core.filemode','core.ignorecase','core.precomposeunicode','core.quotepath','core.symlinks'])gitConfigurationBoolean(git.configurationReview,key);
  if(gitConfigurationBoolean(git.configurationReview,'core.bare'))throw new Error('Native Shared Git requires a non-bare source');
  if(git.indexOptionalReview.length)throw new Error('Native Git optional-index semantics require separate recreation');
  if(git.index.some(entry=>entry.mode==='160000')&&!Object.hasOwn(git,'modules'))throw new Error('Gitlink activation requires a fresh export with inspected module presence or absence');
  for(const file of value.providerFiles.filter(file=>/^\.git\/hooks\/[^/]+$/.test(file.path)&&!file.path.endsWith('.sample'))){
    if(!file.metadata)throw new Error('Active Git hooks require captured mode and timestamp; export the original again');
  }
}

/** Create directly into an empty NEW owned root, never replace a generated .git. */
export interface ReviewedGitModuleData {name:string;source:{storagePath:string;worktreePath:string;coreWorktree:string;configurationSha256:string;initialized:boolean;embedded?:true};worktreeRelativePath:string|null;git:ReviewedGitUserData;originals:ReviewedUserData['providerFiles']}
export function reviewedGitModules(value:ReviewedGitUserData):readonly ReviewedGitModuleData[] {return (value as ReviewedGitUserData&{modules?:ReviewedGitModuleData[]}).modules??[];}
export interface NativeReviewedGitModulePlan {gitDir:string;worktreePath:string;initialized:boolean;value:ReviewedUserData;activation:ReviewedUserDataActivation;configuration:NativeReviewedGitConfiguration}
export type NativeReviewedGitConfiguration=ReturnType<typeof reviewedGitConfiguration>&{includeFiles?:Array<{path:string;data:Buffer;private?:boolean}>;modules?:NativeReviewedGitModulePlan[]};
export interface NativeReviewedGitStorage {gitDir:string;worktreePath:string;initialized:boolean;existingRoot?:boolean}
type SelectedWorktreeReftable={tablesListBase64:string;tables:Array<{name:string;dataBase64:string}>};
export function selectedWorktreeReftable(value:ReviewedGitUserData):SelectedWorktreeReftable|undefined {
  return (value.reftableReview as (NonNullable<ReviewedGitUserData['reftableReview']>&{selectedWorktree?:SelectedWorktreeReftable})|null)?.selectedWorktree;
}
export async function createReviewedNativeGit(root:string,original:Buffer,sha256:string,activation:ReviewedUserDataActivation,configuration?:NativeReviewedGitConfiguration):Promise<Array<{path:string;sha256:string;device:bigint;inode:bigint}>> {
  const source=parseReviewedUserData(original),module=source.associationReview?.length===1&&source.associationReview[0]!.role==='module';
  const value=planReviewedUserDataActivation(original,sha256,activation,module);
  if(!activation.git||!value.git)throw new Error('Explicit native Git selection is required');
  if(selectedWorktreeReftable(value.git))throw new Error('Selected-worktree reftable requires fresh common/private native initialization');
  if(!configuration&&reviewedGitConfiguration(value,activation).includes.length)throw new Error('Native external includes require their complete transported configuration closure');
  return writeReviewedGit(root,value.git,value,undefined,false,configuration??reviewedGitConfiguration(value,activation));
}

/** Recovery roots were just created by the importer; existing native metadata is never replaced. */
export async function createReviewedRecoveryGit(root:string,original:Buffer,sha256:string,activation:ReviewedUserDataActivation,layout?:{commonDir:string;privateDir:string;writeCommon:boolean},configuration?:NativeReviewedGitConfiguration,storage?:NativeReviewedGitStorage):Promise<void> {
  const source=parseReviewedUserData(original),module=source.associationReview?.length===1&&source.associationReview[0]!.role==='module';
  const value=planReviewedUserDataActivation(original,sha256,activation,!!layout||module);
  if(!activation.git||!value.git)throw new Error('Explicit Git activation is required');
  await writeReviewedGit(root,value.git,value,layout,true,configuration??reviewedGitConfiguration(value,activation),storage);
}

/** Only freshly owned native roots; all collisions are checked before creating provider nodes. */
export async function applyReviewedProviderData(root:string,data:Buffer,sha256:string,activation:ReviewedUserDataActivation):Promise<void> {
  const value=planReviewedUserDataActivation(data,sha256,activation);
  if(!activation.harness)return;
  const files=value.providerFiles.filter(file=>!gitReviewOriginal(file.path));
  const directories=new Set(value.providerDirectories.map(directory=>directory.path));
  for(const name of [...directories,...files.map(file=>file.path)]){
    const parts=name.split('/');for(let i=1;i<parts.length;i++)directories.add(parts.slice(0,i).join('/'));
  }
  const ordered=[...directories].sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b));
  const rootHandle=await fs.open(root,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);
  const rootIdentity=await rootHandle.stat({bigint:true}).catch(async error=>{
    try{await rootHandle.close();}catch(cleanupError){throw Object.assign(new Error('Native provider root inspection failed; descriptor cleanup also failed',{cause:error}),{code:(error as {code?:string}).code,partialStatePossible:false,cleanupErrors:[cleanupError]});}
    throw error;
  });
  const opened=[rootHandle];
  let applicationError:Error|undefined;
  const handles:Array<{name:string;handle:Awaited<ReturnType<typeof fs.open>>;device:bigint;inode:bigint;kind:'file'|'directory';metadata?:{mode:number;mtimeNs:string}}>=[];
  const checkRoot=async()=>{
    const current=await fs.lstat(root,{bigint:true});
    if(!current.isDirectory()||current.dev!==rootIdentity.dev||current.ino!==rootIdentity.ino||await fs.realpath(root)!==root)throw new Error('Native activation destination identity changed');
  };
  const checkParents=async(name:string)=>{
    await checkRoot();
    for(const node of handles.filter(node=>node.kind==='directory'&&name.startsWith(node.name+'/'))){
      const current=await fs.lstat(path.join(root,node.name),{bigint:true});
      if(!current.isDirectory()||current.dev!==node.device||current.ino!==node.inode)throw new Error('Native provider parent identity changed');
    }
  };
  const checkNode=async(node:typeof handles[number])=>{
    await checkParents(node.name);const target=path.join(root,node.name),current=await fs.lstat(target,{bigint:true});
    if(current.dev!==node.device||current.ino!==node.inode||await fs.realpath(path.dirname(target))!==path.dirname(target))throw new Error('Native provider node membership changed');
  };
  try{
    await checkRoot();
    if(!rootIdentity.isDirectory())throw new Error('Native activation requires a directory');
    await assertReviewedProviderDestination(root,value);
    for(const name of ordered){
      await checkParents(name);const target=path.join(root,name);
      if(await fs.realpath(path.dirname(target))!==path.dirname(target))throw new Error('Native provider parent changed');
      await fs.mkdir(target,{mode:0o700});
      const handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);opened.push(handle);
      const stat=await handle.stat({bigint:true});
      handles.push({name,handle,device:stat.dev,inode:stat.ino,kind:'directory',metadata:value.providerDirectories.find(directory=>directory.path===name)});
    }
    for(const file of files){
      await checkParents(file.path);const target=path.join(root,file.path);
      if(await fs.realpath(path.dirname(target))!==path.dirname(target))throw new Error('Native provider parent changed');
      const handle=await fs.open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);opened.push(handle);
      const stat=await handle.stat({bigint:true});
      const node={name:file.path,handle,device:stat.dev,inode:stat.ino,kind:'file' as const,metadata:file.metadata};handles.push(node);
      await checkNode(node);await handle.writeFile(Buffer.from(file.dataBase64,'base64'));
    }
    // Files first, deepest directory last; retain descriptors through all application attempts.
    for(const node of [...handles.filter(node=>node.kind==='file'),...handles.filter(node=>node.kind==='directory').reverse()]){
      if(!node.metadata)continue;
      await checkNode(node);
      const expected={fd:node.handle.fd,expectedDevice:node.device,expectedInode:node.inode,kind:node.kind,mode:node.metadata.mode,mtimeNs:BigInt(node.metadata.mtimeNs)};
      const observed=applyExactFileMetadata(expected);
      if(observed.device!==node.device||observed.inode!==node.inode||observed.kind!==node.kind||observed.mode!==expected.mode||observed.mtimeNs!==expected.mtimeNs)throw new Error('Native metadata returned mismatched evidence');
      await checkNode(node);
    }
  }catch(error){
    applicationError=Object.assign(new Error('Native provider application incomplete; preserve destination and authoritative originals at '+root,{cause:error}),{partialStatePossible:true,code:(error as {code?:string}).code??'ERR_PROVIDER_APPLICATION_PARTIAL',observed:(error as {observed?:unknown}).observed??null});
  }finally{
    // Every opened descriptor is owned before stat; cleanup cannot replace mutation evidence.
    const cleanup=await Promise.allSettled(opened.map(handle=>handle.close()));
    const cleanupErrors=cleanup.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
    if(cleanupErrors.length){
      if(applicationError)Object.assign(applicationError,{cleanupErrors});
      else applicationError=Object.assign(new Error('Native provider application descriptor cleanup incomplete; preserve destination and originals'),{code:'ERR_PROVIDER_CLEANUP_PARTIAL',partialStatePossible:true,observed:null,cleanupErrors});
    }
  }
  if(applicationError)throw applicationError;
}

function codexReviewToml(value:string):boolean {
  return value==='.codex/config.toml'||/^\.codex\/agents\/[^/]+\.toml$/.test(value);
}
function claudeOutputStyle(value:string):boolean {
  return /^\.claude\/output-styles\/[^/]+\.md$/.test(value);
}
const providerDirectoryRoots=['.claude/commands','.claude/agents','.claude/rules','.codex/skills','.codex/rules','.codex/agents','.claude/output-styles','.claude/agent-memory','.claude/agent-memory-local','.claude/skills','.claude/hooks'];
const claudeNamedRoots=['.claude/agent-memory','.claude/agent-memory-local','.claude/skills'];
function claudeOpaqueOriginal(value:string,directory=false):boolean {
  const parts=value.split('/'),family=parts.slice(0,2).join('/');
  const minimum=claudeNamedRoots.includes(family)?(directory?3:4):family==='.claude/hooks'?3:Infinity;
  return parts.length>=minimum&&parts.slice(2).every(part=>!!part&&!part.startsWith('.')&&!/[\\\0]/.test(part))&&!credentialPath(value);
}
function providerDirectory(value:string):boolean {
  return ['.claude','.codex'].includes(value)||providerDirectoryRoots.includes(value)||providerDirectoryRoots.some(root=>value.startsWith(root+'/'))&&opaqueProviderOriginal(value,true)&&!gitReviewOriginal(value);
}
function providerMetadata(value:{mode:number;mtimeNs:string}):void {
  fields(value,['mode','mtimeNs']);
  if(!Number.isInteger(value.mode)||value.mode<0||value.mode>0o7777||typeof value.mtimeNs!=='string'||!/^(?:0|-?[1-9][0-9]{0,20})$/.test(value.mtimeNs))throw new Error('Invalid provider original metadata');
}
function providerJsonSettings(value:string):boolean {
  return ['.mcp.json','.claude/settings.json','.claude/settings.local.json'].includes(value);
}
const gitSelectedOriginalNames=['COMMIT_EDITMSG','SQUASH_MSG','TAG_EDITMSG','MERGE_MSG','EDIT_DESCRIPTION'];
const gitDirectoryOriginalNames=['hooks','branches','remotes','rr-cache','lost-found'];
const gitWebOriginalNames=['description','category','cloneurl','README.html'];
function gitReviewOriginal(value:string):boolean {
  return gitSelectedOriginalNames.some(name=>value==='.git/'+name)||gitWebOriginalNames.some(name=>value==='.git/'+name)||gitDirectoryOriginalNames.some(name=>value.startsWith('.git/'+name+'/'))&&value.split('/').every(part=>!!part&&part!=='.'&&part!=='..'&&!/[\\\0]/.test(part))&&!credentialPath(value);
}
function inspectGitReviewOriginal(data:Buffer,originalPath:string):void {
  if(data.includes(0))throw new Error('Git review originals require UTF-8 text, not binary data');
  const value=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);
  safeText(value,'Git review original');
  if(/^\.git\/(?:branches|remotes)\//.test(originalPath)&&/:\/\/[^/\s]*@/.test(value))throw new Error('Legacy Git remote original contains URL userinfo; preserve source');
}
function opaqueProviderOriginal(value:string,directory=false):boolean {
  if(gitReviewOriginal(value))return true;
  if(claudeOpaqueOriginal(value,directory)||['.claude/CLAUDE.md','.claude/AGENTS.md','.codex/instructions.md'].includes(value))return true;
  return /^\.(?:claude\/(?:commands|agents|rules)|codex\/(?:skills|rules))\//.test(value)&&value.split('/').every(part=>!!part&&part!=='.'&&part!=='..'&&!/[\\\0]/.test(part))&&!credentialPath(value);
}
function providerPath(value:string):boolean {
  return codexReviewToml(value)||claudeOutputStyle(value)||opaqueProviderOriginal(value)||providerJsonSettings(value);
}
function providerSupportOriginal(value:string):boolean {
  return opaqueProviderOriginal(value)&&['.claude/skills/','.codex/skills/','.claude/hooks/'].some(prefix=>value.startsWith(prefix));
}
function inspectProviderSupportOriginal(data:Buffer):void {
  // Match binary Git-object inspection without decoding/re-encoding the retained original.
  safeText(data.toString('latin1'),'Provider support original');
  let decoded:string;
  try{decoded=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);}catch{return;}
  safeText(decoded,'Provider support original');
}
function credentialPath(value:string):boolean {
  return value.split('/').some(part=>['.ssh','.aws','.gnupg','browser-profiles'].includes(part.toLowerCase())||/^\.env(?:\.|$)/i.test(part)||/^(?:credentials(?:\.json)?|auth\.json|.*\.(?:pem|key|p12))$/i.test(part));
}

type GitObject=ReviewedGitUserData['objects'][number];

/** Read-only plumbing: no hooks, filters, textconv, network, optional locks or inherited Git overrides. */
function git(root:string,args:string[],input?:Buffer):Promise<Buffer> {
  return new Promise((resolve,reject)=>{
    if(path.dirname(root).includes(path.delimiter)){reject(new Error('Git discovery ceiling cannot contain a path-list separator'));return;}
    const env:NodeJS.ProcessEnv={PATH:process.env.PATH,LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CEILING_DIRECTORIES:path.dirname(root),GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'};
    const child=execFile('git',['--no-pager','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.untrackedCache=false','-C',root,...args],{cwd:root,env,encoding:'buffer',maxBuffer:limit,timeout:30000},(error,stdout,stderr)=>error||stderr.length?reject(new Error('Portable Git read failed or warned; repository retained unchanged')):resolve(stdout));
    child.stdin!.on('error',()=>reject(new Error('Portable Git input failed; repository retained unchanged')));child.stdin!.end(input);
  });
}
function text(data:Buffer):string{return new TextDecoder('utf-8',{fatal:true}).decode(data);}
function objectId(format:'sha1'|'sha256',type:string,data:Buffer):string {
  return createHash(format).update(`${type} ${data.length}\0`).update(data).digest('hex');
}
function safeText(value:string,label:string):void {
  if(Buffer.byteLength(value)>4*1024*1024)throw new Error(`${label} exceeds the known-secret inspection bound`);
  assertPortableSecretsAbsent(value,label);
  if(redactPortableDiagnostic(value)!==value||/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)||/(?:^|\n)\s*(?:export\s+)?(?:[A-Z0-9_]+_)?(?:TOKEN|PASSWORD|SECRET|API_KEY|ACCESS_KEY)\s*=/m.test(value))throw new Error(`${label} contains recognizable credentials; preserve source and remove secrets explicitly`);
}
/** Bounded structured TOML subset; remove credential spans without rewriting retained values. */
function scrubReviewToml(value:string):{safe:string;removedSecretFields:boolean} {
  if(Buffer.byteLength(value)>1024*1024||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\r(?!\n)/.test(value))throw new Error('Invalid or oversized review TOML');
  let offset=0,entries=0,namespaceNodes=0;
  const removals:Array<{start:number;end:number}>=[];
  const remove=(start:number,end:number)=>{removals.push({start,end});};
  type Namespace={kind:'implicit'|'explicit'|'dotted'|'value'|'array';children:Map<string,Namespace>;latest?:Namespace};
  const namespace=(kind:Namespace['kind']):Namespace=>{if(++namespaceNodes>10000)throw new Error('Review TOML namespace exceeds its bound');return {kind,children:new Map()};};
  const root=namespace('explicit');let scope=root,scopeDepth=0,scopeSecret=false;
  const fail=():never=>{throw new Error('Invalid, ambiguous or unsupported review TOML value syntax');};
  const horizontal=()=>{while(value[offset]===' '||value[offset]==='\t')offset++;};
  const newline=()=>{if(value[offset]==='\r')offset++;if(value[offset]!=='\n')fail();offset++;};
  const endLine=()=>{horizontal();if(value[offset]==='#')while(offset<value.length&&value[offset]!=='\n'&&value[offset]!=='\r')offset++;if(offset<value.length)newline();};
  const registerPath=(base:Namespace,parts:string[],declaration:false|'table'|'array'):Namespace=>{
    let parent=base;
    for(const [index,part] of parts.entries()){
      const last=index===parts.length-1;let child=parent.children.get(part);
      if(declaration){
        if(last&&declaration==='array'){
          if(child&&child.kind!=='array')fail();
          if(!child){child=namespace('array');parent.children.set(part,child);}
          child.latest=namespace('explicit');return child.latest;
        }
        if(child?.kind==='array'){
          if(last||!child.latest)fail();parent=child.latest!;continue;
        }
        if(child?.kind==='value'||last&&child&&child.kind!=='implicit')fail();
        if(!child){child=namespace(last?'explicit':'implicit');parent.children.set(part,child);}
        else if(last)child.kind='explicit';
      }else{
        if(last){if(child)fail();child=namespace('value');parent.children.set(part,child);}
        else{
          if(child?.kind==='value'||child?.kind==='explicit'||child?.kind==='array')fail();
          if(!child){child=namespace('dotted');parent.children.set(part,child);}else child.kind='dotted';
        }
      }
      parent=child!;
    }
    return parent;
  };
  const string=(key=false):string=>{
    const quote=value[offset]!,basic=quote==='"',multiline=value.slice(offset,offset+3)===quote.repeat(3);
    if(key&&multiline)fail();
    offset+=multiline?3:1;let decoded='',closed=false;
    if(multiline&&(value[offset]==='\n'||value[offset]==='\r'))newline();
    while(offset<value.length){
      const character=value[offset]!;
      if(character===quote){
        let count=1;while(value[offset+count]===quote)count++;
        if(!multiline){offset++;closed=true;break;}
        if(count>=3){if(count>5)fail();decoded+=quote.repeat(count-3);offset+=count;closed=true;break;}
        decoded+=quote.repeat(count);offset+=count;continue;
      }
      if(character==='\n'||character==='\r'){
        if(!multiline)fail();newline();decoded+='\n';continue;
      }
      if(basic&&character==='\\'){
        offset++;const escaped=value[offset];
        if(multiline&&(escaped===' '||escaped==='\t'||escaped==='\n'||escaped==='\r')){
          horizontal();if(value[offset]!=='\n'&&value[offset]!=='\r')fail();newline();
          while(offset<value.length&&/[ \t\r\n]/.test(value[offset]!)){if(value[offset]==='\n'||value[offset]==='\r')newline();else offset++;}
          continue;
        }
        const escapes:Record<string,string>={b:'\b',t:'\t',n:'\n',f:'\f',r:'\r','"':'"','\\':'\\'};
        if(escaped!==undefined&&Object.hasOwn(escapes,escaped)){decoded+=escapes[escaped];offset++;continue;}
        if(escaped==='u'||escaped==='U'){
          const length=escaped==='u'?4:8,hex=value.slice(offset+1,offset+1+length);
          if(hex.length!==length||!/^[0-9a-f]+$/i.test(hex))fail();
          const code=Number.parseInt(hex,16);if(code>0x10ffff||code>=0xd800&&code<=0xdfff)fail();
          decoded+=String.fromCodePoint(code);offset+=1+length;continue;
        }
        fail();
      }
      decoded+=character;offset++;
    }
    if(!closed)fail();return decoded;
  };
  const keyPath=():string[]=>{
    const parts:string[]=[];
    while(true){
      if(parts.length>=64)fail();horizontal();
      if(value[offset]==='"'||value[offset]==="'")parts.push(string(true));
      else{const match=/^[A-Za-z0-9_-]+/.exec(value.slice(offset));if(!match)fail();parts.push(match![0]);offset+=match![0].length;}
      horizontal();if(value[offset]!=='.')return parts;offset++;
    }
  };
  const arrayWhitespace=()=>{
    while(offset<value.length){
      horizontal();
      if(value[offset]==='#'){while(offset<value.length&&value[offset]!=='\n'&&value[offset]!=='\r')offset++;}
      if(value[offset]==='\n'||value[offset]==='\r')newline();else break;
    }
  };
  let nodes=0;
  const readValue=(discard:boolean,depth=0):void=>{
    if(depth>32||++nodes>10000)throw new Error('Review TOML nesting/value inventory exceeds its bound');
    if(value[offset]==='"'||value[offset]==="'"){
      const decoded=string();if(!discard)safeText(decoded,'Decoded provider TOML string');return;
    }
    if(value[offset]==='['){
      offset++;arrayWhitespace();
      if(value[offset]===']'){offset++;return;}
      while(offset<value.length){
        readValue(discard,depth+1);arrayWhitespace();
        if(value[offset]===']'){offset++;return;}
        if(value[offset++]!==',')fail();arrayWhitespace();
        if(value[offset]===']'){offset++;return;}
      }
      fail();
    }
    if(value[offset]==='{'){
      offset++;const contentStart=offset;horizontal();const members=namespace('explicit');
      const spans:Array<{start:number;end:number;secret:boolean}>=[];
      if(value[offset]==='}'){offset++;return;}
      while(offset<value.length){
        const start=offset,parts=keyPath();registerPath(members,parts,false);
        horizontal();if(value[offset++]!=='=')fail();horizontal();
        const secret=discard||parts.some(isPortableSecretField);
        readValue(secret,depth+1);horizontal();spans.push({start,end:offset,secret});
        if(value[offset]==='}'){
          if(!discard){
            // Remove runs with one adjacent separator; retained member/value bytes stay exact.
            for(let i=0;i<spans.length;){
              if(!spans[i]!.secret){i++;continue;}
              const first=i;while(i<spans.length&&spans[i]!.secret)i++;
              const start=first===0?contentStart:spans[first-1]!.end;
              const end=i===spans.length?offset:first===0?spans[i]!.start:spans[i-1]!.end;
              remove(start,end);
            }
          }
          offset++;return;
        }
        if(value[offset++]!==',')fail();horizontal();
        // TOML 1.0 inline tables allow neither trailing commas nor layout newlines/comments.
        if(value[offset]==='}')fail();
      }
      fail();
    }
    const begin=offset;while(offset<value.length&&!/[,#\r\n\]}]/.test(value[offset]!))offset++;
    const scalar=value.slice(begin,offset).replace(/[ \t]+$/,'');
    if(/^(?:true|false|[+-]?(?:inf|nan))$/.test(scalar))return;
    const based=/^0(?:x[0-9a-fA-F](?:_?[0-9a-fA-F])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)$/.test(scalar);
    const decimal=/^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/.test(scalar);
    if(based||decimal){
      const numeric=scalar.replaceAll('_','');
      if(based||!/[.eE]/.test(numeric)){
        const digits=(based?numeric.slice(2):numeric.replace(/^[+-]/,'')).replace(/^0+/,'');
        const maxDigits=based?(numeric[1]==='x'?16:numeric[1]==='o'?21:63):19;
        if(digits.length>maxDigits)fail();
        const integer=based?BigInt(numeric.slice(0,2)+(digits||'0')):BigInt((numeric.startsWith('-')?'-':'')+(digits||'0'));
        if(integer<-(1n<<63n)||integer>(1n<<63n)-1n)fail();
      }else if(!Number.isFinite(Number(numeric)))fail();
      return;
    }
    const dated=/^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})?)?$/.exec(scalar);
    const timed=/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/.exec(scalar);
    if(dated){
      const year=Number(dated[1]),month=Number(dated[2]),day=Number(dated[3]);
      const days=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
      if(month<1||month>12||day<1||day>days[month-1]!)fail();
      if(dated[4]===undefined)return;
      if(Number(dated[4])>23||Number(dated[5])>59||Number(dated[6])>59)fail();
      const zone=dated[8];
      if(zone&&zone!=='Z'&&zone!=='z'&&(Number(zone.slice(1,3))>23||Number(zone.slice(4,6))>59))fail();
      return;
    }
    if(timed){if(Number(timed[1])>23||Number(timed[2])>59||Number(timed[3])>59)fail();return;}
    // Leap seconds and fractional precision beyond nanoseconds require explicit separate support.
    fail();
  };
  while(offset<value.length){
    if(++entries>10000)fail();const start=offset;horizontal();
    if(value[offset]==='#'||value[offset]==='\r'||value[offset]==='\n'||offset===value.length){endLine();if(scopeSecret)remove(start,offset);continue;}
    if(value[offset]==='['){
      offset++;const array=value[offset]==='[';if(array)offset++;
      const parts=keyPath();if(value[offset++]!==']'||array&&value[offset++]!==']')fail();
      scope=registerPath(root,parts,array?'array':'table');scopeDepth=parts.length;
      scopeSecret=parts.some(isPortableSecretField);endLine();if(scopeSecret)remove(start,offset);continue;
    }
    const parts=keyPath();if(scopeDepth+parts.length>64)fail();
    horizontal();if(value[offset++]!=='=')fail();horizontal();
    registerPath(scope,parts,false);
    const secret=scopeSecret||parts.some(isPortableSecretField);readValue(secret);
    endLine();if(secret)remove(start,offset);
  }
  let kept=0,safe='';
  // Parent removals subsume nested edits; all original namespace/syntax checks ran first.
  for(const span of removals.sort((a,b)=>a.start-b.start||b.end-a.end)){
    if(span.start>kept)safe+=value.slice(kept,span.start);
    kept=Math.max(kept,span.end);
  }
  safe+=value.slice(kept);return {safe,removedSecretFields:removals.length>0};
}
async function regularOriginal(target:string,maxBytes=1024*1024,expectedOwner?:bigint,fsSource?:GitSourceFs):Promise<{data:Buffer;mode:number;mtimeNs:string;identity:string}> {
  const fs=fsSource??sourceFs;
  if(await fs.realpath(path.dirname(target))!==path.dirname(target))throw new Error('Reviewed original parent is not canonical');
  const observed=await fs.lstat(target,{bigint:true});
  if(!observed.isFile()||observed.nlink!==1n||observed.size>BigInt(maxBytes)||expectedOwner!==undefined&&observed.uid!==expectedOwner)throw new Error('Reviewed data requires a bounded regular original');
  const handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let primary:unknown;
  try{
    const before=await handle.stat({bigint:true});
    if(!before.isFile()||before.nlink!==1n||before.dev!==observed.dev||before.ino!==observed.ino||before.size>BigInt(maxBytes)||expectedOwner!==undefined&&before.uid!==expectedOwner)throw new Error('Reviewed original changed before reading');
    const data=Buffer.alloc(Number(before.size));let offset=0;
    while(offset<data.length){const read=await handle.read(data,offset,data.length-offset,offset);if(!read.bytesRead)throw new Error('Reviewed original shortened');offset+=read.bytesRead;}
    const after=await handle.stat({bigint:true}),current=await fs.lstat(target,{bigint:true});
    if(before.uid!==after.uid||current.uid!==after.uid||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||current.dev!==after.dev||current.ino!==after.ino||current.nlink!==1n)throw new Error('Reviewed original changed during reading');
    return {data,mode:Number(before.mode)&0o7777,mtimeNs:before.mtimeNs.toString(),identity:originalIdentity(before)};
  }catch(error){primary=error;throw error;}finally{try{await handle.close();}catch(cleanup){throw Object.assign(new AggregateError([...(primary?[primary]:[]),cleanup],'Reviewed original descriptor cleanup failed'),{cause:primary,cleanupErrors:[cleanup]});}}
}
function refName(value:string):string {
  if(typeof value!=='string'||value.length>1024||!/^refs\/(?:[^\x00-\x20\x7f~^:?*\[\\]+)$/.test(value)||value.includes('..')||value.includes('@{')||value.split('/').some(part=>!part||part.startsWith('.')||part.endsWith('.')||part.endsWith('.lock')))throw new Error('Invalid portable Git ref');
  safeText(value,'Git ref');
  return value;
}
function privateRef(value:string):boolean {return /^refs\/(?:bisect|rewritten|worktree)(?:\/|$)/.test(value);}
function indexPath(value:string):string {
  if(!value||value.startsWith('/')||value.includes('\\')||value.includes('\0')||value.split('/').some(part=>!part||part==='.'||part==='..'||part.toLowerCase()==='.git'))throw new Error('Invalid portable Git index path');
  return value;
}
function excludedGitKey(key:string):boolean {
  return /password|token|secret|extraheader|authorization|^core\.worktree$/i.test(key)||/credential/i.test(key);
}

/** Pinned config.c lexical grammar; spans reference the original UTF-8 source, never include targets. */
function configSource(data:Buffer,source?:'config.worktree'):{items:ReviewedGitUserData['configurationReview'];safe:Buffer;removedFields:boolean} {
  const original=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);
  if(original.includes('\0')||!Buffer.from(original).equals(data))throw new Error('Git configuration requires exact UTF-8 source');
  let input='';const positions:number[]=[];
  for(let i=0;i<original.length;i++){positions.push(i);if(original[i]==='\r'&&original[i+1]==='\n'){input+='\n';i++;}else input+=original[i];}
  positions.push(original.length);
  let offset=input.startsWith('\uFEFF')?1:0,section='',headerStart=-1,headerEnd=-1,sectionExcluded=false;
  const items:ReviewedGitUserData['configurationReview']=[],remove:Array<{start:number;end:number}>=[];
  const fail=():never=>{throw new Error('Unsupported or malformed local Git config source; preserve source');};
  const whitespace=(c:string|undefined)=>c!==undefined&&/[ \t\r\v\f]/.test(c);
  const strip=(start:number,end:number)=>remove.push({start:positions[start]!,end:positions[end]!});
  while(offset<input.length){
    const c=input[offset]!;
    if(whitespace(c)||c==='\n'){offset++;continue;}
    if(c==='#'||c===';'){while(offset<input.length&&input[offset]!=='\n')offset++;continue;}
    if(c==='['){
      headerStart=offset++;let base='';
      while(offset<input.length&&/[A-Za-z0-9.-]/.test(input[offset]!))base+=input[offset++]!.toLowerCase();
      if(!base)fail();
      if(whitespace(input[offset])){
        while(whitespace(input[offset]))offset++;
        if(input[offset++]!=='"')fail();let subsection='',closed=false;
        while(offset<input.length){let part=input[offset++]!;if(part==='\n')fail();if(part==='"'){closed=true;break;}if(part==='\\'){if(offset>=input.length||input[offset]==='\n')fail();part=input[offset++]!;}subsection+=part;}
        if(!closed)fail();base+='.'+subsection;
      }
      if(input[offset++]!==']')fail();
      section=base;headerEnd=offset;sectionExcluded=excludedGitKey(section+'.');
      if(sectionExcluded)strip(headerStart,headerEnd);
      continue;
    }
    if(!section||!/[A-Za-z]/.test(c))fail();
    const start=offset;let variable=input[offset++]!.toLowerCase();
    while(offset<input.length&&/[A-Za-z0-9-]/.test(input[offset]!))variable+=input[offset++]!.toLowerCase();
    while(input[offset]===' '||input[offset]==='\t')offset++;
    let value='',implicitBoolean=false;
    if(offset===input.length||input[offset]==='\n'){implicitBoolean=true;if(input[offset]==='\n')offset++;}
    else {
      if(input[offset++]!=='=')fail();
      let quote=false,comment=false,trim=-1;
      while(offset<input.length){
        let part=input[offset++]!;
        if(part==='\n'){if(quote)fail();break;}
        if(comment)continue;
        if(!quote&&whitespace(part)){if(trim<0)trim=value.length;if(value.length)value+=part;continue;}
        if(!quote&&(part==='#'||part===';')){comment=true;continue;}
        trim=-1;
        if(part==='\\'){
          // Git v2.56 get_next_char supplies LF at EOF, including after a backslash.
          if(offset>=input.length)break;part=input[offset++]!;if(part==='\n')continue;
          const escapes:Record<string,string>={t:'\t',b:'\b',n:'\n','\\':'\\','"':'"'};
          if(!Object.hasOwn(escapes,part))fail();value+=escapes[part];continue;
        }
        if(part==='"'){quote=!quote;continue;}value+=part;
      }
      if(quote)fail();if(trim>=0)value=value.slice(0,trim);
    }
    if(items.length>=10000)fail();
    const item={key:section+'.'+variable,value,...(implicitBoolean?{implicitBoolean:true as const}:{}),...(source?{source}:{})};items.push(item);
    let excluded=sectionExcluded||excludedGitKey(item.key);
    try{safeText(`${item.key}=${value}`,'Git configuration');if(/:\/\/[^/]*@/.test(value))excluded=true;}catch{excluded=true;}
    if(excluded)strip(start,offset);
  }
  let kept=0,safe='';
  for(const span of remove.sort((a,b)=>a.start-b.start)){safe+=original.slice(kept,span.start);kept=span.end;}
  safe+=original.slice(kept);safeText(safe,'Git configuration source');
  if(/:\/\/[^/\s]*@/.test(safe))throw new Error('Git configuration source retains URL userinfo; preserve source');
  return {items,safe:Buffer.from(safe),removedFields:remove.length>0};
}

export function parseReviewedUserData(data:Buffer):ReviewedUserData {
  if(data.length>48*1024*1024)throw new Error('Reviewed user-data manifest exceeds its bound');
  const value=JSON.parse(text(data)) as ReviewedUserData;
  fields(value,['version','activation','selection','recreationScope','providerFiles','providerDirectories','exclusions'],['git','associationReview','filesystemMetadata']);
  if(value.associationReview!==undefined){
    if(!value.selection?.git||!Array.isArray(value.associationReview))throw new Error('Git association evidence requires the original Git selection');
    const roots=new Set(value.associationReview.flatMap(binding=>binding.capture?.roots.map(root=>root.rootRef)??[]));
    validatePortableGitStorageBindings(value.associationReview,roots);
    if(!((value.associationReview.length===1&&value.associationReview[0]!.role==='module')||(value.associationReview.length===2&&value.associationReview.every(binding=>binding.role!=='module')))||value.associationReview.some(binding=>!binding.capture||binding.capture.reviewSha256!==undefined)||new Set(value.associationReview.map(binding=>binding.worktreeRootRef)).size!==1)throw new Error('Retained association evidence requires one unhashed original common/private proof pair');
  }
  if(!value||value.version!==1||value.activation!=='inert_review_only'||!Array.isArray(value.providerFiles)||value.providerFiles.length>1000||!Array.isArray(value.exclusions)||value.exclusions.some(item=>typeof item!=='string'))throw new Error('Invalid reviewed user-data manifest');
  fields(value.selection,['git','harness'],['extendedMetadata','persistentNodes']);
  validateReviewedUserDataSelection(value.selection);
  if(value.selection.extendedMetadata||value.selection.persistentNodes){
    if(!value.filesystemMetadata)throw new Error('Selected metadata requires authoritative per-node evidence; omitted evidence is not absence');
    validateFilesystemMetadata(value.filesystemMetadata,value.selection);
  }else if(value.filesystemMetadata!==undefined)throw new Error('Unselected filesystem metadata');
  if(Object.hasOwn(value,'git')&&!value.git)throw new Error('Invalid selected Git data');
  if(!value.selection.git&&value.git||value.selection.git&&!value.git)throw new Error('Reviewed data differs from its explicit family selection');
  if(!value.recreationScope||Object.keys(value.recreationScope).length!==Object.keys(recreationScope).length||Object.entries(recreationScope).some(([key,status])=>(key==='cyclicLinks'? !['refuse','passive_in_root'].includes(value.recreationScope.cyclicLinks):(value.recreationScope as Record<string,string>)[key]!==status)))throw new Error('Required recreation semantics cannot be silently downgraded');
  if(!Array.isArray(value.providerDirectories)||value.providerDirectories.length+value.providerFiles.length>1000)throw new Error('Provider topology exceeds its bound');
  const directories=new Set<string>();
  for(const directory of value.providerDirectories){
    fields(directory,['path','mode','mtimeNs']);
    if(!value.selection.harness||typeof directory.path!=='string'||!providerDirectory(directory.path)||directory.path.split('/').some(part=>!part||part==='.'||part==='..')||directory.path.includes('\\')||directory.path.includes('\0')||credentialPath(directory.path)||directories.has(directory.path))throw new Error('Invalid selected provider directory');
    providerMetadata({mode:directory.mode,mtimeNs:directory.mtimeNs});directories.add(directory.path);
  }
  const paths=new Set<string>();let bytes=0;
  for(const file of value.providerFiles){
    fields(file,['path','dataBase64','removedSecretFields'],['metadata']);
    if(typeof file.path!=='string'||!providerPath(file.path)||file.path.split('/').some(part=>!part||part==='.'||part==='..')||credentialPath(file.path)||file.path.includes('\\')||file.path.includes('\0')||typeof file.dataBase64!=='string'||typeof file.removedSecretFields!=='boolean'||paths.has(file.path))throw new Error('Invalid reviewed provider original');
    const gitOriginal=gitReviewOriginal(file.path);
    if(!gitOriginal||file.metadata!==undefined)providerMetadata(file.metadata!);
    if(directories.has(file.path)||[...directories].some(directory=>directory.startsWith(file.path+'/')))throw new Error('Provider files cannot be directory parents');
    if(gitOriginal?!value.selection.git||!value.git||file.removedSecretFields:!value.selection.harness)throw new Error('Reviewed original differs from its explicit family selection');
    const data=Buffer.from(file.dataBase64,'base64');bytes+=data.length;
    if(data.length>1024*1024||bytes>limit||data.toString('base64')!==file.dataBase64)throw new Error('Reviewed provider original exceeds its bound');
    if(gitOriginal)inspectGitReviewOriginal(data,file.path);
    if(codexReviewToml(file.path)&&scrubReviewToml(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data)).removedSecretFields)throw new Error('Reviewed TOML retains known credential assignments');
    if(providerSupportOriginal(file.path)){
      if(file.removedSecretFields)throw new Error('Opaque provider support originals cannot claim secret removal');
      inspectProviderSupportOriginal(data);
    }else safeText(text(data),'Reviewed provider configuration');
    if(providerJsonSettings(file.path))assertPortableSecretsAbsent(JSON.parse(text(data)),'Reviewed provider configuration');
    if(opaqueProviderOriginal(file.path)&&[...paths].some(existing=>existing.startsWith(file.path+'/')||file.path.startsWith(existing+'/')))throw new Error('Conflicting opaque provider-original topology');
    paths.add(file.path);
  }
  if(value.git)validateReviewedGit(value.git);
  return value;
}

function reflogPath(value:string):void {
  if(typeof value!=='string'||value.length>1024)throw new Error('Invalid Git reflog path');
  if(value!=='HEAD')refName(value);
}

/** The historical review log shares the ordinary reflog grammar, object proof and total budget. */
function validateGitReflogData(encoded:string,format:'sha1'|'sha256',ids:Map<string,GitObject>,budget:{bytes:number;entries:number;missing:Set<string>}):void {
  if(typeof encoded!=='string'||encoded.length>Math.ceil(1024*1024/3)*4)throw new Error('Invalid Git reflog encoding');
  const oidPattern=format==='sha1'?/^[a-f0-9]{40}$/:/^[a-f0-9]{64}$/;
  const raw=Buffer.from(encoded,'base64');budget.bytes+=raw.length;
  if(raw.length>1024*1024||budget.bytes>limit||raw.toString('base64')!==encoded)throw new Error('Git reflog byte bound or encoding mismatch');
  // The files backend frames ASCII fields but does not declare an identity/message encoding.
  const original=raw.toString('latin1');safeText(original,'Git reflog');
  let decoded:string|undefined;try{decoded=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);}catch{}
  if(decoded!==undefined)safeText(decoded,'Git reflog');
  if(original&&!original.endsWith('\n'))throw new Error('Incomplete Git reflog entry');
  for(const line of original?original.slice(0,-1).split('\n'):[]){
    if(++budget.entries>10000)throw new Error('Git reflog entry count exceeds its bound');
    const entry=/^([a-f0-9]+) ([a-f0-9]+) ([^<>\x00-\x1f\x7f]+) <([^<>\x00-\x20\x7f]+)> ([0-9]{1,16}) ([+-][0-9]{4})\t([^\x00-\x1f\x7f]*)$/.exec(line);
    if(!entry||!oidPattern.test(entry[1]!)||!oidPattern.test(entry[2]!)||Number(entry[6]!.slice(1,3))>23||Number(entry[6]!.slice(3))>59)throw new Error('Unsupported Git reflog entry; preserve source');
    const zero='0'.repeat(format==='sha1'?40:64);
    if(entry[1]===zero&&entry[2]===zero)throw new Error('Git reflog has no object endpoint');
    for(const oid of [entry[1]!,entry[2]!])if(oid!==zero&&!ids.has(oid))budget.missing.add(oid);
  }
}

/** Canonical file-backend records only; originals stay inactive and exact. */
function parseGitOrigHeadReview(value:ReviewedGitUserData['origHeadReview'],format:'sha1'|'sha256'):{oid:string}|{symbolic:string}|undefined {
  fields(value,['path','source','dataBase64','reflogDataBase64']);
  if(value.path!=='ORIG_HEAD'||value.source!=='selected_worktree'||value.reflogDataBase64!==null&&typeof value.reflogDataBase64!=='string')throw new Error('Invalid ORIG_HEAD review path/provenance');
  if(value.dataBase64===null)return;
  if(typeof value.dataBase64!=='string'||value.dataBase64.length>Math.ceil(4096/3)*4)throw new Error('ORIG_HEAD original exceeds its bound');
  const raw=Buffer.from(value.dataBase64,'base64'),original=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);
  if(raw.length>4096||raw.toString('base64')!==value.dataBase64||!Buffer.from(original).equals(raw)||!original.endsWith('\n'))throw new Error('Invalid ORIG_HEAD original bytes; preserve source');
  safeText(original,'Git ORIG_HEAD original');
  const binding=original.slice(0,-1);
  if(binding.startsWith('ref: '))return {symbolic:refName(binding.slice(5))};
  if(!(format==='sha1'?/^[a-f0-9]{40}$/:/^[a-f0-9]{64}$/).test(binding)||/^0+$/.test(binding))throw new Error('Unsupported ORIG_HEAD binding; preserve source');
  return {oid:binding};
}

/** Native fetch records have two framing tabs; the remaining note is opaque review text. */
function parseGitFetchHeadReview(value:ReviewedGitUserData['fetchHeadReview'],format:'sha1'|'sha256'):Array<{oid:string;merge:boolean}> {
  fields(value,['path','source','dataBase64']);
  if(value.path!=='FETCH_HEAD'||value.source!=='selected_worktree')throw new Error('Invalid FETCH_HEAD review path/provenance');
  if(value.dataBase64===null)return [];
  if(typeof value.dataBase64!=='string'||value.dataBase64.length>Math.ceil(1024*1024/3)*4)throw new Error('FETCH_HEAD original exceeds its bound');
  const raw=Buffer.from(value.dataBase64,'base64'),original=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);
  if(raw.length>1024*1024||raw.toString('base64')!==value.dataBase64||!Buffer.from(original).equals(raw)||original&&!original.endsWith('\n'))throw new Error('Invalid FETCH_HEAD original bytes; preserve source');
  safeText(original,'Git FETCH_HEAD original');
  const lines=original?original.slice(0,-1).split('\n'):[];
  if(lines.length>10000)throw new Error('FETCH_HEAD entry count exceeds its bound');
  const oidPattern=format==='sha1'?/^[a-f0-9]{40}$/:/^[a-f0-9]{64}$/;
  return lines.map(line=>{
    const entry=/^([a-f0-9]+)\t(not-for-merge|)\t([^\x00\n]*)$/.exec(line);
    if(!entry||!oidPattern.test(entry[1]!)||/^0+$/.test(entry[1]!))throw new Error('Unsupported FETCH_HEAD record; preserve source');
    return {oid:entry[1]!,merge:entry[2]===''};
  });
}

/** Decode either original index layout without guessing missing CRCs or hash widths. */
function decodeRetentionPackIndex(idx:Buffer,format:'sha1'|'sha256',packChecksum:Buffer):Array<{oid:string;offset:number;crc:number|null}> {
  const width=format==='sha1'?20:32;
  const fail=():never=>{throw new Error('Unsupported or inconsistent Git retention pack index; preserve originals');};
  if(idx.length<1024+2*width||idx.length>1024*1024||packChecksum.length!==width)fail();
  const v2=idx.readUInt32BE(0)===0xff744f63;
  if(v2&&idx.readUInt32BE(4)!==2)fail();
  const fanoutStart=v2?8:0,names=fanoutStart+1024,count=idx.readUInt32BE(fanoutStart+1020);
  const fixedLength=names+count*(width+(v2?8:4))+2*width,largeBytes=idx.length-fixedLength;
  if(count>10000||largeBytes<0||(v2?largeBytes%8!==0||largeBytes/8>count:largeBytes!==0)||!idx.subarray(-2*width,-width).equals(packChecksum)||!createHash(format).update(idx.subarray(0,-width)).digest().equals(idx.subarray(-width)))fail();
  const largeCount=largeBytes/8,largeStart=fixedLength-2*width,largeReferences=new Set<number>();
  safeText(idx.toString('latin1'),'Git retention pack index');
  const entries:Array<{oid:string;offset:number;crc:number|null}>=[],fanout=Array<number>(256).fill(0);let last='';
  for(let i=0;i<count;i++){
    const name=v2?names+i*width:names+i*(width+4)+4,oid=idx.subarray(name,name+width).toString('hex');
    if(oid<=last)fail();last=oid;
    const bucket=parseInt(oid.slice(0,2),16);fanout[bucket]=fanout[bucket]!+1;
    let offset=idx.readUInt32BE(v2?names+count*(width+4)+i*4:names+i*(width+4));
    if(v2&&(offset&0x80000000)){
      const reference=offset&0x7fffffff;
      if(reference>=largeCount||largeReferences.has(reference))fail();
      largeReferences.add(reference);
      // Native Git can encode small offsets indirectly; bound the exact integer before conversion.
      const actual=idx.readBigUInt64BE(largeStart+reference*8);
      if(actual>BigInt(Number.MAX_SAFE_INTEGER)||actual<12n||actual>=BigInt(limit))fail();
      offset=Number(actual);
    }
    if(offset<12||offset>=limit)fail();
    entries.push({oid,offset,crc:v2?idx.readUInt32BE(names+count*width+i*4):null});
  }
  if(largeReferences.size!==largeCount)fail();
  let cumulative=0;for(let i=0;i<256;i++){cumulative+=fanout[i]!;if(idx.readUInt32BE(fanoutStart+i*4)!==cumulative)fail();}
  return entries;
}

/** Verify retention against exact bounded pack/index originals, independently of native Git. */
function validatePackRetention(records:ReviewedGitUserData['packRetentionReview'],format:'sha1'|'sha256',objects:Map<string,GitObject>,availableBytes:number):void {
  if(!Array.isArray(records)||records.length>1000)throw new Error('Invalid Git pack retention inventory');
  const width=format==='sha1'?20:32;let total=0,inflatedBytes=0,previous='';
  const fail=():never=>{throw new Error('Unsupported or inconsistent Git pack retention evidence; preserve originals');};
  const raw=(encoded:string,max:number):Buffer=>{
    if(typeof encoded!=='string'||encoded.length>Math.ceil(max/3)*4)fail();
    const data=Buffer.from(encoded,'base64');total+=data.length;
    if(data.length>max||total>availableBytes||data.toString('base64')!==encoded)fail();return data;
  };
  const checksum=(data:Buffer)=>data.length>=width&&createHash(format).update(data.subarray(0,-width)).digest().equals(data.subarray(-width));
  for(const record of records){
    fields(record,['packOid','packDataBase64','indexDataBase64','keepDataBase64','mtimesDataBase64','objects']);
    if(typeof record.packOid!=='string'||!new RegExp('^[a-f0-9]{'+width*2+'}$').test(record.packOid)||record.packOid<=previous||record.keepDataBase64===null&&record.mtimesDataBase64===null)fail();previous=record.packOid;
    const pack=raw(record.packDataBase64,limit),idx=raw(record.indexDataBase64,1024*1024);
    if(pack.length<12+width||pack.toString('latin1',0,4)!=='PACK'||![2,3].includes(pack.readUInt32BE(4))||!checksum(pack)||pack.subarray(-width).toString('hex')!==record.packOid)fail();
    const decoded=decodeRetentionPackIndex(idx,format,pack.subarray(-width)),count=decoded.length;
    if(pack.readUInt32BE(8)!==count||!Array.isArray(record.objects)||record.objects.length!==count)fail();
    const entries=decoded.map((item,i)=>{
      const object=objects.get(item.oid),entry=record.objects[i]!;
      fields(entry,['oid','mtime']);
      if(!object||entry.oid!==item.oid)fail();
      return {...item,object:object!};
    });
    if(record.keepDataBase64!==null)safeText(raw(record.keepDataBase64,1024*1024).toString('latin1'),'Git pack keep original');
    let mtimes:Buffer|undefined;
    if(record.mtimesDataBase64!==null){
      mtimes=raw(record.mtimesDataBase64,1024*1024);safeText(mtimes.toString('latin1'),'Git pack retention timestamps');
      if(mtimes.length!==12+count*4+2*width||mtimes.toString('latin1',0,4)!=='MTME'||mtimes.readUInt32BE(4)!==1||mtimes.readUInt32BE(8)!==(format==='sha1'?1:2)||!checksum(mtimes)||!mtimes.subarray(-2*width,-width).equals(pack.subarray(-width)))fail();
    }
    for(let i=0;i<count;i++)if(record.objects[i]!.mtime!==(mtimes?mtimes.readUInt32BE(12+i*4):null))fail();
    const ordered=[...entries].sort((a,b)=>a.offset-b.offset),byOffset=new Map(entries.map(entry=>[entry.offset,entry])),byOid=new Map(entries.map(entry=>[entry.oid,entry]));
    if(count===0&&pack.length!==12+width||count>0&&ordered[0]!.offset!==12)fail();
    const packed=new Map<typeof entries[number],{base:typeof entries[number]|undefined;cursor:number;end:number;size:number;type:number}>();
    for(let i=0;i<count;i++){
      const entry=ordered[i]!,end=i+1<count?ordered[i+1]!.offset:pack.length-width;
      if(entry.offset<12||entry.offset>=end||end>pack.length-width)fail();
      if(entry.crc!==null&&crc32(pack.subarray(entry.offset,end))!==entry.crc)fail();
      let cursor=entry.offset;
      const byte=()=>{if(cursor>=end)fail();return pack[cursor++]!;};
      let head=byte(),size=head&15,multiplier=16,parts=0;const type=(head>>>4)&7;
      while(head&128){if(++parts>4)fail();head=byte();size+=(head&127)*multiplier;multiplier*=128;}
      inflatedBytes+=size;if(size>limit||inflatedBytes>limit)fail();
      let base:typeof entry|undefined;
      if(type===6){let b=byte(),distance=b&127;parts=0;while(b&128){if(++parts>4)fail();b=byte();distance=(distance+1)*128+(b&127);}base=byOffset.get(entry.offset-distance);}
      else if(type===7){if(cursor+width>end)fail();base=byOid.get(pack.subarray(cursor,cursor+width).toString('hex'));cursor+=width;}
      else if(![1,2,3,4].includes(type))fail();
      if((type===6||type===7)&&(!base||base===entry||type===6&&base.offset>=entry.offset))fail();
      packed.set(entry,{base,cursor,end,size,type});
    }
    // Schedule each complete indexed entry once, with its same-pack base first.
    const state=new Map<typeof entries[number],1|2>(),verificationOrder:typeof entries=[];
    for(const entry of ordered){
      const chain:typeof entries=[];let next:typeof entry|undefined=entry;
      while(next&&state.get(next)!==2){
        if(state.get(next)===1)fail();
        state.set(next,1);chain.push(next);next=packed.get(next)!.base;
      }
      while(chain.length){const ready=chain.pop()!;state.set(ready,2);verificationOrder.push(ready);}
    }
    for(const entry of verificationOrder){
      const {base,cursor,end,size,type}=packed.get(entry)!;
      const inflated=inflateSync(pack.subarray(cursor,end),{maxOutputLength:limit,info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
      if(inflated.engine.bytesWritten!==end-cursor||inflated.buffer.length!==size)fail();
      let data=inflated.buffer,objectType=['','commit','tree','blob','tag'][type];
      if(base){
        inflatedBytes+=Buffer.byteLength(base.object.dataBase64,'base64');if(inflatedBytes>limit)fail();
        const original=Buffer.from(base.object.dataBase64,'base64');let pos=0;
        const take=()=>{if(pos>=data.length)fail();return data[pos++]!;};
        const integer=()=>{let n=0,m=1,b:number,groups=0;do{if(++groups>4)fail();b=take();n+=(b&127)*m;m*=128;}while(b&128);if(n>limit)fail();return n;};
        if(integer()!==original.length)fail();const target=integer(),chunks:Buffer[]=[];let written=0;
        inflatedBytes+=target;if(inflatedBytes>limit)fail();
        while(pos<data.length){
          const instruction=take();let chunk:Buffer;
          if(instruction&128){let start=0,length=0;for(let j=0;j<4;j++)if(instruction&(1<<j))start+=take()*2**(8*j);for(let j=0;j<3;j++)if(instruction&(16<<j))length+=take()*2**(8*j);if(!length)length=65536;if(start+length>original.length)fail();chunk=original.subarray(start,start+length);}
          else{if(!instruction||pos+instruction>data.length)fail();chunk=data.subarray(pos,pos+instruction);pos+=instruction;}
          written+=chunk.length;if(written>target||chunks.length>=10000)fail();chunks.push(chunk);
        }
        if(written!==target)fail();data=Buffer.concat(chunks,target);objectType=base.object.type;
      }
      if(objectType!==entry.object.type||!data.equals(Buffer.from(entry.object.dataBase64,'base64'))||objectId(format,entry.object.type,data)!==entry.oid)fail();
    }
  }
}

type ReftableRef={name:string;oid?:string;peeled?:string;symbolic?:string;deleted:boolean};
type ReftableLog={key:string;name:string;old?:string;next?:string;deleted:boolean};

function reftableNames(data:Buffer):string[] {
  const value=text(data);
  if(data.length>65536||value&&!value.endsWith('\n'))throw new Error('Invalid bounded reftable stack list');
  const names=value?value.slice(0,-1).split('\n'):[];
  if(names.length>1000||new Set(names).size!==names.length||names.some(name=>!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.(?:ref|log)$/.test(name)||name.includes('..')))throw new Error('Invalid reftable selected filename');
  return names;
}
function reftableRefName(raw:Buffer):string {
  const name=text(raw);if(!Buffer.from(name).equals(raw))throw new Error('Unsupported reftable ref encoding');
  const root=/^[A-Z_-]+$/.test(name)&&(name.endsWith('_HEAD')&&!['FETCH_HEAD','MERGE_HEAD'].includes(name)||['HEAD','AUTO_MERGE','BISECT_EXPECTED_REV','NOTES_MERGE_PARTIAL','NOTES_MERGE_REF','MERGE_AUTOSTASH'].includes(name));
  if(!root)refName(name);
  return name;
}

/** Pinned Git v2.56.0 reftable grammar; parse every record before native views or import writes. */
function decodeReftable(data:Buffer,format:'sha1'|'sha256',budget:{records:number;inflated:number;keys:number}) {
  const fail=():never=>{throw new Error('Malformed or unsupported selected reftable; preserve source');};
  if(data.length<92||data.length>4*1024*1024||data.toString('ascii',0,4)!=='REFT')fail();
  const version=data[4],header=version===1?24:version===2?28:fail(),footerSize=header+44,footer=data.length-footerSize;
  if(footer<header||!data.subarray(0,header).equals(data.subarray(footer,footer+header))||crc32(data.subarray(footer,data.length-4))!==data.readUInt32BE(data.length-4))fail();
  if(version===1&&format!=='sha1'||version===2&&data.toString('ascii',24,28)!==(format==='sha1'?'sha1':'s256'))fail();
  const width=format==='sha1'?20:32,blockSize=data.readUIntBE(5,3),min=data.readBigUInt64BE(8),max=data.readBigUInt64BE(16);
  if(min>max)fail();safeText(data.toString('latin1'),'Reftable original');
  const number=(value:bigint)=>{if(value>BigInt(footer)||value<0n)fail();return Number(value);};
  const refIndex=number(data.readBigUInt64BE(footer+header)),objectField=data.readBigUInt64BE(footer+header+8),objectPosition=number(objectField>>5n),objectWidth=Number(objectField&31n),objectIndex=number(data.readBigUInt64BE(footer+header+16)),logPosition=number(data.readBigUInt64BE(footer+header+24)),logIndex=number(data.readBigUInt64BE(footer+header+32));
  const logStart=logPosition||(data[header]===103?header:0);
  const sections=[refIndex,objectPosition,objectIndex,logPosition,logIndex].filter(Boolean);
  if(sections.some((value,i)=>value<header||value>=footer||i>0&&value<=sections[i-1]!)||objectPosition===0&&(objectWidth!==0||objectIndex!==0)||objectPosition!==0&&(objectWidth<2||objectWidth>Math.min(31,width)))fail();
  type Block={position:number;type:string;family:'ref'|'object'|'log';last:Buffer;keys:Buffer[];children:number[];refs:ReftableRef[]};
  const blocks=new Map<number,Block>(),refs:ReftableRef[]=[],logs:ReftableLog[]=[],objectRecords:Array<{key:Buffer;positions:number[]}>=[];
  const indexed=new Set<string>(),prior=new Map<string,Buffer>();let offset=header,records=0,inflatedBytes=0;
  while(offset<footer){
    if(data[offset]===0){
      if(!blockSize||logStart&&offset>=logStart)fail();const aligned=Math.ceil(offset/blockSize)*blockSize;
      if(aligned<=offset||aligned>footer||data.subarray(offset,aligned).some(byte=>byte!==0))fail();offset=aligned;
    }
    if(offset+4>footer)fail();
    const position=offset,type=String.fromCharCode(data[offset]!),length=data.readUIntBE(offset+1,3),firstBlock=offset===header,origin=firstBlock?0:position;
    const family:Block['family']=logStart&&position>=logStart?'log':objectPosition&&position>=objectPosition?'object':'ref';
    if(!['r','i','o','g'].includes(type)||type==='r'&&family!=='ref'||type==='o'&&family!=='object'||type==='g'&&family!=='log'||length<6||length>16777215||type!=='g'&&blockSize&&length>blockSize&&type!=='i')fail();
    if(type==='i')indexed.add(family);else if(indexed.has(family))fail();
    let body:Buffer,end:number,base:number;
    if(type==='g'){
      const inflated=inflateSync(data.subarray(position+4,footer),{maxOutputLength:Math.min(limit-inflatedBytes,length-(position-origin)-4),info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
      if(inflated.buffer.length!==length-(position-origin)-4||!Number.isSafeInteger(inflated.engine.bytesWritten)||inflated.engine.bytesWritten<1)fail();
      body=Buffer.concat([data.subarray(origin,position+4),inflated.buffer]);base=position-origin+4;end=position+4+inflated.engine.bytesWritten;inflatedBytes+=body.length;budget.inflated+=body.length;if(budget.inflated>limit)fail();
    }else{
      end=origin+length;if(end>footer||end<=position+4)fail();body=data.subarray(origin,end);base=position-origin+4;
    }
    if(end>footer||body.length<base+5)fail();
    const count=body.readUInt16BE(body.length-2),restartStart=body.length-2-count*3;
    if(!count||restartStart<base)fail();
    const restarts:number[]=[];
    for(let i=0;i<count;i++){const value=body.readUIntBE(restartStart+i*3,3);if(value<base||value>=restartStart||i>0&&value<=restarts[i-1]!)fail();restarts.push(value);}
    if(restarts[0]!==base)fail();
    let cursor=base,last=Buffer.alloc(0),restart=0;
    const take=(size:number)=>{if(!Number.isSafeInteger(size)||size<0||cursor+size>restartStart)fail();const result=body.subarray(cursor,cursor+size);cursor+=size;return result;};
    const vint=()=>{let value=0n,more=true,bytes=0;while(more){const byte=take(1)[0]!;if(++bytes>10)fail();value=bytes===1?BigInt(byte&127):(value+1n)*128n+BigInt(byte&127);more=!!(byte&128);if(value>0xffffffffffffffffn)fail();}return value;};
    const bounded=()=>{const value=vint();if(value>BigInt(restartStart))fail();return Number(value);};
    const blob=()=>take(bounded());
    const block:Block={position,type,family,last:Buffer.alloc(0),keys:[],children:[],refs:[]};
    while(cursor<restartStart){
      const at=cursor,prefix=bounded(),encoded=vint(),suffix=Number(encoded>>3n),valueType=Number(encoded&7n);
      if(prefix>last.length||encoded>>3n>BigInt(restartStart)||restarts[restart]!==undefined&&restarts[restart]!<at)fail();
      if(restarts[restart]===at){if(prefix!==0)fail();restart++;}
      const key=Buffer.concat([last.subarray(0,prefix),take(suffix)]);
      if(!key.length||key.length>4105||(budget.keys+=key.length)>limit||last.length&&Buffer.compare(key,last)<=0||++records>20000||++budget.records>20000)fail();
      const orderKey=type==='i'?family+'-index-'+position:type;
      const previous=prior.get(orderKey);if(previous&&Buffer.compare(key,previous)<=0)fail();prior.set(orderKey,key);
      block.keys.push(key);last=key;
      if(type==='r'){
        const name=reftableRefName(key),update=min+vint();if(update>max||valueType>3)fail();
        const ref:ReftableRef={name,deleted:valueType===0};
        if(valueType===1||valueType===2){ref.oid=take(width).toString('hex');if(/^0+$/.test(ref.oid))fail();if(valueType===2)ref.peeled=take(width).toString('hex');}
        if(valueType===3)ref.symbolic=reftableRefName(blob());
        refs.push(ref);block.refs.push(ref);
      }else if(type==='g'){
        const nul=key.indexOf(0);if(nul<1||nul!==key.length-9||valueType>1)fail();
        const name=reftableRefName(key.subarray(0,nul)),update=0xffffffffffffffffn-key.readBigUInt64BE(nul+1);
        // Pinned writer permits replacement/deletion of log keys older than this table's min.
        const log:ReftableLog={key:key.toString('hex'),name,deleted:valueType===0};
        if(valueType===1){
          if(update>max)fail();
          log.old=take(width).toString('hex');log.next=take(width).toString('hex');
          for(const field of [blob(),blob()]){if(field.includes(0))fail();safeText(field.toString('latin1'),'Reftable identity');let decoded:string|undefined;try{decoded=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(field);}catch{}if(decoded!==undefined)safeText(decoded,'Reftable identity');}
          vint();take(2);const message=blob();if(message.includes(0))fail();safeText(message.toString('latin1'),'Reftable log message');let decoded:string|undefined;try{decoded=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(message);}catch{}if(decoded!==undefined)safeText(decoded,'Reftable log message');
        }
        logs.push(log);
      }else if(type==='i'){
        if(valueType)fail();const target=number(vint());if(target>=position&&!(position===header&&target===0))fail();block.children.push(target);
      }else{
        if(key.length!==objectWidth)fail();let count=valueType?BigInt(valueType):vint();if(count>10000n)fail();const positions:number[]=[];let target=0;
        while(count--){const delta=number(vint());target+=delta;if(target>=footer||positions.length&&delta===0)fail();positions.push(target);}
        objectRecords.push({key,positions});
      }
    }
    if(cursor!==restartStart||restart!==restarts.length)fail();block.last=last;blocks.set(position,block);offset=end;
  }
  if(offset!==footer)fail();
  for(const block of blocks.values())if(block.type==='i')for(const [i,target] of block.children.entries()){
    const child=blocks.get(target===0?header:target);
    if(!child||child.family!==block.family||!child.last.equals(block.keys[i]!))fail();
  }
  const leaves=(family:Block['family'])=>[...blocks.values()].filter(block=>block.family===family&&block.type!=='i');
  const checkIndex=(position:number,family:Block['family'],required:boolean)=>{
    if(!position){if(required)fail();return;}
    const seen=new Set<number>(),visit=(at:number,depth=0)=>{if(depth>32)fail();const block=blocks.get(at);if(!block||block.family!==family||seen.has(at))fail();seen.add(at);for(const child of block.children)visit(child===0?header:child,depth+1);};
    if(blocks.get(position)?.type!=='i')fail();let last:Buffer|undefined;for(const root of blocks.values())if(root.family===family&&root.position>=position){if(root.type!=='i'||last&&Buffer.compare(root.keys[0]!,last)<=0)fail();last=root.last;visit(root.position);}if(leaves(family).some(block=>!seen.has(block.position)))fail();
  };
  checkIndex(refIndex,'ref',!blockSize&&leaves('ref').length>1);checkIndex(objectIndex,'object',false);checkIndex(logIndex,'log',false);
  if(objectPosition&&blocks.get(objectPosition)?.type!=='o'||logStart&&blocks.get(logStart)?.type!=='g')fail();
  for(const record of objectRecords){
    const matches=leaves('ref').filter(block=>block.refs.some(ref=>[ref.oid,ref.peeled].some(oid=>oid&&Buffer.from(oid,'hex').subarray(0,objectWidth).equals(record.key))));
    if(!matches.length||record.positions.some(position=>!matches.some(block=>block.position===(position===0?header:position)))||record.positions.length&&matches.some(block=>!record.positions.some(position=>(position===0?header:position)===block.position)))fail();
  }
  return {min,max,refs,logs};
}

function decodeReftableReview(value:NonNullable<ReviewedGitUserData['reftableReview']>,format:'sha1'|'sha256') {
  fields(value,['source','tablesListBase64','tables'],['selectedWorktree']);
  if(value.source!=='common_repository')throw new Error('Invalid reftable provenance');
  const budget={records:0,inflated:0,keys:0};let bytes=0;
  const stack=(original:{tablesListBase64:string;tables:Array<{name:string;dataBase64:string}>})=>{
    if(typeof original.tablesListBase64!=='string'||original.tablesListBase64.length>87384||!Array.isArray(original.tables))throw new Error('Invalid reftable stack');
    const list=Buffer.from(original.tablesListBase64,'base64');bytes+=list.length;
    if(list.toString('base64')!==original.tablesListBase64)throw new Error('Invalid reftable list encoding');
    const names=reftableNames(list);if(names.length!==original.tables.length)throw new Error('Reftable stack is incomplete');
    const refs=new Map<string,ReftableRef>(),logs=new Map<string,ReftableLog>();let prior=-1n;
    for(const [index,table] of original.tables.entries()){
      fields(table,['name','dataBase64']);if(table.name!==names[index]||typeof table.dataBase64!=='string'||table.dataBase64.length>Math.ceil(4*1024*1024/3)*4)throw new Error('Reftable stack order differs');
      const data=Buffer.from(table.dataBase64,'base64');bytes+=data.length;if(bytes>limit||data.toString('base64')!==table.dataBase64)throw new Error('Invalid bounded reftable original');
      const parsed=decodeReftable(data,format,budget);if(parsed.min<=prior)throw new Error('Overlapping reftable update ranges');prior=parsed.max;
      for(const ref of parsed.refs)refs.set(ref.name,ref);for(const log of parsed.logs)logs.set(log.key,log);
    }
    for(const [name,ref] of refs)if(ref.deleted)refs.delete(name);for(const [key,log] of logs)if(log.deleted)logs.delete(key);
    return {refs,logs};
  };
  let {refs,logs}=stack(value);
  if(value.selectedWorktree!==undefined){
    fields(value.selectedWorktree,['tablesListBase64','tables']);
    const selected=stack(value.selectedWorktree),shared=(name:string)=>name.startsWith('refs/')&&!privateRef(name);
    // Native Git selects the common backend for shared refs and the selected
    // worktree backend for pseudorefs/private namespaces. Never inherit main HEAD.
    refs=new Map([...refs].filter(([name])=>shared(name)));
    logs=new Map([...logs].filter(([,log])=>shared(log.name)));
    for(const [name,ref] of selected.refs){if(shared(name))throw new Error('Selected reftable stack contains a foreign shared ref');refs.set(name,ref);}
    for(const [key,log] of selected.logs){if(shared(log.name))throw new Error('Selected reftable log contains a foreign shared ref');logs.set(key,log);}
  }
  const resolve=(name:string)=>{let current=refs.get(name);const seen=new Set<string>();while(current?.symbolic){if(seen.has(current.name))throw new Error('Cyclic reftable symbolic ref');seen.add(current.name);current=refs.get(current.symbolic);}return current?.oid;};
  const logical:ReviewedGitUserData['refs']=[];
  for(const ref of refs.values())if(ref.name.startsWith('refs/')){const oid=resolve(ref.name);if(!oid)throw new Error('Unresolved reftable symbolic ref');logical.push({name:ref.name,oid,...(ref.symbolic?{symbolic:ref.symbolic}:{})});}
  logical.sort((a,b)=>Buffer.compare(Buffer.from(a.name),Buffer.from(b.name)));
  if([...refs.keys()].some(name=>['REBASE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','BISECT_EXPECTED_REV','NOTES_MERGE_PARTIAL','NOTES_MERGE_REF','MERGE_AUTOSTASH'].includes(name)))throw new Error('Selected reftable has operation-in-progress refs requiring a continuation contract');
  for(const ref of refs.values())if(ref.name!=='HEAD'&&!ref.name.startsWith('refs/')&&ref.symbolic&&!resolve(ref.name))throw new Error('Unresolved reftable root reference');
  const selectedHead=refs.get('HEAD');if(!selectedHead)throw new Error('Missing selected reftable HEAD');
  const head:ReviewedGitUserData['head']=selectedHead.symbolic?{symbolic:selectedHead.symbolic}:{oid:selectedHead.oid!};
  return {refs:logical,head,peeledBindings:[...refs.values()].filter(ref=>ref.peeled),rootRefs:[...refs.values()].filter(ref=>!ref.name.startsWith('refs/')).map(ref=>({...ref,oid:resolve(ref.name)})),logs:[...logs.values()]};
}

export function validateReviewedGit(value:ReviewedGitUserData,depth=0):void {
  if(depth>16)throw new Error('Native Git module nesting exceeds the capture bound');
  fields(value,['version','format','objects','refs','head','index','resolveUndo','reflogs','reflogMissingObjects','indexOptionalReview','configurationReview','configurationOriginalReview','sparseReview','infoReview','shallowReview','packRetentionReview','origHeadReview','fetchHeadReview','exclusions','reftableReview'],['modules','configurationSourceDirectories']);
  if(value.configurationSourceDirectories!==undefined){fields(value.configurationSourceDirectories,['common','private'],['home']);for(const directory of Object.values(value.configurationSourceDirectories))if(typeof directory!=='string'||!path.posix.isAbsolute(directory)||path.posix.normalize(directory)!==directory||Buffer.byteLength(directory)>4096||/[\\\x00-\x1f\x7f]/.test(directory))throw new Error('Invalid historical Git configuration directory provenance');}
  if(value.version!==1||!['sha1','sha256'].includes(value.format)||!Array.isArray(value.objects)||value.objects.length>10000||!Array.isArray(value.refs)||value.refs.length>10000||!Array.isArray(value.index)||value.index.length>10000||!Array.isArray(value.configurationReview)||value.configurationReview.length>10000||!Array.isArray(value.exclusions)||value.exclusions.some(item=>typeof item!=='string'))throw new Error('Invalid bounded Git user-data manifest');
  const reftable=value.reftableReview===null?undefined:decodeReftableReview(value.reftableReview,value.format);
  if(reftable&&(JSON.stringify(reftable.refs)!==JSON.stringify(value.refs)||JSON.stringify(reftable.head)!==JSON.stringify(value.head)))throw new Error('Logical refs/HEAD differ from authoritative reftable stack');
  const ids=new Map<string,GitObject>();let bytes=0;
  const oidPattern=value.format==='sha1'?/^[a-f0-9]{40}$/:/^[a-f0-9]{64}$/;
  for(const object of value.objects){
    fields(object,['oid','type','dataBase64']);
    if(!['blob','tree','commit','tag'].includes(object.type)||!oidPattern.test(object.oid)||typeof object.dataBase64!=='string'||object.dataBase64.length>Math.ceil(limit/3)*4)throw new Error('Invalid Git object');
    const data=Buffer.from(object.dataBase64,'base64');bytes+=data.length;
    if(bytes>limit||data.toString('base64')!==object.dataBase64||objectId(value.format,object.type,data)!==object.oid||ids.has(object.oid))throw new Error('Git object identity or bound mismatch');
    // Inspect ASCII credential syntax in binary objects too; never decode/re-encode original object bytes.
    safeText(data.toString('latin1'),'Git object');
    ids.set(object.oid,object);
  }
  validatePackRetention(value.packRetentionReview,value.format,ids,limit-bytes);
  const shallow=validateGitShallowReview(value.shallowReview,value.format);
  for(const oid of shallow)if(ids.get(oid)?.type!=='commit')throw new Error('Git shallow boundary must name a captured verified commit');
  if(!Array.isArray(value.reflogs)||value.reflogs.length>10000)throw new Error('Invalid bounded Git reflogs');
  const logPaths=new Set<string>(),logDirectories=new Set(['']),logBudget={bytes:0,entries:0,missing:new Set<string>()};
  for(const log of value.reflogs){
    fields(log,['path','dataBase64']);reflogPath(log.path);
    if(logPaths.has(log.path)||typeof log.dataBase64!=='string'||log.dataBase64.length>Math.ceil(1024*1024/3)*4)throw new Error('Invalid or duplicate Git reflog');
    logPaths.add(log.path);
    const parts=log.path.split('/');
    for(let i=1;i<parts.length;i++)logDirectories.add(parts.slice(0,i).join('/'));
    if(logPaths.size+logDirectories.size>10000)throw new Error('Git reflog inventory exceeds its bound');
    validateGitReflogData(log.dataBase64,value.format,ids,logBudget);
  }
  for(const name of logPaths)if(logDirectories.has(name))throw new Error('Git reflog file/directory paths conflict');
  const requireObject=(oid:string,type?:string)=>{const object=ids.get(oid);if(!object||type&&object.type!==type)throw new Error('Git graph is incomplete or has a mismatched object type');};
  for(const object of value.objects){
    const data=Buffer.from(object.dataBase64,'base64');
    if(object.type==='tree'){
      let offset=0;const width=value.format==='sha1'?20:32;
      while(offset<data.length){const space=data.indexOf(32,offset),nul=data.indexOf(0,space+1);if(space<offset||nul<space||nul+1+width>data.length)throw new Error('Malformed Git tree');
        const mode=text(data.subarray(offset,space)),name=text(data.subarray(space+1,nul));
        if(!name||name.includes('/')||name==='.'||name==='..'||name.toLowerCase()==='.git'||credentialPath(name))throw new Error('Invalid Git tree name');
        const oid=data.subarray(nul+1,nul+1+width).toString('hex');
        if(mode==='40000')requireObject(oid,'tree');else if(['100644','100755','120000'].includes(mode))requireObject(oid,'blob');else if(mode!=='160000')throw new Error('Unsupported Git tree mode');
        offset=nul+1+width;
      }
    }else if(object.type==='commit'||object.type==='tag'){
      const header=text(data).split('\n\n',1)[0]!;
      const links=header.split('\n').filter(line=>/^(?:tree|parent|object)(?:[ \t]|$)/.test(line));
      if(object.type==='commit'&&!links.some(line=>line.startsWith('tree '))||object.type==='tag'&&!links.some(line=>line.startsWith('object ')))throw new Error('Git graph header lacks original');
      for(const line of links){
        const [kind,oid,...extra]=line.split(' ');
        if(!oid||!oidPattern.test(oid)||/^0+$/.test(oid)||extra.length)throw new Error('Malformed Git graph object ID');
        // Only declared commit roots may omit parents; present parents still require the right type.
        if(object.type==='commit'&&kind==='parent'&&shallow.has(object.oid)&&!ids.has(oid))continue;
        requireObject(oid,kind==='tree'?'tree':kind==='parent'?'commit':undefined);
      }
    }
  }
  const refs=new Set<string>(),refDirectories=new Set<string>();
  for(const ref of value.refs){
    fields(ref,['name','oid'],['symbolic']);refName(ref.name);if(refs.has(ref.name)||!ids.has(ref.oid))throw new Error('Missing or duplicate Git ref original');refs.add(ref.name);if(Object.hasOwn(ref,'symbolic'))refName(ref.symbolic!);
    const parts=ref.name.split('/');for(let i=1;i<parts.length;i++)refDirectories.add(parts.slice(0,i).join('/'));
    if(refs.size+refDirectories.size>20000)throw new Error('Git ref inventory exceeds its bound');
  }
  for(const name of refs)if(!reftable&&refDirectories.has(name))throw new Error('Git ref file/directory paths conflict');
  for(const ref of value.refs){
    let target=ref;const seen=new Set<string>();
    while(target.symbolic){if(seen.has(target.name))throw new Error('Cyclic Git symbolic ref');seen.add(target.name);const next=value.refs.find(candidate=>candidate.name===target.symbolic);if(!next||next.oid!==ref.oid)throw new Error('Incomplete Git symbolic ref target');target=next;}
  }
  for(const entry of parseGitFetchHeadReview(value.fetchHeadReview,value.format)){
    let object=ids.get(entry.oid);
    if(!object)throw new Error('Missing FETCH_HEAD object; preserve source');
    if(entry.merge){
      const seen=new Set<string>();
      while(object.type==='tag'){
        if(seen.has(object.oid))throw new Error('Cyclic FETCH_HEAD tag binding; preserve source');
        seen.add(object.oid);
        const targets=text(Buffer.from(object.dataBase64,'base64')).split('\n\n',1)[0]!.split('\n').filter(line=>line.startsWith('object '));
        if(targets.length!==1)throw new Error('Ambiguous FETCH_HEAD tag binding; preserve source');
        object=ids.get(targets[0]!.slice(7));
        if(!object)throw new Error('Missing FETCH_HEAD tag target; preserve source');
      }
      if(object.type!=='commit')throw new Error('Mergeable FETCH_HEAD entry must resolve to a captured commit');
    }
  }
  const origHead=parseGitOrigHeadReview(value.origHeadReview,value.format);
  if(origHead){
    const oid='oid' in origHead?origHead.oid:value.refs.find(ref=>ref.name===origHead.symbolic)?.oid;
    if(!oid||!ids.has(oid))throw new Error('Missing ORIG_HEAD object or captured symbolic target; preserve source');
  }
  if(value.origHeadReview.reflogDataBase64!==null){
    if(logPaths.size+logDirectories.size>=10000)throw new Error('Git reflog inventory exceeds its bound');
    validateGitReflogData(value.origHeadReview.reflogDataBase64,value.format,ids,logBudget);
  }
  if(reftable){
    for(const ref of reftable.peeledBindings){
      let oid=ref.oid;const seen=new Set<string>();
      while(oid&&ids.get(oid)?.type==='tag'){
        if(seen.has(oid))throw new Error('Cyclic peeled reftable binding');seen.add(oid);
        const target=text(Buffer.from(ids.get(oid)!.dataBase64,'base64')).split('\n\n',1)[0]!.split('\n').filter(line=>line.startsWith('object '));
        if(target.length!==1)throw new Error('Ambiguous peeled reftable tag');oid=target[0]!.slice(7);
      }
      if(!oid||oid!==ref.peeled||!ids.has(oid))throw new Error('Reftable peeled target differs from object graph');
    }
    for(const ref of reftable.rootRefs)if(ref.oid&&!ids.has(ref.oid))throw new Error('Missing active reftable root-ref object');
    for(const log of reftable.logs)for(const oid of [log.old,log.next])if(oid&&!/^0+$/.test(oid)&&!ids.has(oid))logBudget.missing.add(oid);
  }
  if(!Array.isArray(value.reflogMissingObjects)||value.reflogMissingObjects.length>20000||JSON.stringify(value.reflogMissingObjects)!==JSON.stringify([...logBudget.missing].sort()))throw new Error('Reflog missing-object evidence differs from captured historical endpoints');
  if(!Array.isArray(value.indexOptionalReview)||value.indexOptionalReview.length>1000)throw new Error('Invalid optional index original inventory');
  const optionalNames=new Set<string>();let optionalBytes=0;
  for(const extension of value.indexOptionalReview){
    fields(extension,['source','signature','dataBase64']);
    if(!['index','sharedindex'].includes(extension.source)||typeof extension.signature!=='string'||!/^[A-Z][\x00-\xff]{3}$/.test(extension.signature)||['TREE','REUC','UNTR','FSMN','IEOT','EOIE'].includes(extension.signature)||typeof extension.dataBase64!=='string'||optionalNames.has(extension.source+':'+extension.signature))throw new Error('Invalid optional index extension original');
    optionalNames.add(extension.source+':'+extension.signature);
    const raw=Buffer.from(extension.dataBase64,'base64');optionalBytes+=raw.length;
    if(raw.length>1024*1024||optionalBytes>limit||raw.toString('base64')!==extension.dataBase64)throw new Error('Optional index original exceeds its bound');
    safeText(raw.toString('latin1'),'Optional index original');
  }
  fields(value.head,'symbolic' in value.head?['symbolic']:['oid']);
  if('symbolic' in value.head)refName(value.head.symbolic);else if(!ids.has(value.head.oid))throw new Error('Missing detached HEAD object');
  const entries=new Set<string>();
  for(const entry of value.index){
    fields(entry,['mode','oid','stage','path','intentToAdd','assumeUnchanged','skipWorktree']);
    if(typeof entry.intentToAdd!=='boolean'||typeof entry.assumeUnchanged!=='boolean'||typeof entry.skipWorktree!=='boolean')throw new Error('Explicit Git index flags are required');
    if(entry.intentToAdd&&(entry.stage!==0||!['100644','100755','120000'].includes(entry.mode)||entry.oid!==objectId(value.format,'blob',Buffer.alloc(0))))throw new Error('Unsupported Git intent-to-add original');
    indexPath(entry.path);
    if(credentialPath(entry.path))throw new Error('Known credential path in selected Git index; preserve source');
    const key=`${entry.path}\0${entry.stage}`;
    if(entries.has(key)||!Number.isInteger(entry.stage)||entry.stage<0||entry.stage>3||!['100644','100755','120000','160000'].includes(entry.mode)||!oidPattern.test(entry.oid)||entry.mode!=='160000'&&ids.get(entry.oid)?.type!=='blob')throw new Error('Invalid staged Git original');
    entries.add(key);
  }
  encodeResolveUndo(value.resolveUndo,value.format,ids);
  for(const item of value.configurationReview){fields(item,['key','value'],['implicitBoolean','source']);if(item.source!==undefined&&item.source!=='config.worktree')throw new Error('Invalid reviewed Git configuration source');if(typeof item.key!=='string'||typeof item.value!=='string'||item.implicitBoolean!==undefined&&(item.implicitBoolean!==true||item.value!=='')||excludedGitKey(item.key)||/:\/\/[^/]*@/.test(item.value))throw new Error('Invalid reviewed Git configuration');safeText(`${item.key}=${item.value}`,'Git configuration');}
  if(!Array.isArray(value.configurationOriginalReview)||value.configurationOriginalReview.length!==2)throw new Error('Both Git configuration original slots are required');
  for(const [index,record] of value.configurationOriginalReview.entries()){
    fields(record,['path','source','dataBase64','removedFields']);
    const expected=index===0?'config':'config.worktree';
    if(record.path!==expected||record.source!==(index===0?'common_repository':'selected_worktree')||typeof record.removedFields!=='boolean')throw new Error('Git configuration original provenance differs');
    const expectedItems=value.configurationReview.filter(item=>index===0?!item.source:item.source==='config.worktree');
    if(record.dataBase64===null){if(record.removedFields||expectedItems.length)throw new Error('Absent Git configuration has retained declarations');continue;}
    if(typeof record.dataBase64!=='string'||record.dataBase64.length>Math.ceil(1024*1024/3)*4)throw new Error('Git configuration original exceeds its bound');
    const raw=Buffer.from(record.dataBase64,'base64');
    if(raw.length>1024*1024||raw.toString('base64')!==record.dataBase64)throw new Error('Invalid Git configuration original bytes');
    const parsed=configSource(raw,index===0?undefined:'config.worktree');
    if(parsed.removedFields||!parsed.safe.equals(raw)||JSON.stringify(parsed.items)!==JSON.stringify(expectedItems))throw new Error('Git configuration original and logical declarations differ');
  }
  const declaredStorage=value.configurationReview.filter(item=>!item.source&&item.key.toLowerCase()==='extensions.refstorage');
  if(declaredStorage.length>1||declaredStorage.some(item=>!['files','reftable'].includes(item.value))||(declaredStorage[0]?.value==='reftable')!==!!reftable)throw new Error('Git ref-storage provenance differs from configuration');
  validateRelativeWorktrees(value.configurationReview);
  validateGitInfoReview(value.infoReview);
  validateSparseReview(value,ids);
  if(value.modules!==undefined){
    if(!Array.isArray(value.modules)||value.modules.length>1000||Buffer.byteLength(JSON.stringify(value.modules))>limit)throw new Error('Invalid bounded native module inventory');
    const names=new Set<string>();
    for(const module of value.modules){
      fields(module,['name','source','worktreeRelativePath','git','originals']);storageRelativePath(module.name);
      fields(module.source,['storagePath','worktreePath','coreWorktree','configurationSha256','initialized'],['embedded']);
      const source=module.source;
      if(module.name==='.'||[...names].some(name=>name===module.name||name.startsWith(module.name+'/')||module.name.startsWith(name+'/'))||typeof source.initialized!=='boolean'||typeof source.coreWorktree!=='string'||!source.coreWorktree||/[\\\0\r\n]/.test(source.coreWorktree)||!/^[a-f0-9]{64}$/.test(source.configurationSha256)||typeof source.storagePath!=='string'||typeof source.worktreePath!=='string'||![source.storagePath,source.worktreePath].every(target=>target.startsWith('/')&&path.posix.normalize(target)===target&&Buffer.byteLength(target)<=4096)||path.posix.resolve(source.storagePath,source.coreWorktree)!==source.worktreePath)throw new Error('Native module association provenance differs');
      if(source.embedded!==undefined&&(source.embedded!==true||source.storagePath!==path.posix.join(source.worktreePath,'.git')||!source.initialized))throw new Error('Embedded module association differs');
      safeText(source.coreWorktree,'Module core.worktree');names.add(module.name);
      if(module.worktreeRelativePath!==null){storageRelativePath(module.worktreeRelativePath);if(module.worktreeRelativePath==='.')throw new Error('Native module cannot replace its parent root');}
      if(!Array.isArray(module.originals)||module.originals.length>1000)throw new Error('Invalid native module originals');
      const originals=new Set<string>();for(const original of module.originals){
        fields(original,['path','dataBase64','removedSecretFields'],['metadata']);
        if(!gitReviewOriginal(original.path)||originals.has(original.path)||original.removedSecretFields!==false||typeof original.dataBase64!=='string')throw new Error('Invalid selected module Git original');
        const data=Buffer.from(original.dataBase64,'base64');if(data.toString('base64')!==original.dataBase64)throw new Error('Invalid module original encoding');inspectGitReviewOriginal(data,original.path);originals.add(original.path);
        if(original.metadata){fields(original.metadata,['mode','mtimeNs']);if(!Number.isInteger(original.metadata.mode)||original.metadata.mode<0||original.metadata.mode>0o7777||typeof original.metadata.mtimeNs!=='string'||!/^-?\d+$/.test(original.metadata.mtimeNs))throw new Error('Invalid module original metadata');}
      }
      validateReviewedGit(module.git,depth+1);
    }
  }

}

/** Validate boundary syntax before native reads, then require captured commit identities in graph validation. */
function validateGitShallowReview(value:ReviewedGitUserData['shallowReview'],format:'sha1'|'sha256'):Set<string> {
  fields(value,['path','source','dataBase64']);
  if(value.path!=='shallow'||value.source!=='common_repository')throw new Error('Invalid Git shallow path/provenance');
  const ids=new Set<string>();if(value.dataBase64===null)return ids;
  if(typeof value.dataBase64!=='string'||value.dataBase64.length>Math.ceil(1024*1024/3)*4)throw new Error('Git shallow original exceeds its bound');
  const raw=Buffer.from(value.dataBase64,'base64');
  if(raw.length>1024*1024||raw.toString('base64')!==value.dataBase64||raw.some(byte=>byte>127))throw new Error('Invalid Git shallow original bytes; preserve source');
  const original=raw.toString('ascii');safeText(original,'Git shallow original');
  if(original&&!original.endsWith('\n'))throw new Error('Incomplete Git shallow boundary; preserve source');
  const pattern=format==='sha1'?/^[a-f0-9]{40}$/:/^[a-f0-9]{64}$/;
  for(const oid of original?original.slice(0,-1).split('\n'):[]){
    if(!pattern.test(oid)||/^0+$/.test(oid)||ids.has(oid)||ids.size>=10000)throw new Error('Invalid or duplicate Git shallow boundary; preserve source');
    ids.add(oid);
  }
  return ids;
}

const gitInfoPaths=['info/attributes','info/exclude'] as const;
function validateGitInfoReview(value:ReviewedGitUserData['infoReview']):void {
  if(!Array.isArray(value)||value.length!==gitInfoPaths.length)throw new Error('Both Git info originals or explicit absences are required');
  for(const [i,file] of value.entries()){
    fields(file,['path','source','dataBase64']);
    if(file.path!==gitInfoPaths[i]||file.source!=='common_repository')throw new Error('Invalid Git info path/order/provenance');
    if(file.dataBase64===null)continue;
    if(typeof file.dataBase64!=='string'||file.dataBase64.length>Math.ceil(1024*1024/3)*4)throw new Error('Git info original exceeds its bound');
    const raw=Buffer.from(file.dataBase64,'base64');
    if(raw.length>1024*1024||raw.toString('base64')!==file.dataBase64||raw.includes(0))throw new Error('Invalid Git info original bytes; preserve source');
    let original:string;
    try{original=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);}catch{throw new Error(`Unsupported UTF-8 Git ${file.path} original; preserve source`);}
    if(!Buffer.from(original).equals(raw))throw new Error('Unsupported Git info encoding; preserve source');
    safeText(original.replace(/^\uFEFF/,''),`Git ${file.path} original`);
  }
}

type IndexEntry=ReviewedGitUserData['index'][number];
function indexOrder(a:IndexEntry,b:IndexEntry):number{return Buffer.compare(Buffer.from(a.path),Buffer.from(b.path))||a.stage-b.stage;}

/** One canonical semantic validator/encoder for captured, imported and recreated resolve-undo data. */
function encodeResolveUndo(value:ReviewedGitUserData['resolveUndo'],format:'sha1'|'sha256',objects?:Map<string,GitObject>):Buffer {
  if(!Array.isArray(value)||value.length>10000)throw new Error('Invalid bounded Git resolve-undo inventory');
  const oidPattern=format==='sha1'?/^[a-f0-9]{40}$/:/^[a-f0-9]{64}$/;
  const parts:Buffer[]=[];let bytes=0,previous:Buffer|undefined;
  for(const entry of value){
    fields(entry,['path','stages']);
    if(typeof entry.path!=='string'||Buffer.byteLength(entry.path)>1024*1024)throw new Error('Invalid Git resolve-undo path bound');
    indexPath(entry.path);safeText(entry.path,'Git resolve-undo path');
    if(credentialPath(entry.path))throw new Error('Known credential path in Git resolve-undo; preserve source');
    const name=Buffer.from(entry.path);
    if(text(name)!==entry.path||previous&&Buffer.compare(previous,name)>=0)throw new Error('Invalid UTF-8, duplicate or unordered Git resolve-undo path');
    previous=name;
    if(!Array.isArray(entry.stages)||!entry.stages.length||entry.stages.length>3)throw new Error('Git resolve-undo requires original present stages');
    let last=0;
    for(const stage of entry.stages){
      fields(stage,['stage','mode','oid']);
      if(!Number.isInteger(stage.stage)||stage.stage<=last||stage.stage>3||!['100644','100755','120000','160000'].includes(stage.mode)||typeof stage.oid!=='string'||!oidPattern.test(stage.oid)||/^0+$/.test(stage.oid))throw new Error('Invalid Git resolve-undo stage, mode or OID');
      if(objects&&stage.mode!=='160000'&&objects.get(stage.oid)?.type!=='blob')throw new Error('Missing or mismatched Git resolve-undo blob original');
      last=stage.stage;
    }
    const modes=[1,2,3].map(stage=>entry.stages.find(item=>item.stage===stage)?.mode??'0');
    const header=Buffer.from(entry.path+'\0'+modes.join('\0')+'\0'),oids=entry.stages.map(stage=>Buffer.from(stage.oid,'hex'));
    if((bytes+=header.length+oids.reduce((sum,oid)=>sum+oid.length,0))>1024*1024)throw new Error('Git resolve-undo bytes exceed their bound');
    parts.push(header,...oids);
  }
  return Buffer.concat(parts,bytes);
}

function decodeResolveUndo(data:Buffer,format:'sha1'|'sha256'):ReviewedGitUserData['resolveUndo'] {
  if(data.length>1024*1024)throw new Error('Git resolve-undo extension exceeds its bound');
  const result:ReviewedGitUserData['resolveUndo']=[],width=format==='sha1'?20:32;let offset=0;
  const field=()=>{const nul=data.indexOf(0,offset);if(nul<offset)throw new Error('Unterminated Git resolve-undo field');const value=text(data.subarray(offset,nul));offset=nul+1;return value;};
  while(offset<data.length){
    if(result.length>=10000)throw new Error('Git resolve-undo entry count exceeds its bound');
    const name=field(),modes=[field(),field(),field()],stages:ReviewedGitUserData['resolveUndo'][number]['stages']=[];
    for(const [i,mode] of modes.entries()){
      if(mode==='0')continue;
      if(!['100644','100755','120000','160000'].includes(mode)||offset+width>data.length)throw new Error('Invalid Git resolve-undo mode or truncated object name');
      stages.push({stage:i+1,mode,oid:data.subarray(offset,offset+width).toString('hex')});offset+=width;
    }
    result.push({path:name,stages});
  }
  if(!encodeResolveUndo(result,format).equals(data))throw new Error('Noncanonical Git resolve-undo extension');
  return result;
}

function sparseKey(key:string):boolean {return /^(?:core\.sparsecheckout(?:cone)?|index\.sparse|extensions\.(?:sparseindex|worktreeconfig))$/i.test(key);}

/** Git startup must see only an empty private cwd, never the selected or an ancestor repository. */
async function parseCapturedGitConfiguration(data:Buffer):Promise<string> {
  const parent=await fs.realpath(tmpdir()),directory=await fs.mkdtemp(path.join(parent,'ponderosa-config-'));
  try{
    const stat=await fs.lstat(directory);
    if(!stat.isDirectory()||(stat.mode&0o077)!==0||await fs.realpath(directory)!==directory||(await fs.readdir(directory)).length)throw new Error('Git config parser directory is not private and empty');
    return text(await git(directory,['config','--file','-','--null','--list','--no-includes'],data));
  }finally{
    // Only remove an empty parser directory; preserve any unexpected bytes instead of recursive cleanup.
    await fs.rmdir(directory);
  }
}

/** Raw snapshots are private comparison evidence; only nonsecret parsed settings enter the package. */
async function captureSparseConfiguration(gitDir:string,commonDir=gitDir,fsSource?:GitSourceFs) {
  const fs=fsSource??sourceFs;
  const originals:Array<{name:string;identity:string;data:string}>=[];
  const configuration:ReviewedGitUserData['configurationReview']=[];
  let patternsBase64:string|null=null;
  const info=path.join(gitDir,'info');let infoIdentity:string|null=null;
  try{const stat=await fs.lstat(info,{bigint:true});if(!stat.isDirectory()||await fs.realpath(info)!==info)throw new Error('Sparse pattern parent is not a canonical local directory');infoIdentity=originalIdentity(stat);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  for(const name of ['config','config.worktree','info/sparse-checkout']){
    const target=path.join(name==='config'?commonDir:gitDir,name);
    let before;try{before=await fs.lstat(target,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    const {data}=await regularOriginal(target,1024*1024,undefined,fs),after=await fs.lstat(target,{bigint:true});
    const identity=(stat:typeof before)=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
    if(identity(before)!==identity(after))throw new Error('Local Git sparse/config original changed');
    originals.push({name,identity:identity(after),data:data.toString('base64')});
    if(name==='info/sparse-checkout'){patternsBase64=data.toString('base64');continue;}
    const parsed=await parseCapturedGitConfiguration(data);
    if(parsed&&!parsed.endsWith('\0'))throw new Error('Incomplete local Git configuration inventory');
    for(const row of parsed?parsed.slice(0,-1).split('\0'):[]){
      if(configuration.length>=10000)throw new Error('Local Git configuration exceeds its bound');
      const split=row.indexOf('\n'),key=split<0?row:row.slice(0,split),value=split<0?'':row.slice(split+1);
      // Includes stay literal review records: the isolated stdin parser disables target resolution.
      configuration.push({key,value,...(split<0?{implicitBoolean:true as const}:{}),...(name==='config.worktree'?{source:'config.worktree' as const}:{})});
    }
  }
  return {originals,configuration,patternsBase64,infoIdentity};
}

/** Expand only already hash/graph-verified objects; no filesystem, Git command or pattern interpretation. */
function expandSparseDirectories(directories:IndexEntry[],objects:Map<string,GitObject>,format:'sha1'|'sha256'):IndexEntry[] {
  const result:IndexEntry[]=[];let nodes=0,pathBytes=0;
  const active=new Set<string>(),width=format==='sha1'?20:32;
  const walk=(oid:string,prefix:string,depth:number):void=>{
    if(depth>128||++nodes>10000||active.has(oid))throw new Error('Sparse Git tree expansion exceeds its bound or cycles');
    const object=objects.get(oid);if(object?.type!=='tree')throw new Error('Sparse Git tree original is missing');
    active.add(oid);const data=Buffer.from(object.dataBase64,'base64');let offset=0,previous:Buffer|undefined;
    const names=new Set<string>();
    while(offset<data.length){
      const space=data.indexOf(32,offset),nul=data.indexOf(0,space+1);
      if(space<offset||nul<space||nul+1+width>data.length)throw new Error('Malformed sparse Git tree');
      const mode=text(data.subarray(offset,space)),name=text(data.subarray(space+1,nul)),child=data.subarray(nul+1,nul+1+width).toString('hex');
      if(!name||!Buffer.from(name).equals(data.subarray(space+1,nul))||name.includes('/')||names.has(name)||!['40000','100644','100755','120000','160000'].includes(mode))throw new Error('Unsupported or duplicate sparse Git tree entry');
      const order=Buffer.concat([data.subarray(space+1,nul),Buffer.from([mode==='40000'?47:0])]);
      if(previous&&Buffer.compare(previous,order)>=0)throw new Error('Sparse Git tree is not canonically ordered');previous=order;names.add(name);
      const path=indexPath(prefix+name);if(credentialPath(path))throw new Error('Sparse Git original contains a known credential path');
      if((pathBytes+=Buffer.byteLength(path))>limit||result.length>=10000)throw new Error('Expanded sparse Git index exceeds its bound');
      if(mode==='40000')walk(child,path+'/',depth+1);
      else {
        if(mode!=='160000'&&objects.get(child)?.type!=='blob')throw new Error('Sparse Git blob original is missing');
        result.push({path,mode,oid:child,stage:0,intentToAdd:false,assumeUnchanged:false,skipWorktree:true});
      }
      offset=nul+1+width;
    }
    active.delete(oid);
  };
  for(const entry of directories){
    fields(entry,['mode','oid','stage','path','intentToAdd','assumeUnchanged','skipWorktree']);
    if(entry.mode!=='40000'||typeof entry.path!=='string'||!entry.path.endsWith('/')||entry.stage!==0||entry.intentToAdd!==false||entry.assumeUnchanged!==false||entry.skipWorktree!==true)throw new Error('Unsupported sparse directory original flags');
    indexPath(entry.path.slice(0,-1));walk(entry.oid,entry.path,0);
  }
  return result.sort(indexOrder);
}

function gitConfigurationBoolean(items:ReviewedGitUserData['configurationReview'],key:string):boolean|undefined {
  let result:boolean|undefined;
  for(const item of items.filter(item=>item.key.toLowerCase()===key)){
    if(item.implicitBoolean)result=true;
    else if(/^(?:true|yes|on|1)$/i.test(item.value))result=true;
    else if(/^(?:false|no|off|0|)$/i.test(item.value))result=false;
    else throw new Error('Unsupported Git configuration boolean');
  }
  return result;
}

/** Relative linking is association evidence, not a setting to activate on recreation. */
function validateRelativeWorktrees(configuration:ReviewedGitUserData['configurationReview']):void {
  const declarations=configuration.filter(item=>item.key.toLowerCase()==='extensions.relativeworktrees');
  if(!declarations.length)return;
  const versions=configuration.filter(item=>!item.source&&item.key.toLowerCase()==='core.repositoryformatversion');
  if(declarations.some(item=>!item.source)&&(versions.length!==1||versions[0]!.implicitBoolean||versions[0]!.value!=='1'))throw new Error('Relative worktree extension requires explicit Git repository format 1');
  for(const source of [undefined,'config.worktree']){
    const items=declarations.filter(item=>item.source===source);
    if(items.length>1)throw new Error('Ambiguous relative worktree extension declarations');
    gitConfigurationBoolean(items,'extensions.relativeworktrees');
  }
}

function validateSparseReview(value:ReviewedGitUserData,objects:Map<string,GitObject>):void {
  fields(value.sparseReview,['patternsBase64','directories']);
  const {patternsBase64,directories}=value.sparseReview;
  if(!Array.isArray(directories)||directories.length>10000||patternsBase64!==null&&typeof patternsBase64!=='string')throw new Error('Invalid sparse Git review data');
  if(patternsBase64!==null){
    if(patternsBase64.length>Math.ceil(1024*1024/3)*4)throw new Error('Sparse patterns exceed their bound');
    const raw=Buffer.from(patternsBase64,'base64');if(raw.length>1024*1024||raw.toString('base64')!==patternsBase64||raw.includes(0))throw new Error('Invalid sparse pattern bytes');
    safeText(text(raw),'Git sparse patterns');
  }
  const local=value.configurationReview.filter(item=>!item.source),worktree=value.configurationReview.filter(item=>item.source==='config.worktree');
  const boolean=gitConfigurationBoolean;
  // Validate every declared sparse boolean, including dormant worktree settings, without inventing defaults.
  for(const items of [local,worktree])for(const key of ['core.sparsecheckout','core.sparsecheckoutcone','index.sparse','extensions.sparseindex','extensions.worktreeconfig'])boolean(items,key);
  const enabled=boolean(local,'extensions.worktreeconfig'),effective=enabled?[...local,...worktree]:local;
  if(enabled===undefined&&worktree.some(item=>sparseKey(item.key)))throw new Error('Ambiguous worktree sparse configuration without an explicit extension setting');
  if(boolean(effective,'core.sparsecheckout')===true&&patternsBase64===null)throw new Error('Enabled sparse checkout has no captured pattern original');
  if(directories.length&&(boolean(effective,'core.sparsecheckout')!==true||boolean(effective,'core.sparsecheckoutcone')!==true))throw new Error('Sparse directory originals require explicit cone checkout settings');
  const prefixes:string[]=[];
  for(const entry of directories){
    if(typeof entry.path!=='string'||prefixes.some(prefix=>entry.path.startsWith(prefix)||prefix.startsWith(entry.path)))throw new Error('Overlapping sparse directory originals');
    prefixes.push(entry.path);
  }
  const expected=expandSparseDirectories(directories,objects,value.format),actual=value.index.filter(entry=>prefixes.some(prefix=>entry.path.startsWith(prefix))).sort(indexOrder);
  const same=(a:IndexEntry,b:IndexEntry)=>a.path===b.path&&a.mode===b.mode&&a.oid===b.oid&&a.stage===b.stage&&a.intentToAdd===b.intentToAdd&&a.assumeUnchanged===b.assumeUnchanged&&a.skipWorktree===b.skipWorktree;
  if(expected.length!==actual.length||expected.some((entry,i)=>!same(entry,actual[i]!)))throw new Error('Full index differs from captured sparse directory originals');
  const leaves=new Set(value.index.map(entry=>entry.path)),merged=new Set(value.index.filter(entry=>entry.stage===0).map(entry=>entry.path));let bytes=0;
  for(const entry of value.index){
    if((bytes+=Buffer.byteLength(entry.path))>limit)throw new Error('Logical index paths exceed their bound');
    const parts=entry.path.split('/');for(let i=1;i<parts.length;i++)if(leaves.has(parts.slice(0,i).join('/')))throw new Error('Git index file/directory paths conflict');
    if(entry.stage!==0&&merged.has(entry.path))throw new Error('Merged/unmerged Git index stages conflict');
  }
  for(const prefix of prefixes){const parts=prefix.slice(0,-1).split('/');for(let i=1;i<=parts.length;i++)if(leaves.has(parts.slice(0,i).join('/')))throw new Error('Sparse directory conflicts with an index file');}
}

/** Decode bounded v2/v3/v4 originals; never ask Git to read a split index (it freshens shared-file mtime). */
function decodeIndex(data:Buffer,format:'sha1'|'sha256'):{entries:IndexEntry[];resolveUndo?:ReviewedGitUserData['resolveUndo'];link?:Buffer;sparse?:true;optional: Array<{signature:string;dataBase64:string}>} {
  const width=format==='sha1'?20:32,end=data.length-width;
  if(end<12||data.toString('latin1',0,4)!=='DIRC'||!createHash(format).update(data.subarray(0,end)).digest().equals(data.subarray(end)))throw new Error('Invalid Git index header/checksum');
  const version=data.readUInt32BE(4),count=data.readUInt32BE(8);
  if(![2,3,4].includes(version)||count>10000)throw new Error('Only bounded v2/v3/v4 Git index storage is supported');
  const entries:IndexEntry[]=[],entryStarts:number[]=[],fullPaths:boolean[]=[];let offset=12,decodedBytes=0;let previous:Buffer=Buffer.alloc(0);
  for(let i=0;i<count;i++){
    const start=offset;entryStarts.push(start);
    if(offset+42+width>end)throw new Error('Truncated Git index entry');
    const mode=data.readUInt32BE(offset+24).toString(8),oid=data.subarray(offset+40,offset+40+width).toString('hex'),flags=data.readUInt16BE(offset+40+width);
    offset+=42+width;let extended=0;
    if(flags&0x4000){if(version===2||offset+2>end)throw new Error('Unsupported Git extended flags');extended=data.readUInt16BE(offset);offset+=2;if(extended&~0x6000)throw new Error('Unknown Git extended flags');}
    let remove=0;
    if(version===4){
      if(offset>=end)throw new Error('Missing v4 Git path prefix');
      let byte=data[offset++]!,bytes=1;remove=byte&0x7f;
      while(byte&0x80){
        if(bytes++>=5||offset>=end)throw new Error('Truncated or oversized v4 Git path prefix');
        byte=data[offset++]!;remove=(remove+1)*128+(byte&0x7f);
        if(remove>previous.length)throw new Error('V4 Git path prefix exceeds previous original');
      }
      if(remove>previous.length)throw new Error('V4 Git path prefix exceeds previous original');
    }
    fullPaths.push(version!==4||remove===previous.length);
    const nul=data.indexOf(0,offset);
    if(nul<offset||nul>=end)throw new Error('Unterminated Git index path');
    const length=(version===4?previous.length-remove:0)+nul-offset;
    if(length>1024*1024||(decodedBytes+=length)>limit||(flags&0xfff)!==Math.min(length,0xfff))throw new Error('Invalid or oversized decoded Git index path');
    const raw=version===4?Buffer.concat([previous.subarray(0,previous.length-remove),data.subarray(offset,nul)],length):data.subarray(offset,nul);
    const name=text(raw);if(!Buffer.from(name).equals(raw))throw new Error('Noncanonical Git index path encoding');if(name)indexPath(mode==='40000'&&name.endsWith('/')?name.slice(0,-1):name);
    previous=raw;
    offset=version===4?nul+1:start+Math.ceil((nul+1-start)/8)*8;
    if(offset>end||version!==4&&data.subarray(nul,offset).some(byte=>byte!==0))throw new Error('Invalid Git index padding');
    if(!['40000','100644','100755','120000','160000'].includes(mode))throw new Error('Unsupported Git index mode');
    entries.push({path:name,mode,oid,stage:(flags>>>12)&3,assumeUnchanged:Boolean(flags&0x8000),intentToAdd:Boolean(extended&0x2000),skipWorktree:Boolean(extended&0x4000)});
  }
  const entriesEnd=offset,extensionHeaders=createHash(format);
  const optional:Array<{signature:string;dataBase64:string}>=[];
  let link:Buffer|undefined,resolveUndo:ReviewedGitUserData['resolveUndo']|undefined;const seen=new Set<string>();
  while(offset<end){
    if(offset+8>end)throw new Error('Truncated Git index extension');
    const header=data.subarray(offset,offset+8),signature=header.toString('latin1',0,4),size=header.readUInt32BE(4);offset+=8;
    if(size>end-offset||seen.has(signature))throw new Error('Invalid or duplicate Git index extension');seen.add(signature);
    const body=data.subarray(offset,offset+size);offset+=size;
    if(signature==='EOIE'){
      if(size!==4+width||offset!==end||body.readUInt32BE(0)!==entriesEnd||!body.subarray(4).equals(extensionHeaders.digest()))throw new Error('Invalid Git end-of-entry offset/hash/order');
      continue;
    }
    extensionHeaders.update(header);
    if(signature==='IEOT'){
      if(size<4||(size-4)%8||body.readUInt32BE(0)!==1)throw new Error('Invalid Git index offset-table version/grammar');
      const blocks=(size-4)/8;
      if(blocks>count+1||count===0&&blocks!==0||count>0&&blocks===0)throw new Error('Invalid Git index offset-table block count');
      let covered=0;
      for(let block=0;block<blocks;block++){
        const start=body.readUInt32BE(4+block*8),nr=body.readUInt32BE(8+block*8);
        // Git's writer can emit one leading empty block when earlier entries were removed.
        if(nr===0&&(block!==0||blocks<2)||nr>count-covered||start!==entryStarts[covered])throw new Error('Invalid Git index offset-table partition');
        // V4 block starts discard the whole preceding name; decode sequentially, never seek via IEOT.
        if(!fullPaths[covered])throw new Error('Git v4 offset-table block lacks a full restart path');
        covered+=nr;
      }
      if(covered!==count)throw new Error('Incomplete Git index offset-table coverage');
      continue;
    }
    if(signature==='link'){link=body;continue;}
    if(signature==='sdir'){if(body.length)throw new Error('Unsupported sparse-index extension payload');continue;}
    if(signature==='REUC'){resolveUndo=decodeResolveUndo(body,format);continue;}
    if(signature==='UNTR'||signature==='FSMN'){
      // Optional observation caches are opaque: inspect bytes for secrets, never trust their paths/tokens.
      safeText(body.toString('latin1'),'Git index derived cache');continue;
    }
    if(signature!=='TREE'){
      if(!/^[A-Z][\x00-\xff]{3}$/.test(signature))throw new Error('Unknown mandatory Git index extension; preserve source');
      if(optional.length>=1000)throw new Error('Optional index extension inventory exceeds its bound');
      safeText(body.toString('latin1'),'Optional index original');
      optional.push({signature,dataBase64:body.toString('base64')});continue;
    }
    // TREE is only a derived cache: validate its complete grammar, then recreate no cache.
    let cursor=0,pending=1,nodes=0;
    while(pending){
      if(++nodes>10000)throw new Error('Git cache-tree exceeds its bound');
      const nul=body.indexOf(0,cursor),newline=body.indexOf(10,nul+1);
      if(nul<cursor||newline<nul)throw new Error('Invalid Git cache-tree');
      const counts=/^(-1|[0-9]+) ([0-9]+)$/.exec(text(body.subarray(nul+1,newline)));
      if(!counts||Number(counts[1])>10000||Number(counts[2])>10000)throw new Error('Unsupported Git cache-tree counts');
      cursor=newline+1+(counts[1]==='-1'?0:width);pending+=Number(counts[2])-1;
      if(cursor>body.length||pending>10000)throw new Error('Truncated Git cache-tree');
    }
    if(cursor!==body.length)throw new Error('Unconsumed Git cache-tree bytes');
  }
  if(entries.some(entry=>entry.mode==='40000')&&!seen.has('sdir')||seen.has('sdir')&&link)throw new Error('Sparse directory extension missing or combined with split storage');
  return {entries,optional,...(resolveUndo!==undefined?{resolveUndo}:{}),...(link?{link}:{}),...(seen.has('sdir')?{sparse:true as const}:{})};
}

function splitBitmap(data:Buffer,start:number,bound:number):{bits:Set<number>;end:number} {
  if(start+12>data.length)throw new Error('Truncated split-index bitmap');
  const size=data.readUInt32BE(start),words=data.readUInt32BE(start+4),end=start+12+words*8;
  if(size>bound||words<1||words>10000||end>data.length)throw new Error('Invalid bounded split-index bitmap');
  const rlw=data.readUInt32BE(end-4),bits=new Set<number>();let word=0,position=0,lastRlw=-1;
  while(word<words){
    lastRlw=word;const control=data.readBigUInt64BE(start+8+8*word++),run=Number((control>>1n)&0xffffffffn),literals=Number(control>>33n);
    if(word+literals>words||position+64*(run+literals)>Math.ceil(size/64)*64)throw new Error('Invalid split-index bitmap run');
    if(control&1n)for(let bit=position;bit<position+run*64;bit++){if(bit>=size)throw new Error('Split-index bitmap has out-of-range bits');bits.add(bit);}
    position+=run*64;
    for(let i=0;i<literals;i++){
      const literal=data.readBigUInt64BE(start+8+8*word++);
      for(let bit=0;bit<64;bit++)if(literal&(1n<<BigInt(bit))){if(position+bit>=size)throw new Error('Split-index bitmap has out-of-range bits');bits.add(position+bit);}
      position+=64;
    }
  }
  if(rlw!==lastRlw||position!==Math.ceil(size/64)*64)throw new Error('Incomplete split-index bitmap');
  return {bits,end};
}

async function captureIndexStorage(gitDir:string,format:'sha1'|'sha256',fsSource?:GitSourceFs):Promise<{originals:Buffer;logical:IndexEntry[];resolveUndo:ReviewedGitUserData['resolveUndo'];indexOptionalReview:ReviewedGitUserData['indexOptionalReview']}> {
  const fs=fsSource??sourceFs;
  const originals:Array<{name:string;identity:string;data:string}>=[];
  const owner=(await fs.lstat(gitDir,{bigint:true})).uid;
  const read=async(name:string)=>{
    const target=path.join(gitDir,name),before=await fs.lstat(target,{bigint:true}),{data}=await regularOriginal(target,1024*1024,owner,fs),after=await fs.lstat(target,{bigint:true});
    if(originalIdentity(before)!==originalIdentity(after))throw new Error('Git index storage changed during capture');
    originals.push({name,identity:originalIdentity(after),data:data.toString('base64')});return data;
  };
  let data:Buffer;
  try{await fs.lstat(path.join(gitDir,'index'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {originals:Buffer.from('[]'),logical:[],resolveUndo:[],indexOptionalReview:[]};throw error;}
  data=await read('index');
  const decoded=decodeIndex(data,format);
  const ordered=(entries:IndexEntry[])=>{for(let i=0;i<entries.length;i++)if(!entries[i]!.path||i>0&&indexOrder(entries[i-1]!,entries[i]!)>=0)throw new Error('Invalid Git index path/stage ordering');};
  const indexOptionalReview:ReviewedGitUserData['indexOptionalReview']=decoded.optional.map(item=>({source:'index',...item}));
  const resolveUndo=decoded.resolveUndo??[];
  if(!decoded.link){ordered(decoded.entries);return {originals:Buffer.from(JSON.stringify(originals)),logical:decoded.entries,resolveUndo,indexOptionalReview};}
  const width=format==='sha1'?20:32,link=decoded.link;
  if(link.length<width)throw new Error('Truncated split-index link');
  const oid=link.subarray(0,width).toString('hex');let base:IndexEntry[]=[];
  if(!/^0+$/.test(oid)){
    const shared=await read(`sharedindex.${oid}`);
    if(!shared.subarray(shared.length-width).equals(link.subarray(0,width)))throw new Error('Shared Git index identity differs');
    // REUC belongs to the selected overlay, never an inherited or merged shared-base extension.
    const parsed=decodeIndex(shared,format);if(parsed.link||parsed.sparse||parsed.resolveUndo!==undefined)throw new Error('Nested shared, sparse or resolve-undo base Git index refused');base=parsed.entries;indexOptionalReview.push(...parsed.optional.map(item=>({source:'sharedindex' as const,...item})));
  }
  ordered(base);
  let deleted=new Set<number>(),replaced=new Set<number>();
  if(link.length!==width){const first=splitBitmap(link,width,base.length),second=splitBitmap(link,first.end,base.length);if(second.end!==link.length)throw new Error('Unconsumed split-index link');deleted=first.bits;replaced=second.bits;}
  if(replaced.size>decoded.entries.length)throw new Error('Missing split-index replacements');
  let replacement=0;
  const logical=base.flatMap((entry,i)=>{
    if(deleted.has(i)&&replaced.has(i))throw new Error('Conflicting split-index bitmaps');
    if(replaced.has(i)){const next=decoded.entries[replacement++]!;if(next.path)throw new Error('Named split-index replacement refused');return [{...next,path:entry.path}];}
    return deleted.has(i)?[]:[entry];
  });
  const additions=decoded.entries.slice(replacement);ordered(additions);logical.push(...additions);logical.sort(indexOrder);ordered(logical);
  if(logical.length>10000)throw new Error('Logical split index exceeds its bound');
  return {originals:Buffer.from(JSON.stringify(originals)),logical,resolveUndo,indexOptionalReview};
}

/** Source-only custody for one explicitly selected export. Never serialized as authority. */
export interface SelectedGitRoot {
  pathname:string;ref:string;handle:Awaited<ReturnType<typeof fs.open>>;owner:bigint;
}
export interface SelectedGitBinding extends PortableGitStorageBinding {worktreePath:string;storagePath:string}
export interface GitExportCapture {
  io:GitSourceFs;
  bindings:SelectedGitBinding[];
  resolveDirectory(base:string,value:string):Promise<string>;
  verify():Promise<void>;
  close(primary?:unknown):Promise<void>;
  portableBindings(includeHashes?:boolean):PortableGitStorageBinding[];
  bindReview(root:string,data:Buffer):void;
  exclusions(root:string):string[];
  usesGit(root:string):Promise<boolean>;
  record(root:string,evidence:string):void;
}
/** Linux descriptor traversal only. No declaration is sufficient to read an association target. */
export function createGitExportCapture(roots:SelectedGitRoot[],bindings:SelectedGitBinding[]):GitExportCapture {
  if(process.platform!=='linux')throw new Error('Cross-root Git capture requires Linux held descriptor traversal');
  if(!roots.length||!bindings.length)throw new Error('Explicit selected Git storage bindings are required');
  if(new Set(roots.map(root=>root.pathname)).size!==roots.length||new Set(roots.map(root=>root.ref)).size!==roots.length)throw new Error('Selected Git roots must have distinct canonical paths and identities');
  const selected=[...roots].sort((a,b)=>b.pathname.length-a.pathname.length);
  const locate=(target:string)=>{
    const root=selected.find(root=>target===root.pathname||target.startsWith(root.pathname+path.sep));
    if(!root||path.resolve(target)!==target)throw new Error('Git read leaves the explicitly selected working roots');
    return root;
  };
  type Held={handle:SelectedGitRoot['handle'];identity:string;owner:bigint;device:bigint;parent?:string;name?:string};
  const held=new Map<string,Promise<Held>>(),files=new Map<string,Promise<{handle:SelectedGitRoot['handle'];identity:string}>>(),owned:SelectedGitRoot['handle'][]=[];
  const evidence=new Map<string,string>(),reviewHashes=new Map<string,string>(),rootIdentities=new Map<string,string>(),physicalDirectories=new Map<string,string>(),physicalFiles=new Map<string,string>();
  for(const root of roots)held.set(root.pathname,root.handle.stat({bigint:true}).then(stat=>{
    if(!stat.isDirectory()||stat.uid!==root.owner)throw new Error('Selected Git root custody changed');
    const physical=`${stat.dev}:${stat.ino}`,prior=physicalDirectories.get(physical);
    if(prior!==undefined&&prior!==root.pathname)throw new Error('Selected Git roots have unproved physical aliases');
    physicalDirectories.set(physical,root.pathname);rootIdentities.set(root.ref,originalIdentity(stat));
    return {handle:root.handle,identity:originalIdentity(stat),owner:root.owner,device:stat.dev};
  }));
  const descriptor=(entry:Held)=>`/proc/self/fd/${entry.handle.fd}`;
  const directory=(target:string):Promise<Held>=>{
    locate(target);
    let entry=held.get(target);
    if(!entry){
      if(held.size+files.size>=20000)throw new Error('Held Git directory inventory exceeds its bound');
      entry=(async()=>{
        const parent=await directory(path.dirname(target)),name=path.basename(target),relative=descriptor(parent)+'/'+name;
        const before=await fs.lstat(relative,{bigint:true});
        if(!before.isDirectory()||before.uid!==parent.owner||before.dev!==parent.device)throw new Error('Git directory is not a same-owner no-follow descendant');
        const handle=await fs.open(relative,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);owned.push(handle);
        const current=await handle.stat({bigint:true});
        if(originalIdentity(before)!==originalIdentity(current))throw new Error('Git directory changed before custody');
        const physical=`${current.dev}:${current.ino}`,prior=physicalDirectories.get(physical);
        if(prior!==undefined&&prior!==target)throw new Error('Git directory aliases require mount/view proof');
        physicalDirectories.set(physical,target);
        return {handle,identity:originalIdentity(current),owner:parent.owner,device:current.dev,parent:path.dirname(target),name};
      })();
      held.set(target,entry);
    }
    return entry;
  };
  const node=async(target:string)=>{
    const root=locate(target);
    if(target===root.pathname)return descriptor(await directory(target));
    return descriptor(await directory(path.dirname(target)))+'/'+path.basename(target);
  };
  const stat=async(target:string)=>{
    const root=locate(target);
    const observed=target===root.pathname?await root.handle.stat({bigint:true}):await fs.lstat(await node(target),{bigint:true});
    if(observed.uid!==root.owner||observed.dev!==(await directory(root.pathname)).device||observed.isSymbolicLink())throw new Error('Git source node is foreign or symbolic');
    return observed;
  };
  const io:GitSourceFs={
    lstat:(async(target:string,options?:{bigint?:boolean})=>{
      await stat(target);const root=locate(target);
      if(target===root.pathname)return options?.bigint?root.handle.stat({bigint:true}):root.handle.stat();
      return options?.bigint?fs.lstat(await node(target),{bigint:true}):fs.lstat(await node(target));
    }) as typeof fs.lstat,
    realpath:(async(target:string)=>{
      const observed=await stat(target);
      const handle=observed.isDirectory()?(await directory(target)).handle:observed.isFile()?await io.open(target,constants.O_RDONLY):undefined;
      if(!handle||await fs.realpath(`/proc/self/fd/${handle.fd}`)!==target)throw new Error('Held Git node moved from its selected canonical root');
      return target;
    }) as typeof fs.realpath,
    readdir:(async(target:string)=>{
      const entry=await directory(target);return fs.readdir(descriptor(entry));
    }) as typeof fs.readdir,
    open:(async(target:string,flags:number)=>{
      if((flags&(constants.O_WRONLY|constants.O_RDWR|constants.O_CREAT|constants.O_TRUNC|constants.O_APPEND))!==0)throw new Error('Git capture custody is read only');
      const before=await stat(target);
      if(!before.isFile()||before.nlink!==1n)throw new Error('Git original must be a singly linked regular file');
      const physical=`${before.dev}:${before.ino}`,prior=physicalFiles.get(physical);
      if(prior!==undefined&&prior!==target)throw new Error('Git file aliases require mount/view proof');
      physicalFiles.set(physical,target);
      let original=files.get(target);
      if(!original){
        if(files.size+held.size>=20000)throw new Error('Held Git source-node inventory exceeds its bound');
        original=(async()=>{
          const handle=await fs.open(await node(target),flags|constants.O_NOFOLLOW|constants.O_NONBLOCK);owned.push(handle);
          const identity=originalIdentity(await handle.stat({bigint:true}));
          if(identity!==originalIdentity(before))throw new Error('Git original changed before descriptor read');
          return {handle,identity};
        })();
        files.set(target,original);
      }
      const entry=await original;
      if(entry.identity!==originalIdentity(before)||entry.identity!==originalIdentity(await entry.handle.stat({bigint:true})))throw new Error('Held Git source original changed');
      // Readers borrow custody. The export scope closes each underlying descriptor exactly once.
      return new Proxy(entry.handle,{get(handle,key){
        if(key==='close')return async()=>undefined;
        const value=Reflect.get(handle,key,handle);return typeof value==='function'?value.bind(handle):value;
      }});
    }) as typeof fs.open,
  };
  const context:GitExportCapture={io,bindings,
    async resolveDirectory(base,value){
      if(!value||value.includes('\\')||/[\0\r\n]/.test(value)||value.split(path.sep).length>128)throw new Error('Invalid bounded Git association path');
      let target=path.isAbsolute(value)?path.parse(value).root:base;
      for(const part of value.split(path.sep)){
        if(!part||part==='.')continue;
        target=part==='..'?path.dirname(target):path.join(target,part);
        if(selected.some(root=>target===root.pathname||target.startsWith(root.pathname+path.sep))){await directory(target);await io.realpath(target);}
        else if(!selected.some(root=>root.pathname.startsWith(target===path.sep?target:target+path.sep)))throw new Error('Git pointer traverses an unselected path');
      }
      locate(target);await directory(target);return target;
    },
    async verify(){
      for(const [target,promise] of files){
        const entry=await promise;
        if(originalIdentity(await entry.handle.stat({bigint:true}))!==entry.identity||originalIdentity(await stat(target))!==entry.identity)throw new Error('Held Git original or its directory entry changed during capture');
      }
      for(const [target,promise] of held){
        let entry:Held;try{entry=await promise;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
        if(originalIdentity(await entry.handle.stat({bigint:true}))!==entry.identity||await fs.realpath(descriptor(entry))!==target)throw new Error('Held Git directory changed during capture');
        if(entry.parent){const parent=await held.get(entry.parent)!;if(originalIdentity(await fs.lstat(descriptor(parent)+'/'+entry.name,{bigint:true}))!==entry.identity)throw new Error('Git directory entry no longer identifies its held original');}
      }
    },
    async close(primary){
      const results=await Promise.allSettled(owned.map(handle=>handle.close())),errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
      if(errors.length)throw Object.assign(new AggregateError([...(primary?[primary]:[]),...errors],'Git capture descriptor cleanup failed'),{cause:primary,cleanupErrors:errors});
    },
    async usesGit(root){
      if(bindings.some(binding=>binding.worktreePath===root))return true;
      try{await io.lstat(path.join(root,'.git'));return true;}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&bindings.some(binding=>binding.storagePath===root))return false;throw error;}
    },
    exclusions(root){
      const targets=[...new Set(bindings.map(binding=>path.join(binding.storagePath,binding.relativePath)))];
      return targets.filter(target=>target===root||target.startsWith(root+path.sep)).map(target=>target===root?'.':path.relative(root,target).split(path.sep).join('/'));
    },
    record(root,value){const prior=evidence.get(root);if(prior!==undefined&&prior!==value)throw new Error('Git association evidence changed');evidence.set(root,value);},
    bindReview(root,data){
      const hash=createHash('sha256').update(data).digest('hex'),prior=reviewHashes.get(root);
      if(prior!==undefined&&prior!==hash)throw new Error('Authoritative Git review original changed');
      reviewHashes.set(root,hash);
    },
    portableBindings(includeHashes=true){
      return bindings.map(({worktreePath,storagePath,...binding})=>{
        const original=evidence.get(worktreePath);if(!original)throw new Error('Git binding has no reciprocal capture');
        const reviewSha256=reviewHashes.get(worktreePath);if(includeHashes&&!reviewSha256)throw new Error('Git binding has no completed authoritative review original');
        const records=JSON.parse(original) as Array<{path:string;identity:string;data?:string;absent?:true;moduleWorktree?:{value:string;sha256:string}}>;
        const proofRoots=[...new Set(records.map(record=>locate(record.path).ref))].sort().map(ref=>{
          const root=roots.find(root=>root.ref===ref)!;
          safeText(root.pathname,'Git source root provenance');
          const identity=rootIdentities.get(ref);if(!identity)throw new Error('Selected Git root lacks observed custody identity');
          return {rootRef:ref,sourcePath:root.pathname,identity};
        });
        return {...binding,capture:{version:1 as const,currentAuthority:false as const,...(includeHashes?{reviewSha256}:{}),roots:proofRoots,records:records.map(record=>{
          const root=locate(record.path);return {rootRef:root.ref,relativePath:path.relative(root.pathname,record.path).split(path.sep).join('/')||'.',identity:record.identity,...(record.data!==undefined?{dataBase64:record.data}:{}),...(record.absent?{absent:true as const}:{}),...(record.moduleWorktree?{moduleWorktree:record.moduleWorktree}:{})};
        })}};
      });
    },
  };
  return context;
}

type GitAssociation={root:string;gitDir:string;commonDir:string;linked:boolean;module?:true;moduleData?:true;evidence:string};
function originalIdentity(stat:{dev:bigint;ino:bigint;mode:bigint;uid:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint}):string {
  return [stat.dev,stat.ino,stat.mode,stat.uid,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
}
async function absentGitPath(target:string,fsSource?:GitSourceFs):Promise<void> {
  const fs=fsSource??sourceFs;
  try{await fs.lstat(target);throw new Error('Unsupported Git topology or operation metadata; preserve source');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}

/** Check raw path components before resolving dot-dot; lexical normalization must not erase a symlink. */
async function associationDirectory(base:string,value:string):Promise<string> {
  const parts=value.split(path.sep);if(parts.length>128)throw new Error('Git association path exceeds its bound');
  let target=path.isAbsolute(value)?path.parse(value).root:base;
  for(const part of parts){
    if(!part||part==='.')continue;
    target=part==='..'?path.dirname(target):path.join(target,part);
    const stat=await fs.lstat(target);
    if(!stat.isDirectory()||await fs.realpath(target)!==target)throw new Error('Git association path has a symlink or special component');
  }
  return target;
}

/** Explicit Include Git authorizes only this reciprocal association, never a worktrees inventory. */
async function gitAssociation(root:string,capture?:GitExportCapture):Promise<GitAssociation|undefined> {
  const fs=capture?.io??sourceFs;
  const resolveDirectory=capture?capture.resolveDirectory:associationDirectory;
  const pointer=path.join(root,'.git');
  let node;try{node=await fs.lstat(pointer,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
  const owner=(await fs.lstat(root,{bigint:true})).uid,evidence:Array<{path:string;identity:string;data?:string;absent?:true;moduleWorktree?:{value:string;sha256:string}}>=[];
  const directory=async(target:string)=>{
    const stat=await fs.lstat(target,{bigint:true});
    if(!stat.isDirectory()||stat.uid!==owner||await fs.realpath(target)!==target)throw new Error('Git association requires canonical same-owner directories');
    evidence.push({path:target,identity:originalIdentity(stat)});
  };
  const associationFile=async(target:string)=>{
    const before=await fs.lstat(target,{bigint:true});
    if(before.uid!==owner||!before.isFile()||before.nlink!==1n||before.size>4096n)throw new Error('Git association original requires a bounded same-owner regular file');
    const {data}=await regularOriginal(target,4096,owner,fs),after=await fs.lstat(target,{bigint:true});
    if(data.length>4096||originalIdentity(before)!==originalIdentity(after))throw new Error('Git association original is oversized, foreign or changed');
    const value=text(data);if(!value||!Buffer.from(value).equals(data)||/[\0\r]/.test(value)||value.replace(/\n$/,'').includes('\n'))throw new Error('Malformed Git association original');
    safeText(value,'Git association original');
    evidence.push({path:target,identity:originalIdentity(after),data:data.toString('base64')});return value.replace(/\n$/,'');
  };
  const absence=async(target:string)=>{await absentGitPath(target,fs);evidence.push({path:target,identity:'',absent:true});};
  await directory(root);
  if(node.isDirectory()){
    await directory(pointer);
    for(const name of ['commondir','gitdir'])await absence(path.join(pointer,name));
    return {root,gitDir:pointer,commonDir:pointer,linked:false,evidence:JSON.stringify(evidence)};
  }
  // Only these association records may be read before reciprocal authority is established.
  const value=await associationFile(pointer);
  if(!value.startsWith('gitdir: ')||!value.slice(8))throw new Error('Unsupported Git pointer');
  const gitTarget=path.resolve(root,value.slice(8));
  if(capture&&!capture.bindings.some(binding=>binding.worktreePath===root&&['private','module'].includes(binding.role)&&path.join(binding.storagePath,binding.relativePath)===gitTarget))throw new Error('Git private pointer lacks an exact selected binding');
  const gitDir=await resolveDirectory(root,value.slice(8));await directory(gitDir);
  let hasBacklink=true;
  try{await fs.lstat(path.join(gitDir,'gitdir'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')hasBacklink=false;else throw error;}
  if(!hasBacklink){
    const moduleBinding=capture?.bindings.find(binding=>binding.worktreePath===root&&binding.role==='module'&&path.join(binding.storagePath,binding.relativePath)===gitDir);
    if(moduleBinding){
      for(const name of ['gitdir','commondir'])await absence(path.join(gitDir,name));
      const target=path.join(gitDir,'config'),before=await fs.lstat(target,{bigint:true}),{data}=await regularOriginal(target,1024*1024,owner,fs),after=await fs.lstat(target,{bigint:true});
      if(originalIdentity(before)!==originalIdentity(after))throw new Error('Module configuration changed during association capture');
      const parsed=await parseCapturedGitConfiguration(data);
      const entries=(parsed?parsed.slice(0,-1).split('\0'):[]).filter(row=>row.slice(0,row.indexOf('\n')).toLowerCase()==='core.worktree');
      if(!parsed.endsWith('\0')||entries.length!==1)throw new Error('Selected module requires one literal core.worktree association');
      const value=entries[0]!.slice(entries[0]!.indexOf('\n')+1);
      safeText(value,'Module worktree path');
      if(await resolveDirectory(gitDir,value)!==root)throw new Error('Module core.worktree does not identify the selected working root');
      evidence.push({path:target,identity:originalIdentity(after),moduleWorktree:{value,sha256:createHash('sha256').update(data).digest('hex')}});
      return {root,gitDir,commonDir:gitDir,linked:false,module:true,evidence:JSON.stringify(evidence)};
    }
    if(!gitDir.startsWith(root+path.sep))throw new Error('Separated Git storage outside the selected root requires explicit storage selection');
    await absentGitPath(path.join(gitDir,'commondir'),fs);
    return {root,gitDir,commonDir:gitDir,linked:false,evidence:JSON.stringify(evidence)};
  }
  const backlink=await associationFile(path.join(gitDir,'gitdir'));
  // Resolve only the raw parent components; the final .git is the already observed file.
  const slash=backlink.lastIndexOf(path.sep);
  if(backlink.split(path.sep).length>128||backlink.slice(slash+1)!=='.git'||await resolveDirectory(gitDir,slash<0?'.':backlink.slice(0,slash)||path.sep)!==root)throw new Error('Git worktree backlink does not identify the selected root');
  const commonValue=await associationFile(path.join(gitDir,'commondir'));
  if(capture&&!capture.bindings.some(binding=>binding.worktreePath===root&&binding.role==='common'&&path.join(binding.storagePath,binding.relativePath)===path.resolve(gitDir,commonValue)))throw new Error('Git common pointer lacks an exact selected binding');
  const commonDir=await resolveDirectory(gitDir,commonValue);
  if(!commonValue||commonDir===gitDir||path.dirname(gitDir)!==path.join(commonDir,'worktrees')||!path.basename(gitDir)||path.basename(gitDir).startsWith('.'))throw new Error('Unsupported Git common-directory association');
  if(capture&&(commonDir===root||gitDir===root))throw new Error('Working and Git storage roles cannot collapse');
  await directory(commonDir);await directory(path.join(commonDir,'worktrees'));
  for(const name of ['commondir','gitdir'])await absence(path.join(commonDir,name));
  // Recheck the complete association before permitting any repository content read.
  for(const item of evidence){
    if(item.absent){await absentGitPath(item.path,fs);continue;}
    const before=await fs.lstat(item.path,{bigint:true});
    if(originalIdentity(before)!==item.identity||await fs.realpath(item.path)!==item.path)throw new Error('Git reciprocal association changed');
    if(item.data!==undefined){const {data}=await regularOriginal(item.path,4096,owner,fs),after=await fs.lstat(item.path,{bigint:true});if(data.toString('base64')!==item.data||originalIdentity(after)!==item.identity)throw new Error('Git reciprocal association original changed');}
  }
  return {root,gitDir,commonDir,linked:true,evidence:JSON.stringify(evidence)};
}

/** Prove every declared association before working inventory or repository-family reads. */
export async function verifyGitExportAssociations(capture:GitExportCapture):Promise<void> {
  for(const root of new Set(capture.bindings.map(binding=>binding.worktreePath))){
    const selected=capture.bindings.filter(binding=>binding.worktreePath===root);
    const module=selected.length===1&&selected[0]!.role==='module';
    if(!module&&(selected.length!==2||!selected.some(binding=>binding.role==='common')||!selected.some(binding=>binding.role==='private')))throw new Error('Select one module binding or the complete common/private binding pair');
    const association=await gitAssociation(root,capture);
    if(module?!association?.module:!association?.linked)throw new Error('Mapped Git capture lacks its exact module or common/private association');
    capture.record(root,association.evidence);
  }
  await capture.verify();
}

/** Prevent selected contained separated storage from also becoming ordinary working-file bytes. */
export async function selectedReviewedGitStorage(root:string,capture?:GitExportCapture):Promise<string[]> {
  if(capture)return capture.exclusions(root);
  const association=await gitAssociation(root);if(!association)return [];
  const roots=[...new Set([association.gitDir,association.commonDir])].filter(target=>target!==path.join(root,'.git')&&target.startsWith(root+path.sep));
  return roots.filter(target=>!roots.some(parent=>parent!==target&&target.startsWith(parent+path.sep))).map(target=>path.relative(root,target).split(path.sep).join('/'));
}

type CapturedGitFile={name:string;source:'selected'|'shared';data:Buffer;metadata?:{mode:number;mtimeNs:string}};
/** Derived local caches are observed for drift, never parsed or supplied to native Git. */
function derivedGitCache(name:string,format?:'sha1'|'sha256'):boolean {
  const width=format==='sha1'?'{40}':format==='sha256'?'{64}':'{40}(?:[a-f0-9]{24})?';
  const midx=new RegExp('^objects/pack/(?:multi-pack-index-[a-f0-9]'+width+'\\.(?:bitmap|rev)|multi-pack-index\\.d/multi-pack-index-[a-f0-9]'+width+'\\.(?:midx|bitmap|rev))$');
  return name==='info/refs'||name==='objects/info/packs'||name==='objects/pack/multi-pack-index'||name==='objects/pack/multi-pack-index.d/multi-pack-index-chain'||midx.test(name)||name==='objects/info/commit-graph'||name==='objects/info/commit-graphs/commit-graph-chain'||new RegExp('^objects/info/commit-graphs/graph-[a-f0-9]'+width+'\\.graph$').test(name);
}

/** Complete exact allowed roots only; never enumerate common/worktrees or main-worktree private files. */
async function captureGitRaw(association:GitAssociation,reftable=false,fsSource?:GitSourceFs) {
  const fs=fsSource??sourceFs;
  const {gitDir,commonDir,linked}=association,files:CapturedGitFile[]=[],inventory:Array<{name:string;source:'selected'|'shared';identity:string;digest?:string;absent?:true}>=[];
  const owner=(await fs.lstat(association.root,{bigint:true})).uid,names=new Set<string>();
  let nodes=0,bytes=0,hookEntries=0;
  const walk=async(target:string,name:string,source:'selected'|'shared',objects=false,optional=true):Promise<void>=>{
    const hook=name==='hooks'||name.startsWith('hooks/'),originalDirectory=gitDirectoryOriginalNames.some(root=>name===root||name.startsWith(root+'/')),gitOriginal=gitReviewOriginal('.git/'+name);
    if(gitOriginal&&source!==(gitSelectedOriginalNames.includes(name)?'selected':'shared'))throw new Error('Git review original differs from its common or selected-worktree provenance');
    if(originalDirectory&&(source!=='shared'||!gitDirectoryOriginalNames.includes(name)&&!gitOriginal))throw new Error('Invalid common Git review original path');
    if(hook&&name!=='hooks'&&++hookEntries>1000)throw new Error('Git hook inventory exceeds 1000 entries');
    const refPath=name.startsWith('logs/')?name.slice(5):name;
    // Common private names belong to the main worktree: do not even stat or open them.
    if(linked&&source==='shared'&&privateRef(refPath))return;
    if(linked&&source==='selected'&&(name.startsWith('refs/')||name.startsWith('logs/refs/'))&&!privateRef(refPath))throw new Error('Unsupported selected private Git ref storage');
    let before;try{before=await fs.lstat(target,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&(!originalDirectory||optional)){inventory.push({name,source,identity:'',absent:true});return;}throw error;}
    if(++nodes>20000||before.uid!==owner||await fs.realpath(target)!==target)throw new Error('Git raw inventory is foreign, external or exceeds its bound');
    if(before.isDirectory()){
      if(!objects&&!originalDirectory&&!['refs','logs/refs'].some(prefix=>name===prefix||name.startsWith(prefix+'/')))throw new Error('Git control original must be a regular file');
      if(objects&&!['objects','objects/pack','objects/info','objects/info/commit-graphs','objects/pack/multi-pack-index.d'].includes(name)&&!/^objects\/[a-f0-9]{2}$/.test(name))throw new Error('Unsupported Git object directory');
      inventory.push({name,source,identity:originalIdentity(before)});
      const entries=(await fs.readdir(target)).sort();
      for(const entry of entries)await walk(path.join(target,entry),name+'/'+entry,source,objects,false);
      const optional=name==='objects'?['info','pack']:name==='objects/info'?['commit-graph','commit-graphs','packs']:name==='objects/info/commit-graphs'?['commit-graph-chain']:name==='objects/pack'?['multi-pack-index','multi-pack-index.d']:name==='objects/pack/multi-pack-index.d'?['multi-pack-index-chain']:[];
      for(const entry of optional)if(!entries.includes(entry))await walk(path.join(target,entry),name+'/'+entry,source,objects);
      if(name==='objects/pack')for(const entry of entries.filter(entry=>/^pack-[a-f0-9]{40}(?:[a-f0-9]{24})?\.pack$/.test(entry)))for(const suffix of ['keep','mtimes']){const companion=entry.slice(0,-4)+suffix;if(!entries.includes(companion))await walk(path.join(target,companion),name+'/'+companion,source,objects);}
      const after=await fs.lstat(target,{bigint:true});if(originalIdentity(before)!==originalIdentity(after))throw new Error('Git raw directory changed');
    }else{
      if(gitDirectoryOriginalNames.includes(name))throw new Error('Common Git original root must be a directory');
      if(['refs','logs/refs'].includes(name)||linked&&source==='selected'&&['refs/bisect','refs/rewritten','refs/worktree'].includes(refPath))throw new Error('Git ref namespace must be a directory');
      if(['objects/info/commit-graphs','objects/pack/multi-pack-index.d'].includes(name))throw new Error('Git derived-cache namespace must be a directory');
      const cache=derivedGitCache(name),retention=objects&&/\.(?:keep|mtimes)$/.test(name);
      if(objects&&!cache&&!/^objects\/(?:[a-f0-9]{2}\/[a-f0-9]{38}(?:[a-f0-9]{24})?|pack\/pack-[a-f0-9]{40}(?:[a-f0-9]{24})?\.(?:pack|idx|rev|bitmap|keep|mtimes))$/.test(name))throw new Error('Unsupported Git object storage, alternates or promisor metadata');
      if(name.startsWith('refs/'))refName(name);else if(name.startsWith('logs/')&&!(source==='selected'&&name==='logs/ORIG_HEAD'))reflogPath(name.slice(5));
      if(names.has(name))throw new Error('Selected and shared Git originals shadow each other');names.add(name);
      const {data}=await regularOriginal(target,name==='ORIG_HEAD'?4096:/^(?:selected-)?reftable\//.test(name)?4*1024*1024:cache?4*1024*1024:retention?1024*1024:objects?limit:1024*1024,owner,fs),after=await fs.lstat(target,{bigint:true});
      if((bytes+=data.length)>limit||originalIdentity(before)!==originalIdentity(after))throw new Error('Git raw originals changed or exceed their bound');
      if(gitOriginal)inspectGitReviewOriginal(data,'.git/'+name);
      if(cache||retention)safeText(data.toString('latin1'),cache?'Git derived cache':'Git pack retention original');
      inventory.push({name,source,identity:originalIdentity(after),digest:createHash('sha256').update(data).digest('hex')});files.push({name,source,data,...(gitOriginal?{metadata:{mode:Number(after.mode&0o777n),mtimeNs:after.mtimeNs.toString()}}:{})});
    }
  };
  // Inspect only the exact common info parent and three allowlisted files, never its other contents.
  const info=path.join(commonDir,'info');
  const infoIdentity=async():Promise<string|null>=>{
    let stat;try{stat=await fs.lstat(info,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
    if(!stat.isDirectory()||stat.uid!==owner||await fs.realpath(info)!==info)throw new Error('Git info parent must be canonical and same-owner');
    return originalIdentity(stat);
  };
  const infoBefore=await infoIdentity();
  inventory.push({name:'info',source:'shared',identity:infoBefore??'',...(infoBefore===null?{absent:true as const}:{})});
  for(const name of [...gitInfoPaths,'info/refs'])await walk(path.join(commonDir,name),name,'shared');
  if(await infoIdentity()!==infoBefore)throw new Error('Git info parent changed during capture');
  for(const name of ['HEAD','ORIG_HEAD','FETCH_HEAD',...gitSelectedOriginalNames,'config.worktree','info/sparse-checkout'])await walk(path.join(gitDir,name),name,'selected');
  const objectDirectory=await fs.lstat(path.join(commonDir,'objects'));if(!objectDirectory.isDirectory())throw new Error('Missing regular Git object directory');
  // Packed refs precede loose overrides in the captured view.
  for(const name of ['config','shallow',...(reftable?[]:['packed-refs','refs']),'objects',...gitDirectoryOriginalNames,...gitWebOriginalNames])await walk(path.join(commonDir,name),name,'shared',name==='objects');
  if(reftable)for(const [directory,source,prefix] of [
    [path.join(commonDir,'reftable'),'shared','reftable'],
    ...(linked?[[path.join(gitDir,'reftable'),'selected','selected-reftable']]:[]),
  ] as Array<[string,'selected'|'shared',string]>){
    const before=await fs.lstat(directory,{bigint:true});
    if(!before.isDirectory()||before.uid!==owner||await fs.realpath(directory)!==directory)throw new Error('Reftable storage must be canonical and same-owner');
    inventory.push({name:prefix,source,identity:originalIdentity(before)});
    await walk(path.join(directory,'tables.list'),prefix+'/tables.list',source,false,false);
    const list=files.find(file=>file.source===source&&file.name===prefix+'/tables.list')!;
    for(const name of reftableNames(list.data))await walk(path.join(directory,name),prefix+'/'+name,source,false,false);
    const after=await fs.lstat(directory,{bigint:true});if(originalIdentity(before)!==originalIdentity(after))throw new Error('Reftable stack directory changed');
  }
  for(const directory of new Set([gitDir,commonDir])){
    const target=path.join(directory,'logs');
    const source=directory===gitDir?'selected':'shared';
    let before;try{before=await fs.lstat(target,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){inventory.push({name:'logs',source,identity:'',absent:true});continue;}throw error;}
    if(!before.isDirectory()||before.uid!==owner||await fs.realpath(target)!==target)throw new Error('Git log parent is not canonical and same-owner');
    if(!linked||directory===gitDir)for(const name of await fs.readdir(target))if(!['HEAD','ORIG_HEAD','refs'].includes(name))throw new Error('Unsupported selected Git reflog original');
    inventory.push({name:'logs',source,identity:originalIdentity(before)});
  }
  await walk(path.join(gitDir,'logs','ORIG_HEAD'),'logs/ORIG_HEAD','selected');
  await walk(path.join(gitDir,'logs','HEAD'),'logs/HEAD','selected');await walk(path.join(commonDir,'logs','refs'),'logs/refs','shared');
  if(linked&&!reftable){
    await walk(path.join(gitDir,'refs'),'refs','selected');
    await walk(path.join(gitDir,'logs','refs'),'logs/refs','selected');
  }
  if(await infoIdentity()!==infoBefore)throw new Error('Git info parent changed during capture');
  const infoReview:ReviewedGitUserData['infoReview']=gitInfoPaths.map(name=>({path:name,source:'common_repository',dataBase64:files.find(file=>file.source==='shared'&&file.name===name)?.data.toString('base64')??null}));
  validateGitInfoReview(infoReview);
  const shallowReview:ReviewedGitUserData['shallowReview']={path:'shallow',source:'common_repository',dataBase64:files.find(file=>file.source==='shared'&&file.name==='shallow')?.data.toString('base64')??null};
  const origHeadReview:ReviewedGitUserData['origHeadReview']={path:'ORIG_HEAD',source:'selected_worktree',dataBase64:files.find(file=>file.source==='selected'&&file.name==='ORIG_HEAD')?.data.toString('base64')??null,reflogDataBase64:files.find(file=>file.source==='selected'&&file.name==='logs/ORIG_HEAD')?.data.toString('base64')??null};
  const fetchHeadReview:ReviewedGitUserData['fetchHeadReview']={path:'FETCH_HEAD',source:'selected_worktree',dataBase64:files.find(file=>file.source==='selected'&&file.name==='FETCH_HEAD')?.data.toString('base64')??null};
  return {files,evidence:JSON.stringify(inventory),infoReview,shallowReview,origHeadReview,fetchHeadReview};
}

/** Native plumbing sees only an exclusive private copy, with generated config and no source pointers/index. */
async function readCapturedGit(files:CapturedGitFile[],format:'sha1'|'sha256',reftable?:ReturnType<typeof decodeReftableReview>) {
  const parent=await fs.realpath(tmpdir()),root=await fs.mkdtemp(path.join(parent,'ponderosa-git-read-'));
  const stat=await fs.lstat(root);if(!stat.isDirectory()||(stat.mode&0o077)!==0||await fs.realpath(root)!==root||(await fs.readdir(root)).length)throw new Error('Git capture view is not private and empty');
  try{
    const directories=[root],written:Array<{target:string;data:Buffer;identity:string}>=[];
    const mkdir=async(target:string):Promise<void>=>{
      if(directories.includes(target))return;await mkdir(path.dirname(target));await fs.mkdir(target,{mode:0o700});directories.push(target);
    };
    const write=async(name:string,data:Buffer)=>{
      const target=path.join(root,'.git',name);await mkdir(path.dirname(target));await fs.writeFile(target,data,{flag:'wx',mode:0o600});written.push({target,data,identity:originalIdentity(await fs.lstat(target,{bigint:true}))});
    };
    // Object enumeration needs no traversal boundary: shallow and grafts stay out of this read view.
    // Nothing copied here can route Git to a live repository or settings file.
    await mkdir(path.join(root,'.git','refs'));await mkdir(path.join(root,'.git','objects'));
    await write('config',Buffer.from('[core]\nrepositoryformatversion = '+(format==='sha256'?1:0)+'\nbare = true\nhooksPath = /dev/null\nfsmonitor = false\n'+(format==='sha256'?'[extensions]\nobjectformat = sha256\n':'')));
    const oidPattern=format==='sha1'?/^[a-f0-9]{40}$/:/^[a-f0-9]{64}$/;
    const expectedRefs=new Map<string,{oid?:string;symbolic?:string}>();
    if(reftable){for(const ref of reftable.refs)expectedRefs.set(ref.name,ref);await write('HEAD',Buffer.from('symbolic' in reftable.head?'ref: '+reftable.head.symbolic+'\n':reftable.head.oid+'\n'));}
    for(const file of files){
      if(reftable&&!file.name.startsWith('objects/'))continue;
      if(gitReviewOriginal('.git/'+file.name))continue;
      if(file.name==='ORIG_HEAD'||file.name==='logs/ORIG_HEAD'||file.name==='FETCH_HEAD')continue;
      if(derivedGitCache(file.name)){
        if(!derivedGitCache(file.name,format))throw new Error('Git derived cache name differs from the declared format');
        continue;
      }
      if(file.name.startsWith('objects/')){
        const width=format==='sha1'?40:64;
        const loose=new RegExp('^objects/[a-f0-9]{2}/[a-f0-9]{'+(width-2)+'}$'),packed=new RegExp('^objects/pack/pack-[a-f0-9]{'+width+'}\\.(?:pack|idx|rev|bitmap|keep|mtimes)$');
        if(!loose.test(file.name)&&!packed.test(file.name))throw new Error('Git object storage name differs from the declared format');
      }
      if(file.name==='packed-refs'){
        const value=text(file.data);if(value&&!value.endsWith('\n'))throw new Error('Truncated packed Git refs');
        const names=new Set<string>();let canPeel=false;
        for(const line of value?value.slice(0,-1).split('\n'):[]){
          if(line.startsWith('#')){if(!/^# pack-refs with:(?: (?:peeled|fully-peeled|sorted))* *$/.test(line))throw new Error('Unsupported packed Git ref header');canPeel=false;continue;}
          if(line.startsWith('^')){if(!canPeel||!oidPattern.test(line.slice(1)))throw new Error('Invalid peeled Git ref');canPeel=false;continue;}
          const split=line.indexOf(' '),oid=line.slice(0,split),name=line.slice(split+1);refName(name);
          if(!oidPattern.test(oid)||names.has(name)||privateRef(name))throw new Error('Invalid, duplicate or private packed Git ref');
          names.add(name);expectedRefs.set(name,{oid});canPeel=true;
        }
      }
      if(file.name.startsWith('objects/pack/')){
        const stem=file.name.replace(/\.[^.]+$/,'');
        if(!files.some(item=>item.name===stem+'.pack')||!files.some(item=>item.name===stem+'.idx'))throw new Error('Incomplete captured Git pack storage');
      }
      if(/^objects\/pack\/pack-[a-f0-9]+\.(?:keep|mtimes)$/.test(file.name))continue;
      if(file.name==='HEAD'||file.name.startsWith('refs/')){
        if(file.name!=='HEAD')refName(file.name);
        const value=text(file.data).replace(/\n$/,'');
        if(value.startsWith('ref: '))refName(value.slice(5));else if(!oidPattern.test(value))throw new Error('Unsupported Git ref original');
        if(file.name!=='HEAD')expectedRefs.set(file.name,value.startsWith('ref: ')?{symbolic:value.slice(5)}:{oid:value});
      }else if(file.name!=='packed-refs'&&!file.name.startsWith('objects/'))continue;
      await write(file.name,file.data);
    }
    // Resolve only captured names; aliases such as main-worktree/HEAD never reach Git.
    const refDirectories=new Set<string>();
    for(const [name,ref] of expectedRefs){
      const parts=name.split('/');for(let i=1;i<parts.length;i++)refDirectories.add(parts.slice(0,i).join('/'));
      const seen=new Set([name]);let target=ref;
      while(target.symbolic){
        const next=expectedRefs.get(target.symbolic);
        if(!next||seen.has(target.symbolic))throw new Error('Missing, external or cyclic captured Git symbolic target');
        seen.add(target.symbolic);target=next;
      }
    }
    for(const name of expectedRefs.keys())if(!reftable&&refDirectories.has(name))throw new Error('Captured Git refs shadow a directory');
    const directoryIdentities=await Promise.all(directories.map(async target=>({target,identity:originalIdentity(await fs.lstat(target,{bigint:true}))})));
    const refs=reftable?Buffer.from(reftable.refs.map(ref=>[ref.name,ref.oid,ref.symbolic??''].join('\0')).join('\n')+'\n'):await git(root,['for-each-ref','--format=%(refname)%00%(objectname)%00%(symref)']);
    const actualRefs=new Map<string,{oid:string;symbolic:string}>();
    for(const row of text(refs).split('\n').filter(Boolean)){
      const parts=row.split('\0');if(parts.length!==3||actualRefs.has(parts[0]!))throw new Error('Invalid captured Git ref inventory');
      actualRefs.set(parts[0]!,{oid:parts[1]!,symbolic:parts[2]!});
    }
    if(actualRefs.size!==expectedRefs.size||[...expectedRefs].some(([name,expected])=>{const actual=actualRefs.get(name);return !actual||expected.oid!==undefined&&actual.oid!==expected.oid||actual.symbolic!==(expected.symbolic??'');}))throw new Error('Missing, broken or normalized Git ref original');
    const originalHead=reftable?{data:Buffer.from('symbolic' in reftable.head?'ref: '+reftable.head.symbolic+'\n':reftable.head.oid+'\n')}:files.find(file=>file.name==='HEAD');if(!originalHead)throw new Error('Missing selected Git HEAD');
    const headValue=text(originalHead.data).replace(/\n$/,'');
    const head=Buffer.from(headValue.startsWith('ref: ')?headValue.slice(5):headValue);
    const batch=await git(root,['cat-file','--batch-all-objects','--batch']);
    // On any failure leave private partial originals; remove only known, unchanged copies after success.
    for(const file of written){const {data}=await regularOriginal(file.target,limit),stat=await fs.lstat(file.target,{bigint:true});if(!data.equals(file.data)||originalIdentity(stat)!==file.identity)throw new Error('Private Git view changed; retain partial originals');}
    for(const directory of directoryIdentities)if(await fs.realpath(directory.target)!==directory.target||originalIdentity(await fs.lstat(directory.target,{bigint:true}))!==directory.identity)throw new Error('Private Git view directory changed; retain partial originals');
    for(const file of written)await fs.unlink(file.target);
    for(const directory of directories.reverse())await fs.rmdir(directory);
    return {refs,head,batch};
  }catch(error){throw new Error(`Git capture view incomplete; preserve private originals at ${root}`,{cause:error});}
}

type CapturedModuleSource={name:string;source:NonNullable<ReviewedGitUserData['modules']>[number]['source'];worktreeRelativePath:string|null;evidence:string};
async function captureModuleSources(root:string,association:GitAssociation,fs:GitSourceFs,capture?:GitExportCapture,index:IndexEntry[]=[]):Promise<{modules:CapturedModuleSource[];evidence:string}> {
  const modules:CapturedModuleSource[]=[],evidence:unknown[]=[],base=path.join(association.commonDir,'modules');
  const owner=(await fs.lstat(association.root,{bigint:true})).uid;let count=0;
  const walk=async(target:string,name:string):Promise<void>=>{
    let before;try{before=await fs.lstat(target,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&target===base){evidence.push({path:target,absent:true});return;}throw error;}
    if(++count>20000||!before.isDirectory()||before.uid!==owner||await fs.realpath(target)!==target)throw new Error('Native module storage must be bounded canonical same-owner directories');
    const entries=(await fs.readdir(target)).sort();evidence.push({path:target,identity:originalIdentity(before),entries});
    if(name&&entries.includes('config')&&entries.includes('HEAD')&&entries.includes('objects')){
      storageRelativePath(name);
      for(const name of ['gitdir','commondir'])await absentGitPath(path.join(target,name),fs);
      const config=path.join(target,'config'),start=await fs.lstat(config,{bigint:true}),{data}=await regularOriginal(config,1024*1024,owner,fs),end=await fs.lstat(config,{bigint:true});
      if(originalIdentity(start)!==originalIdentity(end))throw new Error('Native module configuration changed');
      const parsed=await parseCapturedGitConfiguration(data),values=(parsed?parsed.slice(0,-1).split('\0'):[]).filter(row=>row.slice(0,row.indexOf('\n')).toLowerCase()==='core.worktree');
      if(!parsed.endsWith('\0')||values.length!==1)throw new Error('Native module storage needs one literal core.worktree');
      const coreWorktree=values[0]!.slice(values[0]!.indexOf('\n')+1);safeText(coreWorktree,'Native module worktree path');
      if(!coreWorktree||/[\\\0\r\n]/.test(coreWorktree))throw new Error('Malformed native module worktree path');
      const worktreePath=path.resolve(target,coreWorktree),contained=worktreePath.startsWith(root+path.sep),relative=contained?path.relative(root,worktreePath).split(path.sep).join('/'):null;
      // Source pathname disclosure is inert. Reading a working pointer still requires a selected root.
      if(!contained&&!capture?.bindings.some(binding=>worktreePath===binding.worktreePath||worktreePath.startsWith(binding.worktreePath+path.sep)))throw new Error('Module working root is outside the selected closure; include its Agent root and module storage binding');
      let initialized=false,pointerEvidence:unknown={absent:true};
      const pointer=path.join(worktreePath,'.git');
      try{
        const resolved=capture?await capture.resolveDirectory(association.root,worktreePath):await associationDirectory(association.root,path.relative(association.root,worktreePath));
        if(resolved!==worktreePath)throw new Error('Native module working root is not canonical');
        const pointerStat=await fs.lstat(pointer,{bigint:true});
        const {data:pointerData}=await regularOriginal(pointer,4096,owner,fs),pointerAfter=await fs.lstat(pointer,{bigint:true});
        const value=text(pointerData).replace(/\n$/,'');
        if(originalIdentity(pointerStat)!==originalIdentity(pointerAfter)||!value.startsWith('gitdir: ')||/[\0\r\n]/.test(value)||path.resolve(worktreePath,value.slice(8))!==target)throw new Error('Native module working pointer differs from selected storage');
        initialized=true;pointerEvidence={identity:originalIdentity(pointerAfter),data:pointerData.toString('base64')};
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const source={storagePath:target,worktreePath,coreWorktree,configurationSha256:createHash('sha256').update(data).digest('hex'),initialized};
      const original=JSON.stringify({identity:originalIdentity(end),source,pointerEvidence});evidence.push(original);
      modules.push({name,source,worktreeRelativePath:relative,evidence:original});
      if(modules.length>1000)throw new Error('Native module repository inventory exceeds its bound');
    }else for(const entry of entries){storageRelativePath(entry);await walk(path.join(target,entry),name?name+'/'+entry:entry);}
    if(originalIdentity(await fs.lstat(target,{bigint:true}))!==originalIdentity(before))throw new Error('Native module directory changed during capture');
  };
  await walk(base,'');
  for(const entry of new Map(index.filter(entry=>entry.mode==='160000').map(entry=>[entry.path,entry])).values()){
    const worktreePath=path.join(root,entry.path),pointer=path.join(worktreePath,'.git');
    if(modules.some(module=>module.source.worktreePath===worktreePath))continue;
    let stat;
    try{
      const resolved=capture?await capture.resolveDirectory(association.root,worktreePath):await associationDirectory(association.root,path.relative(association.root,worktreePath));
      if(resolved!==worktreePath)throw new Error('Gitlink working root is not canonical');
      stat=await fs.lstat(pointer,{bigint:true});
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){evidence.push({worktreePath,pointerAbsent:true});continue;}throw error;}
    if(stat.isDirectory()){
      if(await fs.realpath(pointer)!==pointer||stat.uid!==owner)throw new Error('Embedded module storage is not canonical and same-owner');
      for(const name of ['gitdir','commondir'])await absentGitPath(path.join(pointer,name),fs);
      const config=path.join(pointer,'config'),start=await fs.lstat(config,{bigint:true}),{data}=await regularOriginal(config,1024*1024,owner,fs),end=await fs.lstat(config,{bigint:true});
      if(originalIdentity(start)!==originalIdentity(end))throw new Error('Embedded module configuration changed');
      const parsed=await parseCapturedGitConfiguration(data),values=(parsed?parsed.slice(0,-1).split('\0'):[]).filter(row=>row.slice(0,row.indexOf('\n')).toLowerCase()==='core.worktree');
      if(!parsed.endsWith('\0')||values.length>1)throw new Error('Embedded module has ambiguous core.worktree');
      const coreWorktree=values.length?values[0]!.slice(values[0]!.indexOf('\n')+1):'..';
      if(!coreWorktree||/[\\\0\r\n]/.test(coreWorktree)||path.resolve(pointer,coreWorktree)!==worktreePath)throw new Error('Embedded module core.worktree differs');
      const source={storagePath:pointer,worktreePath,coreWorktree,configurationSha256:createHash('sha256').update(data).digest('hex'),initialized:true,embedded:true as const};
      const original=JSON.stringify({source,identity:originalIdentity(end),directoryIdentity:originalIdentity(stat)});evidence.push(original);
      modules.push({name:entry.path,source,worktreeRelativePath:entry.path,evidence:original});
    }else{
      // Absorbed modules outside modules/ still need an exact human-selected storage root.
      const selected=capture?.bindings.find(binding=>binding.role==='module'&&binding.worktreePath===worktreePath);
      if(!selected)throw new Error('Gitlink pointer lacks selected module storage; include its Agent root and module binding');
      const current=await gitAssociation(worktreePath,capture);
      if(!current?.module)throw new Error('Gitlink module binding lacks a native association');
      const config=path.join(current.gitDir,'config'),{data}=await regularOriginal(config,1024*1024,owner,fs);
      const parsed=await parseCapturedGitConfiguration(data),values=parsed.slice(0,-1).split('\0').filter(row=>row.slice(0,row.indexOf('\n')).toLowerCase()==='core.worktree');
      if(values.length!==1)throw new Error('Selected module has ambiguous core.worktree');
      const source={storagePath:current.gitDir,worktreePath,coreWorktree:values[0]!.slice(values[0]!.indexOf('\n')+1),configurationSha256:createHash('sha256').update(data).digest('hex'),initialized:true};
      evidence.push(current.evidence);modules.push({name:entry.path,source,worktreeRelativePath:entry.path,evidence:current.evidence});
    }
    if(modules.length>1000)throw new Error('Native module repository inventory exceeds its bound');
  }
  return {modules,evidence:JSON.stringify(evidence)};
}

/** Bounded immutable originals with observed-change refusal; this does not drain independent writers. */
export async function exportReviewedGit(root:string,capture?:GitExportCapture):Promise<{git:ReviewedGitUserData;gitOriginals:ReviewedUserData['providerFiles']}|undefined> {
  const association=await gitAssociation(root,capture);if(!association)return undefined;
  return captureReviewedGit(root,association,capture);
}
async function captureReviewedGit(root:string,association:GitAssociation,capture?:GitExportCapture,depth=0):Promise<{git:ReviewedGitUserData;gitOriginals:ReviewedUserData['providerFiles']}> {
  if(depth>16)throw new Error('Native Git module nesting exceeds the capture bound');
  const fs=capture?.io??sourceFs;
  const {gitDir,commonDir,linked}=association;
  const assertTopology=async()=>{
    for(const name of ['MERGE_HEAD','REBASE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','BISECT_LOG','rebase-merge','rebase-apply','index.lock'])await absentGitPath(path.join(gitDir,name),fs);
    for(const name of ['info/grafts','objects/info/alternates','objects/info/http-alternates'])await absentGitPath(path.join(commonDir,name),fs);
    if(linked){
      await absentGitPath(path.join(gitDir,'config'),fs);
      await absentGitPath(path.join(gitDir,'packed-refs'),fs);
      // Unknown private storage/pseudorefs must not silently disappear from the review copy.
      const names=await fs.readdir(gitDir);if(names.length>20000)throw new Error('Selected Git storage inventory exceeds its bound');
      for(const name of names)if(!['gitdir','commondir','HEAD','ORIG_HEAD','FETCH_HEAD',...gitSelectedOriginalNames,'index','config.worktree','info','refs','logs','locked','reftable'].includes(name)&&!/^sharedindex\.[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(name))throw new Error('Unsupported selected Git storage or operation metadata; preserve source');
    }
  };
  const snapshot=async()=>{
    const current=association.moduleData?association:await gitAssociation(root,capture);if(!current||current.evidence!==association.evidence)throw new Error('Git association changed during capture');
    await assertTopology();
    const sparse=await captureSparseConfiguration(gitDir,commonDir,fs);
    const storage=sparse.configuration.filter(item=>!item.source&&item.key.toLowerCase()==='extensions.refstorage');
    if(storage.length>1||storage.some(item=>!['files','reftable'].includes(item.value)))throw new Error('Unsupported Git reference storage declaration');
    const raw=await captureGitRaw(association,storage[0]?.value==='reftable',fs);
    return {sparse,raw};
  };
  const initial=await snapshot();
  validateRelativeWorktrees(initial.sparse.configuration);
  const local=initial.sparse.configuration.filter(item=>!item.source);
  const declared=local.filter(item=>item.key.toLowerCase()==='extensions.objectformat');
  if(declared.length>1||declared.some(item=>!['sha1','sha256'].includes(item.value)))throw new Error('Unsupported Git object format declaration');
  const format: 'sha1'|'sha256'=declared[0]?.value==='sha256'?'sha256':'sha1';
  const versions=local.filter(item=>item.key.toLowerCase()==='core.repositoryformatversion');
  if(versions.length!==1||!['0','1'].includes(versions[0]!.value)||(declared.length>0||local.some(item=>item.key.toLowerCase()==='extensions.refstorage'))&&versions[0]!.value!=='1'||local.some(item=>/^extensions\./i.test(item.key)&&!['extensions.objectformat','extensions.worktreeconfig','extensions.relativeworktrees','extensions.refstorage'].includes(item.key.toLowerCase())))throw new Error('Unsupported Git repository format or extension');
  const before={...initial,storage:await captureIndexStorage(gitDir,format,fs)};
  validateGitShallowReview(before.raw.shallowReview,format);
  parseGitOrigHeadReview(before.raw.origHeadReview,format);
  parseGitFetchHeadReview(before.raw.fetchHeadReview,format);
  const stackOriginal=(prefix:string)=>{
    const list=before.raw.files.find(file=>file.name===prefix+'/tables.list');if(!list)return undefined;
    return {tablesListBase64:list.data.toString('base64'),tables:reftableNames(list.data).map(name=>({name,dataBase64:before.raw.files.find(file=>file.name===prefix+'/'+name)!.data.toString('base64')}))};
  };
  const sharedStack=stackOriginal('reftable'),selectedStack=stackOriginal('selected-reftable');
  const reftableReview:ReviewedGitUserData['reftableReview']=sharedStack?{source:'common_repository',...sharedStack,...(selectedStack?{selectedWorktree:selectedStack}:{})}:null;
  const reftable=reftableReview?decodeReftableReview(reftableReview,format):undefined;
  const captured=await readCapturedGit(before.raw.files,format,reftable),batch=captured.batch;
  const objects:GitObject[]=[];let offset=0;
  while(offset<batch.length){
    const end=batch.indexOf(10,offset);if(end<0)throw new Error('Truncated Git object header');
    const match=/^([a-f0-9]+) (blob|tree|commit|tag) ([0-9]+)$/.exec(text(batch.subarray(offset,end)));
    if(!match)throw new Error('Invalid Git object header');
    const size=Number(match[3]);offset=end+1;
    if(!Number.isSafeInteger(size)||size>limit||offset+size>=batch.length||batch[offset+size]!==10)throw new Error('Truncated Git object original');
    objects.push({oid:match[1]!,type:match[2] as GitObject['type'],dataBase64:batch.subarray(offset,offset+size).toString('base64')});offset+=size+1;
  }
  const after={...await snapshot(),storage:await captureIndexStorage(gitDir,format,fs)};
  if(before.raw.evidence!==after.raw.evidence||JSON.stringify(before.sparse)!==JSON.stringify(after.sparse)||!before.storage.originals.equals(after.storage.originals)||JSON.stringify(before.storage.logical)!==JSON.stringify(after.storage.logical)||JSON.stringify(before.storage.resolveUndo)!==JSON.stringify(after.storage.resolveUndo))throw new Error('Git selection changed during capture; preserve source and retry');
  const finalAssociation=association.moduleData?association:await gitAssociation(root,capture);if(!finalAssociation||finalAssociation.evidence!==association.evidence)throw new Error('Git association changed after capture');
  if(capture){await capture.verify();if(!association.moduleData)capture.record(root,association.evidence);}
  const originalIndex:IndexEntry[]=before.storage.logical;
  const sparseSnapshot=before.sparse;
  const sparseReview:ReviewedGitUserData['sparseReview']={patternsBase64:sparseSnapshot.patternsBase64,directories:originalIndex.filter(entry=>entry.mode==='40000')};
  const headText=text(captured.head).trim();
  const head:ReviewedGitUserData['head']=headText.startsWith('refs/')?{symbolic:headText}:{oid:headText};
  const exclusions=['Excluded: derived local commit-graph, multi-pack-index and server-info advertisements (info/refs, objects/info/packs); rebuild from verified objects/refs if needed','Excluded: derived Git index UNTR/FSMN caches; rebuild local observations if needed','Excluded: Git credentials, external include contents, configured hook targets beyond default common hooks and source worktree ownership',...(linked?['Linked-worktree selection excludes main/other worktrees private state and normalizes selected/shared originals into one inactive standalone review repository']:[]),'Reserved index flags, unknown mandatory extensions and operation-in-progress metadata refuse; pinned Git does not produce combined on-disk split/sparse indexes; supported storage normalizes to a full review index'];
  const configurationReview:ReviewedGitUserData['configurationReview']=[];
  for(const item of before.sparse.configuration){
    const {key,value}=item;
    if(excludedGitKey(key)){exclusions.push('Git configuration entry excluded: credential or source ownership');continue;}
    try{safeText(`${key}=${value}`,'Git configuration');if(/:\/\/[^/]*@/.test(value))throw new Error('URL userinfo');configurationReview.push(item);}catch{
      if(sparseKey(key))throw new Error('Required sparse configuration contains recognizable credentials; preserve source');
      exclusions.push('Git configuration entry excluded: recognizable credential or URL userinfo');
    }
  }
  const configurationOriginalReview:ReviewedGitUserData['configurationOriginalReview']=[];
  for(const name of ['config','config.worktree'] as const){
    const original=before.sparse.originals.find(item=>item.name===name),source=name==='config'?'common_repository' as const:'selected_worktree' as const;
    if(!original){configurationOriginalReview.push({path:name,source,dataBase64:null,removedFields:false});continue;}
    const parsed=configSource(Buffer.from(original.data,'base64'),name==='config'?undefined:name);
    const native=before.sparse.configuration.filter(item=>name==='config'?!item.source:item.source===name);
    if(JSON.stringify(parsed.items)!==JSON.stringify(native))throw new Error('Git source-span parser differs from pinned native config inventory');
    configurationOriginalReview.push({path:name,source,dataBase64:parsed.safe.toString('base64'),removedFields:parsed.removedFields});
  }
  const packRetentionReview:ReviewedGitUserData['packRetentionReview']=[];
  for(const file of before.raw.files.filter(file=>/^objects\/pack\/pack-[a-f0-9]+\.(?:keep|mtimes)$/.test(file.name))){
    const stem=file.name.replace(/\.[^.]+$/,''),packOid=stem.slice('objects/pack/pack-'.length);
    if(packRetentionReview.some(record=>record.packOid===packOid))continue;
    const find=(suffix:string)=>before.raw.files.find(item=>item.name===stem+suffix)?.data;
    const pack=find('.pack'),idx=find('.idx');
    if(!pack||!idx)throw new Error('Pack retention requires complete pack/index originals');
    const width=format==='sha1'?20:32,entries=decodeRetentionPackIndex(idx,format,pack.subarray(-width)),count=entries.length,mtimes=find('.mtimes');
    if(mtimes&&mtimes.length!==12+count*4+2*width)throw new Error('Unsupported pack retention timestamp layout');
    packRetentionReview.push({packOid,packDataBase64:pack.toString('base64'),indexDataBase64:idx.toString('base64'),keepDataBase64:find('.keep')?.toString('base64')??null,mtimesDataBase64:mtimes?.toString('base64')??null,objects:entries.map((entry,i)=>({oid:entry.oid,mtime:mtimes?mtimes.readUInt32BE(12+i*4):null}))});
  }
  packRetentionReview.sort((a,b)=>a.packOid<b.packOid?-1:a.packOid>b.packOid?1:0);
  const reflogEvidence={bytes:0,entries:0,missing:new Set<string>()},objectInventory=new Map(objects.map(object=>[object.oid,object]));
  for(const file of before.raw.files.filter(file=>file.name.startsWith('logs/')))validateGitReflogData(file.data.toString('base64'),format,objectInventory,reflogEvidence);
  if(reftable)for(const log of reftable.logs)for(const oid of [log.old,log.next])if(oid&&!/^0+$/.test(oid)&&!objectInventory.has(oid))reflogEvidence.missing.add(oid);
  const result:ReviewedGitUserData={version:1,format,configurationSourceDirectories:{common:commonDir,private:gitDir,home:homedir()},reftableReview,objects,reflogMissingObjects:[...reflogEvidence.missing].sort(),indexOptionalReview:before.storage.indexOptionalReview,packRetentionReview,reflogs:before.raw.files.filter(file=>file.name.startsWith('logs/')&&file.name!=='logs/ORIG_HEAD').map(file=>({path:file.name.slice(5),dataBase64:file.data.toString('base64')})),refs:reftable?reftable.refs:text(captured.refs).split('\n').filter(Boolean).map(row=>{const [name,oid,symbolic]=row.split('\0');return {name:name!,oid:oid!,...(symbolic?{symbolic}:{})};}),head,index:originalIndex.filter(entry=>entry.mode!=='40000'),resolveUndo:before.storage.resolveUndo,sparseReview,infoReview:before.raw.infoReview,shallowReview:before.raw.shallowReview,origHeadReview:before.raw.origHeadReview,fetchHeadReview:before.raw.fetchHeadReview,configurationReview,configurationOriginalReview,exclusions};
  // Verify every captured object and graph before deriving any missing logical index entries.
  const directories=sparseReview.directories;
  validateReviewedGit({...result,sparseReview:{...sparseReview,directories:[]}});
  result.index.push(...expandSparseDirectories(directories,new Map(objects.map(object=>[object.oid,object])),format));
  result.index.sort(indexOrder);validateReviewedGit(result);
  // Drafts are selected-worktree data even when gitDir and commonDir coincide.
  const gitOriginals=before.raw.files.filter(file=>gitReviewOriginal('.git/'+file.name)&&file.source===(gitSelectedOriginalNames.includes(file.name)?'selected':'shared')).map(file=>({path:'.git/'+file.name,dataBase64:file.data.toString('base64'),removedSecretFields:false,...(file.metadata?{metadata:file.metadata}:{})}));
  const moduleSources=await captureModuleSources(root,association,fs,capture,result.index);
  result.modules=[];
  if(moduleSources.modules.length){
    for(const module of moduleSources.modules){
      const child=await captureReviewedGit(module.source.worktreePath,{root:association.root,gitDir:module.source.storagePath,commonDir:module.source.storagePath,linked:false,moduleData:true,evidence:module.evidence},capture,depth+1);
      result.modules.push({name:module.name,source:module.source,worktreeRelativePath:module.worktreeRelativePath,git:child.git,originals:child.gitOriginals});
    }
    validateReviewedGit(result,depth);
  }
  if((await captureModuleSources(root,association,fs,capture,result.index)).evidence!==moduleSources.evidence)throw new Error('Native module inventory changed during capture');
  return {git:result,gitOriginals};
}

/** Recreate a separate review repository, never the native-owned destination .git. No Git command or hook runs. */
export async function recreateReviewedGit(destination:string,value:ReviewedGitUserData):Promise<void> {
  if(!selectedWorktreeReftable(value)){await writeReviewedGit(destination,value);return;}
  // A selected native stack cannot be flattened into loose files: reftable
  // names and logs belong to their original common/private backends.
  validateReviewedGit(value);
  if(!path.isAbsolute(destination)||path.resolve(destination)!==destination||await fs.realpath(path.dirname(destination))!==path.dirname(destination))throw new Error('Choose a new canonical Git review destination');
  await fs.mkdir(destination,{mode:0o700});
  const commonDir=path.join(destination,'.ponderosa-review-git');
  await fs.mkdir(commonDir,{mode:0o700});
  await writeReviewedGit(destination,value,undefined,{commonDir,privateDir:path.join(commonDir,'worktrees','selected'),writeCommon:true},true);
}

async function writeReviewedGit(destination:string,value:ReviewedGitUserData,native?:ReviewedUserData,layout?:{commonDir:string;privateDir:string;writeCommon:boolean},recovery=false,configuration?:NativeReviewedGitConfiguration,storage?:NativeReviewedGitStorage):Promise<Array<{path:string;sha256:string;device:bigint;inode:bigint}>> {
  validateReviewedGit(value);
  if(native&&!configuration)throw new Error('Native Git requires its validated configuration plan');
  if(!path.isAbsolute(destination)||path.resolve(destination)!==destination||await fs.realpath(path.dirname(destination))!==path.dirname(destination))throw new Error('Choose a new canonical Git review destination');
  if(native||recovery){if(await fs.realpath(destination)!==destination||!recovery&&(await fs.readdir(destination)).length)throw new Error('Git recreation requires its freshly owned canonical destination');}else await fs.mkdir(destination,{mode:0o700});
  const gitDir=layout?.commonDir??storage?.gitDir??path.join(destination,'.git');
  if(layout){
    if(!recovery||!native&&(!selectedWorktreeReftable(value)||gitDir!==path.join(destination,'.ponderosa-review-git')||layout.privateDir!==path.join(gitDir,'worktrees','selected')||!layout.writeCommon)||!path.isAbsolute(gitDir)||path.resolve(gitDir)!==gitDir||path.dirname(layout.privateDir)!==path.join(gitDir,'worktrees')||await fs.realpath(gitDir)!==gitDir)throw new Error('Mapped Git requires its freshly owned canonical common directory and private worktree slot');
  }else if(!storage?.existingRoot)await fs.mkdir(gitDir,{mode:0o700});
  else if(!recovery||await fs.realpath(gitDir)!==gitDir||!(await fs.lstat(gitDir)).isDirectory())throw new Error('Mapped module storage requires its exact fresh selected destination root');
  if(!layout||layout.writeCommon){await fs.mkdir(path.join(gitDir,'objects'),{mode:0o700});await fs.mkdir(path.join(gitDir,'refs'),{mode:0o700});}
  if(layout){
    if(layout.writeCommon)await fs.mkdir(path.join(gitDir,'worktrees'),{mode:0o700});
    await fs.mkdir(layout.privateDir,{mode:0o700});
  }
  const created:Array<{path:string;sha256:string;device:bigint;inode:bigint}>=[];
  const directories=new Map<string,{device:bigint;inode:bigint}>();
  for(const target of [destination,gitDir,path.join(gitDir,'objects'),path.join(gitDir,'refs'),...(layout?[path.join(gitDir,'worktrees'),layout.privateDir]:[])]){const stat=await fs.lstat(target,{bigint:true});directories.set(target,{device:stat.dev,inode:stat.ino});}
  const checkDirectories=async()=>{for(const [target,identity] of directories){const stat=await fs.lstat(target,{bigint:true});if(!stat.isDirectory()||stat.dev!==identity.device||stat.ino!==identity.inode||await fs.realpath(target)!==target)throw new Error('Git destination directory identity changed');}};
  const write=async(relative:string,data:Buffer|string,metadata?:{mode:number;mtimeNs:string},common=false,forcePrivate=false)=>{
    const privateName=forcePrivate||!common&&(relative==='HEAD'||relative==='index'||relative==='commondir'||relative==='gitdir'||relative==='config.worktree'||relative==='info/sparse-checkout'||relative==='ORIG_HEAD'||relative==='FETCH_HEAD'||relative==='logs/HEAD'||relative==='logs/ORIG_HEAD'||gitSelectedOriginalNames.includes(relative)||privateRef(relative.startsWith('logs/')?relative.slice(5):relative));
    if(layout){if(!privateName&&!layout.writeCommon)return;if(privateName)relative=path.relative(gitDir,layout.privateDir).split(path.sep).join('/')+'/'+relative;}
    await checkDirectories();const target=path.join(gitDir,relative);let parent=gitDir;
    for(const part of relative.split('/').slice(0,-1)){
      parent=path.join(parent,part);if(directories.has(parent))continue;
      await fs.mkdir(parent,{mode:0o700});const stat=await fs.lstat(parent,{bigint:true});
      if(!stat.isDirectory()||await fs.realpath(parent)!==parent)throw new Error('Git destination parent changed');directories.set(parent,{device:stat.dev,inode:stat.ino});
    }
    await checkDirectories();const handle=await fs.open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{const stat=await handle.stat({bigint:true});if(!stat.isFile()||stat.nlink!==1n)throw new Error('Git destination file is not exclusive');await handle.writeFile(data);if(metadata){const observed=applyExactFileMetadata({fd:handle.fd,expectedDevice:stat.dev,expectedInode:stat.ino,kind:'file',mode:metadata.mode,mtimeNs:BigInt(metadata.mtimeNs)});if(observed.mode!==metadata.mode||observed.mtimeNs!==BigInt(metadata.mtimeNs))throw new Error('Git original metadata differs after application');}await handle.sync();created.push({path:relative,sha256:createHash('sha256').update(data).digest('hex'),device:stat.dev,inode:stat.ino});}finally{await handle.close();}
  };
  try{
    for(const object of value.objects){const data=Buffer.from(object.dataBase64,'base64');await write(`objects/${object.oid.slice(0,2)}/${object.oid.slice(2)}`,deflateSync(Buffer.concat([Buffer.from(`${object.type} ${data.length}\0`),data])));}
    if(value.shallowReview.dataBase64!==null)await write('shallow',Buffer.from(value.shallowReview.dataBase64,'base64'));
    for(const log of value.reflogs)await write(`logs/${log.path}`,Buffer.from(log.dataBase64,'base64'));
    if(!value.reftableReview)for(const ref of value.refs)await write(ref.name,ref.symbolic?`ref: ${ref.symbolic}\n`:`${ref.oid}\n`);
    if(value.reftableReview){
      await write('reftable/tables.list',Buffer.from(value.reftableReview.tablesListBase64,'base64'),undefined,true);
      for(const table of value.reftableReview.tables)await write('reftable/'+table.name,Buffer.from(table.dataBase64,'base64'),undefined,true);
      const selected=selectedWorktreeReftable(value);
      if(selected){
        if(!layout)throw new Error('Selected-worktree reftable requires distinct common/private destination storage');
        await write('reftable/tables.list',Buffer.from(selected.tablesListBase64,'base64'),undefined,false,true);
        for(const table of selected.tables)await write('reftable/'+table.name,Buffer.from(table.dataBase64,'base64'),undefined,false,true);
      }
    }
    await write('HEAD','symbolic' in value.head?`ref: ${value.head.symbolic}\n`:`${value.head.oid}\n`);
    if(layout&&!native)await write('HEAD','ref: refs/heads/.invalid\n',undefined,true);
    else if(layout)await write('HEAD','symbolic' in value.head?`ref: ${value.head.symbolic}\n`:`${value.head.oid}\n`,undefined,true);
    if(native)await write('config',Buffer.concat([configuration!.common,Buffer.from(layout?'\n[core]\n\trepositoryformatversion = 1\n\tbare = true\n[extensions]\n\tworktreeConfig = true\n':storage?`\n[core]\n\tbare = false\n\tworktree = ${JSON.stringify(storage.worktreePath)}\n`:'')]));else
    await write('config','[core]\n\trepositoryformatversion = '+(value.reftableReview||value.format==='sha256'||layout?1:0)+'\n\tbare = '+(layout?'true':'false')+'\n\thooksPath = /dev/null\n\tfsmonitor = false\n'+(value.reftableReview||value.format==='sha256'||layout?'[extensions]\n':'')+(value.format==='sha256'?'\tobjectFormat = sha256\n':'')+(value.reftableReview?'\trefStorage = reftable\n':'')+(layout?'\tworktreeConfig = true\n':''));
    if(layout&&!native)await write('config.worktree','[core]\n\tbare = false\n\tworktree = '+JSON.stringify(destination)+'\n');
    if(native){
      const worktreeConfig=configuration!.private;
      if(layout||worktreeConfig!==null)await write('config.worktree',Buffer.concat([worktreeConfig??Buffer.alloc(0),Buffer.from(layout?`\n[core]\n\tbare = false\n\tworktree = ${JSON.stringify(destination)}\n`:'')]));
      if(value.sparseReview.patternsBase64!==null)await write('info/sparse-checkout',Buffer.from(value.sparseReview.patternsBase64,'base64'));
      for(const info of value.infoReview)if(info.dataBase64!==null)await write(info.path,Buffer.from(info.dataBase64,'base64'));
      if(value.origHeadReview.dataBase64!==null)await write('ORIG_HEAD',Buffer.from(value.origHeadReview.dataBase64,'base64'));
      if(value.origHeadReview.reflogDataBase64!==null)await write('logs/ORIG_HEAD',Buffer.from(value.origHeadReview.reflogDataBase64,'base64'));
      if(value.fetchHeadReview.dataBase64!==null)await write('FETCH_HEAD',Buffer.from(value.fetchHeadReview.dataBase64,'base64'));
      for(const pack of value.packRetentionReview){
        const stem='objects/pack/pack-'+pack.packOid;
        await write(stem+'.pack',Buffer.from(pack.packDataBase64,'base64'));await write(stem+'.idx',Buffer.from(pack.indexDataBase64,'base64'));
        if(pack.keepDataBase64!==null)await write(stem+'.keep',Buffer.from(pack.keepDataBase64,'base64'));
        if(pack.mtimesDataBase64!==null)await write(stem+'.mtimes',Buffer.from(pack.mtimesDataBase64,'base64'));
      }
      for(const file of native.providerFiles.filter(file=>gitReviewOriginal(file.path)))await write(file.path.slice(5),Buffer.from(file.dataBase64,'base64'),file.metadata);
      for(const file of configuration!.includeFiles??[])await write(file.path,file.data,undefined,!file.private,!!file.private);
    }
    const entries:Buffer[]=[];
    const extendedIndex=value.index.some(entry=>entry.intentToAdd||entry.skipWorktree);
    for(const entry of [...value.index].sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path))||a.stage-b.stage)){
      const name=Buffer.from(entry.path),fixed=Buffer.alloc(40);fixed.writeUInt32BE(parseInt(entry.mode,8),24);
      const extended=entry.intentToAdd||entry.skipWorktree;
      const flags=Buffer.alloc(2);flags.writeUInt16BE((entry.assumeUnchanged?0x8000:0)|(extended?0x4000:0)|(entry.stage<<12)|Math.min(name.length,0xfff));
      const extra=Buffer.alloc(extended?2:0);if(extended)extra.writeUInt16BE((entry.intentToAdd?0x2000:0)|(entry.skipWorktree?0x4000:0));
      const body=Buffer.concat([fixed,Buffer.from(entry.oid,'hex'),flags,extra,name,Buffer.from([0])]);
      entries.push(Buffer.concat([body,Buffer.alloc((8-body.length%8)%8)]));
    }
    const header=Buffer.alloc(12);header.write('DIRC');header.writeUInt32BE(extendedIndex?3:2,4);header.writeUInt32BE(entries.length,8);
    const undo=encodeResolveUndo(value.resolveUndo,value.format),extension=Buffer.alloc(undo.length?8:0);
    if(undo.length){extension.write('REUC');extension.writeUInt32BE(undo.length,4);}
    const index=Buffer.concat([header,...entries,extension,undo]);await write('index',Buffer.concat([index,createHash(value.format).update(index).digest()]));
    if(layout){
      await write('commondir',path.relative(layout.privateDir,gitDir).split(path.sep).join('/')+'\n');
      await write('gitdir',path.relative(layout.privateDir,path.join(destination,'.git')).split(path.sep).join('/')+'\n');
      const pointer=path.join(destination,'.git'),pointerData=Buffer.from('gitdir: '+path.relative(destination,layout.privateDir).split(path.sep).join('/')+'\n');
      const handle=await fs.open(pointer,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{const before=await handle.stat({bigint:true});await handle.writeFile(pointerData);await handle.sync();const current=await fs.lstat(pointer,{bigint:true});if(!current.isFile()||current.nlink!==1n||current.dev!==before.dev||current.ino!==before.ino)throw new Error('Mapped Git worktree pointer changed');}finally{await handle.close();}
    }
    if(native&&(!layout||layout.writeCommon))for(const module of configuration!.modules??[]){
      const relative=path.relative(gitDir,module.gitDir);
      if(!relative||path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))throw new Error('Native module storage escapes its selected parent repository');
      let parent=gitDir;
      for(const component of relative.split(path.sep).slice(0,-1)){
        parent=path.join(parent,component);
        if(!directories.has(parent)){await fs.mkdir(parent,{mode:0o700});const stat=await fs.lstat(parent,{bigint:true});if(!stat.isDirectory()||await fs.realpath(parent)!==parent)throw new Error('Native module storage parent changed');directories.set(parent,{device:stat.dev,inode:stat.ino});}
      }
      await checkDirectories();
      validateNativeGitSelection(module.value);
      const children=await writeReviewedGit(destination,module.value.git!,module.value,undefined,true,module.configuration,{gitDir:module.gitDir,worktreePath:module.worktreePath,initialized:module.initialized});
      const moduleStat=await fs.lstat(module.gitDir,{bigint:true});if(!moduleStat.isDirectory()||await fs.realpath(module.gitDir)!==module.gitDir)throw new Error('Created module storage identity changed');directories.set(module.gitDir,{device:moduleStat.dev,inode:moduleStat.ino});
      for(const file of children)created.push({...file,path:path.relative(gitDir,module.gitDir).split(path.sep).join('/')+'/'+file.path});
    }
    if(storage?.initialized){
        const root=await fs.open(storage.worktreePath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);
        try{
          const before=await root.stat({bigint:true});if(!before.isDirectory()||await fs.realpath(storage.worktreePath)!==storage.worktreePath)throw new Error('Initialized module worktree destination changed');
          const pointer=path.join(storage.worktreePath,'.git'),handle=await fs.open(pointer,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
          try{await handle.writeFile('gitdir: '+path.relative(storage.worktreePath,gitDir).split(path.sep).join('/')+'\n');await handle.sync();}finally{await handle.close();}
          const current=await fs.lstat(storage.worktreePath,{bigint:true});if(current.dev!==before.dev||current.ino!==before.ino)throw new Error('Initialized module worktree membership changed');await root.sync();
        }finally{await root.close();}
    }
    if(!native&&value.modules?.length){
      const parent=path.join(destination,'MODULES-REVIEW');await fs.mkdir(parent,{mode:0o700});
      for(const module of value.modules){
        let target=parent;const parts=module.name.split('/');
        for(const part of parts.slice(0,-1)){target=path.join(target,part);try{await fs.mkdir(target,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}if(await fs.realpath(target)!==target)throw new Error('Module review parent changed');}
        await recreateReviewedGit(path.join(target,parts.at(-1)!),module.git);
      }
    }
    if(!native)await fs.writeFile(path.join(destination,'CONFIGURATION-REVIEW.json'),JSON.stringify({activation:'inert_review_only',reftableReview:value.reftableReview,configuration:value.configurationReview,configurationOriginalReview:value.configurationOriginalReview,reflogMissingObjects:value.reflogMissingObjects,indexOptionalReview:value.indexOptionalReview,sparseReview:value.sparseReview,infoReview:value.infoReview,shallowReview:value.shallowReview,origHeadReview:value.origHeadReview,fetchHeadReview:value.fetchHeadReview,packRetentionReview:value.packRetentionReview,modules:value.modules??[],exclusions:value.exclusions},null,2),{flag:'wx',mode:0o600});
    await checkDirectories();
    for(const file of created){const target=path.join(gitDir,file.path),{data}=await regularOriginal(target,limit),stat=await fs.lstat(target,{bigint:true});if(stat.dev!==file.device||stat.ino!==file.inode||createHash('sha256').update(data).digest('hex')!==file.sha256)throw new Error('Created Git data changed; preserve partial state');}
    for(const target of directories.keys()){const handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);try{await handle.sync();}finally{await handle.close();}}
    return created;
  }catch(error){throw Object.assign(new Error(`Git recreation incomplete; preserve all bytes at ${destination}: ${redactPortableDiagnostic((error as Error).message??String(error))}`,{cause:error}),{code:(error as {code?:string}).code??'ERR_GIT_RECREATION_PARTIAL',partialStatePossible:true,observed:(error as {observed?:unknown}).observed??null});}
}

/** Only configuration families, never provider sessions, login databases, caches or ownership receipts. */
export async function exportReviewedUserData(root:string,selection:ReviewedUserDataSelection,capture?:GitExportCapture,rootMappings?:ReadonlyMap<string,string>,capturedInventory?:import('./portable-working-files.js').WorkingFolderInventory):Promise<ReviewedUserData> {
  validateReviewedUserDataSelection(selection);
  if(selection.source==='retained_originals')throw new Error('Retained originals require their canonical artifact binding');
  const result:ReviewedUserData={version:1,activation:'inert_review_only',selection:{git:selection.git,harness:selection.harness,...(selection.extendedMetadata?{extendedMetadata:selection.extendedMetadata}:{}),...(selection.persistentNodes?{persistentNodes:selection.persistentNodes}:{})},recreationScope:{...recreationScope},providerFiles:[],providerDirectories:[],exclusions:[]};let bytes=0;
  const fixed=['.mcp.json','.claude/settings.json','.claude/settings.local.json','.claude/CLAUDE.md','.claude/AGENTS.md','.codex/config.toml','.codex/instructions.md'],selected=[...fixed];
  const capturedProvider=new Map<string,string>(),absentProvider=new Set<string>();
  let entries=0,outputStyleOwner:bigint|undefined,opaqueOwner:bigint|undefined;
  const walk=async(relative:string,opaque=false,optional=false):Promise<void>=>{
    const target=path.join(root,relative);
    let stat;try{stat=await fs.lstat(target,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&optional){absentProvider.add(relative);return;}throw error;}
    if(!stat.isDirectory()||await fs.realpath(target)!==target)throw new Error('Custom provider configuration must have canonical directory parents');
    result.providerDirectories.push({path:relative,mode:Number(stat.mode)&0o7777,mtimeNs:stat.mtimeNs.toString()});
    if(result.providerDirectories.length>1000)throw new Error('Provider topology exceeds its bound');
    capturedProvider.set(relative,originalIdentity(stat));
    if(opaque){
      opaqueOwner??=(await fs.lstat(root,{bigint:true})).uid;
      if(stat.uid!==opaqueOwner)throw new Error('Opaque provider directory owner differs from the selected root');
    }
    if(relative==='.claude/output-styles'){
      outputStyleOwner=(await fs.lstat(root,{bigint:true})).uid;
      if(stat.uid!==outputStyleOwner)throw new Error('Output-style directory owner differs from the selected root');
    }
    for(const entry of (await fs.readdir(target,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      if(++entries>1000)throw new Error('Custom provider configuration inventory exceeds 1000 entries');
      const name=`${relative}/${entry.name}`;
      if(opaque&&(!opaqueProviderOriginal(name,entry.isDirectory())||claudeNamedRoots.includes(relative)&&!entry.isDirectory()))throw new Error('Opaque provider originals require contained regular text files; memory and skills also require named directories');
      if(relative==='.claude/output-styles'&&(!entry.isFile()||!claudeOutputStyle(name)||name.includes('\\')||credentialPath(name)))throw new Error('Output styles require top-level regular noncredential Markdown originals');
      if(relative==='.codex/agents'&&(!entry.isFile()||!codexReviewToml(name)||name.includes('\\')||credentialPath(name)))throw new Error('Custom Codex agents require top-level regular noncredential TOML originals');
      if(entry.isDirectory())await walk(name,opaque);else if(entry.isFile())selected.push(name);else throw new Error('Custom provider configuration links/special nodes require separate recreation');
    }
    const after=await fs.lstat(target,{bigint:true});if(stat.ino!==after.ino||stat.mtimeNs!==after.mtimeNs||stat.ctimeNs!==after.ctimeNs)throw new Error('Custom provider configuration inventory changed');
  };
  // Observe selected family-parent metadata without enumerating session/profile contents.
  for(const relative of selection.harness?['.claude','.codex']:[]){
    const target=path.join(root,relative);let stat;
    try{stat=await fs.lstat(target,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){absentProvider.add(relative);continue;}throw error;}
    if(!stat.isDirectory()||stat.uid!==(await fs.lstat(root,{bigint:true})).uid||await fs.realpath(target)!==target)throw new Error('Provider family parent must be canonical and same-owner');
    capturedProvider.set(relative,originalIdentity(stat));result.providerDirectories.push({path:relative,mode:Number(stat.mode)&0o7777,mtimeNs:stat.mtimeNs.toString()});
  }
  for(const directory of (selection.harness?providerDirectoryRoots:[]))await walk(directory,directory!=='.codex/agents'&&directory!=='.claude/output-styles',true);
  for(const relative of selection.harness?selected:[]){
    const target=path.join(root,relative);
    if(opaqueProviderOriginal(relative))opaqueOwner??=(await fs.lstat(root,{bigint:true})).uid;
    if(fixed.includes(relative))try{await fs.lstat(target);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){absentProvider.add(relative);continue;}throw error;}
    if(result.providerDirectories.length+result.providerFiles.length>=1000)throw new Error('Provider topology exceeds its bound');
    const originalFile=await regularOriginal(target,1024*1024,opaqueProviderOriginal(relative)?opaqueOwner:claudeOutputStyle(relative)?outputStyleOwner:undefined);
    capturedProvider.set(relative,originalFile.identity);
    const metadata={mode:originalFile.mode,mtimeNs:originalFile.mtimeNs};
    if(providerSupportOriginal(relative)){
      inspectProviderSupportOriginal(originalFile.data);
      bytes+=originalFile.data.length;if(bytes>limit)throw new Error('Provider configuration bound exceeded');
      result.providerFiles.push({path:relative,dataBase64:originalFile.data.toString('base64'),removedSecretFields:false,metadata});
      continue;
    }
    {
      const {data}=originalFile;
      const original=codexReviewToml(relative)||claudeOutputStyle(relative)||opaqueProviderOriginal(relative)?new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data):text(data);let safe=original,removedSecretFields=false;
      if(providerJsonSettings(relative)){const parsed=JSON.parse(original),scrubbed=withoutPortableSecrets(parsed);removedSecretFields=JSON.stringify(parsed)!==JSON.stringify(scrubbed);safe=JSON.stringify(scrubbed,null,2);}
      else if(codexReviewToml(relative)){
        ({safe,removedSecretFields}=scrubReviewToml(original));
      }
      safeText(safe,'Provider configuration');bytes+=Buffer.byteLength(safe);if(bytes>limit)throw new Error('Provider configuration bound exceeded');
      result.providerFiles.push({path:relative,dataBase64:Buffer.from(safe).toString('base64'),removedSecretFields,metadata});
    }
  }
  if(selection.git){
    const captured=await exportReviewedGit(root,capture);
    if(captured){
      result.git=captured.git;
      for(const original of captured.gitOriginals){
        bytes+=Buffer.from(original.dataBase64,'base64').length;
        if(result.providerFiles.length+result.providerDirectories.length>=1000||bytes>limit)throw new Error('Combined review originals exceed their bound');
        result.providerFiles.push(original);
      }
    }
  }
  if(selection.git&&!result.git)throw new Error('Selected Git data is unavailable in this working root');
  if(capture&&selection.git){
    const worktreeRef=capture.bindings.find(binding=>binding.worktreePath===root)?.worktreeRootRef;
    if(worktreeRef)result.associationReview=capture.portableBindings(false).filter(binding=>binding.worktreeRootRef===worktreeRef);
  }
  for(const [relative,identity] of capturedProvider){
    const target=path.join(root,relative),current=await fs.lstat(target,{bigint:true});
    if(originalIdentity(current)!==identity||await fs.realpath(path.dirname(target))!==path.dirname(target))throw new Error('Provider original changed after capture');
  }
  for(const relative of absentProvider){
    try{await fs.lstat(path.join(root,relative));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    throw new Error('Absent provider selection appeared during capture');
  }
  if(selection.extendedMetadata||selection.persistentNodes){
    result.filesystemMetadata=await captureFilesystemMetadata(root,selection,rootMappings,capture,capturedInventory);
    result.exclusions.push('Filesystem metadata covers selected user attributes and Linux POSIX ACLs only; hidden namespaces and coherent independent-writer snapshots are not claimed');
  }
  result.exclusions.push('Exported provider originals are inert evidence; native installation requires a separate reviewed activation choice, and export never grants execution','Other provider files and custom formats require explicit inventory; sessions/auth/profile ownership remain excluded');
  return result;
}


/** Only the original manifest is authoritative; generated review repositories are never read. */
export async function captureRetainedReviewOriginal(root:string,selection:ReviewedUserDataSelection,original:Buffer):Promise<{data:Buffer;verify:()=>Promise<void>}> {
  validateReviewedUserDataSelection(selection);
  if(selection.source!=='retained_originals')throw new Error('Retained originals require explicit source selection');
  const manifest=parseReviewedUserData(original);
  if(manifest.selection.git!==selection.git||manifest.selection.harness!==selection.harness||JSON.stringify(manifest.selection.extendedMetadata)!==JSON.stringify(selection.extendedMetadata)||JSON.stringify(manifest.selection.persistentNodes)!==JSON.stringify(selection.persistentNodes))throw new Error('Select exactly the retained original families; partial, expanded or mixed source export is unsupported');
  const folder=path.join(root,'.ponderosa-portable-review'),target=path.join(root,REVIEWED_USER_DATA_PATH);
  const directory=await fs.lstat(folder,{bigint:true});
  if(!directory.isDirectory()||await fs.realpath(folder)!==folder)throw new Error('Retained review directory must be canonical');
  const names=await fs.readdir(folder);
  if(names.length>3||names.some(name=>!['user-data.json','git-repository','provider-files'].includes(name)))throw new Error('Unknown retained review namespace contents require separate preservation');
  const before=await fs.lstat(target,{bigint:true}),captured=await regularOriginal(target,48*1024*1024);
  const verify=async()=>{
    const currentDirectory=await fs.lstat(folder,{bigint:true}),current=await fs.lstat(target,{bigint:true});
    if(originalIdentity(directory)!==originalIdentity(currentDirectory)||originalIdentity(before)!==originalIdentity(current)||await fs.realpath(folder)!==folder)throw new Error('Retained review original changed');
    const reread=await regularOriginal(target,48*1024*1024);
    if(!reread.data.equals(original))throw new Error('Retained review original differs from its canonical artifact');
  };
  if(!captured.data.equals(original))throw new Error('Retained review original differs from its canonical artifact');
  await verify();return {data:captured.data,verify};
}
