const message='ResizeObserver loop completed with undelivered notifications.';
const cases={workflowMapExpansionRegression:{checkpoint:'workflow-map-final-mounted',nodes:9,edges:8},workflowVisibleConnectionsRegression:{checkpoint:'workflow-fit',nodes:3,edges:2}};
export function canvasResizeCase(name){return cases[name]?{name,...cases[name]}:undefined;}

/** A native skipped-observation notification is not a thrown application Error.
 * Keep both raw event streams; accept only proved settlement in these two cells. */
export function settledCanvasResizeDiagnostics({browser,name,url,pageErrors,pageErrorCountAtProof,diagnostics:d}){
 const spec=canvasResizeCase(name),p=d?.proof,a=d?.after;
 if(browser!=='webkit'||!spec||d?.name!==name||d.documentUrl!==url||d.overflow||d.rejections!==0||!p||!a)return false;
 if(pageErrors.length!==pageErrorCountAtProof||!pageErrors.every(error=>error===message)||d.errors.length<pageErrors.length)return false;
 if(!d.errors.every(e=>e.message===message&&e.isTrusted===true&&e.filename===url&&e.line===0&&e.column===0&&e.errorNull===true))return false;
 const quiet=x=>[x.started,x.quietSince,x.finished].every(Number.isFinite)&&x.started<=x.quietSince&&x.finished-x.started<=2000&&x.finished-x.quietSince>=250&&Number.isSafeInteger(x.frames)&&x.frames>=8&&x.nativeCount===d.errors.length&&!x.busy;
 if(!quiet(p)||!quiet(a)||p.checkpoint!==spec.checkpoint||a.checkpoint!=='after-unmount'||a.started<p.finished)return false;
 if(p.nodes.length!==spec.nodes||p.paths.length!==spec.edges||a.nodes.length||a.paths.length)return false;
 if(!p.nodes.every(n=>[n.x,n.y,n.width,n.height].every(Number.isFinite)&&n.width>0&&n.height>0)||!p.paths.every(Boolean))return false;
 return d.errors.every(e=>Number.isFinite(e.at)&&e.at<=p.quietSince);
}

/** Runs only in an owned mounted-test page. No errors are prevented or hidden. */
export function installCanvasResizeDiagnostics(spec){
 const data={name:spec.name,documentUrl:location.href,errors:[],rejections:0,overflow:false};
 addEventListener('error',e=>{if(data.errors.length>=100){data.overflow=true;return;}data.errors.push({at:performance.now(),message:e.message,isTrusted:e.isTrusted,filename:e.filename,line:e.lineno,column:e.colno,errorNull:e.error==null});});
 addEventListener('unhandledrejection',()=>{data.rejections++;});
 const sample=()=>({nativeCount:data.errors.length,rejections:data.rejections,busy:Boolean(document.querySelector('[aria-busy="true"]')),nodes:[...document.querySelectorAll('.react-flow__node')].map(e=>{const r=e.getBoundingClientRect();return{id:e.getAttribute('data-id'),x:r.x,y:r.y,width:r.width,height:r.height};}),paths:[...document.querySelectorAll('.react-flow__edge-path')].map(e=>e.getAttribute('d'))});
 async function settle(checkpoint){
  const started=performance.now();let quietSince=started,previous='',frames=0;
  while(performance.now()-started<2000){
   await new Promise(requestAnimationFrame);const now=performance.now();if(now-started>2000)break;
   const current=sample(),signature=JSON.stringify(current);
   if(signature!==previous){previous=signature;quietSince=now;frames=0;}else frames++;
   const mounted=checkpoint!=='after-unmount',valid=mounted?current.nodes.length===spec.nodes&&current.paths.length===spec.edges&&current.nodes.every(n=>n.width>0&&n.height>0):!current.nodes.length&&!current.paths.length;
   if(valid&&!current.busy&&frames>=8&&now-quietSince>=250)return{checkpoint,started,quietSince,finished:now,frames,...current};
  }
  return null;
 }
 window.phase2UiCheckpoint=async checkpoint=>{if(checkpoint===spec.checkpoint)data.proof=await settle(checkpoint);};
 window.__mountedCanvasResize={read:()=>data,finish:async()=>{data.after=await settle('after-unmount');return data;}};
}
