import {createHash} from 'node:crypto';
import path from 'node:path';
import type {ReviewedUserData,ReviewedUserDataActivation} from '@ponderosa/core';
import {sourcePathKey,sourcePathWithin,sourcePathsEqual,relativeSourcePath,dirnameSourcePath,joinSourcePath,sourcePathAbsolute} from './portable-source-paths.js';
import type {NativeReviewedGitConfiguration} from './portable-reviewed-user-data.js';

type Location='gitdir'|'private'|'worktree'|'owner'|'ownerWorktree';
type NodeLocation={path:string;context?:Location};
export interface NativeGitExternalApplication {
  rootMetadata?:{context:'worktree';mode:number;mtimeNs:string};
  absentPaths?:NodeLocation[];
  directories:Array<NodeLocation&{mode:number;mtimeNs:string}>;
  files:Array<NodeLocation&{data:Buffer;mode:number;mtimeNs:string}>;
  links:Array<NodeLocation&{target:string;targetContext?:Location;kind:'symlink'|'hardlink';mtimeNs?:string}>;
}
export interface NativeGitExternalGraph {
  rootMetadata:Array<{path:string;root:string;mode:number;mtimeNs:string}>;
  absentPaths:Array<{path:string;root:string}>;
  directories:Array<{path:string;root:string;mode:number;mtimeNs:string}>;
  files:Array<{path:string;root:string;data:Buffer;mode:number;mtimeNs:string}>;
  links:Array<{path:string;target:string;root:string;targetRoot:string;kind:'symlink'|'hardlink';text:string;mtimeNs?:string}>;
}
function relativeName(value:string):void{
  if(typeof value!=='string'||!value||Buffer.byteLength(value)>4096||value.includes('\\')||value.includes(':')||value.split('/').some(part=>!part||part==='.'||part==='..'||/[\x00-\x1f\x7f]/.test(part)))throw new Error('External Git nodes require canonical contained owned paths');
}
const nativeKey=(name:string)=>process.platform==='win32'?name.toLowerCase():name;
function destination(root:string,name:string):string{
  relativeName(name);if(!path.isAbsolute(root)||path.resolve(root)!==root)throw new Error('External Git context must be a canonical current-host root');
  const target=path.join(root,...name.split('/'));if(!target.startsWith(root+path.sep))throw new Error('External Git node leaves its owned context');return target;
}
type GraphContext={gitDir:string;privateDir?:string;worktreePath:string};
// Local planning authority only: neither portable data nor a destination file
// can grant a selected module a different top-level ownership context.
const graphOwners=new WeakMap<NativeReviewedGitConfiguration,{configuration:NativeReviewedGitConfiguration;context:GraphContext}>();
export function bindNativeGitExternalGraphOwner(configuration:NativeReviewedGitConfiguration,owner:NativeReviewedGitConfiguration,context:GraphContext):void {
  if(configuration===owner)return;
  let next={configuration:owner,context};const seen=new Set<NativeReviewedGitConfiguration>([configuration]);
  while(graphOwners.has(next.configuration)){if(seen.has(next.configuration))throw new Error('Native external graph owner cycle');seen.add(next.configuration);next=graphOwners.get(next.configuration)!;}
  if(next.configuration===configuration)throw new Error('Native external graph owner cycle');
  const prior=graphOwners.get(configuration);if(prior&&(prior.configuration!==next.configuration||JSON.stringify(prior.context)!==JSON.stringify(next.context)))throw new Error('Native module external graph already has another local owner');
  graphOwners.set(configuration,next);
}
/** Flatten only a declared owned native graph. Never follow links or read the host filesystem. */
export function getNativeGitExternalGraph(configuration:NativeReviewedGitConfiguration|undefined,context:{gitDir:string;privateDir?:string;worktreePath:string}):NativeGitExternalGraph{
  const owner=configuration?graphOwners.get(configuration):undefined;if(owner)return getNativeGitExternalGraph(owner.configuration,owner.context);
  const result:NativeGitExternalGraph={rootMetadata:[],absentPaths:[],directories:[],files:[],links:[]},nodes=new Map<string,{kind:'directory'|'file'|'link'|'absent';value:unknown}>(),rootReferences=new Set<string>();let count=0;
  const add=(name:string,kind:'directory'|'file'|'link'|'absent',value:unknown)=>{
    if(++count>10000)throw new Error('Native external graph exceeds its node bound');
    const key=nativeKey(name),prior=nodes.get(key);
    const stable={...value as object,root:undefined,targetRoot:undefined};
    const signature=kind==='file'?JSON.stringify({...stable,data:undefined,sha256:createHash('sha256').update((value as NativeGitExternalGraph['files'][number]).data).digest('hex')}):JSON.stringify(stable);
    if(prior){if(prior.kind!==kind||prior.value!==signature)throw new Error('Conflicting native external destination ownership');return false;}
    nodes.set(key,{kind,value:signature});return true;
  };
  const collect=(config:NativeReviewedGitConfiguration|undefined,current:{gitDir:string;privateDir?:string;worktreePath:string},depth:number)=>{
    if(depth>32)throw new Error('Native external module graph exceeds its nesting bound');
    const plan=(config as (NativeReviewedGitConfiguration&{external?:NativeGitExternalApplication})|undefined)?.external;
    if(plan){
      if(plan.rootMetadata){if(plan.rootMetadata.context!=='worktree')throw new Error('Root metadata requires the issued worktree root');const value={path:current.worktreePath,root:current.worktreePath,mode:plan.rootMetadata.mode,mtimeNs:plan.rootMetadata.mtimeNs};const prior=result.rootMetadata.find(row=>nativeKey(row.path)===nativeKey(value.path));if(prior&&(prior.mode!==value.mode||prior.mtimeNs!==value.mtimeNs))throw new Error('Conflicting root metadata');if(!prior){result.rootMetadata.push(value);add(value.path,'directory',value);}}
      const root=(location:Location|undefined)=>{if(location!==undefined&&!['gitdir','private','worktree','owner','ownerWorktree'].includes(location))throw new Error('Unknown native external node context');return location==='ownerWorktree'?context.worktreePath:location==='worktree'?current.worktreePath:location==='private'?current.privateDir??current.gitDir:location==='owner'?context.gitDir:current.gitDir;};
      for(const node of [...plan.directories,...plan.files,...plan.links])if(node.context==='owner'||node.context==='ownerWorktree')throw new Error('Top-level owner contexts are references, not node creation authority');
      for(const node of plan.absentPaths??[]){const base=root(node.context),value={path:destination(base,node.path),root:base};if(add(value.path,'absent',value))result.absentPaths.push(value);}
      for(const node of plan.directories){const base=root(node.context),value={path:destination(base,node.path),root:base,mode:node.mode,mtimeNs:node.mtimeNs};if(add(value.path,'directory',value))result.directories.push(value);}
      for(const node of plan.files){const base=root(node.context),value={path:destination(base,node.path),root:base,data:node.data,mode:node.mode,mtimeNs:node.mtimeNs};if(add(value.path,'file',value))result.files.push(value);}
      for(const node of plan.links){const base=root(node.context),targetRoot=root(node.targetContext),value={path:destination(base,node.path),root:base,target:node.target==='.'&&node.kind==='symlink'&&(node.targetContext==='worktree'||node.targetContext==='ownerWorktree')?targetRoot:destination(targetRoot,node.target),targetRoot,kind:node.kind,text:'',...(node.mtimeNs!==undefined?{mtimeNs:node.mtimeNs}:{})};if(node.target==='.')rootReferences.add(value.path);value.text=path.relative(path.dirname(value.path),value.target).split(path.sep).join('/')||'.';if(add(value.path,'link',value))result.links.push(value);}
    }
    for(const module of config?.modules??[])collect(module.configuration,{gitDir:module.gitDir,privateDir:module.layout?.privateDir??module.gitDir,worktreePath:module.worktreePath},depth+1);
  };
  collect(configuration,context,0);
  const aliases=(config:NativeReviewedGitConfiguration|undefined)=>{
    for(const alias of config?.workingAliases??[]){
      if(!path.isAbsolute(alias.path)||!path.isAbsolute(alias.target)||!path.isAbsolute(alias.rootPath)||!alias.path.startsWith(alias.rootPath+path.sep)||!alias.identity?.device||!alias.identity.inode)throw new Error('Working native alias lacks its issued contained-root proof');
      const original=result.files.find(file=>nativeKey(file.path)===nativeKey(alias.target));if(!original)throw new Error('Working native alias must target a declared native regular original');
      const value={path:alias.path,target:alias.target,root:alias.rootPath,targetRoot:original.root,kind:'hardlink' as const,text:path.relative(path.dirname(alias.path),alias.target).split(path.sep).join('/')};
      if(!nodes.has(nativeKey(value.path))&&add(value.path,'link',value))result.links.push(value);
    }
    for(const module of config?.modules??[])aliases(module.configuration);
  };aliases(configuration);
  for(const link of result.links){
    if(rootReferences.has(link.path)&&!result.rootMetadata.some(row=>nativeKey(row.path)===nativeKey(link.target)))throw new Error('Root symlink reference requires explicit issued-root metadata');
    const target=nodes.get(nativeKey(link.target));if(!target)throw new Error('Native external alias target is outside its complete declared owned graph');
    if(link.kind==='hardlink'){
      if(target.kind!=='file')throw new Error('Native hardlink target must be a declared regular original');
      const original=result.files.find(file=>nativeKey(file.path)===nativeKey(link.target))!;
      if(link.mtimeNs!==undefined&&link.mtimeNs!==original.mtimeNs)throw new Error('Native hardlink timestamp differs from its one original inode');
    }
  }
  return result;
}


