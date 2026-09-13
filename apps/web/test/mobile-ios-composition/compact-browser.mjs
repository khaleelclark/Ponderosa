import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {chromium,devices}=createRequire(process.env.PLAYWRIGHT_PACKAGE)('playwright');
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
try {
 for(const [name,options] of [['iPhone',devices['iPhone 13']],['Android',devices['Pixel 7']],['desktop',{viewport:{width:1200,height:844}}]]) {
  const page=await browser.newPage(options);
  await page.addInitScript(()=>{window.SpeechRecognition=class {start(){queueMicrotask(()=>this.onstart?.());}stop(){queueMicrotask(()=>this.onend?.());}abort(){this.stop();}};});
  await page.route('**/api/**',r=>r.fulfill({json:{acceptedMediaTypes:['text/plain'],maxAssetsPerMessage:20,maxFileBytes:8388608,maxMessageBytes:167772160}}));
  await page.goto('http://127.0.0.1:21848/?mention');
  const composer=page.locator('.ponderosa-composer');
  const input=page.locator('.composer-editor-input');
  await input.waitFor();
  await page.locator('#dismiss').focus();
  await page.waitForTimeout(100);
  assert.equal(await composer.getAttribute('data-compact'),name==='desktop'?'false':'true');
  if(name!=='desktop') assert.ok((await composer.boundingBox()).height<75,'Compact is one touch-sized row');
  if(name==='desktop') await input.click(); else await input.tap();
  await page.waitForTimeout(100);
  assert.equal(await composer.getAttribute('data-compact'),'false','Focus expands');
  await page.keyboard.press('End');
  await page.keyboard.insertText('draft first\nsecond');
  const before=await input.textContent();
  for(let i=0;i<3;i++) {
   await page.locator('#dismiss').focus();await page.waitForTimeout(75);
   assert.equal(await input.textContent(),before,'Collapse retains draft and mention');
   await input.click();await page.waitForTimeout(75);
  }
  await page.locator('#dismiss').focus();await page.waitForTimeout(75);
  await page.getByRole('button',{name:'Start voice dictation',exact:true}).click();
  await page.getByRole('button',{name:'Pause voice dictation',exact:true}).waitFor();
  await page.locator('#dismiss').focus();await page.waitForTimeout(75);
  assert.equal(await composer.getAttribute('data-compact'),'false','Dictation remains expanded outside focus');
  await page.getByRole('button',{name:'Stop voice dictation',exact:true}).click();
  await page.locator('#dismiss').focus();await page.waitForTimeout(75);
  await page.getByRole('button',{name:'Add attachment or capability',exact:true}).click();
  assert.equal(await composer.getAttribute('data-compact'),'false','Open menu stays expanded');
  await page.locator('#dismiss').click();await page.waitForTimeout(75);
  assert.equal(await composer.getAttribute('data-compact'),name==='desktop'?'false':'true','Closing menu returns to reading mode');
  if(name==='iPhone') await page.screenshot({path:'/tmp/compact-composer.png'});
  if(name!=='desktop') {
   await page.locator('input[type="file"]').setInputFiles({name:'note.txt',mimeType:'text/plain',buffer:Buffer.from('disposable attachment')});
   await page.waitForTimeout(100);
   await page.locator('#dismiss').focus();await page.waitForTimeout(75);
   await page.getByRole('button',{name:'View draft attachments',exact:true}).click();
   await page.getByRole('button',{name:'Remove note.txt',exact:true}).waitFor();
   await page.locator('#dismiss').focus();await page.waitForTimeout(75);
   assert.equal(await page.getByRole('button',{name:'View draft attachments',exact:true}).textContent(),'+1','Collapsed attachment count preserved');
   await page.getByRole('button',{name:'View draft attachments',exact:true}).click();
   await page.getByRole('button',{name:'Remove note.txt',exact:true}).click();
   await page.locator('#dismiss').focus();await page.waitForTimeout(75);
  }
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await page.waitForTimeout(100);
  assert.equal(JSON.parse(await page.locator('#sent').textContent()).length,1,'Compact Send submits once');
  console.log(`PASS ${name}: compact/focus/draft/mention/dictation/menu`);
  await page.close();
 }
 for(const mode of ['cancel','queue']) {
  const page=await browser.newPage(devices['iPhone 13']);
  await page.route('**/api/**',r=>r.fulfill({json:{}}));
  await page.goto(`http://127.0.0.1:21848/?run=${mode}`);
  const input=page.locator('.composer-editor-input');
  await input.click();await page.keyboard.insertText('follow up');
  await page.locator('#dismiss').focus();await page.waitForTimeout(100);
  if(mode==='cancel') {
   assert.equal(await page.getByRole('button',{name:'Steer active response',exact:true}).count(),0);
   await page.getByRole('button',{name:'Cancel run',exact:true}).click();
   assert.equal(await input.textContent(),'follow up','Stop preserves draft');
  } else {
   await page.getByRole('button',{name:'Choose send action',exact:true}).click();
   assert.deepEqual(JSON.parse(await page.locator('#sent').textContent()),[],'Expanding must not choose Steer or Queue');
   await page.getByRole('button',{name:'Queue message',exact:true}).click();
   await page.waitForTimeout(100);
   assert.deepEqual(JSON.parse(await page.locator('#sent').textContent()),['queued:follow up']);
  }
  console.log(`PASS ${mode}: existing action semantics retained`);
  await page.close();
 }
} finally {await browser.close();}
