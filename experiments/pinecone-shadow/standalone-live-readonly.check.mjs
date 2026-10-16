import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Explicit read-only qualification against an already-running backend.
// Never starts a daemon, creates data, changes schedules or sends a message.
assert(process.env.PINECONE_READONLY_BACKEND,'Set the approved existing PINECONE_READONLY_BACKEND.');
assert(process.env.PONDEROSA_PLAYWRIGHT_PATH,'Set the existing PONDEROSA_PLAYWRIGHT_PATH.');
const backend=new URL(process.env.PINECONE_READONLY_BACKEND);
assert.equal(backend.protocol,'http:');
const {chromium}=await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const root=fileURLToPath(new URL('../../apps/web/dist/pinecone/',import.meta.url));
const branchId='0356095a-8d73-4249-b39d-883b978ae119';
const get=async p=>{const response=await fetch(new URL(p,backend),{signal:AbortSignal.timeout(8000)});assert.equal(response.status,200,p);return response.json();};
const bindings=await get(`/api/branches/${branchId}/configuration`),agentId=bindings.agents.spokesperson;
const detail=await get(`/api/branches/engine/agents/${agentId}?limit=60`);
assert.equal(detail.agent.projectId,'bc94178c-d588-5d5b-a0f6-d409fe773606');
assert.equal(detail.agent.conversationId,'1982c3cc-702b-5f2b-aab9-76abe3f5c277');
const last=[...detail.messages].reverse().find(m=>m.role==='assistant'&&m.authorAgentId===agentId&&m.communicationIntent!=='collaboration'&&!m.document&&m.text.trim());
assert(last,'Expected an existing canonical plain-text reply.');
const writes=[],errors=[],failedReads=[];
const server=createServer(async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){writes.push(req.method+' '+req.url);res.writeHead(403);res.end('Read-only qualification');return;}
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
    const upstream=request(new URL(req.url,backend),{method:req.method,headers:{host:backend.host}},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
    res.on('close',()=>upstream.destroy());upstream.end();return;
  }
  try{
    const file=path.resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));assert(file.startsWith(root));
    const body=await readFile(file),mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2','.svg':'image/svg+xml'}[path.extname(file)]??'application/octet-stream';
    res.writeHead(200,{'Content-Type':mime});res.end(body);
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.PONDEROSA_CHROMIUM_PATH});
  const page=await browser.newPage({viewport:{width:390,height:844}});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('response',response=>{if(response.url().includes('/api/')&&response.status()>=400)failedReads.push({status:response.status(),path:new URL(response.url()).pathname});});
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('textbox',{name:'Message Pinecone',exact:true}).waitFor();
  await page.locator(`article[data-message-id=${JSON.stringify(last.id)}]`).waitFor();
  assert.equal(await page.getByRole('button',{name:'Back to Branches'}).count(),0);
  assert(await page.getByRole('button',{name:'Call Pinecone',exact:true}).isEnabled());
  const layout=await page.evaluate(()=>({width:innerWidth,height:innerHeight,composerBottom:document.querySelector('form').getBoundingClientRect().bottom,horizontalOverflow:document.documentElement.scrollWidth>innerWidth}));
  assert(!layout.horizontalOverflow);assert(layout.composerBottom<=layout.height+1);
  assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);assert.deepEqual(failedReads,[]);
  const result={at:new Date().toISOString(),passed:true,readOnly:true,branchId,agentId,projectId:detail.agent.projectId,conversationId:detail.agent.conversationId,canonicalReplyId:last.id,canonicalReplyRendered:true,layout,writes,errors,failedReads,providerMessagesSent:0,callsStarted:0,physicalAudioTested:false};
  if(process.env.PINECONE_TEST_EVIDENCE){await mkdir(process.env.PINECONE_TEST_EVIDENCE,{recursive:true});await writeFile(path.join(process.env.PINECONE_TEST_EVIDENCE,'standalone-live-readonly.json'),JSON.stringify(result,null,2)+'\n');}
  console.log(JSON.stringify(result));
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
