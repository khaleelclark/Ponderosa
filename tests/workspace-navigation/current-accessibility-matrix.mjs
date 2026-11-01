import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {spawn,execFileSync} from 'node:child_process';import {once} from 'node:events';import {mkdir,writeFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
import {fixture} from '../shared/fixture.mjs';import {serveFixture} from '../shared/serve-ui-fixture.mjs';
const require=createRequire(new URL('../../apps/server/package.json',import.meta.url)),{chromium}=require('playwright-core');
const out=process.env.PONDEROSA_A11Y_EVIDENCE;assert(out&&process.env.AXE_CORE_PATH);await mkdir(out,{recursive:true});
const f=await fixture();let browser,web,xv;const rows=[];
async function tabTo(page,locator){for(let n=0;n<200;n++){if(await locator.evaluate(e=>e===document.activeElement))return n;await page.keyboard.press('Tab');}throw Error('Tab target unreachable');}
try{
 const core=await f.createChat('Keyboard Core'),branch=f.ok(await f.api('POST','/api/branches',{name:'Keyboard Branch',idempotencyKey:randomUUID()})),chat=f.ok(await f.api('POST',`/api/branches/${branch.id}/chats`,{label:'Keyboard Branch Chat',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
 await f.createIdleAgent(core,'Core reader');const agent=f.ok(await f.api('POST',`/api/branches/engine/projects/${chat.projectId}/agents`,{title:'Output reader',engine:'codex',conversationId:chat.id,idempotencyKey:randomUUID()}));
 const output=f.ok(await f.api('PUT',`/api/branches/output-apps/${agent.id}`,{enabled:true})).app,assistant=f.ok(await f.api('POST','/api/branches/assistant',{initialize:true}));
 const routes={core:`/projects/${core.projectId}/chats/${core.id}`,branches:`/branches?branch=${branch.id}&tab=chats&chat=${chat.id}`,assistant:'/assistant',output:output.url};
 web=await serveFixture(f);xv=spawn('Xvfb',['-displayfd','1','-screen','0','1600x1100x24','-nolisten','tcp'],{stdio:['ignore','pipe','inherit']});const display=':'+String((await once(xv.stdout,'data'))[0]).trim(),env={...process.env,DISPLAY:display};
 browser=await chromium.launch({executablePath:'/opt/google/chrome/chrome',headless:false,env,args:['--no-sandbox','--window-size=1280,1000']});
 for(const [product,route] of Object.entries(routes))for(const theme of ['light','dark'])for(const zoom of (process.env.PONDEROSA_A11Y_ZOOMS??'1,2,4').split(',').map(Number)){
  const row={product,theme,zoom,status:'started',errors:[],requests:[]};rows.push(row);const context=await browser.newContext({viewport:null});const page=await context.newPage();page.setDefaultTimeout(10000);
  try{
   page.on('pageerror',e=>row.errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/messages'))row.requests.push({url:r.url(),body:r.postData()});});
   await page.route('**/*',r=>['localhost','127.0.0.1'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());await page.addInitScript(theme=>localStorage.setItem('ponderosa-color-mode',theme),theme);
   await page.goto(web.origin+route);const editor=page.getByLabel('Message',{exact:true});await editor.waitFor();await page.bringToFront();
   execFileSync('xdotool',['key','--clearmodifiers','ctrl+0',...Array(zoom===4?8:zoom===2?5:0).fill('ctrl+plus')],{env});await page.waitForFunction(z=>devicePixelRatio===z,zoom);
   row.geometry=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,dpr:devicePixelRatio,font:getComputedStyle(document.querySelector('[aria-label="Message"]')).fontSize,scheme:document.documentElement.style.colorScheme}));assert.equal(row.geometry.scheme,theme);assert.ok(row.geometry.scrollWidth<=row.geometry.width);
   row.tabsToEditor=await tabTo(page,editor);await page.keyboard.press('Control+A');await page.keyboard.press('Backspace');
   const cdp=await context.newCDPSession(page);await cdp.send('Input.imeSetComposition',{text:'入力',selectionStart:2,selectionEnd:2});const before=row.requests.length;
   // A dispatched composing key checks the component guard, not an installed OS IME.
   await editor.evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,keyCode:229,bubbles:true,cancelable:true})));assert.equal(row.requests.length,before);row.ime='CDP composition + dispatched composing Enter; no OS IME claim';await cdp.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});
   await page.keyboard.press('Control+A');await page.keyboard.press('Backspace');const text=`matrix-${product}-${theme}-${zoom}`;await page.keyboard.type(text);await page.keyboard.press('Shift+Enter');await page.keyboard.type('tail');
   const send=page.getByRole('button',{name:'Send message',exact:true});row.tabsToSend=await tabTo(page,send);const sent=page.waitForResponse(r=>r.request().method()==='POST'&&r.request().postData()?.includes(text));await page.keyboard.press('Enter');row.sendStatus=(await sent).status();assert.equal(row.sendStatus,['assistant','output'].includes(product)?202:200);
   await page.addScriptTag({path:process.env.AXE_CORE_PATH});row.scan=await page.evaluate(()=>window.axe.run());await page.screenshot({path:`${out}/${product}-${theme}-${zoom}.png`});
   assert.deepEqual(row.scan.violations.filter(v=>v.impact==='critical').map(v=>v.id),[]);if(process.env.PONDEROSA_ASSERT_LANDMARK_REPAIR==='1'){assert.deepEqual(row.scan.violations.filter(v=>['landmark-one-main','landmark-unique','region'].includes(v.id)).map(v=>v.id),[]);assert.equal(await page.getByRole('main').count(),1);}assert.deepEqual(row.errors,[]);row.status='pass';
  }catch(error){row.status='fail';row.error=error.stack;await page.screenshot({path:`${out}/${product}-${theme}-${zoom}-failure.png`}).catch(()=>{});throw error;}
  finally{await context.close();await writeFile(out+'/results.json',JSON.stringify({browser:await browser.version(),rows},null,2));}
 }
 console.log(JSON.stringify({pass:true,cells:rows.length}));
}finally{await browser?.close();await web?.close();await f.dispose(false);if(xv){const exited=once(xv,'exit');xv.kill('SIGTERM');await exited;}}
