import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const {fixture}=await import('../shared/fixture.mjs');
import {serveFixture} from '../shared/serve-ui-fixture.mjs';

const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const evidence=await mkdtemp(join(tmpdir(),'ponderosa-insertion-actions-'));
const f=await fixture();
let web,browser;

try{
 web=await serveFixture(f);
 browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 for(const mobile of [false,true]){
  const size=mobile?'phone':'desktop';
  const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1440,height:900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
  page.setDefaultTimeout(10000);
  await page.route('**/*',route=>new URL(route.request().url()).origin===web.origin?route.continue():route.abort());
  try{
   const branch=f.ok(await f.api('POST','/api/branches',{name:`Insertion actions ${size}`,idempotencyKey:randomUUID()}));
   const routes=[
    ...Array.from({length:7},(_,i)=>({id:'path'+i,from:'route',to:'end',on:'selected',choice:`Route ${i+1} for manual follow-up`})),
    {id:'long',from:'route',to:'end',on:'selected',choice:'UnbrokenRouteLabel'.repeat(5)},
    {id:'otherwise',from:'route',to:'end',on:'failure'},
   ];
   const success={id:'success',from:'start',to:'route',on:'success'};
   const script=(id,label)=>({id,label,kind:'script',runtime:'node',source:'process.stdout.write("fixture")',cwdRef:'workspace',timeoutMs:1000});
   const definition={schema:'ponderosa.branch.v1',name:branch.name,trigger:{kind:'manual'},entry:'start',
    steps:[script('start','Prepare request'),script('end','Finish request')],controls:[{id:'route',kind:'route',label:'Choose follow-up',otherwise:'end'}],
    edges:[success,...routes],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
   const initial=f.ok(await f.api('POST','/api/branches/deploy',{branchId:branch.id,chatId:branch.chatId,expectedVersionId:branch.versionId,idempotencyKey:randomUUID(),definition,bindings:{agents:{},directories:{workspace:f.root}}}));
   const canvas=page.getByRole('region',{name:'Workflow Canvas',exact:true});
   const viewport=canvas.getByRole('region',{name:'Canvas Viewport',exact:true});
   const group=canvas.getByRole('group',{name:'Workflow Insertion Actions',exact:true});
   const button=(name,area=canvas)=>area.getByRole('button',{name,exact:true});
   const inspector=page.getByRole(mobile?'dialog':'region',{name:'Workflow inspector',exact:true});
   const back=button('Back to workflow',inspector);
   const activate=control=>mobile?control.tap():control.press('Enter');
   const settled=()=>page.waitForFunction(()=>document.querySelector('[aria-label="Workflow Canvas"]')?.getAttribute('aria-busy')==='false');
   const lowZoom=async()=>{
    const zoom=()=>viewport.locator('.react-flow__viewport').evaluate(element=>new DOMMatrix(getComputedStyle(element).transform).a);
    for(let i=0;i<7&&await zoom()>=.8;i++)await activate(button('Zoom Out'));
    assert.ok(await zoom()<.8,'Canvas reaches the fallback-action zoom');
   };
   const select=async name=>{
    await canvas.getByLabel('Select '+name,{exact:true}).press('Enter');
    await back.click();
    await inspector.waitFor({state:'hidden'});
    await settled();
    await lowZoom();
   };
   const geometry=()=>group.evaluate(element=>{
    const box=element.getBoundingClientRect(),body=element.parentElement.getBoundingClientRect(),styles=getComputedStyle(element);
    const controls=Array.from(element.querySelectorAll('button'),button=>({bounds:button.getBoundingClientRect().toJSON(),width:button.clientWidth,contentWidth:button.scrollWidth}));
    return {box:box.toJSON(),body:body.toJSON(),rows:new Set(controls.map(({bounds})=>Math.round(bounds.top))).size,
     padding:parseFloat(styles.paddingLeft)+parseFloat(styles.paddingRight),gap:parseFloat(styles.columnGap),controls,
     clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,clientHeight:element.clientHeight,scrollHeight:element.scrollHeight,scrollTop:element.scrollTop};
   });
   const checkGroup=async(count,compact)=>{
    await group.getByRole('button').nth(count-1).waitFor();
    const g=await geometry();
    assert.equal(g.controls.length,count);
    assert.ok(Math.abs(g.box.left+g.box.width/2-g.body.left-g.body.width/2)<=1,'The group is centered in the Canvas');
    assert.ok(g.box.height<=g.body.height*.3+1,'The existing height cap applies');
    assert.equal(g.scrollWidth,g.clientWidth,'No horizontal scrollbar');
    assert.ok(g.controls.every(control=>control.contentWidth<=control.width&&control.bounds.left>=g.box.left-1&&control.bounds.right<=g.box.right+1),'Button labels stay within the group');
    if(compact){
     assert.equal(g.rows,1);
     const expected=g.controls.reduce((width,control)=>width+control.bounds.width,0)+g.gap*(count-1)+g.padding;
     assert.ok(Math.abs(g.box.width-expected)<=1,'Background fits the buttons, gap and padding');
    }
    return g;
   };
   const insert=async(name,targetLabel)=>{
    const control=button(name,group);
    await control.scrollIntoViewIfNeeded();
    await activate(control);
    const menu=page.getByRole('menu');
    await menu.getByText(targetLabel,{exact:true}).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(name=>document.activeElement?.textContent.trim()===name,name);
    await activate(control);
    await activate(menu.getByRole('menuitem',{name:'Approval',exact:true}));
    await back.click();
    await inspector.waitFor({state:'hidden'});
    await settled();
    await lowZoom();
   };

   await page.goto(`${web.origin}/branches?branch=${branch.id}`);
   await button('Fit Workflow').waitFor();
   await settled();
   const outline=page.getByRole('region',{name:'Workflow Outline',exact:true});
   const quick=label=>page.getByRole('menu',{name:`Actions for ${label}`,exact:true});
   const choice=(menu,label)=>menu.getByRole('menuitem',{name:label,exact:true});
   const focus=async control=>{
    const element=await control.elementHandle();
    try{await page.waitForFunction(element=>element===document.activeElement,element)}
    catch(error){throw Error(`Expected focus on ${await element.getAttribute('aria-label')}, found ${await page.evaluate(()=>document.activeElement?.outerHTML.slice(0,180))}`,{cause:error})}
    finally{await element.dispose()}
   };
   for(const activeView of ['Canvas','Outline']){
    const inCanvas=activeView==='Canvas',label=inCanvas?'Prepare request':'Choose follow-up';
    const view=inCanvas?canvas:outline;
    const row=inCanvas?canvas.getByLabel('Select '+label,{exact:true}):outline.getByRole('button',{name:label+' Choose route',exact:true});
    const overflow=button('Actions for '+label,view);
    const menu=quick(label);
    if(activeView==='Outline')await activate(button('Outline'));
    await row.focus();
    if(!mobile){
     await row.click({button:'right'});
     await choice(menu,'Edit step').waitFor();
     await page.keyboard.press('Escape');
     await menu.waitFor({state:'hidden'});
     assert.equal(await inspector.isVisible(),false,'Opening a menu leaves the editor closed');
     if(activeView==='Canvas')assert.doesNotMatch(await row.getAttribute('class'),/\bselected\b/);
     else assert.equal(await row.getAttribute('aria-pressed'),'false');
     await focus(row);
    }
    await row.press(activeView==='Canvas'?'Shift+F10':'ContextMenu');
    await choice(menu,'Remove step').waitFor();
    await page.keyboard.press('Escape');
    await menu.waitFor({state:'hidden'});
    await focus(row);
    await activate(overflow);
    const route='Route 1 for manual follow-up → Finish request';
    await activate(choice(menu,inCanvas?'Add after this step':'Add on '+route));
    await page.getByRole('menu').getByText(inCanvas?'After Prepare request':route,{exact:true}).waitFor();
    await page.keyboard.press('Escape');
    await focus(overflow);
    await activate(overflow);
    await activate(choice(menu,'Edit step'));
    assert.equal(await inspector.getByRole('textbox',{name:'Name',exact:true}).inputValue(),label);
    await back.click();
    await inspector.waitFor({state:'hidden'});
    const protectedRow=activeView==='Canvas'?canvas.getByLabel('Select Finish request',{exact:true}):outline.getByRole('button',{name:'Finish request Script',exact:true});
    await protectedRow.press('Shift+F10');
    const protectedMenu=quick('Finish request');
    await choice(protectedMenu,'Edit step').waitFor();
    assert.equal(await choice(protectedMenu,'Remove step').count(),0,'The route fallback cannot be removed');
    await page.keyboard.press('Escape');
    await focus(protectedRow);
   }
   await activate(button('Canvas',outline));
   await page.reload();
   await button('Fit Workflow').waitFor();
   await settled();
   assert.equal(await group.count(),0);
   await button('Expand Workflow').waitFor();
   const initialTop=(await viewport.boundingBox()).y;
   assert.equal(initialTop,(await canvas.boundingBox()).y,'No insertion wrapper or reserved gap at default zoom');
   await lowZoom();
   const entry='Insert Before The First Step';
   await checkGroup(1,true);
   await page.screenshot({path:join(evidence,size+'-one.png')});
   await select('Prepare request');
   await checkGroup(2,!mobile);
   await page.screenshot({path:join(evidence,size+'-two.png')});
   await insert('Insert On Success','On This Connection');
   await insert(entry,'Before The First Step');

   if(mobile)await page.setViewportSize({width:320,height:600});
   await select('Choose follow-up');
   const many=await checkGroup(routes.length+1,false);
   if(mobile){
    assert.ok(many.rows>1&&many.scrollHeight>many.clientHeight,'Narrow Canvas wraps and vertically scrolls');
    await group.getByRole('button').last().scrollIntoViewIfNeeded();
    assert.ok((await geometry()).scrollTop>0,'Last action is reachable by scrolling');
   }
   await page.screenshot({path:join(evidence,size+'-many.png')});
   for(const route of routes){
    await insert('Insert On '+(route.choice??'Otherwise'),'On This Connection');
    if(route!==routes.at(-1))await select('Choose follow-up');
   }
   await button('Outline').waitFor();
   await button('Review changes').waitFor();
   await activate(button('Review changes'));
   await inspector.getByRole('button',{name:'Publish workflow',exact:true}).click();
   await inspector.waitFor({state:'hidden'});
   const current=f.ok(await f.api('GET',`/api/branches/${branch.id}`));
   assert.notEqual(current.versionId,initial.versionId);
   const {definition:saved}=f.ok(await f.api('GET',`/api/branches/${branch.id}/versions/${current.versionId}`));
   const verifyApproval=(added,destination)=>{
    assert.equal(saved.steps.find(step=>step.id===added)?.kind,'human_gate');
    assert.ok(saved.edges.some(edge=>edge.from===added&&edge.to===destination&&edge.on==='approved'));
   };
   verifyApproval(saved.entry,definition.entry);
   for(const original of definition.edges){
    const inserted=saved.edges.find(edge=>edge.id===original.id);
    assert.deepEqual({...inserted,to:original.to},original);
    verifyApproval(inserted.to,original.to);
    if(original.on==='failure')assert.equal(saved.controls.find(control=>control.id===original.from).otherwise,inserted.to);
   }
   const create=async name=>f.ok(await f.api('POST','/api/branches',{name,idempotencyKey:randomUUID()}));
   const other=await create(`Other published ${size}`);
   const otherSaved=f.ok(await f.api('POST','/api/branches/deploy',{
    branchId:other.id,chatId:other.chatId,expectedVersionId:other.versionId,idempotencyKey:randomUUID(),
    definition:{...definition,name:other.name,entry:'other',steps:[script('other','Only step')],controls:[],edges:[]},
    bindings:{agents:{},directories:{workspace:f.root}},
   }));
   const unpublished=await create(`Unpublished ${size}`);
   await page.reload();
   await settled();
   const nav=page.getByRole('complementary',{name:'Workflows Navigation'});
   const sidebarLink=name=>nav.getByRole('link',{name:'Open Workflow '+name,exact:true});
   const sidebarOverflow=name=>button('Actions for '+name,nav);
   const openNav=async()=>{if(mobile)await activate(button('Open Workspace Navigation',page))};
   const owner=()=>new URL(page.url()).searchParams.get('branch');
   await openNav();
   const link=sidebarLink(other.name),overflow=sidebarOverflow(other.name),menu=quick(other.name);
   if(!mobile){
    await link.click({button:'right'});
    await choice(menu,'View runs').waitFor();
    assert.equal(owner(),branch.id);
    await page.keyboard.press('Escape');
    await menu.waitFor({state:'hidden'});
    assert.match(await sidebarLink(branch.name).getAttribute('class'),/Mui-selected/);
    await focus(link);
   }
   await link.press('Shift+F10');
   await choice(menu,'Rename…').waitFor();
   await page.keyboard.press('Escape');
   await menu.waitFor({state:'hidden'});
   await focus(link);
   await activate(overflow);
   await activate(choice(menu,'Star'));
   await button('Unstar '+other.name,nav).waitFor();
   assert.equal(owner(),branch.id);
   await focus(overflow);
   await activate(overflow);
   await activate(choice(menu,'Unstar'));
   await button('Star '+other.name,nav).waitFor();
   await focus(overflow);
   await activate(sidebarOverflow(unpublished.name));
   await choice(quick(unpublished.name),'Rename…').waitFor();
   assert.equal(await choice(quick(unpublished.name),'View runs').count(),0);
   await page.keyboard.press('Escape');
   await activate(overflow);
   await activate(choice(menu,'View runs'));
   await page.waitForURL(url=>url.searchParams.get('branch')===other.id&&url.searchParams.get('tab')==='executions');
   await page.getByRole('heading',{name:other.name,exact:true}).waitFor();
   assert.deepEqual(f.ok(await f.api('GET',`/api/branches/${other.id}/executions`)),[]);

   await page.getByRole('tab',{name:'Workflow',exact:true}).press('Enter');
   await settled();
   const onlyOverflow=button('Actions for Only step');
   await activate(onlyOverflow);
   await activate(choice(quick('Only step'),'Remove step'));
   await button('Add your first step').waitFor();
   await focus(button('Add your first step'));
   assert.equal(f.ok(await f.api('GET',`/api/branches/${other.id}`)).versionId,otherSaved.versionId);
   await openNav();
   await activate(sidebarOverflow(branch.name));
   await activate(choice(quick(branch.name),'Rename…'));
   await inspector.getByRole('heading',{name:'Unsaved Changes',exact:true}).waitFor();
   await activate(back);
   assert.equal(owner(),other.id);
   await button('Add your first step').waitFor();
   await activate(button('Undo'));
   await onlyOverflow.waitFor();
   await openNav();
   await activate(sidebarOverflow(branch.name));
   await activate(choice(quick(branch.name),'Rename…'));
   await inspector.getByRole('textbox',{name:'Workflow Name',exact:true}).waitFor();
   assert.equal(owner(),branch.id);
   assert.equal(await inspector.getByRole('textbox',{name:'Workflow Name',exact:true}).inputValue(),branch.name);
   await back.click();
   console.log(`PASS ${size} shared step menus, exact workflow targeting, focus restore, and guarded navigation`);
   console.log(`PASS ${size} one/two/many, compact center, capped wrap/scroll, empty space, menu focus, and ${definition.edges.length+1} saved destinations`);
  }catch(error){
   const path=join(evidence,size+'-failed.png');
   await page.screenshot({path}).catch(()=>{});
   console.error('Fixture screenshot',path);
   throw error;
  }finally{await page.close()}
 }
 console.log('Evidence:',evidence);
}finally{await browser?.close();await web?.close();await f.dispose()}
