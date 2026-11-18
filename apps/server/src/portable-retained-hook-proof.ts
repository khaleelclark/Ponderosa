import {createHash} from 'node:crypto';
import path from 'node:path';
import {constants,promises as fs} from '@ponderosa/native-host/fs';
import type {ReviewedUserData} from '@ponderosa/core';
import {sourcePathAbsolute,sourcePathKey,sourcePathsEqual} from './portable-source-paths.js';
import {GENERATED_HOOK_NAMESPACE,generatedHookName,generatedHookIdentity,type CanonicalGeneratedHooksProof,type GeneratedHookIdentity} from './portable-generated-hook-proof.js';

/** Check names/content against durable local operation authority. This reader
 * never follows a generated symlink or opens a historical source path. */
export async function verifyRetainedGeneratedHooks(root:string,manifest:ReviewedUserData,original:Buffer,authority:CanonicalGeneratedHooksProof|undefined):Promise<void> {
 function fail(message:string):never{throw new Error(message);}
 const fields=(value:unknown,required:readonly string[])=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==required.length||required.some(key=>!Object.hasOwn(value,key)))fail('Generated hook proof is not an exact local operation receipt');
 };
 if(!authority)fail('Generated hook namespace has no canonical local creation-operation proof; preserve its files separately');
 // Keep one immutable copy of the caller's canonical lookup result during IO.
 const proof=structuredClone(authority);fields(proof,['schema','operationId','sourceOriginalSha256','root','namespace','links']);fields(proof.root,['device','inode']);
 if(proof.schema!=='ponderosa.generated-hook-namespace.v1'||typeof proof.operationId!=='string'||!proof.operationId||proof.operationId.length>256||/[\x00-\x20\x7f]/.test(proof.operationId)||proof.sourceOriginalSha256!==createHash('sha256').update(original).digest('hex')||![proof.root.device,proof.root.inode].every(value=>typeof value==='string'&&/^(?:0|[1-9][0-9]{0,31})$/.test(value))||!Array.isArray(proof.links)||proof.links.length>1000)fail('Generated hook proof differs from this canonical original or local root');
 const identityKeys=['device','inode','mode','nlink','uid','gid','size','mtimeNs','ctimeNs'] as const;
 const identity=(value:GeneratedHookIdentity)=>{
  fields(value,identityKeys);
  if(identityKeys.some(key=>typeof value[key]!=='string'||!(key==='mtimeNs'||key==='ctimeNs'?/^(?:0|-?[1-9][0-9]{0,31})$/:/^(?:0|[1-9][0-9]{0,31})$/).test(value[key])))fail('Generated hook inode proof is malformed');
 };
 identity(proof.namespace);
 const sameIdentity=(actual:GeneratedHookIdentity,expected:GeneratedHookIdentity)=>identityKeys.every(key=>actual[key]===expected[key]);
 const family=manifest.gitExternalDependencies;
 if(!manifest.git||!family)fail('Retained original does not declare generated relative hook paths');
 const absent=new Set(family.absentPaths.map(sourcePathKey));
 const expected=new Set(family.bindings.filter(binding=>binding.kind==='hooks'&&!binding.default&&binding.context==='worktree'&&sourcePathsEqual(binding.contextSourcePath,family.sourceWorkingRoot)&&!sourcePathAbsolute(binding.rawValue,binding.contextSourcePath)&&!binding.rawValue.startsWith('~')&&!binding.rawValue.startsWith('%(')&&!absent.has(sourcePathKey(binding.resolvedPath))).map(binding=>generatedHookName(binding.sourceConfigPath,binding.rawValue)));
 const issued=new Map<string,CanonicalGeneratedHooksProof['links'][number]>();
 for(const link of proof.links){
  fields(link,['name','text','identity']);identity(link.identity);
  if(typeof link.name!=='string'||!/^[a-f0-9]{64}$/.test(link.name)||!expected.has(link.name)||issued.has(link.name)||typeof link.text!=='string'||!link.text||Buffer.byteLength(link.text)>8192||/[\x00-\x1f\x7f\\]/.test(link.text)||path.posix.isAbsolute(link.text)||/^[a-z]:/i.test(link.text)||path.posix.normalize(link.text)!==link.text)fail('Generated hook link is not the exact declared local path');
  issued.set(link.name,link);
 }
 if(issued.size!==expected.size)fail('Generated hook proof omits a retained relative-hook path');
 if(!path.isAbsolute(root)||path.resolve(root)!==root||await fs.realpath(root)!==root)fail('Generated hook root is not canonical');
 const handles:Array<Awaited<ReturnType<typeof fs.open>>>=[];let primary:unknown;
 try{
  const rootHandle=await fs.open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(rootHandle);const rootBefore=await rootHandle.stat({bigint:true});
  if(!rootBefore.isDirectory()||rootBefore.dev.toString()!==proof.root.device||rootBefore.ino.toString()!==proof.root.inode)fail('Generated hook root differs from its canonical operation');
  const review=path.join(root,'.ponderosa-portable-review'),reviewHandle=await fs.open(path.join(process.platform==='linux'?'/proc/self/fd/'+rootHandle.fd:root,'.ponderosa-portable-review'),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(reviewHandle);
  const reviewBefore=await reviewHandle.stat({bigint:true});if(!reviewBefore.isDirectory()||await fs.realpath(review)!==review)fail('Generated hook review parent changed');
  const namespace=path.join(root,GENERATED_HOOK_NAMESPACE),namespaceHandle=await fs.open(path.join(process.platform==='linux'?'/proc/self/fd/'+reviewHandle.fd:review,'active-git-hooks'),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(namespaceHandle);
  const namespaceBefore=await namespaceHandle.stat({bigint:true}),held=process.platform==='linux'?'/proc/self/fd/'+namespaceHandle.fd:namespace;
  if(!namespaceBefore.isDirectory()||!sameIdentity(generatedHookIdentity(namespaceBefore),proof.namespace)||await fs.realpath(namespace)!==namespace)fail('Generated hook namespace lost its canonical creation identity');
  const names=(await fs.readdir(held)).sort();
  if(JSON.stringify(names)!==JSON.stringify([...issued.keys()].sort()))fail('Unknown or missing generated hook namespace contents require separate preservation');
  for(const name of names){
   const link=issued.get(name)!,target=path.join(held,name),before=await fs.lstat(target,{bigint:true});
   if(!before.isSymbolicLink()||before.nlink!==1n||!sameIdentity(generatedHookIdentity(before),link.identity)||await fs.readlink(target)!==link.text)fail('Generated hook link changed from its canonical local operation');
   const after=await fs.lstat(target,{bigint:true});if(!sameIdentity(generatedHookIdentity(after),link.identity)||await fs.readlink(target)!==link.text)fail('Generated hook link changed during retained-original capture');
  }
  const currentRoot=await fs.lstat(root,{bigint:true}),currentReview=await fs.lstat(review,{bigint:true}),currentNamespace=await fs.lstat(namespace,{bigint:true}),retainedNamespace=await namespaceHandle.stat({bigint:true});
  if(currentRoot.dev!==rootBefore.dev||currentRoot.ino!==rootBefore.ino||currentReview.dev!==reviewBefore.dev||currentReview.ino!==reviewBefore.ino||!sameIdentity(generatedHookIdentity(currentNamespace),proof.namespace)||!sameIdentity(generatedHookIdentity(retainedNamespace),proof.namespace)||JSON.stringify((await fs.readdir(held)).sort())!==JSON.stringify(names)||await fs.realpath(root)!==root||await fs.realpath(review)!==review||await fs.realpath(namespace)!==namespace)fail('Generated hook namespace membership changed during capture');
 }catch(error){primary=error;throw error;}
 finally{
  const cleanup:unknown[]=[];for(const handle of handles.reverse())try{await handle.close();}catch(error){cleanup.push(error);}
  if(cleanup.length)throw Object.assign(new Error('Generated hook proof handle cleanup failed; preserve all source bytes',{cause:primary??cleanup[0]}),{code:(primary as {code?:string}|undefined)?.code??'ERR_GENERATED_HOOK_PROOF_CLEANUP',cleanupErrors:cleanup});
 }
}
