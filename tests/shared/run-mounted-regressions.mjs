// Explicit offline mounted qualification. No provider, production server or dependency install.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mountedRegressionInventory,mountedRegressionEntryImports} from './mounted-regression-inventory.mjs';
import {runMountedCase,withinMountedDeadline} from './mounted-regression-lifetime.mjs';
import {canvasResizeCase,installCanvasResizeDiagnostics,settledCanvasResizeDiagnostics} from './canvas-resize-diagnostics.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(new URL('../../apps/server/package.json',import.meta.url));
const {chromium,webkit,devices}=require('playwright-core');
const browserName=process.env.PONDEROSA_MOUNTED_BROWSER??'chromium';
assert(['chromium','webkit'].includes(browserName),'Select an existing Chromium or WebKit runner');
const browserType=browserName==='webkit'?webkit:chromium;
const inventory=mountedRegressionInventory(),expected=inventory.flatMap(row=>row.names).sort();
assert.deepEqual(mountedRegressionEntryImports(),inventory.map(row=>row.file),'Every mounted source must be included exactly once');
assert.equal(new Set(expected).size,expected.length,'Mounted case names must be unique');assert.ok(expected.length>0);
const selected=process.env.PONDEROSA_MOUNTED_CASES?process.env.PONDEROSA_MOUNTED_CASES.split(',').map(name=>name.trim()):expected;
assert(selected.length>0&&new Set(selected).size===selected.length&&selected.every(name=>expected.includes(name)),'Selected mounted cases must be distinct registered names');
const owned=await mkdtemp(path.join(tmpdir(),'ponderosa-mounted-regressions-'));
const build=process.env.PONDEROSA_MOUNTED_BUILD??path.join(owned,'build');
const out=process.env.PONDEROSA_MOUNTED_EVIDENCE??path.join(owned,'evidence');
for(const directory of [build,out]){
 assert(path.isAbsolute(directory),'Build and evidence paths must be absolute');await mkdir(directory,{recursive:true});
 assert.equal((await readdir(directory)).length,0,'Use fresh owned build and evidence paths; existing content is preserved');
}
const timeout=Number(process.env.PONDEROSA_MOUNTED_CASE_TIMEOUT_MS??30_000);
assert(Number.isSafeInteger(timeout)&&timeout>=1000&&timeout<=120_000,'Case timeout must be between 1 and 120 seconds');
const results=[],globalErrors=[];let server,browser,browserServer,origin,forceExit=false;
console.log(`Mounted regression evidence: ${out}`);
const record=async()=>writeFile(path.join(out,'results.json'),JSON.stringify({inventory,expected,selected,cells:results,errors:globalErrors},null,2)+'\n');
const describe=error=>error?.stack||String(error);
const launchOwnedBrowser=async()=>{
 browserServer=await withinMountedDeadline(()=>browserType.launchServer({executablePath:browserName==='webkit'?process.env.PONDEROSA_WEBKIT_PATH:process.env.PONDEROSA_CHROME_PATH||'/usr/bin/google-chrome',headless:true,...(browserName==='chromium'?{args:['--no-sandbox']}:{}),timeout:15_000}),20_000,'owned browser launch');
 browser=await withinMountedDeadline(()=>browserType.connect(browserServer.wsEndpoint()),10_000,'owned browser connection');
};
const closeOwnedBrowser=async()=>{
 const owned=browserServer,client=browser,pid=owned?.process()?.pid;browser=undefined;browserServer=undefined;
 if(client)try{await withinMountedDeadline(()=>client.close(),5000,'browser client cleanup');}catch(error){globalErrors.push({stage:'browser client cleanup',ownedPid:pid,error:describe(error)});process.exitCode=1;}
 if(!owned)return true;
 try{await withinMountedDeadline(()=>owned.close(),5000,'owned browser cleanup');return true;}
 catch(error){globalErrors.push({stage:'owned browser cleanup',ownedPid:pid,error:describe(error)});process.exitCode=1;}
 // Playwright owns this exact launched server/process. Never search for or kill
 // Chrome by name, a guessed PID, another user profile or an unrelated group.
 try{await withinMountedDeadline(()=>owned.kill(),5000,'owned browser kill');return true;}
 catch(error){globalErrors.push({stage:'owned browser kill unresolved',ownedPid:pid,error:describe(error)});process.exitCode=1;forceExit=true;return false;}
};
const persist=()=>withinMountedDeadline(record,5000,'evidence persistence');
try{
 const compiled=spawnSync(process.execPath,[path.join(root,'apps/web/node_modules/@rsbuild/core/bin/rsbuild.js'),'build','--config',path.join(root,'tests/shared/mounted-regressions.config.mjs')],{cwd:root,env:{...process.env,PONDEROSA_MOUNTED_BUILD:build},stdio:'inherit',timeout:180_000});
 if(compiled.error)throw compiled.error;assert.equal(compiled.status,0,'The complete mounted entry must compile before browser cases begin');
 server=createServer(async(request,response)=>{
  try{
   const url=new URL(request.url,'http://fixture.local');
   if(url.pathname.startsWith('/api/')){response.writeHead(501,{'content-type':'application/json'});response.end(JSON.stringify({error:'Mounted regression made an unmocked API request'}));return;}
   const relative=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1)),target=path.resolve(build,relative);
   if(!target.startsWith(path.resolve(build)+path.sep)){response.writeHead(404);response.end();return;}
   const bytes=await readFile(target),mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2'};
   response.writeHead(200,{'content-type':mime[path.extname(target)]??'application/octet-stream','cache-control':'no-store'});response.end(bytes);
  }catch(error){response.writeHead(500,{'content-type':'text/plain'});response.end(String(error));}
 });
 await withinMountedDeadline(()=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);}),5000,'owned listener setup');origin='http://127.0.0.1:'+server.address().port;
 await launchOwnedBrowser();
 for(const mobile of [false,true])for(const name of selected){
  const cell=mobile?'phone':'desktop',pageErrors=[],network=[],canvasSpec=browserName==='webkit'?canvasResizeCase(name):undefined;let context,page,stopped=false,canvasDiagnostics,pageErrorCountAtProof;
  const settledNativeResize=()=>settledCanvasResizeDiagnostics({browser:browserName,name,url:origin+'/',pageErrors,pageErrorCountAtProof,diagnostics:canvasDiagnostics});
  const startedAt=Date.now(),checkpoint=()=>{if(stopped)throw Error('Mounted cell ended; no late browser action is allowed');};
  const outcome=await runMountedCase({timeout,stop:()=>{stopped=true;},
   run:async()=>{
    context=await browser.newContext({...(mobile&&browserName==='webkit'?devices['iPhone 13']:{viewport:mobile?{width:390,height:844}:{width:1440,height:962},isMobile:mobile,hasTouch:mobile}),...(process.env.PONDEROSA_MOUNTED_VIDEO==='1'?{recordVideo:{dir:path.join(out,cell+'-video')}}:{})});checkpoint();
    if(canvasSpec){await context.addInitScript(installCanvasResizeDiagnostics,canvasSpec);checkpoint();}
    await context.route('**/*',route=>{
     const url=new URL(route.request().url());
     if(url.origin!==origin||url.pathname.startsWith('/api/')){network.push({url:url.href,method:route.request().method()});return route.abort('blockedbyclient');}
     return route.continue();
    });checkpoint();
    page=await context.newPage();checkpoint();page.setDefaultTimeout(timeout);page.on('pageerror',error=>pageErrors.push(describe(error)));
    await page.goto(origin);checkpoint();await page.waitForFunction(()=>Boolean(window.ponderosaMountedRegression));checkpoint();
    assert.deepEqual(await page.evaluate(()=>window.ponderosaMountedRegression.list()),expected,'Browser must expose every inventoried export');checkpoint();
    await page.evaluate(name=>window.ponderosaMountedRegression.run(name),name);checkpoint();
    // This flush is inside the same case deadline as setup and fixture actions.
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));checkpoint();
    if(canvasSpec){canvasDiagnostics=await page.evaluate(()=>window.__mountedCanvasResize.finish());checkpoint();pageErrorCountAtProof=pageErrors.length;assert(settledNativeResize(),'Canvas native diagnostics require exact provenance and bounded mounted/unmounted settlement');}
    else assert.deepEqual(pageErrors,[],'Uncaught browser errors invalidate a cell');
    assert.deepEqual(network,[],'A mounted fixture must own every API/network effect');
   },
   diagnose:async()=>{if(page)await page.screenshot({path:path.join(out,cell+'-'+name+'-failure.png'),fullPage:true,timeout:5000});},
   close:async()=>{try{if(canvasSpec&&page)canvasDiagnostics=await page.evaluate(()=>window.__mountedCanvasResize?.read());}finally{if(context)await context.close();}},
  });
  if(!outcome.failure&&((canvasSpec?!settledNativeResize():pageErrors.length>0)||network.length))outcome.failure=Error('Late browser errors or unmocked effects invalidated the mounted cell');
  const result={cell,browser:browserName,name,status:outcome.failure||outcome.secondary.length?'FAIL':'PASS',durationMs:Date.now()-startedAt,...(outcome.failure?{error:describe(outcome.failure)}:{}),secondary:outcome.secondary.map(row=>({stage:row.stage,error:describe(row.error)})),pageErrors,network,...(canvasSpec?{canvasDiagnostics,pageErrorCountAtProof}:{} )};results.push(result);await persist();console.log(`${result.status} ${cell} ${name}`);
  if(outcome.timedOut||outcome.secondary.some(row=>row.stage==='context cleanup')||!browser.isConnected()){
   // A timeout can leave a late context-creation/evaluate promise. Reclaim only
   // this owned browser before later independent cells; never replay this case.
   if(!await closeOwnedBrowser())throw Error('Owned browser cleanup is unresolved; remaining cells are blocked');
   if(results.length<selected.length*2)await launchOwnedBrowser();
  }
 }
 assert.equal(results.length,selected.length*2,'Every exported regression must complete one desktop and one phone cell');
 assert.ok(results.every(result=>result.status==='PASS'),'Mounted regressions failed; inspect results.json and failure evidence');
}catch(error){globalErrors.push({stage:'qualification',error:describe(error)});process.exitCode=1;if(error?.code==='ERR_MOUNTED_TIMEOUT')forceExit=true;}
finally{
 await closeOwnedBrowser();
 if(server)try{server.closeAllConnections();await withinMountedDeadline(()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())),5000,'owned listener cleanup');}catch(error){globalErrors.push({stage:'server cleanup',error:describe(error)});process.exitCode=1;forceExit=true;}
 try{await persist();}catch(error){console.error('Mounted evidence could not be persisted:',describe(error));process.exitCode=1;forceExit=true;}
 // A broken transport/cleanup promise may keep Node alive. Evidence has been
 // attempted and only this runner exits; unknown browser processes are untouched.
 if(forceExit)process.exit(1);
}
