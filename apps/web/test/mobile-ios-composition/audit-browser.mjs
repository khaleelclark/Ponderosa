import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {chromium,webkit,devices}=createRequire(process.env.PLAYWRIGHT_PACKAGE||import.meta.url)('playwright');
const engine=process.env.BROWSER==='webkit'?webkit:chromium;
const executablePath=engine===webkit?process.env.WEBKIT_PATH:process.env.CHROMIUM_PATH;
const browser=await engine.launch({headless:true,...(executablePath?{executablePath}:{})});
const project={id:'project',label:'Very long Project label that must not paint behind the status badge'};
const agent={id:'agent',title:'Fixture running agent',handle:'Boston'};
try{
 for(const width of [320,390,412,1200]) for(const light of [false,true]){
  const context=await browser.newContext({...devices['Pixel 7'],viewport:{width,height:915}});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',r=>{
   const url=new URL(r.request().url());
   let items=[];
   if(url.pathname.endsWith('/trigger'))items=[{project,trigger:{id:'trigger',name:'Fixture automation',enabled:true},targetAgent:{title:'Long Agent title'}}];
   if(url.searchParams.has('outcomes'))items=[{project,agent,health:{assignedWorkOutcome:{status:'running'}}}];
   return r.fulfill({json:{items,total:items.length,activeCount:0,enabledCount:1,history:{hasMore:false}}});
  });
  await page.goto(`http://127.0.0.1:21848/?audit${light?'&light':''}`);
  await page.getByText('Fixture automation',{exact:true}).waitFor();
  if(width<900){
   await page.getByRole('button',{name:'Expand workspace header',exact:true}).click();
   await page.getByRole('tab',{name:'Team Chat',exact:true}).click();
   await page.getByRole('button',{name:'Collapse workspace header',exact:true}).click();
   const table=page.getByRole('table',{name:'Scrollable message table'});
   assert.equal(await table.getAttribute('tabindex'),'0');
   const metrics=await table.evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth,cell:el.querySelector('th').getBoundingClientRect().width}));
   assert.ok(metrics.scroll>metrics.client&&metrics.cell>=110,JSON.stringify(metrics));
   await table.evaluate(el=>{el.scrollLeft=100;});
   assert.ok(await table.evaluate(el=>el.scrollLeft>0));
   await table.evaluate(el=>{el.scrollLeft=0;});
   assert.equal(await page.getByText('Recent Assigned Work',{exact:true}).count(),1);
   assert.equal(await page.getByText('Recent Outcomes',{exact:true}).count(),0);
   const card=page.getByRole('button',{name:/Fixture automation/});
   const detail=await card.getByText(/Very long Project label/).boundingBox();
   const status=await card.getByText('Enabled',{exact:true}).boundingBox();
   assert.ok(detail.x+detail.width<=status.x,'Automation detail reserves badge space');
   const target=await page.getByRole('button',{name:'Action target'}).boundingBox();assert.ok(target.width>=44&&target.height>=44);
   const label=page.locator('#navigation').getByText('Automations',{exact:true});
   assert.equal(await label.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
   const title=page.locator('#navigation').getByText('A Project With A Recognizable Long Name',{exact:true});
   assert.equal(await title.evaluate(el=>getComputedStyle(el).whiteSpace),'normal');
  }else{
   assert.equal(await page.getByRole('button',{name:'Collapse workspace header',exact:true}).count(),1,'Desktop still starts expanded');
   assert.equal(await page.getByText('Recent Outcomes',{exact:true}).count(),1);
  }
  const push=JSON.parse(await page.locator('#push').textContent());
  assert.equal(push[0].kind,'installation_required');assert.equal(push[0].blocked,true);
  assert.match(push[0].message,/Add to Home Screen/);
  assert.equal(push[1].kind,'permission_default');assert.equal(push[1].blocked,false);
  assert.equal(push[2].kind,'permission_denied');assert.match(push[2].message,/Settings/);
  assert.equal(push[3].kind,'permission_default');assert.equal(push[3].blocked,false);
  assert.deepEqual(errors,[]);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(width===390&&!light)await page.screenshot({path:`/tmp/mobile-audit-${engine.name()}.png`,fullPage:true});
  if(width<900&&light){
   await page.goto('http://127.0.0.1:21848/?light');
   const input=page.locator('.composer-editor-input');await input.waitFor();
   const ratio=await input.evaluate(el=>{
    const placeholder=el.parentElement.querySelector('span.MuiTypography-root');
    if(!placeholder)throw new Error('Placeholder missing');
    const parse=s=>(s.match(/[\d.]+/g)||[]).map(Number);
    const foreground=parse(getComputedStyle(placeholder).color);
    let background=[255,255,255];
    for(let parent=placeholder.parentElement;parent;parent=parent.parentElement){
     const c=parse(getComputedStyle(parent).backgroundColor);
     if(c.length===3||c[3]===1){background=c;break;}
    }
    const luminance=c=>c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
    const a=luminance(foreground),b=luminance(background);
    return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
   });
   assert.ok(ratio>=4.5,`Placeholder contrast ${ratio}`);
   assert.equal(await page.getByRole('button',{name:/dictation/i}).count(),1,'Mobile Project-style composer exposes dictation or its unsupported reason');
  }
  console.log(`PASS ${engine.name()} audit ${width}px ${light?'light':'dark'}`);
  await context.close();
 }
}finally{await browser.close();}
