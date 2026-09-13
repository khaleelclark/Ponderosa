import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {chromium}=createRequire(process.env.PLAYWRIGHT_PACKAGE)('playwright');
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
try {
 for(const width of [390,1200]) {
  const page=await browser.newPage({viewport:{width,height:844}});
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{bottom:34}});
  await page.route('**/api/**',r=>r.fulfill({json:{}}));
  await page.goto('http://127.0.0.1:21848/');
  await page.locator('[data-composer-toolbar]').waitFor();
  const padding=await page.locator('#composer > *').first().evaluate(el=>getComputedStyle(el).paddingBottom);
  assert.equal(padding,width===390?'6px':'34px');
  if(width===390) {
   const button=page.getByRole('button',{name:'Add attachment or capability',exact:true});
   const box=await button.boundingBox();
   assert.ok(box.width>=44&&box.height>=44,'Touch target remains at least 44px');
   await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{bottom:0}});
   assert.equal(await page.locator('#composer > *').first().evaluate(el=>getComputedStyle(el).paddingBottom),'6px','Inset also stays small with keyboard open');
  }
  console.log(`PASS width=${width}: bottom safe-area padding=${padding}`);
  await page.close();
 }
} finally {await browser.close();}
