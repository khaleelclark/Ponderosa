/** Presentation-only bootstrap; never stored in or added to downloaded artifact bytes.
 * The existing preview CSP and iframe sandbox remain the security boundary. */
export const VISUALIZATION_BOOTSTRAP = `<!doctype html><meta charset="utf-8">
<style>
:root{color-scheme:light;--ponderosa-bg:#fafbf8;--ponderosa-surface:#f0f4ee;--ponderosa-text:#182b22;--ponderosa-muted:#52675b;--ponderosa-border:#c8d3c9;--ponderosa-accent:#2f6c46;--ponderosa-on-accent:#fff;--ponderosa-font-family:system-ui,sans-serif;--ponderosa-font-size:16px;font-size:var(--ponderosa-font-size)}
html{overflow-y:hidden;scrollbar-width:none}*{box-sizing:border-box;scrollbar-width:none}::-webkit-scrollbar{display:none}body{display:flow-root;overflow-y:hidden;margin:0;padding:16px;background:var(--ponderosa-bg);color:var(--ponderosa-text);font:1rem/1.5 var(--ponderosa-font-family);overflow-wrap:anywhere}img,svg,canvas{max-width:100%}button,input,select,textarea{font:inherit;accent-color:var(--ponderosa-accent)}button{border:1px solid var(--ponderosa-border);border-radius:8px;padding:8px 12px;background:var(--ponderosa-accent);color:var(--ponderosa-on-accent);cursor:pointer}input,select,textarea{max-width:100%}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--ponderosa-accent);outline-offset:2px}@media(pointer:coarse){button,input,select{min-height:44px}}
</style><script>
(()=>{
 const nonce=new URL(location.href).searchParams.get('visualizationNonce');
 let failed=false,timer=0,lastHeight=0;
 const send=(status,height)=>parent.postMessage({type:'ponderosa:visualization',version:1,nonce,status,...(height?{height}:{})},'*');
 const report=()=>{timer=0;if(failed)return;const body=document.body;if(!body)return;const height=Math.ceil(Math.max(body.scrollHeight,body.getBoundingClientRect().height));if(height!==lastHeight){lastHeight=height;send('ready',height)}};
 const schedule=()=>{if(!timer)timer=setTimeout(report,150)};
 addEventListener('message',event=>{
  const data=event.data;if(event.source!==parent||!data||data.type!=='ponderosa:visualization-theme'||data.version!==1||data.nonce!==nonce)return;
  if(!['light','dark'].includes(data.mode)||!data.colors||typeof data.colors!=='object')return;
  const root=document.documentElement;root.style.colorScheme=data.mode;
  for(const key of ['bg','surface','text','muted','border','accent','on-accent','font-family','font-size']){const value=data.colors[key];if(typeof value==='string'&&value.length<256)root.style.setProperty('--ponderosa-'+key,value)}send('ready');schedule();
 });
 const fail=()=>{if(failed)return;failed=true;send('error')};
 addEventListener('error',event=>{if(event instanceof ErrorEvent)fail()},true);addEventListener('unhandledrejection',fail);
 addEventListener('DOMContentLoaded',()=>{if(failed)return;document.body.tabIndex=0;send('ready');new ResizeObserver(schedule).observe(document.body);document.fonts.ready.then(schedule);schedule()},{once:true});
})();
</script>`;
