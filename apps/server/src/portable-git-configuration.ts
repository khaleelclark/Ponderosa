import {createHash} from 'node:crypto';
import path from 'node:path';
import type {ReviewedUserData,ReviewedUserDataActivation} from '@ponderosa/core';
import {parseReviewedGitConfiguration,reviewedGitConfiguration,type NativeReviewedGitConfiguration} from './portable-reviewed-user-data.js';

/** Compile external includes only from transported originals, never historical host paths. */
export function compileReviewedGitConfiguration(value:ReviewedUserData,activation:ReviewedUserDataActivation,directories:{common:string;private:string},originals:ReadonlyMap<string,Buffer>|((path:string)=>Buffer|undefined)):NativeReviewedGitConfiguration {
  const git=value.git;if(!git)throw new Error('Git configuration has no selected repository');
  const includeFiles:NonNullable<NativeReviewedGitConfiguration['includeFiles']>=[],targets=new Set<string>(),includes:Array<{source:string;destination:string}>=[],files=new Map<string,string>();
  let bytes=0,count=0;
  const sourceDirectories=git.configurationSourceDirectories;
  const sourceDirectory=(privateSide:boolean)=>{
    if(sourceDirectories)return sourceDirectories[privateSide?'private':'common'];
    const binding=value.associationReview?.find(binding=>binding.role===(privateSide?'private':'common'));
    const root=binding?.capture?.roots.find(root=>root.rootRef===binding.storageRootRef);
    return root&&binding?path.posix.join(root.sourcePath,binding.relativePath):undefined;
  };
  const compile=(items:NonNullable<ReviewedUserData['git']>['configurationReview'],source:string|undefined,privateSide:boolean,stack:ReadonlySet<string>,depth:number):Buffer=>{
    if(depth>10)throw new Error('Git configuration include depth exceeds the native ten-level limit');
    const synthetic:ReviewedUserData={...value,git:{...git,configurationReview:items.map(({source:_source,...item})=>item),configurationOriginalReview:[git.configurationOriginalReview[0]!,{path:'config.worktree',source:'selected_worktree',dataBase64:null,removedFields:false}]}};
    const provenance=source?{common:source,private:source,...(sourceDirectories?.home?{home:sourceDirectories.home}:{})}:undefined;
    const plan=reviewedGitConfiguration(synthetic,activation,new Map(),provenance),overrides=new Map<string,string>();
    for(const target of plan.targets)targets.add(target);
    for(const request of plan.includes){
      includes.push(request);
      const identity=JSON.stringify([request.source,request.destination]);
      if(stack.has(identity))throw new Error('Git configuration include cycle; preserve the original package');
      const original=typeof originals==='function'?originals(request.destination):originals.get(request.destination);
      if(!original)throw new Error('Include the configured Git file in the export before activation: '+request.source);
      const parsed=parseReviewedGitConfiguration(original);
      if((bytes+=original.length)>32*1024*1024||++count>1000)throw new Error('Git configuration include closure exceeds its documented memory bound');
      const next=new Set(stack);next.add(identity);
      const data=compile(parsed.items,path.posix.dirname(request.source),privateSide,next,depth+1);
      const digest=createHash('sha256').update(request.source).update('\0').update(data).digest('hex'),relative='ponderosa-includes/'+digest+'.config';
      const destination=path.join(directories[privateSide?'private':'common'],relative),key=JSON.stringify([privateSide,relative]),prior=files.get(key);
      if(prior!==undefined&&prior!==data.toString('base64'))throw new Error('Conflicting included Git configuration identity');
      if(prior===undefined){files.set(key,data.toString('base64'));includeFiles.push({path:relative,data,private:privateSide});}
      if(overrides.has(request.destination)&&overrides.get(request.destination)!==destination)throw new Error('Ambiguous relocated Git include');
      overrides.set(request.destination,destination);
    }
    return reviewedGitConfiguration(synthetic,activation,overrides,provenance).common;
  };
  const common=compile(git.configurationReview.filter(item=>!item.source),sourceDirectory(false),false,new Set(),0);
  const privateConfig=git.configurationOriginalReview[1]!.dataBase64===null?null:compile(git.configurationReview.filter(item=>item.source==='config.worktree'),sourceDirectory(true),true,new Set(),0);
  return {common,private:privateConfig,targets:[...targets],includes,includeFiles};
}
