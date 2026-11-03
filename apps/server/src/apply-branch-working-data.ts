import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {promises as fs} from '@ponderosa/native-host/fs';
import {stableJson,publishManagedArtifactContentsAsync,type AgentStore} from '@ponderosa/agents';
import type {AgentDto,BranchPortableWorkingData,BranchImportFileSelections,ImportAgentPackageResponse,PortableAgentNodeDto} from '@ponderosa/core';
import type {AgentWorkingCopyService} from './agent-working-copy-service.js';
import {portableApplicationFailure} from './portable-application-error.js';
import {validatePortableAgentPackage} from './portable-agent-package-validation.js';
import {assertAgentPackageMemoryAvailable,decodePortableArtifactData} from './agent-package-codec.js';
import {importWorkingFiles,importWorkingLinks,finalizeWorkingFolderMetadata,workingLinkCounts,createWorkingNativeMetadataEvidence,validateWorkingRootNesting,type WorkingRootIdentity} from './portable-working-files.js';
import {applyReviewedRecoveryRoots,planReviewedRecoveryRoots} from './portable-git-recreation.js';
import {branchWorkingDataHash} from './branch-working-data.js';
import {REVIEWED_USER_DATA_PATH,verifyDormantModuleDeclarations} from './portable-reviewed-user-data.js';

type NativeReceipt=NonNullable<ImportAgentPackageResponse['reviewedUserDataApplications']>[number];
type MetadataReceipt=NonNullable<ImportAgentPackageResponse['reviewedMetadataApplications']>[number];
export interface BranchWorkingDataApplication {
 schema:'ponderosa.branch-working-application.v1';sourceSha256:string;inputSha256:string;
 state:'applying'|'completed'|'incomplete';phase:string;
 roots:Array<{ref:string;recoveryPath:string;livePath?:string;agentIds:string[];state:'planned'|'recovered'|'populated'|'completed'}>;
 artifacts:Array<{sourceRef:string;nodeRef:string;agentId:string;projectId:string;id:string;path:string;sha256:string;size:number}>;
 reviewedUserDataApplications:NativeReceipt[];reviewedMetadataApplications:MetadataReceipt[];
 recoveryHolds?:Record<string,{state:'unavailable';message:string;code:string;at:string;memberIds?:string[];agentIds:string[];conversationId?:string}>;
 error?:ReturnType<typeof portableApplicationFailure>;
}
export interface BranchWorkingDataPreparation {
 sourceSha256:string;parentRootRef:string;childRootRef:string;parentAgentId:string;
 state:'reserving'|'reserved'|'incomplete';reservation?:Awaited<ReturnType<AgentWorkingCopyService['reserveImportedContainedRoot']>>;error?:string;
}
/** Separate roots carry one exclusive Agent owner; a Shared physical root
 * can only be activated for members that all retain Shared ownership. */
