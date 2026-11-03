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

const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(new URL('../../apps/server/package.json',import.meta.url));
const {chromium}=require('playwright-core');
const inventory=mountedRegressionInventory(),expected=inventory.flatMap(row=>row.names).sort();
assert.deepEqual(mountedRegressionEntryImports(),inventory.map(row=>row.file),'Every mounted source must be included exactly once');
assert.equal(new Set(expected).size,expected.length,'Mounted case names must be unique');assert.ok(expected.length>0);
const owned=await mkdtemp(path.join(tmpdir(),'ponderosa-mounted-regressions-'));
const build=process.env.PONDEROSA_MOUNTED_BUILD??path.join(owned,'build');
const out=process.env.PONDEROSA_MOUNTED_EVIDENCE??path.join(owned,'evidence');
for(const directory of [build,out]){
 assert(path.isAbsolute(directory),'Build and evidence paths must be absolute');await mkdir(directory,{recursive:true});
 assert.equal((await readdir(directory)).length,0,'Use fresh owned build and evidence paths; existing content is preserved');
}
const timeout=Number(process.env.PONDEROSA_MOUNTED_CASE_TIMEOUT_MS??30_000);
assert(Number.isSafeInteger(timeout)&&timeout>=1000&&timeout<=120_000,'Case timeout must be between 1 and 120 seconds');
const results=[],globalErrors=[];let server,browser,origin;
console.log(`Mounted regression evidence: ${out}`);
const record=async()=>writeFile(path.join(out,'results.json'),JSON.stringify({inventory,expected,cells:results,errors:globalErrors},null,2)+'\n');
const bounded=async(work,milliseconds)=>{let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Mounted regression exceeded its finite timeout')),milliseconds);})]);}finally{clearTimeout(timer);}};
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
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:process.env.PONDEROSA_CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 for(const mobile of [false,true])for(const name of expected){
  const cell=mobile?'phone':'desktop',pageErrors=[],network=[],secondary=[];let context,page,failure;
  const startedAt=Date.now();
  try{
   context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:962},isMobile:mobile,hasTouch:mobile,...(process.env.PONDEROSA_MOUNTED_VIDEO==='1'?{recordVideo:{dir:path.join(out,cell+'-video')}}:{})});
   await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin||url.pathname.startsWith('/api/')){network.push({url:url.href,method:route.request().method()});return route.abort('blockedbyclient');}
    return route.continue();
   });
   page=await context.newPage();page.setDefaultTimeout(timeout);page.on('pageerror',error=>pageErrors.push(error.stack??error.message));
   await page.goto(origin);await page.waitForFunction(()=>Boolean(window.ponderosaMountedRegression));
   assert.deepEqual(await page.evaluate(()=>window.ponderosaMountedRegression.list()),expected,'Browser must expose every inventoried export');
   await bounded(page.evaluate(name=>window.ponderosaMountedRegression.run(name),name),timeout);
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.deepEqual(pageErrors,[],'Uncaught browser errors invalidate a cell');assert.deepEqual(network,[],'A mounted fixture must own every API/network effect');
  }catch(error){
   failure=error;
   if(page)try{await page.screenshot({path:path.join(out,cell+'-'+name+'-failure.png'),fullPage:true,timeout:5000});}catch(error){secondary.push({stage:'failure screenshot',error:error.stack??String(error)});}
  }finally{
   if(context)try{await context.close();}catch(error){secondary.push({stage:'context cleanup',error:error.stack??String(error)});}
   const result={cell,name,status:failure||secondary.length?'FAIL':'PASS',durationMs:Date.now()-startedAt,...(failure?{error:failure.stack??String(failure)}:{}),secondary,pageErrors,network};results.push(result);await record();console.log(`${result.status} ${cell} ${name}`);
  }
 }
 assert.equal(results.length,expected.length*2,'Every exported regression must complete one desktop and one phone cell');
 assert.ok(results.every(result=>result.status==='PASS'),'Mounted regressions failed; inspect results.json and failure evidence');
}catch(error){globalErrors.push({stage:'qualification',error:error.stack??String(error)});process.exitCode=1;}
finally{
 if(browser)try{await browser.close();}catch(error){globalErrors.push({stage:'browser cleanup',error:error.stack??String(error)});process.exitCode=1;}
 if(server)try{server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}catch(error){globalErrors.push({stage:'server cleanup',error:error.stack??String(error)});process.exitCode=1;}
 await record();
}
