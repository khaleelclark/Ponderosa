import type {GroupJournalAuditSelection,GroupJournalAuditReadback} from './lifecycle-reconciliation.js';
import type {BranchGroupCaptureResult,BranchGroupCaptureInput,BranchGroupCapturePreview,BranchTreeGroupCapturePreview,BranchTreeGroupCaptureStatus,BranchGroupDiscoveryPage,BranchIssuedGroupCaptureStatus} from './branches.js';
import type {BranchDisclosureChoice,BranchDisclosureReceipt,BranchDisclosureReviewDto,BranchIssuedDestinationDto,BranchIssuedDestinationInput,CoordinationDestinationGroupResource,CoordinationDestinationGroupReceipt} from './coordination-destination.js';

export interface BranchGroupOwnerReviewEvidence {
 branchId:string;sourceExecutionId:string;destinationExecutionId:string;
 sourceParentExecutionId:string|null;sourceParentAttemptId:string|null;destinationParentExecutionId:string|null;destinationParentAttemptId:string|null;
 counters:{traversals:number;loopIterations:number;recoveryTraversals:number;callDepth:number;depthCeiling:number;
 paths:{sourcePathId:string;destinationPathId:string;traversals:number}[];
 steps:{sourceStepExecutionId:string;destinationStepExecutionId:string;invocation:number}[];
 loops:{sourcePathId:string;destinationPathId:string;edgeId:string;iterations:number}[]};
 capacity:{maxConcurrentExecutions:number;maxPathInstances:number;maxStepInvocations:number;maxEphemeralAgents:number};
 selectedUsage:{paths:number;stepInvocations:number;requestedAgents:number};
 limits:import('./branches.js').BranchLimits;policy:import('./branches.js').BranchDefinition['policy'];
 acceptance:{source:string;admittedAt:string;kind:'manual'|'charged'|'unlimited';budget:import('./branches.js').BranchExecutionBudgetDto};
}
export type BranchGroupReviewEvidence = {state:'unavailable';reason:'legacy_missing_saved_evidence'} | {
 state:'verified';evidenceHash:string;ancestry:'prospective'|'committed';idMap:Record<string,string>;ownerMap:Record<string,string>;owners:BranchGroupOwnerReviewEvidence[];
};
/** Group wire output differs from the singular destination output. */
export type BranchIssuedGroupDestinationDto=Omit<BranchIssuedDestinationDto,'destination'|'receipt'>&{reviewEvidence?:BranchGroupReviewEvidence;scope?:'owner_tree'|'standalone';ownerMap?:Record<string,string>;resources:CoordinationDestinationGroupResource[];receipt?:CoordinationDestinationGroupReceipt};
/** POST capture seals packages; GET capture returns status without these receipts. */
export type BranchIssuedGroupCaptureReceipt=BranchGroupCaptureResult;
/** Uses the caller's existing operator transport; never retries mutations. */
export class BranchGroupClient {
 private readonly base:string;
 constructor(branchId:string,executionId:string,private readonly request:<T>(path:string,init?:RequestInit)=>Promise<T>){this.base=`/api/branches/${encodeURIComponent(branchId)}/executions/${encodeURIComponent(executionId)}/destination-groups`;}
 private post<T>(path:string,body:unknown){return this.request<T>(path,{method:'POST',body:JSON.stringify(body)});}
 previewTreeCapture(){return this.request<BranchTreeGroupCapturePreview>(this.base+'/tree-capture-preview',{cache:'no-store'});}
 discoverTreeCaptures(){return this.request<{items:(BranchTreeGroupCaptureStatus&{commandKey:string})[]}>(this.base+'/tree-captures',{cache:'no-store'});}
 captureTree(input:BranchGroupCaptureInput){return this.post<BranchIssuedGroupCaptureReceipt>(this.base+'/tree-capture',input);}
 treeCaptureStatus(commandKey:string){return this.request<BranchTreeGroupCaptureStatus>(this.base+'/tree-capture?commandKey='+encodeURIComponent(commandKey),{cache:'no-store'});}
 previewCapture(){return this.request<BranchGroupCapturePreview>(this.base+'/capture-preview',{cache:'no-store'});}
 discover(kind:'captures'|'admissions',cursor?:string){return this.request<BranchGroupDiscoveryPage>('/api/branches/destination-groups/discovery?kind='+kind+'&limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''),{cache:'no-store'});}
 journalAudit(selection:GroupJournalAuditSelection){const query=new URLSearchParams();for(const [key,value] of Object.entries(selection))if(value!==undefined)query.set(key,String(value));return this.request<GroupJournalAuditReadback>('/api/lifecycle/destination-groups/journal?'+query.toString(),{cache:'no-store'});}
 capture(input:BranchGroupCaptureInput){return this.post<BranchIssuedGroupCaptureReceipt>(this.base+'/capture',input);}
 captureStatus(commandKey:string){return this.request<BranchIssuedGroupCaptureStatus>(this.base+'/capture?commandKey='+encodeURIComponent(commandKey),{cache:'no-store'});}
 prepare(input:BranchIssuedDestinationInput){return this.post<BranchIssuedGroupDestinationDto>(this.base,input);}
 inspect(commandKey:string){return this.request<BranchIssuedGroupDestinationDto>(this.base+'?commandKey='+encodeURIComponent(commandKey),{cache:'no-store'});}
 review(admissionId:string){return this.request<BranchDisclosureReviewDto>(this.base+'/'+encodeURIComponent(admissionId)+'/disclosure',{cache:'no-store'});}
 choose(admissionId:string,input:BranchDisclosureChoice){return this.post<BranchDisclosureReceipt>(this.base+'/'+encodeURIComponent(admissionId)+'/disclosure',input);}
 choiceReceipt(admissionId:string,commandKey:string){return this.request<BranchDisclosureReceipt>(this.base+'/'+encodeURIComponent(admissionId)+'/disclosure?commandKey='+encodeURIComponent(commandKey),{cache:'no-store'});}
 admit(input:{commandKey:string;reviewHash:string}){return this.post<BranchIssuedGroupDestinationDto>(this.base+'/admit',input);}
}