function assertLiveRootOwnership(pkg:BranchPortableWorkingData['package'],ref:string):void {
 const members=pkg.agents.filter(node=>(node.workingRootRef??node.ref)===ref);
 const modes=new Set(members.map(member=>member.workingCopyMode??'shared'));
 if(!members.length||modes.size!==1||modes.has('separate_git')&&members.length!==1)throw Error('Live working-root import requires one compatible ownership mode for every member');
}
export interface PrepareBranchWorkingDataChildInput {
 planId:string;data:BranchPortableWorkingData;parentRootRef:string;childRootRef:string;parentAgentId:string;previous?:BranchWorkingDataPreparation;
}
export async function prepareBranchWorkingDataChild(store:AgentStore,workingCopies:AgentWorkingCopyService,input:PrepareBranchWorkingDataChildInput,onReceipt:(receipt:BranchWorkingDataPreparation)=>void):Promise<NonNullable<BranchWorkingDataPreparation['reservation']>>{
 const boundary=input.data.package.workingRootNesting?.find(item=>item.parentRootRef===input.parentRootRef&&item.childRootRef===input.childRootRef);
 if(!boundary||branchWorkingDataHash({schema:input.data.schema,package:input.data.package,owners:input.data.owners})!==input.data.sha256)throw new Error('Contained root requires its exact reviewed carrier boundary');
 assertLiveRootOwnership(input.data.package,input.parentRootRef);
 const parentNode=input.data.package.agents.find(node=>(node.workingRootRef??node.ref)===input.parentRootRef&&node.workingFolder)??input.data.package.agents.find(node=>(node.workingRootRef??node.ref)===input.parentRootRef)!;
 let agent=store.getAgent(input.parentAgentId);const project=agent&&store.getProject(agent.projectId);
 const stagedOwner=agent&&store.sqlite.prepare("SELECT r.chat_ref,r.agent_ref FROM branch_installation_resources r JOIN agent_creation_operations o ON o.id=r.creation_operation_id WHERE r.local_id=? AND r.staging_plan_id=? AND r.state='staging' AND o.status='completed'").get(agent.id,input.planId) as {chat_ref:string;agent_ref:string}|undefined;
 const rootMember=stagedOwner&&input.data.package.agents.some(node=>{
  const owner=input.data.owners[node.ref];
  return (node.workingRootRef??node.ref)===input.parentRootRef&&owner?.chatRef===stagedOwner.chat_ref&&owner.agentRef===stagedOwner.agent_ref;
 });
 if(!agent||!project||!rootMember)throw new Error('Contained root parent is not the exact staged canonical import for the reviewed parent root');
 const release=workingCopies.beginModeChange(agent.id);
 const receipt:BranchWorkingDataPreparation={sourceSha256:input.data.sha256,parentRootRef:input.parentRootRef,childRootRef:input.childRootRef,parentAgentId:agent.id,state:'reserving'};
 try{
  if(input.previous){
   const prior=input.previous;
   if(prior.state!=='reserved'||!prior.reservation||prior.sourceSha256!==receipt.sourceSha256||prior.parentRootRef!==receipt.parentRootRef||prior.childRootRef!==receipt.childRootRef||prior.parentAgentId!==receipt.parentAgentId)throw new BranchWorkingDataHeldError('Contained directory preparation remains uncertain; inspect its original receipt');
   const issued=agent.workingCopy.containedRootPreparations?.find(item=>item.id===prior.reservation!.id),stat=await fs.lstat(prior.reservation.rootPath,{bigint:true});
   if(issued?.phase!=='created'||stat.dev.toString()!==prior.reservation.parent.device||stat.ino.toString()!==prior.reservation.parent.inode||await fs.realpath(prior.reservation.rootPath)!==prior.reservation.rootPath)throw new BranchWorkingDataHeldError('Contained directory preparation identity changed');
   return prior.reservation;
  }
  onReceipt(receipt);
  // A staged Shared folder belongs to the Project, not this parent's
  // separately selected root, even if another imported member staged it first.
  if(parentNode.workingCopyMode==='separate_git'&&agent.workingCopy.mode==='shared'){
   agent=await workingCopies.allocateImportedSeparateGit(agent,project);
  }else if(!await workingCopies.inspectPreparedImportedRoot(agent,project)){
   if(parentNode.workingCopyMode==='separate_git')agent=await workingCopies.allocateImportedSeparateGit(agent,project);
   else await workingCopies.stageImportedSharedGit(project,store.listAgents(project.id).map(item=>item.id));
  }
  const reservation=await workingCopies.reserveImportedContainedRoot(store.getAgent(agent.id)!,project,boundary.path);
  onReceipt({...receipt,state:'reserved',reservation});return reservation;
 }catch(error){if(!input.previous)onReceipt({...receipt,state:'incomplete',error:errorText(error)});throw error instanceof BranchWorkingDataHeldError?error:new BranchWorkingDataHeldError('Contained directory preparation is held without replay: '+errorText(error));}
 finally{release();}
}

