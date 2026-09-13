import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PONDEROSA_PLAYWRIGHT_PATH??'playwright');
const old=process.env.PONDEROSA_PREVIOUS_WEB_DIST;
if(!old||!process.argv[2])throw new Error('Provide PONDEROSA_PREVIOUS_WEB_DIST and the newly built web dist argument. Uses only a disposable browser profile.');
let root=old, fixed=false;
const policy="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
const server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname;
  if(name.startsWith('/api/')){res.writeHead(404).end();return;}
  try{const file=path.join(root,name==='/'?'index.html':name);const data=await readFile(file);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'application/octet-stream');res.setHeader('Content-Security-Policy',policy+(fixed?"; media-src 'self' blob:":''));res.end(data);}catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,executablePath:process.env.PONDEROSA_CHROMIUM_PATH});
try{
const page=await browser.newPage();const url=`http://127.0.0.1:${server.address().port}`;
await page.goto(url);await page.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;});
await page.reload();await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
fixed=true;
await page.evaluate(async()=>{await (await navigator.serviceWorker.getRegistration()).update();});
const unchanged=await page.reload();
console.log(JSON.stringify({phase:'server-policy-only',fromServiceWorker:unchanged.fromServiceWorker(),policy:(await unchanged.allHeaders())['content-security-policy']}));
assert.equal(unchanged.fromServiceWorker(),true);
assert.equal((await unchanged.allHeaders())['content-security-policy'].includes('media-src'),false);
if(process.argv[2]){
root=process.argv[2];
await page.evaluate(async()=>{await (await navigator.serviceWorker.getRegistration()).update();});
await page.waitForTimeout(3000);
const changed=await page.reload();
const csp=(await changed.allHeaders())['content-security-policy'];
console.log(JSON.stringify({phase:'new-shell',fromServiceWorker:changed.fromServiceWorker(),policy:csp}));
if(!csp.includes('media-src'))throw new Error('Updated shell still blocks audio');
}
}finally{await browser.close();await new Promise(r=>server.close(r));}
