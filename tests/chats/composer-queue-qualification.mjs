// Existing real API + built web, owned loopback data and inert providers only.
// Never points at DEV/production; no harness account, real device or audio.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture,until} from '../shared/fixture.mjs';
const {chromium,webkit,devices}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const root=fileURLToPath(new URL('../../',import.meta.url)),out=process.env.PONDEROSA_QUEUE_QUALIFICATION_DIR??await mkdtemp(path.join(tmpdir(),'ponderosa-queue-keyboard-'));
await mkdir(out,{recursive:true});
const results=[];let browser,context,f;
const save=()=>writeFile(path.join(out,'results.json'),JSON.stringify({results,realDeviceVerified:false},null,2)+'\n');
try{
 for(const engine of ['chromium','webkit']){
  browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='webkit'?{executablePath:process.env.PONDEROSA_WEBKIT_PATH}:{executablePath:process.env.PONDEROSA_CHROME_PATH??'/usr/bin/google-chrome',args:['--no-sandbox']})});
  for(const phone of [false,true])for(const surface of ['shared','agent']){
   const cell={engine,phone,surface,passed:false,pageErrors:0,checks:[]};results.push(cell);
   f=await fixture({webDist:path.join(root,'apps/web/dist')});
   const chat=await f.createChat('Synthetic shortcut Chat'),agent=await f.createIdleAgent(chat,'Synthetic Queue Agent');await f.hold(agent.id);
   const origin=await f.listen();assert.equal(new URL(origin).hostname,'127.0.0.1');
   context=await browser.newContext({...(phone?(engine==='webkit'?devices['iPhone 13']:{viewport:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36'}):{viewport:{width:1440,height:962}}),serviceWorkers:'block',acceptDownloads:false});
   const requests=[];let rejectNext=false;
   await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());assert.equal(url.origin,origin,'Owned fixture traffic only');
    let body;try{body=request.postDataJSON();}catch{}
    if(request.method()==='POST'&&typeof body?.text==='string'&&/\/(messages|direct-messages)$/.test(url.pathname)){
     requests.push(body);if(rejectNext){rejectNext=false;return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Controlled queue rejection'})});}
    }
    return route.continue();
   });
   const page=await context.newPage();page.setDefaultTimeout(15_000);page.on('pageerror',()=>cell.pageErrors++);
   const route=surface==='agent'?`/projects/${chat.projectId}/agents/${agent.id}?view=chat`:`/projects/${chat.projectId}/chats/${chat.id}`;
   await page.goto(origin+route,{waitUntil:'domcontentloaded'});const editor=page.getByRole('textbox',{name:'Message',exact:true});await editor.waitFor();
   const type=async text=>{await editor.fill((surface==='shared'?'#'+agent.handle+' ':'')+text);await editor.focus();const action=page.getByRole('button',{name:'Queue message',exact:true});await action.waitFor();await until(async()=>!(await action.isDisabled()),'eligible typed draft');};
   const queued=()=>f.api('GET',`/api/agents/${agent.id}/queued-messages`).then(f.ok);
   const marker=`queue-${engine}-${phone}-${surface} λ😀`;
   await type(marker);const queueButton=page.getByRole('button',{name:'Queue message',exact:true});await queueButton.waitFor();await until(async()=>!(await queueButton.isDisabled()),'eligible busy queue');
   if(!phone){await queueButton.hover();await page.getByRole('tooltip').filter({hasText:'Ctrl+Enter'}).waitFor();await editor.focus();}
   const uploaded=page.waitForResponse(response=>response.request().method()==='POST'&&/\/draft-attachments$/.test(new URL(response.url()).pathname)&&response.ok());
   const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Add attachment or capability'}).click();await page.getByRole('menuitem',{name:/^Files/}).click();await (await chooser).setFiles({name:'queue-native.txt',mimeType:'text/plain',buffer:Buffer.from('Exact synthetic queued attachment')});
   const stagedAttachment=await (await uploaded).json();assert.equal(stagedAttachment.name,'queue-native.txt');
   await page.getByRole('button',{name:'Remove queue-native.txt'}).waitFor();await until(async()=>!(await queueButton.isDisabled()),'uploaded queue attachment');await editor.focus();
   const before=requests.length,steers=f.steers.length,turns=f.turns.length;
   await page.keyboard.press('Control+Enter');
   const rows=await until(async()=>{const rows=await queued();return rows.some(row=>row.text.includes(marker))?rows:false;},'canonical queued message');
   assert.equal(requests.length,before+1,'one physical shortcut submits once');assert.equal(requests.at(-1).activeRunDelivery,'queue','existing queue submission policy');
   const message=(await f.detail(agent.id)).messages.find(message=>message.text.includes(marker));
   assert.equal(message?.attachments?.length,1,'canonical queued Communication retains one attachment');
   const exactAttachment=message.attachments[0];assert.equal(exactAttachment.name,stagedAttachment.name);
   if(surface==='shared')assert.deepEqual(requests.at(-1).recipients[0].attachmentIds,[exactAttachment.id]);
   else assert.deepEqual(requests.at(-1).draftAttachmentIds,[stagedAttachment.id],'direct queue uses existing server-side draft materialization');
   const attachment=await fetch(origin+exactAttachment.downloadUrl);assert(attachment.ok);assert.equal(await attachment.text(),'Exact synthetic queued attachment','canonical attachment retains exact uploaded bytes');
   const row=rows.find(row=>row.text.includes(marker));assert.equal(row.targetAgentId,agent.id);assert(!row.text.includes('\n'),'Ctrl+Enter inserts no newline');
   await page.locator('[aria-label="Queued messages"]').filter({hasText:marker}).waitFor();assert.equal(f.steers.length,steers);assert.equal(f.turns.length,turns,'busy recipient does not receive an extra provider turn');
   cell.checks.push('trusted Ctrl+Enter once, busy exact recipient/attachment, canonical queue UI, no steer');
   await type('soft-keyboard check');const count=requests.length;await page.keyboard.press('Enter');
   await page.waitForTimeout(200);assert.equal(requests.length,count+(phone?0:1),'desktop Enter sends; phone Return remains newline');
   if(phone){assert((await editor.innerText()).endsWith('\n'));cell.checks.push('mobile Enter remains newline with physical key injection');}else cell.checks.push('desktop Enter sends once');
   await type('shift newline');const shiftCount=requests.length;await page.keyboard.press('Shift+Enter');
   assert.equal(requests.length,shiftCount,'Shift+Enter never submits');assert((await editor.innerText()).endsWith('\n'),'native Shift+Enter retains newline');cell.checks.push('trusted Shift+Enter newline');
   // A failed durable enqueue retains its exact recoverable draft/operation;
   // the active editor and captured-intent tray keep their existing semantics.
   const failed='recoverable-queue-'+marker;await type(failed);rejectNext=true;await page.keyboard.press('Control+Enter');
   const rejectedRow=page.locator('[data-queue-row]').filter({hasText:failed});
   await rejectedRow.getByText('Failed',{exact:true}).waitFor();
   await rejectedRow.getByRole('button',{name:'Retry',exact:true}).waitFor();
   const captured=await page.evaluate(marker=>Object.keys(localStorage).filter(key=>key.startsWith('ponderosa.submission.v1.')).map(key=>{try{return JSON.parse(localStorage.getItem(key));}catch{return null;}}).find(item=>item?.action==='queue'&&item.text?.includes(marker)),failed);
   assert(captured?.error==='Controlled queue rejection'&&captured.text.includes(failed)&&captured.status==='failed','failed enqueue keeps recoverable draft bytes and operation identity');
   assert(!(await queued()).some(row=>row.text.includes(failed)),'rejected enqueue did not enter canonical queue');cell.checks.push('failed enqueue retains recoverable draft through existing submission recovery');
   const retryCount=requests.length;await rejectedRow.getByRole('button',{name:'Retry',exact:true}).click();
   await until(async()=>(await queued()).some(row=>row.text.includes(failed)),'existing captured-operation retry queues exact draft');
   assert.equal(requests.length,retryCount+1);assert.equal(requests.at(-1).idempotencyKey,captured.pending.idempotencyKey);assert.equal(requests.at(-1).activeRunDelivery,'queue');cell.checks.push('existing Retry preserves queue action and idempotency key');
   assert.equal(cell.pageErrors,0);cell.passed=true;await context.close();context=undefined;await f.dispose(false);f=undefined;await save();console.log(`PASS ${engine} ${phone?'phone keyboard emulation':'desktop'} ${surface}`);
  }
  await browser.close();browser=undefined;
 }
 assert.equal(results.length,8);assert(results.every(cell=>cell.passed));await save();console.log('PASS 8 native keyboard/queue cases; physical mobile hardware remains unverified');
}finally{if(context)await context.close();if(browser)await browser.close();if(f)await f.dispose(false);await save();}
