import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {promises as fs} from '@ponderosa/native-host/fs';
import {stableJson,publishManagedArtifactContentsAsync,type AgentStore} from '@ponderosa/agents';
import type {AgentDto,BranchPortableWorkingData,BranchImportFileSelections,ImportAgentPackageResponse,PortableAgentNodeDto} from '@ponderosa/core';
import type {AgentWorkingCopyService} from './agent-working-copy-service.js';
import {decodePortableArtifactData} from './agent-package-codec.js';
import {importWorkingFiles,importWorkingLinks,finalizeWorkingFolderMetadata,workingLinkCounts,validateWorkingRootNesting} from './portable-working-files.js';
import {applyReviewedRecoveryRoots,planReviewedRecoveryRoots} from './portable-git-recreation.js';
import {branchWorkingDataHash} from './branch-working-data.js';
import {applyReviewedProviderData,REVIEWED_USER_DATA_PATH} from './portable-reviewed-user-data.js';

type NativeReceipt=NonNullable<ImportAgentPackageResponse['reviewedUserDataApplications']>[number];
type MetadataReceipt=NonNullable<ImportAgentPackageResponse['reviewedMetadataApplications']>[number];
export interface BranchWorkingDataApplication {
 schema:'ponderosa.branch-working-application.v1';sourceSha256:string;inputSha256:string;
 state:'applying'|'completed'|'incomplete';phase:string;
 roots:Array<{ref:string;recoveryPath:string;livePath?:string;agentIds:string[];state:'planned'|'recovered'|'populated'|'completed'}>;
 artifacts:Array<{sourceRef:string;nodeRef:string;agentId:string;projectId:string;id:string;path:string;sha256:string;size:number}>;
 reviewedUserDataApplications:NativeReceipt[];reviewedMetadataApplications:MetadataReceipt[];
 error?:{message:string;code?:string;partialStatePossible:true};
}
export interface ApplyBranchWorkingDataInput {
 planId:string;data:BranchPortableWorkingData;agentIds:Record<string,string>;fileSelections:BranchImportFileSelections;
}
export class BranchWorkingDataHeldError extends Error{}
const key=(chatRef:string,agentRef:string)=>JSON.stringify([chatRef,agentRef]);
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);

