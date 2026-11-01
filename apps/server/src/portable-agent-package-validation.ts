import {assertPortableSecretsAbsent} from './portable-secrets.js';
import {portableWorkingPath} from './portable-working-files.js';
import {BUILT_IN_CAPABILITIES,parseConnectorCapabilityId} from '@ponderosa/core';
import {validatePortableCommunication} from './portable-communication.js';
import {validateOutputRoles} from './portable-output-roles.js';
import {validateMemorySnapshot} from './portable-memory-snapshot.js';
import {normalizeAgentRole,AGENT_PACKAGE_MAX_AGENTS,agentPackageJsonUtf8Bytes,agentPackageTextIsWellFormed,AGENT_PACKAGE_ARTIFACT_MAX_BYTES,AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL,type AgentPortablePackageDto,type PortableArtifactDto} from '@ponderosa/core';
import {CANONICAL_ARTIFACT_ID,portableAgentTopologyError} from './artifact-refs.js';
import {exactObjectFields,validatedObject} from './object-validation.js';
import {portableBase64ByteLength} from './agent-package-codec.js';


export interface ValidatedPortableAgentPackage {
  package: AgentPortablePackageDto;
  artifactBytes: ReadonlyMap<PortableArtifactDto,number>;
  totalArtifactBytes: number;
}

/** Mutation-free parser shared by standalone and Branch package imports. */
export function validatePortableAgentPackage(value:unknown):ValidatedPortableAgentPackage {
  const record=validatedObject(value,'Agent package');
  exactObjectFields(record,['schema','mode','kind','exportedAt','sourceLabel','sourceProjectInstructions','rootRef','agents','memory','outputRoles'],'Agent package');
  if(record.schema!=='ponderosa.agent-package.v1'||(record.mode!=='template'&&record.mode!=='full')||!Array.isArray(record.agents)||record.agents.length<1)throw new Error('invalid Ponderosa Agent package');
  if(record.agents.length>AGENT_PACKAGE_MAX_AGENTS)throw Object.assign(new Error(`Agent package contains ${record.agents.length} Agents; the limit is ${AGENT_PACKAGE_MAX_AGENTS}`),{statusCode:413});
  if(typeof record.exportedAt!=='string'||!Number.isFinite(Date.parse(record.exportedAt))||typeof record.sourceLabel!=='string'||(record.sourceProjectInstructions!==undefined&&(typeof record.sourceProjectInstructions!=='string'||record.sourceProjectInstructions.length>100_000)))throw new Error('Agent package metadata is invalid');
  if(record.mode==='template'&&record.sourceProjectInstructions!==undefined)throw new Error('template packages cannot contain full-mode Project context');
  const portable=record as unknown as AgentPortablePackageDto;
  const topologyError=portableAgentTopologyError(portable);if(topologyError)throw new Error(topologyError);
  validateOutputRoles(portable.outputRoles,new Set(portable.agents.map(a=>a.ref)));
  agentPackageJsonUtf8Bytes(portable);
  const artifactBytes=new Map<PortableArtifactDto,number>(),artifactRefs=new Set<string>();let totalArtifactBytes=0;
  for(const candidate of portable.agents as unknown[]){
    const node=validatedObject(candidate,'Agent package node');
    exactObjectFields(node,['ref','title','engine','model','effort','speed','role','presetSnapshot','accessSettings','workingCopyMode','sourceChat','workingFiles','initialInstructions','managerRef','managementPermissions','history','artifacts'],'Agent package node');
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
    if(node.workingFiles!==undefined){
      if(portable.mode!=='full'||!Array.isArray(node.workingFiles)||node.workingFiles.length>10000)throw new Error('Selected working files require a bounded full package');
      const paths=new Set<string>();
      for(const candidate of node.workingFiles){const file=validatedObject(candidate,'Working file');exactObjectFields(file,['path','artifactRef'],'Working file');const relative=portableWorkingPath(file.path);if(paths.has(relative)||typeof file.artifactRef!=='string'||!Array.isArray(node.artifacts)||!node.artifacts.some(a=>a.ref===file.artifactRef))throw new Error('Working files need unique paths and included originals');paths.add(relative);}
      for(const relative of paths)if(relative.split('/').slice(0,-1).some((_,i)=>paths.has(relative.split('/').slice(0,i+1).join('/'))))throw new Error('A working file cannot also be a parent folder');
    }
    if(node.workingCopyMode!==undefined&&!['shared','separate_git'].includes(String(node.workingCopyMode)))throw new Error('Invalid portable working-copy mode');
    if(node.sourceChat!==undefined){const chat=validatedObject(node.sourceChat,'Source Chat');exactObjectFields(chat,['ref','title'],'Source Chat');if(typeof chat.ref!=='string'||!chat.ref||typeof chat.title!=='string')throw new Error('Invalid source Chat binding');}
    if(node.accessSettings!==undefined){const settings=validatedObject(node.accessSettings,'Access settings');exactObjectFields(settings,['restrictedCapabilityIds'],'Access settings');if(!Array.isArray(settings.restrictedCapabilityIds)||settings.restrictedCapabilityIds.some(id=>typeof id!=='string'||!BUILT_IN_CAPABILITIES.some(cap=>cap.id===id)&&!parseConnectorCapabilityId(id)))throw new Error('Invalid portable capability restrictions');}
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
      exactObjectFields(artifact,['ref','kind','path','summary','createdAt','mediaType','visibility','pinned','sourcePath','dataBase64'],'portable artifact');
      if(typeof artifact.ref!=='string'||!CANONICAL_ARTIFACT_ID.test(artifact.ref)||artifactRefs.has(artifact.ref))throw new Error('artifact refs must be unique canonical identifiers');
      if(!['diff','test_report','pr_summary','log','document','screenshot','generated_file'].includes(String(artifact.kind))||typeof artifact.path!=='string'||!artifact.path||typeof artifact.createdAt!=='string'||!Number.isFinite(Date.parse(artifact.createdAt))||typeof artifact.dataBase64!=='string'||(artifact.summary!==undefined&&typeof artifact.summary!=='string')||(artifact.mediaType!==undefined&&typeof artifact.mediaType!=='string')||(artifact.visibility!==undefined&&artifact.visibility!=='project'&&artifact.visibility!=='published')||(artifact.pinned!==undefined&&typeof artifact.pinned!=='boolean')||(artifact.sourcePath!==undefined&&typeof artifact.sourcePath!=='string'))throw new Error(`artifact ${String(artifact.ref)} has an invalid shape`);
      const bytes=portableBase64ByteLength(artifact.dataBase64);totalArtifactBytes+=bytes;if(totalArtifactBytes>AGENT_PACKAGE_ARTIFACT_MAX_BYTES)throw Object.assign(new Error(`portable Agent package artifacts exceed ${AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL}`),{statusCode:413});
      const typed=artifactCandidate as PortableArtifactDto;artifactRefs.add(artifact.ref);artifactBytes.set(typed,bytes);
    }
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
  return {package:portable,artifactBytes,totalArtifactBytes};
}
