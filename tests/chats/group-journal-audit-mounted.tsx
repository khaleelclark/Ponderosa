// Deferred mounted source; not executed.
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {BranchGroupReview} from '../../apps/web/src/components/branches/BranchGroupReview';
const assert=(v:unknown,m:string)=>{if(!v)throw Error(m);};
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setTimeout(r,0));};
const button=(text:string)=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent===text)!;
export async function groupJournalAuditRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),originalFetch=globalThis.fetch;
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}}),hash='a'.repeat(64),calls:string[]=[];let stale=false,reads=0;
 const captureSelection={kind:'captures',branchId:'branch',executionId:'missing-source',journalKey:'issued-group-capture:'+hash,journalSha256:hash,custodySha256:hash};
 const admissionSelection={kind:'admissions',branchId:'branch',executionId:'missing-source',journalKey:'actual admission journal',journalSha256:hash,custodySha256:hash,commandKey:'original prepare & key',admissionId:'admission',reservationHash:hash};
 const resources=[0,1].map(i=>({custody:{sourceChatId:`chat${i}`},destination:{executionId:'fresh-run',resourceStepId:`mapped${i}`}}));
 const captureRow={kind:'captures',branchId:'branch',executionId:'missing-source',discovery:'unsupported_legacy_key',state:'capturing',ownerPresent:false,resourceCount:2,auditSelection:captureSelection};
 const admissionRow={kind:'admissions',branchId:'branch',executionId:'missing-source',commandKey:admissionSelection.commandKey,discovery:'exact',state:'import_unknown',ownerPresent:false,resourceCount:2,admissionId:'admission',checkpointId:4,checkpointHash:hash,auditSelection:admissionSelection};
 const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
 globalThis.fetch=async(input,init)=>{
  const url=String(input);assert(!init?.method||init.method==='GET','audit UI must never POST');calls.push(url);
  if(url.includes('/discovery?'))return json({items:[url.includes('kind=captures')?captureRow:admissionRow]});
  if(url.includes('/destination-groups?'))return json({error:'Source owner unavailable'},409);
  if(url.includes('/destination-groups/journal?')){
   reads++;if(stale)return json({error:'Original journal or custody hash changed; rediscover'},409);
   const s=Object.fromEntries(new URL(url,window.location.origin).searchParams),expected=s.kind==='captures'?captureSelection:admissionSelection;
   assert(JSON.stringify(Object.keys(s).sort().map(k=>[k,s[k]]))===JSON.stringify(Object.keys(expected).sort().map(k=>[k,expected[k as keyof typeof expected]])),'selector copied verbatim');
   const base={historical:true,currentAuthority:false,actionEligible:false,held:true,selection:expected,sourceOwnerPresent:false,state:s.kind==='captures'?'capturing':'import_unknown',journalSha256:hash,evidenceSha256:hash};
   return json(s.kind==='captures'?{...base,capture:{sources:[0,1].map(i=>({checkpointId:`package${i}`,sourceChatId:`chat${i}`})),receipts:[]}}:{...base,reservationHash:hash,resources,idMap:{source0:'mapped0',source1:'mapped1'},agentMap:{old0:'new0',old1:'new1'},imports:[{sourceChatId:'chat0',operationId:'import0',status:'unknown'},{sourceChatId:'chat1',operationId:'import1',status:'preparing'}],owners:resources.map(r=>({...r.destination,present:false,commandPresent:false})),receipt:null,retirement:null});
  }
  throw Error('Unexpected read '+url);
 };
 try{
  const detail={execution:{id:'current-source',branchId:'branch',state:'completed'},resources:[],paths:[],steps:[],attempts:[],gates:[]};
  root.render(<QueryClientProvider client={client}><BranchGroupReview detail={detail as never} enabled onChanged={()=>{}}/></QueryClientProvider>);await settle();button('Review Resource Group').click();await settle();
  button('Restart Admission Discovery').click();await settle();button('Read Discovered Admission Command').click();await settle();
  assert(document.body.textContent?.includes('Source owner unavailable'),'scoped current-authority refusal preserved');assert(Boolean(button('Read Historical Group Audit')),'audit selector remains after scoped refusal');
  button('Read Historical Group Audit').click();await settle();
  assert(document.body.textContent?.includes('currentAuthority: false')&&document.body.textContent?.includes('actionEligible: false')&&document.body.textContent?.includes('held: true'),'audit envelope always nonauthorizing');
  assert(document.body.textContent?.includes('new1')&&document.body.textContent?.includes('import1'),'full non-first maps and import statuses visible');
  assert(!button('Approve Whole-Group Disclosure')&&!button('Admit Whole Group')&&Boolean(button('Prepare Held Group')?.disabled),'historical audit cannot create a current target');
  stale=true;button('Read Historical Group Audit').click();await settle();assert(!button('Read Historical Group Audit'),'stale409 removes selector and requires rediscovery');assert(!document.body.textContent?.includes('new1'),'stale audit evidence cleared');assert(reads===2,'no automatic retry');
  stale=false;button('Restart Capture Discovery').click();await settle();assert(document.body.textContent?.includes('Unsupported legacy capture'),'legacy ordinary command unsupported');
  assert(!button('Read Discovered Capture Command'),'no plaintext key guessed');button('Read Historical Group Audit').click();await settle();assert(document.body.textContent?.includes('package1'),'legacy retained capture audit works without plaintext key');
  assert(calls.filter(url=>url.includes('/journal?')).length===3,'audit uses only deliberate exact GET reads');
 }finally{root.unmount();client.clear();host.remove();globalThis.fetch=originalFetch;}
}