export interface ApplyBranchWorkingDataInput {
 planId:string;data:BranchPortableWorkingData;agentIds:Record<string,string>;fileSelections:BranchImportFileSelections;preparations?:Record<string,BranchWorkingDataPreparation>;
}
export class BranchWorkingDataHeldError extends Error{}
export function branchWorkingDataInputHash(input:ApplyBranchWorkingDataInput):string{
 return createHash('sha256').update(stableJson({sourceSha256:input.data.sha256,agentIds:input.agentIds,fileSelections:input.fileSelections,preparations:input.preparations??{}})).digest('hex');
}
const key=(chatRef:string,agentRef:string)=>JSON.stringify([chatRef,agentRef]);
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);

export function branchWorkingRootDestinations(data:BranchPortableWorkingData,fileSelections:BranchImportFileSelections):Record<string,string>{
 const pkg=data.package;
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
 // One physical root cannot become incompatible live ownership modes. Make
 // this decision during preview, before reserving or writing any destination.
 for(const ref of rootRefs){
  const members=pkg.agents.filter(node=>(node.workingRootRef??node.ref)===ref);
  const selected=members.map(member=>{
   const owner=data.owners[member.ref];
   if(!owner)throw Error('Working root member requires its exact Chat owner');
   return Object.entries(fileSelections).some(([selectionKey,choice])=>JSON.parse(selectionKey)[0]===owner.chatRef&&!!choice.workingFilesActivation);
  });
  if(selected.some(Boolean)&&!selected.every(Boolean))throw Error('Chats sharing a source working folder must activate that folder together');
  if(selected.some(Boolean))assertLiveRootOwnership(pkg,ref);
 }
 validateWorkingRootNesting(new Set(rootRefs),pkg.workingRootNesting??[],destinations);
 return destinations;
}

