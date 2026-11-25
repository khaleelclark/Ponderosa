import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
const {fixture,until}=await import('../shared/fixture.mjs');
import {serveFixture} from '../shared/serve-ui-fixture.mjs';

const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const f=await fixture();
let browser,web;
const post=async(path,body)=>f.ok(await f.api('POST',path,body));
const evidence={records:Array.from({length:60},(_,index)=>({index,text:'x'.repeat(120)})),last:'End of pinned evidence'};
const raw=JSON.stringify(evidence).replace('"index":0','"index":9007199254740993123');
const markdown='# Behavior report\n\n'+Array.from({length:45},(_,index)=>`## Observation ${index+1}\n\nA readable result for this part of the report.\n\n`).join('')+'Last conclusion stays readable.';
const script=(id,label,source)=>({id,label,kind:'script',runtime:'node',cwdRef:'workspace',timeoutMs:5000,source});
const emit=(id,label,text)=>script(id,label,`process.stdout.write(${JSON.stringify(text)});`);
const auditSteps=[emit('fetch','Fetch pinned GitHub evidence',raw),emit('archive','Original Evidence',raw)];
const gate={id:'review',label:'Review evidence',kind:'human_gate',prompt:'Review the retained evidence.',editable:true};
async function publish(name,steps,edges,controls=[],entry=steps[0].id){
 const owner=await post('/api/branches',{name,idempotencyKey:randomUUID()});
 return post('/api/branches/deploy',{branchId:owner.id,chatId:owner.chatId,expectedVersionId:owner.versionId,idempotencyKey:randomUUID(),
  definition:{schema:'ponderosa.branch.v1',name,entry,trigger:{kind:'manual'},steps,controls,edges,policy:{maxConcurrentExecutions:2,failure:{action:'stop'}}},
  bindings:{agents:{},directories:{workspace:f.root}}});
}
const edge=(from,to)=>({id:`${from}-${to}`,from,to,on:'success'});
const run=(branch,input)=>post(`/api/branches/${branch.id}/executions`,{input,occurrenceKey:randomUUID()});
const read=(id,suffix='')=>f.api('GET',`/api/branch-executions/${id}${suffix}`).then(f.ok);
const settled=(id,state)=>until(async()=>{const detail=await read(id);return detail.execution.state===state&&detail;},state,20000);
try{
 const completed=await publish('Behavior report and evidence',[...auditSteps,emit('report','Write behavior report',markdown)],[edge('fetch','archive'),edge('archive','report')]);
 const canceled=await publish('Interrupted behavior report',[...auditSteps,gate],[edge('fetch','archive'),edge('archive','review')]);
 const approvedJson=JSON.stringify({decision:'User-approved final result',details:'x'.repeat(200),literal:'Markdown **stays literal**, as does \\n.'},null,2).replace('  "details"', '  "number": 9007199254740993123,\n  "details"');
 const previewPrefix='# Distinct reports\n\n'+'Shared prefix '.repeat(16);
 const reviewed=await publish('Approve an exact structured result',[
  emit('one','First report',previewPrefix+' FIRST exact tail'),emit('two','Second report',previewPrefix+' SECOND exact tail'),
  emit('same','Script JSON matching edited result',approvedJson),gate,
 ],[edge('one','two'),edge('two','same'),{...edge('same','review'),input:{kind:'literal',text:'Replace this initial proposal.'}}]);
 const technicalOnly=await publish('A run with technical JSON only',[auditSteps[0]],[]);
 const technicalRun=await run(technicalOnly,'Archive structured script output.');
 assert.equal((await settled(technicalRun.id,'completed')).executionOutputTechnical,true);
 const joinedText='# Joined evidence\n\n'+'A complete paragraph in the joined output.\n\n'.repeat(160)+'Final joined paragraph';
 const joined=await publish('Joined Markdown output',[emit('worker','Generate evidence',joinedText)],[
  {id:'item',from:'map',to:'worker',on:'selected'},edge('worker','join'),
 ],[
  {id:'map',label:'For Each evidence',kind:'map',joinId:'join',workerId:'worker',source:'list',maxItems:2,maxConcurrentItems:2},
  {id:'join',kind:'join',forkId:'map',mode:'all',remainder:'finish',inputOrder:[]},
 ],'map');
 const joinedRun=await run(joined,JSON.stringify(['exact-search-one','exact-search-two']));
 const joinedDetail=await settled(joinedRun.id,'completed');
 assert.match(joinedDetail.execution.output,/^branch-result-bundle:/);
 const bundle=await read(joinedRun.id,'/result-bundles/'+joinedDetail.execution.output.split(':')[2]);
 assert.ok(bundle.content.endsWith('Final joined paragraph'));
 const errorText='Review could not finish because the input manifest was missing.';
 const failed=await publish('Recover a failed script',[{...script('failed','Verify manifest',`process.stdout.write('Diagnostic sample from process '+process.pid); process.stderr.write(${JSON.stringify(errorText)}); process.exitCode=7;`),failure:{action:'retry',maxAttempts:2,delayMs:0}}],[]);
 const completeRun=await run(completed,'Compare the accepted behavior.');
 const complete=await settled(completeRun.id,'completed');
 assert.equal(complete.executionOutputTruncated,true);
 assert.equal(complete.steps.find(step=>step.stepId==='report').resultInRun,true);
 web=await serveFixture(f);
 browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block',permissions:['clipboard-read','clipboard-write']});
  const page=await context.newPage();page.setDefaultTimeout(12000);
  const errors=[];page.on('pageerror',error=>{errors.push(error.message);console.error(error.stack)});
  await page.route('**/*',route=>new URL(route.request().url()).origin===web.origin?route.continue():route.abort());
  const activate=locator=>mobile?locator.tap():locator.click();
  const selected=page.getByRole('region',{name:'Selected Run'});
  const history=page.getByRole('region',{name:'Run History'});
  const results=selected.getByRole('region',{name:'Results'});
  const tray=selected.getByRole('complementary',{name:'Step details',exact:true});
  const button=(name,owner=selected)=>owner.getByRole('button',{name,exact:true});
  const row=name=>button('Details for '+name);
  const technical=selected.locator('summary').filter({hasText:/^Technical Details/});
  const open=(branch,id)=>page.goto(`${web.origin}/branches?branch=${branch.id}&tab=executions&execution=${id}`);
  const back=()=>activate(button(mobile?'Back to Steps':'Close',tray));
  const readToEnd=async last=>{
   await last.waitFor();
   assert.equal(await last.evaluate(node=>{
    for(let element=node.parentElement;element&&!element.matches('[aria-label="Selected Run"]');element=element.parentElement)
     if(/^(auto|scroll)$/.test(getComputedStyle(element).overflowY)&&element.scrollHeight>element.clientHeight)return true;
    return false;
   }),false);
   await last.scrollIntoViewIfNeeded();
   assert.ok(await last.evaluate(node=>{
    const rect=node.getBoundingClientRect(),owner=node.closest('[aria-label="Selected Run"]'),viewport=owner.getBoundingClientRect();
    return owner.scrollTop>300&&rect.top>=viewport.top&&rect.bottom<=viewport.bottom;
   }),'The run scrolls to the last paragraph');
  };
  try{
   const approvalRun=await run(reviewed,'Enter the final structured decision.');
   await open(reviewed,approvalRun.id);
   const proposed=selected.getByRole('textbox',{name:'Proposed Result'});
   await proposed.fill(approvedJson);
   await activate(button('Approve Edited Text'));
   const approved=await settled(approvalRun.id,'completed');
   const scriptStep=approved.steps.find(step=>step.stepId==='same'),humanStep=approved.steps.find(step=>step.stepId==='review');
   assert.equal(approved.executionOutputTechnical,undefined);
   assert.equal(scriptStep.resultOutputTechnical,true);
   assert.equal(humanStep.resultOutputTechnical,undefined);
   assert.equal((await read(approvalRun.id,'/result')).output,approvedJson);
   assert.equal((await read(approvalRun.id,'/steps/'+humanStep.id+'/evidence')).result.output,approvedJson);
   const [firstReport,secondReport]=approved.steps;
   assert.equal(firstReport.result.output,secondReport.result.output);
   await activate(button('View result for Review evidence'));
   const finalOutput=results.locator('#branch-run-output:focus');
   await finalOutput.getByText(/9007199254740993123/).waitFor();
   assert.equal(await finalOutput.locator('.chat-code-block').count(),1);
   await activate(button('Copy Code',finalOutput));
   await until(()=>page.evaluate(async expected=>(await navigator.clipboard.readText())===expected,approvedJson),'copy exact approved JSON');
   for(const [step,label,tail] of [[firstReport,'First report','FIRST'],[secondReport,'Second report','SECOND']]){
    await activate(button('View result for '+label));
    const linked=results.locator('#branch-result-'+step.id);
    await linked.and(page.locator(':focus')).waitFor();
    await activate(button('Read full result',linked));
    await linked.getByText(new RegExp(tail+' exact tail')).waitFor();
    assert.equal(await linked.getByText(new RegExp((tail==='FIRST'?'SECOND':'FIRST')+' exact tail')).count(),0);
   }
   await activate(row('Review evidence'));
   await button('View result',tray).waitFor();
   assert.equal(await tray.locator('.chat-code-block').count(),0);
   await activate(button('View result',tray));
   await finalOutput.waitFor();

   await activate(row('Script JSON matching edited result'));
   await tray.getByText(/9007199254740993123/).waitFor();
   assert.equal(await tray.locator('.chat-code-block').count(),1);
   assert.equal(await tray.locator('summary').filter({hasText:/^Stdout$/}).count(),0);
   await back();

   await open(technicalOnly,technicalRun.id);
   await selected.getByText('No readable result was produced.',{exact:false}).waitFor();
   assert.equal(await results.count(),0);

   await open(joined,joinedRun.id);
   const joinedOutput=results.locator('#branch-run-output');
   await joinedOutput.getByText('[1: exact-search-one]',{exact:true}).waitFor();
   await joinedOutput.getByText('[2: exact-search-two]',{exact:true}).waitFor();
   assert.equal(await joinedOutput.getByText('Final joined paragraph',{exact:true}).count(),2);
   assert.equal(await button('Show Full Message',joinedOutput).count(),0);
   await readToEnd(joinedOutput.getByText('Final joined paragraph',{exact:true}).last());
   await activate(technical);
   await selected.getByRole('textbox',{name:/Search Item|Find Item/}).fill('exact-search-two');
   await selected.getByText('1 matching items across this execution',{exact:true}).waitFor();
   await selected.getByText('Run Input',{exact:true}).waitFor();

   await open(completed,completeRun.id);
   await results.getByRole('heading',{name:'Behavior report',exact:true}).waitFor();
   assert.equal(await results.getByRole('heading',{name:'Behavior report',exact:true}).count(),1);
   await readToEnd(results.getByText('Last conclusion stays readable.',{exact:true}));
   assert.equal(await results.getByText('End of pinned evidence').count(),0);
   await activate(button('View result for Write behavior report'));
   await selected.locator('#branch-run-output:focus').waitFor();

   const fetchRow=row('Fetch pinned GitHub evidence');
   await fetchRow.scrollIntoViewIfNeeded();
   const savedScroll=await selected.evaluate(node=>node.scrollTop);
   await activate(fetchRow);
   await tray.getByText('Attempt 1 · completed',{exact:true}).waitFor();
   const pre=tray.locator('.chat-code-block code:visible');
   await pre.waitFor();
   assert.equal(await pre.count(),1);
   assert.match(await pre.innerText(),/\n\s+"records": \[/);
   assert.match(await pre.innerText(),/9007199254740993123/);
   assert.match(await pre.innerText(),/End of pinned evidence/);
   assert.equal(await tray.locator('summary').filter({hasText:/^Stdout$|^Stderr$/}).count(),0);
   const scroll=await tray.evaluate(node=>({wide:node.scrollWidth>node.clientWidth,overflow:getComputedStyle(node).overflowY,within:node.getBoundingClientRect().width/node.closest('[aria-label="Selected Run"]').clientWidth,inner:Array.from(node.querySelectorAll('*')).filter(child=>child.scrollHeight>child.clientHeight+16&&/^(auto|scroll)$/.test(getComputedStyle(child).overflowY)).length}));
   assert.equal(scroll.wide,false);assert.equal(scroll.inner,0);
   assert.equal(mobile,scroll.within>0.9);
   assert.equal(scroll.overflow,mobile?'visible':'auto');
   assert.ok(await pre.evaluate(node=>{const element=node.closest('[tabindex="0"]');return element&&element.scrollWidth>element.clientWidth}));
   await activate(button('Copy Code',tray));
   await until(()=>page.evaluate(async expected=>(await navigator.clipboard.readText())===expected,raw),'copy exact evidence');
   if(!mobile){
    await activate(row('Write behavior report'));
    await tray.getByText('Write behavior report',{exact:true}).waitFor();
    await button('View result',tray).waitFor();
    assert.equal(await tray.locator('.chat-code-block:visible').count(),0);
    await back();
    await row('Write behavior report').and(page.locator(':focus')).waitFor();
   }else{
    assert.equal(await button('Back to Run History').isVisible(),false);
    await back();
    await fetchRow.and(page.locator(':focus')).waitFor();
    assert.ok(Math.abs(await selected.evaluate(node=>node.scrollTop)-savedScroll)<2,'Back restores the run scroll');
    await activate(button('Back to Run History'));
    await history.locator('[aria-current="true"]:focus').waitFor();
    await activate(history.locator('[aria-current="true"]'));
   }
   await activate(technical);
   const full=selected.getByRole('link',{name:'Open Full Evidence (JSON)',exact:true});
   const bounds=await Promise.all([button('Copy Run ID').boundingBox(),full.boundingBox(),button('Recovery options').boundingBox()]);
   assert.ok(bounds.every(rect=>rect&&rect.width<230),'Technical actions are compact');
   assert.equal(await button('Review Saved Work').isVisible(),false);
   const popup=context.waitForEvent('page');
   await activate(full);
   const fullPage=await popup;await fullPage.waitForLoadState();
   assert.match(fullPage.url(),new RegExp(`${completeRun.id}/full-detail`));
   await fullPage.close();
   await activate(button('Recovery options'));
   for(const [name,destination,content] of [
    ['Review Saved Work','Review Saved Work','Choose a checkpoint'],
    ['Review Resource Group','Resource Group','Preview which Chats and Agents'],
    ['Review Fresh Destination','Fresh Destination Review','No fresh destinations have been prepared'],
   ]){
    await activate(button(name));
    const dialog=page.getByRole('dialog',{name:destination,exact:true});await dialog.getByText(new RegExp(content)).waitFor();
    await activate(dialog.getByText('Close',{exact:true}));await dialog.waitFor({state:'hidden'});
   }

   const original=await run(canceled,'Original canceled input');
   await until(async()=>{const detail=await read(original.id);return detail.gates.some(gate=>gate.state==='waiting');},'archived steps finish before cancellation',20000);
   await post(`/api/branch-executions/${original.id}/cancel`);
   const archived=await settled(original.id,'canceled');assert.equal(archived.execution.waitReason,undefined);
   await open(canceled,original.id);
   await button('Run again with edited input').waitFor();
   await selected.getByText('No readable result was produced.',{exact:false}).waitFor();
   assert.equal(await results.count(),0);
   for(const name of ['Fetch pinned GitHub evidence','Original Evidence']){
    await activate(row(name));
    await tray.locator('.chat-code-block code:visible').waitFor();
    assert.equal(await tray.locator('.chat-code-block code:visible').count(),1);
    await back();
   }
   await activate(button('Run again with edited input'));
   const rerun=page.getByRole(mobile?'dialog':'region',{name:'Workflow inspector'});
   const input=rerun.getByRole('textbox',{name:'Run Input',exact:true});
   assert.equal(await input.inputValue(),'Original canceled input');
   await input.fill('Edited follow-up input');
   const posted=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith(`/api/branches/${canceled.id}/executions`));
   await activate(button('Start new run',rerun));
   const again=await (await posted).json();assert.notEqual(again.id,original.id);assert.equal(again.input,'Edited follow-up input');
   assert.equal((await read(original.id)).execution.state,'canceled');

   const failure=await run(failed,'Verify the manifest');
   const stopped=await settled(failure.id,'failed');assert.equal(stopped.attempts.length,2);
   await open(failed,failure.id);
   await button('Retry Step').waitFor();
   await selected.getByText(/Script exited with code 7/).first().waitFor();
   await activate(button('Inspect Details'));
   const attempts=['Attempt 1','Attempt 2'].map(name=>tray.getByRole('region',{name,exact:true}));
   await attempts[1].waitFor();
   const stdout=[];
   for(const attempt of attempts){
    await activate(attempt.locator('summary').filter({hasText:/^Stdout$/}));
    stdout.push(await attempt.getByText(/^Diagnostic sample from process /).innerText());
   }
   assert.notEqual(stdout[0],stdout[1]);
   const stderr=attempts[1].locator('summary').filter({hasText:/^Stderr$/});
   await stderr.waitFor();
   assert.equal(await tray.getByText(errorText,{exact:true}).isVisible(),false);
   await activate(stderr);await tray.getByText(errorText,{exact:true}).waitFor();
   await back();await button('Inspect Details').and(page.locator(':focus')).waitFor();
   await activate(button('Retry Step'));
   const confirmation=page.getByRole('dialog',{name:'Retry This Step'});
   await confirmation.getByRole('textbox',{name:'Reason For This Decision'}).fill('Retain previous attempt and retry the fixture.');
   const retried=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith(`/api/branch-executions/${failure.id}/intervene`));
   await activate(button('Apply Decision',confirmation));
   assert.equal((await retried).ok(),true);
   await until(async()=>{const detail=await read(failure.id);return detail.execution.state==='failed'&&detail.attempts.length>2;},'a distinct canonical retry attempt',20000);
   assert.deepEqual(errors,[]);
   console.log(`${mobile?'390 × 844':'1440 × 900'} passed: approved JSON and exact copy, distinct result links, full joined and ordinary Markdown, step evidence, Technical Details, canceled rerun and retry confirmation`);
  }catch(error){await page.screenshot({path:`${f.root}/execution-results-${mobile?'phone':'desktop'}-failure.png`});throw error;}finally{await context.close();}
 }
}finally{await browser?.close();await web?.close();await f.dispose(false);}
