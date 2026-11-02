import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {promises as fs} from '@ponderosa/native-host/fs';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import type {ReviewedGitUserData,ReviewedUserData,ReviewedUserDataSelection} from '@ponderosa/core';
import {assertPortableSecretsAbsent,isPortableSecretField,redactPortableDiagnostic,withoutPortableSecrets} from './portable-secrets.js';

export const REVIEWED_USER_DATA_PATH='.ponderosa-portable-review/user-data.json';
const limit=32*1024*1024;
const recreationScope={absoluteLinks:'refuse',crossRootLinks:'refuse',cyclicLinks:'refuse',specialNodes:'refuse',acl:'not_inspected_preserve_source',xattrs:'not_inspected_preserve_source'} as const;

function fields(value:unknown,required:readonly string[],optional:readonly string[]=[]):void {
  if(!value||typeof value!=='object'||Array.isArray(value)||required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>![...required,...optional].includes(key)))throw new Error('Unexpected or missing reviewed user-data fields');
}
export function validateReviewedUserDataSelection(value:unknown):asserts value is ReviewedUserDataSelection {
  fields(value,['git','harness']);
  const selection=value as ReviewedUserDataSelection;
  if(typeof selection.git!=='boolean'||typeof selection.harness!=='boolean'||!selection.git&&!selection.harness)throw new Error('Select Git data, harness settings, or both');
}
function providerPath(value:string):boolean {
  return ['.mcp.json','.claude/settings.json','.claude/settings.local.json','.claude/CLAUDE.md','.codex/config.toml','.codex/instructions.md'].includes(value)||/^\.(?:claude\/(?:commands|agents|skills|rules)|codex\/(?:skills|rules))\//.test(value);
}
function credentialPath(value:string):boolean {
  return value.split('/').some(part=>['.ssh','.aws','.gnupg','browser-profiles'].includes(part.toLowerCase())||/^\.env(?:\.|$)/i.test(part)||/^(?:credentials(?:\.json)?|auth\.json|.*\.(?:pem|key|p12))$/i.test(part));
}

type GitObject=ReviewedGitUserData['objects'][number];

