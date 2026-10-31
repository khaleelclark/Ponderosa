// Installed Chrome/Xvfb/xdotool; rebuilt web assets and disposable controlled provider.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {deflateSync,crc32} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const require=createRequire(new URL('../../apps/server/package.json',import.meta.url));
const {chromium}=require('playwright-core');
const root=fileURLToPath(new URL('../../',import.meta.url));
const output=process.env.QUALIFICATION_DIRECTORY;
assert.ok(output&&process.env.AXE_CORE_PATH,'Set QUALIFICATION_DIRECTORY and AXE_CORE_PATH');
await mkdir(path.join(output,'framebuffer'),{recursive:true});
const fixture=spawn(process.execPath,['--import','./tests/shared/workspace-resolution.mjs','tests/branches/ui-qualification.mjs'],{cwd:root,stdio:['ignore','pipe','inherit']});
const xvfb=spawn('Xvfb',['-displayfd','1','-screen','0','1600x1000x24','-nolisten','tcp','-fbdir',path.join(output,'framebuffer')],{stdio:['ignore','pipe','inherit']});
const fixtureExit=once(fixture,'exit'),displayExit=once(xvfb,'exit');
let browser;const results=[];
// Capture the native framebuffer: CDP screenshots can crop at browser zoom.
async function captureDesktop(name){
 const frame=await readFile(path.join(output,'framebuffer','Xvfb_screen0'));
 const h=Array.from({length:25},(_,i)=>frame.readUInt32BE(i*4));
 const [header,version,,,width,height,,order,,,,bpp,stride,,red,green,blue,,,colors]=h;
 assert.equal(version,7);assert.equal(order,0);assert.equal(bpp,32);
 assert.deepEqual([red,green,blue],[0xff0000,0xff00,0xff]);
 const pixels=frame.subarray(header+colors*12),rgb=Buffer.alloc((width*3+1)*height);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const from=y*stride+x*4,to=y*(width*3+1)+1+x*3;
  rgb[to]=pixels[from+2];rgb[to+1]=pixels[from+1];rgb[to+2]=pixels[from];
 }
 const chunk=(name,data)=>{const tag=Buffer.from(name),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([tag,data])));return Buffer.concat([length,tag,data,crc]);};
 const size=Buffer.alloc(13);size.writeUInt32BE(width);size.writeUInt32BE(height,4);size[8]=8;size[9]=2;
 await writeFile(path.join(output,name),Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',size),chunk('IDAT',deflateSync(rgb)),chunk('IEND',Buffer.alloc(0))]));
}
async function tabTo(page,target){
 for(let i=0;i<180;i++) {if(await target.evaluate(el=>el===document.activeElement))return i;await page.keyboard.press('Tab');}
 throw Error('Keyboard target not reached: '+await target.getAttribute('aria-label'));
}
try {
 const display=':'+String((await once(xvfb.stdout,'data'))[0]).trim();
 const env={...process.env,DISPLAY:display};
 let manifest;
 for await(const line of createInterface({input:fixture.stdout}))if(line.startsWith('{"origin":')){manifest=JSON.parse(line);break;}
 assert.ok(manifest,'Fixture ready');
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/usr/bin/google-chrome',headless:false,env,args:['--no-sandbox','--window-size=1280,900']});
 for(const product of ['core','branches'])for(const theme of ['light','dark'])for(const scale of [1,2,4]){
  if(process.env.QUALIFICATION_CASE&&process.env.QUALIFICATION_CASE!==`${product}-${theme}-${scale}`)continue;
  const context=await browser.newContext({viewport:null});
  const row={product,theme,scale,actions:[],scans:[],errors:[]};results.push(row);
  try{
   const page=await context.newPage();await page.addInitScript(()=>{window.focusTrace=[];addEventListener('focusin',event=>window.focusTrace.push({at:performance.now(),target:event.target.outerHTML.slice(0,200)}),true);});page.setDefaultTimeout(10_000);page.on('pageerror',e=>row.errors.push(e.message));
   await page.addInitScript(theme=>localStorage.setItem('ponderosa-color-mode',theme),theme);
   await page.goto(product==='core'?manifest.normalUrl:manifest.url);
   const editor=page.getByLabel('Message',{exact:true});await editor.waitFor();await page.bringToFront();
   execFileSync('xdotool',['key','--clearmodifiers','ctrl+0',...Array(scale===4?8:scale===2?5:0).fill('ctrl+plus')],{env});
   await page.waitForFunction(scale=>devicePixelRatio===scale,scale);
   row.metrics=await page.evaluate(()=>({dpr:devicePixelRatio,width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,colorScheme:document.documentElement.style.colorScheme,font:getComputedStyle(document.querySelector('[aria-label="Message"]')).fontSize}));
   assert.equal(row.metrics.colorScheme,theme);assert.ok(row.metrics.scrollWidth<=row.metrics.width,'No page-wide overflow at native zoom');
   if(product==='core'&&theme==='light'&&scale===1)assert.ok(await page.getByText('Write a message…',{exact:true}).isVisible(),'Empty composer placeholder is present for contrast verification');
   await page.addScriptTag({path:process.env.AXE_CORE_PATH});
   row.scans.push({surface:'empty-chat',...await page.evaluate(()=>window.axe.run())});
   row.actions.push({name:'Tab to editor',tabs:await tabTo(page,editor)});
   await page.keyboard.press('Control+A');await page.keyboard.press('Backspace');
   const marker=`a11y-${product}-${theme}-${scale}`;
   await page.keyboard.type(marker);await page.keyboard.press('Shift+Enter');await page.keyboard.type('tail');
   const send=page.getByRole('button',{name:'Send message',exact:true});
   row.actions.push({name:'Tab to Send',tabs:await tabTo(page,send)});
   const sent=page.waitForRequest(r=>r.method()==='POST'&&r.postData()?.includes(marker));
   await page.keyboard.press('Enter');await sent;
   row.actions.push({name:'Keyboard explicit Send',pass:true});
   const actions=page.getByRole('button',{name:'Chat settings and actions',exact:true});
   row.actions.push({name:'Tab to Chat actions',tabs:await tabTo(page,actions)});await page.keyboard.press('Enter');
   const rename=page.getByRole('menuitem',{name:'Rename',exact:true});await rename.waitFor();
   await page.waitForFunction(()=>Boolean(document.activeElement?.closest('.MuiMenu-paper')));
   await rename.evaluate(async element=>{await Promise.all(element.closest('[role=menu]').parentElement.getAnimations().map(animation=>animation.finished.catch(()=>{})));});
   if(!await rename.evaluate(el=>document.activeElement?.closest('[role=menu]'))){await page.keyboard.press('Tab');row.actions.push({name:'Tab from menu surface to first item',pass:true});}
   for(let i=0;i<30&&!await rename.evaluate(el=>el===document.activeElement);i++)await page.keyboard.press('ArrowDown');
   assert.ok(await rename.evaluate(el=>el===document.activeElement));await page.keyboard.press('Enter');
   const name=page.getByLabel('Chat name',{exact:true});await name.waitFor();assert.ok(await name.evaluate(el=>el===document.activeElement));
   await page.keyboard.press('Control+A');await page.keyboard.type(marker+' renamed');await page.keyboard.press('Enter');await name.waitFor({state:'hidden'});
   row.actions.push({name:'Keyboard rename Enter',pass:true});
   await page.addScriptTag({path:process.env.AXE_CORE_PATH});
   row.scans.push({surface:'chat',...await page.evaluate(()=>window.axe.run())});
   await captureDesktop(`${product}-${theme}-${scale}-chat.png`);
   await page.goto(manifest.origin+(product==='core'?'/settings/general':'/branches?settings=general'));
   const instructions=page.getByLabel('Global Agent Instructions',{exact:true});await instructions.waitFor();
   row.actions.push({name:'Tab to instructions',tabs:await tabTo(page,instructions)});
   await page.keyboard.press('Control+A');await page.keyboard.type(marker+' instructions');
   assert.equal(await instructions.inputValue(),marker+' instructions');
   await page.addScriptTag({path:process.env.AXE_CORE_PATH});row.scans.push({surface:'settings',...await page.evaluate(()=>window.axe.run())});
   await captureDesktop(`${product}-${theme}-${scale}-settings.png`);
   for(const scan of row.scans)assert.deepEqual(scan.violations.filter(v=>['critical','serious'].includes(v.impact)).map(v=>v.id),[],`${product}/${theme}/${scale}/${scan.surface}: no critical or serious axe findings`);
   assert.deepEqual(row.errors,[]);row.status='pass';console.log(`PASS ${product} ${theme} native zoom ${scale*100}%`);
  }catch(error){row.status='failed';row.error=error.stack;row.focusTrace=await context.pages()[0]?.evaluate(()=>window.focusTrace).catch(()=>null);row.focus=await context.pages()[0]?.evaluate(()=>document.activeElement?.outerHTML).catch(()=>null);await context.pages()[0]?.screenshot({path:path.join(output,`${product}-${theme}-${scale}-failure.png`)}).catch(()=>{});throw error;}
  finally{await context.close();await writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2));}
 }
}finally{
 await browser?.close();fixture.kill('SIGTERM');await fixtureExit;xvfb.kill('SIGTERM');await displayExit;
}
