import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {chromium}=createRequire(process.env.PLAYWRIGHT_PACKAGE||import.meta.url)('playwright');
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
try {
  for(const mobile of [false,true]) {
    const context=await browser.newContext({viewport:{width:mobile?375:1200,height:900},hasTouch:mobile,isMobile:mobile});
    const page=await context.newPage();
    const calls=[],errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/api/projects/**/agent-work/items/**',route=>{
      calls.push(route.request().url());
      return route.fulfill({json:{requestLifecycle:{request:{text:'Canonical request details'},updates:[]}}});
    });
    await page.goto('http://127.0.0.1:21844');
    const linked=page.getByTestId('linked');
    const action=linked.getByRole('button',{name:'View request',exact:true});
    await action.waitFor();
    for(const id of ['none','missing-project','blank-id']) assert.equal(await page.getByTestId(id).getByRole('button',{name:/View request/}).count(),0);
    assert.equal(calls.length,0,'no request details fetched before opening');
    assert.equal(await page.getByText('Do the requested work',{exact:false}).count(),0,'no inline request cards');
    const opacity=()=>action.evaluate(el=>getComputedStyle(el.closest('.chat-message-action-buttons')).opacity);
    if(!mobile) {
      assert.equal(await opacity(),'0');
      await linked.hover(); await page.waitForTimeout(180); assert.equal(await opacity(),'1');
      await page.mouse.move(1190,890); await action.focus(); await page.waitForTimeout(180); assert.equal(await opacity(),'1');
      await page.keyboard.press('Enter');
    } else { assert.equal(await opacity(),'1'); await action.tap(); }
    const dialog=page.getByRole('dialog');
    await dialog.getByText('Canonical request details',{exact:true}).waitFor();
    assert(calls[0].includes('/project-1/agent-work/items/request/request-1?conversationId=request-chat'));
    await page.waitForTimeout(300);
    await page.screenshot({path:`/tmp/message-request-action-${mobile?'mobile':'desktop'}.png`});
    await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
    assert(await action.evaluate(el=>document.activeElement===el));
    await page.getByTestId('multiple').hover();
    await page.getByTestId('multiple').getByRole('button',{name:'View requests',exact:true}).click();
    await dialog.getByText('Canonical request details',{exact:true}).nth(1).waitFor();
    await dialog.getByRole('button',{name:'Close request details'}).click();
    assert.deepEqual(errors,[]);
    await context.close();
  }
  console.log('PASS: conditional availability, no inline cards/eager detail fetches, hover/focus/touch, scoped request opening, multiple requests, Escape/Close, focus restoration.');
} finally {await browser.close();}