/** The existing Branch plan owns this once-only physical phase; no carrier Agent or second importer exists. */
export async function applyBranchWorkingData(dataDir:string,store:AgentStore,workingCopies:AgentWorkingCopyService,input:ApplyBranchWorkingDataInput,onReceipt:(receipt:BranchWorkingDataApplication)=>void,signal?:AbortSignal):Promise<BranchWorkingDataApplication>{
 const {data,agentIds,fileSelections,planId}=input,pkg=data.package;
 if(branchWorkingDataHash({schema:data.schema,package:pkg,owners:data.owners})!==data.sha256)throw Error('Working-data carrier changed');
 const inputSha256=createHash('sha256').update(stableJson({sourceSha256:data.sha256,agentIds,fileSelections})).digest('hex');
 const agents=new Map<string,AgentDto>();
 for(const node of pkg.agents){
  const id=agentIds[node.ref],agent=id&&store.getAgent(id),owner=data.owners[node.ref];
  const resource=id&&store.sqlite.prepare("SELECT r.local_id FROM branch_installation_resources r JOIN agent_creation_operations o ON o.id=r.creation_operation_id WHERE r.local_id=? AND r.staging_plan_id=? AND r.state='staging' AND o.status='completed'").get(id,planId);
  if(!agent||!owner||!resource)throw Error('Working data requires its exact completed, idle staged Agent identities');
  agents.set(node.ref,agent);
 }
 const rootRefs=[...new Set(pkg.agents.map(node=>node.workingRootRef??node.ref))],destinations:Record<string,string>={};
 for(const [selectionKey,selection] of Object.entries(fileSelections)){
  for(const [ref,destination] of Object.entries(selection.workingRootDestinations??{})){
   if(!rootRefs.includes(ref)||destinations[ref]&&destinations[ref]!==destination)throw Error('Conflicting final working-root destination');
   destinations[ref]=destination;
  }
  if(selection.workingFilesDestination){
   const owners=Object.entries(data.owners).filter(([,owner])=>key(owner.chatRef,owner.agentRef)===selectionKey),refs=[...new Set(owners.map(([ref])=>pkg.agents.find(node=>node.ref===ref)!.workingRootRef!))];
   if(refs.length!==1||destinations[refs[0]!]&&destinations[refs[0]!]!==selection.workingFilesDestination)throw Error('A recovery folder must name one exact carrier root');
   destinations[refs[0]!]=selection.workingFilesDestination;
  }
 }
 if(Object.keys(destinations).length!==rootRefs.length||rootRefs.some(ref=>!destinations[ref]||!path.isAbsolute(destinations[ref]!)||path.resolve(destinations[ref]!)!==destinations[ref]))throw Error('Choose one canonical new recovery folder for every captured working root');
 validateWorkingRootNesting(new Set(rootRefs),pkg.workingRootNesting??[],destinations);
 const nativeChoices=Object.values(fileSelections).flatMap(choice=>choice.reviewedUserDataActivation?[choice.reviewedUserDataActivation]:[]);
 if(new Set(nativeChoices.map(choice=>stableJson(choice))).size>1)throw Error('Choose one consistent native activation for the complete working-folder closure');
 const native=nativeChoices[0];
 const metadataChoices=Object.values(fileSelections).flatMap(choice=>choice.reviewedMetadataActivation?[choice.reviewedMetadataActivation]:[]);
 const metadataFor=(ref:string)=>{const choices=metadataChoices.filter(choice=>choice.rootRefs.includes(ref));if(new Set(choices.map(choice=>stableJson(choice))).size>1)throw Error('Conflicting metadata activation for the same root');return choices[0];};
 const chatLive=(chatRef:string)=>Object.entries(fileSelections).some(([selectionKey,choice])=>JSON.parse(selectionKey)[0]===chatRef&&!!choice.workingFilesActivation);
 type Artifact={nodeRef:string;source:NonNullable<PortableAgentNodeDto['artifacts']>[number];id:string;data:Buffer;sha256:string;path:string;agent:AgentDto};
 const artifacts:Artifact[]=[];
 for(const node of pkg.agents)for(const source of node.artifacts??[]){
  signal?.throwIfAborted();const decoded=await decodePortableArtifactData(source),id=randomUUID();
  artifacts.push({nodeRef:node.ref,source,id,...decoded,path:'imported/'+id+path.extname(source.path).toLowerCase().slice(0,16),agent:agents.get(node.ref)!});
 }
 const roots=rootRefs.map(ref=>{
  const members=pkg.agents.filter(node=>(node.workingRootRef??node.ref)===ref),node=members.find(node=>node.workingFolder)??members[0]!;
  const selected=members.map(member=>chatLive(data.owners[member.ref]!.chatRef));
  if(selected.some(Boolean)&&!selected.every(Boolean))throw Error('Chats sharing a source working folder must activate that folder together');
  const live=selected.every(Boolean),agent=agents.get(node.ref)!,project=store.getProject(agent.projectId);
  if(!project)throw Error('Imported working-root Project disappeared');
  const files=members.flatMap(member=>(member.workingFiles??[]).map(file=>{const original=artifacts.find(item=>item.nodeRef===member.ref&&item.source.ref===file.artifactRef);if(!original)throw Error('Carrier working original is absent');return {...file,data:original.data,sha256:original.sha256,artifactRef:original.id};}));
  const paths=new Set<string>();for(const file of files){if(paths.has(file.path))throw Error('Physical root originals are duplicated');paths.add(file.path);}
  return {ref,members,node,agent,project,files,links:node.workingFolder?.links??[],metadata:metadataFor(ref),live,destination:destinations[ref]!,mode:node.workingCopyMode??'shared',livePath:undefined as string|undefined};
 });
 // A connected physical graph cannot be split between an independent recovery snapshot and live copies.
 const byRef=new Map(roots.map(root=>[root.ref,root]));
 const edges=roots.flatMap(root=>root.links.flatMap(link=>link.targetRootRef?[[root.ref,link.targetRootRef] as const]:[]));
 for(const binding of pkg.gitStorageBindings??[])edges.push([binding.worktreeRootRef,binding.storageRootRef]);
 for(const boundary of pkg.workingRootNesting??[])edges.push([boundary.parentRootRef,boundary.childRootRef]);
 for(const [left,right] of edges)if(byRef.get(left)!.live!==byRef.get(right)!.live)throw Error('Linked, nested and Git storage folders must activate together to preserve the complete physical graph');
 if(native)planReviewedRecoveryRoots(pkg,destinations,native);
 const ordered=[...roots].sort((a,b)=>a.destination.split(path.sep).length-b.destination.split(path.sep).length);
 const receipt:BranchWorkingDataApplication={schema:'ponderosa.branch-working-application.v1',sourceSha256:data.sha256,inputSha256,state:'applying',phase:'reserved',
  roots:roots.map(root=>({ref:root.ref,recoveryPath:root.destination,agentIds:root.members.map(member=>agents.get(member.ref)!.id),state:'planned'})),
  artifacts:artifacts.map(artifact=>({sourceRef:artifact.source.ref,nodeRef:artifact.nodeRef,agentId:artifact.agent.id,projectId:artifact.agent.projectId,id:artifact.id,path:artifact.path,sha256:artifact.sha256,size:artifact.data.length})),reviewedUserDataApplications:[],reviewedMetadataApplications:[]};
 const save=()=>onReceipt(JSON.parse(JSON.stringify(receipt)) as BranchWorkingDataApplication);
 const nativeReceipt=(value:NativeReceipt)=>{const prior=receipt.reviewedUserDataApplications.findIndex(item=>item.ref===value.ref&&item.path===value.path);if(prior<0)receipt.reviewedUserDataApplications.push(value);else receipt.reviewedUserDataApplications[prior]=value;save();};
 const metadataReceipt=(ref:string,destination:string,originalSha256:string)=>{const value:MetadataReceipt={ref,path:destination,originalSha256,state:'applying'};receipt.reviewedMetadataApplications.push(value);save();return value;};
 const releases:Array<()=>void>=[];
 save(); // Exact identities and every proposed path are durable before the first physical mutation.
 try{
  signal?.throwIfAborted();receipt.phase='publishing-originals';save();
  for(const projectId of new Set(artifacts.map(artifact=>artifact.agent.projectId))){
   const selected=artifacts.filter(artifact=>artifact.agent.projectId===projectId);
   await publishManagedArtifactContentsAsync(dataDir,projectId,selected.map(artifact=>({artifactId:artifact.id,input:artifact.data})));
   store.recordProjectArtifacts(selected.map(artifact=>({artifact:{id:artifact.id,projectId,agentId:artifact.agent.id,originAgentId:artifact.agent.id,kind:artifact.source.kind,path:artifact.path,summary:artifact.source.summary??path.basename(artifact.source.path),createdAt:artifact.source.createdAt,mediaType:artifact.source.mediaType??'application/octet-stream',visibility:artifact.source.visibility??'project',pinned:artifact.source.pinned??false,size:artifact.data.length,sha256:artifact.sha256,...(artifact.source.sourcePath?{sourcePath:artifact.source.sourcePath}:{})}})));
  }
  for(const node of pkg.agents){
   const originals=(node.workingFiles??[]).map(file=>({...file,artifactRef:artifacts.find(artifact=>artifact.nodeRef===node.ref&&artifact.source.ref===file.artifactRef)!.id}));
   await store.attachImportedWorkingStateAsync(agents.get(node.ref)!.id,planId,{workingFiles:originals,...(node.workingFolder?{workingFolder:node.workingFolder}:{})});
  }
  receipt.phase='recovery-folders';save();
  const recoveryIdentity=new Map<string,{device:bigint;inode:bigint}>();
  for(const root of ordered){
   signal?.throwIfAborted();
   await importWorkingFiles(root.destination,root.files,root.node.workingFolder?.directories??[],undefined,undefined,root.links,root.node.workingFolder?.cyclicLinks,root.metadata,true,destinations,true);
   const identity=await fs.lstat(root.destination,{bigint:true});recoveryIdentity.set(root.ref,{device:identity.dev,inode:identity.ino});
   receipt.roots.find(item=>item.ref===root.ref)!.state='recovered';save();
  }
  for(const root of roots)await importWorkingLinks(root.destination,root.links,destinations);
  receipt.phase='live-allocation';save();
  const liveRoots=roots.filter(root=>root.live),initialized=new Set<string>();
  for(const id of new Set(liveRoots.flatMap(root=>root.members.map(member=>agents.get(member.ref)!.id))))releases.push(workingCopies.beginModeChange(id));
  for(const root of liveRoots){
   signal?.throwIfAborted();
   if(root.mode==='separate_git'){
    if(root.members.length!==1)throw Error('A Separate working root must have one exact Agent owner');
    if(native?.git)root.agent=await workingCopies.allocateImportedSeparateGit(root.agent,root.project);
    else{
     if(!initialized.has(root.project.id)){if(store.isManagedProjectImportDestination(root.project.id))await workingCopies.initializeImportProject(root.project);initialized.add(root.project.id);}
     root.agent=await workingCopies.setMode(root.agent,root.project,'separate_git');
    }
    agents.set(root.node.ref,root.agent);
   }
   root.livePath=root.agent.workingCopy.rootPath;
   if(root.mode==='shared'&&root.members.some(member=>agents.get(member.ref)!.workingCopy.rootPath!==root.livePath))throw Error('Shared working-root membership differs from its canonical destination Projects');
   if(native?.git&&root.mode==='shared')await workingCopies.stageImportedSharedGit(root.project,store.listAgents(root.project.id).map(agent=>agent.id));
   receipt.roots.find(item=>item.ref===root.ref)!.livePath=root.livePath;save();
  }
  const finalDestinations={...destinations,...Object.fromEntries(liveRoots.map(root=>[root.ref,root.livePath!]))};
  validateWorkingRootNesting(new Set(rootRefs),pkg.workingRootNesting??[],finalDestinations);
  const liveActivation=native?{...native,...(native.gitPathMappings?{gitPathMappings:native.gitPathMappings.map(mapping=>{const source=Object.entries(destinations).filter(([,root])=>mapping.destination===root||mapping.destination.startsWith(root+path.sep)).sort((a,b)=>b[1].length-a[1].length)[0];if(!source)throw Error('Git mapping lost its selected recovery root');return {...mapping,destination:path.join(finalDestinations[source[0]]!,path.relative(source[1],mapping.destination))};})}:{})}:undefined;
  const nativeTasks=liveActivation?planReviewedRecoveryRoots(pkg,finalDestinations,liveActivation):[];
  receipt.phase='live-folders';save();
  for(const root of [...liveRoots].sort((a,b)=>a.livePath!.split(path.sep).length-b.livePath!.split(path.sep).length)){
   await workingCopies.populateImportedRoot(root.agent,root.project,root.files,root.node.workingFolder?.directories??[],undefined,path.join(root.livePath!,'.ponderosa-import-backups'),root.links,root.node.workingFolder?.cyclicLinks,liveActivation?.git?{...liveActivation,harness:nativeTasks.find(task=>task.ref===root.ref)?.activation.harness??false}:undefined,root.metadata,finalDestinations,true,true);
   receipt.roots.find(item=>item.ref===root.ref)!.state='populated';save();
  }
  for(const root of liveRoots)await importWorkingLinks(root.livePath!,root.links,finalDestinations);
  receipt.phase='native-settings';save();
  if(liveActivation?.git&&liveRoots.length){
   for(const root of roots.filter(root=>!root.live)){
    const task=nativeTasks.find(task=>task.ref===root.ref);
    if(task?.activation.harness)await applyReviewedProviderData(root.destination,task.data,task.sha256,{git:false,harness:true});
    await workingCopies.retainImportedRecoveryGitRoot(root.destination,recoveryIdentity.get(root.ref)!);
   }
   await workingCopies.completeImportedGitRoots(liveRoots[0]!.project,pkg,finalDestinations,liveActivation,nativeReceipt,[...new Set(liveRoots.flatMap(root=>root.members.map(member=>agents.get(member.ref)!.id)))]);
  }else if(native)await applyReviewedRecoveryRoots(planReviewedRecoveryRoots(pkg,finalDestinations,liveActivation??native),liveActivation??native,nativeReceipt);
  receipt.phase='final-metadata';save();
  const links=roots.map(root=>({ref:root.ref,links:root.links}));
  for(const root of [...ordered].reverse()){
   const meta=root.node.workingFolder,original=root.files.find(file=>file.path===REVIEWED_USER_DATA_PATH),ordinary=meta?.mode!==undefined&&meta.mtime?{mode:meta.mode,mtime:meta.mtime}:undefined;
   const recovery=root.metadata&&original?metadataReceipt(root.ref,root.destination,original.sha256):undefined;
   await finalizeWorkingFolderMetadata(root.destination,root.files,meta?.directories??[],ordinary,root.links,root.metadata,workingLinkCounts(root.ref,links));
   if(recovery){recovery.state='completed';save();}
  }
  for(const root of [...liveRoots].sort((a,b)=>b.livePath!.split(path.sep).length-a.livePath!.split(path.sep).length)){
   const meta=root.node.workingFolder,original=root.files.find(file=>file.path===REVIEWED_USER_DATA_PATH),value=root.metadata&&original?metadataReceipt(root.ref,root.livePath!,original.sha256):undefined;
   await workingCopies.finalizeImportedRootMetadata(store.getAgent(root.agent.id)!,root.project,root.files,meta?.directories??[],meta?.mode!==undefined&&meta.mtime?{mode:meta.mode,mtime:meta.mtime}:undefined,root.links,root.metadata,workingLinkCounts(root.ref,links));
   if(value){value.state='completed';save();}
  }
  for(const root of receipt.roots)root.state='completed';receipt.phase='completed';receipt.state='completed';save();return receipt;
 }catch(error){
  receipt.state='incomplete';receipt.error={message:errorText(error),code:(error as {code?:string}).code,partialStatePossible:true};
  for(const value of receipt.reviewedMetadataApplications)if(value.state==='applying'){value.state='incomplete';value.error={code:receipt.error.code,partialStatePossible:true,observed:null};}
  try{save();}catch(persistence){throw new BranchWorkingDataHeldError('Physical outcome and receipt persistence are uncertain. Preserve every reserved root: '+errorText(persistence));}
  throw new BranchWorkingDataHeldError('Working-folder restoration is incomplete; partial roots and exact originals are retained. Inspect the saved receipt before any separate action: '+errorText(error));
 }finally{for(const release of releases.reverse())release();}
}
