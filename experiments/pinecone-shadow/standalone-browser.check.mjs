import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Synthetic transport qualification only: no provider, live API or database.
// Build with pnpm --filter @ponderosa/web build:pinecone first.
if(!process.env.PONDEROSA_PLAYWRIGHT_PATH)throw Error('Set PONDEROSA_PLAYWRIGHT_PATH to the existing Playwright module.');
const {chromium}=await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const root=fileURLToPath(new URL('../../apps/web/dist/pinecone/',import.meta.url));
const evidence=process.env.PINECONE_TEST_EVIDENCE;
const branchId='0356095a-8d73-4249-b39d-883b978ae119',agentId='speaker',projectId='project',conversationId='chat';
const agent={id:agentId,title:'Pinecone',projectId,conversationId,archived:false,model:'fixture',effort:'high'};
const message=(index,text=`Saved message ${index}`)=>({id:`m${index}`,role:'assistant',text,authorAgentId:agentId,projectId,conversationId,communicationIntent:'user_dm',createdAt:new Date(Date.UTC(2026,9,1)+index*60000).toISOString()});
const initial=Array.from({length:80},(_,index)=>message(index));
const errors=[],unexpected=[],rows=[];
const server=createServer(async(req,res)=>{
  try{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname.startsWith('/api/')){res.writeHead(500);res.end('A fixture API request escaped interception');return;}
    const file=path.resolve(root,'.'+(pathname==='/'||pathname==='/branches'?'/index.html':pathname));
    if(!file.startsWith(root)){res.writeHead(404);res.end();return;}
    const body=await readFile(file),mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2','.svg':'image/svg+xml'}[path.extname(file)]??'application/octet-stream';
    res.writeHead(200,{'Content-Type':mime});res.end(body);
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.PONDEROSA_CHROMIUM_PATH});
  for(const [width,height,touch=false] of [[320,740],[390,844],[430,932],[390,360],[844,390],[1440,900],[390,844,true]]){
    const context=await browser.newContext({viewport:{width,height},hasTouch:touch,isMobile:touch}),page=await context.newPage();
    let messages=initial.slice(20),failHistory=false,failDetail=false,failOwner=false,failBranch=false,empty=false,unknown=false;
    const submissions=[],accepted=new Map();
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/api/**',async route=>{
      const req=route.request(),url=new URL(req.url()),p=url.pathname,method=req.method();
      const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
      if(p.endsWith('/stream'))return route.fulfill({contentType:'text/event-stream',body:p.includes('/workspace/')?'event: workspace_status\ndata: '+JSON.stringify({instanceId:'fixture',cursor:0,snapshot:true,caughtUp:true})+'\n\n':': fixture\n\n'});
      if(p==='/api/branches/'+branchId)return failBranch?json({error:'Fixture backend offline'},503):json({id:branchId,enabled:true,bindingRevisionId:'binding',versionId:'version',triggerId:'timer'});
      if(p==='/api/branches/'+branchId+'/configuration')return json({agents:{spokesperson:agentId},directories:{workspace:'/synthetic/assistant'}});
      if(p==='/api/branches/'+branchId+'/executions')return json([{id:'old-wait',admissionSource:'automatic',state:'waiting',createdAt:new Date(Date.now()-3600000).toISOString(),updatedAt:new Date(Date.now()-3600000).toISOString()}]);
      if(p==='/api/branches/engine/projects/'+projectId+'/memories'&&method==='POST')return json([]);
      if(p==='/api/branches/'+branchId+'/trigger')return json({id:'timer',branchId,enabled:true});
      if(p==='/api/branches/contexts/'+conversationId)return json({branchId});
      if(p==='/api/branches/engine/agents/'+agentId&&method==='GET'){
        if(url.searchParams.get('limit')==='1')return failOwner?json({error:'Fixture offline'},503):json({agent});
        if(failDetail)return json({error:'Fixture offline'},503);
        if(url.searchParams.has('cursor'))return failHistory?json({error:'Fixture history offline'},503):json({agent,messages:initial.slice(0,21),runs:[],decisionEvents:[],history:{hasMore:false}});
        return json({agent,messages:empty?[]:messages,runs:[],decisionEvents:[],history:{hasMore:!empty,cursor:'older'}});
      }
      if(p==='/api/branches/engine/agents/'+agentId+'/messages'&&method==='POST'){
        const body=req.postDataJSON();submissions.push(body);
        if(!accepted.has(body.idempotencyKey)){
          const id=`sent-${accepted.size}`,executionId=`run-${id}`;
          const sent={...message(100+accepted.size*2,body.text),id,role:'user',deliveryReceipts:[{targetAgentId:agentId,state:'processed',executionId}]};
          messages=[...messages,sent,{...message(101+accepted.size*2,'Fixture reply: '+body.text),executionId}];
          accepted.set(body.idempotencyKey,{messageId:id,queued:false});
        }
        if(unknown){unknown=false;return route.abort('connectionreset');}
        return json(accepted.get(body.idempotencyKey),202);
      }
      if(p==='/api/branches/engine/conversations/'+conversationId)return json({conversation:{id:conversationId,projectId,branchId},agents:[agent],messages:[],history:{hasMore:false}});
      if(p==='/api/branches/engine/workspace/preferences')return json({});
      if(p==='/api/branches/engine/streams/probe')return json({});
      unexpected.push(method+' '+p);return json({error:'Unexpected fixture request'},404);
    });
    const editor=page.getByRole('textbox',{name:'Message Pinecone',exact:true});
    await page.goto(origin+'/');await editor.waitFor();await page.getByText('Saved message 79',{exact:true}).waitFor();
    await page.getByText('Check-ins are delayed. Chat still works.',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Back to Branches'}).count(),0);
    const measure=()=>page.evaluate(()=>{
      const box=s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return {x:r.x,y:r.y,bottom:r.bottom,height:r.height,scrollTop:e.scrollTop,scrollHeight:e.scrollHeight}};
      return {width:innerWidth,height:innerHeight,conversation:box('section[aria-label="Conversation with Pinecone"]'),composer:box('form'),overflow:document.documentElement.scrollWidth>innerWidth};
    });
    const layout=await measure();assert(!layout.overflow);assert(layout.composer.bottom<=height+1);assert(layout.conversation.bottom<=layout.composer.y+1);assert(layout.conversation.height>height*.5);rows.push({...layout,touch});
    if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,`layout-${width}x${height}${touch?'-touch':''}.png`)});}
    if(touch){
      await editor.fill('Touch first');await editor.press('Enter');assert.equal(submissions.length,0,'touch Return never sends');
      assert.equal(await editor.inputValue(),'Touch first\n');
      await page.getByRole('button',{name:'Send message to Pinecone'}).click();await page.getByText('Fixture reply: Touch first',{exact:false}).waitFor();assert.equal(accepted.size,1);
    }
    if(width===390&&height===844&&!touch){
      const conversation=page.getByRole('region',{name:'Conversation with Pinecone'});
      await conversation.evaluate(e=>{e.scrollTop=0});
      messages=[...messages,message(90,'New saved fixture message')];failBranch=true;
      await page.getByText('New saved fixture message',{exact:true}).waitFor({state:'attached'});
      const stale=page.getByRole('alert').filter({hasText:'Pinecone couldn’t refresh. Showing your last loaded conversation.'});
      await stale.waitFor();assert(await editor.isVisible(),'failed background metadata refresh must retain the loaded conversation');
      assert((await measure()).conversation.scrollTop<2,'incoming messages must not move a reader at earlier history');
      await page.getByRole('button',{name:'↓ New message',exact:true}).waitFor();
      failBranch=false;await stale.getByRole('button',{name:'Retry',exact:true}).click();
      failHistory=true;
      await page.getByRole('button',{name:'Earlier messages',exact:true}).click();
      await page.getByText('Earlier messages couldn’t load. Try again.',{exact:true}).waitFor();failHistory=false;
      await page.getByRole('alert').getByRole('button',{name:'Retry',exact:true}).click();
      await page.getByText('Saved message 0',{exact:true}).waitFor();
      assert.equal(await page.getByText('Saved message 20',{exact:true}).count(),1);
      assert((await measure()).conversation.scrollTop>200,'older page insertion preserves the previous reading position');
      await conversation.evaluate(e=>{e.scrollTop=e.scrollHeight});
      await editor.fill('First fixture turn');await page.getByRole('button',{name:'Send message to Pinecone'}).click();
      await page.getByText('Fixture reply: First fixture turn',{exact:true}).waitFor();
      await editor.fill('Second fixture turn');await editor.press('Enter');await page.getByText('Fixture reply: Second fixture turn',{exact:true}).waitFor();
      assert.equal(accepted.size,2);assert.notEqual(submissions[0].idempotencyKey,submissions[1].idempotencyKey);
      unknown=true;await editor.fill('Recover fixture turn');await editor.press('Enter');
      await page.getByRole('button',{name:'Retry same message',exact:true}).waitFor();
      const retained=await editor.inputValue();assert.equal(retained,'Recover fixture turn');
      await page.reload();await page.getByRole('button',{name:'Retry same message',exact:true}).waitFor();
      await page.getByRole('button',{name:'Retry same message',exact:true}).click();await page.getByText('Fixture reply: Recover fixture turn',{exact:true}).waitFor();
      assert.equal(accepted.size,3);assert.deepEqual(submissions[2],submissions[3],'reload/retry retains the exact accepted identity and payload');
      await editor.fill('Unsent keyboard draft\n'.repeat(12));
      await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,value:360});visualViewport.dispatchEvent(new Event('resize'));});
      await page.waitForFunction(()=>document.querySelector('form').getBoundingClientRect().bottom<=361);
      assert((await measure()).conversation.height>150);
      await page.reload();await editor.waitFor();assert((await editor.inputValue()).startsWith('Unsent keyboard draft'));
      await page.getByRole('button',{name:'Conversation options',exact:true}).click();
      await page.getByRole('menuitem',{name:'What Pinecone remembers',exact:true}).click();
      await page.getByRole('dialog').getByText('No memories found.',{exact:true}).waitFor();
      await page.getByRole('button',{name:'Done',exact:true}).click();
      await page.getByText('Check-ins are delayed. Chat still works.',{exact:true}).waitFor();
      await page.getByRole('button',{name:'Call Pinecone',exact:true}).click();await page.getByRole('dialog').waitFor();
      await page.getByRole('button',{name:'End call',exact:true}).click();assert.equal(accepted.size,3,'opening/ending a call sends no message');
      empty=true;await page.reload();await page.getByText('What’s on your mind?',{exact:true}).waitFor();
      empty=false;failDetail=true;await page.reload();await page.getByText('Conversation could not refresh.',{exact:false}).waitFor();
      failDetail=false;await page.getByRole('alert').getByRole('button',{name:'Retry',exact:true}).click();await page.getByText('Saved message 79',{exact:true}).waitFor();
      failOwner=true;await page.reload();await page.getByText('Pinecone couldn’t load your conversation.',{exact:false}).waitFor();
      failOwner=false;await page.getByRole('alert').getByRole('button',{name:'Retry',exact:true}).click();await editor.waitFor();
      if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,'standalone-mobile.png')});}
    }
    await context.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  const result={passed:true,syntheticTransportOnly:true,realProviderCalls:0,realApplicationWrites:0,physicalKeyboardTested:false,physicalAudioTested:false,rows,errors,unexpected};
  if(evidence)await writeFile(path.join(evidence,'standalone-browser.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
