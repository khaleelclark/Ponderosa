import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo=resolve(process.argv[2]);
const {chromeBrowserDriverFactory}=await import(pathToFileURL(join(repo,"apps/server/dist/chrome-cdp-driver.js")));
const root=mkdtempSync(join(tmpdir(),"ponderosa-browser-evidence-"));
const listen=async server=>{await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));return `http://127.0.0.1:${server.address().port}`;};
const child=createServer((_req,res)=>res.end('<input aria-label="Frame-only control" id="frame-only">'));
const childUrl=await listen(child);
const server=createServer((req,res)=>{
  res.setHeader("Content-Type","text/html; charset=utf-8");
  if(req.url==="/delayed")return res.end('<title>Loading</title><script>setTimeout(()=>{document.body.innerHTML=\'<input aria-label="Delayed form" id="late">\';document.title="Ready"},1200)</script>');
  if(req.url==="/scope")return res.end(`<input id="password" aria-label="Password" type="password" value="SYNTHETIC_NOT_A_SECRET"><iframe src="${childUrl}"></iframe><div id="host"></div><script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<input id="shadow-only" aria-label="Shadow-only control">'</script>`);
  if(req.url==="/many")return res.end(`<style>body{display:grid;grid-template-columns:repeat(10,100px)}input{width:90px;height:20px}</style>${Array.from({length:100},(_,i)=>`<input id="field${i}" aria-label="Field ${i}">`).join("")}`);
  res.end('<title>Fixture</title><input id="normal" aria-label="Normal">');
});
const url=await listen(server), results={scope:"owned-local-fixtures-only",modes:[],input:{}};
try {
  // Execute the current callback body with a pending transport; this is a source-level
  // reproduction, not a claim that a physical browser/client was exercised.
  const source=readFileSync(join(repo,"apps/web/src/components/browser/useBrowserController.ts"),"utf8");
  const match=source.match(/const sendInput = useCallback\(\(value: UnfencedBrowserInput\): void => \{([\s\S]*?)\n  \}, \[input\]\);/);
  assert.ok(match,"Input callback changed; update the probe rather than guessing");
  const sent=[],callbacks=[];
  const send=new Function("input","sessionRef","inputBusy","queuedScroll","mergeBrowserScrollInputs",`const sendInput=(value)=>{${match[1]}};return sendInput;`)(
    {mutate:(value,callback)=>{sent.push(value);callbacks.push(callback);}},
    {current:{controlOwner:"operator"}},{current:false},{current:undefined},(_old,next)=>next);
  send({kind:"type",text:"a"});send({kind:"type",text:"b"});send({kind:"key",key:"Tab"});
  callbacks[0].onSettled(undefined,null);
  results.input={method:"source-extracted-callback-with-pending-transport",submitted:3,dispatched:sent.length,lost:3-sent.length};
  for(const headed of [true,false]) {
    const driver=await chromeBrowserDriverFactory(root)(headed?"headed":"headless",()=>{},undefined,undefined,{hostedHeaded:headed});
    try {
      const begin=performance.now();await driver.navigate(url+"/delayed");
      const navigationMs=Math.round(performance.now()-begin),early=await driver.inspect();
      const deadline=Date.now()+4000;let late=early;
      while(!late.includes('Delayed form') && Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,100));late=await driver.inspect();}
      await driver.navigate(url+"/scope");const scope=await driver.inspect();
      await driver.navigate(url+"/many");const many=await driver.inspect();
      results.modes.push({headed,navigationMs,returnedBeforeFormReady:!early.includes('Delayed form'),eventuallyReady:late.includes('Delayed form'),passwordValueExposed:scope.includes('SYNTHETIC_NOT_A_SECRET'),frameControlObserved:scope.includes('Frame-only control'),shadowControlObserved:scope.includes('Shadow-only control'),lastOf100Observed:many.includes('Field 99'),inspection:many});
    } finally {await driver.close();assert.equal(driver.isAlive(),false);}
  }
  writeFileSync(process.argv[3],JSON.stringify(results,null,2),{mode:0o600});
  console.log(JSON.stringify({...results,modes:results.modes.map(({inspection,...mode})=>mode)},null,2));
} finally {
  await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>child.close(resolve))]);
  rmSync(root,{recursive:true,force:true});
}
