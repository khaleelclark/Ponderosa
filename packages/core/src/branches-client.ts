import type {
 BranchBindings, BranchConfiguration, BranchDeploymentPreviewDto, BranchDto, BranchExecutionActionsDto,
 BranchExecutionDetailDto, BranchExecutionDto, BranchGateResolution, BranchHistoricalCheckpointDto,
 BranchInitialCheckpointDto, BranchInstallationPreviewDto, BranchIntervention, BranchMemoryUpdateSelectionDto, BranchHistoricalRewindInput,
 BranchOperationalSummaryDto, BranchStepEvidenceDto, BranchVersionDto, DeployBranchRequest,
 InstalledBranchPackage, OutputAgentAppDto, AssistantStatusDto,
} from './branches.js';
import type {AgentDetailDto,RunOutputTextDto} from './dto/events.js';
import type {CollectionPageDto} from './dto/collections.js';
import type {TriggerDefinitionDto,TriggerOccurrenceDto} from './dto/branch-triggers.js';

export class BranchesHttpError extends Error {
 constructor(readonly status:number,readonly body:unknown) {
  super(body&&typeof body==='object'&&'error'in body?String(body.error):`Branches request failed (${status})`);
  this.name='BranchesHttpError';
 }
}
export interface BranchesRequestOptions {signal?:AbortSignal}
export interface BranchesStreamMessage {event:string;id?:string;data:unknown}
const part=(id:string)=>encodeURIComponent(id);
const query=(values:Record<string,string|number|undefined>)=>{
 const params=new URLSearchParams();for(const [key,value]of Object.entries(values))if(value!==undefined)params.set(key,String(value));
 return params.size?'?'+params.toString():'';
};

