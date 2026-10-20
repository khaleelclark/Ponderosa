// Real shared rendering and native intersection geometry; bounded synthetic scrolling, not a physical trackpad latency measurement.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { ChatSurface } from '../../../../apps/web/src/components/chat/ChatSurface';
import { ChatMessageFrame } from '../../../../apps/web/src/components/chat/ChatMessageFrame';
import { ChatMessageBody } from '../../../../apps/web/src/components/chat/ChatMessages';
import { createPonderosaTheme } from '../../../../apps/web/src/theme';
import '../../../../apps/web/src/global.css';
const counts = { observe: 0, unobserve: 0, callbacks: 0, visible: 0 };
const NativeObserver = window.IntersectionObserver;
window.IntersectionObserver = class extends NativeObserver {
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    super((entries, observer) => { counts.callbacks++; callback(entries, observer); }, options);
  }
  observe(element: Element) { counts.observe++; super.observe(element); }
  unobserve(element: Element) { counts.unobserve++; super.unobserve(element); }
};
const text = `A representative message with **formatting**, a list, and a table.\n\n- Preserve the reader's position when new content arrives.\n- Existing messages stay accessible and selectable.\n\n| Area | Check | Result |\n| --- | --- | --- |\n| Scrolling | Native rendering | Under investigation |\n| Layout | Stable composer | Preserved |\n\nA final paragraph with enough prose to occupy a few lines without any external resources.`;
const rows = Array.from({length:100}, (_,i) => <ChatMessageFrame key={i} message={{id:`fixture-message-${i}`,author:{kind:'agent',name:`Agent ${i}`},createdAt:'2026-10-20T12:00:00Z',onVisible: visible => { if (visible) counts.visible++; },body:<ChatMessageBody text={`${i + 1}. ${text}`} collapseLongMessage={false} />}} />);
const frame = () => new Promise<number>((resolve,reject) => { const timer=setTimeout(()=>reject(Error(`No frame: visibility=${document.visibilityState}; focus=${document.hasFocus()}`)),2000); window.requestAnimationFrame(time=>{clearTimeout(timer);resolve(time);}); });
function App() {
  const [report,setReport]=useState('Run the bounded native scrolling replay. No server, account, or production data.');
  const run = async () => {
    setReport('Running');
    await frame(); await frame();
    const root=document.querySelector<HTMLElement>('.chat-scroll-region')!;
    const end=root.scrollHeight-root.clientHeight;
    Object.assign(counts,{observe:0,unobserve:0,callbacks:0,visible:0});
    const times:number[]=[]; let previous=await frame();
    for(let i=1;i<=120;i++) { root.scrollTop=end*(1-i/120); const now=await frame(); times.push(now-previous);previous=now; }
    await frame(); await frame();
    const sorted=[...times].sort((a,b)=>a-b);
    setReport(JSON.stringify({messages:100,frames:120,...counts,p95FrameMs:Number(sorted[Math.floor(sorted.length*.95)].toFixed(2)),maxFrameMs:Number(sorted.at(-1)!.toFixed(2)),over25ms:times.filter(v=>v>25).length},null,2));
  };
  return <ThemeProvider theme={createPonderosaTheme('dark')}><CssBaseline/><main style={{height:'100dvh',display:'flex',flexDirection:'column'}}><header style={{padding:12}}><button onClick={()=>void run().catch(e=>setReport(String(e)))}>Replay 120 scrolling frames</button><pre role="status" style={{fontSize:13,margin:0}}>{report}</pre></header><div style={{flex:1,minHeight:0}}><ChatSurface layout="project" layoutKey="fixture" follow={{kind:'latest',storageKey:'scroll-fixture-position'}}>{rows}</ChatSurface></div><footer style={{padding:12}}>Synthetic 100-message chat using the real shared surface, message renderer and notification visibility code.</footer></main></ThemeProvider>;
}
createRoot(document.getElementById('root')!).render(<App/>);
