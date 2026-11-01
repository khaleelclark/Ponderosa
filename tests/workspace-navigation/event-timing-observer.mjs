// Inject before navigation. Raw entries remain evidence, including zero-ID noninteractions.
export function installTimingObserver(){
 const state=window.__uiTiming={documentId:crypto.randomUUID(),events:[],lcp:[],errors:[],supported:PerformanceObserver.supportedEntryTypes,marks:[],threshold:16,cutoff:null,finalized:false,totalInteractions:null,countSupport:'unavailable',trustedInputs:[],eventCounts:null,window:{start:0,end:null,timeOrigin:performance.timeOrigin},lifecycle:[{type:'init',time:performance.now(),visibility:document.visibilityState}],health:{registered:false,callbacks:0,droppedEntries:null,drained:false}};
 const occurrence=e=>e.timeStamp>performance.timeOrigin?e.timeStamp-performance.timeOrigin:e.timeStamp;
 const events=entries=>{for(const e of entries)state.events.push({name:e.name,startTime:e.startTime,duration:e.duration,processingStart:e.processingStart,processingEnd:e.processingEnd,interactionId:e.interactionId,target:e.target?.getAttribute('aria-label')??e.target?.tagName});};
 const paints=entries=>{for(const e of entries)state.lcp.push({startTime:e.startTime,renderTime:e.renderTime,loadTime:e.loadTime,size:e.size,id:e.id,element:e.element?.tagName});};
 let eventObserver,lcpObserver;
 try{eventObserver=new PerformanceObserver((list,_observer,options)=>{state.health.callbacks++;if(Number.isInteger(options?.droppedEntriesCount))state.health.droppedEntries=(state.health.droppedEntries??0)+options.droppedEntriesCount;events(list.getEntries());});eventObserver.observe({type:'event',buffered:true,durationThreshold:16});state.health.registered=true;}catch(error){state.errors.push(String(error));}
 try{lcpObserver=new PerformanceObserver(list=>paints(list.getEntries()));lcpObserver.observe({type:'largest-contentful-paint',buffered:true});}catch(error){state.errors.push(String(error));}
 const flush=()=>{events(eventObserver?.takeRecords()??[]);paints(lcpObserver?.takeRecords()??[]);};
 const cutoff=(reason,event)=>{if(state.cutoff)return;const handlerObservedAt=performance.now(),raw=event?.timeStamp;const occurrence=Number.isFinite(raw)?(raw>performance.timeOrigin?raw-performance.timeOrigin:raw):handlerObservedAt;flush();state.cutoff={reason,time:occurrence,handlerObservedAt,rawTimeStamp:raw??null,validOccurrence:!event||(occurrence>=0&&occurrence<=handlerObservedAt)};};
 for(const type of ['pointerdown','pointerup','keydown','keyup','click'])addEventListener(type,e=>{if(e.isTrusted)state.trustedInputs.push({type,time:occurrence(e),key:e.key,repeat:e.repeat,pointerId:e.pointerId});},{capture:true});
 for(const type of ['pointerdown','keydown'])addEventListener(type,e=>{if(e.isTrusted)cutoff('first-trusted-input',e);},{capture:true});
 addEventListener('visibilitychange',()=>{state.lifecycle.push({type:'visibilitychange',time:performance.now(),visibility:document.visibilityState});if(document.visibilityState==='hidden')cutoff('hidden');});addEventListener('pagehide',()=>{state.lifecycle.push({type:'pagehide',time:performance.now(),visibility:document.visibilityState});cutoff('pagehide');});
 window.__finalizeUiTiming=async()=>{
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,0))));flush();
  if(!state.cutoff)cutoff('explicit-finalize');
  // Only an independently supplied browser count can establish subfloor groups; never infer them from key presses.
  if(Number.isInteger(performance.interactionCount)&&performance.interactionCount>=0){state.totalInteractions=performance.interactionCount;state.countSupport='performance.interactionCount';}
  state.health.drained=true;state.window.end=performance.now();state.eventCounts=performance.eventCounts?Object.fromEntries(performance.eventCounts):null;state.nativeCountProperty=('interactionCount' in performance);state.finalized=true;state.visibility=document.visibilityState;state.finishedAt=performance.now();return state;
 };
}
export function summarizeTimings(sessions){
 if(!sessions.length)throw Error('No sessions');
 const durations=[],namespaces=new Set();let total=0,censored=0,complete=true;
 const sessionResults=sessions.map((session,index)=>{
  if(session.errors.length||!session.supported.includes('event')||!session.supported.includes('largest-contentful-paint'))throw Error('Unsupported or failed timing observer');
  const namespace=session.namespace??`diagnostic-${index}`;if(namespaces.has(namespace))throw Error('Duplicate document namespace');namespaces.add(namespace);
  const grouped=new Map();for(const entry of session.events)if(entry.interactionId)grouped.set(entry.interactionId,Math.max(grouped.get(entry.interactionId)??0,entry.duration));
  const eligible=session.lcp.filter(e=>!session.cutoff||e.startTime<=session.cutoff.time);
  if(!eligible.length)throw Error('Missing eligible LCP, never substitute zero');
  const values=[...grouped.values()];durations.push(...values);
  const identity=typeof session.documentId==='string'&&session.documentId.length>0&&typeof session.namespace==='string'&&session.namespace.endsWith('/'+session.documentId);
  const window=session.window,cutoff=session.cutoff;
  const lifecycle=Array.isArray(session.lifecycle)&&session.lifecycle.length>0&&session.lifecycle[0].type==='init'&&session.lifecycle.every(e=>e.visibility==='visible'&&e.type!=='pagehide'&&Number.isFinite(e.time)&&e.time>=window?.start&&e.time<=window?.end);
  const health=session.health?.registered===true&&session.health.drained===true&&session.health.droppedEntries===0&&session.health.callbacks>0&&session.eventCounts&&Array.isArray(session.trustedInputs)&&session.trustedInputs.length>0&&session.trustedInputs.every(e=>Number.isFinite(e.time)&&e.time>=window?.start&&e.time<=window?.end)&&['keydown','click'].every(type=>(session.eventCounts[type]??0)>=session.trustedInputs.filter(e=>e.type===type).length);
  const bounded=window&&Number.isFinite(window.start)&&Number.isFinite(window.end)&&Number.isFinite(window.timeOrigin)&&window.start===0&&window.end>window.start&&cutoff&&Number.isFinite(cutoff.time)&&cutoff.time>=window.start&&cutoff.time<=window.end&&cutoff.validOccurrence===true&&Number.isFinite(cutoff.handlerObservedAt)&&cutoff.handlerObservedAt>=cutoff.time;
  const supported=identity&&bounded&&lifecycle&&health&&session.finalized===true&&session.visibility==='visible'&&session.countSupport==='performance.interactionCount'&&Number.isInteger(session.totalInteractions)&&session.totalInteractions>=values.length;
  if(!grouped.size&&!(Number.isInteger(session.totalInteractions)&&session.totalInteractions>0))throw Error('Missing qualified discrete interactions, never substitute zero');
  complete&&=supported;if(supported){total+=session.totalInteractions;censored+=session.totalInteractions-values.length;}
  return {namespace,observedInteractions:values.length,totalInteractions:session.totalInteractions??null,censored:supported?session.totalInteractions-values.length:null,lcp:eligible.at(-1).startTime,lcpCutoff:session.cutoff??null,complete:supported,zeroIdEntries:session.events.filter(e=>!e.interactionId).length};
 });
 durations.sort((a,b)=>a-b);const observedP75=durations.length?durations[Math.ceil(.75*durations.length)-1]:null,rank=Math.ceil(.75*total);
 // Mixed thresholds cannot establish one subfloor population.
 complete&&=sessions.every(s=>s.threshold===16);
 const p75=complete?(rank<=censored?null:durations[rank-censored-1]):null;
 return {nSessions:sessions.length,nInteractions:durations.length,totalInteractions:complete?total:null,censored:complete?censored:null,qualifiedPopulation:complete,method:'per-document maxima; nearest-rank pooling; duration quantized by browser',observedP75,p75,p75BelowFloor:complete&&rank<=censored,reportingFloor:16,populationReason:complete?'browser count with explicit identity, window, lifecycle and no-drop collector health':'observed-only diagnostic; identity/window/lifecycle/count/collection health incomplete',sessions:sessionResults};
}

export function latencyBreakdown(session){
 return session.events.filter(e=>e.interactionId).map(e=>({...e,inputDelayMs:e.processingStart-e.startTime,handlerMs:e.processingEnd-e.processingStart,presentationRemainderMs:Math.max(0,e.duration-(e.processingEnd-e.startTime))})).sort((a,b)=>b.duration-a.duration);
}
