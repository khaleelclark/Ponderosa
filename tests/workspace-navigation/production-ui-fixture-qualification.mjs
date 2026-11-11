// 100-message production-route smoke only; no workers or performance qualification.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {fixture} from '../shared/fixture.mjs';
import {seedQualificationHistory} from '../shared/ui-load-fixture.mjs';
import {AgentStore} from '../../packages/agents/dist/index.js';
const out=process.env.PONDEROSA_UI_EVIDENCE;assert(out,'Owned evidence directory required');await mkdir(out,{recursive:true});
const webDist=fileURLToPath(new URL('../../apps/web/dist/',import.meta.url));
const result={kind:'Existing production UI/API shared listener, 100 synthetic messages',requests:[],pageErrors:[],cleanup:[]};
let f,listener,browser,context,page,store;
try{
 f=await fixture({webDist,storeFactory:dir=>(store=new AgentStore(dir))});
 const chat=await f.createChat('Production UI smoke'),seed=seedQualificationHistory(store,chat,100);
 listener=f.app.server;const origin=await f.listen(),route='/projects/'+chat.projectId+'/chats/'+chat.id;
 result.origin=origin;result.listenerOwner='fixture';result.separateWebServer=false;
 const spa=await fetch(origin+route,{headers:{'accept-encoding':'identity'}});
 assert.equal(spa.status,200);assert.match(spa.headers.get('content-type'),/^text\/html/);assert.equal(spa.headers.get('cache-control'),'no-cache');
 const html=await spa.text();assert.equal(html,await readFile(webDist+'/index.html','utf8'));
 result.spaHeaders=Object.fromEntries(spa.headers);
 const assetPath=[...html.matchAll(/<script\b[^>]*src=["']([^"']+)["']/g)].map(match=>match[1]).find(path=>path.startsWith('/static/js/'));
 assert(assetPath,'Built SPA must reference a hashed script');
 const asset=await fetch(origin+assetPath,{headers:{'accept-encoding':'identity'}});
 assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/^text\/javascript/);
 assert.equal(asset.headers.get('cache-control'),'public, max-age=31536000, immutable');
 const original=await readFile(webDist+assetPath);assert.deepEqual(Buffer.from(await asset.arrayBuffer()),original);
 const compressed=await fetch(origin+assetPath,{headers:{'accept-encoding':'br'}});
 assert.equal(compressed.status,200);assert.equal(compressed.headers.get('content-encoding'),'br');assert(compressed.headers.get('vary').toLowerCase().split(',').map(value=>value.trim()).includes('accept-encoding'));
 assert.deepEqual(Buffer.from(await compressed.arrayBuffer()),original,'Production compression preserves exact asset bytes');
 result.assetHeaders=Object.fromEntries(asset.headers);result.compressedAssetHeaders=Object.fromEntries(compressed.headers);
 const response=await fetch(origin+'/api/conversations/'+chat.id+'?limit=100');assert.equal(response.status,200);
 const data=await response.json();assert.equal(data.messages.length,100);assert.equal(data.messages.at(-1).id,seed.lastId);assert.equal(data.messages.at(-1).text,seed.lastText);
 const unknown=await fetch(origin+'/api/not-a-route');assert.equal(unknown.status,404,'An unknown API route must not become the SPA');
 const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
 browser=await chromium.launch({executablePath:'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
 context=await browser.newContext({viewport:{width:1365,height:768},serviceWorkers:'block'});page=await context.newPage();page.setDefaultTimeout(10000);
 await page.route('**/*',request=>new URL(request.request().url()).origin===origin?request.continue():request.abort());
 page.on('pageerror',error=>result.pageErrors.push(error.message));page.on('request',request=>result.requests.push({url:request.url(),type:request.resourceType()}));
 await page.goto(origin+route);await page.getByLabel('Message',{exact:true}).waitFor();
 const tail=page.locator('#master-message-'+seed.lastId);await tail.waitFor({state:'visible'});assert.match(await tail.innerText(),/Qualification 99:/);
 assert(result.requests.some(request=>new URL(request.url).pathname===assetPath));
 assert(result.requests.some(request=>new URL(request.url).pathname==='/api/conversations/'+chat.id));
 assert(result.requests.every(request=>new URL(request.url).origin===origin));assert.equal(f.turns.length,0);assert.deepEqual(result.pageErrors,[]);
 result.canonicalMessages=100;result.providerTurns=0;result.sameOriginSpaAssetsAndApi=true;result.passed=true;await page.screenshot({path:out+'/production-shared-listener.png'});
}catch(error){result.error=error.stack;if(page)await page.screenshot({path:out+'/failure.png',timeout:3000}).catch(()=>{});}
finally{
 for(const [name,close]of[['context',()=>context?.close()],['browser',()=>browser?.close()],['fixture-shared-listener',async()=>{await f?.dispose(false);if(listener){assert.equal(listener.listening,false,'Fixture owns and closes the actual UI/API listener');result.listenerClosed=true;}}]])try{await close();result.cleanup.push({name,status:'complete'});}catch(error){result.cleanup.push({name,status:'failed',error:String(error)});}
 await writeFile(out+'/result.json',JSON.stringify(result,null,2));
}
console.log(JSON.stringify({passed:result.passed,error:result.error,sameOriginSpaAssetsAndApi:result.sameOriginSpaAssetsAndApi,canonicalMessages:result.canonicalMessages,listenerClosed:result.listenerClosed,cleanup:result.cleanup}));
if(!result.passed||result.cleanup.some(row=>row.status!=='complete'))process.exitCode=1;
