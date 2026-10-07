import type {AgentPortablePackageDto,PortableArtifactDto} from '@ponderosa/core';
import {CANONICAL_ARTIFACT_ID,portableAgentTopologyError} from './artifact-refs.js';
import {exactTriggerFields,triggerObject} from './trigger-validation.js';


export function portableBase64ByteLength(value:string):number {
  const unpadded=value.replace(/=+$/u,'');
  if(!/^[A-Za-z0-9+/]*={0,2}$/u.test(value)||unpadded.length%4===1||value.length-unpadded.length>((4-unpadded.length%4)%4))throw new Error('portable artifact has invalid base64 data');
  const tail=unpadded.slice(-4),canonicalTail=Buffer.from(tail,'base64').toString('base64').replace(/=+$/u,'');
  if(canonicalTail!==tail)throw new Error('portable artifact has invalid base64 data');
  return Math.floor(unpadded.length*3/4);
}

export interface ValidatedPortableAgentPackage {
  package: AgentPortablePackageDto;
  artifactBytes: ReadonlyMap<PortableArtifactDto,number>;
  totalArtifactBytes: number;
}

/** Mutation-free parser shared by standalone and Branch package imports. */
export function validatePortableAgentPackage(value:unknown):ValidatedPortableAgentPackage {
  const record=triggerObject(value,'Agent package');
  exactTriggerFields(record,['schema','mode','kind','exportedAt','sourceLabel','sourceProjectInstructions','rootRef','agents'],'Agent package');
  if(record.schema!=='ponderosa.agent-package.v1'||(record.mode!=='template'&&record.mode!=='full')||!Array.isArray(record.agents)||record.agents.length<1||record.agents.length>100)throw new Error('invalid Ponderosa Agent package');
  if(typeof record.sourceLabel==='string'&&record.sourceLabel.length>240)throw new Error('Agent package source label exceeds the limit');
  if(typeof record.exportedAt!=='string'||!Number.isFinite(Date.parse(record.exportedAt))||typeof record.sourceLabel!=='string'||(record.sourceProjectInstructions!==undefined&&typeof record.sourceProjectInstructions!=='string'))throw new Error('Agent package metadata is invalid');
  if(record.mode==='template'&&record.sourceProjectInstructions!==undefined)throw new Error('template packages cannot contain full-mode Project context');
  const portable=record as unknown as AgentPortablePackageDto;
  const topologyError=portableAgentTopologyError(portable);if(topologyError)throw new Error(topologyError);
  const artifactBytes=new Map<PortableArtifactDto,number>(),artifactRefs=new Set<string>();let totalArtifactBytes=0,totalArtifacts=0,totalHistoryMessages=0;
  for(const candidate of portable.agents as unknown[]){
    const node=triggerObject(candidate,'Agent package node');
    exactTriggerFields(node,['ref','title','engine','model','effort','initialInstructions','managerRef','managementPermissions','history','artifacts'],'Agent package node');
    if(typeof node.ref!=='string'||typeof node.title!=='string'||typeof node.engine!=='string'||!node.engine.trim()||(node.model!==undefined&&typeof node.model!=='string')||(node.effort!==undefined&&typeof node.effort!=='string')||(node.initialInstructions!==undefined&&typeof node.initialInstructions!=='string'))throw new Error('every imported Agent must declare valid identity and runtime fields');
    if(((node.initialInstructions as string|undefined)?.length??0)>99_969)throw new Error('Agent initial instructions exceed the imported message limit');
    const permissions=triggerObject(node.managementPermissions,'managementPermissions');
    exactTriggerFields(permissions,['allowAutomaticDescendantDeletion','allowAutomaticDescendantReorganization'],'managementPermissions');
    if(typeof permissions.allowAutomaticDescendantDeletion!=='boolean'||typeof permissions.allowAutomaticDescendantReorganization!=='boolean')throw new Error('every imported Agent must declare exact boolean management permissions');
    if(portable.mode==='template'&&(node.history!==undefined||node.artifacts!==undefined))throw new Error('template packages cannot contain history or artifacts');
    if(node.history!==undefined&&!Array.isArray(node.history))throw new Error('Agent history must be an array');
    if(((node.history as unknown[]|undefined)?.length??0)>10_000||(totalHistoryMessages+=((node.history as unknown[]|undefined)?.length??0))>50_000)throw new Error('Agent history exceeds the package message limit');
    for(const messageCandidate of (node.history as unknown[]|undefined)??[]){
      const message=triggerObject(messageCandidate,'history message');exactTriggerFields(message,['role','text','createdAt'],'history message');
      if(typeof message.text==='string'&&message.text.length>100_000)throw new Error('Agent history message exceeds the 100,000 character limit');
      if(!['user','assistant','system'].includes(String(message.role))||typeof message.text!=='string'||(message.createdAt!==undefined&&(typeof message.createdAt!=='string'||!Number.isFinite(Date.parse(message.createdAt)))))throw new Error('Agent history messages have an invalid shape');
    }
    if(node.artifacts!==undefined&&!Array.isArray(node.artifacts))throw new Error('Agent artifacts must be an array');
    for(const artifactCandidate of (node.artifacts as unknown[]|undefined)??[]){
      const artifact=triggerObject(artifactCandidate,'portable artifact');
      exactTriggerFields(artifact,['ref','kind','path','summary','createdAt','mediaType','visibility','pinned','sourcePath','dataBase64'],'portable artifact');
      if(++totalArtifacts>1_000)throw new Error('Agent artifacts exceed the package item limit');
      if(typeof artifact.ref!=='string'||!CANONICAL_ARTIFACT_ID.test(artifact.ref)||artifactRefs.has(artifact.ref))throw new Error('artifact refs must be unique canonical identifiers');
      if(typeof artifact.path==='string'&&artifact.path.length>1024)throw new Error('portable artifact path exceeds the limit');
      if(typeof artifact.mediaType==='string'&&artifact.mediaType.length>255)throw new Error('portable artifact media type exceeds the limit');
      if(!['diff','test_report','pr_summary','log','document','screenshot','generated_file'].includes(String(artifact.kind))||typeof artifact.path!=='string'||!artifact.path||typeof artifact.createdAt!=='string'||!Number.isFinite(Date.parse(artifact.createdAt))||typeof artifact.dataBase64!=='string'||(artifact.summary!==undefined&&typeof artifact.summary!=='string')||(artifact.mediaType!==undefined&&typeof artifact.mediaType!=='string')||(artifact.visibility!==undefined&&artifact.visibility!=='project'&&artifact.visibility!=='published')||(artifact.pinned!==undefined&&typeof artifact.pinned!=='boolean')||(artifact.sourcePath!==undefined&&typeof artifact.sourcePath!=='string'))throw new Error(`artifact ${String(artifact.ref)} has an invalid shape`);
      const bytes=portableBase64ByteLength(artifact.dataBase64);totalArtifactBytes+=bytes;if(totalArtifactBytes>64*1024*1024)throw new Error('portable Agent package artifacts exceed 64 MiB');
      const typed=artifactCandidate as PortableArtifactDto;artifactRefs.add(artifact.ref);artifactBytes.set(typed,bytes);
    }
  }
  return {package:portable,artifactBytes,totalArtifactBytes};
}
