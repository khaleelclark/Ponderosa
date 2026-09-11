import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {chromium}=createRequire(process.env.PLAYWRIGHT_PACKAGE||import.meta.url)('playwright');
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
try{
 const page=await browser.newPage();
 page.on('pageerror',error=>console.log(error.message));
 await page.route('**/api/**',route=>route.fulfill({json:{}}));
 await page.goto('http://127.0.0.1:21844');
 const input=page.locator('.composer-editor-input');
 await input.waitFor(); await page.waitForTimeout(500);
 console.log('initial',await input.innerText());
 await input.focus(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace');
 await page.waitForTimeout(200);
 console.log('cleared',await input.innerText());
 await page.getByRole('button',{name:'Mention Boston',exact:true}).click();
 await page.waitForTimeout(500);
 console.log('clicked',await input.innerText());
 assert((await input.innerText()).includes('#Boston'));
 for(let i=0;i<3;i++) await page.getByRole('button',{name:'Mention Boston',exact:true}).click();
 await page.waitForTimeout(200);
 assert.equal((await input.innerText()).match(/#Boston/g)?.length,1);
 await page.keyboard.type('hello world');
 await page.getByRole('button',{name:'Mention Arches',exact:true}).click();
 await page.waitForTimeout(200);
 assert((await input.innerText()).includes('hello world'));
 assert((await input.innerText()).includes('#Arches'));
 for(let i=0;i<3;i++){
  await input.focus(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace');
  await page.getByRole('button',{name:'Mention Boston',exact:true}).click();
  await page.waitForTimeout(150);
  assert((await input.innerText()).includes('#Boston'));
 }
 console.log('PASS: clear/reinsert, repeated clicks, multiple mentions and preserved typed text.');
}finally{await browser.close();}