/** The existing Branch plan owns this once-only physical phase; no carrier Agent or second importer exists. */
export async function applyBranchWorkingData(dataDir:string,store:AgentStore,workingCopies:AgentWorkingCopyService,input:ApplyBranchWorkingDataInput,onReceipt:(receipt:BranchWorkingDataApplication)=>void,signal?:AbortSignal):Promise<BranchWorkingDataApplication>{
 const {data,agentIds,fileSelections,planId}=input,pkg=data.package;
 if(branchWorkingDataHash({schema:data.schema,package:pkg,owners:data.owners})!==data.sha256)throw Error('Working-data carrier changed');
 const validated=validatePortableAgentPackage(pkg);assertAgentPackageMemoryAvailable(validated.totalArtifactBytes);
 const inputSha256=branchWorkingDataInputHash(input);
 const agents=new Map<string,AgentDto>();
 for(const node of pkg.agents){
  const id=agentIds[node.ref],agent=id&&store.getAgent(id),owner=data.owners[node.ref];
  const resource=id&&store.sqlite.prepare("SELECT r.local_id FROM branch_installation_resources r JOIN agent_creation_operations o ON o.id=r.creation_operation_id WHERE r.local_id=? AND r.staging_plan_id=? AND r.state='staging' AND o.status='completed'").get(id,planId);
  if(!agent||!owner||!resource)throw Error('Working data requires its exact completed, idle staged Agent identities');
  agents.set(node.ref,agent);
 }
 const rootRefs=[...new Set(pkg.agents.map(node=>node.workingRootRef??node.ref))],destinations=branchWorkingRootDestinations(data,fileSelections);
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
 const reviewCopies=new Map<string,{path:string;artifactRef:string;mode?:number;mtime?:string}>();
 for(const ref of rootRefs){
  const members=pkg.agents.filter(node=>(node.workingRootRef??node.ref)===ref),owner=members.find(node=>node.workingFiles?.some(file=>file.path===REVIEWED_USER_DATA_PATH));
  const file=owner?.workingFiles?.find(file=>file.path===REVIEWED_USER_DATA_PATH),original=file&&artifacts.find(artifact=>artifact.nodeRef===owner!.ref&&artifact.source.ref===file.artifactRef);
  if(!file||!original)continue;
  for(const chatRef of new Set(members.map(node=>data.owners[node.ref]!.chatRef))){
   if(data.owners[owner!.ref]!.chatRef===chatRef)continue;
   const member=members.find(node=>data.owners[node.ref]!.chatRef===chatRef)!,copy={...original,id:randomUUID(),nodeRef:member.ref,agent:agents.get(member.ref)!};
   copy.path='imported/'+copy.id+path.extname(original.source.path).toLowerCase().slice(0,16);artifacts.push(copy);reviewCopies.set(member.ref,{...file,artifactRef:copy.id});
  }
 }
 const roots=rootRefs.map(ref=>{
  const members=pkg.agents.filter(node=>(node.workingRootRef??node.ref)===ref),node=members.find(node=>node.workingFolder)??members[0]!;
  const selected=members.map(member=>chatLive(data.owners[member.ref]!.chatRef));
  if(selected.some(Boolean)&&!selected.every(Boolean))throw Error('Chats sharing a source working folder must activate that folder together');
  const live=selected.every(Boolean),representative=node.workingCopyMode==='separate_git'?node:members.find(member=>store.isManagedProjectImportDestination(agents.get(member.ref)!.projectId))??node,agent=agents.get(representative.ref)!,project=store.getProject(agent.projectId);
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
 if(native)for(const task of planReviewedRecoveryRoots(pkg,destinations,native))if(task.activation.git&&task.value.git)await verifyDormantModuleDeclarations(task.value.git);
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
  for(const id of new Set(roots.filter(root=>root.live).flatMap(root=>root.members.flatMap(member=>store.listAgents(agents.get(member.ref)!.projectId).map(agent=>agent.id)))))releases.push(workingCopies.beginModeChange(id));
  signal?.throwIfAborted();receipt.phase='publishing-originals';save();
  for(const projectId of new Set(artifacts.map(artifact=>artifact.agent.projectId))){
   const selected=artifacts.filter(artifact=>artifact.agent.projectId===projectId);
   await publishManagedArtifactContentsAsync(dataDir,projectId,selected.map(artifact=>({artifactId:artifact.id,input:artifact.data})));
   store.recordProjectArtifacts(selected.map(artifact=>({artifact:{id:artifact.id,projectId,agentId:artifact.agent.id,originAgentId:artifact.agent.id,kind:artifact.source.kind,path:artifact.path,summary:artifact.source.summary??path.basename(artifact.source.path),createdAt:artifact.source.createdAt,mediaType:artifact.source.mediaType??'application/octet-stream',visibility:artifact.source.visibility??'project',pinned:artifact.source.pinned??false,size:artifact.data.length,sha256:artifact.sha256,...(artifact.source.sourcePath?{sourcePath:artifact.source.sourcePath}:{})}})));
  }
  for(const node of pkg.agents){
   const originals=(node.workingFiles??[]).map(file=>({...file,artifactRef:artifacts.find(artifact=>artifact.nodeRef===node.ref&&artifact.source.ref===file.artifactRef)!.id}));
   const review=reviewCopies.get(node.ref);if(review)originals.push(review);
   await store.attachImportedWorkingStateAsync(agents.get(node.ref)!.id,planId,{workingFiles:originals,...(node.workingFolder?{workingFolder:node.workingFolder}:{})});
  }
  receipt.phase='recovery-folders';save();
  const recoveryIdentity=new Map<string,WorkingRootIdentity>(),liveIdentity=new Map<string,WorkingRootIdentity>(),nativeMetadata=createWorkingNativeMetadataEvidence();
  for(const root of ordered){
   signal?.throwIfAborted();
   const identity=await importWorkingFiles(root.destination,root.files,root.node.workingFolder?.directories??[],undefined,undefined,root.links,root.node.workingFolder?.cyclicLinks,root.metadata,true,destinations,true);
   recoveryIdentity.set(root.ref,identity);
   receipt.roots.find(item=>item.ref===root.ref)!.state='recovered';save();
  }
  for(const root of roots)await importWorkingLinks(root.destination,root.links,destinations,undefined,recoveryIdentity.get(root.ref));
  receipt.phase='live-allocation';save();
  const liveRoots=roots.filter(root=>root.live);
  const liveByRef=new Map(liveRoots.map(root=>[root.ref,root]));
  const allocated=new Set<string>();
  const allocate=async(ref:string):Promise<void>=>{
   if(allocated.has(ref))return;
   const root=liveByRef.get(ref);if(!root)throw Error('Contained live root parent was not selected');
   signal?.throwIfAborted();
   const boundary=pkg.workingRootNesting?.find(item=>item.childRootRef===ref);
   if(boundary){
    await allocate(boundary.parentRootRef);const parent=liveByRef.get(boundary.parentRootRef)!;
    let reservation=input.preparations?.[ref]?.reservation;
    if(!reservation)reservation=await workingCopies.reserveImportedContainedRoot(store.getAgent(parent.agent.id)!,parent.project,boundary.path);
    receipt.phase='binding-contained-project';receipt.roots.find(item=>item.ref===root.ref)!.livePath=reservation.rootPath;save();
    root.agent=root.mode==='shared'&&root.project.hostPath!==reservation.rootPath?await workingCopies.bindImportedContainedProject(store.getAgent(root.agent.id)!,root.project,reservation,planId):await workingCopies.bindImportedContainedRoot(store.getAgent(root.agent.id)!,root.project,reservation,root.mode);
    root.project=store.getProject(root.agent.projectId)!;
    if(root.mode==='shared')for(const projectId of new Set(root.members.map(member=>agents.get(member.ref)!.projectId))){
     if(projectId===root.project.id)continue;const member=root.members.find(member=>agents.get(member.ref)!.projectId===projectId)!,alias=agents.get(member.ref)!,project=store.getProject(projectId)!;
     if(project.hostPath!==reservation.rootPath)await workingCopies.bindImportedContainedProjectAlias(store.getAgent(alias.id)!,project,root.agent,planId);
    }
   }else{
    const current=store.getAgent(root.agent.id)!;
    // A Shared root may already be staged for another member of this Project.
    // It does not prepare this Agent's independently selected Separate root.
    if(root.mode==='separate_git'&&current.workingCopy.mode==='shared'){
     root.agent=await workingCopies.allocateImportedSeparateGit(current,root.project);
    }else{
     const prepared=await workingCopies.inspectPreparedImportedRoot(current,root.project);
     if(!prepared){
      if(root.mode==='separate_git')root.agent=await workingCopies.allocateImportedSeparateGit(current,root.project);
      else await workingCopies.stageImportedSharedGit(root.project,store.listAgents(root.project.id).map(agent=>agent.id));
     }else if(prepared.phase!=='allocated')throw Error('Live root preparation is no longer in its exact empty phase');
    }
   }
   for(const member of root.members)agents.set(member.ref,store.getAgent(agents.get(member.ref)!.id)!);
   root.livePath=root.agent.workingCopy.rootPath;
   if(root.mode==='shared'&&root.members.some(member=>agents.get(member.ref)!.workingCopy.rootPath!==root.livePath))throw Error('Shared working-root membership differs from its canonical destination Projects');
   receipt.roots.find(item=>item.ref===root.ref)!.livePath=root.livePath;save();allocated.add(ref);
  };
  for(const root of liveRoots)await allocate(root.ref);
  for(const root of liveRoots){root.agent=store.getAgent(root.agent.id)!;root.project=store.getProject(root.agent.projectId)!;}
  const finalDestinations={...destinations,...Object.fromEntries(liveRoots.map(root=>[root.ref,root.livePath!]))};
  validateWorkingRootNesting(new Set(rootRefs),pkg.workingRootNesting??[],finalDestinations);
  const liveActivation=native?{...native,...(native.gitPathMappings?{gitPathMappings:native.gitPathMappings.map(mapping=>{const source=Object.entries(destinations).filter(([,root])=>mapping.destination===root||mapping.destination.startsWith(root+path.sep)).sort((a,b)=>b[1].length-a[1].length)[0];if(!source)throw Error('Git mapping lost its selected recovery root');return {...mapping,destination:path.join(finalDestinations[source[0]]!,path.relative(source[1],mapping.destination))};})}:{})}:undefined;
  receipt.phase='live-folders';save();
  for(const root of [...liveRoots].sort((a,b)=>a.livePath!.split(path.sep).length-b.livePath!.split(path.sep).length)){
   const identity=await workingCopies.populateImportedRoot(root.agent,root.project,root.files,root.node.workingFolder?.directories??[],undefined,path.join(root.livePath!,'.ponderosa-import-backups'),root.links,root.node.workingFolder?.cyclicLinks,undefined,root.metadata,finalDestinations,true,true);liveIdentity.set(root.ref,identity);
   receipt.roots.find(item=>item.ref===root.ref)!.state='populated';save();
  }
  for(const root of liveRoots)await importWorkingLinks(root.livePath!,root.links,finalDestinations,{backupRoot:path.join(root.livePath!,'.ponderosa-import-backups')},liveIdentity.get(root.ref));
  let metadataStaged=false;
  const stageWorkingMetadata=async()=>{
   if(metadataStaged)return;
  receipt.phase='final-metadata';save();
  const links=roots.map(root=>({ref:root.ref,links:root.links}));
  for(const root of [...ordered].reverse()){
   const meta=root.node.workingFolder,original=root.files.find(file=>file.path===REVIEWED_USER_DATA_PATH),ordinary=meta?.mode!==undefined&&meta.mtime?{mode:meta.mode,mtime:meta.mtime}:undefined;
   const recovery=root.metadata&&original?metadataReceipt(root.ref,root.destination,original.sha256):undefined;
   await finalizeWorkingFolderMetadata(root.destination,root.files,meta?.directories??[],ordinary,root.links,root.metadata,workingLinkCounts(root.ref,links),recoveryIdentity.get(root.ref),nativeMetadata);
   if(recovery)save();
  }
  for(const root of [...liveRoots].sort((a,b)=>b.livePath!.split(path.sep).length-a.livePath!.split(path.sep).length)){
   const meta=root.node.workingFolder,original=root.files.find(file=>file.path===REVIEWED_USER_DATA_PATH),value=root.metadata&&original?metadataReceipt(root.ref,root.livePath!,original.sha256):undefined;
   await workingCopies.finalizeImportedRootMetadata(store.getAgent(root.agent.id)!,root.project,root.files,meta?.directories??[],meta?.mode!==undefined&&meta.mtime?{mode:meta.mode,mtime:meta.mtime}:undefined,root.links,root.metadata,workingLinkCounts(root.ref,links),nativeMetadata);
   if(value)save();
  }
   metadataStaged=true;
  };
  receipt.phase='native-settings';save();
  if(liveRoots.length){
   for(const root of roots.filter(root=>!root.live))await workingCopies.retainImportedRecoveryGitRoot(root.destination,recoveryIdentity.get(root.ref)!);
   await workingCopies.completeImportedGitRoots(liveRoots[0]!.project,pkg,finalDestinations,liveActivation,nativeReceipt,[...new Set(liveRoots.flatMap(root=>root.members.map(member=>agents.get(member.ref)!.id)))],nativeMetadata,stageWorkingMetadata);
  }else if(native)await applyReviewedRecoveryRoots(planReviewedRecoveryRoots(pkg,finalDestinations,liveActivation??native),liveActivation??native,nativeReceipt,Object.fromEntries(roots.map(root=>[root.destination,recoveryIdentity.get(root.ref)!])),nativeMetadata,stageWorkingMetadata);
  if(!metadataStaged)await stageWorkingMetadata();
  for(const value of receipt.reviewedMetadataApplications)if(value.state==='applying')value.state='completed';save();
  for(const root of receipt.roots)root.state='completed';receipt.phase='completed';receipt.state='completed';save();return receipt;
 }catch(error){
  receipt.state='incomplete';receipt.error=portableApplicationFailure(error);
  for(const value of receipt.reviewedMetadataApplications)if(value.state==='applying'){value.state='incomplete';value.error=portableApplicationFailure(error);}
  try{save();}catch(persistence){throw new BranchWorkingDataHeldError('Physical outcome and receipt persistence are uncertain. Preserve every reserved root: '+errorText(persistence));}
  throw new BranchWorkingDataHeldError('Working-folder restoration is incomplete; partial roots and exact originals are retained. Inspect the saved receipt before any separate action: '+errorText(error));
 }finally{for(const release of releases.reverse())release();}
}
