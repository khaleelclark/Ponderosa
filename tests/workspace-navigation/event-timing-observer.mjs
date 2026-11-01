// Inject before navigation. Raw entries remain evidence, including zero-ID noninteractions.
export function installTimingObserver(){
 const state=window.__uiTiming={documentId:crypto.randomUUID(),events:[],lcp:[],errors:[],supported:PerformanceObserver.supportedEntryTypes,marks:[],threshold:16,cutoff:null,finalized:false,totalInteractions:null,countSupport:'unavailable',trustedInputs:[],eventCounts:null};
 const events=entries=>{for(const e of entries)state.events.push({name:e.name,startTime:e.startTime,duration:e.duration,processingStart:e.processingStart,processingEnd:e.processingEnd,interactionId:e.interactionId,target:e.target?.getAttribute('aria-label')??e.target?.tagName});};
 const paints=entries=>{for(const e of entries)state.lcp.push({startTime:e.startTime,renderTime:e.renderTime,loadTime:e.loadTime,size:e.size,id:e.id,element:e.element?.tagName});};
 let eventObserver,lcpObserver;
 try{eventObserver=new PerformanceObserver(list=>events(list.getEntries()));eventObserver.observe({type:'event',buffered:true,durationThreshold:16});}catch(error){state.errors.push(String(error));}
 try{lcpObserver=new PerformanceObserver(list=>paints(list.getEntries()));lcpObserver.observe({type:'largest-contentful-paint',buffered:true});}catch(error){state.errors.push(String(error));}
 const flush=()=>{events(eventObserver?.takeRecords()??[]);paints(lcpObserver?.takeRecords()??[]);};
 const cutoff=reason=>{if(state.cutoff)return;flush();state.cutoff={reason,time:performance.now()};};
 for(const type of ['pointerdown','pointerup','keydown','keyup','click'])addEventListener(type,e=>{if(e.isTrusted)state.trustedInputs.push({type,time:e.timeStamp,key:e.key,repeat:e.repeat,pointerId:e.pointerId});},{capture:true});
 for(const type of ['pointerdown','keydown'])addEventListener(type,e=>{if(e.isTrusted)cutoff('first-trusted-input');},{capture:true});
 addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')cutoff('hidden');});addEventListener('pagehide',()=>cutoff('pagehide'));
 window.__finalizeUiTiming=async()=>{
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,0))));flush();
  if(!state.cutoff)cutoff('explicit-finalize');
  // Only an independently supplied browser count can establish subfloor groups; never infer them from key presses.
  if(Number.isInteger(performance.interactionCount)&&performance.interactionCount>=0){state.totalInteractions=performance.interactionCount;state.countSupport='performance.interactionCount';}
  state.eventCounts=performance.eventCounts?Object.fromEntries(performance.eventCounts):null;state.nativeCountProperty=('interactionCount' in performance);state.finalized=true;state.visibility=document.visibilityState;state.finishedAt=performance.now();return state;
 };
}
export function summarizeTimings(sessions){
 if(!sessions.length)throw Error('No sessions');
 const durations=[],namespaces=new Set();let total=0,censored=0,complete=true;
 const sessionResults=sessions.map((session,index)=>{
  if(session.errors.length||!session.supported.includes('event')||!session.supported.includes('largest-contentful-paint'))throw Error('Unsupported or failed timing observer');
  const namespace=session.namespace??`session-${index}/${session.documentId??'legacy'}`;if(namespaces.has(namespace))throw Error('Duplicate document namespace');namespaces.add(namespace);
  const grouped=new Map();for(const entry of session.events)if(entry.interactionId)grouped.set(entry.interactionId,Math.max(grouped.get(entry.interactionId)??0,entry.duration));
  const eligible=session.lcp.filter(e=>!session.cutoff||e.startTime<=session.cutoff.time);
  if(!eligible.length)throw Error('Missing eligible LCP, never substitute zero');
  const values=[...grouped.values()];durations.push(...values);
  const supported=session.finalized===true&&session.visibility==='visible'&&session.countSupport==='performance.interactionCount'&&Number.isInteger(session.totalInteractions)&&session.totalInteractions>=values.length;
  if(!grouped.size&&!(supported&&session.totalInteractions>0))throw Error('Missing qualified discrete interactions, never substitute zero');
  complete&&=supported;if(supported){total+=session.totalInteractions;censored+=session.totalInteractions-values.length;}
  return {namespace,observedInteractions:values.length,totalInteractions:session.totalInteractions??null,censored:supported?session.totalInteractions-values.length:null,lcp:eligible.at(-1).startTime,lcpCutoff:session.cutoff??null,complete:supported,zeroIdEntries:session.events.filter(e=>!e.interactionId).length};
 });
 durations.sort((a,b)=>a-b);const observedP75=durations.length?durations[Math.ceil(.75*durations.length)-1]:null,rank=Math.ceil(.75*total);
 // Mixed thresholds cannot establish one subfloor population.
 complete&&=sessions.every(s=>s.threshold===16);
 const p75=complete?(rank<=censored?null:durations[rank-censored-1]):null;
 return {nSessions:sessions.length,nInteractions:durations.length,totalInteractions:complete?total:null,censored:complete?censored:null,qualifiedPopulation:complete,method:'per-document maxima; nearest-rank pooling; duration quantized by browser',observedP75,p75,p75BelowFloor:complete&&rank<=censored,reportingFloor:16,populationReason:complete?'browser count with finalized visible documents':'observed-only diagnostic; total/censoring or collection health unsupported',sessions:sessionResults};
}

export function latencyBreakdown(session){
 return session.events.filter(e=>e.interactionId).map(e=>({...e,inputDelayMs:e.processingStart-e.startTime,handlerMs:e.processingEnd-e.processingStart,presentationRemainderMs:Math.max(0,e.duration-(e.processingEnd-e.startTime))})).sort((a,b)=>b.duration-a.duration);
}
