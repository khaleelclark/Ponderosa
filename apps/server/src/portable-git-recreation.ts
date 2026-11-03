import {decodePortableMetadataArtifact} from './agent-package-codec.js';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {promises as fs} from '@ponderosa/native-host/fs';
import path from 'node:path';
import type {AgentPortablePackageDto,PortableGitStorageBinding,ReviewedUserData,ReviewedUserDataActivation,PortableArtifactDto} from '@ponderosa/core';
import {compileReviewedGitConfiguration} from './portable-git-configuration.js';
import {applyReviewedProviderData,assertReviewedProviderDestination,createReviewedRecoveryGit,gitBindingSourceEvidence,planReviewedUserDataActivation,REVIEWED_USER_DATA_PATH,validatePortableGitStorageBindings} from './portable-reviewed-user-data.js';

type RecoveryTask={ref:string;destination:string;data:Buffer;sha256:string;value:ReviewedUserData;configuration?:ReturnType<typeof compileReviewedGitConfiguration>;layout?:{commonDir:string;privateDir:string;commonRoot:string}};
type RecoveryReceipt={ref:string;path:string;originalSha256:string;selection:ReviewedUserDataActivation;state:'applying'|'completed'|'incomplete';error?:{code?:string;partialStatePossible:boolean;observed:unknown}};
const privateRef=(name:string)=>['refs/bisect/','refs/rewritten/','refs/worktree/'].some(prefix=>name.startsWith(prefix));

