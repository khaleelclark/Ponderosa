// Inject before navigation. Raw entries remain evidence, including zero-ID noninteractions.
export function installTimingObserver(){
 const state=window.__uiTiming={documentId:crypto.randomUUID(),events:[],lcp:[],errors:[],supported:PerformanceObserver.supportedEntryTypes,marks:[],threshold:16,cutoff:null,finalized:false,totalInteractions:null,countSupport:'unavailable',trustedInputs:[],eventCounts:null,tasks:[],window:{start:0,end:null,lastFrame:null,timeOrigin:performance.timeOrigin},lifecycle:[{type:'init',time:performance.now(),visibility:document.visibilityState}],health:{registered:false,callbacks:0,callbackLedger:[],droppedEntries:null,drained:false}};
 const occurrence=e=>e.timeStamp>performance.timeOrigin?e.timeStamp-performance.timeOrigin:e.timeStamp;
 const events=entries=>{for(const e of entries)state.events.push({name:e.name,startTime:e.startTime,duration:e.duration,processingStart:e.processingStart,processingEnd:e.processingEnd,interactionId:e.interactionId,target:e.target?.getAttribute('aria-label')??e.target?.tagName});};
 const paints=entries=>{for(const e of entries)state.lcp.push({startTime:e.startTime,renderTime:e.renderTime,loadTime:e.loadTime,size:e.size,id:e.id,element:e.element?.tagName});};
 let eventObserver,lcpObserver;
 try{eventObserver=new PerformanceObserver((list,_observer,options)=>{state.health.callbacks++;state.health.callbackLedger.push({observedAt:performance.now(),droppedEntriesCount:options?.droppedEntriesCount??null});if(Number.isInteger(options?.droppedEntriesCount))state.health.droppedEntries=(state.health.droppedEntries??0)+options.droppedEntriesCount;events(list.getEntries());});eventObserver.observe({type:'event',buffered:true,durationThreshold:16});state.health.registered=true;}catch(error){state.errors.push(String(error));}
 try{lcpObserver=new PerformanceObserver(list=>paints(list.getEntries()));lcpObserver.observe({type:'largest-contentful-paint',buffered:true});}catch(error){state.errors.push(String(error));}
 const flush=()=>{events(eventObserver?.takeRecords()??[]);paints(lcpObserver?.takeRecords()??[]);};
 const cutoff=(reason,event)=>{if(state.cutoff)return;const handlerObservedAt=performance.now(),raw=event?.timeStamp;const occurrence=Number.isFinite(raw)?(raw>performance.timeOrigin?raw-performance.timeOrigin:raw):handlerObservedAt;flush();state.cutoff={reason,time:occurrence,handlerObservedAt,rawTimeStamp:raw??null,validOccurrence:!event||(occurrence>=0&&occurrence<=handlerObservedAt)};};
 for(const type of ['pointerdown','pointerup','keydown','keyup','click'])addEventListener(type,e=>{if(e.isTrusted)state.trustedInputs.push({type,time:occurrence(e),key:e.key,code:e.code,repeat:e.repeat,pointerId:e.pointerId});},{capture:true});
 for(const type of ['pointerdown','keydown'])addEventListener(type,e=>{if(e.isTrusted)cutoff('first-trusted-input',e);},{capture:true});
 addEventListener('visibilitychange',()=>{state.lifecycle.push({type:'visibilitychange',time:performance.now(),visibility:document.visibilityState});if(document.visibilityState==='hidden')cutoff('hidden');});addEventListener('pagehide',()=>{state.lifecycle.push({type:'pagehide',time:performance.now(),visibility:document.visibilityState});cutoff('pagehide');});
 window.__beginUiTask=(id,expectedTrustedCounts)=>{if(state.tasks.some(t=>!t.complete)||state.tasks.some(t=>t.id===id))throw Error('Overlapping or duplicate trusted task');state.tasks.push({id,start:performance.now(),expectedTrustedCounts,nativeStart:performance.interactionCount,complete:false});};
 window.__endUiTask=id=>{const task=state.tasks.at(-1);if(!task||task.id!==id||task.complete)throw Error('Unexpected task completion');Object.assign(task,{end:performance.now(),nativeEnd:performance.interactionCount,complete:true});};
 // Observe normal rendering and idle delivery, then compare independent drains.
 // This is an operational browser measurement, not a terminal-delivery guarantee.
 const checkpoint=async()=>{
  const ready=await new Promise(resolve=>{
   let done=false;
   const timer=setTimeout(()=>{if(!done){done=true;resolve(null);}},4000);
   if(typeof requestIdleCallback!=='function'){clearTimeout(timer);done=true;resolve(null);return;}
   requestAnimationFrame(()=>requestAnimationFrame(frame=>requestIdleCallback(deadline=>{
    if(done)return;done=true;clearTimeout(timer);resolve(deadline.didTimeout?null:frame);
   },{timeout:2000})));
  });
  flush();
  return {at:performance.now(),frame:ready,events:state.events.length,lcp:state.lcp.length,
   interactions:performance.interactionCount??null,droppedEntries:state.health.droppedEntries,
   lifecycle:state.lifecycle.length,inputs:state.trustedInputs.length,
   eventCounts:performance.eventCounts?Object.fromEntries(performance.eventCounts):null};
 };
 const same=(a,b)=>['events','lcp','interactions','droppedEntries','lifecycle','inputs','eventCounts'].every(k=>JSON.stringify(a[k])===JSON.stringify(b[k]));
 window.__finalizeUiTiming=async()=>{
  const first=await checkpoint(),second=await checkpoint();
  state.health.delivery={basis:'two rendering-and-idle drains plus post-capture check; observational, not a terminal guarantee',checkpoints:[first,second],stable:!!(first.frame!==null&&second.frame!==null&&same(first,second)),postCapture:null};
  if(!state.cutoff)cutoff('explicit-finalize');
  if(Number.isInteger(performance.interactionCount)&&performance.interactionCount>=0){state.totalInteractions=performance.interactionCount;state.countSupport='performance.interactionCount';}
  state.health.drained=true;state.window.lastFrame=second.frame;state.window.end=second.frame;state.health.flushCompletedAt=performance.now();state.eventCounts=performance.eventCounts?Object.fromEntries(performance.eventCounts):null;state.nativeCountProperty=('interactionCount' in performance);state.finalized=true;state.visibility=document.visibilityState;state.finishedAt=performance.now();return state;
 };
 window.__verifyUiTiming=async()=>{
  const previous=state.health.delivery?.checkpoints?.at(-1),check=await checkpoint();
  state.health.delivery.postCapture={checkpoint:check,stable:!!(previous&&check.frame!==null&&same(previous,check))};
  state.health.flushCompletedAt=performance.now();state.visibility=document.visibilityState;return state;
 };
}
export function summarizeTimings(sessions){
 if(!sessions.length)throw Error('No sessions');
 const durations=[],namespaces=new Set(),documents=new Set(),origins=new Set();let total=0,censored=0,complete=true;
 const sessionResults=sessions.map((session,index)=>{
  if(session.errors.length||!session.supported.includes('event')||!session.supported.includes('largest-contentful-paint'))throw Error('Unsupported or failed timing observer');
  const namespace=session.namespace??`diagnostic-${index}`;if(namespaces.has(namespace))throw Error('Duplicate document namespace');namespaces.add(namespace);
  if(session.documentId){if(documents.has(session.documentId))throw Error('Duplicate document identity');documents.add(session.documentId);}
  if(Number.isFinite(session.window?.timeOrigin)){if(origins.has(session.window.timeOrigin))throw Error('Duplicate document time origin');origins.add(session.window.timeOrigin);}
  // Event Timing also exposes auxiliary events whose zero ID is expected:
  // https://www.w3.org/TR/event-timing/#sec-performance-event-timing
  // https://www.w3.org/TR/event-timing/#compute-interactionid
  // A composing input can create an interaction; exempt zero-ID input only
  // when the independent event counters establish no composition occurred.
  const auxiliaryZeroTypes=new Set(['pointerover','pointerenter','pointerout','pointerleave','mouseover','mouseenter','mouseout','mouseleave','mousedown','mouseup','beforeinput']);
  const noComposition=['compositionstart','compositionupdate','compositionend'].every(type=>session.eventCounts?.[type]===0);
  const ambiguousInteractionId=session.events.some(entry=>!Number.isSafeInteger(entry.interactionId)||entry.interactionId<0||(entry.interactionId===0&&!auxiliaryZeroTypes.has(entry.name)&&!(entry.name==='input'&&noComposition)));
  const grouped=new Map();for(const entry of session.events)if(Number.isSafeInteger(entry.interactionId)&&entry.interactionId>0&&Number.isFinite(entry.duration)&&entry.duration>=0)grouped.set(entry.interactionId,Math.max(grouped.get(entry.interactionId)??0,entry.duration));
  const eligible=session.lcp.filter(e=>!session.cutoff||e.startTime<=session.cutoff.time);
  if(!eligible.length)throw Error('Missing eligible LCP, never substitute zero');
  const values=[...grouped.values()];durations.push(...values);
  const identity=typeof session.documentId==='string'&&session.documentId.length>0&&typeof session.namespace==='string'&&session.namespace.endsWith('/'+session.documentId);
  const window=session.window,cutoff=session.cutoff;
  const lifecycle=Array.isArray(session.lifecycle)&&session.lifecycle.length>0&&session.lifecycle[0].type==='init'&&session.lifecycle.every(e=>e.visibility==='visible'&&e.type!=='pagehide'&&Number.isFinite(e.time)&&e.time>=window?.start&&e.time<=window?.end);
  // A session with no callback has no browser drop-count receipt; even if every
  // interaction might be below the reporting floor it remains inconclusive.
  // Performance Timeline reports droppedEntriesCount on the first callback
  // after observe(), then leaves it unset. Require that first zero receipt;
  // retain later nulls without fabricating zeros or accepting reported drops.
  // https://www.w3.org/TR/performance-timeline/#queue-the-performanceobserver-task
  const health=session.health?.registered===true&&session.health.drained===true&&session.health.droppedEntries===0&&Number.isInteger(session.health.callbacks)&&session.health.callbacks>0&&Number.isFinite(session.health.flushCompletedAt)&&session.health.flushCompletedAt>=window?.end&&Array.isArray(session.health.callbackLedger)&&session.health.callbackLedger.length===session.health.callbacks&&session.health.callbackLedger.every((c,i)=>Number.isFinite(c.observedAt)&&c.observedAt>=window?.start&&c.observedAt<=session.health.flushCompletedAt&&(c.droppedEntriesCount===0||(i>0&&c.droppedEntriesCount===null)))&&session.eventCounts&&Array.isArray(session.trustedInputs)&&session.trustedInputs.length>0&&session.trustedInputs.every(e=>Number.isFinite(e.time)&&e.time>=window?.start&&e.time<=window?.end)&&['pointerdown','pointerup','click','keydown','keyup'].every(type=>Number.isInteger(session.eventCounts[type]??0)&&(session.eventCounts[type]??0)>=session.trustedInputs.filter(e=>e.type===type).length);
  const bounded=window&&Number.isFinite(window.start)&&Number.isFinite(window.end)&&Number.isFinite(window.timeOrigin)&&window.start===0&&window.end>window.start&&window.lastFrame===window.end&&cutoff&&Number.isFinite(cutoff.time)&&cutoff.time>=window.start&&cutoff.time<=window.end&&cutoff.validOccurrence===true&&Number.isFinite(cutoff.handlerObservedAt)&&cutoff.handlerObservedAt>=cutoff.time&&cutoff.handlerObservedAt<=window.end;
  const firstInput=session.trustedInputs?.filter(e=>['pointerdown','keydown'].includes(e.type)).reduce((time,e)=>Math.min(time,e.time),Infinity);
  const occurrenceMatches=Number.isFinite(firstInput)&&cutoff?.reason==='first-trusted-input'&&cutoff.time===firstInput;
  // Duration is quantized in 8ms units. Use one full quantum conservatively, never an exact paint timestamp.
  const quantizationToleranceMs=8;
  const eventWindow=Array.isArray(session.events)&&session.events.every(e=>[e.startTime,e.duration,e.processingStart,e.processingEnd].every(Number.isFinite)&&e.startTime>=window?.start&&e.duration>=0&&e.startTime<=e.processingStart&&e.processingStart<=e.processingEnd&&e.processingEnd<=window?.end&&e.startTime+e.duration+quantizationToleranceMs>=e.processingEnd&&Math.max(e.processingEnd,e.startTime+e.duration+quantizationToleranceMs)<=window?.end);
  const tasks=session.tasks,types=['pointerdown','pointerup','click','keydown','keyup'];
  const taskLedger=Array.isArray(tasks)&&tasks.length>0&&new Set(tasks.map(t=>t.id)).size===tasks.length&&tasks.every((t,i)=>t.complete===true&&Number.isFinite(t.start)&&Number.isFinite(t.end)&&t.start>=window?.start&&t.end>=t.start&&t.end<=window?.end&&(!i||t.start>=tasks[i-1].end)&&Number.isInteger(t.nativeStart)&&Number.isInteger(t.nativeEnd)&&t.nativeStart>=0&&t.nativeEnd>=t.nativeStart&&t.nativeEnd<=session.totalInteractions&&types.every(type=>Number.isInteger(t.expectedTrustedCounts?.[type])&&t.expectedTrustedCounts[type]>=0&&(session.trustedInputs??[]).filter(e=>e.type===type&&e.time>=t.start&&e.time<=t.end).length>=t.expectedTrustedCounts[type]))&&tasks[0].nativeStart===0&&tasks.at(-1).nativeEnd===session.totalInteractions&&(session.trustedInputs??[]).every(e=>tasks.some(t=>e.time>=t.start&&e.time<=t.end));
  const delivery=session.health?.delivery,checks=delivery?.checkpoints,post=delivery?.postCapture;
  const sameCheckpoint=(a,b)=>['events','lcp','interactions','droppedEntries','lifecycle','inputs','eventCounts'].every(k=>JSON.stringify(a?.[k])===JSON.stringify(b?.[k]));
  const validCheckpoint=c=>c&&Number.isFinite(c.at)&&Number.isFinite(c.frame)&&c.at>=c.frame&&Number.isInteger(c.events)&&Number.isInteger(c.lcp)&&Number.isInteger(c.interactions)&&Number.isInteger(c.droppedEntries)&&Number.isInteger(c.lifecycle)&&Number.isInteger(c.inputs)&&c.eventCounts;
  const settled=Array.isArray(checks)&&checks.length===2&&checks.every(validCheckpoint)&&validCheckpoint(post?.checkpoint)&&checks[0].at<=checks[1].frame&&checks[1].at<=post.checkpoint.frame&&checks[1].frame===window?.end&&delivery.stable===true&&post.stable===true&&sameCheckpoint(checks[0],checks[1])&&sameCheckpoint(checks[1],post.checkpoint)&&post.checkpoint.events===session.events.length&&post.checkpoint.lcp===session.lcp.length&&post.checkpoint.interactions===session.totalInteractions&&post.checkpoint.droppedEntries===session.health.droppedEntries&&post.checkpoint.lifecycle===session.lifecycle.length&&post.checkpoint.inputs===session.trustedInputs.length&&JSON.stringify(post.checkpoint.eventCounts)===JSON.stringify(session.eventCounts);
  const pendingKeys=new Set(),pendingPointers=new Set();let paired=true;
  for(const input of session.trustedInputs??[]){
   const keyboard=input.type.startsWith('key'),pointer=input.type==='pointerdown'||input.type==='pointerup';
   const set=keyboard?pendingKeys:pendingPointers,key=keyboard?input.code:input.pointerId;
   if((keyboard&&(typeof key!=='string'||!key))||(pointer&&(!Number.isInteger(key)||key<0)))paired=false;
   if(input.type==='keydown'||input.type==='pointerdown'){if(set.has(key)&&!input.repeat)paired=false;set.add(key);}
   if(input.type==='keyup'||input.type==='pointerup'){if(!set.has(key))paired=false;set.delete(key);}
  }
  paired&&=pendingKeys.size===0&&pendingPointers.size===0;
  const supported=Boolean(!ambiguousInteractionId&&occurrenceMatches&&eventWindow&&taskLedger&&settled&&paired&&identity&&bounded&&lifecycle&&health&&session.finalized===true&&session.visibility==='visible'&&session.countSupport==='performance.interactionCount'&&Number.isInteger(session.totalInteractions)&&session.totalInteractions>=values.length);
  if(!grouped.size&&!(Number.isInteger(session.totalInteractions)&&session.totalInteractions>0))throw Error('Missing qualified discrete interactions, never substitute zero');
  complete&&=supported;if(supported){total+=session.totalInteractions;censored+=session.totalInteractions-values.length;}
  return {namespace,settled:Boolean(settled),paired,taskLedger:Boolean(taskLedger),eventWindow,ambiguousInteractionId,quantizationToleranceMs,observedInteractions:values.length,totalInteractions:session.totalInteractions??null,censored:supported?session.totalInteractions-values.length:null,lcp:eligible.at(-1).startTime,lcpCutoff:session.cutoff??null,complete:supported,zeroIdEntries:session.events.filter(e=>!e.interactionId).length};
 });
 durations.sort((a,b)=>a-b);const observedP75=durations.length?durations[Math.ceil(.75*durations.length)-1]:null,rank=Math.ceil(.75*total);
 // Mixed thresholds cannot establish one subfloor population.
 complete&&=sessions.every(s=>s.threshold===16);
 const p75=complete?(rank<=censored?null:durations[rank-censored-1]):null;
 return {nSessions:sessions.length,nInteractions:durations.length,totalInteractions:complete?total:null,censored:complete?censored:null,qualifiedPopulation:complete,method:'per-document maxima; nearest-rank pooling; browser-quantized duration; observed rendering and idle drains, not a terminal delivery guarantee',observedP75,p75,p75BelowFloor:complete&&rank<=censored,reportingFloor:16,populationReason:complete?'browser count with identity, task and lifecycle checks, no reported drops and stable observed drains; later delivery cannot be ruled out':'conditional observed-only diagnostic; observed delivery/task/window/identity health not established',sessions:sessionResults};
}

export function latencyBreakdown(session){
 return session.events.filter(e=>e.interactionId).map(e=>({...e,inputDelayMs:e.processingStart-e.startTime,handlerMs:e.processingEnd-e.processingStart,presentationRemainderMs:Math.max(0,e.duration-(e.processingEnd-e.startTime))})).sort((a,b)=>b.duration-a.duration);
}
