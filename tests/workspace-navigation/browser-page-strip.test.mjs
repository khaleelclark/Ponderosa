import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';

const webRoot=fileURLToPath(new URL('../../apps/web/',import.meta.url));
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const {createRsbuild}=require('@rsbuild/core'),{pluginReact}=require('@rsbuild/plugin-react');
const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');

test('Browser page tabs own only tabs; adjacent add action preserves selection, keyboard and management guards',async t=>{
 await mkdir(path.join(webRoot,'node_modules/.cache'),{recursive:true});
 const root=await mkdtemp(path.join(webRoot,'node_modules/.cache/browser-tabs-'));
 let browser,preview;
 t.after(async()=>{await browser?.close();await preview?.server.close();await rm(root,{recursive:true,force:true});});
 await writeFile(path.join(root,'entry.tsx'),`
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {ThemeProvider,createTheme} from '@mui/material/styles';import CssBaseline from '@mui/material/CssBaseline';
 import {BrowserPageStrip} from ${JSON.stringify(path.join(webRoot,'src/components/browser/BrowserPageStrip.tsx'))};
 const params=new URLSearchParams(location.search);window.events=[];
 function App(){const [active,setActive]=React.useState('a');const [guard,setGuard]=React.useState('normal');
 window.setGuard=setGuard;
 const pages=Array.from({length:guard==='limit'?30:2},(_,i)=>({id:i===0?'a':i===1?'b':String(i),title:i===0?'Alpha':i===1?'Beta':'Page '+i,closable:true,active:i===0}));
 return <ThemeProvider theme={createTheme({palette:{mode:params.get('theme')||'light'}})}><CssBaseline/><BrowserPageStrip pages={guard==='empty'?[]:pages} activePageId={active} canManage={guard!=='readonly'} busy={guard==='busy'} onNew={guard==='noadd'?undefined:()=>window.events.push('new')} onActivate={id=>{window.events.push('activate:'+id);setActive(id)}} onClose={id=>window.events.push('close:'+id)}/></ThemeProvider>}
 createRoot(document.getElementById('root')!).render(<App/>);`);
 const rsbuild=await createRsbuild({cwd:webRoot,rsbuildConfig:{plugins:[pluginReact()],source:{entry:{index:path.join(root,'entry.tsx')}},output:{distPath:{root:path.join(root,'dist')}},html:{templateContent:'<!doctype html><html><body><div id="root"></div></body></html>'},server:{host:'127.0.0.1',port:38429,open:false}}});
 await rsbuild.build();preview=await rsbuild.preview();
 browser=await chromium.launch({executablePath:process.env.PONDEROSA_BROWSER_EXECUTABLE||'/usr/bin/google-chrome',headless:true});
 const results=[];const evidence=process.env.PONDEROSA_TABLIST_EVIDENCE;
 if(evidence)await mkdir(evidence,{recursive:true});
 for(const mobile of [false,true])for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:962},deviceScaleFactor:mobile?3:1,isMobile:mobile,hasTouch:mobile});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${preview.port}/?theme=${theme}`);
  const tabs=page.getByRole('tablist',{name:'Browser pages'}),add=page.getByRole('button',{name:'New browser tab'});
  await tabs.waitFor();await add.waitFor();await page.evaluate(()=>document.fonts.ready);
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('[role=tablist]')).display==='flex');
  const structure=await tabs.evaluate(el=>({children:[...el.children].map(x=>({role:x.getAttribute('role'),name:x.getAttribute('aria-label')})),nestedAdd:!!el.querySelector('[aria-label="New browser tab"]')}));
  const id=`${mobile?'mobile':'desktop'}-${theme}`;
  if(evidence){await page.screenshot({path:path.join(evidence,id+'.png')});await writeFile(path.join(evidence,id+'.html'),await page.content());await writeFile(path.join(evidence,id+'.json'),JSON.stringify({structure,errors},null,2));}
  assert.equal(structure.nestedAdd,false,'New browser tab must be outside tablist');
  assert.deepEqual(structure.children.map(x=>x.role),['tab','tab']);
  assert.equal(await page.getByRole('tab',{name:'Alpha',exact:true}).getAttribute('aria-selected'),'true');
  const beta=page.getByRole('tab',{name:'Beta',exact:true});await beta.focus();await page.keyboard.press('Enter');
  assert.equal(await beta.getAttribute('aria-selected'),'true');
  const alpha=page.getByRole('tab',{name:'Alpha',exact:true});await alpha.focus();await page.keyboard.press('Space');
  assert.equal(await alpha.getAttribute('aria-selected'),'true');
  await page.keyboard.press('Delete');
  if(mobile)await add.tap();else await add.click();
  assert.deepEqual(await page.evaluate(()=>window.events),['activate:b','activate:a','close:a','new']);
  await page.getByRole('button',{name:'Close Beta',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.events),['activate:b','activate:a','close:a','new','close:b']);
  for(const guard of ['readonly','busy','limit']){await page.evaluate(g=>window.setGuard(g),guard);await page.waitForFunction(()=>document.querySelector('[aria-label="New browser tab"]')?.disabled);assert.equal(await add.isDisabled(),true);}
  await page.evaluate(()=>window.setGuard('noadd'));await add.waitFor({state:'detached'});assert.equal(await tabs.getByRole('tab').count(),2);
  await page.evaluate(()=>window.setGuard('empty'));await tabs.waitFor({state:'detached'});
  assert.deepEqual(errors,[]);results.push({id,status:'pass',structure,viewport:await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})),errors});await context.close();
 }
 if(evidence)await writeFile(path.join(evidence,'results.json'),JSON.stringify({engine:await browser.version(),results},null,2));
});
