// Deferred mounted regression; run only in the existing browser harness when authorized.
import {createRoot} from 'react-dom/client';
import {DirectReplyPreview} from '../../apps/web/src/components/chat/DirectReplyPreview';
import {api} from '../../apps/web/src/api';
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const settle=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setTimeout(resolve,0));};
export async function requestReplyPreviewRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const originalRead=api.getTextReplyStatus,originalSubscribe=api.subscribeAgent;
 const calls:string[][]=[];let wake=()=>{};
 let status:any={messageId:'request',runId:'run',runStatus:'running',memoryExposure:{state:'valid',runId:'run',sessionResetSeq:1,projectGeneration:2,globalGeneration:3},reply:{presentation:'text',purpose:'answer',projectId:'project',conversationId:'chat',agentId:'recipient',messageId:'request',runId:'run',fence:1,streamId:'stream',sequence:1,state:'streaming',text:'Exact private draft',publication:{kind:'request_update',requestId:'request',updateKind:'completed'}}};
 api.getTextReplyStatus=async(...args)=>{calls.push(args);return status;};
 api.subscribeAgent=((_id:unknown,_cursor:unknown,handlers:any)=>{wake=()=>handlers.onStatus?.();return {close(){}};}) as typeof api.subscribeAgent;
 const render=(key:string,state:'in_progress'|'completed'='in_progress')=>root.render(<DirectReplyPreview key={key} projectId="project" agentId="recipient" request={{id:'request',conversationId:'chat',state}}/>);
 try{
  render('valid');await settle();assert(host.textContent==='Exact private draft','exact Request draft displays');assert(calls.every(args=>args.join('/')==='chat/request/recipient'),'read exact Request route');
  status={...status,reply:{...status.reply,publication:{...status.reply.publication,requestId:'other'}}};wake();await settle();assert(!host.textContent?.includes('Exact private draft'),'foreign Request cannot render');
  status={...status,reply:{...status.reply,publication:{kind:'request_update',requestId:'request',updateKind:'completed'}}};render('memory');await settle();
  status={...status,memoryExposure:{...status.memoryExposure,projectGeneration:4}};wake();await settle();assert(!host.textContent?.includes('Exact private draft'),'memory drift revokes draft');
  render('terminal','completed');await settle();assert(!host.textContent,'canonical terminal Request hides provisional draft');
  status={...status,memoryExposure:undefined};render('missing-context');await settle();assert(!host.textContent?.includes('Exact private draft'),'missing memory validation fails closed');
 }finally{root.unmount();host.remove();api.getTextReplyStatus=originalRead;api.subscribeAgent=originalSubscribe;}
}
