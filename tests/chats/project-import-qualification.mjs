// Built web + disposable real API + native file inputs. All traffic/data is owned loopback.
import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {fixture,until}=await import('../shared/fixture.mjs');
const {chromium,webkit,devices}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const root=fileURLToPath(new URL('../../',import.meta.url));
const dist=process.env.PONDEROSA_PROJECT_IMPORT_WEB_DIST??path.join(root,'apps/web/dist');
const out=process.env.PONDEROSA_PROJECT_IMPORT_EVIDENCE??await mkdtemp(path.join(tmpdir(),'ponderosa-project-import-'));
await mkdir(out,{recursive:true});
const rows=[];let browser,context,f;
const save=()=>writeFile(path.join(out,'results.json'),JSON.stringify({rows,realDeviceVerified:false,dist},null,2)+'\n');
async function inspect(attachment,origin,name){
 const response=await fetch(origin+attachment.downloadUrl);assert(response.ok);
 const archive=path.join(out,name+'.zip');await writeFile(archive,Buffer.from(await response.arrayBuffer()));
 const {stdout}=await promisify(execFile)(process.env.PYTHON??'python3',['-c','import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({n:list(z.read(n)) for n in z.namelist()}))',archive]);
 return JSON.parse(stdout);
}
try{
 for(const engine of (process.env.PONDEROSA_PROJECT_IMPORT_BROWSERS??'chromium,webkit').split(',')){
  browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='webkit'?{executablePath:process.env.PONDEROSA_WEBKIT_PATH}:{executablePath:process.env.PONDEROSA_CHROME_PATH??'/usr/bin/google-chrome',args:['--no-sandbox']})});
  for(const width of [1440,390])for(const mode of ['light','dark'])for(const view of ['chat','assistant']){
   const name=`${engine}-${width}-${mode}-${view}`,row={name,engine,width,mode,view,passed:false,errors:[],checks:[]};rows.push(row);
   f=await fixture({webDist:dist});let route;
   if(view==='assistant'){f.ok(await f.api('POST','/api/branches/assistant',{initialize:true}));route='/assistant';}
   else {const chat=await f.createChat('Project Import QA');await f.createIdleAgent(chat,'Project Import Agent');route=`/projects/${chat.projectId}/chats/${chat.id}`;}
   const origin=await f.listen();assert.equal(new URL(origin).hostname,'127.0.0.1');
   context=await browser.newContext({...(width===390&&engine==='webkit'?devices['iPhone 13']:{viewport:{width,height:width===390?844:962},isMobile:width===390,hasTouch:width===390}),serviceWorkers:'block',acceptDownloads:false});
   await context.addInitScript(mode=>localStorage.setItem('ponderosa-color-mode',mode),mode);
   const uploadRequests=new Set();
   const observeUpload=request=>{if(request.method()==='POST'&&/\/draft-attachments$/.test(new URL(request.url()).pathname))uploadRequests.add(request);};
   await context.route('**/*',route=>{assert.equal(new URL(route.request().url()).origin,origin,'Only owned loopback traffic');observeUpload(route.request());return route.continue();});
   const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>row.errors.push(error.message));
   try{
    await page.goto(origin+route,{waitUntil:'domcontentloaded'});await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
    const project=path.join(out,name,'project');
    const sources={'.gitignore':'node_modules\n','.github/workflows/build.yml':'name: Build\n','.env.example':'EXAMPLE=\n','Dockerfile':'FROM scratch\n','src/café.ts':new Uint8Array([0,255,42]),'empty':new Uint8Array(),'design.key':'Synthetic presentation bytes','credentials.md':'Synthetic project documentation','.env':'Synthetic excluded environment','.git/config':'Synthetic excluded internals','node_modules/pkg.js':'Synthetic excluded dependency'};
    for(const [relative,bytes]of Object.entries(sources)){const target=path.join(project,relative);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes);}
    await page.getByRole('button',{name:'Add Attachment Or Capability',exact:true}).click();
    const folderAction=page.getByRole('menuitem',{name:/^Folder/});await folderAction.scrollIntoViewIfNeeded();assert((await folderAction.innerText()).includes('Some folder pickers omit hidden files'),'Picker fallback remains available before any folder report exists');
    const uploaded=page.waitForResponse(response=>response.request().method()==='POST'&&/\/draft-attachments$/.test(new URL(response.url()).pathname)&&response.ok());
    await page.getByLabel('Choose Folder',{exact:true}).evaluate(input=>input.addEventListener('change',event=>{
      window.projectImportNativeFiles=Array.from(event.target.files??[]).map(file=>file.webkitRelativePath);
    },{capture:true,once:true}));
    const folderChooser=page.waitForEvent('filechooser');await folderAction.click();await(await folderChooser).setFiles(project);
    row.nativeFilePaths=await page.evaluate(()=>window.projectImportNativeFiles);
    const initialResponse=await uploaded,initial=await initialResponse.json();assert.equal(initial.name,'project.zip');
    await page.getByRole('button',{name:'Remove project.zip',exact:true}).waitFor();
    const reviewButton=page.getByRole('button',{name:'Review Excluded Items',exact:true});await reviewButton.waitFor();
    assert.equal(await page.getByRole('alert').filter({hasText:/Skipped|hidden, sensitive/}).count(),0);
    const before=await inspect(initial,origin,name+'-before');
    const eligible=['project/.gitignore','project/.github/workflows/build.yml','project/.env.example','project/Dockerfile','project/src/café.ts','project/empty'];
    row.browserOmittedPaths=eligible.filter(path=>!row.nativeFilePaths.includes(path));
    assert(row.browserOmittedPaths.every(path=>path.split('/').some(component=>component.startsWith('.'))),'Native selection must supply all visible fixture files');
    assert.deepEqual(Object.keys(before).sort(),eligible.filter(path=>row.nativeFilePaths.includes(path)).sort());
    assert.deepEqual(before['project/src/café.ts'],[0,255,42]);assert.deepEqual(before['project/empty'],[]);
    row.checks.push('native folder picker, real opaque ZIP upload, independent CRC/member/byte inspection');
    await until(async()=>page.evaluate(id=>Object.keys(localStorage).filter(key=>key.startsWith('ponderosa.folder-imports.v1.')).some(key=>{try{return JSON.parse(localStorage.getItem(key)).reports.some(report=>report.archiveId===id);}catch{return false;}}),initial.id),'local report is bound to durable archive');
    const draftPath=new URL(initialResponse.url()).pathname.replace(/draft-attachments$/,'draft')+'?ownerId='+encodeURIComponent(initial.ownerId);
    await until(async()=>f.ok(await f.api('GET',draftPath)).attachmentIds.includes(initial.id),'canonical staged draft saves exact archive before reload');
    await page.screenshot({animations:'disabled',path:path.join(out,name+'-summary.png')});
    let denyDownload=true;
    await page.route('**/*',route=>{
     const request=route.request(),url=new URL(request.url());assert.equal(url.origin,origin,'Only owned loopback traffic');observeUpload(request);
     if(denyDownload&&request.method()==='GET'&&url.pathname.endsWith('/draft-attachments/'+initial.id))return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Controlled transient attachment read failure'})});
     return route.continue();
    });
    await page.reload({waitUntil:'domcontentloaded'});
    const failedRestore=page.getByRole('alert').filter({hasText:'project.zip could not be restored from this draft.'});await failedRestore.waitFor();
    await reviewButton.waitFor();await reviewButton.click();
    const retainedReview=page.getByRole('dialog',{name:'Review Excluded Items',exact:true});await retainedReview.getByText('project/design.key',{exact:true}).waitFor();
    assert(await retainedReview.getByRole('button',{name:'Select Folder Again',exact:true}).isDisabled(),'Canonical failed download keeps explanation and blocks rebuild until restored');
    await retainedReview.getByRole('button',{name:'Close',exact:true}).click();await retainedReview.waitFor({state:'hidden'});
    denyDownload=false;await failedRestore.getByRole('button',{name:'Retry',exact:true}).click();await page.getByRole('button',{name:'Remove project.zip',exact:true}).waitFor();
    row.checks.push('reload retains exact archive metadata through failed download and successful Retry');
    await reviewButton.click();
    const dialog=page.getByRole('dialog',{name:'Review Excluded Items',exact:true});await dialog.waitFor();
    await dialog.getByText('project/design.key',{exact:true}).waitFor();assert((await dialog.innerText()).includes(`${row.nativeFilePaths.some(path=>path.startsWith('project/.git/'))?2:1} excluded folders`));await dialog.getByText(/Some folder pickers omit hidden files/).waitFor();
    const metrics=await dialog.evaluate(element=>({dialog:element.getBoundingClientRect().toJSON(),scroll:element.scrollWidth,client:element.clientWidth,viewport:innerWidth}));
    assert(metrics.dialog.x>=0&&metrics.dialog.right<=metrics.viewport+1&&metrics.scroll<=metrics.client+1,'Review stays inside desktop/phone viewport');row.metrics=metrics;
    await page.screenshot({animations:'disabled',path:path.join(out,name+'-review.png')});
    await dialog.getByRole('button',{name:'Close',exact:true}).click();await reviewButton.click();await dialog.getByText('project/design.key',{exact:true}).waitFor();
    await dialog.getByRole('checkbox',{name:/project\/design\.key/}).check();
    const rebuilt=page.waitForResponse(response=>response.request().method()==='POST'&&/\/draft-attachments$/.test(new URL(response.url()).pathname)&&response.ok());
    const reselect=page.waitForEvent('filechooser');await dialog.getByRole('button',{name:'Select Folder Again',exact:true}).click();await(await reselect).setFiles(project);const updated=await(await rebuilt).json();assert.notEqual(updated.id,initial.id);
    const after=await inspect(updated,origin,name+'-after');
    assert.deepEqual(after,{...before,'project/design.key':Array.from(Buffer.from(sources['design.key']))});
    await dialog.getByText(/File · .*Included/).waitFor();
    row.checks.push('dismiss/reopen preserves reasons, deliberate Keynote inclusion, exact replacement with other omissions retained');
    await dialog.getByRole('button',{name:'Close',exact:true}).click();await dialog.waitFor({state:'hidden'});await page.getByRole('button',{name:'Remove project.zip',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Remove project.zip',exact:true}).count(),1);
    const selectedHidden=page.waitForResponse(response=>response.request().method()==='POST'&&/\/draft-attachments$/.test(new URL(response.url()).pathname)&&response.ok());
    const fileSelectionUrl=page.url(),hiddenChooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Add Attachment Or Capability',exact:true}).click();await page.getByRole('menuitem',{name:/^Files/}).click();await(await hiddenChooser).setFiles(path.join(project,'.gitignore'));assert.equal(page.url(),fileSelectionUrl,'File selection must not navigate');
    assert((await selectedHidden).ok());
    const hidden=await until(async()=>f.ok(await f.api('GET',draftPath)).attachments?.find(file=>file.name==='.gitignore'),'canonical direct hidden-file attachment');assert.equal(hidden.name,'.gitignore');
    const hiddenRead=await fetch(origin+hidden.downloadUrl);assert(hiddenRead.ok);assert.equal(await hiddenRead.text(),sources['.gitignore']);
    // Existing ZIPs use the ordinary opaque attachment path, preserving hidden project files.
    const complete=path.join(out,name+'-complete-project.zip');
    await promisify(execFile)(process.env.PYTHON??'python3',['-c','import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); [z.write(sys.argv[2]+"/"+p,"project/"+p) for p in sys.argv[3:]]; z.close()',complete,project,...eligible.map(path=>path.slice('project/'.length))]);
    const selectedZip=page.waitForResponse(response=>response.request().method()==='POST'&&/\/draft-attachments$/.test(new URL(response.url()).pathname)&&response.ok());
    const zipChooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Add Attachment Or Capability',exact:true}).click();await page.getByRole('menuitem',{name:/^Files/}).click();await(await zipChooser).setFiles(complete);assert((await selectedZip).ok());
    const opaque=await until(async()=>f.ok(await f.api('GET',draftPath)).attachments?.find(file=>file.name===path.basename(complete)),'canonical opaque ZIP attachment');
    const opaqueRead=await fetch(origin+opaque.downloadUrl);assert(opaqueRead.ok);assert.deepEqual(Buffer.from(await opaqueRead.arrayBuffer()),await readFile(complete));
    const completeContents=await inspect(opaque,origin,name+'-opaque');assert.deepEqual(Object.keys(completeContents).sort(),eligible.sort());
    row.checks.push('direct native hidden-file upload and unchanged opaque ZIP preserve full project alternatives');
    await page.getByRole('button',{name:'Remove project.zip',exact:true}).click();await until(async()=>await reviewButton.count()===0,'attachment removal clears local exclusion report');
    await page.getByRole('button',{name:'Remove .gitignore',exact:true}).waitFor();await page.getByRole('button',{name:'Remove '+path.basename(complete),exact:true}).waitFor();
    const remaining=await until(async()=>{const draft=f.ok(await f.api('GET',draftPath));return !draft.attachmentIds.includes(updated.id)&&draft.attachmentIds.includes(hidden.id)&&draft.attachmentIds.includes(opaque.id)?draft:false;},'canonical removal preserves other staged files');assert.deepEqual([...remaining.attachmentIds].sort(),[hidden.id,opaque.id].sort());
    assert.equal(uploadRequests.size,4,'Exactly initial ZIP, replacement ZIP, direct dotfile and opaque ZIP uploads; no replay or duplicate upload');row.uploadRequests=uploadRequests.size;
    assert.deepEqual(row.errors,[]);row.passed=true;console.log('PASS '+name);
   }catch(error){row.error=error.stack;await page.screenshot({animations:'disabled',path:path.join(out,name+'-FAIL.png')}).catch(()=>{});throw error;}
   finally{await context.close();context=undefined;await save();await f.dispose(false);f=undefined;}
  }
  await browser.close();browser=undefined;
 }
 assert.equal(rows.length,(process.env.PONDEROSA_PROJECT_IMPORT_BROWSERS??'chromium,webkit').split(',').length*8);assert(rows.every(row=>row.passed&&row.errors.length===0));
}finally{if(context)await context.close();if(browser)await browser.close();if(f)await f.dispose(false);await save();}
