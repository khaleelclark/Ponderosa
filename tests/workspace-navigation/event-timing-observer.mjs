// Inject before navigation. Preserve all entries and interaction IDs; no automation elapsed time enters the score.
export function installTimingObserver(){
 const state=window.__uiTiming={events:[],lcp:[],errors:[],supported:PerformanceObserver.supportedEntryTypes,marks:[]};
 try{new PerformanceObserver(list=>{for(const e of list.getEntries())state.events.push({name:e.name,startTime:e.startTime,duration:e.duration,processingStart:e.processingStart,processingEnd:e.processingEnd,interactionId:e.interactionId,target:e.target?.getAttribute('aria-label')??e.target?.tagName});}).observe({type:'event',buffered:true,durationThreshold:16});}catch(error){state.errors.push(String(error));}
 try{new PerformanceObserver(list=>{for(const e of list.getEntries())state.lcp.push({startTime:e.startTime,size:e.size,id:e.id});}).observe({type:'largest-contentful-paint',buffered:true});}catch(error){state.errors.push(String(error));}
}
export function summarizeTimings(sessions){
 const durations=[];const sessionResults=sessions.map(session=>{
  if(session.errors.length||!session.supported.includes('event')||!session.supported.includes('largest-contentful-paint'))throw Error('Unsupported or failed timing observer');
  const grouped=new Map();for(const entry of session.events)if(entry.interactionId)grouped.set(entry.interactionId,Math.max(grouped.get(entry.interactionId)??0,entry.duration));
  if(!grouped.size||!session.lcp.length)throw Error('Missing interactions or LCP, never substitute zero');
  const values=[...grouped.values()];durations.push(...values);return {interactionCount:values.length,lcp:session.lcp.at(-1).startTime};
 });
 durations.sort((a,b)=>a-b);if(!durations.length)throw Error('No sessions');return {nSessions:sessions.length,nInteractions:durations.length,method:'nearest-rank pooled interaction-group maximum EventTiming duration',p75:durations[Math.ceil(.75*durations.length)-1],sessions:sessionResults};
}
