import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {serveFixture} from '../shared/serve-ui-fixture.mjs';

const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const {fixture,until}=await import('../shared/fixture.mjs');
const f=await fixture();
let web,browser;
try{
 web=await serveFixture(f);
 browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/usr/bin/google-chrome',args:['--no-sandbox']});
 for(const mobile of [false,true]){
  const viewport=mobile?{width:390,height:844}:{width:1440,height:900};
  const context=await browser.newContext({viewport,isMobile:mobile,hasTouch:mobile,serviceWorkers:'block',permissions:['clipboard-read','clipboard-write']});
  const page=await context.newPage();
  page.setDefaultTimeout(12000);
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===web.origin?route.continue():route.abort());
  const activate=control=>mobile?control.tap():control.click();
  const button=(name,owner=page)=>owner.getByRole('button',{name,exact:true});
  const text=(name,owner=inspector)=>owner.getByRole('textbox',{name,exact:true});
  const tab=name=>page.getByRole('tab',{name,exact:true});
  const inspector=page.getByRole(mobile?'dialog':'region',{name:'Workflow inspector',exact:true});
  const back=button('Back to workflow',inspector);
  const outline=page.getByRole('region',{name:'Workflow Outline'});
  const selected=page.getByRole('region',{name:'Selected Run'});
  const variablesLink=inspector.getByRole('link',{name:'Settings → Workflow Variables',exact:true});
  const saved=page.getByRole('region',{name:'Workflow Variables',exact:true});
  const get=async url=>f.ok(await f.api('GET',url));
  const post=async(url,body,headers)=>f.ok(await f.api('POST',url,body,headers));
  const reference=(name='report_title')=>'{{parameter:'+name+'}}';
  const initialTitle='Weekly team update',nextTitle='Friday summary';
  async function openVariables(){
   await activate(button('Workflow Actions'));
   await activate(page.getByRole('menuitem',{name:'Workflow variables',exact:true}));
   await inspector.getByRole('heading',{name:'Workflow variables',exact:true}).waitFor();
  }
  async function editStep(label,heading='Step Settings'){
   await activate(outline.getByRole('button',{name:new RegExp('^'+label+' ')}));
   await inspector.getByRole('heading',{name:heading,exact:true}).waitFor();
  }
  async function insert(label,source,start,end,name='report_title'){
   const field=text(label);
   await field.fill(source);
   await field.evaluate((field,[start,end])=>field.setSelectionRange(start,end),[start,end]);
   await activate(button('Insert variable into '+label,inspector));
   const menu=page.getByRole('menu',{name:'Variables for '+label});
   const choice=menu.getByRole('menuitem',{name,exact:true});
   await choice.waitFor();
   assert.equal(await menu.getByRole('menuitem',{name:'service_secret',exact:true}).count(),0);
   if(mobile)await choice.tap();else await choice.press('Enter');
   await field.evaluate((node,caret)=>{
    const boundary=performance.now()+2000;
    return new Promise((resolve,reject)=>{
     function check(){
      if(document.activeElement===node&&node.selectionStart===caret&&node.selectionEnd===caret)resolve();
      else if(performance.now()>boundary)reject(Error('Selection and focus were not returned to the field'));
      else requestAnimationFrame(check);
     }
     check();
    });
   },start+reference(name).length);
   assert.equal(await field.inputValue(),source.slice(0,start)+reference(name)+source.slice(end));
  }
  async function openRun(input){
   await activate(button('Run once'));
   await text('Run Input').fill(input);
   const submit=await inspector.getByRole('button',{name:/^(Run once|Run Published Workflow)$/}).count();
   assert.equal(submit,1);
   await activate(inspector.getByRole('button',{name:/^(Run once|Run Published Workflow)$/}));
  }
  async function waitForGate(prompt){
   await selected.getByText(prompt,{exact:true}).waitFor();
   await button('Approve',selected).waitFor();
   const id=new URL(page.url()).searchParams.get('execution');
   assert.ok(id);
   return id;
  }
  async function completed(id){
   return until(async()=>{
    const {execution}=await get('/api/branch-executions/'+id);
    return execution.state==='completed'&&execution;
   },'Completed workflow '+id,20000);
  }
  try{
   const branch=await post('/api/branches',{name:'Workflow variables '+viewport.width,idempotencyKey:randomUUID()});
   const path='/api/branches/'+branch.id;
   const chat=await post(path+'/chats',{label:'Fixture worker Chat',defaultEngine:'codex'},{'idempotency-key':randomUUID()});
   const agent=await post('/api/branches/engine/projects/'+chat.projectId+'/agents',{title:'Fixture worker',engine:'codex',conversationId:chat.id,idempotencyKey:randomUUID()});
   const script=`const parameters = JSON.parse(process.env.PONDEROSA_PARAMETERS ?? '{}');
let input = '';
for await (const chunk of process.stdin) input += chunk;
process.stdout.write(JSON.stringify({input, cwd:process.cwd(), parameters}));`;
   const initial=await post('/api/branches/deploy',{branchId:branch.id,chatId:'',expectedVersionId:'',idempotencyKey:randomUUID(),
    definition:{schema:'ponderosa.branch.v1',name:branch.name,trigger:{kind:'manual'},entry:'review',
     parameters:{count:{type:'number',default:7.5},include_details:{type:'boolean',default:false},folder:{type:'path',default:f.root},missing:{type:'text'},service_secret:{type:'secret'}},
     steps:[
      {id:'review',kind:'human_gate',label:'Review request',prompt:'Review the draft',editable:false},
      {id:'script',kind:'script',label:'Compose report',runtime:'node',cwdRef:'workspace',timeoutMs:5000,source:script},
      {id:'notify',kind:'action',action:'notify',label:'Notify team',configRefs:[]},
      {id:'worker',kind:'agent',label:'Fallback report',target:{kind:'persistent_agent',ref:'worker'},instructions:'Draft a report titled “”.'}
     ],controls:[{id:'match',kind:'condition',label:'Match starting input',predicate:{source:'input',equals:'Original title'},otherwise:'worker'}],
     edges:[{id:'approved',from:'review',to:'match',on:'approved'},{id:'matched',from:'match',to:'script',on:'selected',input:{kind:'literal',text:'Report: '}},{id:'unmatched',from:'match',to:'worker',on:'failure'},
      {id:'send',from:'script',to:'notify',on:'success',input:{kind:'literal',text:'Ready: '}}],
     policy:{maxConcurrentExecutions:2,failure:{action:'stop'}}},bindings:{agents:{worker:agent.id},directories:{workspace:f.root}}});
   await page.goto(web.origin+'/branches?branch='+branch.id);
   await activate(button('Outline'));
   await openVariables();
   await inspector.getByText('Set a value once and reuse it in this workflow.',{exact:true}).waitFor();
   await inspector.getByText('Draft a report titled “'+reference()+'”.',{exact:true}).waitFor();
   assert.equal(await inspector.getByRole('combobox',{name:'Type for include_details'}).innerText(),'Yes/No');
   assert.equal(await inspector.getByRole('combobox',{name:'Type for folder'}).innerText(),'File or folder path');
   await inspector.getByText('A path names a location. A step must open it to read its contents.',{exact:true}).waitFor();
   const name=text('Variable name');
   await name.fill('not valid');
   assert.equal(await button('Add variable',inspector).isDisabled(),true);
   await name.fill('report_title');
   const nameBox=await name.boundingBox();
   assert.ok(nameBox.width>=220&&nameBox.x+nameBox.width<=viewport.width);
   await activate(button('Add variable',inspector));
   await activate(inspector.getByRole('checkbox',{name:'Use a default for report_title',exact:true}));
   await text('Default for report_title').fill(initialTitle);

   await activate(variablesLink);
   await page.waitForURL(url=>url.searchParams.get('section')==='variables');
   await saved.waitFor();
   assert.equal(await text('report_title',saved).count(),0,'Draft definitions must be published before saved values can be edited');
   await page.goBack();
   await inspector.getByRole('heading',{name:'Workflow variables',exact:true}).waitFor();
   assert.equal(await text('Default for report_title').inputValue(),initialTitle);
   await activate(back);

   await editStep('Review request');
   await insert('Review Prompt','Review [draft].',8,13);
   await activate(back);
   await editStep('Match starting input','Condition');
   await insert('Comparison value','old text',0,8);
   await activate(button('Advanced',inspector));
   await insert('Explicit Input','Report: ',8,8);
   await activate(back);
   await editStep('Compose report');
   assert.equal(await button('Insert variable into Script',inspector).count(),0);
   await activate(button('Advanced',inspector));
   await activate(button('Copy Code',inspector));
   const example=await page.evaluate(()=>navigator.clipboard.readText());
   assert.match(example,/JSON\.parse\(process\.env\.PONDEROSA_PARAMETERS/);
   await insert('Working Directory',f.root,0,f.root.length,'folder');
   await inspector.getByText('This is the text the Notification sends.',{exact:true}).waitFor();
   await insert('Explicit Input','Ready: ',7,7);
   await activate(back);
   await activate(outline.locator('summary').filter({hasText:'Fallback report'}));
   await editStep('Fallback report');
   await insert('Agent Instructions','Draft a report titled “”.',23,23);
   await activate(back);

   async function publishAfter(versionId){
    await activate(button('Review changes',outline));
    await activate(button('Publish workflow',inspector));
    const published=await until(async()=>{const current=await get(path);return current.versionId!==versionId&&current;},'Published variable definitions');
    await inspector.waitFor({state:'hidden'});
    return published;
   }
   const published=await publishAfter(initial.versionId);
   const version=await get(path+'/versions/'+published.versionId);
   assert.equal(version.definition.steps.find(step=>step.id==='worker').instructions,'Draft a report titled “'+reference()+'”.');
   assert.equal(version.definition.steps.find(step=>step.id==='script').source,script);

   await openRun(initialTitle);
   const original=await waitForGate('Review ['+initialTitle+'].');
   await activate(tab('Workflow'));
   await openVariables();
   await text('Help for report_title').fill('Keep this unpublished workflow edit');
   await activate(variablesLink);
   const value=text('report_title',saved);
   assert.equal(await value.inputValue(),initialTitle);
   await value.fill(nextTitle);
   await saved.getByRole('spinbutton',{name:'count',exact:true}).fill('12.25');
   await activate(saved.getByRole('checkbox',{name:'include_details',exact:true}));
   await activate(button('Save Variables',saved));
   await until(async()=>(await get(path+'/settings')).configuration.parameters.report_title===nextTitle,'Saved variable value');
   await activate(tab('Workflow'));
   assert.equal(await text('Help for report_title').inputValue(),'Keep this unpublished workflow edit');
   await activate(back);
   await openRun(nextTitle);
   const fresh=await waitForGate('Review ['+nextTitle+'].');
   await activate(button('Approve',selected));
   await page.goto(web.origin+'/branches?'+new URLSearchParams({branch:branch.id,tab:'executions',execution:original}));
   await waitForGate('Review ['+initialTitle+'].');
   await activate(button('Approve',selected));
   for(const [id,title] of [[original,initialTitle],[fresh,nextTitle]]){
    const result=await completed(id);
    assert.equal(result.versionId,published.versionId);
    assert.equal(result.output,'Ready: '+title);
    const runPath='/api/branch-executions/'+id;
    const detail=await get(runPath);
    const step=detail.steps.find(step=>step.stepId==='script');
    const {result:scriptResult}=await get(runPath+'/steps/'+step.id+'/evidence');
    assert.deepEqual(JSON.parse(scriptResult.output),{input:'Report: '+title,cwd:f.root,parameters:{report_title:title,count:id===original?7.5:12.25,include_details:id===fresh,folder:f.root}});
   }

   const notifications=(await get('/api/branches/engine/notifications?limit=100')).items;
   for(const [id,title] of [[original,initialTitle],[fresh,nextTitle]]){
    assert.ok(notifications.some(item=>item.branchExecutionId===id&&item.body==='Ready: '+title));
   }

   await openRun('Different per-run input');
   const fallback=await waitForGate('Review ['+nextTitle+'].');
   await activate(button('Approve',selected));
   await completed(fallback);
   const turn=f.turns.find(turn=>turn.agentId===agent.id);
   assert.ok(turn,'A different starting input takes the Condition’s otherwise path');
   assert.match(JSON.stringify(turn.input),/Draft a report titled “Friday summary”\./);

   await activate(tab('Workflow'));
   await editStep('Review request');
   await insert('Review Prompt','Missing: ',9,9,'missing');
   await activate(back);
   await publishAfter(published.versionId);
   const before=await get(path+'/executions');
   await openRun(initialTitle);
   await inspector.getByText('Parameter is missing: missing',{exact:true}).waitFor();
   assert.deepEqual((await get(path+'/executions')).map(execution=>execution.id),before.map(execution=>execution.id));
   const empty=await post('/api/branches',{name:'Unpublished variables '+viewport.width,idempotencyKey:randomUUID()});
   await page.goto(web.origin+'/branches?branch='+empty.id);
   await openVariables();
   await activate(variablesLink);
   await saved.getByText('Publish a workflow with variables to edit saved values here.',{exact:true}).waitFor();
   assert.deepEqual(errors,[]);
   console.log('PASS '+viewport.width+'×'+viewport.height+' variable definitions, Settings link and retained draft, five insertion fields and caret, Script copy, Notification input, pinned values, native types, missing values and secret exclusion');
  }catch(error){
   console.error(JSON.stringify({viewport,url:page.url(),errors,visible:(await page.locator('body').innerText()).slice(0,3200)}));
   throw error;
  }finally{await context.close()}
 }
}finally{
 await browser?.close();
 await web?.close();
 await f.dispose();
}
