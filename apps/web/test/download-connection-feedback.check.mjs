import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRsbuild} from '@rsbuild/core';
import {pluginReact} from '@rsbuild/plugin-react';
const web=fileURLToPath(new URL('..',import.meta.url)),out=await mkdtemp(path.join(tmpdir(),'download-connection-feedback-'));
const playwright=await import(process.env.PONDEROSA_PLAYWRIGHT_PATH??'playwright-core');
const engine=process.env.PONDEROSA_TEST_BROWSER??'chromium';
let server,browser,requests=0,otherRequests=0,pending;
try{
  const build=await createRsbuild({cwd:web,rsbuildConfig:{plugins:[pluginReact()],source:{entry:{index:path.join(web,'test/download-connection-feedback-entry.tsx')}},output:{distPath:{root:out}},logLevel:'error'}});await build.build();
  server=createServer(async(req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/api/probe/download'||pathname==='/api/probe/unknown'){
      requests++;pending=res;res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="app.apk"',...(pathname.endsWith('/download')?{'Content-Length':'100'}:{})});res.write(Buffer.alloc(25));return;
    }
    if(pathname==='/api/probe/other'){otherRequests++;res.end('other');return;}
    if(pathname==='/api/probe/missing'){res.writeHead(404).end();return;}
    if(pathname==='/test/chunk'){pending?.write(Buffer.alloc(25));res.end('ok');return;}
    if(pathname==='/test/finish'){pending?.end(Buffer.alloc(50));pending=undefined;res.end('ok');return;}
    try{const file=path.join(out,pathname==='/'?'index.html':pathname);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await readFile(file));}catch{res.writeHead(404).end();}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await playwright[engine].launch({headless:true,...(engine==='chromium'?{executablePath:process.env.PONDEROSA_CHROMIUM_PATH}:{})});
  const origin=`http://127.0.0.1:${server.address().port}`;
  for(const viewport of [{width:412,height:900},{width:412,height:500},{width:1440,height:900}]){
    requests=0;otherRequests=0;
    const context=await browser.newContext({viewport,hasTouch:true,acceptDownloads:true});
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin);await page.clock.install();
    // Exercise the real hook, not a visual-only fixture state.
    await page.getByRole('button',{name:'Fail connection',exact:true}).tap();await page.clock.runFor(8_100);
    await page.getByText('Live updates are disconnected.',{exact:false}).waitFor();
    await page.getByRole('button',{name:'Retry',exact:true}).tap();
    await page.getByRole('button',{name:'Checking…',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Checking…',exact:true}).isDisabled(),true);
    assert.equal(await page.locator('body').getAttribute('data-attempts'),'2');
    await page.getByRole('button',{name:'Details',exact:true}).tap();
    await page.getByText('This does not mean an Agent stopped',{exact:false}).waitFor();
    await page.clock.runFor(8_100);await page.getByRole('button',{name:'Retry',exact:true}).waitFor();
    await page.getByRole('button',{name:'Retry',exact:true}).tap();
    await page.getByRole('button',{name:'Fail connection',exact:true}).tap();
    await page.getByRole('button',{name:'Retry',exact:true}).waitFor();
    await page.getByRole('button',{name:'Restore connection',exact:true}).tap();
    await page.waitForFunction(()=>document.querySelector('#connection')?.textContent==='live');
    assert.equal(await page.getByText('Live updates are disconnected.',{exact:false}).count(),0,'banner clears only after confirmed status');
    const download=page.getByRole('link',{name:'Download APK',exact:true});
    await download.tap();await page.getByText('Preparing download…',{exact:false}).waitFor();
    await page.clock.runFor(300);
    await page.getByRole('progressbar',{name:'Download preparation progress'}).waitFor();
    await page.waitForFunction(()=>document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')==='25');
    await download.tap();await page.getByText('This download is already being prepared.',{exact:false}).waitFor();
    assert.equal(requests,1);
    await page.getByRole('link',{name:'Download another file',exact:true}).tap();
    await page.getByText('Finish or cancel the current download',{exact:false}).waitFor();assert.equal(otherRequests,0);
    // Total duration exceeds the old 60s cutoff, but arriving chunks extend the idle deadline.
    await page.clock.runFor(40_000);await page.evaluate(()=>fetch('/test/chunk'));await page.clock.runFor(300);
    await page.waitForFunction(()=>document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')==='50');
    await page.clock.runFor(30_000);assert.equal(await page.getByRole('button',{name:'Cancel download',exact:true}).count(),1);
    const received=page.waitForEvent('download');await page.evaluate(()=>fetch('/test/finish'));const file=await received;assert.equal(file.suggestedFilename(),'app.apk');
    await page.getByText('Download started',{exact:true}).waitFor();await page.clock.runFor(3_500);
    await page.getByRole('link',{name:'Download unknown size',exact:true}).tap();await page.getByText('Preparing download…',{exact:false}).waitFor();
    assert.equal(await page.getByRole('progressbar',{name:'Download preparation progress'}).getAttribute('aria-valuenow'),null);
    await page.getByRole('button',{name:'Cancel download',exact:true}).tap();await page.getByText('Download cancelled',{exact:true}).waitFor();
    pending?.destroy();pending=undefined;await page.clock.runFor(3_500);
    await download.tap();await page.getByText('Preparing download…',{exact:false}).waitFor();await page.clock.runFor(300);
    await page.waitForFunction(()=>document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')==='25');
    await page.clock.runFor(61_000);
    await page.getByText('No download data arrived for 60 seconds.',{exact:false}).waitFor();pending?.destroy();pending=undefined;
    await page.getByRole('button',{name:'Close',exact:true}).tap();
    await page.getByRole('link',{name:'Download missing file',exact:true}).tap();await page.getByText('Download could not start (404). Try again.',{exact:true}).waitFor();
    assert.deepEqual(errors,[]);await context.close();console.log(`${engine}: feedback, progress, repeat taps, slow transfer, cancel, idle timeout and connection retries passed at ${viewport.width}x${viewport.height}`);
  }
}finally{pending?.destroy();await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(out,{recursive:true,force:true});}
