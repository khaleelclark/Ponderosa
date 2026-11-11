// Real Copy/Download transcript actions over disposable canonical data only.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import '../shared/web-typescript-loader.mjs';
import {buildMarkdownTranscript,transcriptFileName} from '../../apps/web/src/chatTranscript.ts';
import {resolveMessageMentionText} from '../../apps/web/src/components/chat/messageMentionPresentation.ts';
import {createLoadFixture} from '../shared/ui-load-fixture.mjs';
import {serveFixture} from '../shared/serve-ui-fixture.mjs';
const out=path.resolve(process.argv[2]);await mkdir(out,{recursive:true});
const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
let fixture,web,browser;const contexts=[],results=[];
async function action(page,label,kind){
 await page.getByRole('button',{name:label,exact:true}).click();
 await page.getByRole('menuitem',{name:kind,exact:true}).click();
 await page.getByRole('menuitem',{name:'Chat Transcript',exact:true}).click();
}
try{
 fixture=await createLoadFixture(out,{messages:100});web=await serveFixture(fixture.f);
 browser=await chromium.launch({executablePath:'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
 for(const product of ['core','branches']){
  const p=fixture.products[product],context=await browser.newContext({viewport:{width:1365,height:768},serviceWorkers:'block',acceptDownloads:true});contexts.push(context);
  await context.route('**/*',route=>new URL(route.request().url()).origin===web.origin?route.continue():route.abort());
  await context.addInitScript(()=>{window.__copies=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.__copies.push(text)}});});
  const page=await context.newPage();page.setDefaultTimeout(10000);await page.goto(web.origin+p.route);await page.getByLabel('Message',{exact:true}).waitFor();await page.locator(`[id=${JSON.stringify('master-message-'+p.seed.lastId)}]`).waitFor({state:'visible'});
  const detail=fixture.f.ok(await fixture.f.api('GET',p.prefix+'/conversations/'+p.chat.id+'?limit=100'));assert.equal(detail.messages.length,100);
  for(const team of [false,true]){
   if(team)await page.getByRole('tab',{name:'Team Chat',exact:true}).click();
   const title=team?`${detail.conversation.title} — Team chat`:detail.conversation.title;
   const rows=team?[]:detail.messages;
   const expected=buildMarkdownTranscript(title,rows.map(message=>({author:message.role==='system'?'System':'You',text:resolveMessageMentionText(message.text,message.agentMentions),createdAt:message.createdAt,attachments:message.attachments,document:message.document})),{hasEarlier:team?false:detail.history?.hasMore});
   const label=`${team?'Team Chat':'Chat'} settings and actions`;
   await action(page,label,'Copy');await page.waitForFunction(text=>window.__copies.at(-1)===text,expected);assert.equal(await page.evaluate(()=>window.__copies.at(-1)),expected);
   const pending=page.waitForEvent('download');await action(page,label,'Download');const download=await pending;assert.equal(download.suggestedFilename(),transcriptFileName(title));const dest=path.join(out,`${product}-${team?'team':'main'}.md`);await download.saveAs(dest);assert.equal(await readFile(dest,'utf8'),expected);
   results.push({product,team,copyBytes:Buffer.byteLength(expected),downloadBytes:Buffer.byteLength(expected),filename:download.suggestedFilename()});await writeFile(path.join(out,'results.json'),JSON.stringify(results,null,2));
  }
  await page.screenshot({path:path.join(out,`${product}-after-export.png`)});await context.close();contexts.splice(contexts.indexOf(context),1);
 }
 await writeFile(path.join(out,'results.json'),JSON.stringify({passed:true,results},null,2));
}catch(error){await writeFile(path.join(out,'failure.json'),JSON.stringify({error:error.stack,results},null,2));throw error;}
finally{
 const stages=[],failures=[];const attempt=async(name,resource,close)=>{if(!resource)return;try{await close();stages.push({name,status:'closed'});}catch(error){stages.push({name,status:'failed',error:String(error)});failures.push(error);}};
 for(const [i,c] of contexts.entries())await attempt('context-'+i,c,()=>c.close());await attempt('browser',browser,()=>browser.close());await attempt('web',web,()=>web.close());await attempt('fixture',fixture,()=>fixture.close());await writeFile(path.join(out,'cleanup.json'),JSON.stringify({stages,passed:!failures.length},null,2));if(failures.length)throw new AggregateError(failures,'Owned transcript check cleanup failed');
}