/** No source identity is adopted: the caller supplies the exact newly imported root map. */
export function planReviewedRecoveryRoots(pkg:AgentPortablePackageDto,destinations:Record<string,string>,activation:ReviewedUserDataActivation):RecoveryTask[] {
  if(pkg.mode!=='full')throw new Error('Native recovery requires a full package');
  const roots=new Set(pkg.agents.filter(node=>node.workingFolder||node.workingFiles?.length).map(node=>node.workingRootRef??node.ref));
  if(Object.keys(destinations).length!==roots.size||[...roots].some(ref=>!Object.hasOwn(destinations,ref)))throw new Error('Native recovery requires the complete selected destination root map');
  const paths=Object.values(destinations);
  if(paths.some(name=>typeof name!=='string'||!path.isAbsolute(name)||path.resolve(name)!==name||/[\x00-\x1f\x7f]/.test(name))||paths.some((name,i)=>paths.some((other,j)=>i!==j&&(name===other||name.startsWith(other+path.sep)))))throw new Error('Native recovery roots must be canonical, distinct and non-nested');
  if(activation.gitPathMappings?.some(mapping=>!paths.some(root=>mapping.destination===root||mapping.destination.startsWith(root+path.sep))))throw new Error('Git path mappings must select one of the newly imported destination roots');
  const bindings=pkg.gitStorageBindings??[];
  if(bindings.length)validatePortableGitStorageBindings(bindings,roots);
  const storage=new Set(bindings.map(binding=>binding.storageRootRef));
  const tasks:RecoveryTask[]=[];
  type Original=Pick<PortableArtifactDto,'dataBase64'|'dataEncoding'|'decodedSize'>;
  const originals=new Map<string,Original>();
  const addOriginal=(name:string,original:Original)=>{const prior=originals.get(name);if(prior!==undefined&&(prior.dataBase64!==original.dataBase64||prior.dataEncoding!==original.dataEncoding||prior.decodedSize!==original.decodedSize))throw new Error('Conflicting transported Git configuration original');originals.set(name,original);};
  for(const node of pkg.agents){const root=destinations[node.workingRootRef??node.ref];if(!root)continue;for(const file of node.workingFiles??[]){const artifact=node.artifacts?.find(artifact=>artifact.ref===file.artifactRef);if(artifact)addOriginal(path.join(root,file.path),artifact);}}
  for(const ref of roots){
    const owners=pkg.agents.filter(node=>(node.workingRootRef??node.ref)===ref);
    const originals=owners.flatMap(node=>{const file=node.workingFiles?.find(file=>file.path===REVIEWED_USER_DATA_PATH);return file?[node.artifacts?.find(artifact=>artifact.ref===file.artifactRef)]:[];});
    if(!originals.length){if(storage.has(ref))continue;throw new Error('Every activated working root requires its authoritative reviewed original');}
    if(originals.some(original=>!original)||new Set(originals.map(original=>original!.dataBase64)).size!==1)throw new Error('Conflicting reviewed originals for a shared recovery root');
    const data=decodePortableMetadataArtifact(originals[0]!),sha256=createHash('sha256').update(data).digest('hex');
    const selected=bindings.filter(binding=>binding.worktreeRootRef===ref);
    const value=planReviewedUserDataActivation(data,sha256,activation,!!selected.length);
    const task:RecoveryTask={ref,destination:destinations[ref]!,data,sha256,value};
    if(activation.git&&selected.length){
      if(selected.length!==2||!value.associationReview||selected.some(binding=>!binding.capture||binding.capture.reviewSha256!==sha256||!value.associationReview!.some(original=>gitBindingSourceEvidence(binding)===gitBindingSourceEvidence(original))))throw new Error('Mapped Git lacks the exact original common/private association review');
      const common=selected.find(binding=>binding.role==='common'),privateBinding=selected.find(binding=>binding.role==='private');
      if(!common||!privateBinding)throw new Error('Mapped Git needs one common/private pair');
      const target=(binding:PortableGitStorageBinding)=>path.join(destinations[binding.storageRootRef]!,binding.relativePath);
      const commonDir=target(common),privateDir=target(privateBinding);
      if(path.dirname(privateDir)!==path.join(commonDir,'worktrees')||privateDir===task.destination||commonDir===task.destination)throw new Error('Destination Git storage must retain its declared common/worktrees/private topology');
      task.layout={commonDir,privateDir,commonRoot:destinations[common.storageRootRef]!};
    }else if(activation.git&&value.associationReview)throw new Error('Retained mapped originals require their complete original package binding set');
    tasks.push(task);
  }
  if(activation.git){
    for(const task of tasks){
      const common=task.layout?.commonDir??path.join(task.destination,'.git'),privateDir=task.layout?.privateDir??common;
      for(const file of task.value.providerFiles){
        const name=file.path.slice(5),selected=['COMMIT_EDITMSG','SQUASH_MSG','TAG_EDITMSG','MERGE_MSG','EDIT_DESCRIPTION'].includes(name);
        addOriginal(file.path.startsWith('.git/')?path.join(selected?privateDir:common,name):path.join(task.destination,file.path),{dataBase64:file.dataBase64});
      }
      for(const record of task.value.git!.configurationOriginalReview)if(record.dataBase64!==null)addOriginal(path.join(record.source==='selected_worktree'?privateDir:common,record.path),{dataBase64:record.dataBase64});
    }
    const read=(name:string)=>{const encoded=originals.get(name);if(encoded===undefined)return;return decodePortableMetadataArtifact(encoded,1024*1024);};
    for(const task of tasks)task.configuration=compileReviewedGitConfiguration(task.value,activation,{common:task.layout?.commonDir??path.join(task.destination,'.git'),private:task.layout?.privateDir??path.join(task.destination,'.git')},read);
  }
  const signatures=new Map<string,string>(),privatePaths=new Set<string>();
  for(const task of tasks.filter(task=>task.layout)){
    const {commonDir,privateDir}=task.layout!;
    if(privatePaths.has(privateDir))throw new Error('Two selected worktrees cannot claim the same destination private Git directory');privatePaths.add(privateDir);
    const git=task.value.git!;
    const signature=JSON.stringify({format:git.format,reftable:git.reftableReview,objects:git.objects,refs:git.refs.filter(ref=>!privateRef(ref.name)),reflogs:git.reflogs.filter(log=>log.path!=='HEAD'&&!privateRef(log.path)),configuration:git.configurationOriginalReview[0],activeConfiguration:task.configuration?.common.toString('base64'),includes:task.configuration?.includeFiles?.filter(file=>!file.private).map(file=>({path:file.path,data:file.data.toString('base64')})),info:git.infoReview,shallow:git.shallowReview,retention:git.packRetentionReview,originals:task.value.providerFiles.filter(file=>file.path.startsWith('.git/')&&!['COMMIT_EDITMSG','SQUASH_MSG','TAG_EDITMSG','MERGE_MSG','EDIT_DESCRIPTION'].includes(file.path.slice(5)))});
    if(signatures.has(commonDir)&&signatures.get(commonDir)!==signature)throw new Error('Selected common repository originals disagree; no destination has been changed');
    signatures.set(commonDir,signature);
  }
  return tasks;
}

