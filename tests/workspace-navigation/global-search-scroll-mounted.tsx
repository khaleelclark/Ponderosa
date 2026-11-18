// UI033: actual GlobalChatSearch in a real browser. The dialog stays inside the
// viewport, only its results body scrolls, and keyboard selection moves that body.
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {GlobalChatSearch} from '../../apps/web/src/components/GlobalChatSearch';
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const until=async(test:()=>boolean,label:string)=>{const end=performance.now()+3000;while(!test()){if(performance.now()>end)throw Error(label);await new Promise(resolve=>setTimeout(resolve,10));}};
const press=async(target:HTMLElement,key:string,times:number)=>{for(let index=0;index<times;index++){target.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));await new Promise(resolve=>setTimeout(resolve,0));}};
const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
export async function globalSearchBoundedScrollRegression():Promise<void>{
 const background=document.createElement('div');background.style.height='4000px';document.body.append(background);
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),original=globalThis.fetch;
 const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false,gcTime:Infinity}}});
 const longTitle='Quarterly-planning-'+'x'.repeat(400);
 const recentChats=Array.from({length:40},(_,index)=>({project:{id:'p',label:'Project'},chat:{kind:'conversation',id:'chat-'+index,title:index===3?longTitle:'Chat '+index},lastActivityAt:'2026-11-11T12:00:00Z',snippet:'Unbroken'+'y'.repeat(300),unreadCount:index%5}));
 const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
 globalThis.fetch=async raw=>{
  const url=new URL(String(raw),location.origin);
  if(url.pathname==='/api/search')return json({query:'',results:[],recentChats,scannedMessages:0,truncated:false});
  if(url.pathname==='/api/notifications')return json({items:[],openActionCount:0,unacknowledgedActionCount:0,unreadUpdateCount:0});
  throw Error('Unexpected read '+url.pathname);
 };
 try{
  window.scrollTo(0,0);
  root.render(<QueryClientProvider client={client}><GlobalChatSearch open onClose={()=>{}} onSelect={()=>{}}/></QueryClientProvider>);
  await until(()=>Boolean(document.getElementById('global-search-option-39')),'Recent Chats did not render');await frame();
  const paper=document.querySelector('[role="dialog"]') as HTMLElement,header=paper.querySelector('header') as HTMLElement;
  const body=paper.querySelector('.MuiDialogContent-root') as HTMLElement,input=paper.querySelector('input') as HTMLInputElement;
  const scope=Array.from(paper.querySelectorAll('[aria-pressed]')).find(node=>node.textContent==='Files') as HTMLElement;
  assert(paper.getBoundingClientRect().bottom<=innerHeight&&paper.getBoundingClientRect().top>=0,'Dialog is bounded by the viewport');
  assert(body.scrollHeight>body.clientHeight,'Fixture overflows the results body');
  const overflow=Array.from(paper.querySelectorAll<HTMLElement>('*')).filter(node=>node.getBoundingClientRect().right>paper.getBoundingClientRect().right+1&&node.getBoundingClientRect().width>0).map(node=>node.tagName+'.'+node.className.toString().split(' ').slice(0,2).join('.'));
  assert(body.scrollWidth<=body.clientWidth+1&&paper.scrollWidth<=paper.clientWidth+1&&!overflow.length,'Long titles and snippets stay contained: '+overflow.slice(0,4).join(' | ')+` body ${body.scrollWidth}/${body.clientWidth} paper ${paper.scrollWidth}/${paper.clientWidth}`);
  const headerTop=header.getBoundingClientRect().top;
  input.focus();
  await press(input,'ArrowDown',40);
  await until(()=>input.getAttribute('aria-activedescendant')==='global-search-option-39','Keyboard selection did not reach the last result');
  await frame();
  const last=document.getElementById('global-search-option-39')!.getBoundingClientRect(),view=body.getBoundingClientRect();
  assert(body.scrollTop>0&&last.bottom<=view.bottom+1&&last.top>=view.top-1,'Active result is scrolled into the results body');
  assert(paper.scrollTop===0&&(paper.parentElement as HTMLElement).scrollTop===0,'Dialog and container do not scroll');
  assert(document.scrollingElement!.scrollTop===0,'Background workspace does not scroll');
  assert(Math.abs(header.getBoundingClientRect().top-headerTop)<1&&scope.getBoundingClientRect().bottom<=view.top+1,'Search field and filters stay reachable above the body');
  await press(input,'ArrowUp',39);
  await until(()=>input.getAttribute('aria-activedescendant')==='global-search-option-0','Keyboard selection did not return to the first result');await frame();
  const first=document.getElementById('global-search-option-0')!.getBoundingClientRect();
  assert(first.top>=body.getBoundingClientRect().top-1,'Moving up scrolls the body back to the first result');
 }finally{
  root.unmount();client.clear();host.remove();background.remove();globalThis.fetch=original;
 }
}
