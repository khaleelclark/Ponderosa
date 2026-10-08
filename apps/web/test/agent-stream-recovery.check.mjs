import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createRsbuild} from '@rsbuild/core';
import {pluginReact} from '@rsbuild/plugin-react';
import {registerStreamRoutes} from '../../server/dist/routes/streams.js';

const require=createRequire(new URL('../../server/package.json',import.meta.url));
const Fastify=require('fastify');
const web=fileURLToPath(new URL('..',import.meta.url));
const output=await mkdtemp(path.join(tmpdir(),'agent-stream-recovery-'));
const playwright=await import(process.env.PONDEROSA_PLAYWRIGHT_PATH??require.resolve('playwright-core'));
const engine=process.env.PONDEROSA_TEST_BROWSER??'chromium';
const closures=new Set(), subscribers=new Set(), app=Fastify();
let browser, down=false, history=[], requests=[], latest=147;
const large={seq:146,ts:'2026-10-01',event:{type:'tool_result',output:'x'.repeat(1_058_543)}};
try {
  const build=await createRsbuild({cwd:web,rsbuildConfig:{plugins:[pluginReact()],
    source:{entry:{index:path.join(web,'test/agent-stream-recovery-entry.tsx')},alias:{
      '../src/components/AgentDetail.header':path.join(web,'test/fixtures/agent-header-stop-probe.tsx'),
      '@qualification-real-agent-header':path.join(web,'src/components/AgentDetail.header.tsx'),
    }},
    output:{distPath:{root:output}},logLevel:'error'}});
  await build.build();
  app.addHook('onRequest',async request=>{
    if(request.url.startsWith('/api/agents/agent/stream'))requests.push(request.url);
  });
  registerStreamRoutes(app,{
    store:{getAgent:()=>({id:'agent'}),lastSeqOf:()=>latest,
      readEventsSince:(_,cursor,limit)=>history.filter(e=>e.seq>cursor).slice(0,limit)},
    workspace:{instanceId:()=> 'instance'},serverClosed:()=>down,
    maxSubscribersPerStream:20,workspaceSubscribers:new Set(),agentSubscriberCount:()=>subscribers.size,
    subscribe:(_,listener)=>{subscribers.add(listener);return()=>subscribers.delete(listener);},
    liveSseClosures:closures,serverMetrics:{openSse:()=>()=>{},sseBackpressure:()=>{}},
  });
  app.get('/test/control',async request=>{
    const action=new URL(request.url,'http://localhost').searchParams.get('action');
    if(action==='disconnect')for(const close of closures)close();
    if(action==='down'){down=true;for(const close of closures)close();}
    if(action==='up')down=false;
    if(action==='large'){
      const event={...large,seq:++latest};history.push(event);
      for(const listener of subscribers)listener(event);
    }
    if(action==='later'){
      const event={seq:++latest,ts:'2026-10-01',event:{type:'command',command:'disposable',cwd:'/tmp'}};
      history.push(event);for(const listener of subscribers)listener(event);
    }
    return {ok:true};
  });
  app.get('/*',async(request,reply)=>{
    const pathname=new URL(request.url,'http://localhost').pathname;
    const file=path.resolve(output,'.'+(pathname==='/'?'/index.html':pathname));
    if(!file.startsWith(output+'/'))return reply.code(404).send();
    try{return reply.type(file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html').send(await readFile(file));}
    catch{return reply.code(404).send();}
  });
  await app.listen({host:'127.0.0.1',port:0});
  browser=await playwright[engine].launch({headless:true,...(engine==='chromium'?{executablePath:process.env.PONDEROSA_CHROMIUM_PATH}:{})});
  for(const width of [390,1440]){
    history=[large,{seq:147,ts:'2026-10-01',event:{type:'context_usage'}}];latest=147;requests=[];down=false;
    const page=await browser.newPage({viewport:{width,height:900}});
    const errors=[];page.on('pageerror',error=>{errors.push(error.message);console.error(error.message);});
    await page.goto(app.listeningOrigin);
    if(width<900)await page.getByRole('button',{name:'Expand workspace header',exact:true}).click();
    await page.getByText('connected',{exact:true}).waitFor();
    await page.waitForFunction(()=>window.canonicalRefreshes>=2);
    assert.equal(requests.length,1,'oversized replay requires no reconnect');
    const control=action=>page.evaluate(action=>fetch('/test/control?action='+action),action);
    await control('large');
    await page.waitForFunction(()=>window.canonicalRefreshes>=3);
    await control('later');
    await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('ponderosa.agent.stream-cursors.v1')??'[]')
      .some(([id,cursor])=>id==='agent'&&cursor.lastSeq===149));
    assert.equal(requests.length,1,'large live result keeps its stream');
    await control('disconnect');
    await page.getByText('disconnected',{exact:true}).waitFor();
    if(width<900) assert.match(await page.getByRole('button',{name:/^Agent status:/}).getAttribute('aria-label'), /; live\./,
      'mobile status retains live state during the short reconnect grace period');
    else assert.equal(await page.getByText('Reconnecting updates',{exact:true}).count(),0,'short reconnect has a grace period');
    await page.getByText('connected',{exact:true}).waitFor();
    assert(requests.at(-1).includes('lastEventId=149'),'real API resumes past oversized snapshot and later event');
    await control('down');
    if(width<900) {
      const status=page.getByRole('button',{name:/^Agent status:/});
      await page.getByRole('button',{name:/^Agent status: Running.*; reconnecting\./}).waitFor();
      await status.focus();await page.keyboard.press('Enter');
      await page.getByRole('status').filter({hasText:/Agent status: Running.*; reconnecting\./}).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('status').filter({hasText:/Agent status:/}).waitFor({state:'hidden'});
      assert(await status.evaluate(el=>el===document.activeElement),'status returns keyboard focus after Escape');
      assert.equal(await page.evaluate(()=>window.stopRequests),0,'viewing status cannot stop work');
      await page.getByRole('button',{name:/^Agent status: Running.*; stale\./}).waitFor({timeout:12_000});
      await status.click();
      const detail=page.getByRole('status').filter({hasText:/Agent status: Running.*; stale\./});await detail.waitFor();
      await page.mouse.move(0,899);
      await page.waitForFunction(()=>{
        let element=[...document.querySelectorAll('[role="status"]')].find(e=>e.textContent.includes('; stale.'));
        if(!element)return false;
        for(;element;element=element.parentElement)if(getComputedStyle(element).opacity!=='1')return false;
        return true;
      });
      const bounds=await detail.boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=width+0.5,'mobile status details stay in viewport');
      if(process.env.PONDEROSA_QUALIFICATION_SCREENSHOTS==='1')await page.screenshot({path:`/tmp/remaining-stream-status-${engine}-${width}.png`});
      await page.keyboard.press('Escape');
    } else {
      await page.getByText('Reconnecting updates',{exact:true}).waitFor();
      const running=page.locator('.MuiChip-root').filter({hasText:/^Running/});
      assert.equal(await running.count(),1);
      assert(await running.evaluate(el=>el.classList.contains('MuiChip-colorInfo')),'Run stays blue while its connection is reconnecting');
      await page.getByText('Updates delayed',{exact:true}).waitFor({timeout:12_000});
      await page.getByText(/^Last known: Running/).waitFor();
      if(process.env.PONDEROSA_QUALIFICATION_SCREENSHOTS==='1')await page.screenshot({path:`/tmp/remaining-stream-status-${engine}-${width}.png`});
    }
    assert(await page.locator('.MuiChip-root').evaluateAll(chips=>chips.every(chip=>{
      const r=chip.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+0.5;
    })),'both status chips remain inside the real header');
    assert(await page.getByRole('button',{name:'Stop',exact:true}).isVisible());
    assert.equal(await page.evaluate(()=>window.stopRequests),0,'status inspections do not mutate work');
    await page.getByRole('button',{name:'Stop',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.stopRequests),1,'Stop remains independently reachable');
    await control('up');
    await page.getByText('connected',{exact:true}).waitFor({timeout:12_000});
    assert.equal(await page.getByText('Updates delayed',{exact:true}).count(),0);
    if(width<900) assert.match(await page.getByRole('button',{name:/^Agent status:/}).getAttribute('aria-label'), /; live\./);
    assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.close();
    console.log(`PASS ${engine} ${width}: oversized replay/live recovery, exact resume cursor149, grace/stale/recovery, mobile accessible status/keyboard popover or desktop inline status, inert inspection and independent Stop`);
  }
}finally{
  await browser?.close();for(const close of closures)close();await app.close();
  await rm(output,{recursive:true,force:true});
}
