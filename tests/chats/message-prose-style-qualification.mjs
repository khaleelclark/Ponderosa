// Manual actual-component CSS compatibility check, not timing qualification.
// BASELINE_REPO=<owned frozen source> node --import ./tests/shared/workspace-resolution.mjs tests/chats/message-prose-style-qualification.mjs <owned output>
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const repo=fileURLToPath(new URL('../../',import.meta.url)),baseline=process.env.BASELINE_REPO,out=path.resolve(process.argv[2]);
assert(baseline,'Explicit frozen baseline source required');await mkdir(out,{recursive:true});
const text=['# Heading one','First paragraph with **strong**, *emphasis*, ~~GFM deletion~~ and `inline code`.','Second authored line.','','## Heading two','','### Heading three','','#### Heading four','','- First item','- Second item with `code`','','1. Ordered first','2. Ordered second','','> Quoted prose with a [link](https://example.invalid/quote).','','| First | Long heading |','| --- | ---: |','| Cell | [Long link](https://example.invalid/table) |','| Another | A_long_unbroken_value_abcdefghijklmnopqrstuvwxyz0123456789 |','','```text','Code keeps spacing and a long line '+ 'x'.repeat(160),'  indented code','```','','![Owned figure](http://127.0.0.1:1/prose-test.svg)','','Last paragraph with [ordinary link](https://example.invalid/final) and '+ 'longword'.repeat(40)+'.'].join('\n');
async function renderDocuments(sourceRoot){
 const script=`
 import {createRequire} from 'node:module';
 import {readFile} from 'node:fs/promises';
 const repo=process.env.PROSE_SOURCE,require=createRequire(repo+'/apps/web/package.json');
 await import(repo+'/tests/shared/web-typescript-loader.mjs');
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),{ThemeProvider,CssBaseline}=require('@mui/material');
 const {ChatMessageBody,messageProseTypography}=await import(repo+'/apps/web/src/components/chat/ChatMessages.tsx');
 const {MutationNotificationProvider}=await import(repo+'/apps/web/src/components/MutationNotifications.tsx');
 const {createPonderosaTheme}=await import(repo+'/apps/web/src/theme.ts');
 const text=${JSON.stringify(text)},documents=[];
 for(const mode of ['light','dark'])for(const compact of [false,true])for(const small of [false,true]){
  const html=renderToStaticMarkup(React.createElement(ThemeProvider,{theme:createPonderosaTheme(mode)},React.createElement(React.Fragment,null,React.createElement(CssBaseline),React.createElement(MutationNotificationProvider,null,React.createElement('main',{className:'chat-scroll-region',style:{width:'100%',maxWidth:1040,padding:16}},React.createElement(ChatMessageBody,{text,collapseLongMessage:false,compactMarkdown:compact,smallText:small}))))));
  documents.push({mode,compact,small,html});
 }
 console.log(JSON.stringify({documents,css:await readFile(repo+'/apps/web/src/global.css','utf8'),typography:messageProseTypography}));`;
 const result=execFileSync(process.execPath,['--import',path.join(sourceRoot,'tests/shared/workspace-resolution.mjs'),'--input-type=module'],{input:script,env:{...process.env,PROSE_SOURCE:sourceRoot},maxBuffer:16*1024*1024});
 return JSON.parse(result.toString());
}
const old=await renderDocuments(baseline),next=await renderDocuments(repo);assert.deepEqual(next.typography,old.typography,'Existing exported live/completed typography remains unchanged');
const {chromium}=createRequire(path.join(repo,'apps/server/package.json'))('playwright-core');
const properties=['display','width','height','minHeight','boxSizing','overflow','maskImage','webkitMaskImage','fontFamily','fontSize','fontWeight','lineHeight','color','backgroundColor','whiteSpace','overflowWrap','wordBreak','overflowX','minWidth','maxWidth','maxHeight','marginTop','marginRight','marginBottom','marginLeft','paddingTop','paddingRight','paddingBottom','paddingLeft','borderRadius','borderLeftWidth','borderLeftStyle','borderLeftColor','borderBottomWidth','borderBottomStyle','borderBottomColor','borderCollapse','verticalAlign','textAlign','fontVariantNumeric','objectFit','textDecorationLine','textUnderlineOffset'];
async function measure(page){return page.locator('main h1').evaluate((heading,keys)=>{
 const prose=heading.parentElement,root=prose.getBoundingClientRect(),elements=[prose.parentElement.parentElement,prose.parentElement,prose,...prose.querySelectorAll('p,h1,h2,h3,h4,ul,ol,li,blockquote,pre,code,table,thead,tbody,tr,th,td,a,img,button,[role="region"]')];
 const clone=prose.cloneNode(true);clone.removeAttribute('class');for(const style of clone.querySelectorAll('style'))style.remove();
 return {html:clone.outerHTML,metrics:elements.map(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return{tag:e.tagName,text:e.textContent,box:{x:r.x-root.x,y:r.y-root.y,width:r.width,height:r.height},style:Object.fromEntries(keys.map(k=>[k,s[k]]))}})};
 },properties);}
