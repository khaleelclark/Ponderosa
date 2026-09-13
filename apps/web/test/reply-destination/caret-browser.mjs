import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {chromium,webkit}=createRequire(process.env.PLAYWRIGHT_PACKAGE)('playwright');
const browser=await (process.env.WEBKIT_PATH?webkit:chromium).launch({headless:true,executablePath:process.env.WEBKIT_PATH||process.env.CHROMIUM_PATH});
try {
 for(const scenario of ['autofill-focused','autofill-blurred','manual-reply','click-reply-start']) {
  const page=await browser.newPage();
  await page.route('**/api/**',r=>r.fulfill({json:{}}));
  await page.goto('http://127.0.0.1:21845/');
  const input=page.locator('.composer-editor-input');await input.waitFor();await page.waitForTimeout(200);
  await input.focus();await page.keyboard.press('End');await page.keyboard.type('first');
  await page.keyboard.press('Enter');await page.waitForTimeout(150);
  if(scenario==='autofill-focused') {
   // Deliver a background reply while the empty editor still has focus.
   await page.getByRole('button',{name:'Arches reply',exact:true}).evaluate(el=>el.click());
  } else await page.getByRole('button',{name:scenario==='manual-reply'?'Mention Boston':'Arches reply',exact:true}).click();
  await page.waitForTimeout(200);
  if(scenario==='autofill-blurred') await input.focus();
  if(scenario==='click-reply-start') await input.click({position:{x:2,y:10}});
  await page.keyboard.type('second');await page.waitForTimeout(100);
  const text=await input.innerText();
  assert.match(text,/^#(?:Arches|Boston).*second/s,'Reply text must follow its chip without manually moving the caret');
  await input.click({position:{x:2,y:10}});await page.keyboard.type('prefix ');
  assert.match(await input.innerText(),/^prefix /,'Existing message text keeps normal caret placement');
  const selected=await input.evaluate(el=>{
   const range=document.createRange();range.selectNodeContents(el);
   const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
   const before=selection.toString();el.dispatchEvent(new MouseEvent('click',{bubbles:true}));return before;
  });
  assert.equal(await page.evaluate(()=>window.getSelection().toString()),selected,'Noncollapsed selection is preserved');
  console.log(`PASS ${process.env.WEBKIT_PATH?'webkit':'chromium'} ${scenario}: reply caret and normal draft editing`);
  await page.close();
 }
} finally {await browser.close();}
