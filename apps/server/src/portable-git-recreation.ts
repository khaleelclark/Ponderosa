import {decodePortableMetadataArtifact} from './agent-package-codec.js';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {promises as fs} from '@ponderosa/native-host/fs';
import path from 'node:path';
import type {AgentPortablePackageDto,PortableGitStorageBinding,ReviewedUserData,ReviewedUserDataActivation,PortableArtifactDto} from '@ponderosa/core';
import {bindReviewedGitDirectories,compileReviewedGitConfiguration} from './portable-git-configuration.js';
import {applyReviewedProviderData,assertReviewedProviderDestination,createReviewedRecoveryGit,gitBindingSourceEvidence,parseReviewedUserData,planReviewedUserDataActivation,reviewedGitModules,selectedWorktreeReftable,REVIEWED_USER_DATA_PATH,validatePortableGitStorageBindings,validateReviewedUserDataActivation,type NativeReviewedGitModulePlan,type NativeReviewedGitStorage} from './portable-reviewed-user-data.js';
import {redactPortableDiagnostic} from './portable-secrets.js';
import {validateWorkingRootNesting} from './portable-working-files.js';

type RecoveryTask={ref:string;destination:string;roots:readonly string[];activation:ReviewedUserDataActivation;data:Buffer;sha256:string;value:ReviewedUserData;configuration?:ReturnType<typeof compileReviewedGitConfiguration>;layout?:{commonDir:string;privateDir:string;commonRoot:string};storage?:NativeReviewedGitStorage&{root:string};moduleOwner?:{ref:string;gitDir:string}};
type RecoveryReceipt={ref:string;path:string;originalSha256:string;selection:ReviewedUserDataActivation;state:'applying'|'completed'|'incomplete';error?:{code?:string;message?:string;partialStatePossible:boolean;observed:unknown}};
const privateRef=(name:string)=>['refs/bisect/','refs/rewritten/','refs/worktree/'].some(prefix=>name.startsWith(prefix));

