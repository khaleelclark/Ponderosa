import {validateMemorySnapshot} from './portable-memory-snapshot.js';
import {AGENT_PACKAGE_MAX_AGENTS,agentPackageJsonUtf8Bytes,agentPackageTextIsWellFormed,AGENT_PACKAGE_ARTIFACT_MAX_BYTES,AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL,type AgentPortablePackageDto,type PortableArtifactDto} from '@ponderosa/core';
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
  exactObjectFields(record,['schema','mode','kind','exportedAt','sourceLabel','sourceProjectInstructions','rootRef','agents','memory'],'Agent package');
  if(record.schema!=='ponderosa.agent-package.v1'||(record.mode!=='template'&&record.mode!=='full')||!Array.isArray(record.agents)||record.agents.length<1)throw new Error('invalid Ponderosa Agent package');
  if(record.agents.length>AGENT_PACKAGE_MAX_AGENTS)throw Object.assign(new Error(`Agent package contains ${record.agents.length} Agents; the limit is ${AGENT_PACKAGE_MAX_AGENTS}`),{statusCode:413});
  if(typeof record.exportedAt!=='string'||!Number.isFinite(Date.parse(record.exportedAt))||typeof record.sourceLabel!=='string'||(record.sourceProjectInstructions!==undefined&&(typeof record.sourceProjectInstructions!=='string'||record.sourceProjectInstructions.length>100_000)))throw new Error('Agent package metadata is invalid');
  if(record.mode==='template'&&record.sourceProjectInstructions!==undefined)throw new Error('template packages cannot contain full-mode Project context');
  const portable=record as unknown as AgentPortablePackageDto;
  const topologyError=portableAgentTopologyError(portable);if(topologyError)throw new Error(topologyError);
  agentPackageJsonUtf8Bytes(portable);
  const artifactBytes=new Map<PortableArtifactDto,number>(),artifactRefs=new Set<string>();let totalArtifactBytes=0;
  for(const candidate of portable.agents as unknown[]){
    const node=validatedObject(candidate,'Agent package node');
    exactObjectFields(node,['ref','title','engine','model','effort','initialInstructions','managerRef','managementPermissions','history','artifacts'],'Agent package node');
    if(typeof node.ref!=='string'||typeof node.title!=='string'||typeof node.engine!=='string'||!node.engine.trim()||(node.model!==undefined&&typeof node.model!=='string')||(node.effort!==undefined&&typeof node.effort!=='string')||(node.initialInstructions!==undefined&&typeof node.initialInstructions!=='string'))throw new Error('every imported Agent must declare valid identity and runtime fields');
    if(typeof node.initialInstructions==='string'&&!agentPackageTextIsWellFormed(node.initialInstructions))throw new Error('Agent initial instructions must contain well-formed Unicode');
    const permissions=validatedObject(node.managementPermissions,'managementPermissions');
    exactObjectFields(permissions,['allowAutomaticDescendantDeletion','allowAutomaticDescendantReorganization'],'managementPermissions');
    if(typeof permissions.allowAutomaticDescendantDeletion!=='boolean'||typeof permissions.allowAutomaticDescendantReorganization!=='boolean')throw new Error('every imported Agent must declare exact boolean management permissions');
    if(portable.mode==='template'&&(node.history!==undefined||node.artifacts!==undefined))throw new Error('template packages cannot contain history or artifacts');
    if(node.history!==undefined&&!Array.isArray(node.history))throw new Error('Agent history must be an array');
    for(const messageCandidate of (node.history as unknown[]|undefined)??[]){
      const message=validatedObject(messageCandidate,'history message');exactObjectFields(message,['role','text','createdAt'],'history message');
      if(!['user','assistant','system'].includes(String(message.role))||typeof message.text!=='string'||(message.createdAt!==undefined&&(typeof message.createdAt!=='string'||!Number.isFinite(Date.parse(message.createdAt)))))throw new Error('Agent history messages have an invalid shape');
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
