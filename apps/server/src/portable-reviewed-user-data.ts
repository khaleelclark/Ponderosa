import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {promises as fs} from '@ponderosa/native-host/fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {deflateSync} from 'node:zlib';
import type {ReviewedGitUserData,ReviewedUserData,ReviewedUserDataSelection} from '@ponderosa/core';
import {assertPortableSecretsAbsent,isPortableSecretField,redactPortableDiagnostic,withoutPortableSecrets} from './portable-secrets.js';

export const REVIEWED_USER_DATA_PATH='.ponderosa-portable-review/user-data.json';
const limit=32*1024*1024;
const recreationScope={absoluteLinks:'refuse',crossRootLinks:'refuse',cyclicLinks:'passive_in_root',specialNodes:'refuse',acl:'not_inspected_preserve_source',xattrs:'not_inspected_preserve_source'} as const;

function fields(value:unknown,required:readonly string[],optional:readonly string[]=[]):void {
  if(!value||typeof value!=='object'||Array.isArray(value)||required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>![...required,...optional].includes(key)))throw new Error('Unexpected or missing reviewed user-data fields');
}
export function validateReviewedUserDataSelection(value:unknown):asserts value is ReviewedUserDataSelection {
  fields(value,['git','harness'],['source']);
  const selection=value as ReviewedUserDataSelection;
  if(selection.source!==undefined&&!['live','retained_originals'].includes(selection.source))throw new Error('Choose live or retained-original review data');
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
/** Bounded structured TOML subset; source spans survive unless their whole assignment is secret. */
function scrubReviewToml(value:string):{safe:string;removedSecretFields:boolean} {
  if(Buffer.byteLength(value)>1024*1024||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\r(?!\n)/.test(value))throw new Error('Invalid or oversized review TOML');
  let offset=0,kept=0,safe='',removedSecretFields=false,entries=0,namespaceNodes=0;
  type Namespace={kind:'implicit'|'explicit'|'dotted'|'value'|'array';children:Map<string,Namespace>;latest?:Namespace};
  const namespace=(kind:Namespace['kind']):Namespace=>{if(++namespaceNodes>10000)throw new Error('Review TOML namespace exceeds its bound');return {kind,children:new Map()};};
  const root=namespace('explicit');let scope=root,scopeDepth=0;
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
      offset++;horizontal();const members=namespace('explicit');
      if(value[offset]==='}'){offset++;return;}
      while(offset<value.length){
        const parts=keyPath();registerPath(members,parts,false);
        horizontal();if(value[offset++]!=='=')fail();horizontal();
        if(!discard&&parts.some(isPortableSecretField))throw new Error('Nested credential TOML fields require separate preservation; inline tables are not partially scrubbed');
        readValue(discard,depth+1);horizontal();
        if(value[offset]==='}'){offset++;return;}
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
    if(value[offset]==='#'||value[offset]==='\r'||value[offset]==='\n'||offset===value.length){endLine();continue;}
    if(value[offset]==='['){
      offset++;const array=value[offset]==='[';if(array)offset++;
      const parts=keyPath();if(value[offset++]!==']'||array&&value[offset++]!==']')fail();
      if(parts.some(isPortableSecretField))throw new Error('Credential TOML tables require separate preservation');
      scope=registerPath(root,parts,array?'array':'table');scopeDepth=parts.length;endLine();continue;
    }
    const parts=keyPath();if(scopeDepth+parts.length>64)fail();
    horizontal();if(value[offset++]!=='=')fail();horizontal();
    registerPath(scope,parts,false);
    const secret=parts.some(isPortableSecretField);readValue(secret);
    endLine();
    if(secret){safe+=value.slice(kept,start);kept=offset;removedSecretFields=true;}
  }
  safe+=value.slice(kept);return {safe,removedSecretFields};
}
async function regularOriginal(target:string,maxBytes=1024*1024,expectedOwner?:bigint):Promise<{data:Buffer;mode:number}> {
  if(await fs.realpath(path.dirname(target))!==path.dirname(target))throw new Error('Reviewed original parent is not canonical');
  const observed=await fs.lstat(target,{bigint:true});
  if(!observed.isFile()||observed.nlink!==1n||observed.size>BigInt(maxBytes)||expectedOwner!==undefined&&observed.uid!==expectedOwner)throw new Error('Reviewed data requires a bounded regular original');
  const handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const before=await handle.stat({bigint:true});
    if(!before.isFile()||before.nlink!==1n||before.dev!==observed.dev||before.ino!==observed.ino||before.size>BigInt(maxBytes)||expectedOwner!==undefined&&before.uid!==expectedOwner)throw new Error('Reviewed original changed before reading');
    const data=Buffer.alloc(Number(before.size));let offset=0;
    while(offset<data.length){const read=await handle.read(data,offset,data.length-offset,offset);if(!read.bytesRead)throw new Error('Reviewed original shortened');offset+=read.bytesRead;}
    const after=await handle.stat({bigint:true}),current=await fs.lstat(target,{bigint:true});
    if(before.uid!==after.uid||current.uid!==after.uid||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||current.dev!==after.dev||current.ino!==after.ino||current.nlink!==1n)throw new Error('Reviewed original changed during reading');
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
  fields(value.selection,['git','harness']);
  validateReviewedUserDataSelection(value.selection);
  if(Object.hasOwn(value,'git')&&!value.git)throw new Error('Invalid selected Git data');
  if(!value.selection.git&&value.git||!value.selection.harness&&value.providerFiles.length||value.selection.git&&!value.git)throw new Error('Reviewed data differs from its explicit family selection');
  if(!value.recreationScope||Object.keys(value.recreationScope).length!==Object.keys(recreationScope).length||Object.entries(recreationScope).some(([key,status])=>(key==='cyclicLinks'? !['refuse','passive_in_root'].includes(value.recreationScope.cyclicLinks):(value.recreationScope as Record<string,string>)[key]!==status)))throw new Error('Required recreation semantics cannot be silently downgraded');
  const paths=new Set<string>();let bytes=0;
  for(const file of value.providerFiles){
    fields(file,['path','dataBase64','removedSecretFields']);
    if(typeof file.path!=='string'||!providerPath(file.path)||file.path.split('/').some(part=>!part||part==='.'||part==='..')||credentialPath(file.path)||file.path.includes('\\')||file.path.includes('\0')||typeof file.dataBase64!=='string'||typeof file.removedSecretFields!=='boolean'||paths.has(file.path))throw new Error('Invalid reviewed provider original');
    const data=Buffer.from(file.dataBase64,'base64');bytes+=data.length;
    if(data.length>1024*1024||bytes>limit||data.toString('base64')!==file.dataBase64)throw new Error('Reviewed provider original exceeds its bound');
    if(file.path==='.codex/config.toml'&&scrubReviewToml(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data)).removedSecretFields)throw new Error('Reviewed TOML retains known credential assignments');
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
async function captureSparseConfiguration(gitDir:string,commonDir=gitDir) {
  const originals:Array<{name:string;identity:string;data:string}>=[];
  const configuration:ReviewedGitUserData['configurationReview']=[];
  let patternsBase64:string|null=null;
  const info=path.join(gitDir,'info');let infoIdentity:string|null=null;
  try{const stat=await fs.lstat(info,{bigint:true});if(!stat.isDirectory()||await fs.realpath(info)!==info)throw new Error('Sparse pattern parent is not a canonical local directory');infoIdentity=originalIdentity(stat);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  for(const name of ['config','config.worktree','info/sparse-checkout']){
    const target=path.join(name==='config'?commonDir:gitDir,name);
    let before;try{before=await fs.lstat(target,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    const {data}=await regularOriginal(target),after=await fs.lstat(target,{bigint:true});
    const identity=(stat:typeof before)=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
    if(identity(before)!==identity(after))throw new Error('Local Git sparse/config original changed');
    originals.push({name,identity:identity(after),data:data.toString('base64')});
    if(name==='info/sparse-checkout'){patternsBase64=data.toString('base64');continue;}
    const parsed=await parseCapturedGitConfiguration(data);
    if(parsed&&!parsed.endsWith('\0'))throw new Error('Incomplete local Git configuration inventory');
    for(const row of parsed?parsed.slice(0,-1).split('\0'):[]){
      if(configuration.length>=10000)throw new Error('Local Git configuration exceeds its bound');
      const split=row.indexOf('\n'),key=split<0?row:row.slice(0,split),value=split<0?'':row.slice(split+1);
      // Repository-aware plumbing must never resolve an include outside this exact local authority.
      if(/^(?:include|includeif)\./i.test(key))throw new Error('Git configuration includes require separate scoped capture');
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

type GitAssociation={root:string;gitDir:string;commonDir:string;linked:boolean;evidence:string};
function originalIdentity(stat:{dev:bigint;ino:bigint;mode:bigint;uid:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint}):string {
  return [stat.dev,stat.ino,stat.mode,stat.uid,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
}
async function absentGitPath(target:string):Promise<void> {
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
async function gitAssociation(root:string):Promise<GitAssociation|undefined> {
  const pointer=path.join(root,'.git');
  let node;try{node=await fs.lstat(pointer,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
  const owner=(await fs.lstat(root,{bigint:true})).uid,evidence:Array<{path:string;identity:string;data?:string}>=[];
  const directory=async(target:string)=>{
    const stat=await fs.lstat(target,{bigint:true});
    if(!stat.isDirectory()||stat.uid!==owner||await fs.realpath(target)!==target)throw new Error('Git association requires canonical same-owner directories');
    evidence.push({path:target,identity:originalIdentity(stat)});
  };
  const associationFile=async(target:string)=>{
    const before=await fs.lstat(target,{bigint:true});
    if(before.uid!==owner||!before.isFile()||before.nlink!==1n||before.size>4096n)throw new Error('Git association original requires a bounded same-owner regular file');
    const {data}=await regularOriginal(target,4096,owner),after=await fs.lstat(target,{bigint:true});
    if(data.length>4096||originalIdentity(before)!==originalIdentity(after))throw new Error('Git association original is oversized, foreign or changed');
    const value=text(data);if(!value||!Buffer.from(value).equals(data)||/[\0\r]/.test(value)||value.replace(/\n$/,'').includes('\n'))throw new Error('Malformed Git association original');
    evidence.push({path:target,identity:originalIdentity(after),data:data.toString('base64')});return value.replace(/\n$/,'');
  };
  await directory(root);
  if(node.isDirectory()){
    await directory(pointer);
    for(const name of ['commondir','gitdir'])await absentGitPath(path.join(pointer,name));
    return {root,gitDir:pointer,commonDir:pointer,linked:false,evidence:JSON.stringify(evidence)};
  }
  // Only these association records may be read before reciprocal authority is established.
  const value=await associationFile(pointer);
  if(!value.startsWith('gitdir: ')||!value.slice(8))throw new Error('Unsupported Git pointer');
  const gitDir=await associationDirectory(root,value.slice(8));await directory(gitDir);
  const backlink=await associationFile(path.join(gitDir,'gitdir'));
  if(!path.isAbsolute(backlink)||backlink!==pointer)throw new Error('Git worktree backlink does not identify the selected root');
  const commonValue=await associationFile(path.join(gitDir,'commondir')),commonDir=await associationDirectory(gitDir,commonValue);
  if(!commonValue||commonDir===gitDir||path.dirname(gitDir)!==path.join(commonDir,'worktrees')||!path.basename(gitDir)||path.basename(gitDir).startsWith('.'))throw new Error('Unsupported Git common-directory association');
  await directory(commonDir);await directory(path.join(commonDir,'worktrees'));
  for(const name of ['commondir','gitdir'])await absentGitPath(path.join(commonDir,name));
  // Recheck the complete association before permitting any repository content read.
  for(const item of evidence){
    const before=await fs.lstat(item.path,{bigint:true});
    if(originalIdentity(before)!==item.identity||await fs.realpath(item.path)!==item.path)throw new Error('Git reciprocal association changed');
    if(item.data!==undefined){const {data}=await regularOriginal(item.path,4096,owner),after=await fs.lstat(item.path,{bigint:true});if(data.toString('base64')!==item.data||originalIdentity(after)!==item.identity)throw new Error('Git reciprocal association original changed');}
  }
  return {root,gitDir,commonDir,linked:true,evidence:JSON.stringify(evidence)};
}

type CapturedGitFile={name:string;data:Buffer};
/** Complete exact allowed roots only; never enumerate common/worktrees or main-worktree private files. */
async function captureGitRaw(association:GitAssociation) {
  const {gitDir,commonDir,linked}=association,files:CapturedGitFile[]=[],inventory:Array<{name:string;identity:string;digest?:string;absent?:true}>=[];
  let nodes=0,bytes=0;
  const walk=async(target:string,name:string,objects=false):Promise<void>=>{
    let before;try{before=await fs.lstat(target,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){inventory.push({name,identity:'',absent:true});return;}throw error;}
    if(linked&&/^(?:refs|logs\/refs)\/(?:bisect|rewritten|worktree)(?:\/|$)/.test(name))throw new Error('Other worktree private namespace is outside the selected Git scope');
    if(++nodes>20000||await fs.realpath(target)!==target)throw new Error('Git raw inventory is external or exceeds its bound');
    if(before.isDirectory()){
      if(!objects&&!['refs','logs/refs'].some(prefix=>name===prefix||name.startsWith(prefix+'/')))throw new Error('Git control original must be a regular file');
      if(objects&&!['objects','objects/pack','objects/info'].includes(name)&&!/^objects\/[a-f0-9]{2}$/.test(name))throw new Error('Unsupported Git object directory');
      inventory.push({name,identity:originalIdentity(before)});
      for(const entry of (await fs.readdir(target)).sort())await walk(path.join(target,entry),name+'/'+entry,objects);
      const after=await fs.lstat(target,{bigint:true});if(originalIdentity(before)!==originalIdentity(after))throw new Error('Git raw directory changed');
    }else{
      if(objects&&!/^objects\/(?:[a-f0-9]{2}\/[a-f0-9]{38}(?:[a-f0-9]{24})?|pack\/pack-[a-f0-9]{40}(?:[a-f0-9]{24})?\.(?:pack|idx|rev|bitmap))$/.test(name))throw new Error('Unsupported Git object storage, alternates or promisor metadata');
      if(name.startsWith('refs/'))refName(name);else if(name.startsWith('logs/'))reflogPath(name.slice(5));
      const {data}=await regularOriginal(target,objects?limit:1024*1024),after=await fs.lstat(target,{bigint:true});
      if((bytes+=data.length)>limit||originalIdentity(before)!==originalIdentity(after))throw new Error('Git raw originals changed or exceed their bound');
      inventory.push({name,identity:originalIdentity(after),digest:createHash('sha256').update(data).digest('hex')});files.push({name,data});
    }
  };
  for(const name of ['HEAD','config.worktree','info/sparse-checkout'])await walk(path.join(gitDir,name),name);
  const objectDirectory=await fs.lstat(path.join(commonDir,'objects'));if(!objectDirectory.isDirectory())throw new Error('Missing regular Git object directory');
  // Packed refs precede loose overrides in the captured view.
  for(const name of ['config','packed-refs','refs','objects'])await walk(path.join(commonDir,name),name,name==='objects');
  for(const directory of new Set([gitDir,commonDir])){
    const target=path.join(directory,'logs');
    let before;try{before=await fs.lstat(target,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){inventory.push({name:directory===gitDir?'selected/logs':'shared/logs',identity:'',absent:true});continue;}throw error;}
    if(!before.isDirectory()||await fs.realpath(target)!==target)throw new Error('Git log parent is not canonical');
    if(!linked||directory===gitDir)for(const name of await fs.readdir(target))if(!(linked?['HEAD']:['HEAD','refs']).includes(name))throw new Error('Unsupported selected Git reflog original');
    inventory.push({name:directory===gitDir?'selected/logs':'shared/logs',identity:originalIdentity(before)});
  }
  await walk(path.join(gitDir,'logs','HEAD'),'logs/HEAD');await walk(path.join(commonDir,'logs','refs'),'logs/refs');
  if(linked){
    // These namespaces are private to a worktree; this bounded implementation refuses instead of merging them.
    for(const base of [path.join(gitDir,'refs'),path.join(gitDir,'logs','refs')])await absentGitPath(base);
  }
  return {files,evidence:JSON.stringify(inventory)};
}

/** Native plumbing sees only an exclusive private copy, with generated config and no source pointers/index. */
async function readCapturedGit(files:CapturedGitFile[],format:'sha1'|'sha256') {
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
    // Nothing copied here can route Git to a live repository or settings file.
    await mkdir(path.join(root,'.git','refs'));await mkdir(path.join(root,'.git','objects'));
    await write('config',Buffer.from(format==='sha256'?'[core]\nrepositoryformatversion = 1\nbare = true\n[extensions]\nobjectformat = sha256\n':'[core]\nrepositoryformatversion = 0\nbare = true\n'));
    const oidPattern=format==='sha1'?/^[a-f0-9]{40}$/:/^[a-f0-9]{64}$/;
    const expectedRefs=new Map<string,{oid?:string;symbolic?:string}>();
    for(const file of files){
      if(file.name.startsWith('objects/')){
        const width=format==='sha1'?40:64;
        const loose=new RegExp('^objects/[a-f0-9]{2}/[a-f0-9]{'+(width-2)+'}$'),packed=new RegExp('^objects/pack/pack-[a-f0-9]{'+width+'}\\.(?:pack|idx|rev|bitmap)$');
        if(!loose.test(file.name)&&!packed.test(file.name))throw new Error('Git object storage name differs from the declared format');
      }
      if(file.name==='packed-refs'){
        const value=text(file.data);if(value&&!value.endsWith('\n'))throw new Error('Truncated packed Git refs');
        const names=new Set<string>();let canPeel=false;
        for(const line of value?value.slice(0,-1).split('\n'):[]){
          if(line.startsWith('#')){if(!/^# pack-refs with:(?: (?:peeled|fully-peeled|sorted))* *$/.test(line))throw new Error('Unsupported packed Git ref header');canPeel=false;continue;}
          if(line.startsWith('^')){if(!canPeel||!oidPattern.test(line.slice(1)))throw new Error('Invalid peeled Git ref');canPeel=false;continue;}
          const split=line.indexOf(' '),oid=line.slice(0,split),name=line.slice(split+1);refName(name);
          if(!oidPattern.test(oid)||names.has(name)||/^refs\/(?:bisect|rewritten|worktree)(?:\/|$)/.test(name))throw new Error('Invalid, duplicate or private packed Git ref');
          names.add(name);expectedRefs.set(name,{oid});canPeel=true;
        }
      }
      if(file.name.startsWith('objects/pack/')){
        const stem=file.name.replace(/\.[^.]+$/,'');
        if(!files.some(item=>item.name===stem+'.pack')||!files.some(item=>item.name===stem+'.idx'))throw new Error('Incomplete captured Git pack storage');
      }
      if(file.name==='HEAD'||file.name.startsWith('refs/')){
        if(file.name!=='HEAD')refName(file.name);
        const value=text(file.data).replace(/\n$/,'');
        if(value.startsWith('ref: '))refName(value.slice(5));else if(!oidPattern.test(value))throw new Error('Unsupported Git ref original');
        if(file.name!=='HEAD')expectedRefs.set(file.name,value.startsWith('ref: ')?{symbolic:value.slice(5)}:{oid:value});
      }else if(file.name!=='packed-refs'&&!file.name.startsWith('objects/'))continue;
      await write(file.name,file.data);
    }
    const directoryIdentities=await Promise.all(directories.map(async target=>({target,identity:originalIdentity(await fs.lstat(target,{bigint:true}))})));
    const refs=await git(root,['for-each-ref','--format=%(refname)%00%(objectname)%00%(symref)']);
    const actualRefs=new Map<string,{oid:string;symbolic:string}>();
    for(const row of text(refs).split('\n').filter(Boolean)){
      const parts=row.split('\0');if(parts.length!==3||actualRefs.has(parts[0]!))throw new Error('Invalid captured Git ref inventory');
      actualRefs.set(parts[0]!,{oid:parts[1]!,symbolic:parts[2]!});
    }
    if(actualRefs.size!==expectedRefs.size||[...expectedRefs].some(([name,expected])=>{const actual=actualRefs.get(name);return !actual||expected.oid!==undefined&&actual.oid!==expected.oid||actual.symbolic!==(expected.symbolic??'');}))throw new Error('Missing, broken or normalized Git ref original');
    const originalHead=files.find(file=>file.name==='HEAD');if(!originalHead)throw new Error('Missing selected Git HEAD');
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

/** Bounded immutable originals with observed-change refusal; this does not drain independent writers. */
export async function exportReviewedGit(root:string):Promise<ReviewedGitUserData|undefined> {
  const association=await gitAssociation(root);if(!association)return undefined;
  const {gitDir,commonDir,linked}=association;
  const assertTopology=async()=>{
    for(const name of ['MERGE_HEAD','REBASE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','BISECT_LOG','rebase-merge','rebase-apply','index.lock'])await absentGitPath(path.join(gitDir,name));
    for(const name of ['shallow','info/grafts','objects/info/alternates','objects/info/http-alternates'])await absentGitPath(path.join(commonDir,name));
    if(linked){
      await absentGitPath(path.join(gitDir,'config'));
      for(const name of ['bisect','rewritten','worktree']){
        await absentGitPath(path.join(commonDir,'refs',name));await absentGitPath(path.join(commonDir,'logs','refs',name));
      }
    }
  };
  const snapshot=async()=>{
    const current=await gitAssociation(root);if(!current||current.evidence!==association.evidence)throw new Error('Git association changed during capture');
    await assertTopology();
    const sparse=await captureSparseConfiguration(gitDir,commonDir);
    const raw=await captureGitRaw(association);
    return {sparse,raw};
  };
  const initial=await snapshot();
  const local=initial.sparse.configuration.filter(item=>!item.source);
  const declared=local.filter(item=>item.key.toLowerCase()==='extensions.objectformat');
  if(declared.length>1||declared.some(item=>!['sha1','sha256'].includes(item.value)))throw new Error('Unsupported Git object format declaration');
  const format: 'sha1'|'sha256'=declared[0]?.value==='sha256'?'sha256':'sha1';
  const versions=local.filter(item=>item.key.toLowerCase()==='core.repositoryformatversion');
  if(versions.length!==1||!['0','1'].includes(versions[0]!.value)||declared.length>0&&versions[0]!.value!=='1'||local.some(item=>/^extensions\./i.test(item.key)&&!['extensions.objectformat','extensions.worktreeconfig'].includes(item.key.toLowerCase())))throw new Error('Unsupported Git repository format or extension');
  const before={...initial,storage:await captureIndexStorage(gitDir,format)};
  const captured=await readCapturedGit(before.raw.files,format),batch=captured.batch;
  const objects:GitObject[]=[];let offset=0;
  while(offset<batch.length){
    const end=batch.indexOf(10,offset);if(end<0)throw new Error('Truncated Git object header');
    const match=/^([a-f0-9]+) (blob|tree|commit|tag) ([0-9]+)$/.exec(text(batch.subarray(offset,end)));
    if(!match)throw new Error('Invalid Git object header');
    const size=Number(match[3]);offset=end+1;
    if(!Number.isSafeInteger(size)||size>limit||offset+size>=batch.length||batch[offset+size]!==10)throw new Error('Truncated Git object original');
    objects.push({oid:match[1]!,type:match[2] as GitObject['type'],dataBase64:batch.subarray(offset,offset+size).toString('base64')});offset+=size+1;
  }
  const after={...await snapshot(),storage:await captureIndexStorage(gitDir,format)};
  if(before.raw.evidence!==after.raw.evidence||JSON.stringify(before.sparse)!==JSON.stringify(after.sparse)||!before.storage.originals.equals(after.storage.originals)||JSON.stringify(before.storage.logical)!==JSON.stringify(after.storage.logical))throw new Error('Git selection changed during capture; preserve source and retry');
  const finalAssociation=await gitAssociation(root);if(!finalAssociation||finalAssociation.evidence!==association.evidence)throw new Error('Git association changed after capture');
  const originalIndex:IndexEntry[]=before.storage.logical;
  const sparseSnapshot=before.sparse;
  const sparseReview:ReviewedGitUserData['sparseReview']={patternsBase64:sparseSnapshot.patternsBase64,directories:originalIndex.filter(entry=>entry.mode==='40000')};
  const headText=text(captured.head).trim();
  const head:ReviewedGitUserData['head']=headText.startsWith('refs/')?{symbolic:headText}:{oid:headText};
  const exclusions=['Excluded: Git credentials, external include contents, all Git hook files and source worktree ownership',...(linked?['Linked-worktree selection excludes main/other worktrees private state and normalizes selected/shared originals into one inactive standalone review repository']:[]),'Unsupported index flags/extensions, combined split/sparse storage and operation-in-progress metadata need separate recreation; supported storage normalizes to a full review index'];
  const configurationReview:ReviewedGitUserData['configurationReview']=[];
  for(const item of before.sparse.configuration){
    const {key,value}=item;
    if(excludedGitKey(key)){exclusions.push('Git configuration entry excluded: credential or source ownership');continue;}
    try{safeText(`${key}=${value}`,'Git configuration');if(/:\/\/[^/]*@/.test(value))throw new Error('URL userinfo');configurationReview.push(item);}catch{
      if(sparseKey(key))throw new Error('Required sparse configuration contains recognizable credentials; preserve source');
      exclusions.push('Git configuration entry excluded: recognizable credential or URL userinfo');
    }
  }
  const result:ReviewedGitUserData={version:1,format,objects,reflogs:before.raw.files.filter(file=>file.name.startsWith('logs/')).map(file=>({path:file.name.slice(5),dataBase64:file.data.toString('base64')})),refs:text(captured.refs).split('\n').filter(Boolean).map(row=>{const [name,oid,symbolic]=row.split('\0');return {name:name!,oid:oid!,...(symbolic?{symbolic}:{})};}),head,index:originalIndex.filter(entry=>entry.mode!=='40000'),sparseReview,configurationReview,exclusions};
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
  if(selection.source==='retained_originals')throw new Error('Retained originals require their canonical artifact binding');
  const result:ReviewedUserData={version:1,activation:'inert_review_only',selection:{git:selection.git,harness:selection.harness},recreationScope:{...recreationScope},providerFiles:[],exclusions:[]};let bytes=0;
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
      const original=relative==='.codex/config.toml'?new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data):text(data);let safe=original,removedSecretFields=false;
      if(relative.endsWith('.json')){const parsed=JSON.parse(original),scrubbed=withoutPortableSecrets(parsed);removedSecretFields=JSON.stringify(parsed)!==JSON.stringify(scrubbed);safe=JSON.stringify(scrubbed,null,2);}
      else if(relative==='.codex/config.toml'){
        ({safe,removedSecretFields}=scrubReviewToml(original));
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


/** Only the original manifest is authoritative; generated review repositories are never read. */
export async function captureRetainedReviewOriginal(root:string,selection:ReviewedUserDataSelection,original:Buffer):Promise<{data:Buffer;verify:()=>Promise<void>}> {
  validateReviewedUserDataSelection(selection);
  if(selection.source!=='retained_originals')throw new Error('Retained originals require explicit source selection');
  const manifest=parseReviewedUserData(original);
  if(manifest.selection.git!==selection.git||manifest.selection.harness!==selection.harness)throw new Error('Select exactly the retained original families; partial or mixed source export is unsupported');
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
