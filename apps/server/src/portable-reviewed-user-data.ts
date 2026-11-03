import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {promises as fs} from '@ponderosa/native-host/fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {crc32,deflateSync,inflateSync} from 'node:zlib';
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
function codexReviewToml(value:string):boolean {
  return value==='.codex/config.toml'||/^\.codex\/agents\/[^/]+\.toml$/.test(value);
}
function claudeOutputStyle(value:string):boolean {
  return /^\.claude\/output-styles\/[^/]+\.md$/.test(value);
}
const claudeNamedRoots=['.claude/agent-memory','.claude/agent-memory-local','.claude/skills'];
function claudeOpaqueOriginal(value:string,directory=false):boolean {
  const parts=value.split('/'),family=parts.slice(0,2).join('/');
  const minimum=claudeNamedRoots.includes(family)?(directory?3:4):family==='.claude/hooks'?3:Infinity;
  return parts.length>=minimum&&parts.slice(2).every(part=>!!part&&!part.startsWith('.')&&!/[\\\0]/.test(part))&&!credentialPath(value);
}
function providerJsonSettings(value:string):boolean {
  return ['.mcp.json','.claude/settings.json','.claude/settings.local.json'].includes(value);
}
const gitWebOriginalNames=['description','category','cloneurl','README.html'];
function gitReviewOriginal(value:string):boolean {
  return gitWebOriginalNames.some(name=>value==='.git/'+name)||value.startsWith('.git/hooks/')&&value.split('/').every(part=>!!part&&part!=='.'&&part!=='..'&&!/[\\\0]/.test(part))&&!credentialPath(value);
}
function opaqueProviderOriginal(value:string,directory=false):boolean {
  if(gitReviewOriginal(value))return true;
  if(claudeOpaqueOriginal(value,directory)||['.claude/CLAUDE.md','.claude/AGENTS.md','.codex/instructions.md'].includes(value))return true;
  return /^\.(?:claude\/(?:commands|agents|rules)|codex\/(?:skills|rules))\//.test(value)&&value.split('/').every(part=>!!part&&part!=='.'&&part!=='..'&&!/[\\\0]/.test(part))&&!credentialPath(value);
}
function providerPath(value:string):boolean {
  return codexReviewToml(value)||claudeOutputStyle(value)||opaqueProviderOriginal(value)||providerJsonSettings(value);
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

export function parseReviewedUserData(data:Buffer):ReviewedUserData {
  if(data.length>48*1024*1024)throw new Error('Reviewed user-data manifest exceeds its bound');
  const value=JSON.parse(text(data)) as ReviewedUserData;
  fields(value,['version','activation','selection','recreationScope','providerFiles','exclusions'],['git']);
  if(!value||value.version!==1||value.activation!=='inert_review_only'||!Array.isArray(value.providerFiles)||value.providerFiles.length>1000||!Array.isArray(value.exclusions)||value.exclusions.some(item=>typeof item!=='string'))throw new Error('Invalid reviewed user-data manifest');
  fields(value.selection,['git','harness']);
  validateReviewedUserDataSelection(value.selection);
  if(Object.hasOwn(value,'git')&&!value.git)throw new Error('Invalid selected Git data');
  if(!value.selection.git&&value.git||value.selection.git&&!value.git)throw new Error('Reviewed data differs from its explicit family selection');
  if(!value.recreationScope||Object.keys(value.recreationScope).length!==Object.keys(recreationScope).length||Object.entries(recreationScope).some(([key,status])=>(key==='cyclicLinks'? !['refuse','passive_in_root'].includes(value.recreationScope.cyclicLinks):(value.recreationScope as Record<string,string>)[key]!==status)))throw new Error('Required recreation semantics cannot be silently downgraded');
  const paths=new Set<string>();let bytes=0;
  for(const file of value.providerFiles){
    fields(file,['path','dataBase64','removedSecretFields']);
    if(typeof file.path!=='string'||!providerPath(file.path)||file.path.split('/').some(part=>!part||part==='.'||part==='..')||credentialPath(file.path)||file.path.includes('\\')||file.path.includes('\0')||typeof file.dataBase64!=='string'||typeof file.removedSecretFields!=='boolean'||paths.has(file.path))throw new Error('Invalid reviewed provider original');
    const gitOriginal=gitReviewOriginal(file.path);
    if(gitOriginal?!value.selection.git||!value.git||file.removedSecretFields:!value.selection.harness)throw new Error('Reviewed original differs from its explicit family selection');
    const data=Buffer.from(file.dataBase64,'base64');bytes+=data.length;
    if(gitOriginal&&data.includes(0))throw new Error('Git review originals require UTF-8 text, not binary data');
    if(data.length>1024*1024||bytes>limit||data.toString('base64')!==file.dataBase64)throw new Error('Reviewed provider original exceeds its bound');
    if(codexReviewToml(file.path)&&scrubReviewToml(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data)).removedSecretFields)throw new Error('Reviewed TOML retains known credential assignments');
    safeText(text(data),'Reviewed provider configuration');
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
function validateGitReflogData(encoded:string,format:'sha1'|'sha256',ids:Map<string,GitObject>,budget:{bytes:number;entries:number}):void {
  if(typeof encoded!=='string'||encoded.length>Math.ceil(1024*1024/3)*4)throw new Error('Invalid Git reflog encoding');
  const oidPattern=format==='sha1'?/^[a-f0-9]{40}$/:/^[a-f0-9]{64}$/;
  const raw=Buffer.from(encoded,'base64');budget.bytes+=raw.length;
  if(raw.length>1024*1024||budget.bytes>limit||raw.toString('base64')!==encoded)throw new Error('Git reflog byte bound or encoding mismatch');
  const original=text(raw);safeText(original,'Git reflog');
  if(original&&!original.endsWith('\n'))throw new Error('Incomplete Git reflog entry');
  for(const line of original?original.slice(0,-1).split('\n'):[]){
    if(++budget.entries>10000)throw new Error('Git reflog entry count exceeds its bound');
    const entry=/^([a-f0-9]+) ([a-f0-9]+) ([^<>\x00-\x1f\x7f]+) <([^<>\x00-\x20\x7f]+)> ([0-9]{1,16}) ([+-][0-9]{4})\t([^\x00-\x1f\x7f]*)$/.exec(line);
    if(!entry||!oidPattern.test(entry[1]!)||!oidPattern.test(entry[2]!)||Number(entry[6]!.slice(1,3))>23||Number(entry[6]!.slice(3))>59)throw new Error('Unsupported Git reflog entry; preserve source');
    const zero='0'.repeat(format==='sha1'?40:64);
    if(entry[1]===zero&&entry[2]===zero)throw new Error('Git reflog has no object endpoint');
    for(const oid of [entry[1]!,entry[2]!])if(oid!==zero&&!ids.has(oid))throw new Error('Git reflog original object is missing; preserve source');
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

export function validateReviewedGit(value:ReviewedGitUserData):void {
  fields(value,['version','format','objects','refs','head','index','resolveUndo','reflogs','configurationReview','sparseReview','infoReview','shallowReview','packRetentionReview','origHeadReview','fetchHeadReview','exclusions']);
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
  validatePackRetention(value.packRetentionReview,value.format,ids,limit-bytes);
  const shallow=validateGitShallowReview(value.shallowReview,value.format);
  for(const oid of shallow)if(ids.get(oid)?.type!=='commit')throw new Error('Git shallow boundary must name a captured verified commit');
  if(!Array.isArray(value.reflogs)||value.reflogs.length>10000)throw new Error('Invalid bounded Git reflogs');
  const logPaths=new Set<string>(),logDirectories=new Set(['']),logBudget={bytes:0,entries:0};
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
  for(const name of refs)if(refDirectories.has(name))throw new Error('Git ref file/directory paths conflict');
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
  validateRelativeWorktrees(value.configurationReview);
  validateGitInfoReview(value.infoReview);
  validateSparseReview(value,ids);
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
function decodeIndex(data:Buffer,format:'sha1'|'sha256'):{entries:IndexEntry[];resolveUndo?:ReviewedGitUserData['resolveUndo'];link?:Buffer;sparse?:true} {
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
  return {entries,...(resolveUndo!==undefined?{resolveUndo}:{}),...(link?{link}:{}),...(seen.has('sdir')?{sparse:true as const}:{})};
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

async function captureIndexStorage(gitDir:string,format:'sha1'|'sha256'):Promise<{originals:Buffer;logical:IndexEntry[];resolveUndo:ReviewedGitUserData['resolveUndo']}> {
  const originals:Array<{name:string;identity:string;data:string}>=[];
  const owner=(await fs.lstat(gitDir,{bigint:true})).uid;
  const read=async(name:string)=>{
    const target=path.join(gitDir,name),before=await fs.lstat(target,{bigint:true}),{data}=await regularOriginal(target,1024*1024,owner),after=await fs.lstat(target,{bigint:true});
    if(originalIdentity(before)!==originalIdentity(after))throw new Error('Git index storage changed during capture');
    originals.push({name,identity:originalIdentity(after),data:data.toString('base64')});return data;
  };
  let data:Buffer;
  try{await fs.lstat(path.join(gitDir,'index'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {originals:Buffer.from('[]'),logical:[],resolveUndo:[]};throw error;}
  data=await read('index');
  const decoded=decodeIndex(data,format);
  const ordered=(entries:IndexEntry[])=>{for(let i=0;i<entries.length;i++)if(!entries[i]!.path||i>0&&indexOrder(entries[i-1]!,entries[i]!)>=0)throw new Error('Invalid Git index path/stage ordering');};
  const resolveUndo=decoded.resolveUndo??[];
  if(!decoded.link){ordered(decoded.entries);return {originals:Buffer.from(JSON.stringify(originals)),logical:decoded.entries,resolveUndo};}
  const width=format==='sha1'?20:32,link=decoded.link;
  if(link.length<width)throw new Error('Truncated split-index link');
  const oid=link.subarray(0,width).toString('hex');let base:IndexEntry[]=[];
  if(!/^0+$/.test(oid)){
    const shared=await read(`sharedindex.${oid}`);
    if(!shared.subarray(shared.length-width).equals(link.subarray(0,width)))throw new Error('Shared Git index identity differs');
    // REUC belongs to the selected overlay, never an inherited or merged shared-base extension.
    const parsed=decodeIndex(shared,format);if(parsed.link||parsed.sparse||parsed.resolveUndo!==undefined)throw new Error('Nested shared, sparse or resolve-undo base Git index refused');base=parsed.entries;
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
  return {originals:Buffer.from(JSON.stringify(originals)),logical,resolveUndo};
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
  // Resolve only the raw parent components; the final .git is the already observed file.
  const slash=backlink.lastIndexOf(path.sep);
  if(backlink.split(path.sep).length>128||backlink.slice(slash+1)!=='.git'||await associationDirectory(gitDir,slash<0?'.':backlink.slice(0,slash)||path.sep)!==root)throw new Error('Git worktree backlink does not identify the selected root');
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

type CapturedGitFile={name:string;source:'selected'|'shared';data:Buffer};
/** Derived local caches are observed for drift, never parsed or supplied to native Git. */
function derivedGitCache(name:string,format?:'sha1'|'sha256'):boolean {
  const width=format==='sha1'?'{40}':format==='sha256'?'{64}':'{40}(?:[a-f0-9]{24})?';
  const midx=new RegExp('^objects/pack/(?:multi-pack-index-[a-f0-9]'+width+'\\.(?:bitmap|rev)|multi-pack-index\\.d/multi-pack-index-[a-f0-9]'+width+'\\.(?:midx|bitmap|rev))$');
  return name==='info/refs'||name==='objects/info/packs'||name==='objects/pack/multi-pack-index'||name==='objects/pack/multi-pack-index.d/multi-pack-index-chain'||midx.test(name)||name==='objects/info/commit-graph'||name==='objects/info/commit-graphs/commit-graph-chain'||new RegExp('^objects/info/commit-graphs/graph-[a-f0-9]'+width+'\\.graph$').test(name);
}

/** Complete exact allowed roots only; never enumerate common/worktrees or main-worktree private files. */
async function captureGitRaw(association:GitAssociation) {
  const {gitDir,commonDir,linked}=association,files:CapturedGitFile[]=[],inventory:Array<{name:string;source:'selected'|'shared';identity:string;digest?:string;absent?:true}>=[];
  const owner=(await fs.lstat(association.root,{bigint:true})).uid,names=new Set<string>();
  let nodes=0,bytes=0,hookEntries=0;
  const walk=async(target:string,name:string,source:'selected'|'shared',objects=false,optional=true):Promise<void>=>{
    const hook=name==='hooks'||name.startsWith('hooks/'),gitOriginal=gitReviewOriginal('.git/'+name);
    if(gitOriginal&&source!=='shared')throw new Error('Git review originals require common provenance');
    if(hook&&(source!=='shared'||name!=='hooks'&&!gitReviewOriginal('.git/'+name)))throw new Error('Invalid common Git hook original path');
    if(hook&&name!=='hooks'&&++hookEntries>1000)throw new Error('Git hook inventory exceeds 1000 entries');
    const refPath=name.startsWith('logs/')?name.slice(5):name;
    // Common private names belong to the main worktree: do not even stat or open them.
    if(linked&&source==='shared'&&privateRef(refPath))return;
    if(linked&&source==='selected'&&(name.startsWith('refs/')||name.startsWith('logs/refs/'))&&!privateRef(refPath))throw new Error('Unsupported selected private Git ref storage');
    let before;try{before=await fs.lstat(target,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&(!hook||optional)){inventory.push({name,source,identity:'',absent:true});return;}throw error;}
    if(++nodes>20000||before.uid!==owner||await fs.realpath(target)!==target)throw new Error('Git raw inventory is foreign, external or exceeds its bound');
    if(before.isDirectory()){
      if(!objects&&!hook&&!['refs','logs/refs'].some(prefix=>name===prefix||name.startsWith(prefix+'/')))throw new Error('Git control original must be a regular file');
      if(objects&&!['objects','objects/pack','objects/info','objects/info/commit-graphs','objects/pack/multi-pack-index.d'].includes(name)&&!/^objects\/[a-f0-9]{2}$/.test(name))throw new Error('Unsupported Git object directory');
      inventory.push({name,source,identity:originalIdentity(before)});
      const entries=(await fs.readdir(target)).sort();
      for(const entry of entries)await walk(path.join(target,entry),name+'/'+entry,source,objects,false);
      const optional=name==='objects'?['info','pack']:name==='objects/info'?['commit-graph','commit-graphs','packs']:name==='objects/info/commit-graphs'?['commit-graph-chain']:name==='objects/pack'?['multi-pack-index','multi-pack-index.d']:name==='objects/pack/multi-pack-index.d'?['multi-pack-index-chain']:[];
      for(const entry of optional)if(!entries.includes(entry))await walk(path.join(target,entry),name+'/'+entry,source,objects);
      if(name==='objects/pack')for(const entry of entries.filter(entry=>/^pack-[a-f0-9]{40}(?:[a-f0-9]{24})?\.pack$/.test(entry)))for(const suffix of ['keep','mtimes']){const companion=entry.slice(0,-4)+suffix;if(!entries.includes(companion))await walk(path.join(target,companion),name+'/'+companion,source,objects);}
      const after=await fs.lstat(target,{bigint:true});if(originalIdentity(before)!==originalIdentity(after))throw new Error('Git raw directory changed');
    }else{
      if(name==='hooks')throw new Error('Common Git hook root must be a directory');
      if(['refs','logs/refs'].includes(name)||linked&&source==='selected'&&['refs/bisect','refs/rewritten','refs/worktree'].includes(refPath))throw new Error('Git ref namespace must be a directory');
      if(['objects/info/commit-graphs','objects/pack/multi-pack-index.d'].includes(name))throw new Error('Git derived-cache namespace must be a directory');
      const cache=derivedGitCache(name),retention=objects&&/\.(?:keep|mtimes)$/.test(name);
      if(objects&&!cache&&!/^objects\/(?:[a-f0-9]{2}\/[a-f0-9]{38}(?:[a-f0-9]{24})?|pack\/pack-[a-f0-9]{40}(?:[a-f0-9]{24})?\.(?:pack|idx|rev|bitmap|keep|mtimes))$/.test(name))throw new Error('Unsupported Git object storage, alternates or promisor metadata');
      if(name.startsWith('refs/'))refName(name);else if(name.startsWith('logs/')&&!(source==='selected'&&name==='logs/ORIG_HEAD'))reflogPath(name.slice(5));
      if(names.has(name))throw new Error('Selected and shared Git originals shadow each other');names.add(name);
      const {data}=await regularOriginal(target,name==='ORIG_HEAD'?4096:cache?4*1024*1024:retention?1024*1024:objects?limit:1024*1024,owner),after=await fs.lstat(target,{bigint:true});
      if((bytes+=data.length)>limit||originalIdentity(before)!==originalIdentity(after))throw new Error('Git raw originals changed or exceed their bound');
      if(gitOriginal){
        if(data.includes(0))throw new Error('Git review originals require UTF-8 text, not binary data');
        safeText(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data),'Git review original');
      }
      if(cache||retention)safeText(data.toString('latin1'),cache?'Git derived cache':'Git pack retention original');
      inventory.push({name,source,identity:originalIdentity(after),digest:createHash('sha256').update(data).digest('hex')});files.push({name,source,data});
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
  for(const name of ['HEAD','ORIG_HEAD','FETCH_HEAD','config.worktree','info/sparse-checkout'])await walk(path.join(gitDir,name),name,'selected');
  const objectDirectory=await fs.lstat(path.join(commonDir,'objects'));if(!objectDirectory.isDirectory())throw new Error('Missing regular Git object directory');
  // Packed refs precede loose overrides in the captured view.
  for(const name of ['config','shallow','packed-refs','refs','objects','hooks',...gitWebOriginalNames])await walk(path.join(commonDir,name),name,'shared',name==='objects');
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
  if(linked){
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
    // Object enumeration needs no traversal boundary: shallow and grafts stay out of this read view.
    // Nothing copied here can route Git to a live repository or settings file.
    await mkdir(path.join(root,'.git','refs'));await mkdir(path.join(root,'.git','objects'));
    await write('config',Buffer.from(format==='sha256'?'[core]\nrepositoryformatversion = 1\nbare = true\nhooksPath = /dev/null\nfsmonitor = false\n[extensions]\nobjectformat = sha256\n':'[core]\nrepositoryformatversion = 0\nbare = true\nhooksPath = /dev/null\nfsmonitor = false\n'));
    const oidPattern=format==='sha1'?/^[a-f0-9]{40}$/:/^[a-f0-9]{64}$/;
    const expectedRefs=new Map<string,{oid?:string;symbolic?:string}>();
    for(const file of files){
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
    for(const name of expectedRefs.keys())if(refDirectories.has(name))throw new Error('Captured Git refs shadow a directory');
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
export async function exportReviewedGit(root:string):Promise<{git:ReviewedGitUserData;gitOriginals:ReviewedUserData['providerFiles']}|undefined> {
  const association=await gitAssociation(root);if(!association)return undefined;
  const {gitDir,commonDir,linked}=association;
  const assertTopology=async()=>{
    for(const name of ['MERGE_HEAD','REBASE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','BISECT_LOG','rebase-merge','rebase-apply','index.lock'])await absentGitPath(path.join(gitDir,name));
    for(const name of ['info/grafts','objects/info/alternates','objects/info/http-alternates'])await absentGitPath(path.join(commonDir,name));
    if(linked){
      await absentGitPath(path.join(gitDir,'config'));
      await absentGitPath(path.join(gitDir,'packed-refs'));
      // Unknown private storage/pseudorefs must not silently disappear from the review copy.
      const names=await fs.readdir(gitDir);if(names.length>20000)throw new Error('Selected Git storage inventory exceeds its bound');
      for(const name of names)if(!['gitdir','commondir','HEAD','ORIG_HEAD','FETCH_HEAD','index','config.worktree','info','refs','logs','locked'].includes(name)&&!/^sharedindex\.[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(name))throw new Error('Unsupported selected Git storage or operation metadata; preserve source');
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
  validateRelativeWorktrees(initial.sparse.configuration);
  const local=initial.sparse.configuration.filter(item=>!item.source);
  const declared=local.filter(item=>item.key.toLowerCase()==='extensions.objectformat');
  if(declared.length>1||declared.some(item=>!['sha1','sha256'].includes(item.value)))throw new Error('Unsupported Git object format declaration');
  const format: 'sha1'|'sha256'=declared[0]?.value==='sha256'?'sha256':'sha1';
  const versions=local.filter(item=>item.key.toLowerCase()==='core.repositoryformatversion');
  if(versions.length!==1||!['0','1'].includes(versions[0]!.value)||declared.length>0&&versions[0]!.value!=='1'||local.some(item=>/^extensions\./i.test(item.key)&&!['extensions.objectformat','extensions.worktreeconfig','extensions.relativeworktrees'].includes(item.key.toLowerCase())))throw new Error('Unsupported Git repository format or extension');
  const before={...initial,storage:await captureIndexStorage(gitDir,format)};
  validateGitShallowReview(before.raw.shallowReview,format);
  parseGitOrigHeadReview(before.raw.origHeadReview,format);
  parseGitFetchHeadReview(before.raw.fetchHeadReview,format);
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
  if(before.raw.evidence!==after.raw.evidence||JSON.stringify(before.sparse)!==JSON.stringify(after.sparse)||!before.storage.originals.equals(after.storage.originals)||JSON.stringify(before.storage.logical)!==JSON.stringify(after.storage.logical)||JSON.stringify(before.storage.resolveUndo)!==JSON.stringify(after.storage.resolveUndo))throw new Error('Git selection changed during capture; preserve source and retry');
  const finalAssociation=await gitAssociation(root);if(!finalAssociation||finalAssociation.evidence!==association.evidence)throw new Error('Git association changed after capture');
  const originalIndex:IndexEntry[]=before.storage.logical;
  const sparseSnapshot=before.sparse;
  const sparseReview:ReviewedGitUserData['sparseReview']={patternsBase64:sparseSnapshot.patternsBase64,directories:originalIndex.filter(entry=>entry.mode==='40000')};
  const headText=text(captured.head).trim();
  const head:ReviewedGitUserData['head']=headText.startsWith('refs/')?{symbolic:headText}:{oid:headText};
  const exclusions=['Excluded: derived local commit-graph, multi-pack-index and server-info advertisements (info/refs, objects/info/packs); rebuild from verified objects/refs if needed','Excluded: derived Git index UNTR/FSMN caches; rebuild local observations if needed','Excluded: Git credentials, external include contents, configured hook targets beyond default common hooks and source worktree ownership',...(linked?['Linked-worktree selection excludes main/other worktrees private state and normalizes selected/shared originals into one inactive standalone review repository']:[]),'Unsupported index flags/extensions, combined split/sparse storage and operation-in-progress metadata need separate recreation; supported storage normalizes to a full review index'];
  const configurationReview:ReviewedGitUserData['configurationReview']=[];
  for(const item of before.sparse.configuration){
    const {key,value}=item;
    if(excludedGitKey(key)){exclusions.push('Git configuration entry excluded: credential or source ownership');continue;}
    try{safeText(`${key}=${value}`,'Git configuration');if(/:\/\/[^/]*@/.test(value))throw new Error('URL userinfo');configurationReview.push(item);}catch{
      if(sparseKey(key))throw new Error('Required sparse configuration contains recognizable credentials; preserve source');
      exclusions.push('Git configuration entry excluded: recognizable credential or URL userinfo');
    }
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
  const result:ReviewedGitUserData={version:1,format,objects,packRetentionReview,reflogs:before.raw.files.filter(file=>file.name.startsWith('logs/')&&file.name!=='logs/ORIG_HEAD').map(file=>({path:file.name.slice(5),dataBase64:file.data.toString('base64')})),refs:text(captured.refs).split('\n').filter(Boolean).map(row=>{const [name,oid,symbolic]=row.split('\0');return {name:name!,oid:oid!,...(symbolic?{symbolic}:{})};}),head,index:originalIndex.filter(entry=>entry.mode!=='40000'),resolveUndo:before.storage.resolveUndo,sparseReview,infoReview:before.raw.infoReview,shallowReview:before.raw.shallowReview,origHeadReview:before.raw.origHeadReview,fetchHeadReview:before.raw.fetchHeadReview,configurationReview,exclusions};
  // Verify every captured object and graph before deriving any missing logical index entries.
  const directories=sparseReview.directories;
  validateReviewedGit({...result,sparseReview:{...sparseReview,directories:[]}});
  result.index.push(...expandSparseDirectories(directories,new Map(objects.map(object=>[object.oid,object])),format));
  result.index.sort(indexOrder);validateReviewedGit(result);
  const gitOriginals=before.raw.files.filter(file=>file.source==='shared'&&gitReviewOriginal('.git/'+file.name)).map(file=>({path:'.git/'+file.name,dataBase64:file.data.toString('base64'),removedSecretFields:false}));
  return {git:result,gitOriginals};
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
    if(value.shallowReview.dataBase64!==null)await write('shallow',Buffer.from(value.shallowReview.dataBase64,'base64'));
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
    const undo=encodeResolveUndo(value.resolveUndo,value.format),extension=Buffer.alloc(undo.length?8:0);
    if(undo.length){extension.write('REUC');extension.writeUInt32BE(undo.length,4);}
    const index=Buffer.concat([header,...entries,extension,undo]);await write('index',Buffer.concat([index,createHash(value.format).update(index).digest()]));
    await fs.writeFile(path.join(destination,'CONFIGURATION-REVIEW.json'),JSON.stringify({activation:'inert_review_only',configuration:value.configurationReview,sparseReview:value.sparseReview,infoReview:value.infoReview,shallowReview:value.shallowReview,origHeadReview:value.origHeadReview,fetchHeadReview:value.fetchHeadReview,packRetentionReview:value.packRetentionReview,exclusions:value.exclusions},null,2),{flag:'wx',mode:0o600});
  }catch(error){throw new Error(`Git recreation incomplete; preserve all bytes at ${destination}`,{cause:error});}
}

/** Only configuration families, never provider sessions, login databases, caches or ownership receipts. */
export async function exportReviewedUserData(root:string,selection:ReviewedUserDataSelection):Promise<ReviewedUserData> {
  validateReviewedUserDataSelection(selection);
  if(selection.source==='retained_originals')throw new Error('Retained originals require their canonical artifact binding');
  const result:ReviewedUserData={version:1,activation:'inert_review_only',selection:{git:selection.git,harness:selection.harness},recreationScope:{...recreationScope},providerFiles:[],exclusions:[]};let bytes=0;
  const fixed=['.mcp.json','.claude/settings.json','.claude/settings.local.json','.claude/CLAUDE.md','.claude/AGENTS.md','.codex/config.toml','.codex/instructions.md'],selected=[...fixed];
  let entries=0,outputStyleOwner:bigint|undefined,opaqueOwner:bigint|undefined;
  const walk=async(relative:string,opaque=false,optional=false):Promise<void>=>{
    const target=path.join(root,relative);
    let stat;try{stat=await fs.lstat(target,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&optional)return;throw error;}
    if(!stat.isDirectory()||await fs.realpath(target)!==target)throw new Error('Custom provider configuration must have canonical directory parents');
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
  for(const directory of (selection.harness?['.claude/commands','.claude/agents','.claude/rules','.codex/skills','.codex/rules','.codex/agents','.claude/output-styles',...claudeNamedRoots,'.claude/hooks']:[]))await walk(directory,directory!=='.codex/agents'&&directory!=='.claude/output-styles',true);
  for(const relative of selection.harness?selected:[]){
    const target=path.join(root,relative);
    if(opaqueProviderOriginal(relative))opaqueOwner??=(await fs.lstat(root,{bigint:true})).uid;
    if(fixed.includes(relative))try{await fs.lstat(target);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    const originalFile=await regularOriginal(target,1024*1024,opaqueProviderOriginal(relative)?opaqueOwner:claudeOutputStyle(relative)?outputStyleOwner:undefined);
    {
      const {data}=originalFile;
      const original=codexReviewToml(relative)||claudeOutputStyle(relative)||opaqueProviderOriginal(relative)?new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data):text(data);let safe=original,removedSecretFields=false;
      if(providerJsonSettings(relative)){const parsed=JSON.parse(original),scrubbed=withoutPortableSecrets(parsed);removedSecretFields=JSON.stringify(parsed)!==JSON.stringify(scrubbed);safe=JSON.stringify(scrubbed,null,2);}
      else if(codexReviewToml(relative)){
        ({safe,removedSecretFields}=scrubReviewToml(original));
      }
      safeText(safe,'Provider configuration');bytes+=Buffer.byteLength(safe);if(bytes>limit)throw new Error('Provider configuration bound exceeded');
      result.providerFiles.push({path:relative,dataBase64:Buffer.from(safe).toString('base64'),removedSecretFields});
    }
  }
  if(selection.git){
    const captured=await exportReviewedGit(root);
    if(captured){
      result.git=captured.git;
      for(const original of captured.gitOriginals){
        bytes+=Buffer.from(original.dataBase64,'base64').length;
        if(result.providerFiles.length>=1000||bytes>limit)throw new Error('Combined review originals exceed their bound');
        result.providerFiles.push(original);
      }
    }
  }
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
