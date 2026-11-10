// Built UI + real loopback API + owned inert providers; no subscription inference.
import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture,until} from '../shared/fixture.mjs';
import {randomUUID} from 'node:crypto';
const require=createRequire(new URL('../../apps/server/package.json',import.meta.url));
const {chromium}=require('playwright-core');
const root=fileURLToPath(new URL('../../',import.meta.url)),web=path.join(root,'apps/web/dist');
const out=process.env.PONDEROSA_OUTPUT_QUALIFICATION_DIR??'/tmp/ponderosa-output-settings-ui';await mkdir(out,{recursive:true});
let browser,server;const f=await fixture();const errors=[],requests=[],fileClicks=[];let workspaceActions;
try{
 const api=await f.listen();
 const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml','.json':'application/json','.webmanifest':'application/manifest+json'};
 server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
   const upstream=await fetch(api+req.url,{method:req.method,headers:{...Object.fromEntries(Object.entries(req.headers).filter(([name])=>!['host','connection','content-length','accept-encoding'].includes(name))),host:new URL(api).host,...(req.headers.origin===`http://${req.headers.host}`?{origin:new URL(api).origin}:{})},...(body.length?{body}:{})});
   requests.push({method:req.method,path:req.url,status:upstream.status});
   res.writeHead(upstream.status,Object.fromEntries([...upstream.headers].filter(([name])=>!['transfer-encoding','connection','content-encoding','content-length'].includes(name))));
   if(upstream.body){const stream=Readable.fromWeb(upstream.body);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);}else res.end();return;
  }
  if(['/sw.js','/register-sw.js'].includes(url.pathname)){res.writeHead(404);res.end();return;}
  let file=path.resolve(web,'.'+decodeURIComponent(url.pathname));if(!file.startsWith(web+path.sep)){res.writeHead(404);res.end();return;}
  let bytes;try{bytes=await readFile(file);}catch{file=path.join(web,'index.html');bytes=await readFile(file);}
  res.writeHead(200,{'content-type':mime[path.extname(file)]??'application/octet-stream','cache-control':'no-store'});res.end(bytes);
 }catch(error){res.writeHead(500);res.end(String(error));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath:process.env.PONDEROSA_BROWSER_EXECUTABLE??'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
 const status=f.ok(await f.api('POST','/api/branches/assistant',{initialize:true}));
 const results=[],external=[];
 for(const entry of ['/assistant',status.app.url])for(const mobile of [false,true])for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile,deviceScaleFactor:mobile?3:1});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(!['127.0.0.1','localhost'].includes(url.hostname)){external.push(url.origin);return route.abort();}return route.continue();});
  await page.addInitScript(theme=>localStorage.setItem('ponderosa-color-mode',theme),theme);
  await page.goto(origin+entry);const settings=page.getByRole('button',{name:'Settings',exact:true}).first();await settings.waitFor();
  await settings.focus();await page.keyboard.press('Enter');const dialog=page.getByRole('dialog',{name:'Settings',exact:true});await dialog.waitFor();
  await page.route('**/api/branches/output-apps/*/schedule',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Controlled workflow version conflict'})}));
  const save=dialog.getByRole('button',{name:'Save Schedule',exact:true});
  for(let i=0;i<30&&!await save.evaluate(el=>el===document.activeElement);i++)await page.keyboard.press('Tab');
  assert.ok(await save.evaluate(el=>el===document.activeElement),'Keyboard reaches schedule save');await page.keyboard.press('Enter');
  const error=dialog.getByRole('alert');await error.filter({hasText:'Controlled workflow version conflict'}).waitFor();
  assert.equal(await page.getByRole('alert').filter({hasText:'Controlled workflow version conflict'}).count(),1);
  await page.addScriptTag({path:process.env.AXE_CORE_PATH});
  const scan=await page.evaluate(()=>window.axe.run(document.querySelector('[role=dialog]')));
  assert.deepEqual(scan.violations.filter(v=>['critical','serious'].includes(v.impact)).map(v=>v.id),[]);
  const id=(entry==='/assistant'?'assistant':'output')+'-'+(mobile?'phone':'desktop')+'-'+theme;
  await page.screenshot({path:path.join(out,id+'.png'),fullPage:true});
  const observation={id,scan,dialog:await dialog.getAttribute('aria-labelledby'),error:await error.innerText(),geometry:await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}))};
  assert.ok(observation.geometry.scrollWidth<=observation.geometry.width);
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});await page.getByRole('alert').filter({hasText:'Controlled workflow version conflict'}).waitFor();
  assert.ok(await settings.evaluate(el=>el===document.activeElement),'Modal restores Settings focus');
  results.push(observation);await writeFile(path.join(out,'results.json'),JSON.stringify({results,errors,external,requests},null,2));await context.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log(JSON.stringify({pass:true,cells:results.length,out}));
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await f.dispose();}
