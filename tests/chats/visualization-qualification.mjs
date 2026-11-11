// Explicit built-UI qualification: existing Playwright + disposable API/inert providers only.
import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const {AgentStore}=await import('../../packages/agents/dist/store.js');
const {fixture,until}=await import('../shared/fixture.mjs');
const root=fileURLToPath(new URL('../../',import.meta.url)),{chromium,webkit,devices}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const out=process.env.PONDEROSA_VISUALIZATION_EVIDENCE??await mkdtemp(path.join(tmpdir(),'ponderosa-visualizations-'));await mkdir(out,{recursive:true});
const html=await readFile(new URL('../fixtures/interactive-visualization.html',import.meta.url),'utf8'),rows=[];
let browser,context,f,page;let outboundRequests=0;const receiver=createServer((_request,response)=>{outboundRequests++;response.end('must remain unreachable');});await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));
const external='http://127.0.0.1:'+receiver.address().port+'/blocked';
const reveal=locator=>locator.evaluate(node=>{const region=node.closest('.chat-scroll-region');if(!region){node.scrollIntoView();return;}const top=region.scrollTop+node.getBoundingClientRect().top-region.getBoundingClientRect().top;region.dispatchEvent(new CustomEvent('ponderosa:chat-message-navigation',{detail:top}));region.scrollTo({top,behavior:'instant'});});
const save=()=>writeFile(path.join(out,'results.json'),JSON.stringify({rows,realProvider:false,liveDataChanged:false,outboundRequests},null,2)+'\n');
try{
 for(const engine of (process.env.PONDEROSA_VISUALIZATION_BROWSERS??'chromium,webkit').split(',')){
  browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='webkit'?{executablePath:process.env.PONDEROSA_WEBKIT_PATH}:{executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']})});
  for(const width of (process.env.PONDEROSA_VISUALIZATION_WIDTHS??'1440,390').split(',').map(Number))for(const mode of (process.env.PONDEROSA_VISUALIZATION_MODES??'light,dark').split(','))for(const surface of (process.env.PONDEROSA_VISUALIZATION_SURFACES??'chat,agent,assistant').split(',')){
   const activate=locator=>width===390?locator.tap():locator.click();
   const row={engine,width,mode,surface,provider:mode==='dark'?'claude':'codex',passed:false,errors:[],expectedErrors:[],reads:[],previewLoads:0};rows.push(row);let store,session,agent,chat,base,origin,securityProbe=false,expectedTopFrame='';
   const dirs=new Map();
   try{
    f=await fixture({webDist:process.env.PONDEROSA_VISUALIZATION_WEB_DIST??path.join(root,'apps/web/dist'),storeFactory:dir=>store=new AgentStore(dir),diagnosticProvider:true,onProviderOpen:options=>dirs.set(options.agentId,options.cwd)});
    if(surface==='assistant'){
     const descriptor=f.ok(await f.api('POST','/api/branches/assistant',{initialize:true}));base='/api/branches/engine';
     agent=store.getAgent(descriptor.app.agentId);chat=store.getConversation(agent.conversationId);
    }else{base='/api';chat=await f.createChat('Interactive Panels');agent=await f.createIdleAgent(chat,'Panel Author');}
    if(mode==='dark')f.ok(await f.api('PATCH',`${base}/agents/${agent.id}`,{activeEngine:'claude'}));
    f.plans.set(agent.id,[{hold:true}]);f.ok(await f.api('POST',`${base}/agents/${agent.id}/messages`,{text:'Build this authorized interactive panel.',idempotencyKey:randomUUID()}));
    session=await until(()=>f.sessions.get(agent.id),'authorized publisher session');
    const instructions=store.acceptedProviderSessionInput(agent.id)?.exactSystemPrompt;assert(instructions?.includes('\"type\":\"visualization\"')&&instructions.includes('--ponderosa-accent'),'Both executing engines receive the shared supported format');
    const working=dirs.get(agent.id);assert(working.startsWith(f.root+path.sep),'Only disposable working files');
    const capture=async(name,content)=>{await writeFile(path.join(working,name),content);return f.ok(await f.tool(session,'ponderosa_import_file',{path:name})).artifact;};
    const notes=await capture('retained-notes.txt','Unrelated attachment remains available.'),artifact=await capture('explorer.html',html),broken=await capture('broken.html','<!doctype html><script>throw new Error("Controlled visualization failure")</script>');
    const oversized=await capture('oversized.html',html+' '.repeat(2*1024*1024));
    const fence=(id,title)=>'```ponderosa\n'+JSON.stringify({version:1,type:'visualization',title,artifactId:id})+'\n```';
    const text=[('Panel controls remain usable after a long explanation.\n').repeat(80),fence(artifact.id,'Fruit Sales Explorer'),fence(artifact.id,'Independent Explorer'),fence(broken.id,'Broken Panel'),fence(oversized.id,'Large Panel')].join('\n\n');
    f.ok(await f.tool(session,'ponderosa_message',{intent:surface==='chat'?'broadcast':'direct_to_user',text,artifactIds:[artifact.id,broken.id,oversized.id,notes.id],idempotencyKey:randomUUID()}));
    const publication=store.readCommunicationEvents(agent.projectId).find(event=>event.sender.kind==='agent'&&event.artifactIds?.includes(artifact.id));assert(publication);

    origin=await f.listen();context=await browser.newContext({...(engine==='webkit'&&width===390?{...devices['iPhone 13'],viewport:{width,height:844}}:{viewport:{width,height:width===390?844:962},isMobile:width===390,hasTouch:width===390})});
    await context.addInitScript(mode=>{if(window!==window.top)return;localStorage.setItem('ponderosa-color-mode',mode);localStorage.setItem('private-parent-sentinel','not available to a panel');},mode);
    page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>{if(error.message==='Controlled visualization failure'||engine==='webkit'&&securityProbe&&expectedTopFrame&&error.message.includes(expectedTopFrame)&&error.message.includes('The frame attempting navigation of the top-level window is sandboxed')&&error.message.includes("'allow-top-navigation-by-user-activation' flag is not set"))row.expectedErrors.push(error.message);else row.errors.push(error.message);});
    page.on('response',async response=>{const url=new URL(response.url());if(url.pathname.endsWith('/preview')&&url.searchParams.has('visualizationNonce'))row.previewLoads++;if(url.pathname.endsWith('/artifacts/'+artifact.id))row.reads.push({path:url.pathname,status:response.status()});});
    const route=surface==='assistant'?'/assistant':surface==='agent'?`/projects/${agent.projectId}/agents/${agent.id}?view=chat`:`/projects/${chat.projectId}/chats/${chat.id}`;
    await page.goto(origin+route,{waitUntil:'domcontentloaded'});
    row.coldScroll=[];for(let attempt=0;attempt<3;attempt++){await reveal(page.locator('[data-ponderosa-rich="visualization"]').first());await page.waitForTimeout(250);row.coldScroll.push(await page.evaluate(()=>({frame:!!document.querySelector('iframe[title="Fruit Sales Explorer"]'),panel:document.querySelector('[data-ponderosa-rich="visualization"]')?.getBoundingClientRect().toJSON(),regions:[...document.querySelectorAll('.chat-scroll-region')].map(node=>({top:node.scrollTop,height:node.scrollHeight,viewport:node.clientHeight}))})));if(row.coldScroll.at(-1).frame)break;}assert.equal(await page.getByRole('button',{name:'Show Full Message',exact:true}).count(),0,'Interactive messages bypass prose truncation');
    const iframe=page.locator('iframe[title="Fruit Sales Explorer"]');await iframe.waitFor();const frame=await(await iframe.elementHandle()).contentFrame();assert(frame);
    await frame.getByLabel('Fruit Filter',{exact:true}).waitFor();await page.waitForFunction(()=>getComputedStyle(document.querySelector('iframe[title="Fruit Sales Explorer"]')).visibility==='visible');
    const originalSrc=await iframe.getAttribute('src');expectedTopFrame=new URL(originalSrc,origin).href;const marker=await frame.evaluate(()=>{window.__panelInstance='instance-'+Math.random();return window.__panelInstance;});
    assert.equal(await iframe.getAttribute('sandbox'),'allow-scripts');
    await frame.getByLabel('Chart View',{exact:true}).selectOption('donut');assert.equal(await frame.locator('#chart circle').count(),4);
    const colors=await frame.locator('#chart circle').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('stroke')));assert.equal(new Set(colors).size,4);
    await frame.getByLabel('Fruit Filter',{exact:true}).selectOption({label:'Apples'});assert.equal(await frame.locator('#rows tr').count(),1);assert.equal(await frame.locator('#total').innerText(),'40 units');
    await frame.getByLabel('Fruit Filter',{exact:true}).selectOption('all');await frame.getByRole('button',{name:'Units ↕',exact:true}).focus();await page.keyboard.press('Enter');assert.equal(await frame.locator('#rows tr').first().innerText(),'Oranges\t15');
    await frame.getByLabel('Search Fruits',{exact:true}).fill('gr');assert.equal(await frame.locator('#rows tr').count(),1);assert.equal(await frame.locator('#total').innerText(),'20 units');
    await frame.getByLabel('Quantity',{exact:true}).fill('12');await frame.getByLabel('Unit Price',{exact:true}).focus();await page.keyboard.press('ArrowRight');assert.equal(await frame.locator('#revenue').innerText(),'$72');
    await activate(frame.getByRole('button',{name:'Pause Simulation',exact:true}));assert.equal(await frame.getByRole('button',{name:'Resume Simulation',exact:true}).getAttribute('aria-pressed'),'true');
    session.finish();await until(()=>!store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status IN ('running','leased')").get(agent.id),'stream/completion state settles');await page.waitForTimeout(250);assert.equal(await frame.evaluate(()=>window.__panelInstance),marker,'Canonical completion never replaces a live panel');
    const panel=page.locator('[data-ponderosa-rich="visualization"]').first();
    assert.equal(await panel.locator('dialog').count(),0,'Inline visualization has no separate dialog');
    for(const name of ['Expand','Restore','Download'])assert.equal(await panel.getByRole('button',{name,exact:true}).count()+await panel.getByRole('link',{name,exact:true}).count(),0,'No outer '+name+' toolbar');
    assert.equal(await page.getByText('explorer.html',{exact:true}).count(),0,'The exact authorized backing file is not repeated as a chip');assert.equal(await page.getByText('retained-notes.txt',{exact:true}).count(),1,'An unrelated attachment remains available');
    const height=()=>iframe.evaluate(node=>node.getBoundingClientRect().height);
    const naturalHeight=await height();
    await frame.evaluate(()=>{const tall=document.createElement('div');tall.id='intrinsic-height-probe';tall.style.height='1600px';tall.textContent='Long intrinsic visualization';document.body.append(tall);});
    await page.waitForFunction(()=>document.querySelector('iframe[title="Fruit Sales Explorer"]').getBoundingClientRect().height>1600);
    row.grownHeight=await height();assert(row.grownHeight>1200,'Long visualizations grow beyond the old cap');
    await frame.evaluate(()=>document.querySelector('#intrinsic-height-probe').remove());
    await page.waitForFunction(limit=>document.querySelector('iframe[title="Fruit Sales Explorer"]').getBoundingClientRect().height<limit,naturalHeight+5);
    row.shrunkHeight=await height();assert(Math.abs(row.shrunkHeight-naturalHeight)<5,'Final resize measurement shrinks to intrinsic content');
    await frame.evaluate(()=>{const wide=document.createElement('div');wide.id='horizontal-probe';wide.tabIndex=0;wide.style.cssText='overflow-x:auto;max-width:100%';wide.innerHTML='<div style="width:1800px;height:24px">Wide table equivalent</div>';document.body.append(wide);});
    await frame.locator('#horizontal-probe').focus();await page.keyboard.press('ArrowRight');await frame.waitForFunction(()=>document.querySelector('#horizontal-probe').scrollLeft>0);
    assert.equal(await frame.locator('#horizontal-probe').evaluate(node=>getComputedStyle(node).scrollbarWidth==='none'||getComputedStyle(node,'::-webkit-scrollbar').display==='none'),true,'Wide content scrolls by keyboard with hidden bars');
    await frame.evaluate(()=>document.querySelector('#horizontal-probe').remove());
    row.frameOverflow=await frame.evaluate(()=>({height:innerHeight,body:document.body.getBoundingClientRect().height,scroll:document.scrollingElement.scrollHeight,overflow:getComputedStyle(document.documentElement).overflowY}));
    assert(row.frameOverflow.scroll<=row.frameOverflow.height+1,'The Chat, rather than the frame, owns vertical scrolling');
    assert.equal(await iframe.getAttribute('src'),originalSrc);assert.equal(await frame.evaluate(()=>window.__panelInstance),marker,'Resizing preserves the mounted frame and interaction state');
    // The shared bridge updates presentation metadata without touching authored state.
    const nonce=new URL(originalSrc,origin).searchParams.get('visualizationNonce');
    const initialColors=await frame.evaluate(()=>Object.fromEntries(['bg','surface','text','muted','border','accent','on-accent','font-family','font-size'].map(key=>[key,getComputedStyle(document.documentElement).getPropertyValue('--ponderosa-'+key).trim()])));
    assert.equal(await frame.evaluate(()=>document.documentElement.style.colorScheme),mode);assert(!initialColors['font-family'].includes('var('),'Font metadata is resolved, never a self-referencing custom property');
    await page.evaluate(({nonce,mode,colors})=>document.querySelector('iframe[title="Fruit Sales Explorer"]').contentWindow.postMessage({type:'ponderosa:visualization-theme',version:1,nonce,mode,colors},'*'),{nonce,mode:mode==='light'?'dark':'light',colors:{...initialColors,accent:'#c45b91'}});
    await frame.waitForFunction(()=>getComputedStyle(document.documentElement).getPropertyValue('--ponderosa-accent').trim()==='#c45b91');assert.equal(await frame.evaluate(()=>window.__panelInstance),marker);
    await page.evaluate(({nonce,mode,colors})=>document.querySelector('iframe[title="Fruit Sales Explorer"]').contentWindow.postMessage({type:'ponderosa:visualization-theme',version:1,nonce,mode,colors},'*'),{nonce,mode,colors:initialColors});
    await page.evaluate(()=>{localStorage.setItem('ponderosa.text-size.v1','150');window.dispatchEvent(new Event('ponderosa:text-size'));});const hostTextSize=await page.evaluate(()=>getComputedStyle(document.documentElement).fontSize);if(surface!=='assistant')assert.equal(hostTextSize,'24px');await frame.waitForFunction(expected=>getComputedStyle(document.documentElement).getPropertyValue('--ponderosa-font-size').trim()===expected,hostTextSize);assert.equal(await frame.evaluate(()=>window.__panelInstance),marker);await page.evaluate(()=>{localStorage.setItem('ponderosa.text-size.v1','100');window.dispatchEvent(new Event('ponderosa:text-size'));});
    // A real workspace invalidation refreshes canonical message/metadata projections.
    f.ok(await f.api('PATCH',`${base}/conversations/${chat.id}`,{title:'Panels Refreshed'}));await page.waitForTimeout(500);assert.equal(await iframe.getAttribute('src'),originalSrc);assert.equal(await frame.evaluate(()=>window.__panelInstance),marker);assert.equal(await frame.getByLabel('Search Fruits').inputValue(),'gr');
    const second=page.locator('iframe[title="Independent Explorer"]');await reveal(page.locator('[data-ponderosa-rich="visualization"]').nth(1));await second.waitFor();const secondFrame=await(await second.elementHandle()).contentFrame();await secondFrame.getByLabel('Fruit Filter').waitFor();assert.equal(await secondFrame.getByLabel('Search Fruits').inputValue(),'','Panels have independent state');
    const otherNonce=new URL(await second.getAttribute('src'),origin).searchParams.get('visualizationNonce');
    await frame.evaluate(otherNonce=>parent.postMessage({type:'ponderosa:visualization',version:1,nonce:otherNonce,status:'error'},'*'),otherNonce);await page.waitForTimeout(50);assert.equal(await secondFrame.locator('#rows tr').count(),4,'One frame cannot affect another panel');
    securityProbe=true;row.isolation=await frame.evaluate(async external=>{
     const results={};for(const key of ['parent','cookie','storage'])try{if(key==='parent')void parent.document.body;if(key==='cookie')void document.cookie;if(key==='storage')void localStorage.getItem('private-parent-sentinel');results[key]=false;}catch{results[key]=true;}
     for(const [key,url]of [['external',external],['api','/api/workspace/preferences']])try{await fetch(url,{credentials:'include'});results[key]=false;}catch{results[key]=true;}
     results.popup=window.open(external)===null;try{top.location.href=external;results.top=false;}catch{results.top=true;}
     const image=new Image();image.src=external;document.body.append(image);const nested=document.createElement('iframe');nested.src=external;document.body.append(nested);return results;
    },external);assert(Object.values(row.isolation).every(Boolean),JSON.stringify(row.isolation));assert.equal(page.url(),origin+route);assert.equal(context.pages().length,1);assert.equal(outboundRequests,0);await page.waitForTimeout(50);securityProbe=false;
    const brokenPanel=page.locator('[data-ponderosa-rich="visualization"]').nth(2);await reveal(brokenPanel);await brokenPanel.getByText('This visualization is unavailable.',{exact:false}).waitFor();assert.equal(await brokenPanel.getByRole('button',{name:'Retry',exact:true}).count(),1);assert.equal(await brokenPanel.getByRole('link',{name:'Download',exact:true}).count(),0);
    const largePanel=page.locator('[data-ponderosa-rich="visualization"]').nth(3);await reveal(largePanel);await largePanel.getByText('This visualization is unavailable.',{exact:false}).waitFor();assert.equal(await largePanel.locator('iframe').count(),0,'Oversized previews never execute truncated HTML');
    assert.equal(row.reads.length,1,'Concurrent panels and canonical refresh share one immutable metadata read');assert(row.previewLoads<=3,'Only near-view healthy/broken frames load once; oversize never loads');row.coldPreviewLoads=row.previewLoads;
    if(width===1440&&mode==='light'&&surface==='chat'){
     // The sandbox and existing request-origin guard also fence navigations, not just fetch.
     await frame.evaluate(external=>{const form=document.createElement('form');form.method='POST';form.action=external;document.body.append(form);form.submit();navigator.sendBeacon(external,'blocked');try{const socket=new WebSocket(external.replace('http:','ws:'));socket.onerror=()=>{};}catch{}},external);
     await page.waitForTimeout(200);assert.equal(outboundRequests,0);
     await page.evaluate(nonce=>window.postMessage({type:'ponderosa:visualization',version:1,nonce,status:'error'},'*'),nonce);assert.equal(await panel.getByText('This visualization is unavailable.',{exact:false}).count(),0,'Parent/unknown Window messages are rejected');
     await frame.evaluate(nonce=>{for(let i=0;i<1000;i++)parent.postMessage({type:'ponderosa:visualization',version:1,nonce,status:'ready',height:500+i%200},'*');parent.postMessage({type:'ponderosa:visualization',version:1,nonce,status:'ready',height:777},'*');},nonce);
     await page.waitForFunction(()=>document.querySelector('iframe[title="Fruit Sales Explorer"]').getBoundingClientRect().height===777);assert.equal(await iframe.getAttribute('src'),originalSrc,'Coalescing retains the final update without replacing the frame');
     const navigationUrl=origin+base+'/workspace/preferences';
     for(const method of ['location','link','meta']){
      const current=await(await iframe.elementHandle()).contentFrame();const denied=page.waitForResponse(response=>response.url()===navigationUrl&&response.status()===403);
      await current.evaluate(({method,url})=>{if(method==='location')location.assign(url);else if(method==='link'){const link=document.createElement('a');link.href=url;document.body.append(link);link.click();}else{const meta=document.createElement('meta');meta.httpEquiv='refresh';meta.content='0;url='+url;document.head.append(meta);}},{method,url:navigationUrl});
      await denied;await panel.getByText('This visualization is unavailable.',{exact:false}).waitFor();assert.equal(page.url(),origin+route);assert.equal(outboundRequests,0);
      await panel.getByRole('button',{name:'Retry',exact:true}).focus();await page.keyboard.press('Enter');await reveal(panel);await iframe.waitFor();const recovered=await(await iframe.elementHandle()).contentFrame();await recovered.getByLabel('Fruit Filter').waitFor();await page.waitForFunction(()=>getComputedStyle(document.querySelector('iframe[title="Fruit Sales Explorer"]')).visibility==='visible');
     }
     const safe=await(await iframe.elementHandle()).contentFrame();await safe.evaluate(external=>location.assign(external),external);await page.waitForTimeout(250);assert.equal(outboundRequests,0,'The parent frame CSP also blocks external self-navigation');assert.equal(page.url(),origin+route);await panel.getByText('This visualization is unavailable.',{exact:false}).waitFor();await panel.getByRole('button',{name:'Retry',exact:true}).focus();await page.keyboard.press('Enter');await reveal(panel);await iframe.waitFor();await (await(await iframe.elementHandle()).contentFrame()).getByLabel('Fruit Filter').waitFor();row.navigationGuards=['location','link','meta','external'];
    }
    await reveal(panel);await page.screenshot({path:path.join(out,`${engine}-${width}-${mode}-${surface}.png`),animations:'disabled'});
    assert((await page.evaluate(()=>document.documentElement.scrollWidth))<=width+1);
    if(width===1440&&mode==='light'&&surface==='chat'){
     const other=await f.createChat('Other Conversation'),otherRoute=`/projects/${other.projectId}/chats/${other.id}`,started=Date.now();
     await page.evaluate(route=>{history.pushState(null,'',route);dispatchEvent(new PopStateEvent('popstate'));},otherRoute);
     await page.waitForFunction(()=>!document.querySelector('[data-ponderosa-rich="visualization"]')&&document.body.innerText.includes('Other Conversation'));row.switchMs=Date.now()-started;assert(row.switchMs<5000,'Switching away remains bounded and removes the previous owner frames');
     await page.goBack();for(let attempt=0;attempt<3;attempt++){await reveal(page.locator('[data-ponderosa-rich="visualization"]').first());await page.waitForTimeout(250);if(await iframe.count())break;}
     await iframe.waitFor();const reopened=await(await iframe.elementHandle()).contentFrame();await reopened.getByLabel('Fruit Filter').waitFor();assert.equal(await reopened.evaluate(()=>window.__panelInstance),undefined,'Navigation creates a fresh owner instance; old callbacks cannot revive the old panel');row.navigationRecovery=true;
    }
    assert.deepEqual(row.errors,[]);row.passed=true;console.log('PASS',engine,width,mode,surface);
   }catch(error){row.error=error.stack;row.fixtureRoot=f?.root;row.dom=await page?.locator('body').innerText();row.frames=await Promise.all((page?.frames()??[]).filter(frame=>frame.parentFrame()).map(frame=>frame.evaluate(()=>({url:location.href,text:document.body?.innerText.slice(-2000),scrollTop:document.scrollingElement?.scrollTop})).catch(error=>({error:String(error)}))));row.geometry=await page?.evaluate(()=>({iframes:[...document.querySelectorAll('iframe')].map(node=>({src:node.src,title:node.title,style:node.getAttribute('style')})),viewport:[innerWidth,innerHeight],panels:[...document.querySelectorAll('[data-ponderosa-rich="visualization"]')].map(node=>node.getBoundingClientRect().toJSON()),regions:[...document.querySelectorAll('.chat-scroll-region')].map(node=>({top:node.scrollTop,height:node.scrollHeight,viewport:node.clientHeight,rect:node.getBoundingClientRect().toJSON()}))}));await page?.screenshot({path:path.join(out,'FAIL-'+rows.length+'.png'),animations:'disabled'}).catch(()=>{});throw error;}
   finally{await context?.close();context=undefined;page=undefined;await f?.dispose(false);f=undefined;await save();}
  }
  await browser.close();browser=undefined;
 }
}finally{await context?.close();await browser?.close();await f?.dispose(false);await new Promise(resolve=>receiver.close(resolve));await save();console.log(out);}
