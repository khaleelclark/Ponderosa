import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {chromium,devices}=createRequire(process.env.PLAYWRIGHT_PACKAGE)('playwright');
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
try {
 for(const [name,options] of [['iPhone',devices['iPhone 13']],['Android',devices['Pixel 7']],['desktop',{viewport:{width:1200,height:844}}]]) {
  const context=await browser.newContext(options);
  const page=await context.newPage();
  await page.addInitScript(()=>{window.SpeechRecognition=class {start(){queueMicrotask(()=>this.onstart?.());}stop(){queueMicrotask(()=>this.onend?.());}abort(){this.stop();}};});
  await page.route('**/api/**',r=>r.fulfill({json:{acceptedMediaTypes:['text/plain'],maxAssetsPerMessage:20,maxFileBytes:8388608,maxMessageBytes:167772160}}));
  await page.goto('http://127.0.0.1:21848/?mention');
  const composer=page.locator('.ponderosa-composer');
  const input=page.locator('.composer-editor-input');
  await input.waitFor();
  if(name!=='desktop') {
   assert.equal(await page.getByRole('button',{name:'Composer options',exact:true}).count(),0,'Mobile has no separate composer-options panel');
   assert.equal(await page.getByRole('button',{name:/new Agent/i}).count(),1,'New Agent stays inline');
   assert.equal(await page.getByRole('button',{name:'Choose engine, model, reasoning, and speed',exact:true}).count(),1,'Runtime selector stays inline');
  }
  await page.locator('#dismiss').focus();
  await page.waitForTimeout(100);
  assert.equal(await composer.getAttribute('data-compact'),'false','Composer never collapses');
  const unfocusedHeight=(await composer.boundingBox()).height;
  if(name!=='desktop') assert.ok(unfocusedHeight>=90,'Mobile keeps its two-row composer while unfocused');
  if(name==='desktop') await input.click(); else await input.tap();
  await page.waitForTimeout(100);
  assert.equal(await composer.getAttribute('data-compact'),'false','Focus does not change the layout mode');
  assert.equal((await composer.boundingBox()).height,unfocusedHeight,'Empty composer height is stable across focus');
  await page.keyboard.press('End');
  await page.keyboard.insertText('draft first\nsecond');
  const before=await input.textContent();
  const draftHeight=(await composer.boundingBox()).height;
  for(let i=0;i<3;i++) {
   await page.locator('#dismiss').focus();await page.waitForTimeout(75);
   assert.equal(await input.textContent(),before,'Blur retains draft and mention');
   assert.equal(await composer.getAttribute('data-compact'),'false','Blur does not collapse the composer');
   assert.equal((await composer.boundingBox()).height,draftHeight,'Draft height is stable across blur');
   await input.click();await page.waitForTimeout(75);
  }
  await page.locator('#dismiss').focus();await page.waitForTimeout(75);
  await page.getByRole('button',{name:'Start voice dictation',exact:true}).click();
  await page.getByRole('button',{name:'Pause voice dictation',exact:true}).waitFor();
  await page.locator('#dismiss').focus();await page.waitForTimeout(75);
  assert.equal(await composer.getAttribute('data-compact'),'false','Dictation retains the stable composer');
  await page.getByRole('button',{name:'Stop voice dictation',exact:true}).click();
  await page.locator('#dismiss').focus();await page.waitForTimeout(75);
  await page.getByRole('button',{name:'Add attachment or capability',exact:true}).click();
  assert.equal(await composer.getAttribute('data-compact'),'false','Open menu retains the stable composer');
  await page.locator('#dismiss').click();await page.waitForTimeout(75);
  assert.equal(await composer.getAttribute('data-compact'),'false','Closing menu does not collapse the composer');
  if(name==='iPhone') await page.screenshot({path:'/tmp/compact-composer.png'});
  if(name!=='desktop') {
   await page.locator('input[type="file"]').setInputFiles({name:'note.txt',mimeType:'text/plain',buffer:Buffer.from('disposable attachment')});
   await page.waitForTimeout(100);
   await page.locator('#dismiss').focus();await page.waitForTimeout(75);
   await page.getByRole('button',{name:'Remove note.txt',exact:true}).waitFor();
   assert.equal(await composer.getAttribute('data-compact'),'false','Attachments remain visible while unfocused');
   await page.getByRole('button',{name:'Remove note.txt',exact:true}).click();
   await page.locator('#dismiss').focus();await page.waitForTimeout(75);
  }
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await page.waitForTimeout(100);
  assert.equal(JSON.parse(await page.locator('#sent').textContent()).length,1,'Stable composer Send submits once');
  console.log(`PASS ${name}: stable focus/blur/draft/mention/dictation/menu`);
  await context.close();
 }
 for(const mode of ['cancel','queue']) {
  const context=await browser.newContext(devices['iPhone 13']);
  const page=await context.newPage();
  await page.route('**/api/**',r=>r.fulfill({json:{}}));
  await page.goto(`http://127.0.0.1:21848/?run=${mode}`);
  const input=page.locator('.composer-editor-input');
  await input.click();await page.keyboard.insertText('follow up');
  await page.locator('#dismiss').focus();await page.waitForTimeout(100);
  assert.equal(await page.getByRole('button',{name:'Composer options',exact:true}).count(),0,'Run controls remain inline');
  if(mode==='cancel') {
   await page.getByRole('button',{name:'Cancel run',exact:true}).click();
   assert.equal(await input.textContent(),'follow up','Stop preserves draft');
  } else {
   await page.getByRole('button',{name:'Queue message',exact:true}).click();
   await page.waitForTimeout(100);
   assert.deepEqual(JSON.parse(await page.locator('#sent').textContent()),['queued:follow up']);
  }
  console.log(`PASS ${mode}: inline action semantics retained`);
  await context.close();
 }
} finally {await browser.close();}