/** Public HTTP client. No store/process hooks, authority changes, or implicit mutation retries. */
export class BranchesClient {
 constructor(readonly baseUrl:string,private readonly transport:typeof fetch=globalThis.fetch) {}
 private async response(path:string,method:string,body:unknown,options:BranchesRequestOptions,headers:Record<string,string>={}) {
  const response=await this.transport(new URL(path,this.baseUrl),{method,signal:options.signal,headers:{...headers,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok){let error:unknown;try{error=await response.json();}catch{error={error:`Branches request failed (${response.status})`};}throw new BranchesHttpError(response.status,error);}
  return response;
 }
 private async json<T>(path:string,method='GET',body?:unknown,options:BranchesRequestOptions={}):Promise<T> {
  return (await this.response(path,method,body,options)).json() as Promise<T>;
 }
 async list(options:BranchesRequestOptions&{cursor?:string;search?:string}={}):Promise<CollectionPageDto<BranchDto>> {
  const response=await this.response('/api/branches'+query({cursor:options.cursor,search:options.search}),'GET',undefined,options);
  const total=response.headers.get('x-total-count'),limit=response.headers.get('x-page-limit'),hasMore=response.headers.get('x-collection-has-more');
  if(total===null||limit===null||!Number.isSafeInteger(Number(total))||Number(total)<0||!Number.isSafeInteger(Number(limit))||Number(limit)<1||!['true','false'].includes(hasMore??''))throw new Error('Branches collection metadata is missing or invalid');
  return {items:await response.json() as BranchDto[],total:Number(total),limit:Number(limit),hasMore:hasMore==='true',...(response.headers.get('x-next-cursor')?{cursor:response.headers.get('x-next-cursor')!}:{})};
 }
 create(name:string,idempotencyKey:string,options?:BranchesRequestOptions){return this.json<BranchDto>('/api/branches','POST',{name,idempotencyKey},options);}
 get(id:string,options?:BranchesRequestOptions){return this.json<BranchDto>(`/api/branches/${part(id)}`,'GET',undefined,options);}
 version(id:string,versionId:string,options?:BranchesRequestOptions){return this.json<BranchVersionDto>(`/api/branches/${part(id)}/versions/${part(versionId)}`,'GET',undefined,options);}
 bindings(id:string,revisionId?:string,options?:BranchesRequestOptions){return this.json<BranchBindings>(`/api/branches/${part(id)}/configuration`+query({revisionId}),'GET',undefined,options);}
 preview(input:DeployBranchRequest,options?:BranchesRequestOptions){return this.json<BranchDeploymentPreviewDto>('/api/branches/preview','POST',input,options);}
 deploy(input:DeployBranchRequest,options?:BranchesRequestOptions){return this.json<BranchDto>('/api/branches/deploy','POST',input,options);}
 settings(id:string,options?:BranchesRequestOptions){return this.json<{revision:number;configuration:BranchConfiguration;secretStatus:Record<string,string>}>(`/api/branches/${part(id)}/settings`,'GET',undefined,options);}
 configure(id:string,configuration:Omit<BranchConfiguration,'secretBindings'>,revision:number,options?:BranchesRequestOptions){return this.json<{revision:number;configuration:BranchConfiguration}>(`/api/branches/${part(id)}/settings`,'PUT',{configuration,revision},options);}
 availability(id:string,enabled:boolean,options?:BranchesRequestOptions){return this.json<BranchDto>(`/api/branches/${part(id)}/availability`,'PUT',{enabled},options);}
 invoke(id:string,input:string,occurrenceKey:string,options?:BranchesRequestOptions){return this.json<BranchExecutionDto>(`/api/branches/${part(id)}/executions`,'POST',{input,occurrenceKey},options);}
 executions(id:string,options:BranchesRequestOptions&{before?:string;state?:string}={}){return this.json<BranchExecutionDto[]>(`/api/branches/${part(id)}/executions`+query({before:options.before,state:options.state}),'GET',undefined,options);}
 /** Current graph state and historical rows are paged by the server; follow nextCursor explicitly. */
 state(executionId:string,cursor?:string,options?:BranchesRequestOptions){return this.json<BranchExecutionDetailDto>(`/api/branch-executions/${part(executionId)}/full-detail`+query({cursor}),'GET',undefined,options);}
 actions(executionId:string,cursor?:string,options?:BranchesRequestOptions){return this.json<BranchExecutionActionsDto>(`/api/branch-executions/${part(executionId)}/actions`+query({cursor}),'GET',undefined,options);}
 operations(executionId:string,options?:BranchesRequestOptions){return this.json<BranchOperationalSummaryDto>(`/api/branch-executions/${part(executionId)}/operations`,'GET',undefined,options);}
 evidence(executionId:string,stepExecutionId:string,options?:BranchesRequestOptions){return this.json<BranchStepEvidenceDto>(`/api/branch-executions/${part(executionId)}/steps/${part(stepExecutionId)}/evidence`,'GET',undefined,options);}
 result(executionId:string,options?:BranchesRequestOptions){return this.json<{output:string|null}>(`/api/branch-executions/${part(executionId)}/result`,'GET',undefined,options);}
 cancel(executionId:string,options?:BranchesRequestOptions){return this.json<BranchExecutionDetailDto>(`/api/branch-executions/${part(executionId)}/cancel`,'POST',{},options);}
 resolveGate(gateId:string,resolution:BranchGateResolution,options?:BranchesRequestOptions){return this.json<BranchExecutionDetailDto>(`/api/branch-gates/${part(gateId)}/resolve`,'POST',resolution,options);}
 intervene(executionId:string,intervention:BranchIntervention,options?:BranchesRequestOptions){return this.json<BranchExecutionDetailDto>(`/api/branch-executions/${part(executionId)}/intervene`,'POST',intervention,options);}
 interrupt(branchId:string,executionId:string,action:'interrupt'|'resume',expectedId:string,commandKey:string,options?:BranchesRequestOptions){return this.json<BranchExecutionDto>(`/api/branches/${part(branchId)}/executions/${part(executionId)}/checkpoint-interruption`,'POST',{action,expectedId,commandKey},options);}
 initialCheckpoint(branchId:string,executionId:string,capture=false,options?:BranchesRequestOptions){return this.json<BranchInitialCheckpointDto>(`/api/branches/${part(branchId)}/executions/${part(executionId)}/initial-checkpoint`,capture?'POST':'GET',capture?{}:undefined,options);}
 /** Preview only; never grants disclosure or starts a destination. */
 reviewDestinationDisclosure(branchId:string,executionId:string,admissionId:string,options?:BranchesRequestOptions){return this.json<import('./coordination-destination.js').BranchDisclosureReviewDto>(`/api/branches/${part(branchId)}/executions/${part(executionId)}/destinations/${part(admissionId)}/disclosure`,'GET',undefined,options);}
 chooseDestinationDisclosure(branchId:string,executionId:string,admissionId:string,input:import('./coordination-destination.js').BranchDisclosureChoice,options?:BranchesRequestOptions){return this.json<import('./coordination-destination.js').BranchDisclosureReceipt>(`/api/branches/${part(branchId)}/executions/${part(executionId)}/destinations/${part(admissionId)}/disclosure`,'POST',input,options);}
 destinationDisclosureReceipt(branchId:string,executionId:string,admissionId:string,commandKey:string,options?:BranchesRequestOptions){return this.json<import('./coordination-destination.js').BranchDisclosureReceipt>(`/api/branches/${part(branchId)}/executions/${part(executionId)}/destinations/${part(admissionId)}/disclosure`+query({commandKey}),'GET',undefined,options);}
 checkpoints(branchId:string,executionId:string,before?:number,options?:BranchesRequestOptions){return this.json<BranchHistoricalCheckpointDto[]>(`/api/branches/${part(branchId)}/executions/${part(executionId)}/historical-checkpoints`+query({before}),'GET',undefined,options);}
 inspectResource(branchId:string,executionId:string,stepExecutionId:string,options?:BranchesRequestOptions){return this.json<import('./branches.js').BranchResourceInspectionDto>(`/api/branches/${part(branchId)}/executions/${part(executionId)}/resources/${part(stepExecutionId)}`,'GET',undefined,options);}
 resourceCustodyReleaseStatus(branchId:string,executionId:string,stepExecutionId:string,commandKey:string,options?:BranchesRequestOptions){return this.json<import('./branches.js').BranchResourceCustodyReleaseStatus>(`/api/branches/${part(branchId)}/executions/${part(executionId)}/resources/${part(stepExecutionId)}/checkpoint-custody`+query({commandKey}),'GET',undefined,options);}
 releaseResourceCustody(branchId:string,executionId:string,stepExecutionId:string,input:import('./branches.js').BranchResourceCustodyReleaseInput,options?:BranchesRequestOptions){return this.json<import('./branches.js').BranchResourceCustodyReleaseDto>(`/api/branches/${part(branchId)}/executions/${part(executionId)}/resources/${part(stepExecutionId)}/checkpoint-custody`,'DELETE',input,options);}
 reviewResourceAccess(branchId:string,executionId:string,stepExecutionId:string,resolution:NonNullable<import('./dto/agents.js').ImportAgentPackageRequest['accessSettingsResolution']>,options?:BranchesRequestOptions){return this.json<import('./dto/agents.js').AgentAccessImportReviewDto>(`/api/branches/${part(branchId)}/executions/${part(executionId)}/resources/${part(stepExecutionId)}/access-review`,'POST',resolution,options);}
 reviewHostGraph(branchId:string,executionId:string,selection:{checkpointId:number;expectedHash:string},options?:BranchesRequestOptions){return this.json<import('./branches.js').BranchHostGraphReviewDto>(`/api/branches/${part(branchId)}/executions/${part(executionId)}/host-graph-review`,'POST',selection,options);}
 restoreHostGraph(branchId:string,executionId:string,input:import('./branches.js').BranchHostGraphRestoreInput,options?:BranchesRequestOptions){return this.json<import('./branches.js').BranchHostGraphRestoreDto>(`/api/branches/${part(branchId)}/executions/${part(executionId)}/restore-host-graph`,'POST',input,options);}
 reviewHostRequest(branchId:string,executionId:string,selection:import('./branches.js').BranchHostRequestSelection,options?:BranchesRequestOptions){return this.json<import('./branches.js').BranchHostRequestReviewDto>(`/api/branches/${part(branchId)}/executions/${part(executionId)}/host-request-review`,'POST',selection,options);}
 adoptHostRequest(branchId:string,executionId:string,input:import('./branches.js').BranchHostRequestAdoption,options?:BranchesRequestOptions){return this.json<import('./branches.js').BranchHostRequestAdoptionDto>(`/api/branches/${part(branchId)}/executions/${part(executionId)}/adopt-host-request`,'POST',input,options);}
 rewind(branchId:string,executionId:string,kind:'initial'|'historical',checkpoint:BranchHistoricalRewindInput,options?:BranchesRequestOptions){return this.json<BranchExecutionDto>(`/api/branches/${part(branchId)}/executions/${part(executionId)}/rewind-${kind}`,'POST',checkpoint,options);}
 trigger(branchId:string,options?:BranchesRequestOptions){return this.json<TriggerDefinitionDto>(`/api/branches/${part(branchId)}/trigger`,'GET',undefined,options);}
 occurrences(branchId:string,before?:string,options?:BranchesRequestOptions){return this.json<TriggerOccurrenceDto[]>(`/api/branches/${part(branchId)}/trigger/occurrences`+query({before}),'GET',undefined,options);}
 webhook(triggerId:string,eventId:string,payload:unknown,options:BranchesRequestOptions={}){return this.response(`/api/trigger-webhooks/${part(triggerId)}`,'POST',payload,options,{'x-ponderosa-event-id':eventId}).then(response=>response.json());}
 export(branchId:string,mode:'template'|'full',options?:BranchesRequestOptions,fileSelections?:import('./branches.js').BranchExportFileSelections){return this.json<InstalledBranchPackage>(`/api/branches/${part(branchId)}/package`+query({mode,...(fileSelections?{fileSelections:JSON.stringify(fileSelections)}:{})}),'GET',undefined,options);}
 importPreview(pkg:InstalledBranchPackage,bindings:BranchBindings,branchId?:string,memorySelection?:BranchMemoryUpdateSelectionDto,options?:BranchesRequestOptions,fileSelections?:import('./branches.js').BranchImportFileSelections){return this.json<BranchInstallationPreviewDto>('/api/branches/install-preview','POST',{package:pkg,bindings,branchId,memorySelection,fileSelections},options);}
 installation(id:string,options?:BranchesRequestOptions){return this.json<unknown>(`/api/branches/installations/${part(id)}`,'GET',undefined,options);}
 resolveImportAccess(id:string,chatRef:string,agentRef:string,resolution:NonNullable<import('./dto/agents.js').ImportAgentPackageRequest['accessSettingsResolution']>,options?:BranchesRequestOptions){return this.json<unknown>(`/api/branches/installations/${part(id)}/access-review`,'POST',{chatRef,agentRef,resolution},options);}
 resolveImportWorkingRoot(id:string,chatRef:string,agentRef:string,sharedRoot:string,options?:BranchesRequestOptions){return this.json<unknown>(`/api/branches/installations/${part(id)}/working-root-review`,'POST',{chatRef,agentRef,sharedRoot},options);}
 confirmImport(id:string,acknowledgements:{acknowledgeFullImport?:boolean;acknowledgeMemoryUpdate?:boolean;outputRoleReviewId?:string},options?:BranchesRequestOptions){return this.json<unknown>(`/api/branches/installations/${part(id)}/confirm`,'POST',acknowledgements,options);}
 outputApp(agentId:string,options?:BranchesRequestOptions){return this.json<OutputAgentAppDto>(`/api/branches/output-apps/${part(agentId)}`,'GET',undefined,options);}
 assistant(options?:BranchesRequestOptions){return this.json<AssistantStatusDto>('/api/branches/assistant','GET',undefined,options);}
 moveSpeaker(agentId:string,expectedSpeakerId:string|null,options?:BranchesRequestOptions){return this.json<AssistantStatusDto>('/api/branches/assistant/speaker','POST',{agentId,expectedSpeakerId},options);}
 scheduleOutput(agentId:string,settings:{expectedVersionId:string;expectedSettingsRevision:string;automatic:boolean;everyMs:number},options?:BranchesRequestOptions){return this.json<OutputAgentAppDto>(`/api/branches/output-apps/${part(agentId)}/schedule`,'PUT',settings,options);}
 agent(agentId:string,options?:BranchesRequestOptions){return this.json<AgentDetailDto>(`/api/branches/engine/agents/${part(agentId)}`,'GET',undefined,options);}
 fullOutput(agentId:string,seq:number,options?:BranchesRequestOptions){return this.json<RunOutputTextDto>(`/api/agents/${part(agentId)}/run-output/${seq}/text`,'GET',undefined,options);}
 streamAgent(agentId:string,options:BranchesRequestOptions&{lastEventId?:string}={}){return this.stream(`/api/agents/${part(agentId)}/stream`,options);}
 streamWorkspace(options:BranchesRequestOptions&{lastEventId?:string}={}){return this.stream('/api/workspace/stream',options);}
 /** One connection only. Consumers own reconnect policy, cursor persistence and reset/snapshot handling. */
 private async *stream(path:string,options:BranchesRequestOptions&{lastEventId?:string}):AsyncGenerator<BranchesStreamMessage> {
  const response=await this.response(path,'GET',undefined,options,{'accept':'text/event-stream',...(options.lastEventId?{'last-event-id':options.lastEventId}:{})});
  if(!response.body)throw new Error('Branches event stream has no body');
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let buffer='',event='message',id:string|undefined,data:string[]=[];
  const line=(value:string):BranchesStreamMessage|undefined=>{
   if(value===''){if(!data.length){event='message';return;}const text=data.join('\n'),message={event,...(id===undefined?{}:{id}),data:JSON.parse(text) as unknown};data=[];event='message';return message;}
   if(value.startsWith(':'))return;
   const colon=value.indexOf(':'),key=colon<0?value:value.slice(0,colon),raw=colon<0?'':value.slice(colon+1),content=raw.startsWith(' ')?raw.slice(1):raw;
   if(key==='data')data.push(content);else if(key==='event')event=content;else if(key==='id'&&!content.includes('\0'))id=content;
  };
  try{
   for(;;){const next=await reader.read();buffer+=next.done?decoder.decode():decoder.decode(next.value,{stream:true});
    let boundary:number;while((boundary=buffer.search(/[\r\n]/u))>=0){
     if(!next.done&&buffer[boundary]==='\r'&&boundary===buffer.length-1)break;
     const value=buffer.slice(0,boundary),width=buffer[boundary]==='\r'&&buffer[boundary+1]==='\n'?2:1;buffer=buffer.slice(boundary+width);
     const message=line(value);if(message)yield message;
    }
    if(next.done)break;
   }
   // An incomplete event at disconnect is intentionally not dispatched; resume from the last received id.
  }finally{try{await reader.cancel();}finally{reader.releaseLock();}}
 }
}
