// Run after a build: node --import ./tests/shared/workspace-resolution.mjs tests/chats/composer-clipboard-qualification.mjs
// Uses an installed Chromium (CHROME_PATH) and disposable controlled-provider data only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const root = fileURLToPath(new URL('../../', import.meta.url));
const child = spawn(process.execPath, ['--import', './tests/shared/workspace-resolution.mjs', 'tests/branches/ui-qualification.mjs'], {cwd:root, stdio:['ignore','pipe','inherit']});
let browser;
const scans=[];
const normalize = text => text.replace(/\r\n?/g, '\n');
try {
  const lines = createInterface({input:child.stdout});
  let manifest;
  for await (const line of lines) { if (line.startsWith('{"origin":')) { manifest = JSON.parse(line); break; } }
  assert.ok(manifest, 'Disposable fixture started');
  const state = await (await fetch(manifest.origin + '/api/__qualification/state')).json();
  const coreAgents = await (await fetch(`${manifest.origin}/api/projects/${state.normal.projectId}/agents`)).json();
  const coreAgent = (Array.isArray(coreAgents) ? coreAgents : coreAgents.agents)[0];
  browser = await chromium.launch({executablePath:process.env.CHROME_PATH ?? '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  let cases = 0;
  for (const mobile of [false,true]) for (const surface of ['core-shared','core-direct','branches-shared','branches-direct','inbox']) {
    const context = await browser.newContext({permissions:['clipboard-read','clipboard-write'], viewport: mobile ? {width:390,height:844} : {width:1440,height:1000}, ...(mobile ? {isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36'} : {})});
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const sends = [];
      page.on('request', request => {
        if (request.method() !== 'POST') return;
        try { const body=request.postDataJSON(); if (typeof (body?.text ?? body?.initialMessage) === 'string') sends.push(body.text ?? body.initialMessage); } catch {}
      });
      await page.addInitScript(() => { window.pastes=[]; addEventListener('paste',event => window.pastes.push({trusted:event.isTrusted,text:event.clipboardData.getData('text/plain')}),true); });
      await page.goto(surface==='inbox' ? manifest.origin+'/messages' : surface.startsWith('core') ? manifest.normalUrl : manifest.url);
      const editor=page.getByLabel('Message',{exact:true});
      await editor.waitFor();
      if (surface.endsWith('shared')) {
        if (!mobile && surface.startsWith('core')) {
          const resize=page.getByRole('separator',{name:'Resize sidebar',exact:true});
          const width=Number(await resize.getAttribute('aria-valuenow'));
          assert.ok(width>=320&&width<=520,'Current sidebar width exposed');
          await resize.focus(); await page.keyboard.press('ArrowRight');
          await page.waitForFunction(old=>Number(document.querySelector('[role=separator][aria-label="Resize sidebar"]').getAttribute('aria-valuenow'))===Math.min(520,old+16),width);
        }
        await page.getByRole('button',{name:'Chat settings and actions',exact:true}).click();
        await page.getByRole('menuitem',{name:'Rename',exact:true}).click();
        const name=page.getByLabel('Chat name',{exact:true});
        await name.fill(`Renamed ${surface} ${mobile}`);
        await name.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});
        assert.ok(await name.isVisible(),'IME Enter does not save');
        await page.keyboard.press('Enter');
        await name.waitFor({state:'hidden'});
        if (mobile && surface.startsWith('branches')) {
          await page.getByRole('tab',{name:'Workflow',exact:true}).click();
          const disabled=page.getByRole('tab',{name:'Executions',exact:true});
          assert.equal(await disabled.isDisabled(),true);
          assert.equal(await disabled.evaluate(el=>el.parentElement.getAttribute('role')),'tablist');
        }
        if (process.env.AXE_CORE_PATH) {
          await page.addScriptTag({path:process.env.AXE_CORE_PATH});
          for (const theme of ['light','dark']) {
            await page.evaluate(theme=>{localStorage.setItem('ponderosa-color-mode',theme);location.reload();},theme);
            await page.waitForLoadState('domcontentloaded');
            await page.getByRole('tab').first().waitFor();
            await page.addScriptTag({path:process.env.AXE_CORE_PATH});
            const scan=await page.evaluate(async()=>await window.axe.run());
            scans.push({surface,mobile,theme,...scan});
            assert.equal(scan.violations.filter(v=>v.impact==='critical').length,0,'No critical axe violations on selected surface');
          }
        }
        if (mobile && surface.startsWith('branches')) await page.getByRole('tab',{name:'Chats',exact:true}).click();
      }
      if (surface.endsWith('direct')) {
        await page.getByRole('tab',{name:'Agents',exact:true}).click();
        await page.getByText(surface.startsWith('core') ? coreAgent.title : state.agents[0].title,{exact:true}).filter({visible:true}).first().click();
        await editor.waitFor();
      }
      for (const ending of ['\n','\r\n']) {
        const marker=`clipboard-${surface}-${mobile}-${cases++}`;
        const text=[`${marker} λ😀`,'second line','','TAIL_KEEP_ME'].join(ending);
        await editor.click(); await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
        if(surface==='inbox'){const reply=page.getByRole('button',{name:/^Reply to /}).filter({visible:true}).first();await reply.focus();await page.keyboard.press('Enter');await editor.click();}
        const before=sends.length;
        await page.evaluate(text=>navigator.clipboard.writeText(text),text);
        await page.keyboard.press('Control+V');
        await page.waitForTimeout(250);
        assert.equal(sends.length,before,'Paste never sends');
        assert.ok(normalize(await editor.innerText()).includes(normalize(text)),'Full draft retained');
        const paste=await page.evaluate(()=>window.pastes.at(-1));
        assert.deepEqual(paste,{trusted:true,text},'Actual OS clipboard paste');
        await page.keyboard.press('Shift+Enter'); await page.keyboard.type('SHIFT_TAIL');
        assert.equal(sends.length,before,'Shift+Enter never sends');
        assert.ok((await editor.innerText()).includes('SHIFT_TAIL'));
        await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.getAttribute('aria-label')==='Send message'&&!button.disabled));
        if (ending === '\r\n') {
          await page.keyboard.press('Enter'); await page.waitForTimeout(250);
          assert.equal(sends.length,before+(mobile?0:1),'Desktop Enter sends; Android Return adds newline');
        }
        if (sends.length===before) await page.getByRole('button',{name:'Send message',exact:true}).click();
        await page.waitForTimeout(700);
        assert.equal(sends.length,before+1,'One explicit send');
        assert.ok(normalize(sends.at(-1)).includes(normalize(text)));
        const journals=[];
        for (const dir of await readdir(path.join(manifest.root,'data/projects'))) {
          const file=path.join(manifest.root,'data/projects',dir,'message-dispatches.jsonl');
          try { journals.push(...(await readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)); } catch(error) { if(error.code!=='ENOENT')throw error; }
        }
        const canonical=journals.filter(row=>row.role==='user'&&row.renderedText?.includes(marker));
        assert.equal(canonical.length,1,'One canonical stored message');
        assert.ok(normalize(canonical[0].renderedText).includes(normalize(text)),'Canonical tail retained');
        assert.ok(canonical[0].renderedText.includes('SHIFT_TAIL'));
        console.log(`PASS ${surface} ${mobile?'Android emulation':'desktop'} ${ending==='\n'?'LF':'CRLF'}`);
      }
    } finally { await context.close(); }
  }
  console.log(`PASS ${cases} real clipboard cases; physical iPhone and future Assistant remain separate qualification.`);
} finally {
  if (process.env.QUALIFICATION_REPORT) await writeFile(process.env.QUALIFICATION_REPORT,JSON.stringify(scans,null,2));
  await browser?.close();
  const exited=once(child,'exit'); child.kill('SIGTERM'); await exited;
}