/** No source identity is adopted: the caller supplies the exact newly imported root map. */
export function planReviewedRecoveryRoots(pkg:AgentPortablePackageDto,destinations:Record<string,string>,activation:ReviewedUserDataActivation):RecoveryTask[] {
  validateReviewedUserDataActivation(activation);
  if(pkg.mode!=='full')throw new Error('Native recovery requires a full package');
  const roots=new Set(pkg.agents.filter(node=>node.workingFolder||node.workingFiles?.length).map(node=>node.workingRootRef??node.ref));
  if(Object.keys(destinations).length!==roots.size||[...roots].some(ref=>!Object.hasOwn(destinations,ref)))throw new Error('Native recovery requires the complete selected destination root map');
  const paths=Object.values(destinations);
  if(paths.some(name=>typeof name!=='string'||!path.isAbsolute(name)||path.resolve(name)!==name||/[\x00-\x1f\x7f]/.test(name)))throw new Error('Native recovery roots must be canonical');
  validateWorkingRootNesting(roots,(pkg as AgentPortablePackageDto&{workingRootNesting?:Array<{parentRootRef:string;childRootRef:string;path:string}>}).workingRootNesting??[],destinations);
  if(activation.gitPathMappings?.some(mapping=>!paths.some(root=>mapping.destination===root||mapping.destination.startsWith(root+path.sep))))throw new Error('Git path mappings must select one of the newly imported destination roots');
  const bindings=pkg.gitStorageBindings??[];
  if(bindings.length)validatePortableGitStorageBindings(bindings,roots);
  const tasks:RecoveryTask[]=[];
  type Original=Pick<PortableArtifactDto,'dataBase64'|'dataEncoding'|'decodedSize'>;
  const originals=new Map<string,Original>();
  const addOriginal=(name:string,original:Original)=>{const prior=originals.get(name);if(prior!==undefined&&(prior.dataBase64!==original.dataBase64||prior.dataEncoding!==original.dataEncoding||prior.decodedSize!==original.decodedSize))throw new Error('Conflicting transported Git configuration original');originals.set(name,original);};
  for(const node of pkg.agents){const root=destinations[node.workingRootRef??node.ref];if(!root)continue;for(const file of node.workingFiles??[]){const artifact=node.artifacts?.find(artifact=>artifact.ref===file.artifactRef);if(artifact)addOriginal(path.join(root,file.path),artifact);}}
  for(const ref of roots){
    const owners=pkg.agents.filter(node=>(node.workingRootRef??node.ref)===ref);
    const originals=owners.flatMap(node=>{const file=node.workingFiles?.find(file=>file.path===REVIEWED_USER_DATA_PATH);return file?[node.artifacts?.find(artifact=>artifact.ref===file.artifactRef)]:[];});
    if(!originals.length)continue; // Explicitly selected supporting roots supply files, not invented Git repositories.
    if(originals.some(original=>!original)||new Set(originals.map(original=>original!.dataBase64)).size!==1)throw new Error('Conflicting reviewed originals for a shared recovery root');
    const data=decodePortableMetadataArtifact(originals[0]!),sha256=createHash('sha256').update(data).digest('hex');
    const declared=parseReviewedUserData(data),selected=bindings.filter(binding=>binding.worktreeRootRef===ref);
    let taskActivation:ReviewedUserDataActivation={git:activation.git&&declared.selection.git,harness:activation.harness&&declared.selection.harness,...(activation.git&&declared.selection.git&&activation.gitPathMappings?{gitPathMappings:activation.gitPathMappings}:{})};
    if(!taskActivation.git&&!taskActivation.harness)continue;
    if(taskActivation.git){
      const commonBinding=selected.find(binding=>binding.role==='common'),privateBinding=selected.find(binding=>binding.role==='private');
      const moduleBinding=selected.length===1&&selected[0]!.role==='module'?selected[0]:undefined;
      const common=commonBinding?path.join(destinations[commonBinding.storageRootRef]!,commonBinding.relativePath):moduleBinding?path.join(destinations[moduleBinding.storageRootRef]!,moduleBinding.relativePath):selectedWorktreeReftable(declared.git!)?path.join(destinations[ref]!,'.ponderosa-portable-review','native-git-common'):path.join(destinations[ref]!,'.git');
      const privateDir=privateBinding?path.join(destinations[privateBinding.storageRootRef]!,privateBinding.relativePath):selectedWorktreeReftable(declared.git!)?path.join(common,'worktrees','imported'):common;
      taskActivation=bindReviewedGitDirectories(declared,taskActivation,{common,private:privateDir});
    }
    const value=planReviewedUserDataActivation(data,sha256,taskActivation,!!selected.length);
    const task:RecoveryTask={ref,destination:destinations[ref]!,roots:paths,activation:taskActivation,data,sha256,value};
    if(taskActivation.git&&selected.length){
      if(!value.associationReview||selected.some(binding=>!binding.capture||binding.capture.reviewSha256!==sha256||!value.associationReview!.some(original=>gitBindingSourceEvidence(binding)===gitBindingSourceEvidence(original))))throw new Error('Mapped Git lacks its exact original association review');
      if(selected.length===1&&selected[0]!.role==='module'){
        const binding=selected[0]!,root=destinations[binding.storageRootRef]!,gitDir=path.join(root,binding.relativePath);
        if(gitDir===path.join(task.destination,'.git'))throw new Error('Mapped module storage cannot replace its worktree pointer');
        task.storage={gitDir,worktreePath:task.destination,initialized:true,existingRoot:gitDir===root,root};
        tasks.push(task);continue;
      }
      if(selected.length!==2)throw new Error('Mapped Git requires one module binding or one complete common/private pair');
      const common=selected.find(binding=>binding.role==='common'),privateBinding=selected.find(binding=>binding.role==='private');
      if(!common||!privateBinding)throw new Error('Mapped Git needs one common/private pair');
      const target=(binding:PortableGitStorageBinding)=>path.join(destinations[binding.storageRootRef]!,binding.relativePath);
      const commonDir=target(common),privateDir=target(privateBinding);
      if(path.dirname(privateDir)!==path.join(commonDir,'worktrees')||privateDir===task.destination||commonDir===task.destination)throw new Error('Destination Git storage must retain its declared common/worktrees/private topology');
      task.layout={commonDir,privateDir,commonRoot:destinations[common.storageRootRef]!};
    }else if(taskActivation.git&&value.associationReview)throw new Error('Retained mapped originals require their complete original package binding set');
    else if(taskActivation.git&&selectedWorktreeReftable(value.git!)){
      const commonDir=path.join(task.destination,'.ponderosa-portable-review','native-git-common');
      task.layout={commonDir,privateDir:path.join(commonDir,'worktrees','imported'),commonRoot:task.destination};
    }
    tasks.push(task);
  }
  if(!tasks.length||activation.git&&!tasks.some(task=>task.activation.git)||activation.harness&&!tasks.some(task=>task.activation.harness))throw new Error('The selected package contains no authoritative originals for an activated family');
  if(activation.git){
    for(const task of tasks.filter(task=>task.activation.git)){
      const common=task.layout?.commonDir??task.storage?.gitDir??path.join(task.destination,'.git'),privateDir=task.layout?.privateDir??common;
      for(const file of task.value.providerFiles){
        const name=file.path.slice(5),selected=['COMMIT_EDITMSG','SQUASH_MSG','TAG_EDITMSG','MERGE_MSG','EDIT_DESCRIPTION'].includes(name);
        addOriginal(file.path.startsWith('.git/')?path.join(selected?privateDir:common,name):path.join(task.destination,file.path),{dataBase64:file.dataBase64});
      }
      for(const record of task.value.git!.configurationOriginalReview)if(record.dataBase64!==null)addOriginal(path.join(record.source==='selected_worktree'?privateDir:common,record.path),{dataBase64:record.dataBase64});
    }
    let moduleCount=0;
    const modulePlans=new Map<RecoveryTask,NativeReviewedGitModulePlan[]>();
    const collectModules=(value:ReviewedUserData,common:string,workingRoot:string,current:ReviewedUserDataActivation,depth:number):NativeReviewedGitModulePlan[]=>{
      if(depth>32)throw new Error('Native module nesting exceeds its documented parser memory bound');
      return reviewedGitModules(value.git!).map(module=>{
        if(++moduleCount>1000||!module.name||path.posix.normalize(module.name)!==module.name||path.posix.isAbsolute(module.name)||module.name.split('/').some(part=>part==='..'||part==='.')||/[\\\x00-\x1f\x7f]/.test(module.name))throw new Error('Invalid or excessive native module storage selection');
        const sourceMap=[...(activation.gitPathMappings??[])].sort((a,b)=>b.source.length-a.source.length).find(mapping=>module.source.worktreePath===mapping.source||module.source.worktreePath.startsWith(mapping.source+'/'));
        const worktreePath=sourceMap?path.join(sourceMap.destination,path.posix.relative(sourceMap.source,module.source.worktreePath)):module.worktreeRelativePath!==null?path.join(workingRoot,module.worktreeRelativePath):undefined;
        if(!worktreePath||!paths.some(root=>worktreePath===root||worktreePath.startsWith(root+path.sep)))throw new Error('Choose a selected destination root mapping for external module worktree: '+module.source.worktreePath);
        const gitDir=path.join(common,'modules',module.name);
        const moduleValue:ReviewedUserData={version:1,activation:'inert_review_only',selection:{git:true,harness:false},recreationScope:value.recreationScope,git:module.git,providerFiles:module.originals,providerDirectories:[],exclusions:[]};
        const moduleActivation=bindReviewedGitDirectories(moduleValue,{git:true,harness:false,...(current.gitPathMappings?{gitPathMappings:current.gitPathMappings}:{})},{common:gitDir,private:gitDir});
        for(const original of module.originals){if(!original.path.startsWith('.git/'))throw new Error('Module originals must belong to their captured Git storage');addOriginal(path.join(gitDir,original.path.slice(5)),{dataBase64:original.dataBase64});}
        for(const record of module.git.configurationOriginalReview)if(record.dataBase64!==null)addOriginal(path.join(gitDir,record.path),{dataBase64:record.dataBase64});
        const configuration:ReturnType<typeof compileReviewedGitConfiguration>={common:Buffer.alloc(0),private:null,targets:[],includes:[],modules:collectModules(moduleValue,gitDir,worktreePath,moduleActivation,depth+1)};
        return {gitDir,worktreePath,initialized:module.source.initialized,value:moduleValue,activation:moduleActivation,configuration};
      });
    };
    for(const task of tasks.filter(task=>task.activation.git))modulePlans.set(task,collectModules(task.value,task.layout?.commonDir??task.storage?.gitDir??path.join(task.destination,'.git'),task.destination,task.activation,0));
    const read=(name:string)=>{const encoded=originals.get(name);if(encoded===undefined)return;return decodePortableMetadataArtifact(encoded,1024*1024);};
    const compileModules=(modules:NativeReviewedGitModulePlan[])=>{for(const module of modules){const children=module.configuration.modules??[];compileModules(children);module.configuration={...compileReviewedGitConfiguration(module.value,module.activation,{common:module.gitDir,private:module.gitDir},read),modules:children};}};
    for(const task of tasks.filter(task=>task.activation.git)){const modules=modulePlans.get(task)!;compileModules(modules);task.configuration={...compileReviewedGitConfiguration(task.value,task.activation,{common:task.layout?.commonDir??task.storage?.gitDir??path.join(task.destination,'.git'),private:task.layout?.privateDir??task.storage?.gitDir??path.join(task.destination,'.git')},read),modules};}
    const owners=new Map<string,{task:RecoveryTask;module:NativeReviewedGitModulePlan}>();
    const recordModules=(task:RecoveryTask,modules:NativeReviewedGitModulePlan[])=>{for(const module of modules){if(module.initialized){const prior=owners.get(module.worktreePath);if(prior&&prior.module.gitDir!==module.gitDir)throw new Error('Two native modules claim the same destination worktree');if(!prior)owners.set(module.worktreePath,{task,module});}recordModules(task,module.configuration.modules??[]);}};
    for(const task of tasks.filter(task=>task.activation.git))recordModules(task,task.configuration!.modules??[]);
    for(const task of tasks.filter(task=>task.activation.git)){
      const owner=owners.get(task.destination);if(!owner)continue;
      if(owner.task===task||JSON.stringify(task.value.git)!==JSON.stringify(owner.module.value.git)||JSON.stringify(task.value.providerFiles.filter(file=>file.path.startsWith('.git/')))!==JSON.stringify(owner.module.value.providerFiles))throw new Error('Captured module and selected Agent repository disagree; re-export one coherent source');
      if(task.storage?.gitDir!==owner.module.gitDir)throw new Error('Selected module storage must match its parent repository destination topology');
      task.moduleOwner={ref:owner.task.ref,gitDir:owner.module.gitDir};task.configuration=owner.module.configuration;
      task.activation={...owner.module.activation,harness:task.activation.harness};
    }
    const ordered:RecoveryTask[]=[],visiting=new Set<string>();
    const visit=(task:RecoveryTask)=>{if(ordered.includes(task))return;if(visiting.has(task.ref))throw new Error('Native module destination ownership cycle');visiting.add(task.ref);if(task.moduleOwner){const owner=tasks.find(other=>other.ref===task.moduleOwner!.ref);if(!owner)throw new Error('Native module owner is outside the selected package');visit(owner);}visiting.delete(task.ref);ordered.push(task);};
    for(const task of tasks)visit(task);tasks.splice(0,tasks.length,...ordered);
  }
  const signatures=new Map<string,string>(),privatePaths=new Set<string>();
  const moduleSignature=(modules:readonly NativeReviewedGitModulePlan[]):unknown=>modules.map(module=>{
    const {modules:_modules,...git}=module.value.git as NonNullable<ReviewedUserData['git']>&{modules?:unknown};
    return {gitDir:module.gitDir,worktreePath:module.worktreePath,initialized:module.initialized,git,originals:module.value.providerFiles,configuration:module.configuration.common.toString('base64'),privateConfiguration:module.configuration.private?.toString('base64'),includes:module.configuration.includeFiles?.map(file=>({path:file.path,private:file.private,data:file.data.toString('base64')})),modules:moduleSignature(module.configuration.modules??[])};
  });
  for(const task of tasks.filter(task=>task.layout)){
    const {commonDir,privateDir}=task.layout!;
    if(privatePaths.has(privateDir))throw new Error('Two selected worktrees cannot claim the same destination private Git directory');privatePaths.add(privateDir);
    const git=task.value.git!;
    const sharedReftable=git.reftableReview?{source:git.reftableReview.source,tablesListBase64:git.reftableReview.tablesListBase64,tables:git.reftableReview.tables}:null;
    const signature=JSON.stringify({format:git.format,reftable:sharedReftable,objects:git.objects,refs:git.refs.filter(ref=>!privateRef(ref.name)),reflogs:git.reflogs.filter(log=>log.path!=='HEAD'&&!privateRef(log.path)),configuration:git.configurationOriginalReview[0],activeConfiguration:task.configuration?.common.toString('base64'),includes:task.configuration?.includeFiles?.filter(file=>!file.private).map(file=>({path:file.path,data:file.data.toString('base64')})),modules:moduleSignature(task.configuration?.modules??[]),info:git.infoReview,shallow:git.shallowReview,retention:git.packRetentionReview,originals:task.value.providerFiles.filter(file=>file.path.startsWith('.git/')&&!['COMMIT_EDITMSG','SQUASH_MSG','TAG_EDITMSG','MERGE_MSG','EDIT_DESCRIPTION'].includes(file.path.slice(5)))});
    if(signatures.has(commonDir)&&signatures.get(commonDir)!==signature)throw new Error('Selected common repository originals disagree; no destination has been changed');
    signatures.set(commonDir,signature);
  }
  return tasks;
}

