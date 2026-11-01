import type {BranchGroupCaptureResult,BranchGroupCaptureInput,BranchGroupCapturePreview,BranchGroupDiscoveryPage,BranchIssuedGroupCaptureStatus} from './branches.js';
import type {BranchDisclosureChoice,BranchDisclosureReceipt,BranchDisclosureReviewDto,BranchIssuedDestinationDto,BranchIssuedDestinationInput,CoordinationDestinationGroupResource,CoordinationDestinationGroupReceipt} from './coordination-destination.js';

/** Group wire output differs from the singular destination output. */
export type BranchIssuedGroupDestinationDto=Omit<BranchIssuedDestinationDto,'destination'|'receipt'>&{resources:CoordinationDestinationGroupResource[];receipt?:CoordinationDestinationGroupReceipt};
/** POST capture seals packages; GET capture returns status without these receipts. */
export type BranchIssuedGroupCaptureReceipt=BranchGroupCaptureResult;
/** Uses the caller's existing operator transport; never retries mutations. */
export class BranchGroupClient {
 private readonly base:string;
 constructor(branchId:string,executionId:string,private readonly request:<T>(path:string,init?:RequestInit)=>Promise<T>){this.base=`/api/branches/${encodeURIComponent(branchId)}/executions/${encodeURIComponent(executionId)}/destination-groups`;}
 private post<T>(path:string,body:unknown){return this.request<T>(path,{method:'POST',body:JSON.stringify(body)});}
 previewCapture(){return this.request<BranchGroupCapturePreview>(this.base+'/capture-preview',{cache:'no-store'});}
 discover(kind:'captures'|'admissions',cursor?:string){return this.request<BranchGroupDiscoveryPage>('/api/branches/destination-groups/discovery?kind='+kind+'&limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''),{cache:'no-store'});}
 capture(input:BranchGroupCaptureInput){return this.post<BranchIssuedGroupCaptureReceipt>(this.base+'/capture',input);}
 captureStatus(commandKey:string){return this.request<BranchIssuedGroupCaptureStatus>(this.base+'/capture?commandKey='+encodeURIComponent(commandKey),{cache:'no-store'});}
 prepare(input:BranchIssuedDestinationInput){return this.post<BranchIssuedGroupDestinationDto>(this.base,input);}
 inspect(commandKey:string){return this.request<BranchIssuedGroupDestinationDto>(this.base+'?commandKey='+encodeURIComponent(commandKey),{cache:'no-store'});}
 review(admissionId:string){return this.request<BranchDisclosureReviewDto>(this.base+'/'+encodeURIComponent(admissionId)+'/disclosure',{cache:'no-store'});}
 choose(admissionId:string,input:BranchDisclosureChoice){return this.post<BranchDisclosureReceipt>(this.base+'/'+encodeURIComponent(admissionId)+'/disclosure',input);}
 choiceReceipt(admissionId:string,commandKey:string){return this.request<BranchDisclosureReceipt>(this.base+'/'+encodeURIComponent(admissionId)+'/disclosure?commandKey='+encodeURIComponent(commandKey),{cache:'no-store'});}
 admit(input:{commandKey:string;reviewHash:string}){return this.post<BranchIssuedGroupDestinationDto>(this.base+'/admit',input);}
}