let browser;const results=[],cleanup=[];
try{
 browser=await chromium.launch({executablePath:process.env.PONDEROSA_BROWSER_EXECUTABLE||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox','--disable-background-networking']});
 for(const width of [390,599,600,899,900,1280]){
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
  await context.route('**/*',route=>route.request().url()==='http://127.0.0.1:1/prose-test.svg'?route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="280"><rect width="640" height="280" fill="#42996b"/></svg>'}):route.abort());
  try{for(let i=0;i<old.documents.length;i++){
   const a=old.documents[i],b=next.documents[i],samples=[];
   for(const [name,packet,doc] of [['baseline',old,a],['new',next,b]]){
    const page=await context.newPage();await page.setContent('<!doctype html><html><head><style>'+packet.css+'</style></head><body>'+doc.html+'</body></html>');
    await page.locator('img').scrollIntoViewIfNeeded();await page.waitForFunction(()=>[...document.images].every(image=>image.complete&&image.naturalWidth>0));
    await page.evaluate(()=>document.fonts.ready);const measured=await measure(page);
    const anchor=page.locator('a').last();await anchor.hover();const hover=await anchor.evaluate(e=>getComputedStyle(e).textDecorationThickness);
    await page.keyboard.press('Tab');await anchor.focus();const focus=await anchor.evaluate(e=>({visible:e.matches(':focus-visible'),style:getComputedStyle(e).outlineStyle,width:getComputedStyle(e).outlineWidth,color:getComputedStyle(e).outlineColor,offset:getComputedStyle(e).outlineOffset}));
    samples.push({name,...measured,hover,focus});await page.close();
   }
   const [x,y]=samples;assert.equal(y.html,x.html,'Authored HTML/GFM/table/code/link/media descendants remain identical');assert.equal(y.metrics.length,x.metrics.length);
   for(let j=0;j<x.metrics.length;j++){const before=x.metrics[j],after=y.metrics[j];assert.equal(after.tag,before.tag);assert.deepEqual(after.style,before.style,`${width}/${a.mode}/${a.compact}/${a.small}/${j}/${before.tag} styles`);for(const key of Object.keys(before.box))assert(Math.abs(after.box[key]-before.box[key])<=.1,`${width}/${a.mode}/${a.compact}/${a.small}/${j}/${key}: ${after.box[key]} vs ${before.box[key]}`);}
   assert.equal(y.hover,x.hover);assert.deepEqual(y.focus,x.focus);assert.equal(y.focus.visible,true);assert.equal(y.focus.width,'2px');
   results.push({width,mode:a.mode,compact:a.compact,small:a.small,elementsCompared:x.metrics.length,descendantHtmlEqual:true,computedStylesEqual:true,geometryTolerancePx:.1,hover:x.hover,focus:x.focus});
  }}finally{await context.close();}
 }
 await writeFile(path.join(out,'results.json'),JSON.stringify({passed:true,baseline,repo,cases:results.length,typography:next.typography,results,scope:'actual SSR component/CssBaseline plus browser CSS; no hydration, provider, app startup or timing claim'},null,2));
 console.log(JSON.stringify({passed:true,cases:results.length,out,scope:'component and body-wrapper style equivalence only'}));
}catch(error){await writeFile(path.join(out,'failure.json'),JSON.stringify({error:error.stack,results},null,2));throw error;}
finally{try{await browser?.close();cleanup.push({resource:'browser',status:'closed'});}catch(error){cleanup.push({resource:'browser',status:'failed',error:String(error)});throw error;}finally{await writeFile(path.join(out,'cleanup.json'),JSON.stringify(cleanup,null,2));}}
