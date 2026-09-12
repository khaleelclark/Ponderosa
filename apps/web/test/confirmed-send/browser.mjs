import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {chromium}=createRequire(process.env.PLAYWRIGHT_PACKAGE||import.meta.url)('playwright');
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
try {
  for(const mode of ['normal','cache-failure','transport-failure']) {
    const page=await browser.newPage();const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/**',route=>route.fulfill({json:{}}));
    await page.goto(`http://127.0.0.1:21846/?mode=${mode}`);
    const input=page.locator('.composer-editor-input');await input.waitFor();
    await page.waitForFunction(()=>document.querySelector('.composer-editor-input')?.textContent.includes('#Boston'));
    await input.click();await page.keyboard.press('End');await page.keyboard.type('unique reply');
    await page.keyboard.press('Enter');
    const expected=mode==='transport-failure'?'error':'success';
    await page.waitForFunction(status=>document.querySelector('#status')?.textContent===status,expected);
    if(mode==='transport-failure') {
      assert.equal(await page.locator('#accepted').innerText(),'');
      assert.ok((await input.innerText()).includes('unique reply'));
      assert.ok((await page.locator('body').innerText()).includes('Message not sent'));
    } else {
      await page.waitForFunction(()=>!document.querySelector('.composer-editor-input')?.textContent.includes('unique reply'));
      assert.ok((await page.locator('#accepted').innerText()).includes('unique reply'));
      assert.ok(!(await page.locator('body').innerText()).includes('Message not sent'));
    }
    assert.equal(await page.locator('#requests').innerText(),'1');
    assert.deepEqual(errors,[]);
    console.log('PASS',mode);await page.close();
  }
} finally {await browser.close();}
