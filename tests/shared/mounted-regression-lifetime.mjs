/** Every operation is observed exactly once. A timeout reports uncertainty;
 * it never retries a view action, cleanup or resource mutation. */
export async function withinMountedDeadline(work,milliseconds,stage){
 let timer;
 try{return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error(`${stage} exceeded its finite timeout`),{code:'ERR_MOUNTED_TIMEOUT',stage})),milliseconds);})]);}
 finally{clearTimeout(timer);}
}
/** Keep the original case failure when diagnostics or cleanup also fail. */
export async function runMountedCase({run,stop,diagnose,close,timeout,cleanupTimeout=5000}){
 let failure;const secondary=[];
 try{await withinMountedDeadline(run,timeout,'mounted case');}catch(error){failure=error;}
 finally{
  try{stop();}catch(error){secondary.push({stage:'case cancellation',error});}
  if(failure&&diagnose)try{await withinMountedDeadline(diagnose,cleanupTimeout,'failure screenshot');}catch(error){secondary.push({stage:'failure screenshot',error});}
  try{await withinMountedDeadline(close,cleanupTimeout,'context cleanup');}catch(error){secondary.push({stage:'context cleanup',error});}
 }
 return {failure,secondary,timedOut:failure?.code==='ERR_MOUNTED_TIMEOUT'||secondary.some(row=>row.error?.code==='ERR_MOUNTED_TIMEOUT')};
}