export interface NativeExternalScope {
  value:ReviewedUserData;sourceWorkingRoot:string;sourceCommon:string;sourcePrivate:string;
  gitDir:string;privateDir:string;worktreePath:string;initialized:boolean;worktreeUnconfigured?:true;bare?:true;
  external:NativeGitExternalApplication;
}
export interface NativeExternalProjection {source:string;destination:string;value:string}
export interface PlannedGitExternalApplication {
  activation:ReviewedUserDataActivation;scopes:NativeExternalScope[];external:NativeGitExternalApplication;
  originals:ReadonlyMap<string,Buffer>;absentSources:ReadonlySet<string>;repositories:NativeExternalScope[];
  project(scope:{common:string;private:string},sourceConfigPath:string|undefined,key:string,rawValue:string):NativeExternalProjection|undefined;
}
const emptyApplication=():NativeGitExternalApplication=>({directories:[],files:[],links:[],absentPaths:[]});
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

// An external graph is authority only when produced by the local planner for
// these exact reviewed bytes and fresh destinations. Package JSON and caller
// supplied configuration objects cannot mint or clone this capability.
type PlanContext={common:string;private:string;worktree:string};
const issuedPlans=new WeakMap<PlannedGitExternalApplication,{source:string;context:string;signature:string;project:PlannedGitExternalApplication['project']}>();
const issuedConfigurations=new WeakMap<NativeReviewedGitConfiguration,{source:string;sha256:string;activation:string;context:string;signature:string;sealedSignature?:string}>();
const encoded=(value:unknown)=>digest(JSON.stringify(value));
const applicationSignature=(external:NativeGitExternalApplication|undefined)=>{
  if(!external)return null;
  const {worktreeIdentity:_identity,...content}=external as NativeGitExternalApplication&{worktreeIdentity?:unknown};
  return content;
};
function planSignature(plan:PlannedGitExternalApplication):string {
  return encoded({activation:plan.activation,scopes:plan.scopes.map(scope=>({...scope,external:applicationSignature(scope.external)})),
    originals:[...plan.originals].map(([name,data])=>[name,data.toString('base64')]),
    absentSources:[...plan.absentSources],repositories:plan.repositories.map(scope=>plan.scopes.indexOf(scope))});
}
function configurationSignature(config:NativeReviewedGitConfiguration,includeIdentity=false,depth=0,seen=new Set<NativeReviewedGitConfiguration>()):unknown {
  if(depth>32||seen.has(config))throw new Error('Native Git dependency configuration is cyclic or too deep');
  seen.add(config);
  const result={common:config.common.toString('base64'),private:config.private?.toString('base64')??null,
    targets:config.targets,includes:config.includes,includeFiles:config.includeFiles?.map(file=>({...file,data:file.data.toString('base64')})),
    external:includeIdentity?config.external:applicationSignature(config.external),modules:(config.modules??[]).map(module=>({
      gitDir:module.gitDir,worktreePath:module.worktreePath,initialized:module.initialized,
      worktreeUnconfigured:module.worktreeUnconfigured,bare:module.bare,layout:module.layout,
      value:module.value,activation:module.activation,configuration:configurationSignature(module.configuration,includeIdentity,depth+1,seen)}))};
  seen.delete(config);return result;
}
/** Bind the compiled graph to the issued planner and exact native owner. */
export function bindNativeGitExternalPlan(config:NativeReviewedGitConfiguration,plan:PlannedGitExternalApplication,value:ReviewedUserData,sha256:string,activation:ReviewedUserDataActivation,context:PlanContext):void {
  const issued=issuedPlans.get(plan);
  if(!issued||issued.source!==encoded(value)||issued.context!==encoded(context)||
    issued.project!==plan.project||encoded(plan.activation)!==encoded(activation)||config.external!==plan.external)
    throw new Error('Native Git requires its exact locally issued dependency plan');
  // Configuration compilation may add projections to the locally held plan.
  // Finalize its identity only after that compilation and before exposing tasks.
  issued.signature=planSignature(plan);
  const found=new Set<NativeExternalScope>();
  const check=(current:NativeReviewedGitConfiguration,scope:NativeExternalScope,depth:number)=>{
    if(depth>32||found.has(scope)||current.external!==scope.external)throw new Error('Native Git dependency graph differs from its issued plan');
    found.add(scope);
    for(const module of current.modules??[]){
      const matches=plan.scopes.filter(candidate=>candidate.gitDir===module.gitDir&&candidate.privateDir===(module.layout?.privateDir??module.gitDir)&&candidate.worktreePath===module.worktreePath);
      if(matches.length!==1||matches[0]!.initialized!==module.initialized||Boolean(matches[0]!.worktreeUnconfigured)!==Boolean(module.worktreeUnconfigured)||
        Boolean(matches[0]!.bare)!==Boolean(module.bare)||encoded(matches[0]!.value)!==encoded(module.value))throw new Error('Native Git dependency module differs from its issued owner');
      check(module.configuration,matches[0]!,depth+1);
    }
  };
  check(config,plan.scopes[0]!,0);
  if(found.size!==plan.scopes.length)throw new Error('Native Git dependency plan omits a reviewed repository');
  issuedConfigurations.set(config,{source:issued.source,sha256,activation:encoded(activation),context:issued.context,signature:encoded(configurationSignature(config))});
}
/** Freeze the late-issued worktree custody data only after apply has opened and
 * checked its destination roots, and before any receipt or native mutation. */
