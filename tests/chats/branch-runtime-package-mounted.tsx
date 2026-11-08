import {readPackageCommand,savePackageCommand} from '../../apps/web/src/components/branches/branchPackageJournal';
// Deferred DOM fixture. No Node/browser/provider execution or preparation authorized.
import {createRoot} from 'react-dom/client';
import {BranchRuntimeReadback,RuntimePrivateFacts} from '../../apps/web/src/components/branches/BranchRuntimePackageReview';
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const settle=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setTimeout(resolve,0));};
export async function branchRuntimeReadbackRegression(){
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),original=globalThis.fetch;let requests=0,acknowledged=0,wrong=true;
 const sha='a'.repeat(64),data:any={schema:'ponderosa.branch-runtime-data.v1',sourceBranchId:'source',sha256:sha,identities:{chats:{'source-chat':'chat-ref'},agents:{}},owners:[{sourceExecutionId:'source-owner',sourceBranchId:'source',chatRefs:['chat-ref'],sha256:'b'.repeat(64),facts:[{kind:'frontier',key:'current',json:'{"traversals":9,"state":"outcome_unknown","privateText":"All retained bytes"}',sha256:'c'.repeat(64)}]}]};
 const receipt={schema:'ponderosa.branch-runtime-import.v1',planId:'plan',branchId:'destination',manifestSha256:sha,disposition:'held',currentAuthority:false,dispatched:false,workflowEnabled:false,credentials:'reenter',nativeState:'not_adopted',createdAt:'2026-11-01T00:00:00Z',executionMap:{'source-owner':'fresh-owner'},chatMap:{'source-chat':'fresh-chat'},agentMap:{},frontiers:{'source-owner':{disposition:'evidence_only',reason:'Unknown native effects',idMap:{}}}};
 globalThis.fetch=async(input,init)=>{assert(!init?.method||init.method==='GET','read-only GET; no installation replay');assert(String(input).includes('/installations/plan/runtime-data?branchId=destination'),'exact saved installation and destination');requests++;return new Response(JSON.stringify({receipt:{...receipt,branchId:wrong?'foreign':'destination'},data}),{headers:{'content-type':'application/json'}});};
 try{
  root.render(<><RuntimePrivateFacts data={data}/><BranchRuntimeReadback planId="plan" branchId="destination" manifestSha256={sha} expected={data} onVerified={()=>acknowledged++}/></>);await settle();assert(requests===0,'explicit private data read');
  data.owners[0].facts.push({kind:'command',key:'resource-final-exit:step:0',json:'{"retained":"original"}',sha256:'d'.repeat(64)});
  root.render(<><RuntimePrivateFacts data={data}/><BranchRuntimeReadback planId="plan" branchId="destination" manifestSha256={sha} expected={data} onVerified={()=>acknowledged++}/></>);await settle();
  assert(document.body.textContent?.includes('Retired resource exit included · execution held pending a supported destination review'),'Import must clearly identify held final-resource data');
  const original=structuredClone(data),nested:any={...data,owners:[{...data.owners[0],facts:[{kind:'import',key:'original',json:JSON.stringify({data:original}),sha256:'e'.repeat(64)}]}]};
  nested.owners[0].facts.push({kind:'custody',key:'missing',json:'{"disposition":"unavailable_held"}',sha256:'f'.repeat(64)});
  root.render(<RuntimePrivateFacts data={nested}/>);await settle();
  assert(document.body.textContent?.includes('Retired resource exit included · execution held pending a supported destination review')&&document.body.textContent?.includes('Some checkpoint data was unavailable at export'),'Nested re-export must retain the held and unavailable warnings');
  nested.owners[0].facts=[{kind:'tree-continuation',key:'original',json:JSON.stringify({held:{data:original}}),sha256:'e'.repeat(64)}];
  root.render(<RuntimePrivateFacts data={nested}/>);await settle();
  assert(document.body.textContent?.includes('Retired resource exit included · execution held pending a supported destination review'),'Nested tree continuation must retain the held-resource warning');
  root.render(<><RuntimePrivateFacts data={data}/><BranchRuntimeReadback planId="plan" branchId="destination" manifestSha256={sha} expected={data} onVerified={()=>acknowledged++}/></>);await settle();

  const click=async(text:string)=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent===text);assert(b,text);b!.click();await settle();};
  await click('Read saved runtime data');assert(document.body.textContent?.includes('differs'),'foreign receipt held');assert(acknowledged===0,'cannot acknowledge wrong receipt');
  wrong=false;await click('Read saved runtime data');assert(document.body.textContent?.includes('Unknown native effects')&&document.body.textContent?.includes('source-chat')&&document.body.textContent?.includes('fresh-chat'),'exact maps and evidence-only reason');assert(document.body.textContent?.includes('All retained bytes')&&document.body.textContent?.includes('traversals'),'every private fact byte retained in reveal');
  await click('Acknowledge held runtime receipt');assert(acknowledged===1&&requests===2,'deliberate readback acknowledgment only');
  const compressed:any={...data,schema:'ponderosa.branch-runtime-data.v2',owners:[{...data.owners[0],facts:[{kind:'import',key:'original',sha256:'e'.repeat(64),json:JSON.stringify({schema:'ponderosa.runtime-import-bytes.v1',dataEncoding:'gzip',dataBase64:'opaque-exact-bytes'})}]}]};
  let reads=0;
  globalThis.fetch=async(input,init)=>{
   assert(!init?.method||init.method==='GET','selected source inspection is read only');
   const url=new URL(String(input),location.origin);assert(url.pathname.endsWith('/installations/plan/runtime-import-facts'),'saved preview scope');
   assert(url.searchParams.get('manifestSha256')===sha&&url.searchParams.get('path')===JSON.stringify(['source-owner']),'exact manifest and imported owner path');
   reads++;
   return new Response(JSON.stringify(url.searchParams.has('kind')?{manifestSha256:sha,sourceManifestSha256:'f'.repeat(64),fact:{kind:'frontier',key:'current',sha256:'c'.repeat(64),json:'{"text":"Readable original retained history"}'}}:{manifestSha256:sha,sourceManifestSha256:'f'.repeat(64),status:{finalResource:true,unavailable:true},receipt:{dispatched:false},owners:[{sourceExecutionId:'prior-owner',sha256:'b'.repeat(64),facts:[{kind:'frontier',key:'current',sha256:'c'.repeat(64),bytes:47}]}]}),{headers:{'content-type':'application/json'}});
  };
  root.render(<RuntimePrivateFacts data={compressed} inspection={{planId:'plan',manifestSha256:sha}}/>);await settle();
  assert(reads===0&&document.body.textContent?.includes('Inspect prior imported history before acknowledging'),'compressed nested status disclosed before acknowledgment without automatic byte reads');
  await click('Inspect prior imported history');assert(document.body.textContent?.includes('Prior history includes a retired resource exit')&&document.body.textContent?.includes('Prior history includes checkpoint data that was unavailable'),'decoded nested warning summary is readable');assert(reads===1&&!document.body.textContent?.includes('Readable original retained history'),'inventory alone does not dump fact contents');
  await click('Read selected fact');assert(reads===2&&document.body.textContent?.includes('Readable original retained history'),'selected compressed-source fact is readable without a browser decoder');

 }finally{root.unmount();host.remove();globalThis.fetch=original;}
}

