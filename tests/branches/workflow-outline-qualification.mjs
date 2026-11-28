import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile,readdir} from 'node:fs/promises';
const {fixture}=await import('../shared/fixture.mjs');
import {serveFixture} from '../shared/serve-ui-fixture.mjs';

const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const assets=new URL('../../apps/web/dist/static/js/async/',import.meta.url);
const chunks=(await readdir(assets)).filter(name=>name.endsWith('.js'));
const canvasChunks=(await Promise.all(chunks.map(async name=>(await readFile(new URL(name,assets),'utf8')).includes('Canvas Viewport')?name:null))).filter(Boolean);
assert.equal(canvasChunks.length,1,'Find the production lazy Canvas script');
const canvasPath='/static/js/async/'+canvasChunks[0];
const f=await fixture();
let web,browser;
const script=(id,label)=>({id,label,kind:'script',runtime:'node',source:'process.stdout.write("fixture")',cwdRef:'workspace',timeoutMs:1000});
const edge=(id,from,to,on='success',extra={})=>({id,from,to,on,...extra});
try{
 web=await serveFixture(f);
 browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
  const page=await context.newPage();
  page.setDefaultTimeout(8000);
  const pageErrors=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  await context.route('**/*',route=>new URL(route.request().url()).origin===web.origin?route.continue():route.abort());
  let releaseCanvas;
  const holdCanvas=()=>new Promise(resolve=>{releaseCanvas=resolve});
  let heldCanvas=holdCanvas();
  await context.route(web.origin+canvasPath,async route=>{
   await heldCanvas;
   await route.continue().catch(()=>{});
  });
  // ELK stays pending until the test switches back, then its next layout attempt fails.
  await context.addInitScript(()=>{
   const NativeWorker=window.Worker;
   window.Worker=class extends NativeWorker {
    constructor(url,options){
     if(!window.useRealOutlineLayout&&new URL(url).pathname.startsWith('/static/js/async/')){
      if(window.failOutlineLayout)throw Error('Fixture layout failure');
      const idle=URL.createObjectURL(new Blob(['onmessage = () => {}'],{type:'text/javascript'}));
      super(idle,options);
      URL.revokeObjectURL(idle);
      return;
     }
     super(url,options);
    }
   };
  });
  try{
   const name=mobile?'Phone Outline':'Desktop Outline';
   const branch=f.ok(await f.api('POST','/api/branches',{name,idempotencyKey:randomUUID()}));
   const tail=Array.from({length:14},(_,i)=>script('tail'+i,'Follow-up '+i));
   const definition={schema:'ponderosa.branch.v1',name,trigger:{kind:'manual'},entry:'condition',
    steps:[...tail,script('right','Second worker'),script('verify','Verify second result'),script('third','Third worker'),script('report','Report failed input'),script('no','Fallback input'),script('yes','Matched input'),script('shared','Shared work'),script('recover','Recover input'),script('left','First worker')],
    controls:[{id:'join',kind:'join',label:'Combine workers',forkId:'fork',mode:'all',remainder:'finish',inputOrder:['left','right','third']},
     {id:'condition',kind:'condition',label:'Check input',predicate:{source:'input',equals:'yes'},otherwise:'no'},{id:'fork',kind:'fork',label:'Run workers',joinId:'join'}],
    edges:[edge('no','condition','no','failure'),edge('right','fork','right','selected'),edge('yes','condition','yes','selected'),edge('yes-next','yes','shared'),edge('no-next','no','shared'),edge('yes-failure','yes','report','failure'),edge('no-failure','no','report','failure'),
     edge('failure','shared','recover','failure'),edge('recover-next','recover','fork'),edge('ready','shared','fork'),edge('left','fork','left','selected'),edge('left-done','left','join'),edge('right-verify','right','verify'),edge('right-done','verify','join'),edge('third-done','third','join'),edge('third','fork','third','selected'),
     edge('finish','join','tail0'),...tail.slice(1).map((node,index)=>edge('after'+index,'tail'+index,node.id)),edge('retry','tail1','tail0','failure',{loop:true})],
    policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
   const initial=f.ok(await f.api('POST','/api/branches/deploy',{branchId:branch.id,chatId:branch.chatId,expectedVersionId:branch.versionId,idempotencyKey:randomUUID(),definition,bindings:{agents:{},directories:{workspace:f.root}}}));
   const url=`${web.origin}/branches?branch=${branch.id}`;
   const canvas=page.getByRole('region',{name:'Workflow Canvas',exact:true});
   const outline=page.getByRole('region',{name:'Workflow Outline',exact:true});
   const view=label=>page.getByRole('button',{name:label,exact:true});
   const row=text=>outline.getByRole('button',{name:new RegExp('^'+text+' (?:Script|Condition|Join|· 3 parallel paths|Human approval)$')});
   const inspector=page.getByRole(mobile?'dialog':'region',{name:'Workflow inspector',exact:true});
   const back=inspector.getByRole('button',{name:'Back to workflow',exact:true});
   const activate=button=>mobile?button.tap():button.press('Enter');
   const scroll=outline.locator('div').first();
   const footer=async(region,label)=>{
    const selector=region.getByRole('group',{name:'Workflow view',exact:true});
    await selector.waitFor();
    assert.equal(await page.getByRole('group',{name:'Workflow view',exact:true}).count(),1);
    assert.equal(await selector.getByRole('button',{name:label,exact:true}).getAttribute('aria-pressed'),'true');
    return selector.evaluate(element=>{
     const bar=element.parentElement,rect=bar.getBoundingClientRect(),control=element.getBoundingClientRect();
     const review=[...bar.querySelectorAll('button')].find(button=>button.textContent==='Review changes');
     const action=review?.getBoundingClientRect();
     if(!action||!bar.querySelector('[aria-label="Undo"]'))throw Error('The selector must share the footer with Undo and Review changes');
     if(![control,action].every(box=>box.left>=rect.left&&box.right<=rect.right&&box.top>=rect.top&&box.bottom<=rect.bottom&&box.bottom<=innerHeight))throw Error('Footer controls must fit in the visible viewport');
     if(rect.right-action.right>13)throw Error('Review changes must stay on the action side');
     return control.left-rect.left;
    });
   };
   const switchTo=async label=>{
    await activate(view(label));
    await page.waitForFunction(label=>document.activeElement?.textContent===label&&document.activeElement?.getAttribute('aria-pressed')==='true',label);
   };
   const request=page.waitForRequest(web.origin+canvasPath);
   await page.goto(url,{waitUntil:'domcontentloaded'});
   await request;
   const loading=page.getByText('Loading Workflow Canvas…',{exact:true});
   await loading.waitFor();
   const workflow=page.getByRole('tabpanel',{name:'Workflow',exact:true});
   const loadingOffset=await footer(workflow,'Canvas');
   const panel=await workflow.boundingBox();
   const tabs=await page.getByRole('tablist',{name:'Workflow Views',exact:true}).boundingBox();
   assert.ok(Math.abs(panel.y-tabs.y-tabs.height)<=2,'Workflow content begins at the tab row');
   await switchTo('Outline');
   assert.equal(await footer(outline,'Outline'),loadingOffset);
   assert.equal((await outline.boundingBox()).y,panel.y,'Outline starts at the top of the Workflow panel');
   await row('Check input').waitFor();
   const path=label=>outline.locator('summary').filter({has:page.getByText(label,{exact:true})});
   const otherwise=path('Otherwise'),matches=path('If it matches');
   const isOpen=summary=>summary.evaluate(node=>node.parentElement.open);
   const toggle=async summary=>{
    await summary.scrollIntoViewIfNeeded();
    const top=(await summary.boundingBox()).y;
    await activate(summary);
    assert.ok(Math.abs((await summary.boundingBox()).y-top)<=2,'The toggled header stays at its viewport position');
    assert.equal(await summary.evaluate(node=>node===document.activeElement),true);
   };
   assert.equal(await row('Fallback input').count(),0,'Secondary path starts collapsed');
   await toggle(matches);
   assert.equal(await isOpen(matches),false);
   await matches.getByText('→ Matched input',{exact:true}).waitFor();
   await otherwise.getByText('→ Fallback input',{exact:true}).waitFor();
   await toggle(otherwise);
   await row('Fallback input').waitFor();
   assert.equal(await isOpen(matches),false,'Sibling expansion stays unchanged');
   await toggle(otherwise);
   await otherwise.getByText('→ Fallback input',{exact:true}).waitFor();
   await toggle(otherwise);
   await toggle(matches);
   await row('Matched input').waitFor();
   assert.equal(await row('Shared work').count(),1);
   assert.equal(await row('Report failed input').count(),1);
   const failedInput=outline.getByRole('button',{name:'On failure → Report failed input',exact:true});
   assert.equal(await failedInput.count(),2);
   assert.equal(await row('Matched input').evaluate(node=>node.parentElement.nextElementSibling.textContent),'On failure → Report failed input');
   await activate(failedInput.last());
   assert.equal(await row('Report failed input').evaluate(node=>node===document.activeElement),true);
   const shared=outline.getByRole('button',{name:'Continue at Shared work',exact:true});
   assert.equal(await shared.count(),2);
   await activate(shared.first());
   assert.equal(await row('Shared work').evaluate(node=>node===document.activeElement),true);

   const matched=row('Matched input');
   await activate(matched);
   const initialName=inspector.getByRole('textbox',{name:'Name',exact:true});
   await initialName.fill('Matched input edited');
   await back.click();
   assert.equal(await row('Matched input edited').getAttribute('aria-pressed'),'true');
   await activate(outline.getByRole('button',{name:'Undo',exact:true}));
   await matched.waitFor();
   await activate(outline.getByRole('button',{name:'Expand Workflow',exact:true}));
   await switchTo('Canvas');
   await loading.waitFor();
   await footer(workflow,'Canvas');
   await view('Collapse Workflow').waitFor();
   await switchTo('Outline');
   assert.equal(await matched.getAttribute('aria-pressed'),'true');
   await activate(outline.getByRole('button',{name:'Collapse Workflow',exact:true}));
   console.log(`PASS ${mobile?'phone':'desktop'} switch and edit in Outline while ${canvasPath} is held`);

   await switchTo('Canvas');
   await page.keyboard.press('Tab');
   assert.equal(await view('Outline').evaluate(node=>node===document.activeElement),true);
   releaseCanvas();
   await canvas.getByText('Arranging Workflow…').waitFor();
   assert.equal(await footer(canvas,'Canvas'),loadingOffset);
   assert.equal(await view('Outline').getAttribute('aria-pressed'),'false');
   assert.equal(await view('Outline').evaluate(node=>node===document.activeElement),true,'Unselected Outline keeps focus through Canvas download');
   assert.equal((await canvas.boundingBox()).y,panel.y,'Canvas starts at the top of the Workflow panel');
   await page.keyboard.press('Enter');
   await outline.waitFor();
   await page.evaluate(()=>window.failOutlineLayout=true);
   await switchTo('Canvas');
   await page.getByRole('alert').getByText('Fixture layout failure').waitFor();
   await switchTo('Outline');
   await row('Fallback input').waitFor();
   assert.equal(await row('Recover input').count(),0);
   await activate(outline.getByRole('button',{name:'On failure → Recover input',exact:true}));
   assert.equal(await row('Recover input').evaluate(node=>node===document.activeElement),true);
   assert.equal(await matched.getAttribute('aria-pressed'),'true');
   await row('Recover input').waitFor();
   assert.equal(await row('Run workers').count(),1);
   assert.equal(await path('On success').count(),0);
   assert.equal(await outline.getByRole('button',{name:/Continue at Run workers$/}).count(),2);
   const secondPath=path('Second worker');
   assert.equal(await isOpen(secondPath),false);
   assert.equal(await row('Second worker').count(),0);
   assert.deepEqual(await outline.getByRole('button',{name:/^(First worker|Third worker|Combine workers) /}).allTextContents(),['First workerScript','Third workerScript','Combine workersJoin']);
   await toggle(secondPath);
   assert.deepEqual(await outline.getByRole('button',{name:/^(First worker|Second worker|Verify second result|Third worker|Combine workers) /}).allTextContents(),['First workerScript','Second workerScript','Verify second resultScript','Third workerScript','Combine workersJoin']);
   assert.equal(await outline.getByRole('button',{name:'Rejoin at Combine workers',exact:true}).count(),0);
   assert.equal(await matched.getAttribute('aria-pressed'),'true');
   await toggle(secondPath);
   const checkRowLayout=async(narrow,step=matched)=>{
    const layout=await step.evaluate(node=>{
     const [name,type]=node.children;
     const row=node.parentElement;
     return {height:row.getBoundingClientRect().height,target:node.getBoundingClientRect().height,menu:row.lastElementChild.getBoundingClientRect().height,
      border:getComputedStyle(row).borderBottomWidth,stacked:type.getBoundingClientRect().top>=name.getBoundingClientRect().bottom-1};
    });
    assert.equal(layout.border,'1px');
    assert.equal(layout.stacked,narrow);
    assert.ok(narrow?layout.target>=44&&layout.menu>=44:layout.height>=38&&layout.height<=40,JSON.stringify(layout));
   };
   await checkRowLayout(mobile);
   const loop=outline.getByRole('button',{name:'On failure → Loop to Follow-up 0',exact:true});
   await activate(loop);
   assert.equal(await row('Follow-up 0').evaluate(node=>node===document.activeElement),true);

   const conditionActions=outline.getByRole('button',{name:'Actions for Check input',exact:true});
   await activate(conditionActions);
   await page.getByRole('menuitem',{name:'Add if it matches → Matched input',exact:true}).waitFor();
   await activate(page.getByRole('menuitem',{name:'Add otherwise → Fallback input',exact:true}));
   await page.getByRole('menu').getByText('Otherwise → Fallback input',{exact:true}).waitFor();
   await page.keyboard.press('Escape');
   await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Actions for Check input');
   await activate(conditionActions);
   await activate(page.getByRole('menuitem',{name:'Add otherwise → Fallback input',exact:true}));
   await activate(page.getByRole('menuitem',{name:'Approval',exact:true}));
   await inspector.getByRole('textbox',{name:'Name',exact:true}).fill('Review unmatched input');
   await back.click();
   await inspector.waitFor({state:'hidden'});
   assert.equal(await row('Review unmatched input').evaluate(node=>node===document.activeElement),true);

   await activate(outline.getByRole('button',{name:'Actions for Matched input',exact:true}));
   await page.getByRole('menuitem',{name:'Add on success → Shared work',exact:true}).waitFor();
   await page.getByRole('menuitem',{name:'Add on failure → Report failed input',exact:true}).waitFor();
   await page.keyboard.press('Escape');
   const actions=outline.getByRole('button',{name:'Actions for Shared work',exact:true});
   await activate(actions);
   const onFailure=page.getByRole('menuitem',{name:'Add on failure → Recover input',exact:true});
   await onFailure.waitFor();
   if(!mobile){
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Actions for Shared work');
    await activate(actions);
   }
   await activate(onFailure);
   await page.getByRole('menu').getByText('On failure → Recover input',{exact:true}).waitFor();
   await activate(page.getByRole('menuitem',{name:'Approval',exact:true}));
   const nameField=inspector.getByRole('textbox',{name:'Name',exact:true});
   await nameField.fill('Review fallback');
   if(!mobile){
    const divider=page.getByRole('separator',{name:'Resize workflow inspector'});
    const width=async()=>Number(await divider.getAttribute('aria-valuenow'));
    const first=await width();
    await divider.press('ArrowLeft');assert.equal(await width(),first+16);
    const handle=await divider.boundingBox();
    await page.mouse.move(handle.x+6,handle.y+30);await page.mouse.down();await page.mouse.move(handle.x-34,handle.y+30,{steps:5});await page.mouse.up();
    assert.equal(await width(),first+56);
    const dock=await inspector.boundingBox(),list=await outline.boundingBox();
    assert.ok(list.width>=380&&list.x+list.width<dock.x);
    await checkRowLayout(false);
    await divider.press('End');
    assert.equal(await width(),Number(await divider.getAttribute('aria-valuemax')));
    await checkRowLayout(true);
   }else{
    await page.waitForFunction(()=>{
     const sheet=document.querySelector('[role="dialog"][aria-label="Workflow inspector"]')?.getBoundingClientRect();
     return sheet&&sheet.left===0&&sheet.right<=innerWidth&&sheet.bottom<=innerHeight;
    });
    assert.ok(await nameField.isVisible());
   }
   await back.click();
   await inspector.waitFor({state:'hidden'});
   assert.equal(await row('Review fallback').getAttribute('aria-pressed'),'true');
   assert.equal(await row('Review fallback').evaluate(node=>node===document.activeElement),true);
   assert.equal(await outline.locator('details').filter({has:page.getByRole('button',{name:'Review fallback Human approval',exact:true})}).count(),1);
   await activate(outline.getByRole('button',{name:'Undo',exact:true}));
   await row('Review Result').waitFor();
   await activate(outline.getByRole('button',{name:'Redo',exact:true}));
   await row('Review fallback').waitFor();

   await toggle(matches);
   assert.equal(await isOpen(matches),false);
   if(mobile){
    await page.setViewportSize({width:320,height:640});
    await activate(row('Check input'));
    await inspector.getByRole('textbox',{name:'Name',exact:true}).waitFor();
    await back.tap();
    await inspector.waitFor({state:'hidden'});
    assert.equal(await row('Check input').evaluate(node=>node===document.activeElement),true);
    await checkRowLayout(true,row('Check input'));
    assert.equal(await isOpen(matches),false);
    await activate(row('Review fallback'));
    await back.tap();
   }
   await activate(outline.getByRole('button',{name:'Expand Workflow',exact:true}));
   await row('Follow-up 13').scrollIntoViewIfNeeded();
   await footer(outline,'Outline');
   assert(await row('Follow-up 13').evaluate(node=>node.getBoundingClientRect().bottom<=node.closest('[aria-label="Workflow Outline"]').firstElementChild.getBoundingClientRect().bottom),'The last row scrolls above the footer');
   const before=await scroll.evaluate(node=>node.scrollTop);
   assert.ok(before>100);
   await switchTo('Canvas');
   await footer(canvas,'Canvas');
   await canvas.getByRole('button',{name:'Collapse Workflow',exact:true}).waitFor();
   await switchTo('Outline');
   await outline.getByRole('button',{name:'Collapse Workflow',exact:true}).waitFor();
   assert.equal(await scroll.evaluate(node=>node.scrollTop),before);
   assert.equal(await isOpen(matches),false);
   assert.equal(await isOpen(otherwise),true);
   assert.equal(await row('Review fallback').getAttribute('aria-pressed'),'true');

   const review=outline.getByRole('button',{name:'Review changes',exact:true});
   await activate(review);
   await inspector.getByRole('button',{name:'Publish workflow',exact:true}).click();
   await inspector.waitFor({state:'hidden'});
   await outline.waitFor();
   await row('Review fallback').waitFor();
   const persisted=f.ok(await f.api('GET',`/api/branches/${branch.id}`));
   assert.notEqual(persisted.versionId,initial.versionId);
   const version=f.ok(await f.api('GET',`/api/branches/${branch.id}/versions/${persisted.versionId}`));
   const added=version.definition.steps.find(node=>node.label==='Review fallback');
   assert.ok(added);
   assert.equal(version.definition.edges.find(item=>item.id==='failure').to,added.id);
   assert.equal(version.definition.edges.find(item=>item.from===added.id&&item.on==='approved').to,'recover');
   assert.equal(version.definition.edges.find(item=>item.id==='ready').to,'fork');
   const unmatched=version.definition.steps.find(node=>node.label==='Review unmatched input');
   assert.ok(unmatched);
   assert.equal(version.definition.controls.find(item=>item.id==='condition').otherwise,unmatched.id);
   assert.equal(version.definition.edges.find(item=>item.id==='no').to,unmatched.id);
   assert.equal(version.definition.edges.find(item=>item.from===unmatched.id&&item.on==='approved').to,'no');
   assert.equal(version.definition.edges.find(item=>item.id==='yes').to,'yes');
   console.log(`PASS ${mobile?'phone 390×844':'desktop 1440×900'} Outline Enter after Canvas download, stalled and failed Canvas, paths, links, exact insertion, focus, resize, undo/redo, footer placement, expanded switching, view continuity, publication`);

   if(mobile)await page.setViewportSize({width:390,height:844});
   heldCanvas=holdCanvas();
   const requestsOnReload=[];
   const trackCanvas=request=>{if(request.url()===web.origin+canvasPath)requestsOnReload.push(request)};
   page.on('request',trackCanvas);
   await page.reload({waitUntil:'domcontentloaded'});
   await outline.waitFor();
   assert.equal(await view('Outline').getAttribute('aria-pressed'),'true');
   assert.equal(await canvas.count(),0);
   assert.deepEqual(requestsOnReload,[],'Reloading into Outline keeps Canvas lazy');
   page.off('request',trackCanvas);
   await activate(matched);
   await initialName.fill('Matched input for review');
   await back.click();
   await row('Matched input for review').waitFor();
   await switchTo('Canvas');
   const pendingReview=view('Review changes');
   await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='Review changes'&&!button.disabled&&button.getClientRects().length));
   for(const label of ['Outline','Undo','Expand Workflow','Review changes']){
    await page.keyboard.press('Tab');
    assert.equal(await view(label).evaluate(node=>node===document.activeElement),true,`Tab focuses ${label}`);
   }
   await page.evaluate(()=>window.useRealOutlineLayout=true);
   releaseCanvas();
   await canvas.getByRole('region',{name:'Canvas Viewport',exact:true}).waitFor();
   await page.waitForFunction(()=>document.querySelector('[aria-label="Workflow Canvas"]')?.getAttribute('aria-busy')==='false');
   assert.equal(await pendingReview.evaluate(node=>node===document.activeElement),true,'Review changes keeps focus through Canvas download');
   await page.keyboard.press('Enter');
   await inspector.getByRole('button',{name:'Publish workflow',exact:true}).waitFor();
   await page.reload({waitUntil:'domcontentloaded'});
   await canvas.waitFor();
   assert.equal(await view('Canvas').getAttribute('aria-pressed'),'true');
   assert.deepEqual(pageErrors,[]);
   console.log(`PASS ${mobile?'phone 390×844':'desktop 1440×900'} dirty draft Review changes keeps focus through Canvas download and opens with Enter`);
  }finally{releaseCanvas();await context.close()}
 }
}finally{await browser?.close();await web?.close();await f.dispose()}
