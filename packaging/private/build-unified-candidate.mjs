#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,cpSync,readFileSync,writeFileSync,readdirSync,lstatSync,readlinkSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {auditPortableSymlinkTree} from '../qualification/symlink-portability.mjs';
import {isolateNativeImages} from '../qualification/native-image-isolation.mjs';
const root=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
const {values}=parseArgs({options:{output:{type:'string'}},strict:true});
if(!values.output)throw Error('--output requires a new private output directory');
if(process.platform!=='linux'||process.arch!=='x64'||process.versions.modules!=='137')throw Error('This candidate assembler is qualified only on Linux x64 / Node ABI137');
const git=(args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
if(git(['status','--porcelain']))throw Error('Commit the exact private source before packaging');
const commit=git(['rev-parse','HEAD']),output=path.resolve(values.output),bundle=path.join(output,'Ponderosa-Branches-Memory');
if(existsSync(output))throw Error('Output already exists; preserve previous artifacts and choose a new directory');
const core='vendor/local-memory-mcp-node-private-0.2.0-private.6.tgz',hash=f=>createHash('sha256').update(readFileSync(f)).digest('hex');
if(hash(path.join(root,core))!=='790d81ccabd862e956ce323e00a71c5f2c00042f58261138da16d53593923dba')throw Error('Private.6 core archive differs');
for(const required of ['apps/server/dist/main.js','apps/server/dist/local-memory-config.js','apps/web/dist/index.html','packages/native-host/build/Release/ponderosa_native.node']){
 if(!existsSync(path.join(root,required)))throw Error('Missing built input: '+required);
}
mkdirSync(bundle,{recursive:true});
const sourceArchive=path.join(output,'source-input.tar');
writeFileSync(sourceArchive,execFileSync('git',['archive','--format=tar',commit],{cwd:root,maxBuffer:64*1024*1024}));
execFileSync('tar',['-xf',sourceArchive,'-C',bundle]);rmSync(sourceArchive);
const copy=relative=>{
 const src=path.join(root,relative),dst=path.join(bundle,relative);
 if(existsSync(src))cpSync(src,dst,{recursive:true,dereference:false,verbatimSymlinks:true,force:false,errorOnExist:true,filter:f=>!f.split(path.sep).includes('.cache')});
};
for(const relative of ['packages/core/dist','packages/agents/dist','packages/engines/dist','packages/native-host/dist','packages/native-host/build/Release','apps/server/dist','apps/web/dist','node_modules'])copy(relative);
for(const group of ['apps','packages'])for(const entry of readdirSync(path.join(root,group),{withFileTypes:true}))if(entry.isDirectory())copy(group+'/'+entry.name+'/node_modules');
const nativeImages=isolateNativeImages(bundle);auditPortableSymlinkTree(bundle,{label:'private unified application candidate'});
const manifest={schemaVersion:1,product:'Private unified Ponderosa Branches and memory candidate',commit,target:{platform:process.platform,arch:process.arch},testedNodeVersion:process.version,nodeModulesAbi:process.versions.modules,core:{version:'0.2.0-private.6',sha256:hash(path.join(bundle,core))},components:['normal server entry','native Branches','full web UI','journal-free Chat/global memory','scoped streaming/calls'],prerequisites:{node:'Node24 / ABI137, tested '+process.version,chroma:'separate Chroma1.4.1 HTTP process',models:'pinned local embed/rerank assets; not included',provider:'existing authorized subscription CLI; no provider API keys'},entry:'./run-branches.sh',configuration:'PONDEROSA_LOCAL_MEMORY_CONFIG',userDataIncluded:false,modelsIncluded:false,credentialsIncluded:false,publicRelease:false,nativeImages};
writeFileSync(path.join(bundle,'PRIVATE_BUILD.json'),JSON.stringify(manifest,null,2)+'\n');
const files={},links={};
function scan(dir){for(const name of readdirSync(dir)){const f=path.join(dir,name),st=lstatSync(f),relative=path.relative(bundle,f);if(st.isSymbolicLink())links[relative]=readlinkSync(f);else if(st.isDirectory())scan(f);else if(st.isFile())files[relative]={sha256:hash(f),bytes:st.size};}}
scan(bundle);
writeFileSync(path.join(bundle,'PRIVATE_FILES.json'),JSON.stringify({commit,files,links},null,2)+'\n');
const archive=path.join(output,'Ponderosa-Branches-Memory-'+commit.slice(0,12)+'-linux-x64.tar.gz');
execFileSync('tar',['--use-compress-program=gzip -1','-cf',archive,'-C',output,path.basename(bundle)],{stdio:'inherit'});
writeFileSync(path.join(output,'DELIVERY.json'),JSON.stringify({manifest,bundle,archive,sha256:hash(archive),applicationFiles:Object.keys(files).length,symlinks:Object.keys(links).length},null,2)+'\n');
console.log(JSON.stringify({bundle,archive,sha256:hash(archive),commit,nativeImages}));
