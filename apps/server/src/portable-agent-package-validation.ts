import {portableChatTitleHistoryError} from "@ponderosa/core";
import {decodePortableMetadataArtifact} from './agent-package-codec.js';
import {createHash} from 'node:crypto';
import {assertPortableSecretsAbsent} from './portable-secrets.js';
import {portableWorkingPath,validateWorkingTopology,validateMappedWorkingLinks,orderWorkingRoots,validateWorkingFileData,validateWorkingRootNesting} from './portable-working-files.js';
import {BUILT_IN_CAPABILITIES,parseConnectorCapabilityId} from '@ponderosa/core';
import {validatePortableCommunication} from './portable-communication.js';
import {validateOutputRoles} from './portable-output-roles.js';
import {validateMemorySnapshot} from './portable-memory-snapshot.js';
import {normalizeAgentRole,AGENT_PACKAGE_MAX_AGENTS,agentPackageJsonUtf8Bytes,agentPackageTextIsWellFormed,AGENT_PACKAGE_ARTIFACT_MAX_BYTES,AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL,MAX_WORKING_FILE_PARTS,WORKING_FILE_PART_MEDIA_TYPE,type AgentPortablePackageDto,type PortableArtifactDto} from '@ponderosa/core';
import {CANONICAL_ARTIFACT_ID,collectReachableArtifactIds,portableAgentTopologyError} from './artifact-refs.js';
import {exactObjectFields,validatedObject} from './object-validation.js';
import {validatePortableGitStorageBindings,parseReviewedUserData,gitBindingSourceEvidence} from './portable-reviewed-user-data.js';
import {portableArtifactByteLength} from './agent-package-codec.js';


export interface ValidatedPortableAgentPackage {
  package: AgentPortablePackageDto;
  artifactBytes: ReadonlyMap<PortableArtifactDto,number>;
  totalArtifactBytes: number;
}

