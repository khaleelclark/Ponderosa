// Disposable cold-phone/first-swipe/state check; not performance qualification.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {fixture} from '../shared/fixture.mjs';
import {serveFixture} from '../shared/serve-ui-fixture.mjs';
const out=process.env.PONDEROSA_UI_EVIDENCE;assert(out,'Owned evidence directory required');await mkdir(out,{recursive:true});
const result={kind:'Branch navigation first visibility/open and retained resize state',requests:[],pageErrors:[],cleanup:[]};
let f,web,browser,context,page;
const navigation=()=>page.locator('aside[aria-label="Branches Navigation"]');
const search=()=>page.getByRole('textbox',{name:'Find A Workflow',exact:true});
const open=()=>page.getByRole('tabpanel',{name:'Chats',exact:true}).getByRole('button',{name:'Open Workspace Navigation',exact:true}).click();
const close=async()=>{const button=page.getByRole('button',{name:'Close Workspace Navigation',exact:true});await button.click();await button.waitFor({state:'hidden'});};
const draft=editor=>editor.evaluate(element=>element.value??element.textContent);
try{
 f=await fixture();
 const branch=f.ok(await f.api('POST','/api/branches',{name:'Navigation startup',idempotencyKey:randomUUID()}));
 const chat=f.ok(await f.api('POST','/api/branches/'+branch.id+'/chats',{label:'Navigation Chat',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
 web=await serveFixture(f);const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
 browser=await chromium.launch({executablePath:'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
 context=await browser.newContext({viewport:{width:412,height:823},isMobile:true,hasTouch:true,serviceWorkers:'block'});
 await context.addInitScript(()=>localStorage.setItem('ponderosa.branchesSidebar.v1',JSON.stringify({collapsed:false,width:438})));
 page=await context.newPage();page.setDefaultTimeout(10000);
 page.on('pageerror',error=>result.pageErrors.push(error.message));
 page.on('request',request=>result.requests.push({method:request.method(),path:new URL(request.url()).pathname}));
 await page.route('**/*',route=>['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
 await page.goto(web.origin+'/branches?branch='+branch.id+'&tab=chats&chat='+chat.id);
 const editor=page.getByLabel('Message',{exact:true});await editor.waitFor();
 assert.equal(await navigation().count(),0,'Neither unopened drawer nor hidden desktop sidebar should mount on a cold phone');
 assert(result.requests.some(row=>row.path==='/api/branches/engine/notifications'),'The visible Chat still owns canonical notification loading before drawer use');
 await editor.click();await page.keyboard.type('Keep Branch draft');
 const touch=await context.newCDPSession(page);
 try{
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:4,y:220}]});
  for(const x of [40,110,240]){
   await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:220}]});
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
  }
  assert.equal(await navigation().count(),1,'First edge drag must populate the drawer before touchend/onOpen');
  const bounds=await navigation().evaluate(element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};});
  assert(bounds.width>0&&bounds.right>0&&bounds.left<412);result.firstSwipeBounds=bounds;
  await page.screenshot({path:out+'/first-swipe-before-release.png'});
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await search().waitFor();await close();
 }finally{await touch.detach();}
 assert.equal(await draft(editor),'Keep Branch draft');
 await open();await search().fill('Navigation');await close();await open();
 assert.equal(await search().inputValue(),'Navigation');assert.equal(await navigation().count(),1);
 result.firstSwipeAndReopen=true;
 await page.setViewportSize({width:1365,height:768});
 await page.getByRole('button',{name:'Close Workspace Navigation',exact:true}).waitFor({state:'hidden'});
 await search().waitFor();assert.equal(await navigation().count(),2,'First desktop use retains the existing drawer owner');
 assert.equal(await search().inputValue(),'Navigation','Existing shared Branch search remains intact');
 assert.equal(await page.getByRole('separator',{name:'Resize Sidebar',exact:true}).getAttribute('aria-valuenow'),'438');
 await search().fill('Navigation startup');
 await page.getByRole('button',{name:'Collapse Sidebar',exact:true}).click();await search().waitFor({state:'hidden'});
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('ponderosa.branchesSidebar.v1')).collapsed),true);
 await page.setViewportSize({width:412,height:823});await open();await search().waitFor();
 assert.equal(await search().inputValue(),'Navigation startup');await close();
 await page.setViewportSize({width:1365,height:768});
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('ponderosa.branchesSidebar.v1')).collapsed),true,'Desktop collapse remains intact across phone use');
 await open();await search().waitFor();
 assert.equal(await search().inputValue(),'Navigation startup');
 assert.equal(await page.getByRole('separator',{name:'Resize Sidebar',exact:true}).getAttribute('aria-valuenow'),'438');
 // Resizing the existing phone context must close its retained drawer on desktop.
 assert.equal(await page.getByRole('button',{name:'Close Workspace Navigation',exact:true}).isVisible(),false);
 assert.equal(await draft(editor),'Keep Branch draft');assert.equal(f.turns.length,0);
 result.desktopWidthCollapseAndFilterRetained=true;result.desktopDrawerClosed=true;result.notificationRequestBeforeOpen=true;
 assert.deepEqual(result.pageErrors,[]);await page.screenshot({path:out+'/retained-navigation.png'});result.passed=true;
}catch(error){result.error=error.stack;if(page)await page.screenshot({path:out+'/failure.png',timeout:3000}).catch(()=>{});}
finally{
 for(const [name,close]of[['context',()=>context?.close()],['browser',()=>browser?.close()],['web',()=>web?.close()],['fixture',()=>f?.dispose(false)]])try{await close();result.cleanup.push({name,status:'complete'});}catch(error){result.cleanup.push({name,status:'failed',error:String(error)});}
 await writeFile(out+'/result.json',JSON.stringify(result,null,2));
}
console.log(JSON.stringify({passed:result.passed,error:result.error,firstSwipeAndReopen:result.firstSwipeAndReopen,desktopWidthCollapseAndFilterRetained:result.desktopWidthCollapseAndFilterRetained,desktopDrawerClosed:result.desktopDrawerClosed,cleanup:result.cleanup}));
if(!result.passed||result.cleanup.some(row=>row.status!=='complete'))process.exitCode=1;
