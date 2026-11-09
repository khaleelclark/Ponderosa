import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture} from '../shared/fixture.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const output='/tmp/p2-chat-composer-captures-20261109';await mkdir(output,{recursive:true});
const f=await fixture({webDist:path.join(root,'apps/web/dist')});let browser;
try{
 const core=await f.createChat('Core route scope');await f.createIdleAgent(core,'Core Agent');
 const assistant=f.ok(await f.api('POST','/api/branches/assistant',{initialize:true})).app;
 const origin=await f.listen();browser=await chromium.launch({executablePath:'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
 const rows=[];
 for(const phone of [false,true]){
  const label=phone?'phone':'desktop';const context=await browser.newContext({viewport:phone?{width:390,height:844}:{width:1365,height:900},isMobile:phone,hasTouch:phone,serviceWorkers:'block'});const page=await context.newPage();page.setDefaultTimeout(20000);
  if(!phone)await page.addInitScript(()=>{
   window.__speechRecords=[];
   class SyntheticRecognition{
    constructor(){this.started=false;this.aborted=false;this.stopped=false;window.__speechRecords.push(this);}
    start(){this.started=true;this.onstart?.();}
    stop(){this.stopped=true;this.onend?.();}
    abort(){this.aborted=true;this.onend?.();}
   }
   window.SpeechRecognition=SyntheticRecognition;
  });
  const requests=[],errors=[];page.on('request',request=>{const p=new URL(request.url()).pathname;if(p.startsWith('/api/'))requests.push(p);});page.on('pageerror',error=>errors.push(error.message));
  if(!phone){await page.goto(origin+`/projects/${core.projectId}/chats/${core.id}`);await page.getByLabel('Message',{exact:true}).waitFor();await page.getByRole('link',{name:'Assistant',exact:true}).click();}
  else await page.goto(origin+'/assistant');
  await page.getByRole('heading',{name:'Assistant',exact:true}).waitFor();await page.getByLabel('Message',{exact:true}).waitFor();
  assert.equal(new URL(page.url()).pathname,'/assistant');assert.equal(await page.locator('iframe').count(),0);
  assert.equal(await page.locator('aside[aria-label="Branches navigation"]').count(),0);
  assert.equal(await page.evaluate(()=>window.__ponderosaAssistantMount?.productScope()),'branches');
  if(phone)await page.getByRole('button',{name:'Open workspace navigation'}).click();
  const nav=page.locator('aside[aria-label="Workspace navigation"]:visible');await nav.waitFor();
  await nav.getByRole('link',{name:'Assistant',exact:true}).waitFor();await nav.getByRole('button',{name:'Chats',exact:true}).waitFor();
  if(phone)await page.waitForFunction(()=>{const node=Array.from(document.querySelectorAll('aside[aria-label="Workspace navigation"]')).find(el=>el.getClientRects().length);const rect=node?.getBoundingClientRect();return rect&&rect.left>=-.5&&rect.right<=innerWidth+.5;});
  await page.screenshot({path:path.join(output,label+'-assistant-nav.png')});
  if(phone){await page.getByRole('button',{name:'Close workspace navigation'}).click();
   await page.waitForFunction(()=>Array.from(document.querySelectorAll('.MuiBackdrop-root')).every(node=>{const style=getComputedStyle(node);return style.opacity==='0'||style.visibility==='hidden'||style.pointerEvents==='none';})&&Array.from(document.querySelectorAll('.MuiDrawer-paper')).every(node=>node.getBoundingClientRect().right<=.5||getComputedStyle(node).visibility==='hidden'));
  }
  await page.screenshot({path:path.join(output,label+'-assistant.png')});
  if(!phone){
   await page.getByRole('button',{name:'Call',exact:true}).click();
   await page.getByRole('button',{name:'End call',exact:true}).waitFor();
   await page.waitForFunction(()=>window.__speechRecords.some(item=>item.started));
   await page.goBack();await page.getByLabel('Message',{exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>window.__speechRecords[0]?.aborted||window.__speechRecords[0]?.stopped),true,'Assistant Call capture ends before Core Chat activates');
   await page.getByRole('button',{name:'Voice options'}).click();
   await page.getByRole('menuitem',{name:/Dictation/}).click();
   await page.waitForFunction(()=>window.__speechRecords.filter(item=>item.started).length>=2);
   assert.equal(await page.evaluate(()=>window.__speechRecords[0]?.onresult),null,'Assistant recognizer callbacks are detached');
   await page.goForward();await page.getByRole('heading',{name:'Assistant',exact:true}).waitFor();await page.getByLabel('Message',{exact:true}).waitFor();
   await page.evaluate(()=>sessionStorage.setItem('ponderosa.new-chat-attempts.v2',JSON.stringify([{key:'synthetic-recovery',input:{label:'Earlier ordinary Chat',defaultEngine:'codex'}}])));
   await page.reload();await page.getByLabel('Message',{exact:true}).waitFor();
   await page.getByRole('button',{name:'Recover earlier Chat'}).waitFor();
   await page.getByRole('button',{name:'Recover earlier Chat'}).click();
   await page.getByRole('dialog',{name:'Recover earlier Chat'}).waitFor();
   await page.getByRole('dialog',{name:'Recover earlier Chat'}).getByRole('button',{name:'Close'}).click();
   await page.route('**/api/workspace/stream*',route=>route.abort('failed'));
   await page.reload();await page.getByLabel('Message',{exact:true}).waitFor();
   await page.getByRole('button',{name:'Updates delayed'}).waitFor();
   await page.getByRole('button',{name:'Updates delayed'}).click();
   await page.getByRole('dialog',{name:'Workspace update details'}).waitFor();
   await page.screenshot({path:path.join(output,'desktop-core-outage-assistant.png')});
   await page.unroute('**/api/workspace/stream*');
   await page.evaluate(()=>sessionStorage.removeItem('ponderosa.new-chat-attempts.v2'));
  }
  assert(requests.some(p=>p==='/api/projects'),'Core requests present');
  assert(requests.some(p=>p.startsWith('/api/branches/engine/')),'Assistant engine requests present');
  assert.deepEqual(errors,[]);
  rows.push({label,requests,errors,assistantId:assistant.agentId});await context.close();
 }
 await writeFile(path.join(output,'result.json'),JSON.stringify({pass:true,rows},null,2));console.log(JSON.stringify({pass:true,output,rows}));
}finally{await browser?.close();await f.dispose();}
