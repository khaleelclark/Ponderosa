import {createHash} from 'node:crypto';
import path from 'node:path';
import type {NativeReviewedGitConfiguration} from './portable-reviewed-user-data.js';

type Location='gitdir'|'worktree';
type NodeLocation={path:string;context?:Location};
export interface NativeGitExternalApplication {
  directories:Array<NodeLocation&{mode:number;mtimeNs:string}>;
  files:Array<NodeLocation&{data:Buffer;mode:number;mtimeNs:string}>;
  links:Array<NodeLocation&{target:string;targetContext?:Location;kind:'symlink'|'hardlink';mtimeNs?:string}>;
}
export interface NativeGitExternalGraph {
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
/** Flatten only a declared owned native graph. Never follow links or read the host filesystem. */
export function getNativeGitExternalGraph(configuration:NativeReviewedGitConfiguration|undefined,context:{gitDir:string;worktreePath:string}):NativeGitExternalGraph{
  const result:NativeGitExternalGraph={directories:[],files:[],links:[]},nodes=new Map<string,{kind:'directory'|'file'|'link';value:unknown}>();let count=0;
  const add=(name:string,kind:'directory'|'file'|'link',value:unknown)=>{
    if(++count>10000)throw new Error('Native external graph exceeds its node bound');
    const key=nativeKey(name),prior=nodes.get(key);
    const signature=kind==='file'?JSON.stringify({...value as object,data:undefined,sha256:createHash('sha256').update((value as NativeGitExternalGraph['files'][number]).data).digest('hex')}):JSON.stringify(value);
    if(prior){if(prior.kind!==kind||prior.value!==signature)throw new Error('Conflicting native external destination ownership');return false;}
    nodes.set(key,{kind,value:signature});return true;
  };
  const collect=(config:NativeReviewedGitConfiguration|undefined,current:{gitDir:string;worktreePath:string},depth:number)=>{
    if(depth>32)throw new Error('Native external module graph exceeds its nesting bound');
    const plan=(config as (NativeReviewedGitConfiguration&{external?:NativeGitExternalApplication})|undefined)?.external;
    if(plan){
      const root=(location:Location|undefined)=>{if(location!==undefined&&location!=='gitdir'&&location!=='worktree')throw new Error('Unknown native external node context');return location==='worktree'?current.worktreePath:current.gitDir;};
      for(const node of plan.directories){const base=root(node.context),value={path:destination(base,node.path),root:base,mode:node.mode,mtimeNs:node.mtimeNs};if(add(value.path,'directory',value))result.directories.push(value);}
      for(const node of plan.files){const base=root(node.context),value={path:destination(base,node.path),root:base,data:node.data,mode:node.mode,mtimeNs:node.mtimeNs};if(add(value.path,'file',value))result.files.push(value);}
      for(const node of plan.links){const base=root(node.context),targetRoot=root(node.targetContext),value={path:destination(base,node.path),root:base,target:destination(targetRoot,node.target),targetRoot,kind:node.kind,text:'',...(node.mtimeNs!==undefined?{mtimeNs:node.mtimeNs}:{})};value.text=path.relative(path.dirname(value.path),value.target).split(path.sep).join('/')||'.';if(add(value.path,'link',value))result.links.push(value);}
    }
    for(const module of config?.modules??[])collect(module.configuration,{gitDir:module.gitDir,worktreePath:module.worktreePath},depth+1);
  };
  collect(configuration,context,0);
  for(const link of result.links){
    const target=nodes.get(nativeKey(link.target));if(!target)throw new Error('Native external alias target is outside its complete declared owned graph');
    if(link.kind==='hardlink'){
      if(target.kind!=='file')throw new Error('Native hardlink target must be a declared regular original');
      const original=result.files.find(file=>nativeKey(file.path)===nativeKey(link.target))!;
      if(link.mtimeNs!==undefined&&link.mtimeNs!==original.mtimeNs)throw new Error('Native hardlink timestamp differs from its one original inode');
    }
  }
  return result;
}
