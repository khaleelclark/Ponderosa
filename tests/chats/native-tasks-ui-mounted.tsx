// Deferred DOM fixture. No execution or preparation authorized.
import {createRoot} from 'react-dom/client';
import {NativeTaskControls} from '../../apps/web/src/components/NativeTaskControls';
import {currentProductScope} from '../../apps/web/src/api/productScope';
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const click=async(text:string)=>{const button=Array.from(document.querySelectorAll('button')).find(b=>b.textContent===text);assert(button&&!button.disabled,text);button!.click();await settle();};
export async function nativeTasksUiRegression(){
 const host=document.createElement('div');document.body.append(host);let root=createRoot(host);const original=globalThis.fetch;
 const agent:any={id:'native-task-source',projectId:'project',conversationId:'chat',activeEngine:'claude',workingCopy:{state:'ready',rootPath:'/work'}};
 const key=`native-task-stops:${JSON.stringify([window.location.origin,currentProductScope(),agent.id])}`,prior=localStorage.getItem(key);localStorage.removeItem(key);
 let posts=0,body:any,boundary={runId:'source-run',sourceFence:9,sessionId:'native-session'};const gets:string[]=[];
 globalThis.fetch=async(input,init)=>{
  const url=String(input);assert(url.includes('/native-tasks'),'operator task routes only');
  if(init?.method==='POST'){posts++;body=JSON.parse(String(init.body));assert(JSON.stringify(JSON.parse(localStorage.getItem(key)!)[0])===JSON.stringify(body),'persist exact command before POST');throw Error('Lost response');}
  gets.push(url);if(url.includes('/stops/'))return new Response(JSON.stringify({...body,outcome:'acknowledged',processDrainObserved:false}),{headers:{'content-type':'application/json'}});
  return new Response(JSON.stringify({...boundary,tasks:[{taskKey:'exact-key',taskId:'actual-native',kind:'background',cancellable:true},{taskKey:'cron-key',taskId:'actual-cron',kind:'cron',cancellable:false}]}),{headers:{'content-type':'application/json'}});
 };
 try{
  root.render(<NativeTaskControls agent={agent}/>);await settle();await click('Inspect Native Tasks');await click('Refresh Live Inventory');
  assert(Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Native Stop Unavailable'&&b.disabled),'cron cannot stop');
  await click('Stop Native Task');await click('Stop Task');assert(posts===1,'one POST');
  root.unmount();root=createRoot(host);root.render(<NativeTaskControls agent={agent}/>);await settle();await click('Inspect Native Tasks');await click('Read Original Receipt');
  assert(posts===1&&gets.some(url=>url.includes(`/stops/${body.idempotencyKey}`)&&url.includes('sourceFence=9')),'remount GET original key/boundary only');
  assert(document.body.textContent?.includes('acknowledged')&&document.body.textContent?.includes('processDrainObserved: false'),'honest acknowledgment');
  boundary={runId:'replacement-run',sourceFence:10,sessionId:'new-session'};await click('Refresh Live Inventory');await click('Read Original Receipt');assert(posts===1,'drift recovery never sends native stop');
 }finally{root.unmount();host.remove();globalThis.fetch=original;if(prior===null)localStorage.removeItem(key);else localStorage.setItem(key,prior);}
}
