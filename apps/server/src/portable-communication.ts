import {communicationHasProjectionTarget, isCommunicationEvent, type CommunicationEvent, type PortableAgentHistoryMessageDto} from '@ponderosa/core';
import {assertPortableSecretsAbsent, withoutPortableSecrets} from './portable-secrets.js';
import {exactObjectFields, validatedObject} from './object-validation.js';

/** Scope comes from canonical routing, never text, mentions or timeline placement. */
export function portableCommunicationVisible(event:CommunicationEvent, agent:{id:string;projectId:string;conversationId:string}):boolean {
  return event.projectId===agent.projectId && (event.intent==='broadcast'
    ? event.audience.organizationId===agent.projectId && (!event.conversationId || event.conversationId===agent.conversationId)
    : communicationHasProjectionTarget(event,'direct_agent_audit',agent.id));
}

export function portableCommunicationMessage(event:CommunicationEvent):PortableAgentHistoryMessageDto {
  const communication=withoutPortableSecrets(event) as CommunicationEvent;
  return {role:event.sender.kind==='user'?'user':event.sender.kind==='agent'?'assistant':'system',text:event.text,createdAt:event.createdAt,communication};
}

/** Imported provenance is historical data; it never enters the live communication journal. */
export function validatePortableCommunication(value:unknown):void {
  const event=validatedObject(value,'Historical Communication');
  exactObjectFields(event,['eventId','schemaVersion','projectId','conversationId','sender','text','attachments','artifactIds','document','citations','createdAt','correlationId','causationId','idempotencyKey','correctionOfEventId','audienceSelector','identity','intent','audience'],'Historical Communication');
  if(!isCommunicationEvent(event)||!Number.isFinite(Date.parse(event.createdAt)))throw new Error('Invalid historical Communication');
  assertPortableSecretsAbsent(event,'Historical Communication');
}
