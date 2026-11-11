import type {QueuedConversationMessageDto} from "@ponderosa/core";
import {queryKeys} from "../../queryKeys";
import {draftPendingSubmissionRetired,type ConversationDraftDto,type PutConversationDraftRequest,type DraftPendingSubmissionDto} from '@ponderosa/core';
import type {QueryClient} from '@tanstack/react-query';
import {api} from '../../api';
import {productApiPath} from '../../api/productScope';
import {ApiRequestError,ApiTransportError} from '../../api/types';
import {queryRetryDelay} from '../../api/queryRetry';
import {CapturedRetirementStorageError,readCapturedSubmissions,removeCapturedSubmission,type CapturedSubmission} from './submissionOutbox';

export function capturedDraftSubmissions(scope:string,ownerId:string,current?:ConversationDraftDto):DraftPendingSubmissionDto[]{
 const byId=new Map((current?.pendingSubmissions??[]).filter(item=>!draftPendingSubmissionRetired(current!,item)).map(item=>[item.idempotencyKey,item]));
 for(const item of readCapturedSubmissions(scope,ownerId)){
  if(current&&draftPendingSubmissionRetired(current,item.pending))continue;
  const retained=byId.get(item.pending.idempotencyKey),incoming=item.pending;
  // Preserve monotonic preparation from another tab instead of regressing its
  // generated title/fingerprint to an older browser snapshot.
  byId.set(incoming.idempotencyKey,retained?{...retained,...incoming,
   ...(retained.fingerprint!=='0'.repeat(64)&&incoming.fingerprint==='0'.repeat(64)||retained.agentTitle&&!incoming.agentTitle?{fingerprint:retained.fingerprint,intentFingerprint:retained.intentFingerprint}:{}),
   uploads:[...new Map([...(retained.uploads??[]),...(incoming.uploads??[])].map(upload=>[upload.scope,upload])).values()],
  }:incoming);
 }
 return [...byId.values()];
}
export function withCapturedDraftSubmissions(scope:string,input:PutConversationDraftRequest,current?:ConversationDraftDto):PutConversationDraftRequest{
 return {...input,pendingSubmissions:capturedDraftSubmissions(scope,input.ownerId??'',current)};
}
class CapturedDraftScopeChanged extends Error{}
/** Capture metadata alone uses strict CAS, never the editable writer's bypass.
 * The server preserves the current editor and other tabs' operations verbatim. */
export async function persistCapturedDraftSubmission(scope:string,ownerId:string,clientId:string,pending:DraftPendingSubmissionDto,retire=false,expectedRevision?:number,namespace=productApiPath('/api/conversations')):Promise<{draft:ConversationDraftDto;mayAdvanceDraftRevision:boolean;retired?:boolean;pendingSubmission?:DraftPendingSubmissionDto}>{
 const originalCapture=readCapturedSubmissions(scope,ownerId).find(item=>item.pending.idempotencyKey===pending.idempotencyKey);
 const checkScope=()=>{if(productApiPath('/api/conversations')!==namespace)throw new CapturedDraftScopeChanged('The message destination changed before its metadata could be reconciled.');};
 for(let attempt=0;;attempt++){
  checkScope();const current=await api.getConversationDraft(scope,ownerId);checkScope();
  if(draftPendingSubmissionRetired(current,pending)){
   if(originalCapture)removeCapturedSubmission(pending.idempotencyKey,originalCapture);
   return {draft:current,mayAdvanceDraftRevision:false,retired:true};
  }
  // Ordinary registration never waits on another accepted operation's cleanup.
  // Only a full journal needs an exact accepted entry retired in this same CAS.
  const merged=retire?[...(current.pendingSubmissions??[])]:capturedDraftSubmissions(scope,ownerId,current);
  const requiredSlots=retire?0:Math.max(0,new Set([...merged.map(item=>item.idempotencyKey),pending.idempotencyKey]).size-32);
  const accepted=requiredSlots?readCapturedSubmissions(scope,ownerId).filter(item=>item.status==='accepted'&&item.pending.idempotencyKey!==pending.idempotencyKey&&merged.some(value=>value.idempotencyKey===item.pending.idempotencyKey)&&(!item.apiNamespace||item.apiNamespace===namespace)).slice(0,requiredSlots):[];
  const retireIds=new Set([...(retire?[pending.idempotencyKey]:[]),...accepted.filter(item=>!draftPendingSubmissionRetired(current,item.pending)).map(item=>item.pending.idempotencyKey)]);
  // Removal includes only the selected exact identity, not unrelated captures.
  const selected=merged.find(item=>item.idempotencyKey===pending.idempotencyKey)??pending;
  const pendingSubmissions=merged.filter(item=>!retireIds.has(item.idempotencyKey)&&item.idempotencyKey!==pending.idempotencyKey);
  if(!retire||!current.pendingSubmissions?.some(item=>item.idempotencyKey===pending.idempotencyKey))pendingSubmissions.push(selected);
  for(const item of accepted)if(retireIds.has(item.pending.idempotencyKey)&&!current.pendingSubmissions?.some(value=>value.idempotencyKey===item.pending.idempotencyKey))pendingSubmissions.push(item.pending);
  checkScope();let draft:ConversationDraftDto;
  try{draft=await api.putConversationDraft(scope,{text:current.text,attachmentIds:current.attachmentIds,pastedTextAttachmentId:current.pastedTextAttachmentId,mentionBindings:current.mentionBindings,...(current.pendingSubmission?{pendingSubmission:current.pendingSubmission}:{}),pendingSubmissions,...(retireIds.size?{retirePendingSubmissionIds:[...retireIds]}:{}),captureMetadataOnly:true,expectedRevision:current.revision,clientId:current.clientId||clientId,ownerId});}
  catch(error){if(attempt<2&&error instanceof ApiRequestError&&error.status===409&&(error.body as {code?:string}|undefined)?.code==='DRAFT_METADATA_CONFLICT')continue;throw error;}
  checkScope();
  const retained=draft.pendingSubmissions?.find(item=>item.idempotencyKey===pending.idempotencyKey);
  if(retire&&!draftPendingSubmissionRetired(draft,pending))throw new Error('Message retirement has not been verified. The original record is retained.');
  if(!retire&&!retained)throw new Error('The captured message was not retained. Its original input is preserved.');
  // Quietly mirror any other verified accepted retirements; storage failure
  // cannot turn this distinct new Send into an apparent submission failure.
  for(const item of accepted)if(draftPendingSubmissionRetired(draft,item.pending))try{removeCapturedSubmission(item.pending.idempotencyKey,item);}catch{}
  return {draft,mayAdvanceDraftRevision:current.revision===expectedRevision||current.clientId===clientId,...(retire?{retired:true}:{}),pendingSubmission:retained};
 }
}
/** Housekeeping of durable exact acceptance only. Query retry/dedup belongs to
 * the existing QueryClient and never calls Send, preparation or Agent creation. */