/** Mutation-free parser shared by standalone and Branch package imports. */
export function validatePortableAgentPackage(value:unknown):ValidatedPortableAgentPackage {
  const record=validatedObject(value,'Agent package');
  exactObjectFields(record,['schema','mode','kind','exportedAt','sourceLabel','sourceProjectInstructions','chatTitleHistory','rootRef','rootRefs','agents','memory','outputRoles','gitStorageBindings','workingRootNesting'],'Agent package');
  if(record.schema!=='ponderosa.agent-package.v1'||(record.mode!=='template'&&record.mode!=='full')||!Array.isArray(record.agents)||record.agents.length<1)throw new Error('invalid Ponderosa Agent package');
  if(record.agents.length>AGENT_PACKAGE_MAX_AGENTS)throw Object.assign(new Error(`Agent package contains ${record.agents.length} Agents; the limit is ${AGENT_PACKAGE_MAX_AGENTS}`),{statusCode:413});
  if(typeof record.exportedAt!=='string'||!Number.isFinite(Date.parse(record.exportedAt))||typeof record.sourceLabel!=='string'||(record.sourceProjectInstructions!==undefined&&(typeof record.sourceProjectInstructions!=='string'||record.sourceProjectInstructions.length>100_000)))throw new Error('Agent package metadata is invalid');
  if(record.mode==='template'&&record.sourceProjectInstructions!==undefined)throw new Error('template packages cannot contain full-mode Project context');
  if(record.chatTitleHistory!==undefined){if(record.mode!=='full')throw Error('Template packages cannot contain Chat title history');const error=portableChatTitleHistoryError(record.chatTitleHistory);if(error)throw Error(error);}
  const portable=record as unknown as AgentPortablePackageDto;
  const topologyError=portableAgentTopologyError(portable);if(topologyError)throw new Error(topologyError);
  validateOutputRoles(portable.outputRoles,new Set(portable.agents.map(a=>a.ref)));
  agentPackageJsonUtf8Bytes(portable);
  const artifactBytes=new Map<PortableArtifactDto,number>(),artifactRefs=new Set<string>(),allTransportRefs=new Set<string>(),emptyWorkingRefs=new Set<string>();let totalArtifactBytes=0;
  for(const candidate of portable.agents as unknown[]){
    const node=validatedObject(candidate,'Agent package node');
    exactObjectFields(node,['ref','title','engine','model','effort','speed','role','presetSnapshot','accessSettings','workingCopyMode','sourceChat','workingFiles','workingFolder','workingRootRef','initialInstructions','managerRef','managementPermissions','history','artifacts'],'Agent package node');
    if(typeof node.ref!=='string'||typeof node.title!=='string'||typeof node.engine!=='string'||!node.engine.trim()||(node.model!==undefined&&typeof node.model!=='string')||(node.effort!==undefined&&typeof node.effort!=='string')||(node.initialInstructions!==undefined&&typeof node.initialInstructions!=='string'))throw new Error('every imported Agent must declare valid identity and runtime fields');
    if(typeof node.initialInstructions==='string'&&!agentPackageTextIsWellFormed(node.initialInstructions))throw new Error('Agent initial instructions must contain well-formed Unicode');
    for (const field of ['speed','role'] as const) {
      if (node[field] !== undefined && (typeof node[field] !== 'string' || !agentPackageTextIsWellFormed(node[field] as string))) throw new Error(`Agent ${field} must be well-formed text`);
    }
    if (node.role !== undefined) normalizeAgentRole(node.role as string);
    if (node.presetSnapshot !== undefined) {
      const preset = validatedObject(node.presetSnapshot, 'Agent preset snapshot');
      exactObjectFields(preset, ['id','name','description','guidance','engine','model','effort'], 'Agent preset snapshot');
      for (const key of ['id','name','description','guidance','engine']) if (typeof preset[key] !== 'string' || !agentPackageTextIsWellFormed(preset[key] as string)) throw new Error('Agent preset snapshot has invalid text');
      for (const key of ['model','effort']) if (preset[key] !== undefined && typeof preset[key] !== 'string') throw new Error('Agent preset snapshot has invalid selection');
    }
    if(node.workingRootRef!==undefined&&(portable.mode!=='full'||typeof node.workingRootRef!=='string'||!node.workingRootRef||node.workingRootRef.length>128))throw new Error('Invalid working-root identity');
    const largeRefs=new Set<string>();
    if(node.workingFiles!==undefined){
      if(portable.mode!=='full'||!Array.isArray(node.workingFiles)||node.workingFiles.length>10000)throw new Error('Selected working files require a bounded full package');
      const paths=new Set<string>();
      const ordinaryRefs:string[]=[];
      for(const candidate of node.workingFiles){
        const file=validatedObject(candidate,'Working file');
        exactObjectFields(file,['path','artifactRef','mode','mtime','parts'],'Working file');
        if(file.mode!==undefined&&(!Number.isInteger(file.mode)||Number(file.mode)<0||Number(file.mode)>0o777)||file.mtime!==undefined&&(typeof file.mtime!=='string'||!Number.isFinite(Date.parse(file.mtime))))throw new Error('Invalid working-file metadata');
        const relative=portableWorkingPath(file.path);
        if(paths.has(relative)||typeof file.artifactRef!=='string'||!Array.isArray(node.artifacts)||!node.artifacts.some(a=>a.ref===file.artifactRef))throw new Error('Working files need unique paths and included originals');
        paths.add(relative);
        if(file.parts===undefined){ordinaryRefs.push(file.artifactRef);continue;}
        const parts=validatedObject(file.parts,'Working-file parts');
        exactObjectFields(parts,['schema','refs','byteLength','sha256'],'Working-file parts');
        if(parts.schema!=='ponderosa.working-file-parts.v1'||!Array.isArray(parts.refs)||parts.refs.length<2||parts.refs.length>MAX_WORKING_FILE_PARTS
          ||parts.refs[0]!==file.artifactRef||parts.refs.some(ref=>typeof ref!=='string'||!CANONICAL_ARTIFACT_ID.test(ref))
          ||new Set(parts.refs).size!==parts.refs.length||!Number.isSafeInteger(parts.byteLength)||Number(parts.byteLength)<=64*1024*1024||Number(parts.byteLength)>AGENT_PACKAGE_ARTIFACT_MAX_BYTES
          ||typeof parts.sha256!=='string'||!/^[a-f0-9]{64}$/.test(parts.sha256))throw Error('Invalid working-file parts manifest');
        let bytes=0;
        for(const ref of parts.refs){
          if(largeRefs.has(ref))throw Error('Working-file parts cannot be shared between originals');
          largeRefs.add(ref);allTransportRefs.add(ref);
          const matching=node.artifacts.filter(artifact=>artifact.ref===ref);
          if(matching.length!==1||matching[0].kind!=='document'||matching[0].mediaType!==WORKING_FILE_PART_MEDIA_TYPE)throw Error('Working-file part needs one same-owner transport artifact');
          const size=portableArtifactByteLength(matching[0] as PortableArtifactDto);
          if(size<1)throw Error('Working-file parts cannot be empty');
          bytes+=size;
          if(bytes>AGENT_PACKAGE_ARTIFACT_MAX_BYTES)throw Error('Working-file parts exceed decoded package limit');
        }
        if(bytes!==parts.byteLength)throw Error('Working-file part lengths differ from the declared original');
      }
      if(ordinaryRefs.some(ref=>largeRefs.has(ref)))throw Error('Working-file parts cannot also be another original');
      for(const message of (node.history as AgentPortablePackageDto['agents'][number]['history']|undefined)??[]){
        const refs=[...(message.attachmentRefs??[]),...Object.values(message.artifactRefs??{}),...(message.communication?.artifactIds??[]),...(message.communication?.document?.artifactId?[message.communication.document.artifactId]:[])];
        if(refs.some(ref=>largeRefs.has(ref)))throw Error('Working-file transport parts cannot be history attachments');
      }
      for(const relative of paths)if(relative.split('/').slice(0,-1).some((_,i)=>paths.has(relative.split('/').slice(0,i+1).join('/'))))throw new Error('A working file cannot also be a parent folder');
    }
    if(node.workingFolder!==undefined){
      const folder=validatedObject(node.workingFolder,'Working folder');exactObjectFields(folder,['mode','mtime','directories','excludedPaths','links','cyclicLinks'],'Working folder');if(folder.mode!==undefined&&(!Number.isInteger(folder.mode)||Number(folder.mode)<0||Number(folder.mode)>0o777)||folder.mtime!==undefined&&(typeof folder.mtime!=='string'||!Number.isFinite(Date.parse(folder.mtime))))throw new Error('Invalid root-folder metadata');
      if(portable.mode!=='full'||!Array.isArray(folder.directories)||folder.directories.length>10000||!Array.isArray(folder.excludedPaths)||folder.excludedPaths.some(p=>typeof p!=='string'))throw new Error('Invalid working-folder manifest');
      if(folder.links!==undefined){if(!Array.isArray(folder.links)||folder.links.length>10000)throw new Error('Invalid working links');for(const candidate of folder.links)exactObjectFields(validatedObject(candidate,'Working link'),['path','kind','target','mtime','sourceTarget','targetRootRef'],'Working link');}
      if(folder.cyclicLinks!==undefined&&!['refuse','passive_in_root'].includes(String(folder.cyclicLinks)))throw new Error('Invalid working-link cycle policy');
      if(!node.workingRootRef)validateWorkingTopology((node.workingFiles??[]) as {path:string}[],folder.directories as {path:string}[],(folder.links??[]) as import('@ponderosa/core').PortableWorkingLinkDto[],folder.cyclicLinks as 'refuse'|'passive_in_root'|undefined);
      const paths=new Set<string>();
      for(const candidate of folder.directories){const dir=validatedObject(candidate,'Working directory');exactObjectFields(dir,['path','mode','mtime'],'Working directory');const relative=portableWorkingPath(dir.path);if(paths.has(relative)||!Number.isInteger(dir.mode)||Number(dir.mode)<0||Number(dir.mode)>0o777||typeof dir.mtime!=='string'||!Number.isFinite(Date.parse(dir.mtime)))throw new Error('Invalid working-directory metadata');paths.add(relative);}
      for(const relative of paths)if(relative.split('/').slice(0,-1).some((_,i)=>!paths.has(relative.split('/').slice(0,i+1).join('/'))))throw new Error('Whole-folder directory parents must be declared');
      if(((node.workingFiles as AgentPortablePackageDto['agents'][number]['workingFiles'])??[]).some(file=>paths.has(file.path)))throw new Error('Working files and directories must have distinct paths');
    }
    if(node.workingCopyMode!==undefined&&!['shared','separate_git'].includes(String(node.workingCopyMode)))throw new Error('Invalid portable working-copy mode');
    if(node.sourceChat!==undefined){const chat=validatedObject(node.sourceChat,'Source Chat');exactObjectFields(chat,['ref','title'],'Source Chat');if(typeof chat.ref!=='string'||!chat.ref||typeof chat.title!=='string')throw new Error('Invalid source Chat binding');}
    if(node.accessSettings!==undefined){const settings=validatedObject(node.accessSettings,'Access settings');exactObjectFields(settings,['restrictedCapabilityIds','readGlobalMemory','savedBrowserAllowed','browserMode','sourceProfileName'],'Access settings');for(const key of ['readGlobalMemory','savedBrowserAllowed'])if(settings[key]!==undefined&&typeof settings[key]!=='boolean')throw new Error('Invalid nonsecret grant preference');if(settings.browserMode!==undefined&&!['disposable','trusted'].includes(String(settings.browserMode))||settings.sourceProfileName!==undefined&&typeof settings.sourceProfileName!=='string')throw new Error('Invalid browser preference');if(!Array.isArray(settings.restrictedCapabilityIds)||settings.restrictedCapabilityIds.some(id=>typeof id!=='string'||!BUILT_IN_CAPABILITIES.some(cap=>cap.id===id)&&!parseConnectorCapabilityId(id)))throw new Error('Invalid portable capability restrictions');}
    const permissions=validatedObject(node.managementPermissions,'managementPermissions');
    exactObjectFields(permissions,['allowAutomaticDescendantDeletion','allowAutomaticDescendantReorganization'],'managementPermissions');
    if(typeof permissions.allowAutomaticDescendantDeletion!=='boolean'||typeof permissions.allowAutomaticDescendantReorganization!=='boolean')throw new Error('every imported Agent must declare exact boolean management permissions');
    if(portable.mode==='template'&&(node.history!==undefined||node.artifacts!==undefined))throw new Error('template packages cannot contain history or artifacts');
    if(node.history!==undefined&&!Array.isArray(node.history))throw new Error('Agent history must be an array');
    for(const messageCandidate of (node.history as unknown[]|undefined)??[]){
      const message=validatedObject(messageCandidate,'history message');exactObjectFields(message,['role','text','createdAt','communication','communicationRevisions','attachmentRefs','artifactRefs'],'history message');
      if(!['user','assistant','system'].includes(String(message.role))||typeof message.text!=='string'||(message.createdAt!==undefined&&(typeof message.createdAt!=='string'||!Number.isFinite(Date.parse(message.createdAt)))))throw new Error('Agent history messages have an invalid shape');
      if(message.communication!==undefined)validatePortableCommunication(message.communication);
      if(message.communicationRevisions!==undefined){
        if(!message.communication||!Array.isArray(message.communicationRevisions))throw new Error('Revisions require historical Communication');
        const source=message.communication as import('@ponderosa/core').CommunicationEvent;
        for(const candidate of message.communicationRevisions){const revision=validatedObject(candidate,'Communication revision');exactObjectFields(revision,['eventId','schemaVersion','kind','projectId','conversationId','targetEventId','sender','text','createdAt','idempotencyKey'],'Communication revision');assertPortableSecretsAbsent(revision,'Communication revisions');if(revision.schemaVersion!==1||revision.kind!=='edit'||revision.projectId!==source.projectId||revision.targetEventId!==source.eventId||typeof revision.text!=='string'||!agentPackageTextIsWellFormed(revision.text)||typeof revision.createdAt!=='string'||!Number.isFinite(Date.parse(revision.createdAt)))throw new Error('Invalid historical Communication revision');}
      }
      if(message.artifactRefs!==undefined){const refs=validatedObject(message.artifactRefs,'Historical artifact refs');if(Object.values(refs).some(ref=>typeof ref!=='string'||!portable.agents.some(owner=>owner.artifacts?.some(a=>a.ref===ref))))throw new Error('Historical artifact refs require included originals');}
      if(message.attachmentRefs!==undefined&&(!Array.isArray(message.attachmentRefs)||message.attachmentRefs.some(ref=>typeof ref!=='string'||!node.artifacts||!(node.artifacts as PortableArtifactDto[]).some(a=>a.ref===ref))))throw new Error('Historical attachments must reference included originals');
      if(!agentPackageTextIsWellFormed(message.text as string))throw new Error('Agent history text must contain well-formed Unicode');
    }
    if(node.artifacts!==undefined&&!Array.isArray(node.artifacts))throw new Error('Agent artifacts must be an array');
    for(const artifactCandidate of (node.artifacts as unknown[]|undefined)??[]){
      const artifact=validatedObject(artifactCandidate,'portable artifact');
      exactObjectFields(artifact,['ref','kind','path','summary','createdAt','mediaType','visibility','pinned','sourcePath','dataBase64','dataEncoding','decodedSize'],'portable artifact');
      if(typeof artifact.ref!=='string'||!CANONICAL_ARTIFACT_ID.test(artifact.ref)||artifactRefs.has(artifact.ref))throw new Error('artifact refs must be unique canonical identifiers');
      if(artifact.mediaType===WORKING_FILE_PART_MEDIA_TYPE&&!largeRefs.has(String(artifact.ref)))throw Error('Unbound working-file transport artifact');
      if(!['diff','test_report','pr_summary','log','document','screenshot','generated_file'].includes(String(artifact.kind))||typeof artifact.path!=='string'||!artifact.path||typeof artifact.createdAt!=='string'||!Number.isFinite(Date.parse(artifact.createdAt))||typeof artifact.dataBase64!=='string'||(artifact.summary!==undefined&&typeof artifact.summary!=='string')||(artifact.mediaType!==undefined&&typeof artifact.mediaType!=='string')||(artifact.visibility!==undefined&&artifact.visibility!=='project'&&artifact.visibility!=='published')||(artifact.pinned!==undefined&&typeof artifact.pinned!=='boolean')||(artifact.sourcePath!==undefined&&typeof artifact.sourcePath!=='string'))throw new Error(`artifact ${String(artifact.ref)} has an invalid shape`);
      const bytes=portableArtifactByteLength(artifact as unknown as PortableArtifactDto);
      if(bytes===0){
        // Empty ordinary files are retained in the same owner's imported working
        // state; they are never admitted as standalone managed blobs or parts.
        if(artifact.kind!=='document'||artifact.dataBase64!==''||artifact.dataEncoding!==undefined||artifact.decodedSize!==undefined
          ||!(node.workingFiles as AgentPortablePackageDto['agents'][number]['workingFiles'])?.some(file=>!file.parts&&file.artifactRef===artifact.ref))throw Error('Empty artifacts require a same-owner ordinary working-file original');
        emptyWorkingRefs.add(artifact.ref);
      }
      totalArtifactBytes+=bytes;if(totalArtifactBytes>AGENT_PACKAGE_ARTIFACT_MAX_BYTES)throw Object.assign(new Error(`portable Agent package artifacts exceed ${AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL}`),{statusCode:413});
      const typed=artifactCandidate as PortableArtifactDto;artifactRefs.add(artifact.ref);artifactBytes.set(typed,bytes);
    }
  }
  if(allTransportRefs.size||emptyWorkingRefs.size){
    const referenced=collectReachableArtifactIds({sourceProjectInstructions:portable.sourceProjectInstructions,
      agents:portable.agents.map(node=>({initialInstructions:node.initialInstructions,role:node.role,presetSnapshot:node.presetSnapshot,history:node.history}))});
    for(const node of portable.agents)for(const message of node.history??[]){
      for(const ref of [...(message.attachmentRefs??[]),...Object.values(message.artifactRefs??{})])referenced.add(ref);
    }
    if([...allTransportRefs].some(ref=>referenced.has(ref)))throw Error('Working-file transport parts cannot be used as standalone artifacts');
    if([...emptyWorkingRefs].some(ref=>referenced.has(ref)))throw Error('Empty working-file originals cannot be used as standalone artifacts');
  }
  if(portable.memory!==undefined){
    if(portable.mode!=='full'||!Array.isArray(portable.memory)||portable.memory.length>portable.agents.length)throw new Error('Full-mode memory snapshots require included Agent owners');
    if(portable.memory.length>1)throw new Error('Cross-Chat memory packages require separate destination Chats');
    const chats=new Set<string>(),bound=new Set<string>(),refs=new Set(portable.agents.map(a=>a.ref));
    for(const candidate of portable.memory){
      const entry=validatedObject(candidate,'Package memory');exactObjectFields(entry,['snapshot','agentRefs'],'Package memory');
      const snapshot=validateMemorySnapshot(entry.snapshot),mapping=validatedObject(entry.agentRefs,'Memory Agent refs');
      if(chats.has(snapshot.sourceChatId)||Object.keys(mapping).length!==snapshot.agentIds.length||snapshot.agentIds.some(id=>typeof mapping[id]!=='string'||!refs.has(mapping[id] as string)||bound.has(mapping[id] as string))||new Set(Object.values(mapping)).size!==snapshot.agentIds.length)throw new Error('Memory snapshots require unique included Chat/Agent refs');
      chats.add(snapshot.sourceChatId);for(const ref of Object.values(mapping))bound.add(ref as string);
    }
  }
  const rootRefs=new Set(portable.agents.flatMap(node=>node.workingRootRef?[node.workingRootRef]:[]));
  for(const node of portable.agents)for(const link of node.workingFolder?.links??[])if(link.targetRootRef&&!rootRefs.has(link.targetRootRef))throw new Error('Mapped symbolic target requires complete included root closure');
  if(portable.workingRootNesting!==undefined){
    if(portable.mode!=='full')throw Error('Working-root nesting requires full selected data');validateWorkingRootNesting(rootRefs,portable.workingRootNesting);
    for(const boundary of portable.workingRootNesting){
      const members=portable.agents.filter(node=>node.workingRootRef===boundary.parentRootRef),owner=members.find(node=>node.workingFolder),folder=owner?.workingFolder;
      if(!folder||!folder.excludedPaths.some(name=>name==='.'||name===boundary.path)||[...members.flatMap(member=>member.workingFiles??[]),...folder.directories,...(folder.links??[])].some(item=>item.path===boundary.path||item.path.startsWith(boundary.path+'/')))throw Error('Nested root must own its exact excluded parent boundary without duplicate originals');
    }
    orderWorkingRoots(portable.agents.filter(node=>node.workingFolder).map(node=>({ref:node.workingRootRef??node.ref,links:node.workingFolder!.links??[]})),portable.workingRootNesting);
  }
  if(portable.gitStorageBindings!==undefined){
    if(portable.mode!=='full')throw new Error('Git storage bindings require full selected working-root evidence');
    validatePortableGitStorageBindings(portable.gitStorageBindings,rootRefs);
    const originalProofs=new Map<string,{sha256:string;review:ReturnType<typeof parseReviewedUserData>}>();
    for(const binding of portable.gitStorageBindings){
      if(!binding.capture)continue;
      const worktree=portable.agents.find(node=>node.workingRootRef===binding.worktreeRootRef&&node.workingFiles?.some(file=>file.path==='.ponderosa-portable-review/user-data.json'));
      const file=worktree?.workingFiles?.find(file=>file.path==='.ponderosa-portable-review/user-data.json'),artifact=worktree?.artifacts?.find(artifact=>artifact.ref===file?.artifactRef);
      if(!artifact||!binding.capture.reviewSha256)throw new Error('Captured Git storage needs its included authoritative review original and hash');
      let original=originalProofs.get(artifact.ref);
      if(!original){
        if(artifactBytes.get(artifact)!>48*1024*1024)throw new Error('Git association review original exceeds its bound');
        const data=decodePortableMetadataArtifact(artifact);
        original={sha256:createHash('sha256').update(data).digest('hex'),review:parseReviewedUserData(data)};originalProofs.set(artifact.ref,original);
      }
      if(original.sha256!==binding.capture.reviewSha256||!original.review.associationReview?.some(captured=>gitBindingSourceEvidence(captured)===gitBindingSourceEvidence(binding)))throw new Error('Git captured topology differs from the authoritative Git review original');
      for(const node of portable.agents.filter(node=>node.workingRootRef===binding.storageRootRef)){
        const inStorage=(name:string)=>binding.relativePath==='.'||name===binding.relativePath||name.startsWith(binding.relativePath+'/');
        if(node.workingFiles?.some(file=>inStorage(file.path))||node.workingFolder?.directories.some(directory=>inStorage(directory.path))||node.workingFolder?.links?.some(link=>inStorage(link.path)))throw new Error('Captured Git storage cannot also be ordinary working-file topology');
      }
    }
  }
  if(portable.agents.some(node=>node.workingFolder?.links?.some(link=>link.targetRootRef)))validateMappedWorkingLinks(portable.agents.filter(node=>node.workingFolder).map(node=>({ref:node.workingRootRef??node.ref,links:node.workingFolder!.links??[],cyclicLinks:node.workingFolder!.cyclicLinks})));
  if(portable.agents.some(node=>node.workingFolder?.links?.some(link=>link.kind==='hardlink'&&link.targetRootRef))){
    for(const node of portable.agents)for(const link of node.workingFolder?.links??[])if(link.kind==='hardlink'&&link.targetRootRef){
      const target=portable.agents.find(owner=>owner.workingRootRef===link.targetRootRef&&owner.workingFiles?.some(file=>file.path===link.target));
      const original=target?.workingFiles?.find(file=>file.path===link.target),artifact=original&&target?.artifacts?.find(artifact=>artifact.ref===original.artifactRef);
      if(!original||!artifact)throw new Error('Mapped hardlink requires an included regular original');
      // ponytail: a parts-backed mapped hardlink stays held until its entire
      // decoded original can be checked against the alias-sensitive policy.
      if(original.parts)throw Error('Mapped hardlinks to multi-part working originals require complete alias validation');
      validateWorkingFileData(link.path,decodePortableMetadataArtifact(artifact,64*1024*1024));
    }
    orderWorkingRoots(portable.agents.filter(node=>node.workingFolder).map(node=>({ref:node.workingRootRef??node.ref,links:node.workingFolder!.links??[]})));
  }
  for(const ref of rootRefs){const members=portable.agents.filter(node=>node.workingRootRef===ref);if(members.filter(node=>node.workingFolder).length!==1||members.filter(node=>node.workingFiles?.length).length>1)throw new Error('A working root needs exactly one folder manifest and one originals owner');const folder=members.find(node=>node.workingFolder)!.workingFolder!;validateWorkingTopology(members.flatMap(node=>node.workingFiles??[]),folder.directories,folder.links??[],folder.cyclicLinks);}
  if(rootRefs.size&&portable.agents.some(node=>!node.workingRootRef))throw new Error('Organization folder bundles must identify every Agent root');
  return {package:portable,artifactBytes,totalArtifactBytes};
}