export function sealNativeGitExternalPlan(config:NativeReviewedGitConfiguration):void {
  const issued=issuedConfigurations.get(config);
  if(!issued||issued.signature!==encoded(configurationSignature(config)))throw new Error('Native Git dependency plan changed before destination preflight');
  const rootNodes=[...(config.external?.directories??[]),...(config.external?.files??[]),...(config.external?.links??[]),...(config.external?.absentPaths??[])];
  const ownerReference=(current:NativeReviewedGitConfiguration):boolean=>
    !!current.external?.links.some(link=>link.targetContext==='ownerWorktree')||(current.modules??[]).some(module=>ownerReference(module.configuration));
  if((rootNodes.some(node=>node.context==='worktree')||ownerReference(config))&&!config.external?.worktreeIdentity)
    throw new Error('External worktree nodes require the original issued import-root identity');
  const sealed=encoded(configurationSignature(config,true));
  if(issued.sealedSignature&&issued.sealedSignature!==sealed)throw new Error('Native Git dependency custody changed after preflight');
  issued.sealedSignature=sealed;
}
function hasExternalGraph(config:NativeReviewedGitConfiguration|undefined,seen=new Set<NativeReviewedGitConfiguration>()):boolean {
  if(!config)return false;
  if(seen.has(config))throw new Error('Native Git dependency configuration is cyclic');
  seen.add(config);
  return !!config.external||(config.modules??[]).some(module=>hasExternalGraph(module.configuration,seen));
}
/** Recheck before the first native write; mutable caller objects cannot change the graph. */
export function assertNativeGitExternalPlan(config:NativeReviewedGitConfiguration|undefined,value:ReviewedUserData,sha256:string,activation:ReviewedUserDataActivation,context:PlanContext):void {
  if(!value.gitExternalDependencies){if(hasExternalGraph(config))throw new Error('Native Git external graph lacks reviewed source evidence');return;}
  const issued=config&&issuedConfigurations.get(config);
  if(!issued||!issued.sealedSignature||issued.source!==encoded(value)||issued.sha256!==sha256||issued.activation!==encoded(activation)||
    issued.context!==encoded(context)||issued.signature!==encoded(configurationSignature(config!))||
    issued.sealedSignature!==encoded(configurationSignature(config!,true)))
    throw new Error('Native Git requires its exact locally issued dependency plan');
}

