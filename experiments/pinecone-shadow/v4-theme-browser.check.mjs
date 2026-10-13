import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const repo=fileURLToPath(new URL('../../',import.meta.url)),out=path.resolve(repo,'../evidence/v4-appearance');
const origin=process.env.PINECONE_UI_ORIGIN??'http://192.168.1.147:18795',phase=process.argv[2]??'after';
const branch='0356095a-8d73-4249-b39d-883b978ae119',key='ponderosa-color-mode';
const browser=await chromium.launch({headless:true,executablePath:process.env.PONDEROSA_CHROMIUM_PATH,timeout:15000});
const records=[],errors=[],writes=[];await mkdir(out,{recursive:true});
function luminance(rgb){const c=rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2]}
function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
async function colors(page){return page.evaluate(()=>{
 const bg=e=>{for(let n=e;n;n=n.parentElement){const c=getComputedStyle(n).backgroundColor;if(c!=='rgba(0, 0, 0, 0)'&&c!=='transparent')return c}return getComputedStyle(document.body).backgroundColor};
 const get=e=>({background:bg(e),color:getComputedStyle(e).color});
 const composer=document.querySelector('form textarea'),assistant=document.querySelector('article[aria-label="Pinecone message"]'),user=document.querySelector('article[aria-label="Your message"]'),menu=document.querySelector('[role="menu"]');
 const conversation=document.querySelector('section[aria-label="Conversation with Pinecone"]').getBoundingClientRect(),form=document.querySelector('form').getBoundingClientRect();
 return {body:get(document.body),composer:get(composer),assistant:assistant?get(assistant):null,user:user?get(user):null,menu:menu?get(menu):null,colorScheme:document.documentElement.style.colorScheme,conversationHeight:conversation.height,composerBottom:form.bottom,viewportHeight:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,storedMode:localStorage.getItem('ponderosa-color-mode'),unrelated:localStorage.getItem('theme-check-unrelated')};
});}
async function open(width,height,system,saved,storageDenied=false){
 const context=await browser.newContext({viewport:{width,height},colorScheme:system,isMobile:width<600,hasTouch:width<600}),page=await context.newPage();
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',r=>{if(r.request().method()!=='GET'){writes.push(r.request().method()+' '+r.request().url());return r.abort()}return r.continue()});
 await page.addInitScript(({key,saved,storageDenied})=>{localStorage.setItem('theme-check-unrelated','keep');if(saved)localStorage.setItem(key,saved);if(storageDenied)Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('Blocked','SecurityError')}})}, {key,saved,storageDenied});
 await page.goto(origin+'/branches?branch='+branch+'&tab=pinecone',{waitUntil:'domcontentloaded',timeout:20000});
 await page.locator('article').first().waitFor({timeout:20000});await page.waitForTimeout(100);
 return {context,page};
}
try{
 if(phase==='before'){
  for(const [w,h] of [[390,844],[1440,900]]){
   const {context,page}=await open(w,h,'dark',undefined);const state=await colors(page);assert.equal(state.body.background,'rgb(251, 252, 251)');
   await page.screenshot({path:path.join(out,`before-${w}.png`)});records.push({case:'dark-device-incorrectly-light',w,h,state});await context.close();
  }
 }else{
  for(const [w,h] of [[390,844],[1440,900]])for(const [system,saved,expected] of [['dark',undefined,'dark'],['light',undefined,'dark'],['light','dark','dark'],['dark','light','light']]){
   const {context,page}=await open(w,h,system,saved);
   await page.getByRole('button',{name:'Conversation options'}).click();await page.getByRole('menu').waitFor();await page.waitForTimeout(250);
   const state=await colors(page);assert.equal(state.body.background,expected==='dark'?'rgb(16, 19, 18)':'rgb(251, 252, 251)');assert.equal(state.colorScheme,expected);assert.equal(state.storedMode,expected);assert.equal(state.unrelated,'keep');
   for(const surface of ['body','composer','assistant','user','menu'])if(state[surface])assert(contrast(state[surface].color,state[surface].background)>=4.5,surface+' contrast '+JSON.stringify(state[surface]));
   assert(state.conversationHeight>h*.8);assert(state.composerBottom<=h+1);assert(!state.overflow);
   if(!saved&&system==='dark')await page.screenshot({path:path.join(out,`after-dark-menu-${w}.png`)});
   await page.keyboard.press('Escape');await page.waitForTimeout(250);
   if(!saved&&system==='dark')await page.screenshot({path:path.join(out,`after-dark-${w}.png`)});
   records.push({w,h,system,saved,expected,state});await context.close();
  }
  const {context,page}=await open(390,844,'light',undefined);
  await page.getByRole('textbox',{name:'Message Pinecone',exact:true}).fill('Unsent browser-only appearance draft');
  await page.getByRole('button',{name:'Conversation options'}).click();await page.getByRole('menuitem',{name:'Use light mode',exact:true}).click();await page.waitForTimeout(75);
  assert.equal((await colors(page)).storedMode,'light');assert.equal(await page.getByRole('textbox',{name:'Message Pinecone',exact:true}).inputValue(),'Unsent browser-only appearance draft');
  await page.reload();await page.getByRole('textbox',{name:'Message Pinecone',exact:true}).waitFor();await page.waitForTimeout(75);assert.equal((await colors(page)).storedMode,'light');
  await page.getByRole('button',{name:'Conversation options'}).click();await page.getByRole('menuitem',{name:'Use dark mode',exact:true}).click();await page.waitForTimeout(75);assert.equal((await colors(page)).storedMode,'dark');
  assert.equal((await colors(page)).unrelated,'keep');await context.close();
  records.push({case:'appearance-toggle-reload-preserves-draft-and-unrelated-storage',passed:true});
  const denied=await open(390,844,'light',undefined,true);
  assert.equal(await denied.page.locator('body').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(16, 19, 18)');assert.equal(await denied.page.evaluate(()=>document.documentElement.style.colorScheme),'dark');
  records.push({case:'storage-denied-restores-dark-with-memory-fallback',passed:true});await denied.context.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 await writeFile(path.join(out,phase+'-verification.json'),JSON.stringify({phase,passed:true,records,errors,writes},null,2));console.log(JSON.stringify({phase,passed:true,cases:records.length,records:records.map(r=>({w:r.w,h:r.h,case:r.case,system:r.system,saved:r.saved,expected:r.expected,background:r.state?.body.background})),writes}));
}finally{await browser.close();}
