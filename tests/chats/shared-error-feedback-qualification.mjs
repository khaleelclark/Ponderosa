// Built product against disposable canonical data and inert providers only.
import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {fixture,until}=await import('../shared/fixture.mjs');
const {chromium,webkit,devices}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=process.env.PONDEROSA_FEEDBACK_EVIDENCE??await mkdtemp(path.join(tmpdir(),'ponderosa-shared-feedback-'));
await mkdir(out,{recursive:true});const rows=[];let browser,context,f;
const save=()=>writeFile(path.join(out,'results.json'),JSON.stringify({rows,liveServiceInterrupted:false,realDevice:false},null,2)+'\n');
try{
 for(const engine of (process.env.PONDEROSA_FEEDBACK_BROWSERS??'chromium,webkit').split(',')){
  browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='webkit'?{executablePath:process.env.PONDEROSA_WEBKIT_PATH}:{executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']})});
  for(const width of (process.env.PONDEROSA_FEEDBACK_SIZES??'1440,390').split(',').map(Number))for(const mode of (process.env.PONDEROSA_FEEDBACK_MODES??'light,dark').split(','))for(const view of (process.env.PONDEROSA_FEEDBACK_VIEWS??'chat,assistant').split(',')){
   const name=`${engine}-${width}-${mode}-${view}`,row={name,passed:false,errors:[],checks:[]};rows.push(row);
   f=await fixture({webDist:process.env.PONDEROSA_FEEDBACK_WEB_DIST??path.join(root,'apps/web/dist')});let target,agent;
   if(view==='assistant'){f.ok(await f.api('POST','/api/branches/assistant',{initialize:true}));target='/assistant';}
   else{const chat=await f.createChat('Feedback QA');agent=await f.createIdleAgent(chat,'Feedback Agent');target=`/projects/${chat.projectId}/chats/${chat.id}`;}
   const origin=await f.listen();assert.equal(new URL(origin).hostname,'127.0.0.1');let failUpload=true,failSend=true;const uploads=[],sends=[];
   context=await browser.newContext({...(width===390&&engine==='webkit'?devices['iPhone 13']:{viewport:{width,height:width===390?844:962},isMobile:width===390,hasTouch:width===390}),serviceWorkers:'block'});
   await context.addInitScript(mode=>localStorage.setItem('ponderosa-color-mode',mode),mode);
   await context.route('**/*',route=>{
    const request=route.request(),url=new URL(request.url());assert.equal(url.origin,origin,'Only owned loopback traffic');
    if(request.method()==='POST'&&url.pathname.endsWith('/draft-attachments')){uploads.push({url:url.pathname,body:request.postDataBuffer()});if(failUpload)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Controlled upload refusal '+ 'long diagnostic λ😀 '.repeat(120)})});}
    if(request.method()==='POST'&&/\/(messages|direct-messages)$/.test(url.pathname)){sends.push({url:url.pathname,body:request.postDataJSON()});if(failSend)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Controlled lost message acknowledgement'})});}
    return route.continue();
   });
   const page=await context.newPage();page.setDefaultTimeout(18000);page.on('pageerror',error=>row.errors.push(error.message));
   try{
    await page.goto(origin+target,{waitUntil:'domcontentloaded'});const editor=page.getByRole('textbox',{name:'Message',exact:true});await editor.waitFor();await page.waitForTimeout(1000);
    const text=(agent?'#'+agent.handle+' ':'')+'Original retained exact draft λ😀';await editor.fill(text);await page.waitForTimeout(500);
    const payload={name:'retained.txt',mimeType:'text/plain',buffer:Buffer.from('Original retained exact File bytes λ😀')};
    const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Add Attachment Or Capability',exact:true}).click();await page.getByRole('menuitem',{name:/^Files/}).click();await(await chooser).setFiles(payload);
    const snack=page.locator('.MuiSnackbar-root');await snack.filter({hasText:'Attachment Upload Failed'}).waitFor();assert.equal(await snack.count(),1);assert.equal(await page.getByRole('alert').count(),1,'Only the shared snackbar announces the action failure');
    const composer=page.locator('.ponderosa-composer');const failedHeight=(await composer.boundingBox()).height;await snack.locator('summary').click();await snack.getByText(/Controlled upload refusal/).waitFor();
    assert((await snack.locator('pre').boundingBox()).height<=181,'Long diagnostic is bounded');assert((await snack.boundingBox()).x>=0);await page.screenshot({animations:'disabled',path:path.join(out,name+'-upload-error.png')});
    await snack.getByRole('button',{name:'Close',exact:true}).click();await snack.waitFor({state:'hidden'});assert.equal((await composer.boundingBox()).height,failedHeight,'Feedback Close never changes composer height');assert((await editor.innerText()).includes('Original retained exact draft'));
    const failed=page.locator('details').filter({has:page.locator('summary',{hasText:'Failed'})});await failed.locator('summary').click();assert((await failed.innerText()).includes('Controlled upload refusal'));await failed.locator('summary').click();
    await page.waitForTimeout(250);assert.equal(uploads.length,1,'Close does not retry upload');failUpload=false;const uploaded=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/draft-attachments')&&response.ok());await page.getByRole('button',{name:'Retry',exact:true}).click();const asset=await(await uploaded).json();await page.getByText('Uploaded',{exact:true}).waitFor();assert.equal(uploads.length,2);
    assert.equal(uploads[0].url,uploads[1].url);for(const upload of uploads)if(upload.body)assert(upload.body.includes(payload.buffer),'Available native request bodies retain original file bytes');const retained=await fetch(origin+asset.downloadUrl);assert(retained.ok);assert.deepEqual(Buffer.from(await retained.arrayBuffer()),payload.buffer,'Canonical staged asset retains exact original File bytes, including WebKit where native request bodies are unavailable');assert.equal(await snack.count(),0,'Confirmed retry removes obsolete upload feedback');
    row.checks.push('Native file failure: one snackbar, bounded Details, dismissal preserves draft/File, explicit retry retains bytes and retires feedback');
    const beforeSend=(await composer.boundingBox()).height;await page.getByRole('button',{name:'Send Message',exact:true}).click();await snack.filter({hasText:'Message Needs Review'}).waitFor();assert.equal(await page.getByRole('alert').count(),1);assert.equal(sends.length,1);
    const recovery=page.locator('summary',{hasText:'Message Details'});await recovery.waitFor();const capturedBubble=page.getByRole('article',{name:'Captured Message',exact:true});await capturedBubble.waitFor();assert((await capturedBubble.innerText()).includes('Original retained exact draft')&&(await capturedBubble.innerText()).includes('retained.txt'),'UI012 keeps the exact text and attachment on one conversation bubble');assert.equal(await page.getByRole('article',{name:'Captured Message',exact:true}).count(),1);await page.screenshot({animations:'disabled',path:path.join(out,name+'-send-error.png')});await page.keyboard.press('Escape');await snack.waitFor({state:'hidden'});await recovery.click();await page.getByText(/Controlled lost message acknowledgement/).waitFor();
    await page.evaluate(()=>{window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));});await page.waitForTimeout(300);assert.equal(sends.length,1,'Dismiss/focus/reconnect never resend');
    failSend=false;
    const acceptedResponse=page.waitForResponse(response=>response.request().method()==='POST'&&/\/(messages|direct-messages)$/.test(new URL(response.url()).pathname)&&response.ok());
    await page.getByRole('button',{name:'Retry',exact:true}).click();await until(()=>sends.length===2,'Explicit captured retry reaches the original route');assert.deepEqual(sends[1],sends[0],'Retry retains captured request owner, idempotency and content');
    const receipt=await(await acceptedResponse).json(),communicationId=receipt.communicationEventId??receipt.message?.communicationEventId;assert.equal(typeof communicationId,'string','An observed server receipt establishes acceptance');
    const canonical=f.ok(await f.api('GET',sends[1].url.replace(/\/(messages|direct-messages)$/,'')));assert.equal(canonical.messages.filter(message=>message.communicationEventId===communicationId).length,1,'Exactly one canonical message owns the accepted operation');
    await page.waitForFunction(()=>!Object.keys(localStorage).some(key=>key.startsWith('ponderosa.submission.v1.')));
    await capturedBubble.waitFor({state:'hidden'});await recovery.waitFor({state:'hidden'});await page.getByRole('button',{name:'Finish Cleanup',exact:true}).waitFor({state:'hidden'});assert.equal(await snack.count(),0);
    assert.equal(await page.getByRole('article').filter({hasText:'Original retained exact draft'}).count(),1,'Settled conversation adopts one message without a second pending bubble');
    row.acceptance={communicationId,canonicalCount:1,recoveryRetired:true,pendingBubbleRemoved:true};
    assert((await composer.boundingBox()).height<=beforeSend+1,'Confirmed send removes draft attachments without growing composer');row.checks.push('Lost send acknowledgement retains exact captured recovery; explicit retry settles one observed canonical message and retires its original recovery record');
    await page.screenshot({animations:'disabled',path:path.join(out,name+'-recovered.png')});assert.deepEqual(row.errors,[]);row.passed=true;console.log('PASS '+name);
   }catch(error){row.error=error.stack??String(error);row.dom=(await page.locator('body').innerText()).slice(-3000);await page.screenshot({animations:'disabled',path:path.join(out,name+'-FAIL.png')}).catch(()=>{});throw error;}
   finally{await context.close();context=undefined;await save();await f.dispose(false);f=undefined;}
  }
  await browser.close();browser=undefined;
 }
}finally{await context?.close();await browser?.close();await f?.dispose(false);await save();console.log(out);}