/** Build destinations and native setting projections only from inert, validated
 * bytes plus the human's selected fresh roots. No historical path is opened. */
export function planReviewedGitExternalApplication(value:ReviewedUserData,activation:ReviewedUserDataActivation,context:{common:string;private:string;worktree:string},selectedDestinations:readonly string[],transported:ReadonlyMap<string,Buffer>|((name:string)=>Buffer|undefined)):PlannedGitExternalApplication|undefined{
  const family=value.gitExternalDependencies;if(!family)return;
  if(!activation.git||!value.git)throw new Error('External Git application requires explicit native Git activation');
  const read=(name:string)=>typeof transported==='function'?transported(name):transported.get(name);
  const rootScope:NativeExternalScope={value,sourceWorkingRoot:family.sourceWorkingRoot,sourceCommon:value.git.configurationSourceDirectories?.common??dirnameSourcePath(family.bindings.find(binding=>binding.default)?.sourceConfigPath??family.sourceWorkingRoot),sourcePrivate:value.git.configurationSourceDirectories?.private??value.git.configurationSourceDirectories?.common??family.sourceWorkingRoot,gitDir:context.common,privateDir:context.private,worktreePath:context.worktree,initialized:true,external:emptyApplication()};
  const scopes:NativeExternalScope[]=[rootScope],repositories:NativeExternalScope[]=[],sourceMappings=new Map<string,{source:string;destination:string}>(),originals=new Map<string,Buffer>(),absentSources=new Set(family.absentPaths.map(sourcePathKey));
  const allowed=(target:string)=>[...selectedDestinations,context.common,context.private,context.worktree].some(root=>target===root||target.startsWith(root+path.sep));
  const bind=(source:string,target:string,required=false)=>{if(!allowed(target))throw new Error('External Git destination leaves the selected fresh import roots');const key=sourcePathKey(source),prior=sourceMappings.get(key);if(prior&&prior.destination!==target){if(required)throw new Error('External Git source mapping conflicts with its native destination context');return;}sourceMappings.set(key,{source,destination:target});};
  for(const mapping of activation.gitPathMappings??[])bind(mapping.source,mapping.destination);
  bind(rootScope.sourceWorkingRoot,context.worktree,true);bind(rootScope.sourceCommon,context.common,true);bind(rootScope.sourcePrivate,context.private,true);
  const mapped=(source:string):string|undefined=>{const match=[...sourceMappings.values()].sort((a,b)=>b.source.length-a.source.length).find(mapping=>sourcePathWithin(mapping.source,source));return match?path.join(match.destination,...relativeSourcePath(match.source,source).split('/')):undefined;};
  const ownedTree=(source:string)=>path.join(context.common,'ponderosa-external',digest(sourcePathKey(source)),'tree');
  const moduleScopes=(parent:NativeExternalScope,depth=0)=>{
    if(depth>32)throw new Error('External Git repository nesting exceeds its bound');
    for(const module of parent.value.git?.modules??[]){
      const gitDir=path.join(parent.gitDir,'modules',...module.name.split('/'));
      const worktreePath=module.worktreeRelativePath!==null?path.join(parent.worktreePath,...module.worktreeRelativePath.split('/')):mapped(module.source.worktreePath)??ownedTree(module.source.worktreePath);
      if(module.source.coreWorktree===null){
        const explicit=mapped(module.source.worktreePath),blob=parent.value.git!.objects.find(object=>object.oid===module.source.dormantAssociation!.gitmodulesOid&&object.type==='blob');
        if(explicit&&explicit!==worktreePath)throw new Error('Dormant module destination must follow the selected parent declaration');
        if(!blob||!read(path.join(parent.worktreePath,'.gitmodules'))?.equals(Buffer.from(blob.dataBase64,'base64')))throw new Error('Dormant module needs its exact selected .gitmodules original');
      }
      bind(module.source.storagePath,gitDir,true);bind(module.source.worktreePath,worktreePath,true);
      const childValue:ReviewedUserData={version:1,activation:'inert_review_only',selection:{git:true,harness:false},recreationScope:value.recreationScope,git:module.git,providerFiles:module.originals,providerDirectories:[],exclusions:[]};
      const scope:NativeExternalScope={value:childValue,sourceWorkingRoot:module.source.worktreePath,sourceCommon:module.git.configurationSourceDirectories?.common??module.source.storagePath,sourcePrivate:module.git.configurationSourceDirectories?.private??module.source.storagePath,gitDir,privateDir:gitDir,worktreePath,initialized:module.source.initialized,...(module.source.coreWorktree===null?{worktreeUnconfigured:true as const}:{}),external:emptyApplication()};scopes.push(scope);moduleScopes(scope,depth+1);
    }
  };
  moduleScopes(rootScope);
  const storageRoots=()=>[...scopes.flatMap(scope=>[scope.sourceCommon,scope.sourcePrivate]),...(family.repositories??[]).flatMap(capsule=>[capsule.git.configurationSourceDirectories?.common,capsule.git.configurationSourceDirectories?.private].filter((root):root is string=>!!root))];
  const sourceStorageOwner=(source:string)=>storageRoots().filter(root=>sourcePathWithin(root,source)).sort((a,b)=>b.length-a.length).map(sourcePathKey)[0];
  const sourceStorage=(source:string)=>sourceStorageOwner(source)!==undefined;
  // Bare repositories can appear inside a captured dependency tree. Their
  // canonical native control originals may then be represented both by the
  // Git capsule and by the enclosing external tree. Reuse is safe only when
  // both retained views are exactly the same file; never decide after writes.
  for(const capsule of family.repositories??[]){
    if(!capsule.bare)continue;
    const controls:Array<{path:string;dataBase64:string|null}>=[
      ...capsule.git.infoReview,
      {path:'info/sparse-checkout',dataBase64:capsule.git.sparseReview.patternsBase64},
    ];
    const info=joinSourcePath(capsule.sourcePath,'info');
    if(family.files.some(file=>sourcePathsEqual(file.sourcePath,info))||
      family.links.some(link=>sourcePathsEqual(link.sourcePath,info))||
      controls.some(control=>control.dataBase64!==null)&&
        [...family.absentPaths,...family.omittedPaths].some(absent=>sourcePathsEqual(absent,info)))
      throw new Error('Bare Git control parent differs between its reviewed capsule and external graph');
    for(const control of controls){
      const source=joinSourcePath(capsule.sourcePath,control.path);
      if(family.links.some(link=>sourcePathsEqual(link.sourcePath,source)||sourcePathsEqual(link.targetSourcePath,source)))
        throw new Error('Bare Git control original with an external alias requires separate reviewed custody');
      if(family.directories.some(directory=>sourcePathsEqual(directory.sourcePath,source))||
        control.dataBase64!==null&&[...family.absentPaths,...family.omittedPaths].some(absent=>sourcePathsEqual(absent,source)))
        throw new Error('Bare Git control original differs between its reviewed capsule and external graph');
      const duplicate=family.files.find(file=>sourcePathsEqual(file.sourcePath,source));
      if(control.dataBase64!==null&&!duplicate||
        duplicate&&(control.dataBase64===null||!Buffer.from(duplicate.dataBase64,'base64').equals(Buffer.from(control.dataBase64,'base64'))))
        throw new Error('Bare Git control original differs between its reviewed capsule and external graph');
    }
  }
  const treeDestination=(source:string)=>{
    const nativeDefault=family.bindings.find(binding=>binding.default&&sourcePathsEqual(binding.resolvedPath,source));
    const defaultScope=nativeDefault?scopes.find(scope=>sourcePathsEqual(joinSourcePath(scope.sourceCommon,'config'),nativeDefault.sourceConfigPath)):undefined;
    if(defaultScope)return {target:path.join(defaultScope.gitDir,'hooks'),scope:defaultScope,context:'gitdir' as const};
    const selectedRootScope=scopes.filter(scope=>sourcePathsEqual(scope.sourceWorkingRoot,source)&&!scope.worktreePath.startsWith(context.common+path.sep)&&selectedDestinations.some(root=>scope.worktreePath===root||scope.worktreePath.startsWith(root+path.sep))).sort((a,b)=>b.sourceWorkingRoot.length-a.sourceWorkingRoot.length)[0];
    if(selectedRootScope)return {target:selectedRootScope.worktreePath,scope:selectedRootScope,context:'worktree' as const};
    const workingScope=scopes.filter(scope=>!sourcePathsEqual(scope.sourceWorkingRoot,source)&&sourcePathWithin(scope.sourceWorkingRoot,source)&&!sourceStorage(source)).sort((a,b)=>b.sourceWorkingRoot.length-a.sourceWorkingRoot.length).find(scope=>family.files.filter(file=>sourcePathWithin(source,file.sourcePath)&&!sourceStorage(file.sourcePath)).every(file=>read(path.join(scope.worktreePath,...relativeSourcePath(scope.sourceWorkingRoot,file.sourcePath).split('/')))?.equals(Buffer.from(file.dataBase64,'base64'))));
    return workingScope?{target:path.join(workingScope.worktreePath,...relativeSourcePath(workingScope.sourceWorkingRoot,source).split('/')),scope:workingScope,context:'worktree' as const}:{target:ownedTree(source),scope:rootScope,context:'gitdir' as const};
  };
  for(const capsule of family.repositories??[]){
    const outer=[...family.directories].filter(folder=>folder.root&&sourcePathWithin(folder.sourcePath,capsule.sourcePath)).sort((a,b)=>a.sourcePath.length-b.sourcePath.length)[0];
    const worktreePath=outer?path.join(treeDestination(outer.sourcePath).target,...relativeSourcePath(outer.sourcePath,capsule.sourcePath).split('/')):mapped(capsule.sourcePath)??ownedTree(capsule.sourcePath),bare=(capsule as typeof capsule&{bare?:true}).bare;
    const gitDir=bare?worktreePath:path.join(context.common,'ponderosa-repositories',digest(sourcePathKey(capsule.sourcePath)));
    bind(capsule.sourcePath,worktreePath,true);
    const capsuleValue:ReviewedUserData={version:1,activation:'inert_review_only',selection:{git:true,harness:false},recreationScope:value.recreationScope,git:capsule.git,providerFiles:capsule.originals,providerDirectories:[],exclusions:[]};
    const scope:NativeExternalScope={value:capsuleValue,sourceWorkingRoot:capsule.sourcePath,sourceCommon:capsule.git.configurationSourceDirectories?.common??joinSourcePath(capsule.sourcePath,'.git'),sourcePrivate:capsule.git.configurationSourceDirectories?.private??joinSourcePath(capsule.sourcePath,'.git'),gitDir,privateDir:capsule.git.reftableReview?.selectedWorktree?path.join(gitDir,'worktrees','imported'):gitDir,worktreePath,initialized:!bare,...(bare?{bare}:{}),external:emptyApplication()};
    bind(scope.sourceCommon,scope.gitDir,true);bind(scope.sourcePrivate,scope.privateDir,true);scopes.push(scope);repositories.push(scope);moduleScopes(scope);
  }
  type Placement={scope:NativeExternalScope;context:'gitdir'|'private'|'worktree';path:string;absolute:string};
  const dataRoots:Array<{source:string;placement:Placement}>=[];
  const place=(scope:NativeExternalScope,base:'gitdir'|'private'|'worktree',target:string):Placement=>{const root=base==='worktree'?scope.worktreePath:base==='private'?scope.privateDir:scope.gitDir;const relative=path.relative(root,target).split(path.sep).join('/');if(relative)relativeName(relative);return {scope,context:base,path:relative,absolute:target};};
  for(const folder of [...family.directories].filter(folder=>folder.root).sort((a,b)=>a.sourcePath.length-b.sourcePath.length)){
    const isDefault=family.bindings.some(binding=>binding.default&&sourcePathsEqual(binding.resolvedPath,folder.sourcePath));
    // A selected worktree root can contain its native Git storage. A hook
    // rooted at that storage must not inherit the worktree's byte-phase
    // directory authority or collide with the Git directory being created.
    if(!isDefault&&dataRoots.some(root=>sourcePathWithin(root.source,folder.sourcePath)&&sourceStorageOwner(root.source)===sourceStorageOwner(folder.sourcePath)))continue;
    const choice=treeDestination(folder.sourcePath),target=choice.target,placement=place(choice.scope,choice.context,target);
    dataRoots.push({source:folder.sourcePath,placement});sourceMappings.set(sourcePathKey(folder.sourcePath),{source:folder.sourcePath,destination:target});
  }
  const placements=new Map<string,Placement>();
  const placement=(source:string):Placement=>{
    const key=sourcePathKey(source),prior=placements.get(key);if(prior)return prior;
    const nativeConfiguration=scopes.some(scope=>sourcePathsEqual(source,joinSourcePath(scope.sourceCommon,'config'))||sourcePathsEqual(source,joinSourcePath(scope.sourcePrivate,'config.worktree')));
    const root=nativeConfiguration?undefined:dataRoots.filter(root=>sourcePathWithin(root.source,source)).sort((a,b)=>b.source.length-a.source.length)[0];
    const result=root?place(root.placement.scope,root.placement.context,path.join(root.placement.absolute,...relativeSourcePath(root.source,source).split('/'))):place(rootScope,'gitdir',path.join(context.common,'ponderosa-external',digest(key),'original'));
    placements.set(key,result);sourceMappings.set(key,{source,destination:result.absolute});return result;
  };
  const payloadLinks=new Set(family.links.filter(link=>dataRoots.some(root=>sourcePathWithin(root.source,link.sourcePath))||family.bindings.some(binding=>sourcePathsEqual(binding.resolvedPath,link.sourcePath))).map(link=>sourcePathKey(link.sourcePath)));
  for(let pass=0;pass<=family.links.length;pass++){let changed=false;for(const link of family.links)if(payloadLinks.has(sourcePathKey(link.sourcePath))&&family.links.some(next=>sourcePathsEqual(next.sourcePath,link.targetSourcePath))&&!payloadLinks.has(sourcePathKey(link.targetSourcePath))){payloadLinks.add(sourcePathKey(link.targetSourcePath));changed=true;}if(!changed)break;}
  const payloadTargets=new Set(family.links.filter(link=>payloadLinks.has(sourcePathKey(link.sourcePath))).map(link=>sourcePathKey(link.targetSourcePath)));
  const putDirectory=(p:Placement,metadata:{mode:number;mtimeNs:string})=>{if(p.path)p.scope.external.directories.push({path:p.path,context:p.context,...metadata});else if(p.context==='worktree'){const prior=p.scope.external.rootMetadata;if(prior&&(prior.mode!==metadata.mode||prior.mtimeNs!==metadata.mtimeNs))throw new Error('Captured root metadata is inconsistent');p.scope.external.rootMetadata={context:'worktree',...metadata};}else throw new Error('Only an issued worktree root can carry root metadata');};
  for(const folder of family.directories)if(dataRoots.some(root=>sourcePathWithin(root.source,folder.sourcePath))||payloadTargets.has(sourcePathKey(folder.sourcePath)))putDirectory(placement(folder.sourcePath),{mode:folder.mode,mtimeNs:folder.mtimeNs});
  for(const file of family.files){const p=placement(file.sourcePath),data=Buffer.from(file.dataBase64,'base64');p.scope.external.files.push({path:p.path,context:p.context,data,mode:file.mode,mtimeNs:file.mtimeNs});originals.set(p.absolute,data);}
  const reference=(from:NativeExternalScope,target:Placement):{target:string;targetContext:Location}=>{
    if(from===target.scope&&!target.path&&target.context==='worktree'&&target.scope.external.rootMetadata)return {target:'.',targetContext:'worktree'};
    if(target.absolute===context.worktree&&rootScope.external.rootMetadata)return {target:'.',targetContext:'ownerWorktree'};
    if(from===target.scope&&target.path)return {target:target.path,targetContext:target.context};
    for(const [root,location] of [[context.common,'owner'],[context.worktree,'ownerWorktree']] as const){
      if(target.absolute.startsWith(root+path.sep)){const name=path.relative(root,target.absolute).split(path.sep).join('/');relativeName(name);return {target:name,targetContext:location};}
    }
    throw new Error('External alias target has no declared top-level owned context');
  };
  // Prefix aliases used to qualify source paths are provenance, not payload nodes.
  const payloadLink=(source:string)=>payloadLinks.has(sourcePathKey(source));
  for(const link of family.links){
    if(!payloadLink(link.sourcePath))continue;
    const p=placement(link.sourcePath),target=placement(link.targetSourcePath);relativeName(p.path);
    p.scope.external.links.push({path:p.path,context:p.context,...reference(p.scope,target),kind:link.kind,...(link.mtimeNs!==undefined?{mtimeNs:link.mtimeNs}:{})});
  }
  const absentDestination=(source:string)=>{const p=placement(source);relativeName(p.path);if(!p.scope.external.absentPaths!.some(node=>node.path===p.path&&node.context===p.context))p.scope.external.absentPaths!.push({path:p.path,context:p.context});return p.absolute;};
  for(const source of family.absentPaths)absentDestination(source);
  for(const source of family.omittedPaths){const target=mapped(source);if(!target||!read(target))throw new Error('Configured Git dependency was omitted, not observed absent; include a reviewed replacement before activation: '+source);originals.set(target,read(target)!);}
  const contextScope=(directories:{common:string;private:string})=>scopes.find(scope=>scope.gitDir===directories.common&&scope.privateDir===directories.private)??rootScope;
  const projection=(directories:{common:string;private:string},sourceConfigPath:string|undefined,key:string,rawValue:string):NativeExternalProjection|undefined=>{
    if(!sourceConfigPath)return;
    const kind=/^(?:include|includeif\..+)\.path$/i.test(key)?'include':/^core\.hookspath$/i.test(key)?'hooks':/^core\.attributesfile$/i.test(key)?'attributes':/^core\.excludesfile$/i.test(key)?'excludes':undefined;
    if(!kind)return;
    const scope=contextScope(directories),candidates=family.bindings.filter(binding=>!binding.default&&binding.kind===kind&&binding.rawValue===rawValue&&sourcePathsEqual(binding.sourceConfigPath,sourceConfigPath));
    if(!candidates.length)return;
    const bindings=candidates.filter(binding=>binding.context==='config'||binding.context==='worktree'&&sourcePathsEqual(binding.contextSourcePath,scope.sourceWorkingRoot)||binding.context==='gitdir'&&[scope.sourceCommon,scope.sourcePrivate].some(root=>sourcePathsEqual(binding.contextSourcePath,root)));
    if(!bindings.length)throw new Error('Configured Git dependency has no exact destination repository context');
    const first=bindings[0]!,target=mapped(first.resolvedPath)??absentDestination(first.resolvedPath);
    if(kind==='hooks'&&!sourcePathAbsolute(rawValue,first.contextSourcePath)&&!rawValue.startsWith('~')&&!rawValue.startsWith('%(')){
      const relative='.ponderosa-portable-review/active-git-hooks/'+digest(JSON.stringify([sourcePathKey(sourceConfigPath),rawValue]));
      for(const binding of bindings){
        if(scope.bare&&binding.context==='worktree')continue;
        const location=binding.context==='worktree'?'worktree':'private';
        if(absentSources.has(sourcePathKey(binding.resolvedPath))){if(!scope.external.absentPaths!.some(node=>node.path===relative&&node.context===location))scope.external.absentPaths!.push({path:relative,context:location});continue;}
        const original=placement(binding.resolvedPath),base=location==='worktree'?scope.worktreePath:scope.privateDir,ref=reference(scope,original);
        if(!scope.external.links.some(link=>link.path===relative&&link.context===location))scope.external.links.push({path:relative,context:location,...ref,kind:'symlink'});
        if(!base)throw new Error('Configured hook context has no fresh owned root');
      }
      return {source:first.resolvedPath,destination:target,value:relative};
    }
    if(bindings.some(binding=>!sourcePathsEqual(binding.resolvedPath,first.resolvedPath)))throw new Error('Configured Git paths have distinct contexts that cannot become one absolute scalar');
    return {source:first.resolvedPath,destination:target,value:target};
  };
  const plan:PlannedGitExternalApplication={activation:{...activation,gitPathMappings:[...sourceMappings.values()]},scopes,external:rootScope.external,originals,absentSources,repositories,project:projection};
  issuedPlans.set(plan,{source:encoded(value),context:encoded(context),signature:planSignature(plan),project:plan.project});
  return plan;
}

/** Exact generated views for canonical local issuance; never authority from package data. */
export function getNativeGitGeneratedHookViews(configuration:NativeReviewedGitConfiguration,context:{gitDir:string;privateDir?:string;worktreePath:string}):Array<{path:string;root:string;name:string;text:string}>{
  return getNativeGitExternalGraph(configuration,context).links.filter(link=>link.kind==='symlink'&&path.basename(path.dirname(link.path))==='active-git-hooks'&&/^[a-f0-9]{64}$/.test(path.basename(link.path))).map(link=>({path:link.path,root:link.root,name:path.basename(link.path),text:link.text}));
}