import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {BranchPackageDialog} from '../../apps/web/src/components/branches/BranchPackageDialog';
import {BranchRuntimeOwnerReadback} from '../../apps/web/src/components/branches/BranchRuntimePackageReview';
import {currentProductScope} from '../../apps/web/src/api/productScope';
export async function branchTreePackageRecoveryRegression(){
 const host=document.createElement('div');document.body.append(host);let root=createRoot(host);const original=globalThis.fetch;
 const sha='a'.repeat(64),treeSha='b'.repeat(64),digest='c'.repeat(64),definition:any={name:'Tree',trigger:{kind:'manual'},steps:[],parameters:{root:{type:'string',default:'must-not-rewrite'}}};
 const rootNode:any={sourceBranchId:'root-source',sourceVersionId:'v',sourceBindingRevisionId:'b',packageId:'tree-fixture',definition,agentBindings:{},chatRefs:[],limits:{},configuration:{limits:{}},dependencies:{child:'child-source'}};
 const childNode={...rootNode,sourceBranchId:'child-source',definition:{...definition,name:'Child'},dependencies:{}};
 const owner={sourceExecutionId:'source-owner',sourceBranchId:'root-source',chatRefs:[],sha256:sha,facts:[{kind:'tree-import',key:'original',json:'{"private":"complete retained generation","state":"outcome_unknown"}',sha256:sha}]};
 const branchData:any={schema:'ponderosa.branch-runtime-data.v1',sourceBranchId:'root-source',sha256:sha,identities:{chats:{},agents:{}},owners:[owner]};
 const data:any={schema:'ponderosa.branch-runtime-tree.v1',rootSourceBranchId:'root-source',sha256:sha,branches:{'root-source':branchData,'child-source':{...branchData,sourceBranchId:'child-source',owners:[]}}};
 const pkg:any={schema:'ponderosa.branch-installation.v1',packageId:'tree-fixture-'+crypto.randomUUID(),mode:'full',exportedAt:'2026-11-01T00:00:00Z',definition,parameters:{root:'original'},chats:[],agentBindings:{},limits:{},definitionTree:{rootSourceBranchId:'root-source',packageSha256:sha,sha256:treeSha,nodes:[rootNode,childNode]},executionTree:data};
 const receipt:any={schema:'ponderosa.branch-runtime-tree-import.v1',planId:'tree-plan',rootBranchId:'fresh-root',manifestSha256:sha,held:true,currentAuthority:false,dispatched:false,branchMap:{'root-source':'fresh-root','child-source':'fresh-child'},executionMap:{'source-owner':'fresh-owner'},chatMap:{},agentMap:{},frontiers:{'source-owner':{disposition:'evidence_only',reason:'Unknown native effects',idMap:{}}},reservedFrontiers:{'source-owner':{}},ownerPins:{'source-owner':{versionId:'fresh-v',bindingRevisionId:'fresh-b'}}};
 const key=`branch-package-command:${JSON.stringify([window.location.origin,currentProductScope(),pkg.packageId,null,treeSha,sha])}`,prior=localStorage.getItem(key);localStorage.removeItem(key);
 let posts=0,previews=0,statusReads=0,reads=0,opened=0,known=false,reviewed:any,definitionReceipt:any;
 const click=async(text:string)=>{const button=Array.from(document.querySelectorAll('button')).find(b=>b.textContent===text);assert(button,text);button!.click();await settle();};
 const acknowledge=async(text:string)=>{const label=Array.from(document.querySelectorAll('label')).find(l=>l.textContent?.includes(text));assert(label,text);(label!.querySelector('input') as HTMLInputElement).click();await settle();};
 globalThis.fetch=async(input,init)=>{
  const url=String(input);
  if(url.endsWith('/install-preview')){previews++;const body=JSON.parse(String(init?.body));assert(JSON.stringify(body.package)===JSON.stringify(pkg),'exact package bytes without root parameter rewrite');assert(Object.keys(body.treeBindings).length===2&&body.treeBindings['root-source'].directories.workspace==='/root-destination'&&body.treeBindings['child-source'].directories.workspace==='/child-destination','every distinct destination Branch reviewed');
   const bindings=Object.fromEntries(pkg.definitionTree.nodes.map((n:any)=>[n.sourceBranchId,{...body.treeBindings[n.sourceBranchId],branches:n.dependencies}]));
   reviewed={id:'tree-plan',definitionTreeReview:{manifestSha256:treeSha,reviewSha256:digest,branches:2,bindings},runtimeDataReview:{manifestSha256:sha,owners:1,facts:1,disposition:'held',currentAuthority:false},fullImportReview:{mode:'full',warning:'Review private Agent context',agents:[]},operations:[{kind:'install-definition-tree',resource:'tree',label:'all nodes',after:{inventory:pkg.definitionTree,bindings,chatOwners:{}}},{kind:'retain-private-runtime-tree',resource:'runtime',label:'all facts',after:{data,frontiers:receipt.frontiers}}]};
   definitionReceipt={manifestSha256:treeSha,branchMap:receipt.branchMap,chatMap:{},agentMap:{},nodes:Object.fromEntries(pkg.definitionTree.nodes.map((n:any)=>[n.sourceBranchId,{...n,branchId:receipt.branchMap[n.sourceBranchId],versionId:'new-v',bindingRevisionId:'new-b',bindings:{...bindings[n.sourceBranchId],branches:Object.fromEntries(Object.entries(n.dependencies).map(([ref,source])=>[ref,receipt.branchMap[source as string]])),triggers:{}}}])),executionOwners:1,currentAuthority:false,dispatched:false,workflowEnabled:false};
   return new Response(JSON.stringify(reviewed));
  }
  if(url.endsWith('/tree-plan/confirm')){posts++;const body=JSON.parse(String(init?.body)),saved=await readPackageCommand(key) as any;assert(saved.preview.id==='tree-plan'&&saved.body.acknowledgeDefinitionTreeSha256===digest&&saved.body.acknowledgeRuntimeDataSha256===sha,'original plan/body saved before effect');assert(body.acknowledgeDefinitionTreeSha256===digest&&body.acknowledgeRuntimeDataSha256===sha&&body.acknowledgeFullImport,'independent digests and full context');throw Error('Lost confirmation response');}
  if(url.includes('/runtime-data?branchId=fresh-root')){reads++;assert(!init?.method||init.method==='GET','saved readback is GET');return new Response(JSON.stringify({receipt,data}));}
  if(url.endsWith('/installations/tree-plan')){statusReads++;assert(!init?.method||init.method==='GET','unknown recovery is GET');if(!known)throw Error('Status temporarily unavailable');return new Response(JSON.stringify({state:'completed',branchId:'fresh-root',definitionTreeReceipt:definitionReceipt,runtimeTreeReceipt:receipt}));}
  if(url.endsWith('/branches/fresh-root'))return new Response(JSON.stringify({id:'fresh-root',name:'Tree',enabled:false}));
  throw Error(`Unexpected request ${url}`);
 };
 const mount=async()=>{const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});root.render(<QueryClientProvider client={client}><BranchPackageDialog pkg={pkg} branches={[]} engines={[{id:'claude'}] as any} onClose={()=>{}} onInstalled={()=>{opened++;return true}}/></QueryClientProvider>);await settle();};
 try{
  await mount();assert(!document.querySelector('input[value="original"]'),'no editable root parameters for hash-bound tree');
  for(const [source,directory] of [['root-source','/root-destination'],['child-source','/child-destination']]){const field=document.querySelector(`textarea[aria-label="Destination bindings JSON: ${source}"]`)??Array.from(document.querySelectorAll('textarea')).find(t=>t.id===document.querySelector(`label[for="${t.id}"]`)?.getAttribute('for')&&document.querySelector(`label[for="${t.id}"]`)?.textContent?.includes(source));assert(field,source);const value=JSON.stringify({agents:{},directories:{workspace:directory},engines:{default:'claude'}});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field,value);field!.dispatchEvent(new Event('input',{bubbles:true}));await settle();}
  await click('Review changes');const confirm=()=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Confirm import')!;assert(confirm().disabled,'independent consents required');
  await acknowledge('every Branch definition');assert(confirm().disabled,'definition alone is insufficient');await acknowledge('all private runtime facts');assert(confirm().disabled,'runtime hashes do not replace full context');await acknowledge('imported Agent context and files');await click('Confirm import');assert(posts===1&&Boolean(await readPackageCommand(key)),'unknown original retained');assert(opened===0,'unknown cannot open');
  root.unmount();root=createRoot(host);known=true;await mount();assert(posts===1&&previews===1&&statusReads>0,'remount original status GET without preview/confirm replay');assert(opened===0,'completion does not adopt or open runtime data');await click('Acknowledge saved definition-tree receipt');assert(opened===0,'definition receipt alone cannot open');await click('Read saved runtime data');assert(reads===1&&document.body.textContent?.includes('complete retained generation'),'exact tree facts available');await click('Acknowledge held runtime receipt');assert(opened===1&&posts===1,'deliberate exact saved receipts permit navigation only');
  for(const target of [undefined,'existing-caption-target']){
   root.unmount();root=createRoot(host);
   const planId=target?'caption-update':'caption-import',destination=target??'fresh-caption-target';let confirmations=0,captionOpened=0;
   const template:any={schema:'ponderosa.branch-installation.v1',packageId:'caption-'+crypto.randomUUID(),mode:'template',exportedAt:'2026-11-08T00:00:00Z',definition:{schema:'ponderosa.branch.v1',name:'Caption workflow',trigger:{kind:'manual'},entry:'review',steps:[{id:'review',kind:'human_gate',prompt:'Review'}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},chats:[],agentBindings:{},limits:{},engines:{default:'codex'}};
   globalThis.fetch=async(input,init)=>{
    const url=String(input);
    if(url.endsWith('/install-preview')){const body=JSON.parse(String(init?.body));assert(body.branchId===target,'Preview uses the actual requested target, independent of result identity');return new Response(JSON.stringify({id:planId,operations:[]}));}
    if(url.endsWith(`/installations/${planId}/confirm`)){assert(init?.method==='POST','Explicit component confirmation');confirmations++;return new Response(JSON.stringify({state:'completed',branchId:destination}));}
    if(url.endsWith(`/installations/${planId}`))return new Response(JSON.stringify({state:'completed',branchId:destination}));
    if(url.endsWith(`/branches/${destination}`))return new Response(JSON.stringify({id:destination,name:'Caption workflow',enabled:false}));
    throw Error(`Unexpected caption request ${url}`);
   };
   const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
   root.render(<QueryClientProvider client={client}><BranchPackageDialog pkg={template} branchId={target} branches={[]} engines={[{id:'codex'}] as any} onClose={()=>{}} onInstalled={branch=>{assert(branch.id===destination,'Completed destination remains exact');captionOpened++;return true}}/></QueryClientProvider>);await settle();
   const label=Array.from(document.querySelectorAll('label')).find(l=>l.textContent==='Default working directory');assert(label,'Directory review field retained');const field=document.getElementById(label!.htmlFor) as HTMLInputElement;assert(field,'Owned synthetic directory field');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,'/synthetic-caption-workspace');field.dispatchEvent(new Event('input',{bubbles:true}));await settle();
   await click('Review changes');await click(target?'Confirm update':'Confirm import');
   const noun=target?'update':'import',other=target?'import':'update';assert(document.body.textContent?.includes(`Workflow ${noun} completed. Review the mapped Settings and retained folders before opening it.`),'Completed caption matches the original target and keeps review guidance');assert(!document.body.textContent?.includes(`Workflow ${other} completed.`),'Result branchId cannot turn a fresh import into an update');assert(confirmations===1&&captionOpened>0,'One explicit confirmation per mode and completed readback reached');
   root.unmount();client.clear();root=createRoot(host);
  }

 }finally{root.unmount();host.remove();globalThis.fetch=original;if(prior===null)localStorage.removeItem(key);else localStorage.setItem(key,prior);}
}

