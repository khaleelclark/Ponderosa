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
  return ['.claude/settings.json','.claude/settings.local.json','.claude/CLAUDE.md','.codex/config.toml','.codex/instructions.md'].includes(value)||/^\.(?:claude\/(?:commands|agents|skills)|codex\/(?:skills|rules))\//.test(value);
}
function credentialPath(value:string):boolean {
  return value.split('/').some(part=>['.ssh','.aws','.gnupg','browser-profiles'].includes(part.toLowerCase())||/^\.env(?:\.|$)/i.test(part)||/^(?:credentials(?:\.json)?|auth\.json|.*\.(?:pem|key|p12))$/i.test(part));
}

type GitObject=ReviewedGitUserData['objects'][number];

/** Read-only plumbing: no hooks, filters, textconv, network, optional locks or inherited Git overrides. */
function git(root:string,args:string[]):Promise<Buffer> {
  return new Promise((resolve,reject)=>{
    const env:NodeJS.ProcessEnv={PATH:process.env.PATH,LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'};
    execFile('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.untrackedCache=false','-C',root,...args],{env,encoding:'buffer',maxBuffer:limit,timeout:30000},(error,stdout,stderr)=>error||stderr.length?reject(new Error('Portable Git read failed or warned; repository retained unchanged')):resolve(stdout));
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
  return /password|token|secret|extraheader|authorization|^core\.worktree$|^extensions\.worktreeconfig$/i.test(key)||/credential/i.test(key);
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

export function validateReviewedGit(value:ReviewedGitUserData):void {
  fields(value,['version','format','objects','refs','head','index','configurationReview','exclusions']);
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
  for(const entry of value.index){fields(entry,['mode','oid','stage','path']);indexPath(entry.path);if(credentialPath(entry.path))throw new Error('Known credential path in selected Git index; preserve source');const key=`${entry.path}\0${entry.stage}`;if(entries.has(key)||!Number.isInteger(entry.stage)||entry.stage<0||entry.stage>3||!['100644','100755','120000','160000'].includes(entry.mode)||!oidPattern.test(entry.oid)||entry.mode!=='160000'&&ids.get(entry.oid)?.type!=='blob')throw new Error('Invalid staged Git original');entries.add(key);}
  for(const item of value.configurationReview){fields(item,['key','value'],['implicitBoolean']);if(typeof item.key!=='string'||typeof item.value!=='string'||item.implicitBoolean!==undefined&&(item.implicitBoolean!==true||item.value!=='')||excludedGitKey(item.key)||/:\/\/[^/]*@/.test(item.value))throw new Error('Invalid reviewed Git configuration');safeText(`${item.key}=${item.value}`,'Git configuration');}
}

/** Bounded immutable originals with observed-change refusal; this does not drain independent writers. */
export async function exportReviewedGit(root:string):Promise<ReviewedGitUserData|undefined> {
  let stat;try{stat=await fs.lstat(path.join(root,'.git'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
  if(!stat.isDirectory()||await fs.realpath(path.join(root,'.git'))!==path.join(root,'.git'))throw new Error('Linked/external Git ownership requires a scoped repository reader; preserve source instead of exporting unrelated common objects');
  try{await fs.lstat(path.join(root,'.git','objects','info','alternates'));throw new Error('External Git alternates require explicit scoped recreation');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const gitDir=path.join(root,'.git');
  for(const name of ['commondir','gitdir','shallow','MERGE_HEAD','REBASE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','BISECT_LOG','rebase-merge','rebase-apply','index.lock','config.worktree','info/sparse-checkout']){
    try{await fs.lstat(path.join(gitDir,name));throw new Error('Selected Git repository has unsupported shared/shallow/sparse/in-progress metadata; preserve source');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  if((await fs.readdir(gitDir)).some(name=>name.startsWith('sharedindex.')))throw new Error('Split Git index requires separate recreation');
  let controlEntries=0;
  const inspectControl=async(target:string):Promise<void>=>{
    let current;try{current=await fs.lstat(target);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    if(++controlEntries>20000||await fs.realpath(target)!==target)throw new Error('Git control inventory is external or exceeds its bound');
    if(current.isDirectory()){for(const name of await fs.readdir(target))await inspectControl(path.join(target,name));}
    else if(!current.isFile()||current.nlink!==1)throw new Error('Git control data is not a private regular original');
  };
  for(const name of ['HEAD','config','index','packed-refs','refs'])await inspectControl(path.join(gitDir,name));
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
  const format=text(await git(root,['rev-parse','--show-object-format'])).trim();
  if(format!=='sha1'&&format!=='sha256')throw new Error('Unsupported Git object format');
  const snapshot=async()=>{
    const refs=await git(root,['for-each-ref','--format=%(refname)%00%(objectname)%00%(symref)']);
    let head:Buffer;
    try{head=await git(root,['symbolic-ref','-q','HEAD']);}catch{head=await git(root,['rev-parse','--verify','HEAD']);}
    const index=await git(root,['ls-files','--stage','-z']);
    const flags=await git(root,['ls-files','-v','-z']);
    const debug=await git(root,['ls-files','--debug','-z']);
    const config=await git(root,['config','--local','--null','--list','--no-includes']);
    return {refs,head,index,flags,debug,config};
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
  for(const key of ['refs','head','index','flags','debug','config'] as const)if(!before[key].equals(after[key]))throw new Error('Git selection changed during capture; preserve source and retry');
  if(text(before.flags).split('\0').filter(Boolean).some(row=>!/^H |^M /.test(row)))throw new Error('Git index flags require separate recreation; source retained');
  const indexFlags=[...text(before.debug).matchAll(/\tflags: ([a-f0-9]+)\n/g)];
  if(indexFlags.length!==text(before.index).split('\0').filter(Boolean).length||indexFlags.some(match=>(parseInt(match[1]!,16)&~0x3000)!==0))throw new Error('Extended/intent-to-add index flags require separate recreation; source retained');
  if(!batch.equals(await git(root,['cat-file','--batch-all-objects','--batch'])))throw new Error('Git object inventory changed during capture');
  const headText=text(before.head).trim();
  const head:ReviewedGitUserData['head']=headText.startsWith('refs/')?{symbolic:headText}:{oid:headText};
  const exclusions=['Excluded: Git credentials, external include contents, all Git hook files and source worktree ownership','Reflogs, index flags/extensions, intent-to-add, sparse/split-index and operation-in-progress metadata need separate recreation'];
  const configurationReview:ReviewedGitUserData['configurationReview']=[];
  for(const row of text(before.config).split('\0').filter(Boolean)){
    const split=row.indexOf('\n');
    const key=split<0?row:row.slice(0,split),value=split<0?'':row.slice(split+1);
    if(excludedGitKey(key)){exclusions.push('Git configuration entry excluded: credential or source ownership');continue;}
    try{safeText(`${key}=${value}`,'Git configuration');if(/:\/\/[^/]*@/.test(value))throw new Error('URL userinfo');configurationReview.push({key,value,...(split<0?{implicitBoolean:true as const}:{})});}catch{exclusions.push('Git configuration entry excluded: recognizable credential or URL userinfo');}
  }
  const result:ReviewedGitUserData={version:1,format,objects,refs:text(before.refs).split('\n').filter(Boolean).map(row=>{const [name,oid,symbolic]=row.split('\0');return {name:name!,oid:oid!,...(symbolic?{symbolic}:{})};}),head,index:text(before.index).split('\0').filter(Boolean).map(row=>{const match=/^(100644|100755|120000|160000) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(row);if(!match)throw new Error('Unsupported staged index entry');return {mode:match[1]!,oid:match[2]!,stage:Number(match[3]),path:match[4]!};}),configurationReview,exclusions};
  const final=await fs.lstat(gitDir);if(final.dev!==stat.dev||final.ino!==stat.ino||await fs.realpath(gitDir)!==gitDir)throw new Error('Selected Git ownership directory changed');
  validateReviewedGit(result);return result;
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
    for(const ref of value.refs)await write(ref.name,ref.symbolic?`ref: ${ref.symbolic}\n`:`${ref.oid}\n`);
    await write('HEAD','symbolic' in value.head?`ref: ${value.head.symbolic}\n`:`${value.head.oid}\n`);
    await write('config',`[core]\n\trepositoryformatversion = ${value.format==='sha256'?1:0}\n\tbare = false\n\thooksPath = /dev/null\n\tfsmonitor = false\n${value.format==='sha256'?'[extensions]\n\tobjectFormat = sha256\n':''}`);
    const entries:Buffer[]=[];
    for(const entry of [...value.index].sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path))||a.stage-b.stage)){
      const name=Buffer.from(entry.path),fixed=Buffer.alloc(40);fixed.writeUInt32BE(parseInt(entry.mode,8),24);
      const flags=Buffer.alloc(2);flags.writeUInt16BE((entry.stage<<12)|Math.min(name.length,0xfff));
      const body=Buffer.concat([fixed,Buffer.from(entry.oid,'hex'),flags,name,Buffer.from([0])]);
      entries.push(Buffer.concat([body,Buffer.alloc((8-body.length%8)%8)]));
    }
    const header=Buffer.alloc(12);header.write('DIRC');header.writeUInt32BE(2,4);header.writeUInt32BE(entries.length,8);
    const index=Buffer.concat([header,...entries]);await write('index',Buffer.concat([index,createHash(value.format).update(index).digest()]));
    await fs.writeFile(path.join(destination,'CONFIGURATION-REVIEW.json'),JSON.stringify({activation:'inert_review_only',configuration:value.configurationReview,exclusions:value.exclusions},null,2),{flag:'wx',mode:0o600});
  }catch(error){throw new Error(`Git recreation incomplete; preserve all bytes at ${destination}`,{cause:error});}
}

/** Only configuration families, never provider sessions, login databases, caches or ownership receipts. */
export async function exportReviewedUserData(root:string,selection:ReviewedUserDataSelection):Promise<ReviewedUserData> {
  validateReviewedUserDataSelection(selection);
  const result:ReviewedUserData={version:1,activation:'inert_review_only',selection:{...selection},recreationScope:{...recreationScope},providerFiles:[],exclusions:[]};let bytes=0;
  const selected=['.claude/settings.json','.claude/settings.local.json','.claude/CLAUDE.md','.codex/config.toml','.codex/instructions.md'];
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
  for(const directory of (selection.harness?['.claude/commands','.claude/agents','.claude/skills','.codex/skills','.codex/rules']:[]))await walk(directory);
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