/** Read-only plumbing: no hooks, filters, textconv, network, optional locks or inherited Git overrides. */
function git(root:string,args:string[],input?:Buffer):Promise<Buffer> {
  return new Promise((resolve,reject)=>{
    const env:NodeJS.ProcessEnv={PATH:process.env.PATH,LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'};
    const child=execFile('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.untrackedCache=false','-C',root,...args],{env,encoding:'buffer',maxBuffer:limit,timeout:30000},(error,stdout,stderr)=>error||stderr.length?reject(new Error('Portable Git read failed or warned; repository retained unchanged')):resolve(stdout));
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
function assertSupportedReviewToml(value:string):void {
  if(/'''|"""/.test(value))throw new Error('Multiline provider TOML requires a structured format reader');
  for(const line of value.split('\n')){
    if(/^\s*(?:#|$)/.test(line))continue;
    // This bounded reader cannot safely inspect nested assignments or decode escaped keys.
    if(line.includes('{')||/^\s*["'][^=]*\\/.test(line)||/^\s*(?:"[^"\\]*"|'[^']*'|[A-Za-z0-9_-]+)\s*\./.test(line))throw new Error('Dotted keys, inline tables or escaped TOML keys require a structured format reader');
    if(/^\s*\[/.test(line)){
      if(/["'\\]/.test(line))throw new Error('Quoted or escaped TOML table paths require a structured format reader');
      const table=/^\s*(\[\[?)\s*([A-Za-z0-9_-]+(?:\s*\.\s*[A-Za-z0-9_-]+)*)\s*(\]\]?)\s*(?:#.*)?$/.exec(line);
      if(!table||table[1]!.length!==table[3]!.length)throw new Error('Unsupported or incomplete TOML table header requires a structured format reader');
      if(table[2]!.split('.').some(part=>isPortableSecretField(part.trim())))throw new Error('Credential TOML tables require a structured format reader');
    }
  }
}
async function regularOriginal(target:string):Promise<{data:Buffer;mode:number}> {
  if(await fs.realpath(path.dirname(target))!==path.dirname(target))throw new Error('Reviewed original parent is not canonical');
  const observed=await fs.lstat(target,{bigint:true});
  if(!observed.isFile()||observed.nlink!==1n||observed.size>1024n*1024n)throw new Error('Reviewed data requires a bounded regular original');
  const handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const before=await handle.stat({bigint:true});
    if(!before.isFile()||before.nlink!==1n||before.dev!==observed.dev||before.ino!==observed.ino||before.size>1024n*1024n)throw new Error('Reviewed original changed before reading');
    const data=Buffer.alloc(Number(before.size));let offset=0;
    while(offset<data.length){const read=await handle.read(data,offset,data.length-offset,offset);if(!read.bytesRead)throw new Error('Reviewed original shortened');offset+=read.bytesRead;}
    const after=await handle.stat({bigint:true}),current=await fs.lstat(target,{bigint:true});
    if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||current.dev!==after.dev||current.ino!==after.ino||current.nlink!==1n)throw new Error('Reviewed original changed during reading');
    return {data,mode:Number(before.mode)&0o777};
  }finally{await handle.close();}
}
function refName(value:string):string {
  if(!/^refs\/(?:[^\x00-\x20~^:?*\[\\]+)$/.test(value)||value.includes('..')||value.includes('@{')||value.split('/').some(part=>!part||part.startsWith('.')||part.endsWith('.')||part.endsWith('.lock')))throw new Error('Invalid portable Git ref');
  return value;
}
function indexPath(value:string):string {
  if(!value||value.startsWith('/')||value.includes('\\')||value.includes('\0')||value.split('/').some(part=>!part||part==='.'||part==='..'||part.toLowerCase()==='.git'))throw new Error('Invalid portable Git index path');
  return value;
}
function excludedGitKey(key:string):boolean {
  return /password|token|secret|extraheader|authorization|^core\.worktree$/i.test(key)||/credential/i.test(key);
}

export function parseReviewedUserData(data:Buffer):ReviewedUserData {
  if(data.length>48*1024*1024)throw new Error('Reviewed user-data manifest exceeds its bound');
  const value=JSON.parse(text(data)) as ReviewedUserData;
  fields(value,['version','activation','selection','recreationScope','providerFiles','exclusions'],['git']);
  if(!value||value.version!==1||value.activation!=='inert_review_only'||!Array.isArray(value.providerFiles)||value.providerFiles.length>1000||!Array.isArray(value.exclusions)||value.exclusions.some(item=>typeof item!=='string'))throw new Error('Invalid reviewed user-data manifest');
  validateReviewedUserDataSelection(value.selection);
  if(Object.hasOwn(value,'git')&&!value.git)throw new Error('Invalid selected Git data');
  if(!value.selection.git&&value.git||!value.selection.harness&&value.providerFiles.length||value.selection.git&&!value.git)throw new Error('Reviewed data differs from its explicit family selection');
  if(!value.recreationScope||Object.keys(value.recreationScope).length!==Object.keys(recreationScope).length||Object.entries(recreationScope).some(([key,status])=>(value.recreationScope as Record<string,string>)[key]!==status))throw new Error('Required recreation semantics cannot be silently downgraded');
  const paths=new Set<string>();let bytes=0;
  for(const file of value.providerFiles){
    fields(file,['path','dataBase64','removedSecretFields']);
    if(typeof file.path!=='string'||!providerPath(file.path)||file.path.split('/').some(part=>!part||part==='.'||part==='..')||credentialPath(file.path)||file.path.includes('\\')||file.path.includes('\0')||typeof file.dataBase64!=='string'||typeof file.removedSecretFields!=='boolean'||paths.has(file.path))throw new Error('Invalid reviewed provider original');
    const data=Buffer.from(file.dataBase64,'base64');bytes+=data.length;
    if(data.length>1024*1024||bytes>limit||data.toString('base64')!==file.dataBase64)throw new Error('Reviewed provider original exceeds its bound');
    if(file.path==='.codex/config.toml')assertSupportedReviewToml(text(data));
    safeText(text(data),'Reviewed provider configuration');
    if(file.path.endsWith('.json'))assertPortableSecretsAbsent(JSON.parse(text(data)),'Reviewed provider configuration');
    paths.add(file.path);
  }
  if(value.git)validateReviewedGit(value.git);
  return value;
}

function reflogPath(value:string):void {
  if(typeof value!=='string'||value.length>1024)throw new Error('Invalid Git reflog path');
  if(value!=='HEAD')refName(value);
}

/** Read only private normal local logs; exact bytes and per-file order remain unchanged. */
async function captureReflogs(gitDir:string):Promise<ReviewedGitUserData['reflogs']> {
  const result:ReviewedGitUserData['reflogs']=[];let nodes=0,bytes=0;
  const walk=async(relative:string):Promise<void>=>{
    const target=path.join(gitDir,'logs',relative);
    let before;try{before=await fs.lstat(target,{bigint:true});}catch(error){if(!relative&&(error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    if(++nodes>10000||await fs.realpath(target)!==target)throw new Error('Git reflog inventory is external or exceeds its bound');
    if(before.isDirectory()){
      if(relative&&relative!=='refs'&&!relative.startsWith('refs/'))throw new Error('Unsupported Git reflog directory');
      for(const name of (await fs.readdir(target)).sort())await walk(relative?`${relative}/${name}`:name);
      const after=await fs.lstat(target,{bigint:true});
      if(before.dev!==after.dev||before.ino!==after.ino||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new Error('Git reflog directory changed during capture');
    }else{
      reflogPath(relative);
      const {data}=await regularOriginal(target);bytes+=data.length;
      if(bytes>limit)throw new Error('Git reflog bytes exceed their bound');
      result.push({path:relative,dataBase64:data.toString('base64')});
    }
  };
  await walk('');return result;
}

export function validateReviewedGit(value:ReviewedGitUserData):void {
  fields(value,['version','format','objects','refs','head','index','reflogs','configurationReview','sparseReview','exclusions']);
  if(value.version!==1||!['sha1','sha256'].includes(value.format)||!Array.isArray(value.objects)||value.objects.length>10000||!Array.isArray(value.refs)||value.refs.length>10000||!Array.isArray(value.index)||value.index.length>10000||!Array.isArray(value.configurationReview)||value.configurationReview.length>10000||!Array.isArray(value.exclusions)||value.exclusions.some(item=>typeof item!=='string'))throw new Error('Invalid bounded Git user-data manifest');
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
  if(!Array.isArray(value.reflogs)||value.reflogs.length>10000)throw new Error('Invalid bounded Git reflogs');
  const logPaths=new Set<string>(),logDirectories=new Set(['']);let logBytes=0,logEntries=0;
  for(const log of value.reflogs){
    fields(log,['path','dataBase64']);reflogPath(log.path);
    if(logPaths.has(log.path)||typeof log.dataBase64!=='string'||log.dataBase64.length>Math.ceil(1024*1024/3)*4)throw new Error('Invalid or duplicate Git reflog');
    logPaths.add(log.path);
    const parts=log.path.split('/');
    for(let i=1;i<parts.length;i++)logDirectories.add(parts.slice(0,i).join('/'));
    if(logPaths.size+logDirectories.size>10000)throw new Error('Git reflog inventory exceeds its bound');
    const raw=Buffer.from(log.dataBase64,'base64');logBytes+=raw.length;
    if(raw.length>1024*1024||logBytes>limit||raw.toString('base64')!==log.dataBase64)throw new Error('Git reflog byte bound or encoding mismatch');
    const original=text(raw);safeText(original,'Git reflog');
    if(original&&!original.endsWith('\n'))throw new Error('Incomplete Git reflog entry');
    for(const line of original?original.slice(0,-1).split('\n'):[]){
      if(++logEntries>10000)throw new Error('Git reflog entry count exceeds its bound');
      const entry=/^([a-f0-9]+) ([a-f0-9]+) ([^<>\x00-\x1f\x7f]+) <([^<>\x00-\x20\x7f]+)> ([0-9]{1,16}) ([+-][0-9]{4})\t([^\x00-\x1f\x7f]*)$/.exec(line);
      if(!entry||!oidPattern.test(entry[1]!)||!oidPattern.test(entry[2]!)||Number(entry[6]!.slice(1,3))>23||Number(entry[6]!.slice(3))>59)throw new Error('Unsupported Git reflog entry; preserve source');
      const zero='0'.repeat(value.format==='sha1'?40:64);
      if(entry[1]===zero&&entry[2]===zero)throw new Error('Git reflog has no object endpoint');
      for(const oid of [entry[1]!,entry[2]!])if(oid!==zero&&!ids.has(oid))throw new Error('Git reflog original object is missing; preserve source');
    }
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
      const links=header.split('\n').filter(line=>/^(?:tree|parent|object) /.test(line));
      if(object.type==='commit'&&!links.some(line=>line.startsWith('tree '))||object.type==='tag'&&!links.some(line=>line.startsWith('object ')))throw new Error('Git graph header lacks original');
      for(const line of links){const [kind,oid]=line.split(' ');requireObject(oid!,kind==='tree'?'tree':kind==='parent'?'commit':undefined);}
    }
  }
  const refs=new Set<string>();
  for(const ref of value.refs){fields(ref,['name','oid'],['symbolic']);refName(ref.name);if(refs.has(ref.name)||!ids.has(ref.oid))throw new Error('Missing or duplicate Git ref original');refs.add(ref.name);if(Object.hasOwn(ref,'symbolic'))refName(ref.symbolic!);}
  for(const ref of value.refs){
    let target=ref;const seen=new Set<string>();
    while(target.symbolic){if(seen.has(target.name))throw new Error('Cyclic Git symbolic ref');seen.add(target.name);const next=value.refs.find(candidate=>candidate.name===target.symbolic);if(!next||next.oid!==ref.oid)throw new Error('Incomplete Git symbolic ref target');target=next;}
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
  for(const item of value.configurationReview){fields(item,['key','value'],['implicitBoolean','source']);if(item.source!==undefined&&item.source!=='config.worktree')throw new Error('Invalid reviewed Git configuration source');if(typeof item.key!=='string'||typeof item.value!=='string'||item.implicitBoolean!==undefined&&(item.implicitBoolean!==true||item.value!=='')||excludedGitKey(item.key)||/:\/\/[^/]*@/.test(item.value))throw new Error('Invalid reviewed Git configuration');safeText(`${item.key}=${item.value}`,'Git configuration');}
  validateSparseReview(value,ids);
}

type IndexEntry=ReviewedGitUserData['index'][number];
function indexOrder(a:IndexEntry,b:IndexEntry):number{return Buffer.compare(Buffer.from(a.path),Buffer.from(b.path))||a.stage-b.stage;}

function sparseKey(key:string):boolean {return /^(?:core\.sparsecheckout(?:cone)?|index\.sparse|extensions\.(?:sparseindex|worktreeconfig))$/i.test(key);}

/** Raw snapshots are private comparison evidence; only nonsecret parsed settings enter the package. */
async function captureSparseConfiguration(gitDir:string,root:string) {
  const originals:Array<{name:string;identity:string;data:string}>=[];
  const configuration:ReviewedGitUserData['configurationReview']=[];
  let patternsBase64:string|null=null;
  const info=path.join(gitDir,'info');
  try{const stat=await fs.lstat(info);if(!stat.isDirectory()||await fs.realpath(info)!==info)throw new Error('Sparse pattern parent is not a canonical local directory');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  for(const name of ['config','config.worktree','info/sparse-checkout']){
    const target=path.join(gitDir,name);
    let before;try{before=await fs.lstat(target,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    const {data}=await regularOriginal(target),after=await fs.lstat(target,{bigint:true});
    const identity=(stat:typeof before)=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
    if(identity(before)!==identity(after))throw new Error('Local Git sparse/config original changed');
    originals.push({name,identity:identity(after),data:data.toString('base64')});
    if(name==='info/sparse-checkout'){patternsBase64=data.toString('base64');continue;}
    const parsed=text(await git(root,['config','--file','-','--null','--list','--no-includes'],data));
    if(parsed&&!parsed.endsWith('\0'))throw new Error('Incomplete local Git configuration inventory');
    for(const row of parsed?parsed.slice(0,-1).split('\0'):[]){
      if(configuration.length>=10000)throw new Error('Local Git configuration exceeds its bound');
      const split=row.indexOf('\n'),key=split<0?row:row.slice(0,split),value=split<0?'':row.slice(split+1);
      // Repository-aware plumbing must never resolve an include outside this exact local authority.
      if(/^(?:include|includeif)\./i.test(key))throw new Error('Git configuration includes require separate scoped capture');
      configuration.push({key,value,...(split<0?{implicitBoolean:true as const}:{}),...(name==='config.worktree'?{source:'config.worktree' as const}:{})});
    }
  }
  return {originals,configuration,patternsBase64};
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
  const boolean=(items:typeof local,key:string):boolean|undefined=>{
    let result:boolean|undefined;
    for(const item of items.filter(item=>item.key.toLowerCase()===key)){
      if(item.implicitBoolean)result=true;
      else if(/^(?:true|yes|on|1)$/i.test(item.value))result=true;
      else if(/^(?:false|no|off|0|)$/i.test(item.value))result=false;
      else throw new Error('Unsupported sparse Git configuration boolean');
    }
    return result;
  };
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
function decodeIndex(data:Buffer,format:'sha1'|'sha256'):{entries:IndexEntry[];link?:Buffer;sparse?:true} {
  const width=format==='sha1'?20:32,end=data.length-width;
  if(end<12||data.toString('latin1',0,4)!=='DIRC'||!createHash(format).update(data.subarray(0,end)).digest().equals(data.subarray(end)))throw new Error('Invalid Git index header/checksum');
  const version=data.readUInt32BE(4),count=data.readUInt32BE(8);
  if(![2,3,4].includes(version)||count>10000)throw new Error('Only bounded v2/v3/v4 Git index storage is supported');
  const entries:IndexEntry[]=[];let offset=12,decodedBytes=0;let previous:Buffer=Buffer.alloc(0);
  for(let i=0;i<count;i++){
    const start=offset;
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
  let link:Buffer|undefined;const seen=new Set<string>();
  while(offset<end){
    if(offset+8>end)throw new Error('Truncated Git index extension');
    const signature=data.toString('latin1',offset,offset+4),size=data.readUInt32BE(offset+4);offset+=8;
    if(size>end-offset||seen.has(signature))throw new Error('Invalid or duplicate Git index extension');seen.add(signature);
    const body=data.subarray(offset,offset+size);offset+=size;
    if(signature==='link'){link=body;continue;}
    if(signature==='sdir'){if(body.length)throw new Error('Unsupported sparse-index extension payload');continue;}
    if(signature!=='TREE')throw new Error('Unknown or unsupported Git index extension; preserve source');
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
  return {entries,...(link?{link}:{}),...(seen.has('sdir')?{sparse:true as const}:{})};
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

async function captureIndexStorage(gitDir:string,format:'sha1'|'sha256'):Promise<{originals:Buffer;logical:IndexEntry[]}> {
  const originals:Array<{name:string;identity:string;data:string}>=[];
  const read=async(name:string)=>{
    const target=path.join(gitDir,name),before=await fs.lstat(target,{bigint:true}),{data}=await regularOriginal(target),after=await fs.lstat(target,{bigint:true});
    const identity=(stat:typeof before)=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
    if(identity(before)!==identity(after))throw new Error('Git index storage changed during capture');
    originals.push({name,identity:identity(after),data:data.toString('base64')});return data;
  };
  let data:Buffer;
  try{await fs.lstat(path.join(gitDir,'index'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {originals:Buffer.from('[]'),logical:[]};throw error;}
  data=await read('index');
  const decoded=decodeIndex(data,format);
  const ordered=(entries:IndexEntry[])=>{for(let i=0;i<entries.length;i++)if(!entries[i]!.path||i>0&&indexOrder(entries[i-1]!,entries[i]!)>=0)throw new Error('Invalid Git index path/stage ordering');};
  if(!decoded.link){ordered(decoded.entries);return {originals:Buffer.from(JSON.stringify(originals)),logical:decoded.entries};}
  const width=format==='sha1'?20:32,link=decoded.link;
  if(link.length<width)throw new Error('Truncated split-index link');
  const oid=link.subarray(0,width).toString('hex');let base:IndexEntry[]=[];
  if(!/^0+$/.test(oid)){
    const shared=await read(`sharedindex.${oid}`);
    if(!shared.subarray(shared.length-width).equals(link.subarray(0,width)))throw new Error('Shared Git index identity differs');
    const parsed=decodeIndex(shared,format);if(parsed.link||parsed.sparse)throw new Error('Nested shared or sparse split Git index refused');base=parsed.entries;
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
  return {originals:Buffer.from(JSON.stringify(originals)),logical};
}

/** Bounded immutable originals with observed-change refusal; this does not drain independent writers. */
export async function exportReviewedGit(root:string):Promise<ReviewedGitUserData|undefined> {
  let stat;try{stat=await fs.lstat(path.join(root,'.git'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
  if(!stat.isDirectory()||await fs.realpath(path.join(root,'.git'))!==path.join(root,'.git'))throw new Error('Linked/external Git ownership requires a scoped repository reader; preserve source instead of exporting unrelated common objects');
  try{await fs.lstat(path.join(root,'.git','objects','info','alternates'));throw new Error('External Git alternates require explicit scoped recreation');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const gitDir=path.join(root,'.git');
  for(const name of ['commondir','gitdir','shallow','MERGE_HEAD','REBASE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','BISECT_LOG','rebase-merge','rebase-apply','index.lock']){
    try{await fs.lstat(path.join(gitDir,name));throw new Error('Selected Git repository has unsupported shared/shallow/in-progress metadata; preserve source');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  let controlEntries=0;
  const inspectControl=async(target:string):Promise<void>=>{
    let current;try{current=await fs.lstat(target);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    if(++controlEntries>20000||await fs.realpath(target)!==target)throw new Error('Git control inventory is external or exceeds its bound');
    if(current.isDirectory()){for(const name of await fs.readdir(target))await inspectControl(path.join(target,name));}
    else if(!current.isFile()||current.nlink!==1)throw new Error('Git control data is not a private regular original');
  };
  for(const name of ['HEAD','config','config.worktree','info/sparse-checkout','index','packed-refs','refs'])await inspectControl(path.join(gitDir,name));
  let objectEntries=0;
  const inspectObjects=async(directory:string):Promise<void>=>{
    if(await fs.realpath(directory)!==directory)throw new Error('External Git object directory refused');
    for(const name of await fs.readdir(directory)){
      if(++objectEntries>10000)throw new Error('Git object-file inventory exceeds its bound');
      const target=path.join(directory,name),stat=await fs.lstat(target);
      if(stat.isDirectory())await inspectObjects(target);else if(!stat.isFile())throw new Error('External Git object symlink or special file requires scoped recreation');
    }
  };
  await inspectObjects(path.join(root,'.git','objects'));
  // Parse only captured local bytes, with includes disabled, before repository-aware plumbing.
  await captureSparseConfiguration(gitDir,root);
  const format=text(await git(root,['rev-parse','--show-object-format'])).trim();
  if(format!=='sha1'&&format!=='sha256')throw new Error('Unsupported Git object format');
  const snapshot=async()=>{
    try{await fs.lstat(path.join(gitDir,'index.lock'));throw new Error('Git index is locked; preserve source');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const sparse=await captureSparseConfiguration(gitDir,root);
    const storage=await captureIndexStorage(gitDir,format);
    const refs=await git(root,['for-each-ref','--format=%(refname)%00%(objectname)%00%(symref)']);
    let head:Buffer;
    try{head=await git(root,['symbolic-ref','-q','HEAD']);}catch{head=await git(root,['rev-parse','--verify','HEAD']);}
    const index=Buffer.from(JSON.stringify(storage.logical));
    const config=Buffer.from(JSON.stringify(sparse.configuration));
    const reflogs=Buffer.from(JSON.stringify(await captureReflogs(gitDir)));
    return {refs,head,index,config,reflogs,storage:storage.originals,sparse:Buffer.from(JSON.stringify(sparse))};
  };
  const before=await snapshot(),batch=await git(root,['cat-file','--batch-all-objects','--batch']);
  const objects:GitObject[]=[];let offset=0;
  while(offset<batch.length){
    const end=batch.indexOf(10,offset);if(end<0)throw new Error('Truncated Git object header');
    const match=/^([a-f0-9]+) (blob|tree|commit|tag) ([0-9]+)$/.exec(text(batch.subarray(offset,end)));
    if(!match)throw new Error('Invalid Git object header');
    const size=Number(match[3]);offset=end+1;
    if(!Number.isSafeInteger(size)||size>limit||offset+size>=batch.length||batch[offset+size]!==10)throw new Error('Truncated Git object original');
    objects.push({oid:match[1]!,type:match[2] as GitObject['type'],dataBase64:batch.subarray(offset,offset+size).toString('base64')});offset+=size+1;
  }
  const after=await snapshot();
  for(const key of ['refs','head','index','config','reflogs','storage','sparse'] as const)if(!before[key].equals(after[key]))throw new Error('Git selection changed during capture; preserve source and retry');
  const originalIndex:IndexEntry[]=JSON.parse(text(before.index));
  const sparseSnapshot=JSON.parse(text(before.sparse)) as Awaited<ReturnType<typeof captureSparseConfiguration>>;
  const sparseReview:ReviewedGitUserData['sparseReview']={patternsBase64:sparseSnapshot.patternsBase64,directories:originalIndex.filter(entry=>entry.mode==='40000')};
  if(!batch.equals(await git(root,['cat-file','--batch-all-objects','--batch'])))throw new Error('Git object inventory changed during capture');
  const headText=text(before.head).trim();
  const head:ReviewedGitUserData['head']=headText.startsWith('refs/')?{symbolic:headText}:{oid:headText};
  const exclusions=['Excluded: Git credentials, external include contents, all Git hook files and source worktree ownership','Unsupported index flags/extensions, combined split/sparse storage and operation-in-progress metadata need separate recreation; supported storage normalizes to a full review index'];
  const configurationReview:ReviewedGitUserData['configurationReview']=[];
  for(const item of JSON.parse(text(before.config)) as ReviewedGitUserData['configurationReview']){
    const {key,value}=item;
    if(excludedGitKey(key)){exclusions.push('Git configuration entry excluded: credential or source ownership');continue;}
    try{safeText(`${key}=${value}`,'Git configuration');if(/:\/\/[^/]*@/.test(value))throw new Error('URL userinfo');configurationReview.push(item);}catch{
      if(sparseKey(key))throw new Error('Required sparse configuration contains recognizable credentials; preserve source');
      exclusions.push('Git configuration entry excluded: recognizable credential or URL userinfo');
    }
  }
  const result:ReviewedGitUserData={version:1,format,objects,reflogs:JSON.parse(text(before.reflogs)),refs:text(before.refs).split('\n').filter(Boolean).map(row=>{const [name,oid,symbolic]=row.split('\0');return {name:name!,oid:oid!,...(symbolic?{symbolic}:{})};}),head,index:originalIndex.filter(entry=>entry.mode!=='40000'),sparseReview,configurationReview,exclusions};
  const final=await fs.lstat(gitDir);if(final.dev!==stat.dev||final.ino!==stat.ino||await fs.realpath(gitDir)!==gitDir)throw new Error('Selected Git ownership directory changed');
  // Verify every captured object and graph before deriving any missing logical index entries.
  const directories=sparseReview.directories;
  validateReviewedGit({...result,sparseReview:{...sparseReview,directories:[]}});
  result.index.push(...expandSparseDirectories(directories,new Map(objects.map(object=>[object.oid,object])),format));
  result.index.sort(indexOrder);validateReviewedGit(result);return result;
}

/** Recreate a separate review repository, never the native-owned destination .git. No Git command or hook runs. */
export async function recreateReviewedGit(destination:string,value:ReviewedGitUserData):Promise<void> {
  validateReviewedGit(value);
  if(!path.isAbsolute(destination)||path.resolve(destination)!==destination||await fs.realpath(path.dirname(destination))!==path.dirname(destination))throw new Error('Choose a new canonical Git review destination');
  await fs.mkdir(destination,{mode:0o700});
  const gitDir=path.join(destination,'.git');await fs.mkdir(gitDir,{mode:0o700});
  await fs.mkdir(path.join(gitDir,'objects'),{mode:0o700});await fs.mkdir(path.join(gitDir,'refs'),{mode:0o700});
  const write=async(relative:string,data:Buffer|string)=>{const target=path.join(gitDir,relative);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.writeFile(target,data,{flag:'wx',mode:0o600});};
  try{
    for(const object of value.objects){const data=Buffer.from(object.dataBase64,'base64');await write(`objects/${object.oid.slice(0,2)}/${object.oid.slice(2)}`,deflateSync(Buffer.concat([Buffer.from(`${object.type} ${data.length}\0`),data])));}
    for(const log of value.reflogs)await write(`logs/${log.path}`,Buffer.from(log.dataBase64,'base64'));
    for(const ref of value.refs)await write(ref.name,ref.symbolic?`ref: ${ref.symbolic}\n`:`${ref.oid}\n`);
    await write('HEAD','symbolic' in value.head?`ref: ${value.head.symbolic}\n`:`${value.head.oid}\n`);
    await write('config',`[core]\n\trepositoryformatversion = ${value.format==='sha256'?1:0}\n\tbare = false\n\thooksPath = /dev/null\n\tfsmonitor = false\n${value.format==='sha256'?'[extensions]\n\tobjectFormat = sha256\n':''}`);
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
    const index=Buffer.concat([header,...entries]);await write('index',Buffer.concat([index,createHash(value.format).update(index).digest()]));
    await fs.writeFile(path.join(destination,'CONFIGURATION-REVIEW.json'),JSON.stringify({activation:'inert_review_only',configuration:value.configurationReview,sparseReview:value.sparseReview,exclusions:value.exclusions},null,2),{flag:'wx',mode:0o600});
  }catch(error){throw new Error(`Git recreation incomplete; preserve all bytes at ${destination}`,{cause:error});}
}

/** Only configuration families, never provider sessions, login databases, caches or ownership receipts. */
export async function exportReviewedUserData(root:string,selection:ReviewedUserDataSelection):Promise<ReviewedUserData> {
  validateReviewedUserDataSelection(selection);
  const result:ReviewedUserData={version:1,activation:'inert_review_only',selection:{...selection},recreationScope:{...recreationScope},providerFiles:[],exclusions:[]};let bytes=0;
  const selected=['.mcp.json','.claude/settings.json','.claude/settings.local.json','.claude/CLAUDE.md','.codex/config.toml','.codex/instructions.md'];
  let entries=0;
  const walk=async(relative:string):Promise<void>=>{
    const target=path.join(root,relative);
    let stat;try{stat=await fs.lstat(target,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    if(!stat.isDirectory()||await fs.realpath(target)!==target)throw new Error('Custom provider configuration must have canonical directory parents');
    for(const entry of (await fs.readdir(target,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      if(++entries>1000)throw new Error('Custom provider configuration inventory exceeds 1000 entries');
      const name=`${relative}/${entry.name}`;
      if(entry.isDirectory())await walk(name);else if(entry.isFile())selected.push(name);else throw new Error('Custom provider configuration links/special nodes require separate recreation');
    }
    const after=await fs.lstat(target,{bigint:true});if(stat.ino!==after.ino||stat.mtimeNs!==after.mtimeNs||stat.ctimeNs!==after.ctimeNs)throw new Error('Custom provider configuration inventory changed');
  };
  for(const directory of (selection.harness?['.claude/commands','.claude/agents','.claude/skills','.claude/rules','.codex/skills','.codex/rules']:[]))await walk(directory);
  for(const relative of selection.harness?selected:[]){
    const target=path.join(root,relative);
    let originalFile;try{originalFile=await regularOriginal(target);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    {
      const {data}=originalFile;
      const original=text(data);let safe=original,removedSecretFields=false;
      if(relative.endsWith('.json')){const parsed=JSON.parse(original),scrubbed=withoutPortableSecrets(parsed);removedSecretFields=JSON.stringify(parsed)!==JSON.stringify(scrubbed);safe=JSON.stringify(scrubbed,null,2);}
      else if(relative==='.codex/config.toml'){
        assertSupportedReviewToml(original);
        safe=original.split('\n').filter(line=>{
          const key=/^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=/.exec(line);
          if(!key||!isPortableSecretField((key[1]??key[2]??key[3])!))return true;
          const scalar=line.slice(key[0].length).trim();
          if(!/^(?:"(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.test(scalar))throw new Error('Compound/multiline TOML credentials require a structured format reader');
          return false;
        }).join('\n');
        removedSecretFields=safe!==original;
      }
      safeText(safe,'Provider configuration');bytes+=Buffer.byteLength(safe);if(bytes>limit)throw new Error('Provider configuration bound exceeded');
      result.providerFiles.push({path:relative,dataBase64:Buffer.from(safe).toString('base64'),removedSecretFields});
    }
  }
  if(selection.git)result.git=await exportReviewedGit(root);
  if(selection.git&&!result.git)throw new Error('Selected Git data is unavailable in this working root');
  result.exclusions.push('Provider settings are inert review data: commands, hooks, MCP servers and permissions are never installed or executed','Other provider files and custom formats require explicit inventory; sessions/auth/profile ownership remain excluded');
  return result;
}
