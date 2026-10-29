// Built UI + real loopback API + owned inert providers; no subscription inference.
import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture} from '../shared/fixture.mjs';
const require=createRequire(new URL('../../apps/server/package.json',import.meta.url));
const {chromium}=require('playwright-core');
const root=fileURLToPath(new URL('../../',import.meta.url)),web=path.join(root,'apps/web/dist');
const out=process.env.PONDEROSA_OUTPUT_QUALIFICATION_DIR??'/tmp/ponderosa-output-app-ui';await mkdir(out,{recursive:true});
let browser,server;const f=await fixture();const errors=[],requests=[],fileClicks=[];
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
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',error=>errors.push(error.message));
 await Promise.all([page.waitForResponse(response=>response.url().endsWith('/api/branches/assistant')&&response.request().method()==='POST'&&response.status()===200),page.goto(origin+'/home')]);
 assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).enabled,true,'fresh normal workspace initializes Assistant automatically');
 await page.goto(origin+'/assistant');
 await page.getByRole('button',{name:'Settings',exact:true}).first().waitFor();
 await page.getByRole('textbox').first().waitFor({timeout:20000});
 const initial=f.ok(await f.api('GET','/api/branches/assistant'));
 const {conversation}=f.ok(await f.api('GET',`/api/branches/engine/conversations/${initial.app.chatId}`));
 await writeFile(path.join(conversation.workingDirectory,'output-report.md'),'# OUTPUT_FILE_CONTENT\n\n[Related report](related.md#details)\n');
 await writeFile(path.join(conversation.workingDirectory,'related.md'),'# RELATED_FILE_CONTENT\n');
 f.plans.set(initial.app.agentId,[{run:async session=>assert.equal((await session.tool('ponderosa_message',{text:'OUTPUT_UI_REPLY\n\n[Working report](output-report.md)'})).success,true)}]);
 await page.locator('[contenteditable="true"]').first().fill('Hello from the output app UI');
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 await page.getByText('OUTPUT_UI_REPLY',{exact:true}).waitFor({timeout:20000});
 // Click the actual authored file link and inspect the separate, fresh app tab.
 for(const entry of ['/assistant',initial.app.url]){
  await page.goto(origin+entry);
  const link=page.getByRole('link',{name:'Working report',exact:true});await link.waitFor();
  assert.equal(await link.getAttribute('target'),'_blank');
  const href=await link.getAttribute('href'),url=new URL(href,origin),query=url.searchParams;
  assert.equal(url.pathname,'/branches');assert.equal(query.get('branch'),initial.app.branchId);assert.equal(query.get('chat'),initial.app.chatId);
  const nested=new URL(query.get('workspace'),origin);assert.equal(nested.searchParams.get('agentId'),initial.app.agentId);assert.equal(nested.searchParams.get('path'),'output-report.md');
  const popupPromise=page.waitForEvent('popup');await link.click();const viewer=await popupPromise;
  viewer.on('pageerror',error=>errors.push(error.message));await viewer.waitForLoadState();
  await viewer.getByRole('heading',{name:'OUTPUT_FILE_CONTENT',exact:true}).waitFor({timeout:20000});
  assert.equal(new URL(viewer.url()).pathname,'/branches');
  const related=viewer.getByRole('link',{name:'Related report',exact:true});await related.waitFor();
  const relatedHref=await related.getAttribute('href'),relatedQuery=new URL(relatedHref,origin).searchParams;
  assert.equal(relatedQuery.get('branch'),initial.app.branchId);assert.equal(relatedQuery.get('chat'),initial.app.chatId);
  assert.equal(new URL(relatedQuery.get('workspace'),origin).searchParams.get('agentId'),initial.app.agentId);
  fileClicks.push({entry,href,openedUrl:viewer.url(),renderedContent:'OUTPUT_FILE_CONTENT',relatedHref});
  await viewer.screenshot({path:path.join(out,entry==='/assistant'?'assistant-file.png':'output-file.png'),fullPage:true});await viewer.close();
 }
 await page.goto(origin+'/assistant');await page.getByRole('textbox').first().waitFor();
 await page.screenshot({path:path.join(out,'assistant-desktop.png'),fullPage:true});
 await page.getByRole('button',{name:'Settings',exact:true}).first().click();
 await page.getByLabel('Check every (minutes)').fill('20');await Promise.all([page.waitForResponse(response=>response.url().endsWith('/schedule')&&response.status()===200),page.getByRole('button',{name:'Save schedule',exact:true}).click()]);
 await Promise.all([page.waitForResponse(response=>response.request().method()==='PATCH'&&response.url().includes('/agents/')&&response.status()===200),page.getByRole('button',{name:'Save model',exact:true}).click()]);
 await page.screenshot({path:path.join(out,'assistant-settings.png'),fullPage:true});
 await page.keyboard.press('Escape');
 const status=f.ok(await f.api('GET','/api/branches/assistant'));assert.equal(status.app.everyMs,1200000);
 await page.goto(origin+status.app.url);await page.getByRole('textbox').first().waitFor();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'output-phone.png'),fullPage:true});
 assert.deepEqual(errors,[]);assert.deepEqual(requests.filter(item=>item.status>=400),[]);assert.ok(requests.some(item=>item.path.includes('/agents/')&&item.status===200));
 await writeFile(path.join(out,'result.json'),JSON.stringify({checksPassed:true,freshWorkspaceInitialization:true,app:status.app,errors,requests,fileClicks,screenshots:['assistant-desktop.png','assistant-settings.png','output-phone.png','assistant-file.png','output-file.png'],limit:'Controlled provider, not real phone audio, complete usability or blind judging.'},null,2));
 console.log(JSON.stringify({checksPassed:true,out,requestCount:requests.length}));
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await f.dispose();}
