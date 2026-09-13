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
  assert.equal(padding,width===390?'18px':'34px');
  console.log(`PASS width=${width}: bottom safe-area padding=${padding}`);
  await page.close();
 }
} finally {await browser.close();}
