import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const repo=fileURLToPath(new URL('../../',import.meta.url));
const evidence=path.resolve(repo,'../evidence/mobile-ui');
const staged=process.argv.includes('--staged'),phase=staged?'staged':'after';
const origin=process.env.PINECONE_UI_ORIGIN??'http://192.168.1.147:18795';
if(staged)assert(process.env.PINECONE_UI_ORIGIN,'Set PINECONE_UI_ORIGIN to a separate read-only staging server');
const versions=[['v3','592f4798-cd48-445a-91f2-9f9a86b1c135'],['v5','49005cab-f4d3-4b38-a468-bf153624e4f4']];
const metrics=[],errors=[],mutations=[];
await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.PONDEROSA_CHROMIUM_PATH,timeout:15000});
const androidUA='Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36';
async function open(v,b,width,height,fixture=false){
 const context=await browser.newContext({viewport:{width,height},isMobile:width<600,hasTouch:width<900,...(width<600?{userAgent:androidUA}:{})});
 const page=await context.newPage();let fixtureCount=1;
 page.on('pageerror',e=>errors.push(e.message));

 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.pathname.startsWith('/api/')){
   if(req.method()!=='GET'){mutations.push(req.method()+' '+url.pathname);await route.abort();return;}
   // Long/new-message fixtures exist only in this isolated browser response.
   if(fixture&&url.pathname.includes('/agents/')&&url.pathname.endsWith('/stream')){await route.abort();return;}
   if(fixture&&/\/agents\/[^/]+$/.test(url.pathname)){
    const response=await route.fetch(),body=await response.json(),original=body.messages?.find(m=>m.role==='assistant'&&m.authorAgentId===body.agent?.id);
    if(original){
     const longText='Long message layout fixture — browser only.\n\n'+Array.from({length:35},(_,i)=>`Paragraph ${i+1}. Readable conversation content should scroll independently of the header and composer. `+'A long unbroken URL: https://example.test/'+('verylongsegment'.repeat(15))+'.').join('\n\n')+'\n\n```text\n'+('wide_code_value_'.repeat(30))+'\n```\n\n| One | Two | Three | Four |\n| --- | --- | --- | --- |\n| Wide table | Another cell | Readable | Final cell |';
     body.messages=Array.from({length:fixtureCount},(_,i)=>({...original,id:'mobile-fixture-'+i,text:i===0?longText:'New browser-only message '+i,document:undefined,attachments:[],citations:[]}));
     body.runs=[];body.decisionEvents=[];if(body.history)body.history.hasMore=false;
    }
    await route.fulfill({response,json:body});return;
   }
   await route.continue();return;
  }
  await route.continue();
 });
 await page.goto(origin+'/branches?branch='+b+'&tab=pinecone',{waitUntil:'domcontentloaded',timeout:20000});
 try{await page.locator('section[aria-label="Conversation with Pinecone"]').waitFor({timeout:20000});}catch(error){await page.screenshot({path:path.join(evidence,phase+'-load-failure.png')});console.error(JSON.stringify({errors,body:(await page.locator('body').innerText()).slice(0,3000)}));throw error;}
 await page.locator('article').first().waitFor({timeout:10000});
 await page.waitForTimeout(150);
 return {context,page,setFixtureCount:n=>{fixtureCount=n}};
}
async function measure(page){return page.evaluate(()=>{
 const box=s=>{const e=document.querySelector(s),r=e?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,scrollTop:e.scrollTop}:null};
 return {viewport:{width:innerWidth,height:innerHeight},conversation:box('section[aria-label="Conversation with Pinecone"]'),composer:box('form'),pageHeight:document.documentElement.scrollHeight,horizontalOverflow:document.documentElement.scrollWidth>innerWidth,appHeight:document.documentElement.style.getPropertyValue('--ponderosa-app-viewport-block-size')};
});}
function checkBounds(m,minHeight){
 assert(m.conversation.height>=minHeight,JSON.stringify(m));
 assert(m.conversation.bottom<=m.composer.y+1,'Composer overlaps conversation');
 assert(m.composer.bottom<=m.viewport.height+1,'Composer below viewport');
 assert(m.pageHeight<=m.viewport.height+1,'Outer document scrolls');
 assert(!m.horizontalOverflow,'Horizontal page overflow');
}
try{
 for(const [v,b] of versions)for(const [width,height] of [[360,740],[390,844],[430,932],[390,360],[844,390],[1440,900]]){
  const {context,page}=await open(v,b,width,height);
  const compact=width<600||height<=500;
  if(compact){
   const summary=page.getByRole('button',{name:'Discovery details and controls'});
   assert.equal(await summary.getAttribute('aria-expanded'),'false');
   const m=await measure(page);checkBounds(m,height<500?180:height*.7);metrics.push({v,width,height,mode:'collapsed',...m});
   await page.screenshot({path:path.join(evidence,`${phase}-${v}-${width}x${height}.png`)});
   await summary.click();await page.getByRole('button',{name:'Research history',exact:true}).waitFor();
   await page.waitForTimeout(350);
   const opened=await measure(page);checkBounds(opened,60);metrics.push({v,width,height,mode:'expanded',...opened});
   assert(await page.getByRole('button',{name:'Pause discovery',exact:true}).isVisible());
   await summary.click();await page.waitForTimeout(350);
  }else{
   assert(await page.getByRole('button',{name:'Check now',exact:true}).isVisible());
   assert(await page.getByRole('button',{name:'Pause discovery',exact:true}).isVisible());
   const m=await measure(page);checkBounds(m,400);metrics.push({v,width,height,mode:'desktop',...m});
   await page.screenshot({path:path.join(evidence,`${phase}-${v}-${width}x${height}.png`)});
  }
  await context.close();
 }
 // Expanded long Markdown, arrival while reading, bottom-following, and keyboard-sized viewport.
 const {context,page,setFixtureCount}=await open(...versions[0],390,844,true);
 const conversation=page.locator('section[aria-label="Conversation with Pinecone"]');
 await page.getByRole('button',{name:'Show Full Message',exact:true}).click();
 await conversation.evaluate(e=>{e.scrollTop=0});await page.waitForTimeout(100);
 const long=await measure(page);assert(long.conversation.scrollHeight>long.conversation.clientHeight*4);checkBounds(long,580);
 setFixtureCount(2);await page.waitForFunction(()=>document.querySelectorAll('article').length===2,{},{timeout:12000});
 assert((await measure(page)).conversation.scrollTop<5,'New message pulled reader away from older text');
 await conversation.evaluate(e=>{e.scrollTop=e.scrollHeight});await page.waitForTimeout(100);
 setFixtureCount(3);await page.waitForFunction(()=>document.querySelectorAll('article').length===3,{},{timeout:12000});
 const following=await measure(page);assert(following.conversation.scrollHeight-following.conversation.scrollTop-following.conversation.clientHeight<5,'Reader at bottom did not follow new message');
 await page.locator('form textarea').first().fill(Array.from({length:12},(_,i)=>'Unsent browser draft '+i).join('\n'));
 await page.setViewportSize({width:390,height:360});await page.waitForTimeout(100);
 const short=await measure(page);checkBounds(short,120);assert(short.composer.height<135,'Draft composer grew beyond three rows');
 assert(await page.locator('form textarea').first().evaluate(e=>e===document.activeElement));
 await page.screenshot({path:path.join(evidence,`${phase}-long-draft-short-viewport.png`)});
 metrics.push({case:'long-message-and-focused-draft-short-viewport',...short});
 await context.close();
 // Real Chromium CSS env() safe-area emulation; root and composer remain inside the viewport.
 const safe=await open(...versions[0],390,844),cdp=await safe.context.newCDPSession(safe.page);
 await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{top:24,bottom:34,left:12,right:12}});
 await safe.page.waitForTimeout(100);
 const inset=await measure(safe.page);checkBounds(inset,580);assert(inset.conversation.y>=24);assert(inset.conversation.x>=12);
 const padding=await safe.page.locator('form').evaluate(e=>getComputedStyle(e).paddingBottom);assert.equal(padding,'34px');
 await safe.page.screenshot({path:path.join(evidence,`${phase}-safe-area.png`)});metrics.push({case:'safe-area-24-34-12',padding,...inset});
 await safe.context.close();
 // Model Android's overlay keyboard: visual viewport shrinks without layout viewport resize.
 const overlay=await open(...versions[1],390,844);
 await overlay.page.locator('form textarea').first().focus();
 await overlay.page.evaluate(()=>{Object.defineProperty(window.visualViewport,'height',{configurable:true,value:360});window.visualViewport.dispatchEvent(new Event('resize'));});
 await overlay.page.waitForTimeout(100);
 const keyboard=await measure(overlay.page);assert(keyboard.composer.bottom<=361,'Overlay keyboard hid composer');assert(keyboard.conversation.height>=170);
 metrics.push({case:'visual-viewport-overlay-keyboard-360',...keyboard});
 await overlay.page.screenshot({path:path.join(evidence,`${phase}-overlay-keyboard.png`)});await overlay.context.close();
 assert.deepEqual(errors,[]);assert.deepEqual(mutations,[]);
 await writeFile(path.join(evidence,`${phase}-verification.json`),JSON.stringify({phase,metrics,errors,mutations,physicalAndroidKeyboard:false},null,2));
 console.log(JSON.stringify({phase,passed:true,viewportCases:12,additionalCases:3,mutations,metrics:metrics.filter(m=>m.width===390||m.case)}));
}finally{await browser.close();}