/** Apply once to fresh recovery roots. An incomplete receipt never authorizes a retry. */
export async function applyReviewedRecoveryRoots(tasks:ReturnType<typeof planReviewedRecoveryRoots>,activation:ReviewedUserDataActivation,onReceipt:(receipt:RecoveryReceipt)=>void):Promise<void> {
  validateReviewedUserDataActivation(activation);
  const opened:Array<{path:string;handle:Awaited<ReturnType<typeof fs.open>>;device:bigint;inode:bigint}>=[];
  const commonCreated=new Set<string>();
  let failure:unknown;
  try{
    const rootPaths=new Set(tasks.flatMap(task=>task.roots));
    for(const root of rootPaths){
      const handle=await fs.open(root,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);
      const owned={path:root,handle,device:0n,inode:0n};opened.push(owned);
      const stat=await handle.stat({bigint:true});owned.device=stat.dev;owned.inode=stat.ino;
      if(!stat.isDirectory()||await fs.realpath(root)!==root)throw new Error('Recovery root is no longer canonical');
    }
    const check=async()=>{for(const owned of opened){const stat=await fs.lstat(owned.path,{bigint:true});if(!stat.isDirectory()||stat.dev!==owned.device||stat.ino!==owned.inode||await fs.realpath(owned.path)!==owned.path)throw new Error('Recovery root identity changed; preserve all partial state');}};
    const modules=(value:readonly NativeReviewedGitModulePlan[]):NativeReviewedGitModulePlan[]=>value.flatMap(module=>[module,...modules(module.configuration.modules??[])]);
    // Refuse every collision before creating the first native metadata entry.
    for(const task of tasks){
      await check();
      if(task.activation.git){try{await fs.lstat(path.join(task.destination,'.git'));throw new Error('Recovery root already has native Git metadata');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
      if(task.activation.harness)await assertReviewedProviderDestination(task.destination,task.value);
      if(task.activation.git)for(const name of task.configuration!.targets.filter(target=>!task.configuration!.includes.some(include=>include.destination===target))){
        const target=path.isAbsolute(name)?name:path.resolve(task.destination,name);
        const nativeOriginal=task.value.providerFiles.some(file=>{const installed=file.path.startsWith('.git/')?path.join(task.layout?.commonDir??task.storage?.gitDir??path.join(task.destination,'.git'),file.path.slice(5)):path.join(task.destination,file.path);return installed===target||installed.startsWith(target+path.sep);});
        if(nativeOriginal)continue;
        const resolved=await fs.realpath(target);
        if(![...rootPaths].some(root=>resolved===root||resolved.startsWith(root+path.sep)))throw new Error('Git path activation requires a transported target inside the selected fresh recovery roots');
      }
      if(task.layout&&task.layout.commonDir!==task.layout.commonRoot){try{await fs.lstat(task.layout.commonDir);throw new Error('Mapped common Git destination already exists');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
      if(task.layout)for(const name of ['objects','refs','worktrees','config','HEAD'])try{await fs.lstat(path.join(task.layout.commonDir,name));throw new Error('Mapped common Git destination already contains metadata');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(task.storage){
        if(!task.storage.existingRoot)try{await fs.lstat(task.storage.gitDir);throw new Error('Mapped module Git destination already exists');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        for(const name of ['objects','refs','config','HEAD'])try{await fs.lstat(path.join(task.storage.gitDir,name));throw new Error('Mapped module Git destination already contains metadata');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      }
      if(task.activation.git&&!task.moduleOwner)for(const module of modules(task.configuration!.modules??[])){
        await check();
        try{await fs.lstat(module.gitDir);throw new Error('Native module storage destination already exists');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        if(module.initialized){
          if(await fs.realpath(module.worktreePath)!==module.worktreePath||!(await fs.lstat(module.worktreePath)).isDirectory())throw new Error('Initialized module requires its transported fresh working folder');
          try{await fs.lstat(path.join(module.worktreePath,'.git'));throw new Error('Initialized module destination already has Git metadata');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
          for(const name of module.configuration.targets.filter(target=>!module.configuration.includes.some(include=>include.destination===target))){
            const target=path.isAbsolute(name)?name:path.resolve(module.worktreePath,name);
            if(module.value.providerFiles.some(file=>{const installed=path.join(module.gitDir,file.path.slice(5));return installed===target||installed.startsWith(target+path.sep);}))continue;
            const resolved=await fs.realpath(target);
            if(![...rootPaths].some(root=>resolved===root||resolved.startsWith(root+path.sep)))throw new Error('Module Git path activation requires a transported target in selected fresh roots');
          }
        }
      }
    }
    for(const task of tasks){
      const receipt:RecoveryReceipt={ref:task.ref,path:task.destination,originalSha256:task.sha256,selection:task.activation,state:'applying'};onReceipt(receipt);
      try{
        await check();
        if(task.activation.git&&task.moduleOwner){
          const pointer=path.join(task.destination,'.git'),handle=await fs.open(pointer,constants.O_RDONLY|constants.O_NOFOLLOW);
          try{const before=await handle.stat({bigint:true});if(!before.isFile()||before.nlink!==1n||before.size>4096n)throw new Error('Adopted module pointer is not an exact native file');const data=await handle.readFile();if(data.toString()!=='gitdir: '+path.relative(task.destination,task.moduleOwner.gitDir).split(path.sep).join('/')+'\n')throw new Error('Module destination pointer differs from the parent recreation');const after=await handle.stat({bigint:true}),current=await fs.lstat(pointer,{bigint:true});if(after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeNs!==before.mtimeNs||current.dev!==before.dev||current.ino!==before.ino)throw new Error('Adopted module pointer changed');}finally{await handle.close();}
        }else if(task.activation.git){
          const fresh=task.layout?{target:task.layout.commonDir,root:task.layout.commonRoot}:task.storage?{target:task.storage.gitDir,root:task.storage.root}:undefined;
          if(fresh&&!commonCreated.has(fresh.target)&&fresh.target!==fresh.root){
            let parent=fresh.root;
            for(const component of path.relative(parent,fresh.target).split(path.sep)){
              parent=path.join(parent,component);
              try{await fs.mkdir(parent,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||parent===fresh.target)throw error;}
              if(await fs.realpath(parent)!==parent||!(await fs.lstat(parent)).isDirectory())throw new Error('Mapped Git destination parent changed');
            }
          }
          await createReviewedRecoveryGit(task.destination,task.data,task.sha256,task.activation,task.layout?{commonDir:task.layout.commonDir,privateDir:task.layout.privateDir,writeCommon:!commonCreated.has(task.layout.commonDir)}:undefined,task.configuration,task.storage?{...task.storage,existingRoot:true}:undefined);
          if(task.layout)commonCreated.add(task.layout.commonDir);
        }
        if(task.activation.harness)await applyReviewedProviderData(task.destination,task.data,task.sha256,{git:false,harness:true});
        await check();receipt.state='completed';onReceipt(receipt);
      }catch(error){
        const primary=error instanceof Error?error:new Error(String(error)),details=error as {code?:string;observed?:unknown};
        receipt.state='incomplete';receipt.error={code:details.code??'ERR_RECOVERY_APPLICATION_PARTIAL',message:redactPortableDiagnostic(primary.message),partialStatePossible:true,observed:details.observed===undefined?null:JSON.parse(JSON.stringify(details.observed,(_key,value)=>typeof value==='bigint'?value.toString():value))};
        try{onReceipt(receipt);}catch(receiptError){Object.assign(primary,{receiptError});primary.message+='; the failure receipt could not be saved: '+redactPortableDiagnostic((receiptError as Error).message??String(receiptError));}
        throw primary;
      }
    }
  }catch(error){failure=error;}
  finally{
    const cleanup:unknown[]=[];for(const owned of opened.reverse())try{await owned.handle.close();}catch(error){cleanup.push(error);}
    if(cleanup.length)failure=Object.assign(new Error((failure instanceof Error?failure.message+'; ':'')+'Recovery descriptor cleanup failed; preserve all destination roots',{cause:failure??cleanup[0]}),{code:(failure as {code?:string}|undefined)?.code??'ERR_RECOVERY_CLEANUP_PARTIAL',partialStatePossible:true,observed:(failure as {observed?:unknown}|undefined)?.observed??null,cleanupErrors:cleanup});
  }
  if(failure)throw failure;
}
