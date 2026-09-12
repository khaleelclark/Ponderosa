import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {chromium}=createRequire(process.env.PLAYWRIGHT_PACKAGE||import.meta.url)('playwright');
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
try {
 const page=await browser.newPage();
 await page.route('**/api/**',route=>route.fulfill({json:{}}));
 await page.goto('http://127.0.0.1:21847/');
 await page.locator('#code code').waitFor();
 await page.waitForTimeout(300);
 await page.evaluate(()=>{
  window.sizes=[];window.removals=0;
  new MutationObserver(records=>{
   window.removals+=records.reduce((n,r)=>n+r.removedNodes.length,0);
   window.sizes.push({height:document.querySelector('#code').getBoundingClientRect().height,plain:!!document.querySelector('#code pre')});
  }).observe(document.querySelector('#code'),{childList:true,subtree:true});
 });
 for(let i=0;i<4;i++){await page.getByRole('button',{name:'Rerender',exact:true}).click();await page.waitForTimeout(400);}
 const code=await page.evaluate(()=>({sizes:window.sizes,removedNodes:window.removals}));
 assert.equal(code.removedNodes,0,'Unchanged code must not remount on parent updates');
 assert.equal(code.sizes.length,0,'No fallback/highlight churn after initial loading');
 console.log('PASS stable code blocks',code);
 const input=page.locator('.composer-editor-input');
 await input.click();await page.keyboard.press('End');await page.keyboard.type('draft');
 await page.getByRole('button',{name:'Roster pending',exact:true}).click();
 assert.equal(await page.locator('[data-composer-mention]').getAttribute('aria-label'),'Agent mention Boston');
 await input.focus();await page.keyboard.press('Enter');await page.waitForTimeout(200);
 assert.equal(await page.locator('#sent').innerText(),'0','Loading roster must block sends');
 await page.getByRole('button',{name:'Roster ready',exact:true}).click();
 assert.equal(await page.locator('[data-composer-mention]').getAttribute('aria-label'),'Agent mention Boston');
 console.log('PASS roster loading preserves display and blocks send');
 await page.getByRole('button',{name:'New reply',exact:true}).click();
 await input.focus();await page.keyboard.press('Enter');await page.waitForTimeout(600);
 assert.equal(await page.locator('#sent').innerText(),'1');
 assert.ok((await input.innerText()).includes('#Boston'),'Deferred reply must autofill after sending');
 assert.ok(!(await input.innerText()).includes('draft'));
 console.log('PASS deferred reply autofill');
 await input.focus();await page.keyboard.press('End');await page.keyboard.type('another draft');
 await page.getByRole('button',{name:'Remove Agent',exact:true}).click();
 await page.waitForTimeout(100);
 assert.equal(await page.locator('[data-composer-mention]').getAttribute('aria-label'),'Unavailable Agent mention Boston');
 await input.focus();await page.keyboard.press('Enter');await page.waitForTimeout(100);
 assert.equal(await page.locator('#sent').innerText(),'1');
 console.log('PASS confirmed unavailable recipient blocks send');
}finally{await browser.close();}
