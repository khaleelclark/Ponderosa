// Built product, canonical disposable fixture, inert provider, owned loopback only.
import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {fixture,until} from '../shared/fixture.mjs';
import {AgentStore} from '../../packages/agents/dist/store.js';
const {chromium,webkit,devices}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=process.env.PONDEROSA_QUESTION_EVIDENCE??await mkdtemp(path.join(tmpdir(),'ponderosa-question-panel-'));
await mkdir(out,{recursive:true});const rows=[];let f,browser,context;
const save=()=>writeFile(path.join(out,'results.json'),JSON.stringify({rows,liveDataChanged:false,realDevice:false},null,2)+'\n');
const promptFields=[['Question','https'],['Context','http']].map(([label,protocol])=>{
 const origin=protocol+'://question-links.test:9443';
 const markdown=origin+'/'+label.toLowerCase()+'-markdown?term=a%20b&next=%2F%3Fx%3D1#review';
 const plain=origin+'/'+label.toLowerCase()+'-plain?term=a%20b&next=%2F%3Fx%3D1#review';
 return {label,origin,markdown,plain,text:`[${label} reference](${markdown}) or ${plain}. [${label} unsafe](javascript:alert(1))`};
});
async function checkQuestionLinks(page,scope,touch,afterReturn){
 const originalUrl=page.url();
 for(const {label,markdown,plain} of promptFields){
  const unsafe=scope.getByText(label+' unsafe',{exact:true});
  await unsafe.waitFor();
  assert.equal(await unsafe.evaluate(node=>node.closest('a')===null),true,'Unsafe destination stays inert');
  for(const [text,destination] of [[label+' reference',markdown],[plain,plain]]){
   const link=scope.getByRole('link',{name:text,exact:true});
   await link.waitFor();
   assert.equal(await link.getAttribute('href'),destination);
   if(!touch){
    await link.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expectFocus(link,page);
   }
   const [popup]=await Promise.all([
    page.context().waitForEvent('page',{timeout:5000}),
    touch?link.tap():page.keyboard.press('Enter'),
   ]);
   await popup.waitForURL(destination);
   assert.equal(await popup.evaluate(()=>window.opener),null);
   await popup.close();
   await page.bringToFront();
   assert.equal(page.url(),originalUrl);
   await afterReturn?.();
  }
 }
}
try{
 for(const engine of (process.env.PONDEROSA_QUESTION_BROWSERS??'chromium,webkit').split(',')){
  browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='webkit'?{executablePath:process.env.PONDEROSA_WEBKIT_PATH}:{executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']})});
  for(const width of (process.env.PONDEROSA_QUESTION_SIZES??'1440,390').split(',').map(Number))for(const mode of (process.env.PONDEROSA_QUESTION_MODES??'light,dark').split(','))for(const view of (process.env.PONDEROSA_QUESTION_VIEWS??'chat,agent,assistant').split(',')){
   const row={name:`${engine}-${width}-${mode}-${view}`,passed:false,errors:[],checks:[]};rows.push(row);let store,page;
   try{
    f=await fixture({webDist:path.join(root,'apps/web/dist'),storeFactory:dir=>store=new AgentStore(dir)});
    let agent,target,prefix='/api',session;
    if(view==='assistant'){
     const descriptor=f.ok(await f.api('POST','/api/branches/assistant',{initialize:true}));prefix='/api/branches/engine';agent=(await f.detail(descriptor.app.agentId,prefix)).agent;target='/assistant';
     f.plans.set(agent.id,[{hold:true}]);f.ok(await f.api('POST',`${prefix}/agents/${agent.id}/messages`,{text:'Owned question task',idempotencyKey:randomUUID()}));
     await until(()=>f.turns.some(turn=>turn.agentId===agent.id),'owned Assistant turn');session=f.sessions.get(agent.id);
    }else{
     const chat=await f.createChat('Question Panel Qualification');agent=await f.createIdleAgent(chat,'Real Question Owner');session=await f.hold(agent.id);
     target=view==='agent'?`/projects/${chat.projectId}/agents/${agent.id}?view=chat`:`/projects/${chat.projectId}/chats/${chat.id}?view=team`;
    }
    const asked=f.ok(await f.tool(session,'ponderosa_decision',{idempotencyKey:randomUUID(),question:'Full exact question λ😀. What should the Agent do? '+promptFields[0].text,context:promptFields[1].text,mode:'text',blocking:false}));
    if(view==='chat')target+='&message='+encodeURIComponent('decision:'+asked.id);
    const notificationEntry=view==='chat'&&width===1440&&mode==='light'?await f.createChat('Different Notification Chat'):undefined;
    const origin=await f.listen();assert.equal(new URL(origin).hostname,'127.0.0.1');
    context=await browser.newContext({...(engine==='webkit'&&width===390?devices['iPhone 13']:{viewport:{width,height:width===390?844:962},isMobile:width===390,hasTouch:width===390}),serviceWorkers:'block'});
    await context.addInitScript(mode=>localStorage.setItem('ponderosa-color-mode',mode),mode);
    const posts=[],browserRequests=[];
    await context.route('**/*',route=>{
     const request=route.request(),url=new URL(request.url());
     if(promptFields.some(field=>url.origin===field.origin))return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Question link fixture</title>'});
     assert.equal(url.origin,origin,'Only fixture traffic');
     if(/\/browser(?:\/|$)/.test(url.pathname)){if(request.method()==='POST')browserRequests.push(url.pathname);return route.fulfill({status:501,json:{error:'Hosted browser disabled in fixture'}});}
     if(request.method()==='POST'&&url.pathname.endsWith('/respond'))posts.push(request.postDataJSON());
     return route.continue();
    });
    page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>row.errors.push({message:error.message,stack:error.stack,at:Date.now()}));
    await page.goto(origin+(notificationEntry?`/projects/${notificationEntry.projectId}/chats/${notificationEntry.id}`:target),{waitUntil:'domcontentloaded'});await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
    if(notificationEntry){await page.getByRole('button',{name:/^Notifications(?:,|$)/}).click();await page.getByRole('button',{name:'Answer Question',exact:true}).first().click();await page.waitForURL(url=>url.pathname.includes(agent.conversationId));row.checks.push('Real notification first navigates from a different Chat to its exact owner');}
    const panel=page.getByRole('region',{name:'Chat Questions',exact:true}),question=panel.locator(`details[id="decision:${asked.id}"]`);await question.waitFor();
    await checkQuestionLinks(page,question,width===390);
    row.checks.push('Question card opens both link forms from both fields with the exact port, query and fragment');
    assert.equal(await page.getByRole('dialog').count(),0);await question.getByRole('button',{name:'Answer',exact:true}).click();
    const answer=question.getByRole('textbox',{name:'Your Answer',exact:true});await answer.waitFor();await until(async()=>!(await answer.isDisabled()),'canonical draft loads');await expectFocus(answer,page);
    const draft='Exact retained direction λ😀\nsecond line';await answer.fill(draft);
    await checkQuestionLinks(page,question.getByRole('region',{name:'Answer Decision'}),width===390,async()=>{
     assert(await answer.isVisible(),'Answer form stays open on return');
     assert.equal(await answer.inputValue(),draft,'Unfinished answer stays in the form');
     assert.equal(posts.length,0,'Link activation never submits an answer');
    });
    row.checks.push('Answer form opens both link forms from both fields and retains the unfinished draft');
    const uploaded=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/draft-attachments')&&response.ok());
    const chooser=page.waitForEvent('filechooser');await question.getByRole('button',{name:'Attach Files',exact:true}).click();await(await chooser).setFiles({name:'question-evidence.txt',mimeType:'text/plain',buffer:Buffer.from('Exact question evidence λ😀')});const asset=await(await uploaded).json();await question.getByRole('button',{name:'Remove question-evidence.txt',exact:true}).waitFor();
    await question.getByRole('button',{name:'Cancel',exact:true}).click();await until(async()=>!(await question.evaluate(el=>el.open)),'Cancel collapses native panel');assert.equal(posts.length,0);
    if(notificationEntry){await page.getByRole('button',{name:/^Notifications(?:,|$)/}).click();await page.getByRole('button',{name:'Answer Question',exact:true}).first().click();}else await question.locator('summary').click();await expectFocus(answer,page);assert.equal(await answer.inputValue(),draft);
    const composer=page.locator('.ponderosa-composer');row.geometry={panel:await panel.boundingBox(),composer:await composer.boundingBox()};assert(row.geometry.panel.y+row.geometry.panel.height<=row.geometry.composer.y+1,'Bottom panel stays above composer');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal page overflow');
    await page.screenshot({animations:'disabled',path:path.join(out,row.name+'-draft.png')});
    await until(async()=>{const result=f.ok(await f.api('GET',`${prefix}/conversations/${encodeURIComponent('agent:'+agent.id)}/draft?ownerId=${asked.id}`));return result.text===draft&&result.attachmentIds.includes(asset.id);},'same canonical draft and file retained');
    await page.reload({waitUntil:'domcontentloaded'});await question.waitFor();await question.getByRole('button',{name:'Answer',exact:true}).click();await answer.waitFor();await until(async()=>!(await answer.isDisabled()),'restored draft ready');assert.equal(await answer.inputValue(),draft);await question.getByRole('button',{name:'Remove question-evidence.txt',exact:true}).waitFor();
    await question.getByRole('button',{name:'Send Response',exact:true}).click();await until(()=>posts.length===1,'single existing response dispatch');
    await until(async()=>f.ok(await f.api('GET',`${prefix}/decisions?id=${asked.id}`))[0]?.status==='resolved','exact canonical response');await question.waitFor({state:'hidden'});
    assert.equal(store.sqlite.prepare('SELECT count(*) n FROM agent_activations WHERE dedupe_key=?').get(`message:decision:${asked.id}:response`).n,1,'One existing continuation activation');assert.equal(posts[0].text,draft);assert.deepEqual(posts[0].attachmentIds,[asset.id]);
    const viewQuestion=page.getByRole('button',{name:'View Question',exact:true});
    if(width===390)await viewQuestion.tap();else await viewQuestion.press('Enter');
    const originalQuestion=page.getByRole('dialog',{name:'Original Question'});
    await checkQuestionLinks(page,originalQuestion,width===390,async()=>assert(await originalQuestion.isVisible()));
    assert.deepEqual(browserRequests,[],'Question links never open a hosted browser session');
    row.checks.push('Answered View Question opens both link forms from both fields and remains open');
    assert.deepEqual(row.errors,[]);row.checks.push('Actual owner route, forced Main from Team, inline form and keyboard focus','Cancel/reopen/reload retains canonical text and File','Exact existing response, one continuation, no modal or cross-owner mutation');row.passed=true;console.log('PASS '+row.name);
   }catch(error){row.error=error.stack??String(error);row.fixture=f?.root;if(page){row.dom=(await page.locator('body').innerText()).slice(-4000);await page.screenshot({animations:'disabled',path:path.join(out,row.name+'-FAIL.png')}).catch(()=>{});}throw error;}
   finally{await context?.close();context=undefined;await f?.dispose(false);f=undefined;await save();}
  }
  await browser.close();browser=undefined;
 }
}finally{await context?.close();await browser?.close();await f?.dispose(false);await save();console.log(out);}
async function expectFocus(locator,page){await until(async()=>locator.evaluate(el=>el===document.activeElement),'Visible real editor receives focus');}