/** Apply once to fresh recovery roots. An incomplete receipt never authorizes a retry. */
export async function applyReviewedRecoveryRoots(tasks:ReturnType<typeof planReviewedRecoveryRoots>,activation:ReviewedUserDataActivation,onReceipt:(receipt:RecoveryReceipt)=>void):Promise<void> {
  const opened:Array<{path:string;handle:Awaited<ReturnType<typeof fs.open>>;device:bigint;inode:bigint}>=[];
  const commonCreated=new Set<string>();
  let failure:unknown;
  try{
    const rootPaths=new Set(tasks.flatMap(task=>[task.destination,...(task.layout?[task.layout.commonRoot]:[])]));
    for(const root of rootPaths){
      const handle=await fs.open(root,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);
      const owned={path:root,handle,device:0n,inode:0n};opened.push(owned);
      const stat=await handle.stat({bigint:true});owned.device=stat.dev;owned.inode=stat.ino;
      if(!stat.isDirectory()||await fs.realpath(root)!==root)throw new Error('Recovery root is no longer canonical');
    }
    const check=async()=>{for(const owned of opened){const stat=await fs.lstat(owned.path,{bigint:true});if(!stat.isDirectory()||stat.dev!==owned.device||stat.ino!==owned.inode||await fs.realpath(owned.path)!==owned.path)throw new Error('Recovery root identity changed; preserve all partial state');}};
    // Refuse every collision before creating the first native metadata entry.
    for(const task of tasks){
      await check();
      if(activation.git){try{await fs.lstat(path.join(task.destination,'.git'));throw new Error('Recovery root already has native Git metadata');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
      if(activation.harness)await assertReviewedProviderDestination(task.destination,task.value);
      if(activation.git)for(const name of task.configuration!.targets.filter(target=>!task.configuration!.includes.some(include=>include.destination===target))){
        const target=path.isAbsolute(name)?name:path.resolve(task.destination,name);
        const nativeOriginal=task.value.providerFiles.some(file=>{const installed=file.path.startsWith('.git/')?path.join(task.layout?.commonDir??path.join(task.destination,'.git'),file.path.slice(5)):path.join(task.destination,file.path);return installed===target||installed.startsWith(target+path.sep);});
        if(nativeOriginal)continue;
        const resolved=await fs.realpath(target);
        if(![...rootPaths].some(root=>resolved===root||resolved.startsWith(root+path.sep)))throw new Error('Git path activation requires a transported target inside the selected fresh recovery roots');
      }
      if(task.layout&&task.layout.commonDir!==task.layout.commonRoot){try{await fs.lstat(task.layout.commonDir);throw new Error('Mapped common Git destination already exists');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
      if(task.layout)for(const name of ['objects','refs','worktrees','config','HEAD'])try{await fs.lstat(path.join(task.layout.commonDir,name));throw new Error('Mapped common Git destination already contains metadata');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    for(const task of tasks){
      const receipt:RecoveryReceipt={ref:task.ref,path:task.destination,originalSha256:task.sha256,selection:activation,state:'applying'};onReceipt(receipt);
      try{
        await check();
        if(activation.git){
          if(task.layout&&!commonCreated.has(task.layout.commonDir)&&task.layout.commonDir!==task.layout.commonRoot){
            let parent=task.layout.commonRoot;
            for(const component of path.relative(parent,task.layout.commonDir).split(path.sep)){
              parent=path.join(parent,component);
              try{await fs.mkdir(parent,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||parent===task.layout.commonDir)throw error;}
              if(await fs.realpath(parent)!==parent||!(await fs.lstat(parent)).isDirectory())throw new Error('Mapped Git destination parent changed');
            }
          }
          await createReviewedRecoveryGit(task.destination,task.data,task.sha256,activation,task.layout?{commonDir:task.layout.commonDir,privateDir:task.layout.privateDir,writeCommon:!commonCreated.has(task.layout.commonDir)}:undefined,task.configuration);
          if(task.layout)commonCreated.add(task.layout.commonDir);
        }
        if(activation.harness)await applyReviewedProviderData(task.destination,task.data,task.sha256,{git:false,harness:true});
        await check();receipt.state='completed';onReceipt(receipt);
      }catch(error){receipt.state='incomplete';receipt.error={code:(error as {code?:string}).code??'ERR_RECOVERY_APPLICATION_PARTIAL',partialStatePossible:true,observed:null};onReceipt(receipt);throw error;}
    }
  }catch(error){failure=error;}
  finally{
    const cleanup:unknown[]=[];for(const owned of opened.reverse())try{await owned.handle.close();}catch(error){cleanup.push(error);}
    if(cleanup.length)failure=Object.assign(new Error('Recovery descriptor cleanup failed; preserve all destination roots',{cause:failure??cleanup[0]}),{code:'ERR_RECOVERY_CLEANUP_PARTIAL',partialStatePossible:true,cleanupErrors:cleanup});
  }
  if(failure)throw failure;
}
