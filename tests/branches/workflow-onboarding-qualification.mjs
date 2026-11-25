import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {serveFixture} from '../shared/serve-ui-fixture.mjs';
const {fixture,until}=await import('../shared/fixture.mjs');
const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');

const browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
try{
 for(const mobile of [false,true]){
  const f=await fixture({providerInstalled:()=>false,providerAuthStatus:()=>({authenticated:false})});
  const web=await serveFixture(f);
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
  const page=await context.newPage();
  page.setDefaultTimeout(12000);
  const errors=[],requests=[],sampleCommands=[],dialogs=[];
  let firstSampleId;
  page.on('dialog',dialog=>{dialogs.push(dialog.message());void dialog.dismiss()});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.method()==='POST')requests.push(new URL(request.url()).pathname)});
  await context.route('**/*',route=>new URL(route.request().url()).origin===web.origin?route.continue():route.abort());
  await page.route('**/api/branches',async route=>{
   const request=route.request();
   if(request.method()!=='POST'||request.postDataJSON()?.example!=='approval')return route.continue();
   sampleCommands.push(request.postDataJSON().idempotencyKey);
   if(mobile||sampleCommands.length!==1)return route.continue();
   const committed=await route.fetch();
   assert.equal(committed.status(),200);
   firstSampleId=(await committed.json()).id;
   await route.abort('failed');
  });
  const click=handle=>mobile?handle.tap():handle.click();
  const navButton=page.getByRole('button',{name:'Open Workspace Navigation',exact:true});
  const button=(name,owner=page)=>owner.getByRole('button',{name,exact:true});
  const inspector=page.getByRole(mobile?'dialog':'region',{name:'Workflow inspector',exact:true});
  const back=button('Back to workflow',inspector);
  const branchId=()=>new URL(page.url()).searchParams.get('branch');
  const runId=()=>new URL(page.url()).searchParams.get('execution');
  const steps=[];
  try{
   await page.goto(web.origin+'/');
   await page.getByRole('heading',{name:'Home',exact:true}).waitFor();
   if(mobile)await click(navButton);
   await click(page.getByRole('link',{name:'Workflows',exact:true}));
   await page.waitForURL(web.origin+'/branches');
   await page.getByRole('heading',{name:'Workflows',exact:true}).last().waitFor();
   const example=button('Try an example');
   await example.waitFor();
   assert.ok((await example.getAttribute('class')).includes('MuiButton-contained'));
   await click(example);
   if(!mobile){
    await button('Retry creation').waitFor();
    await click(button('Retry creation'));
    assert.equal(sampleCommands.length,2);
    assert.equal(sampleCommands[0],sampleCommands[1]);
   }
   await page.getByRole('heading',{name:'Approve a sample request',exact:true}).waitFor();
   const sampleId=branchId(),samplePath=`/api/branches/${sampleId}`;
   if(!mobile)assert.equal(sampleId,firstSampleId);
   const branch=f.ok(await f.api('GET',samplePath));
   assert.ok(branch.enabled&&branch.versionId);
   assert.equal(branch.chatId,'');
   assert.deepEqual(f.ok(await f.api('GET',samplePath+'/configuration')),{agents:{},directories:{}});
   assert.deepEqual(f.ok(await f.api('GET',samplePath+'/executions')),[]);
   const versions=f.ok(await f.api('GET',samplePath+'/versions'));
   assert.equal(versions.length,1);
   assert.equal(f.ok(await f.api('GET',samplePath+'/versions/'+branch.versionId)).definition.trigger.kind,'manual');
   assert.equal(requests.filter(path=>path.endsWith('/executions')).length,0);
   steps.push('Home → Workflows → Try an example');

   await click(button('Run once'));
   await button('Run once',inspector).waitFor();
   await inspector.getByText('Optional. Leave blank if this workflow needs no input.',{exact:true}).waitFor();
   assert.equal(await inspector.getByRole('textbox',{name:'Run Input'}).evaluate(node=>node===document.activeElement),false);
   await click(button('Run once',inspector));
   await page.waitForURL(url=>url.searchParams.has('execution'));
   const executionId=runId(),details=page.getByRole('region',{name:'Selected Run'});
   const approve=button('Approve',details);
   await approve.waitFor();
   assert.equal(await approve.isEnabled(),true);
   if(mobile)await approve.tap({trial:true});else await approve.click({trial:true});
   await click(approve);
   const completed=await until(async()=>{
    const detail=f.ok(await f.api('GET',`/api/branch-executions/${executionId}`));
    return detail.execution.state==='completed'&&detail;
   },'sample completion');
   assert.equal(completed.execution.state,'completed');
   assert.equal(completed.steps[0].result.output,'Sample request approved');
   await approve.waitFor({state:'hidden'});
   await details.getByText('Sample request approved',{exact:true}).waitFor();
   assert.equal(f.turns.length,0);
   steps.push('Run once → Approve on arrival → Result');
   assert.equal(requests.filter(path=>path===samplePath+'/executions').length,1);
   assert.equal(requests.filter(path=>path.endsWith('/resolve')).length,1);

   if(mobile)await click(navButton);
   const navigation=page.getByRole('complementary',{name:'Workflows Navigation'});
   await click(button('New Workflow',navigation));
   await page.getByRole('heading',{name:'Untitled Workflow',exact:true}).waitFor();
   const blankId=branchId();
   assert.notEqual(blankId,sampleId);
   await click(button('Run once'));
   await page.getByRole('menu').getByText('First Step',{exact:true}).waitFor();
   await click(page.getByRole('menuitem',{name:'Agent Task',exact:true}));
   const instructions=inspector.getByRole('textbox',{name:'Agent Instructions'});
   await instructions.fill('Keep this draft when I check providers.');
   await inspector.getByText(/Agent steps require/).waitFor();
   assert.equal(await inspector.getByRole('link',{name:'Provider settings',exact:true}).getAttribute('href'),`/branches?branch=${blankId}&settings=providers`);
   await click(inspector.getByRole('link',{name:'Provider settings',exact:true}));
   await page.waitForURL(url=>url.searchParams.get('settings')==='providers');
   await click(button('Back to step settings'));
   await instructions.waitFor();
   assert.equal(branchId(),blankId);
   assert.equal(await instructions.inputValue(),'Keep this draft when I check providers.');
   await back.click();
   const canvas=page.getByRole('region',{name:'Workflow Canvas'});
   await click(button('Undo',canvas));
   await click(button('Undo',canvas));
   await click(button('Add your first step',canvas));
   await click(page.getByRole('menuitem',{name:'Approval',exact:true}));
   await back.click();
   await click(button('Review changes',canvas));
   await inspector.getByText('This workflow starts only when you choose Run once.',{exact:true}).waitFor();
   await click(button('Publish workflow',inspector));
   await inspector.waitFor({state:'hidden'});
   await page.waitForFunction(()=>document.activeElement?.textContent==='Run once');
   assert.equal(await button('Run once').isEnabled(),true);
   steps.push('Empty Run once → first step; provider settings → same draft and step; manual review → Run once');

   const file=(name,content)=>({name,mimeType:'application/json',buffer:Buffer.from(content)});
   const choose=async(control,value)=>{
    const picking=page.waitForEvent('filechooser');
    await click(control);
    await (await picking).setFiles(value);
   };
   if(mobile)await click(navButton);
   await choose(button('Import Workflow',navigation),file('broken.json','{"unfinished"'));
   const error=page.getByRole('alert').filter({hasText:'broken.json'});
   await error.getByText(/Could not parse the workflow JSON/).waitFor();
   assert.equal(await page.getByRole('dialog',{name:'Import Workflow',exact:true}).count(),0);
   const script=(id,cwdRef)=>({id,kind:'script',runtime:'node',source:'process.stdout.write("fixture")',cwdRef,timeoutMs:1000});
   const pkg={schema:'ponderosa.branch-installation.v1',packageId:'onboarding-fixture',mode:'template',exportedAt:new Date().toISOString(),chats:[],agentBindings:{},definition:{
    schema:'ponderosa.branch.v1',name:'Check import folders',trigger:{kind:'manual'},entry:'first',controls:[],
    steps:[script('first','source'),script('second','target')],edges:[{id:'next',from:'first',to:'second',on:'success'}],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}},
   }};
   await choose(button('Choose another file',error),file('workflow.json',JSON.stringify(pkg)));
   const dialog=page.getByRole('dialog',{name:'Import Workflow',exact:true});
   const review=button('Review Changes',dialog);
   const first=dialog.getByRole('textbox',{name:'Working Folder: source'}),second=dialog.getByRole('textbox',{name:'Working Folder: target'});
   await first.waitFor();
   assert.equal(await review.isDisabled(),true);
   await first.fill(f.root);
   assert.equal(await review.isDisabled(),true);
   assert.equal(requests.filter(path=>path.endsWith('/install-preview')).length,0);
   const missing=join(f.root,'missing-folder');
   await second.fill(missing);
   await click(review);
   await dialog.getByText('Choose an existing, accessible working folder on this host. Check the path and permissions.').waitFor();
   assert.equal(await first.inputValue(),f.root);
   assert.equal(await second.inputValue(),missing);
   assert.equal(await second.getAttribute('aria-invalid'),'true');
   assert.equal(await button('Confirm Import',dialog).count(),0);
   await second.fill(f.root);
   await click(review);
   await button('Confirm Import',dialog).waitFor();
   assert.equal(requests.filter(path=>path.endsWith('/install-preview')).length,2);
   await click(button('Back',dialog));
   assert.equal(await first.inputValue(),f.root);
   assert.equal(await second.inputValue(),f.root);
   steps.push('Invalid file blocks import; missing paths block review; invalid path has field feedback; Back retains both paths');
   assert.deepEqual(dialogs,[]);
   assert.deepEqual(errors,[]);
   console.log(JSON.stringify({viewport:mobile?'390×844':'1440×900',passed:true,steps}));
  }catch(error){
   console.error(JSON.stringify({url:page.url(),dialogs,errors,visible:(await page.locator('body').innerText()).slice(-2200)}));
   throw error;
  }finally{
   await context.close();
   await web.close();
   await f.dispose();
  }
 }
}finally{await browser.close()}