const retryableRetirementError=(error:unknown):boolean=>error instanceof ApiTransportError||error instanceof ApiRequestError&&(error.status>=500&&error.status<=504||error.status===429||error.status===409&&(error.body as {code?:string}|undefined)?.code==='DRAFT_METADATA_CONFLICT');
export function reconcileAcceptedCapture(client:QueryClient,item:CapturedSubmission,resume=false):Promise<true>{
 const namespace=item.apiNamespace??productApiPath('/api/conversations');
 const queryKey=['captured-retirement',namespace,item.scope,item.ownerId,item.pending.idempotencyKey];
 const previous=client.getQueryState(queryKey);
 if(previous?.status==='error'){
  const deferred=previous.error instanceof CapturedDraftScopeChanged||previous.error instanceof CapturedRetirementStorageError;
  if(!resume||productApiPath('/api/conversations')!==namespace||!retryableRetirementError(previous.error)&&!deferred)return Promise.reject(previous.error);
  void client.resetQueries({queryKey,exact:true});
 }
 return client.fetchQuery({queryKey,staleTime:Infinity,
  queryFn:async()=>{
   if(item.status!=='accepted')throw new Error('Only accepted message bookkeeping may be reconciled automatically.');
   if(productApiPath('/api/conversations')!==namespace)throw new CapturedDraftScopeChanged('The original message product is not active.');
   if((item.action==='queue'||item.pending.request?.runtime.activeRunDelivery==='queue')&&item.acceptedDeliveryIds?.length){
     // Publish the real queue snapshot before retiring its captured presentation.
     const agentId=item.scope.startsWith('agent:')?item.scope.slice(6):undefined;
     const key=agentId?queryKeys.queuedMessages.agent(agentId):queryKeys.queuedMessages.conversation(item.scope);
     const known=client.getQueryData<QueuedConversationMessageDto[]>(key);
     if(!item.acceptedDeliveryIds.every(id=>known?.some(row=>row.deliveryId===id)))await client.fetchQuery({queryKey:key,
       queryFn:async()=>{if(productApiPath('/api/conversations')!==namespace)throw new CapturedDraftScopeChanged('The original message product is not active.');const rows=await(agentId?api.listQueuedAgentMessages(agentId):api.listQueuedConversationMessages(item.scope));if(productApiPath('/api/conversations')!==namespace)throw new CapturedDraftScopeChanged('The original message product is not active.');return rows;},staleTime:0,retry:false});
   }
   if(!item.scope.startsWith('local:'))await persistCapturedDraftSubmission(item.scope,item.ownerId,item.clientId,item.pending,true,undefined,namespace);
   removeCapturedSubmission(item.pending.idempotencyKey,item);return true;
  },
  retry:(count,error)=>count<3&&retryableRetirementError(error),
  retryDelay:queryRetryDelay,
 });
}