export async function reopenedTreeOwnerReadbackRegression(){
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),original=globalThis.fetch;let gets=0;
 const sha='a'.repeat(64),data:any={schema:'ponderosa.branch-runtime-tree.v1',sha256:sha,rootSourceBranchId:'root',branches:{root:{schema:'ponderosa.branch-runtime-data.v1',sourceBranchId:'root',sha256:sha,identities:{chats:{},agents:{}},owners:[]},child:{schema:'ponderosa.branch-runtime-data.v1',sourceBranchId:'child',sha256:sha,identities:{chats:{},agents:{}},owners:[{sourceExecutionId:'old-child',sourceBranchId:'child',chatRefs:[],sha256:sha,facts:[{kind:'frontier',key:'all',json:'{"state":"unknown","counters":17}',sha256:sha}]}]}}};
 const receipt:any={schema:'ponderosa.branch-runtime-tree-import.v1',planId:'owner-plan',rootBranchId:'fresh-root',manifestSha256:sha,held:true,currentAuthority:false,dispatched:false,branchMap:{root:'fresh-root',child:'fresh-child'},executionMap:{'old-child':'fresh-owner'},chatMap:{},agentMap:{},frontiers:{'old-child':{disposition:'evidence_only',reason:'Unknown leaf',idMap:{}}},reservedFrontiers:{'old-child':{}},ownerPins:{'old-child':{versionId:'v',bindingRevisionId:'b'}}};
 globalThis.fetch=async(input,init)=>{assert(!init?.method||init.method==='GET','reopened held owner has no mutation');gets++;const url=String(input);if(url.endsWith('/installations/owner-plan'))return new Response(JSON.stringify({state:'completed',runtimeTreeReceipt:receipt}));assert(url.includes('/runtime-data?branchId=fresh-root'),'child uses actual installation root from status; never guessed child root');return new Response(JSON.stringify({receipt,data}));};
 try{root.render(<BranchRuntimeOwnerReadback planId="owner-plan" branchId="fresh-child" executionId="fresh-owner" sourceExecutionId="old-child" manifestSha256={sha}/>);await settle();assert(gets===0,'no automatic private-data read');const click=async(text:string)=>{Array.from(document.querySelectorAll('button')).find(b=>b.textContent===text)!.click();await settle();};await click('Inspect original installation status');await click('Read saved runtime data');assert(gets===2&&document.body.textContent?.includes('Unknown leaf')&&document.body.textContent?.includes('counters'),'schema tree and complete private leaf retained with held semantics');assert(!Array.from(document.querySelectorAll('button')).some(b=>/Confirm import|Run|Resume/.test(b.textContent??'')),'no execution authority or import replay');}
 finally{root.unmount();host.remove();globalThis.fetch=original;}
}

export async function branchPackageJournalRegression(){
 const key='package-journal-regression:'+crypto.randomUUID(),command={package:{history:'x'.repeat(6*1024*1024)},preview:{id:'original'},body:{confirm:true}};
 await savePackageCommand(key,command,()=>false);
 const retained=await readPackageCommand(key) as typeof command;
 assert(retained.package.history===command.package.history,'complete package above localStorage quota survives');
 let refused=false;
 try{await savePackageCommand(key,{...command,preview:{id:'replacement'}},()=>false);}catch{refused=true;}
 assert(refused&&(await readPackageCommand(key) as typeof command).preview.id==='original','conflicting command never replaces original');
 const legacyKey=key+':legacy';
 localStorage.setItem(legacyKey,JSON.stringify({original:'legacy'}));
 try{assert((await readPackageCommand(legacyKey) as any).original==='legacy','earlier exact commands remain recoverable');}
 finally{localStorage.removeItem(legacyKey);}
}
