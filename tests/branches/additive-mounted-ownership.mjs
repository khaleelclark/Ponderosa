import {createServer} from 'node:http';

// Own setup as well as the body: browser diagnostics must never prevent teardown.
export async function withMountedCell({prototype, deploy, requestHandler, browser, contextOptions, releaseReview, run, diagnose, record}) {
 const originalDeploy=prototype.deploy,secondary=[];
 let server,context,page,primary,failed=false;
 const attempt=async(stage,action)=>{try{await action();}catch(error){secondary.push({stage,error});}};
 try {
  prototype.deploy=deploy;
  server=createServer(requestHandler);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  context=await browser.newContext(contextOptions);
  page=await context.newPage();
  await run({server,context,page});
 } catch(error) {
  failed=true;primary=error;
  if(page)await attempt('diagnostic',()=>diagnose(page));
 } finally {
  await attempt('release review',()=>releaseReview());
  if(context)await attempt('context close',()=>context.close());
  if(server){
   await attempt('close connections',()=>server.closeAllConnections());
   await attempt('server close',()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  }
  await attempt('restore prototype',()=>{prototype.deploy=originalDeploy;});
 }
 try{await record({failed,primary,secondary});}catch(error){
  secondary.push({stage:'record',error});
  // If writing diagnostics itself fails, retain every secondary failure in the test log.
  console.error('Mounted cell diagnostic/cleanup failures',secondary);
 }
 if(failed)throw primary;
 if(secondary.length)throw new AggregateError(secondary.map(({error})=>error),'Mounted cell diagnostic/cleanup failed');
}
