import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {serveFixture} from '../shared/serve-ui-fixture.mjs';

const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const {fixture}=await import('../shared/fixture.mjs');
const f=await fixture();
let web,browser;
try{
 web=await serveFixture(f);
 browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/usr/bin/google-chrome',args:['--no-sandbox']});
 for(const width of [1440,390]){
  const mobile=width===390;
  const context=await browser.newContext({viewport:{width,height:mobile?844:900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
  try{
   const page=await context.newPage();
   page.setDefaultTimeout(12000);
   await page.route('**/*',route=>new URL(route.request().url()).origin===web.origin?route.continue():route.abort());
   const activate=element=>mobile?element.tap():element.click();
   const post=async(url,body)=>f.ok(await f.api('POST',url,body));
   const get=async url=>f.ok(await f.api('GET',url));
   const branch=await post('/api/branches',{name:'Behavior Bible Delta',idempotencyKey:randomUUID()});
   const path='/api/branches/'+branch.id;
   const receipt='Fetch the pinned commit for a source-only receipt',audit='Fetch pinned GitHub evidence';
   const long='Review'+ 'PinnedEvidenceFromTheRepository'.repeat(4);
   const script=(id,label)=>({kind:'script',id,label,runtime:'node',source:'process.stdout.write("fixture")',cwdRef:'workspace',timeoutMs:1000});
   const condition=(id,label,otherwise)=>({kind:'condition',id,label,otherwise,predicate:{source:'input',equals:'receipt'}});
   const edge=(id,from,on,to,input)=>({id,from,on,to,...(input?{input}:{})});
   const primary={...condition('primary','Source-only receipt or full audit?','audit'),matchLabel:'Source-only receipt',otherwiseLabel:'Full audit'};
   const secondary=condition('secondary','Check available evidence','end');
   const definition={schema:'ponderosa.branch.v1',name:branch.name,trigger:{kind:'manual'},entry:primary.id,
    steps:[script('receipt',receipt),script('audit',audit),script('long',long),script('end','End review')],
    controls:[primary,secondary],
    edges:[edge('match','primary','selected','receipt'),edge('fallback','primary','failure','audit'),
     edge('receipt-next','receipt','success','secondary'),edge('audit-next','audit','success','secondary',{kind:'literal',text:'audit'}),
     edge('long-path','secondary','selected','long'),edge('end-path','secondary','failure','end')],
    policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
   await post('/api/branches/deploy',{branchId:branch.id,chatId:branch.chatId,expectedVersionId:branch.versionId,idempotencyKey:randomUUID(),
    definition,bindings:{agents:{},directories:{workspace:f.root}}});
   const url=web.origin+'/branches?branch='+branch.id+'&tab=workflow';
   const outline=page.getByRole('region',{name:'Workflow Outline'});
   const inspector=page.getByRole(mobile?'dialog':'region',{name:'Workflow inspector',exact:true});
   const back=inspector.getByRole('button',{name:'Back to workflow',exact:true});
   const expand=inspector.getByRole('button',{name:'Expand Workflow',exact:true});
   const heading=name=>inspector.getByRole('heading',{name,exact:true});
   const nameField=inspector.getByRole('textbox',{name:'Name',exact:true});
   const compare=inspector.getByRole('textbox',{name:'Comparison value',exact:true});
   const advanced=inspector.getByRole('button',{name:'Advanced',exact:true});
   const openStep=name=>outline.getByRole('button',{name:new RegExp('^'+name)});
   const combo=name=>inspector.getByRole('combobox',{name});
   const reopen=async()=>{
    await page.goto(url);
    await activate(page.getByRole('button',{name:'Outline',exact:true}));
    await outline.waitFor();
    assert.equal(await page.evaluate(()=>innerWidth),width);
   };
   const openPrimary=async()=>{
    await activate(openStep('Source-only receipt or full audit'));
    await heading('Condition').waitFor();
    assert.equal(await nameField.inputValue(),'Source-only receipt or full audit?');
   };
   async function checkLayout(){
    const [title,left,right,name,check,send]=await Promise.all([heading('Condition'),back,expand,nameField,heading('Check'),heading('Send to')].map(item=>item.boundingBox()));
    assert.ok(left.x+left.width<title.x&&title.x+title.width<=right.x);
    assert.ok(Math.abs(title.y+title.height/2-left.y-left.height/2)<2);
    assert.ok(Math.abs(title.y+title.height/2-right.y-right.height/2)<2);
    assert.ok(title.y<name.y&&name.y<check.y&&check.y<send.y);
    assert.equal(await inspector.getByText('Task',{exact:true}).count(),0);
    assert.equal(await inspector.getByText(/complex checks: preceding Script/).count(),0);
    assert.equal(await advanced.getAttribute('aria-expanded'),'false');
    await inspector.getByRole('button',{name:'Remove Step',exact:true}).waitFor();
   }
   async function wraps(picker,label){
    assert.equal(await picker.textContent(),label);
    const size=await picker.evaluate(element=>{
     const range=document.createRange();range.selectNodeContents(element);
     const style=getComputedStyle(element);
     const content=element.closest('[data-inspector-scroll]');
     const rect=element.getBoundingClientRect(),arrow=element.parentElement.querySelector('svg').getBoundingClientRect();
     const lines=Array.from(range.getClientRects());
     return {lines:lines.length,overflow:content.scrollWidth-content.clientWidth,inside:lines.every(line=>line.left>=rect.left&&line.right<=arrow.left+1),
      wrapping:style.whiteSpace};
    });
    assert.ok(size.lines>1&&size.inside&&size.overflow===0&&size.wrapping==='normal',JSON.stringify(size));
   }
   await reopen();
   await outline.locator('summary').getByText('· Source-only receipt',{exact:true}).waitFor();
   await outline.locator('summary').getByText('· Full audit',{exact:true}).waitFor();
   await openPrimary();
   if(mobile)await page.waitForFunction(()=>document.querySelector('[aria-label="Workflow inspector"]').getBoundingClientRect().x===0);
   await checkLayout();
   const check=inspector.getByRole('region',{name:'Check',exact:true});
   await check.getByText('Workflow Input',{exact:true}).waitFor();
   await check.getByText('Equals',{exact:true}).waitFor();
   assert.equal(await check.getByRole('combobox').count(),0);
   await heading('If it matches · Source-only receipt').waitFor();
   await heading('Otherwise · Full audit').waitFor();
   assert.equal(await combo(/^If it matches · Source-only receipt/).textContent(),receipt);
   assert.equal(await combo(/^Otherwise · Full audit/).textContent(),audit);
   if(!mobile){
    const divider=page.getByRole('separator',{name:'Resize workflow inspector'});
    assert.equal(await divider.getAttribute('aria-valuenow'),'400');
    const bounds=await divider.boundingBox();
    await page.mouse.move(bounds.x+6,bounds.y+25);
    await page.mouse.down();
    await page.mouse.move(bounds.x+46,bounds.y+25,{steps:4});
    await page.mouse.up();
    assert.equal(await divider.getAttribute('aria-valuenow'),'360');
    await divider.press('Home');
    assert.equal(await divider.getAttribute('aria-valuenow'),'320');
    await checkLayout();
    await back.focus();
    await page.keyboard.press('Tab');
    assert.equal(await expand.evaluate(node=>node===document.activeElement),true);
    await page.keyboard.press('Tab');
    assert.equal(await nameField.evaluate(node=>node===document.activeElement),true);
   }
   await activate(back);
   await inspector.waitFor({state:'hidden'});
   await openStep('Source-only receipt or full audit').evaluate(async node=>{
    await new Promise(requestAnimationFrame);
    assertFocus();
    function assertFocus(){if(document.activeElement!==node)throw Error('Back did not restore focus to the Condition');}
   });
   await activate(openStep('Check available evidence'));
   await heading('Condition').waitFor();
   await heading('If it matches').waitFor();
   await heading('Otherwise').waitFor();
   await check.getByText(receipt,{exact:true}).waitFor();
   await check.getByText(audit+' · Custom Input',{exact:true}).waitFor();
   await wraps(combo(/^If it matches /),long);
   await activate(back);
   await inspector.waitFor({state:'hidden'});

   await openPrimary();
   await compare.fill('full audit');
   async function choose(picker,destination){
    if(mobile)await picker.tap();
    else await picker.press('Enter');
    const option=page.getByRole('option',{name:destination,exact:true});
    await option.waitFor();
    if(mobile)await option.tap();else await option.press('Enter');
    await option.waitFor({state:'hidden'});
    assert.equal(await picker.textContent(),destination);
   }
   await choose(combo(/^If it matches · Source-only receipt/),audit);
   await choose(combo(/^Otherwise · Full audit/),receipt);
   await activate(back);
   await activate(page.getByRole('button',{name:'Review changes',exact:true}));
   await heading('Review changes').waitFor();
   const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/branches/deploy'));
   await activate(inspector.getByRole('button',{name:'Publish workflow',exact:true}));
   const saved=await response;
   assert.ok(saved.ok(),await saved.text());
   await inspector.waitFor({state:'hidden'});
   const updated=await get(path);
   const version=(await get(path+'/versions/'+updated.versionId)).definition;
   assert.deepEqual(version.controls.find(node=>node.id===primary.id),{...primary,otherwise:'receipt',predicate:{source:'input',equals:'full audit'}});
   const originalEdges=new Map(definition.edges.map(item=>[item.id,item]));
   const expected={match:'audit',fallback:'receipt'};
   assert.equal(version.edges.length,originalEdges.size);
   for(const item of version.edges)assert.deepEqual(item,{...originalEdges.get(item.id),to:expected[item.id]??originalEdges.get(item.id).to});
   await reopen();
   await openPrimary();
   assert.equal(await compare.inputValue(),'full audit');
   assert.equal(await combo(/^If it matches · Source-only receipt/).textContent(),audit);
   assert.equal(await combo(/^Otherwise · Full audit/).textContent(),receipt);
   assert.deepEqual(await get(path+'/executions'),[]);
   console.log(`PASS ${width}px Condition inspector order, source, labels, long selected destination, focus, resize and published draft round trip`);
  }finally{await context.close();}
 }
}finally{await browser?.close();await web?.close();await f.dispose();}
