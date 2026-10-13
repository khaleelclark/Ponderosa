import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const root=fileURLToPath(new URL('../../',import.meta.url)),evidence=path.resolve(root,'../evidence/v4-texting');
const phase=process.argv[2]??'after',origin=process.env.PINECONE_UI_ORIGIN??'http://192.168.1.147:18795';
const branch='0356095a-8d73-4249-b39d-883b978ae119',agent='f1e52ee0-6966-471c-bfe4-c9d04233a39a';
const browser=await chromium.launch({headless:true,executablePath:process.env.PONDEROSA_CHROMIUM_PATH,timeout:15000});
const rows=[],errors=[],writes=[];
await mkdir(evidence,{recursive:true});
async function measure(page){return page.evaluate(()=>{
 const bounds=s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return {x:r.x,y:r.y,height:r.height,bottom:r.bottom,width:r.width,scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}};
 return {width:innerWidth,height:innerHeight,conversation:bounds('section[aria-label="Conversation with Pinecone"]'),composer:bounds('form'),overflow:document.documentElement.scrollWidth>innerWidth,pageHeight:document.documentElement.scrollHeight};
});}
try{
 for(const [width,height] of [[360,740],[390,844],[430,932],[390,360],[844,390],[1440,900]]){
  const context=await browser.newContext({viewport:{width,height},isMobile:width<600,hasTouch:width<900}),page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',r=>{if(r.request().method()!=='GET'){writes.push(r.request().method()+' '+r.request().url());return r.abort()}return r.continue()});
  await page.goto(origin+'/branches?branch='+branch+'&tab=pinecone',{waitUntil:'domcontentloaded',timeout:20000});
  await page.locator('article').first().waitFor({timeout:20000});await page.waitForTimeout(150);
  const m=await measure(page);
  if(phase!=='baseline'){
   assert(m.conversation.height>=height*(height<500?.6:.8),JSON.stringify(m));
   assert(m.conversation.bottom<=m.composer.y+1);assert(m.composer.bottom<=height+1);assert(!m.overflow);assert(m.pageHeight<=height+1);
   assert.equal(await page.locator('section[aria-label="Proactive research"]').count(),0);
   assert.equal(await page.getByRole('button',{name:'Check now',exact:true}).count(),0);
   await page.getByRole('button',{name:'Conversation options'}).click();
   await page.getByRole('menuitem',{name:'Research history',exact:true}).waitFor();assert(await page.getByRole('menuitem',{name:'Discovery paused',exact:true}).isVisible());
   await page.keyboard.press('Escape');
   const conversation=page.locator('section[aria-label="Conversation with Pinecone"]');
   await conversation.evaluate(e=>{e.scrollTop=0});await page.waitForTimeout(75);
   assert((await measure(page)).conversation.scrollTop<2);await conversation.evaluate(e=>{e.scrollTop=e.scrollHeight});
  }
  await page.screenshot({path:path.join(evidence,`${phase}-${width}x${height}.png`)});rows.push(m);
  if(phase!=='baseline'&&width===390&&height===844){
   const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{top:24,bottom:34,left:12,right:12}});
   await page.waitForTimeout(75);const safe=await measure(page);assert(safe.conversation.x>=12);assert.equal(await page.locator('form').evaluate(e=>getComputedStyle(e).paddingBottom),'34px');
   await page.screenshot({path:path.join(evidence,`${phase}-safe-area.png`)});
   await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{top:0,bottom:0,left:0,right:0}});
   await page.getByRole('textbox',{name:'Message Pinecone',exact:true}).fill(Array.from({length:12},()=> 'Unsent browser-only draft').join('\n'));
   await page.evaluate(()=>{Object.defineProperty(window.visualViewport,'height',{configurable:true,value:360});window.visualViewport.dispatchEvent(new Event('resize'))});
   await page.waitForTimeout(75);const keyboard=await measure(page);assert(keyboard.composer.bottom<=361);assert(keyboard.conversation.height>170);
   await page.screenshot({path:path.join(evidence,`${phase}-keyboard.png`)});rows.push({case:'keyboard-overlay',...keyboard});
  }
  await context.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 await writeFile(path.join(evidence,`${phase}-render-proof.json`),JSON.stringify({phase,rows,errors,writes,physicalMobileKeyboardTested:false},null,2));
 console.log(JSON.stringify({phase,passed:true,viewportCases:6,additionalSafeAreaAndKeyboard:phase!=='baseline',rows}));
}finally{await browser.close();}
