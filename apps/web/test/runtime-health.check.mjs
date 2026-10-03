import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRsbuild} from '@rsbuild/core';
import {pluginReact} from '@rsbuild/plugin-react';
const web=fileURLToPath(new URL('..',import.meta.url));
const output=await mkdtemp(path.join(tmpdir(),'runtime-health-browser-'));
const playwright=await import(process.env.PONDEROSA_PLAYWRIGHT_PATH??'playwright');
const engine=process.env.PONDEROSA_TEST_BROWSER??'chromium';
let browser,server;
try{
 const build=await createRsbuild({cwd:web,rsbuildConfig:{plugins:[pluginReact()],source:{entry:{index:path.join(web,'test/runtime-health-entry.tsx')}},output:{distPath:{root:output}},logLevel:'error'}});await build.build();
 server=createServer(async(req,res)=>{try{const name=path.join(output,new URL(req.url,'http://localhost').pathname==='/'?'index.html':new URL(req.url,'http://localhost').pathname);res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(await readFile(name));}catch{res.writeHead(404).end();}}).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 browser=await playwright[engine].launch({headless:true,...(engine==='chromium'?{executablePath:process.env.PONDEROSA_CHROMIUM_PATH}:{})});
 for(const width of [320,390,1440]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:'Connect',exact:true}).click();
  await page.waitForTimeout(300);
  const reads=()=>page.evaluate(()=>Number(document.body.dataset.reads));
  let before=await reads();await page.getByRole('button',{name:'Recover provider',exact:true}).click();
  await page.waitForFunction(before=>Number(document.body.dataset.reads)>before,before,{timeout:6500});
  await page.waitForTimeout(300);before=await reads();await page.getByRole('button',{name:'Tool burst',exact:true}).click();
  await page.waitForTimeout(5200);assert.equal(await reads(),before,'tool output must not create auth probes/engine refreshes');
  before=await reads();await page.getByRole('button',{name:'Disconnect',exact:true}).click();await page.getByRole('button',{name:'Connect',exact:true}).click();
  await page.waitForFunction(before=>Number(document.body.dataset.reads)>before,before,{timeout:6500});
  assert.equal(await page.getByText(/Quiet Agent is working/).count(),1);
  const activity=page.getByLabel(/Quiet Agent working\. Quiet Agent: last execution activity/);await page.getByRole('button',{name:'Tool burst',exact:true}).focus();await page.keyboard.press('Tab');assert.equal(await activity.evaluate(el=>el===document.activeElement),true);
  await page.getByRole('tooltip').waitFor();assert.match(await page.getByRole('tooltip').innerText(),/Quiet output is not a failure/);
  await page.getByText('Waiting for host resources',{exact:true}).click();
  assert.match(await page.locator('details').innerText(),/Accepted work stays queued; existing Runs are not cancelled/);
  assert.equal(await page.getByText('Sign-in needed',{exact:true}).count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);await page.screenshot({path:`/tmp/spec3-runtime-health-${engine}-${width}.png`,fullPage:true});await page.close();
  console.log(`PASS ${engine} ${width}: canonical recovery, ordinary reconnect, bounded engine refresh, quiet activity age and accessible resource details`);
 }
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(output,{recursive:true,force:true});}
