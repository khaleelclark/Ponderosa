// Built UI + real loopback API + owned inert providers; no subscription inference.
import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture,until} from '../shared/fixture.mjs';
import {randomUUID} from 'node:crypto';
const require=createRequire(new URL('../../apps/server/package.json',import.meta.url));
const {chromium}=require('playwright-core');
const root=fileURLToPath(new URL('../../',import.meta.url)),web=path.join(root,'apps/web/dist');
const out=process.env.PONDEROSA_ROLE_IMPORT_QUALIFICATION_DIR??'/tmp/ponderosa-output-role-import-ui';await mkdir(out,{recursive:true});
let browser,server,page,passed=false;const f=await fixture();const errors=[],requests=[];
try{
 const api=await f.listen();
 const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml','.json':'application/json','.webmanifest':'application/manifest+json'};
 server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
   const upstream=await fetch(api+req.url,{method:req.method,headers:{...Object.fromEntries(Object.entries(req.headers).filter(([name])=>!['host','connection','content-length','accept-encoding'].includes(name))),host:new URL(api).host,...(req.headers.origin===`http://${req.headers.host}`?{origin:new URL(api).origin}:{})},...(body.length?{body}:{})});
   requests.push({method:req.method,path:req.url,status:upstream.status});
   res.writeHead(upstream.status,Object.fromEntries([...upstream.headers].filter(([name])=>!['transfer-encoding','connection','content-encoding','content-length'].includes(name))));
   if(upstream.body){const stream=Readable.fromWeb(upstream.body);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);}else res.end();return;
  }
  if(['/sw.js','/register-sw.js'].includes(url.pathname)){res.writeHead(404);res.end();return;}
  let file=path.resolve(web,'.'+decodeURIComponent(url.pathname));if(!file.startsWith(web+path.sep)){res.writeHead(404);res.end();return;}
  let bytes;try{bytes=await readFile(file);}catch{file=path.join(web,'index.html');bytes=await readFile(file);}
  res.writeHead(200,{'content-type':mime[path.extname(file)]??'application/octet-stream','cache-control':'no-store'});res.end(bytes);
 }catch(error){res.writeHead(500);res.end(String(error));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath:process.env.PONDEROSA_BROWSER_EXECUTABLE??'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
 page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',error=>errors.push(error.message));

 const speaker=f.ok(await f.api('POST','/api/branches/assistant',{enabled:true}));
 const child=f.ok(await f.api('POST',`/api/branches/engine/projects/${speaker.app.projectId}/agents`,{title:'Portable output child',engine:'codex',conversationId:speaker.app.chatId,managerAgentId:speaker.app.agentId,idempotencyKey:randomUUID()}));
 f.ok(await f.api('PUT',`/api/branches/output-apps/${child.id}`,{enabled:true}));
 const organization=f.ok(await f.api('GET',`/api/branches/engine/agents/${speaker.app.agentId}/export?mode=template&organization=true`));
 const workflow=f.ok(await f.api('GET',`/api/branches/${speaker.app.branchId}/package?mode=template`));workflow.packageId=randomUUID();
 const destination=f.ok(await f.api('POST','/api/branches',{name:'Organization destination',idempotencyKey:randomUUID()}));
 const chat=f.ok(await f.api('POST',`/api/branches/${destination.id}/chats`,{label:'Organization destination',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
 await page.goto(origin+`/branches?branch=${destination.id}&tab=chats&chat=${chat.id}`);
 await page.getByRole('button',{name:'Chat settings and actions',exact:true}).click();
 await page.getByRole('menuitem',{name:'Add Agents…',exact:true}).click();
 await page.getByRole('button',{name:'Import Agent package',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Import Agent package',exact:true});await dialog.waitFor();
 await dialog.locator('input[type="file"]').setInputFiles({name:'organization.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(organization))});
 await dialog.getByRole('button',{name:'Review output roles',exact:true}).waitFor();
 // One available engine may still need explicit human mapping in the existing import form.
 const selects=dialog.getByRole('combobox');
 for(let i=0;i<await selects.count();i++){const select=selects.nth(i);const label=await select.getAttribute('aria-labelledby');if(label?.includes('engine')){await select.click();await page.getByRole('option',{name:/Controlled regression adapter/}).click();}}
 await dialog.getByRole('button',{name:'Review output roles',exact:true}).click();
 await dialog.getByText('You already have a Ponderosa speaker. The imported speaker will be disabled.',{exact:true}).waitFor();
 await page.screenshot({path:path.join(out,'organization-collision.png'),fullPage:true});
 const operationResponse=page.waitForResponse(r=>r.url().endsWith('/agent-import-operations')&&r.request().method()==='POST'&&r.status()===202);
 await dialog.getByRole('button',{name:'Import',exact:true}).click();
 const operation=await (await operationResponse).json();
 const imported=await until(async()=>{const op=f.ok(await f.api('GET',`/api/branches/engine/projects/${chat.projectId}/agent-import-operations/${operation.id}`));assert.notEqual(op.status,'failed',op.error);return op.status==='completed'&&op.result;},'organization role import completes');
 assert.equal(imported.agentIds.length,2);for(const id of imported.agentIds)assert.equal(f.ok(await f.api('GET',`/api/branches/output-apps/${id}`)).speaker,false);
 assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).app.agentId,speaker.app.agentId);
 await page.goto(origin+'/branches');
 const chooserPromise=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import workflow',exact:true}).first().click();
 await (await chooserPromise).setFiles({name:'workflow.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(workflow))});
 const branchDialog=page.getByRole('dialog',{name:'Import as a new Branch',exact:true});await branchDialog.waitFor();
 await branchDialog.getByLabel('Default working directory',{exact:true}).fill(f.root);
 await branchDialog.getByLabel('Engine: codex',{exact:true}).click();await page.getByRole('option',{name:'codex',exact:true}).click();
 await branchDialog.getByRole('button',{name:'Review changes',exact:true}).click();
 await branchDialog.getByText('You already have a Ponderosa speaker. The imported speaker will be disabled.',{exact:true}).waitFor();
 await page.screenshot({path:path.join(out,'branch-collision.png'),fullPage:true});
 const confirmed=page.waitForResponse(r=>r.url().endsWith('/confirm')&&r.request().method()==='POST'&&r.status()===200);
 await branchDialog.getByRole('button',{name:'Confirm import',exact:true}).click();
 const installed=await (await confirmed).json();assert.equal(installed.state,'completed',installed.error);
 const installedChats=f.ok(await f.api('GET',`/api/branches/${installed.branchId}/chats`));const agents=f.ok(await f.api('GET',`/api/branches/engine/projects/${installedChats[0].projectId}/agents`));
 assert.equal(agents.length,2);for(const agent of agents)assert.equal(f.ok(await f.api('GET',`/api/branches/output-apps/${agent.id}`)).speaker,false);
 await browser.close();browser=undefined;await f.reopen();assert.deepEqual(f.ok(await f.api('GET','/api/branches/assistant')).app,speaker.app);
 for(const id of [...imported.agentIds,...agents.map(a=>a.id)])assert.equal(f.ok(await f.api('GET',`/api/branches/output-apps/${id}`)).speaker,false);
 assert.deepEqual(errors,[]);assert.deepEqual(requests.filter(r=>r.status>=400),[]);
 await writeFile(path.join(out,'result.json'),JSON.stringify({passed:true,speaker:speaker.app,organizationOperation:operation.id,organization:imported,branch:installed,branchAgentIds:agents.map(a=>a.id),requests,errors,restart:true,limit:'Controlled adapters and browser file uploads; no real provider, voice or broad portability matrix.'},null,2));
 passed=true;console.log(JSON.stringify({passed:true,requests:requests.length,out}));
}catch(error){await page?.screenshot({path:path.join(out,'failed.png'),fullPage:true}).catch(()=>{});await writeFile(path.join(out,'failure.json'),JSON.stringify({error:String(error),requests,errors,fixtureRoot:f.root},null,2));throw error;}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await f.dispose(passed);if(!passed)console.log('Failed owned fixture retained: '+f.root);console.log('Owned import browser/server/provider fixtures closed');}
