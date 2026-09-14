import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const { chromium } = createRequire(process.env.PLAYWRIGHT_PACKAGE || import.meta.url)('playwright');
const browser = await chromium.launch({headless:true, ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {})});
try {
  const page = await browser.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/slow.txt', async route => { await new Promise(resolve=>setTimeout(resolve,500)); await route.fulfill({body:'SLOW CONTENT',contentType:'text/plain'}).catch(()=>{}); });
  await page.route('**/fast.txt', route=>route.fulfill({body:'FAST CONTENT',contentType:'text/plain'}));
  await page.route('**/broken.png', route=>route.fulfill({status:404,body:''}));
  for (const width of [1200,375,320]) {
    await page.setViewportSize({width,height:800});
    await page.goto('http://127.0.0.1:21844');
    const opener=page.getByTestId('multiple').getByRole('button',{name:'Preview Second',exact:true});
    await opener.click();
    const dialog=page.getByRole('dialog');
    const counter = async value => { await dialog.getByText(`${value} of 7`,{exact:true}).waitFor(); };
    await counter(2);
    await dialog.getByRole('button',{name:'Previous attachment'}).click(); await counter(1);
    await page.keyboard.press('ArrowLeft'); await counter(7);
    await dialog.getByText('Artifact unavailable',{exact:true}).waitFor();
    await page.keyboard.press('ArrowRight'); await counter(1);
    await dialog.getByRole('button',{name:'Next attachment'}).click(); await counter(2);
    await page.keyboard.press('ArrowRight'); await counter(3);
    await page.keyboard.press('ArrowRight'); await counter(4);
    try { await dialog.getByText('FAST CONTENT',{exact:true}).waitFor({timeout:5000}); }
    catch (error) { console.log(await dialog.innerText()); throw error; }
    await page.waitForTimeout(600);
    assert.equal(await dialog.getByText('SLOW CONTENT',{exact:true}).count(),0);
    await page.keyboard.press('Shift+ArrowLeft'); await counter(4);
    await page.keyboard.press('ArrowRight'); await counter(5);
    await dialog.getByText('Preview unavailable for this file type.').waitFor();
    assert.equal(await dialog.getByRole('link',{name:'Download file',exact:true}).getAttribute('href'),'/archive.zip');
    await page.keyboard.press('ArrowRight'); await counter(6);
    await dialog.getByText('Artifact unavailable',{exact:true}).waitFor();
    assert.equal(await dialog.getByRole('link').count(),0);
    const bounds=await dialog.boundingBox(); assert(bounds.x>=0 && bounds.x+bounds.width<=width);
    await page.screenshot({path:`/tmp/attachment-preview-${width}.png`});
    await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
    assert(await opener.evaluate(el=>el===document.activeElement));
    await page.getByTestId('single').getByRole('button',{name:'Preview Only'}).click();
    assert.equal(await dialog.getByRole('button',{name:'Next attachment'}).count(),0);
    await page.keyboard.press('ArrowRight');
    assert.equal(await dialog.locator('img').getAttribute('alt'),'Only');
    await dialog.getByRole('button',{name:'Close attachment preview'}).click();
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: attachment navigation, wrapping, mixed/failed files, async text fencing, single attachment, mobile, keyboard and focus.');
} finally { await browser.close(); }
