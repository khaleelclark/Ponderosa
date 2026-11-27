import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const {fixture,until}=await import('../shared/fixture.mjs');
import {serveFixture} from '../shared/serve-ui-fixture.mjs';

const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const f=await fixture();
const write=async(path,body)=>f.ok(await f.api('POST',path,body));
const read=async id=>f.ok(await f.api('GET','/api/branch-executions/'+id));
let browser,web;
try{
 web=await serveFixture(f);
 browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/usr/bin/google-chrome',args:['--no-sandbox']});
 for(const viewport of [{width:320,height:640},{width:390,height:844}]){
  const phone=viewport.width<400;
  const context=await browser.newContext({viewport,isMobile:phone,hasTouch:phone,serviceWorkers:'block'});
  try{
   const page=await context.newPage();
   page.setDefaultTimeout(15_000);
   const activate=control=>phone?control.tap():control.click();
   await page.route('**/*',route=>new URL(route.request().url()).origin===web.origin?route.continue():route.abort());
   const selected=page.getByRole('region',{name:'Selected Run'});
   const approve=selected.getByRole('button',{name:'Approve',exact:true});
   const reject=selected.getByRole('button',{name:'Reject',exact:true});
   async function arrival(){
    await page.waitForFunction(()=>[...document.querySelectorAll('[aria-label="Selected Run"] button')].some(button=>button.textContent==='Approve'&&!button.disabled));
    const frame=await selected.boundingBox();
    assert.equal(await selected.evaluate(node=>node.scrollTop),0);
    for(const button of [approve,reject]){
     const bounds=await button.boundingBox();
     assert.ok(bounds&&bounds.y>=frame.y&&bounds.y+bounds.height<=Math.min(frame.y+frame.height,viewport.height),JSON.stringify({viewport,bounds,frame}));
    }
   }
   const wait=async(id,state)=>until(async()=>{const detail=await read(id);return detail.execution.state===state&&detail;},state,20_000);
   async function launch(branch,input=''){
    const run=await write('/api/branches/'+branch.id+'/executions',{input,occurrenceKey:randomUUID()});
    await wait(run.id,'waiting');
    await page.goto(web.origin+'/branches?'+new URLSearchParams({branch:branch.id,tab:'executions',execution:run.id}));
    await arrival();
    return run;
   }
   await page.goto(web.origin+'/branches');
   await page.getByRole('heading',{name:'Workflows',exact:true}).waitFor();
   const sample=await write('/api/branches',{example:'approval',idempotencyKey:randomUUID()});
   for(const decision of ['approve','reject']){
    const run=await launch(sample);
    assert.doesNotMatch(await selected.innerText(),/Waiting on a person|waiting for review/i);
    const resolved=page.waitForResponse(res=>res.url().includes('/api/branch-gates/')&&res.request().method()==='POST');
    await activate(decision==='approve'?approve:reject);
    const response=await resolved;
    assert.ok(response.ok(),await response.text());
    const completed=await until(async()=>{const detail=await read(run.id);return detail.gates[0]?.state==='resolved'&&detail;},decision,20_000);
    assert.equal(completed.gates[0].resolution.decision,decision);
    const expected=decision==='approve'?'Sample request approved':'Approval rejected at Review sample request.';
    assert.equal(completed.execution.output,expected);
    await selected.getByRole('region',{name:'Results',exact:true}).getByText(expected,{exact:true}).waitFor();
    await selected.getByText(decision==='approve'?'Review sample request · Approved · Sample request approved':'Review sample request · Rejected',{exact:true}).waitFor();
    assert.equal(await approve.count(),0);
   }

   const scorecard='# Blind scorecard\n\n| Candidate | Hard checks |\n|---|---|\n| A | Passed |\n| B | Failed |\n\nChoose A or **No winner**.\n\n'+
    'Supporting detail for the pinned trial.\n\n'.repeat(55)+'End of scorecard evidence.';
   const prompt='Read the scorecard and choose A or No winner. '+
    'Compare the eligibility criteria before selecting a result. '.repeat(14);
   const promptEnding=' End of review prompt.';
   const longPrompt=prompt.slice(0,800-promptEnding.length)+promptEnding;
   const name='Disposable blind verdict '+viewport.width;
   const owner=await write('/api/branches',{name,idempotencyKey:randomUUID()});
   const benchmark=await write('/api/branches/deploy',{branchId:owner.id,chatId:'',expectedVersionId:'',idempotencyKey:randomUUID(),
    bindings:{agents:{},directories:{}},definition:{schema:'ponderosa.branch.v1',name,entry:'verdict',trigger:{kind:'manual'},controls:[],edges:[],
     steps:[{id:'verdict',label:'Record a blind verdict',kind:'human_gate',prompt:longPrompt,choices:['A','No winner'],editable:false}],
     policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}}});
   const run=await launch(benchmark,scorecard);
   const gate=selected.getByRole('region',{name:'Record a blind verdict'});
   assert.deepEqual(await gate.getByRole('radio').evaluateAll(radios=>radios.map(radio=>radio.value)),['A','No winner']);
   const promptRegion=gate.getByRole('region',{name:'Review prompt'});
   assert.equal(await promptRegion.textContent(),longPrompt);
   const bottom=await promptRegion.evaluate(node=>node.scrollHeight-node.clientHeight);
   assert.ok(bottom>0,'the long prompt scrolls within the card');
   await promptRegion.press('End');
   await page.waitForFunction(({bottom})=>{
    const prompt=document.querySelector('[aria-label="Review prompt"]');
    return Math.abs(prompt.scrollTop-bottom)<=1;
   },{bottom});
   await arrival();
   await activate(gate.getByText('Supporting evidence',{exact:true}));
   await gate.getByRole('table').getByRole('cell',{name:'Failed',exact:true}).waitFor();
   await gate.getByText('End of scorecard evidence.',{exact:true}).waitFor();
   await activate(gate.getByRole('radio',{name:'No winner',exact:true}));
   await activate(approve);
   const completed=await wait(run.id,'completed');
   assert.equal(completed.gates[0].resolution.choice,'No winner');
   assert.equal(completed.execution.output,'No winner');
   await selected.getByRole('region',{name:'Results',exact:true}).getByText('No winner',{exact:true}).waitFor();
   console.log('Short and long approval prompts, both decisions, and Markdown scorecard passed at '+viewport.width+' × '+viewport.height);
  }finally{await context.close()}
 }
}finally{
 await browser?.close();await web?.close();await f.dispose();
}
