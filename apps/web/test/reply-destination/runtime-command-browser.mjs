import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {chromium} = createRequire(process.env.PLAYWRIGHT_PACKAGE || import.meta.url)('playwright');
const browser = await chromium.launch({headless:true, ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {})});
try {
  for (const scenario of ['success', 'edit-pending', 'failure', 'other-visit']) {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let draft = {conversationId:'diagnostic-chat',ownerId:'',text:'',attachmentIds:[],mentionBindings:[],revision:4,clientId:'prior',updatedAt:new Date().toISOString()};
    let conflict;
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.endsWith('/draft')) {
        if (request.method() === 'PUT') {
          const body = request.postDataJSON();
          if (body.expectedRevision !== draft.revision) {
            conflict = {id:'conflict',displaced:{...body},current:{...draft},createdAt:new Date().toISOString()};
            return route.fulfill({status:409,json:{error:'draft revision conflict'}});
          }
          draft = {...draft,...body,revision:draft.revision+1};
        }
        return route.fulfill({json:{...draft,ownerId:draft.ownerId || url.searchParams.get('ownerId')}});
      }
      if (url.pathname.endsWith('/draft-conflicts')) return route.fulfill({json:{conflicts:conflict ? [conflict] : []}});
      return route.fulfill({json:{}});
    });
    await page.goto('http://127.0.0.1:21845/?durable=1&navigation=1&commands=1');
    const input = page.locator('.composer-editor-input');
    await input.waitFor(); await page.waitForTimeout(200);
    await input.fill('/status'); await page.getByRole('button',{name:'Send message',exact:true}).click();
    await page.waitForFunction(() => document.querySelector('#command-result')?.textContent === 'started:status', null, {timeout:3_000}).catch(async error => { console.log('Command start diagnostic:', await page.locator('body').innerText()); throw error; });
    assert.equal(await page.locator('#sent').innerText(),'','must use the real onCommand branch');
    assert.equal(draft.revision,4,'command must start before autosave');
    if (scenario === 'edit-pending') await input.fill('New work while status is pending');
    if (scenario === 'other-visit') {
      await page.getByRole('button',{name:'Settings',exact:true}).click();
      await page.getByRole('button',{name:'Back to chat',exact:true}).click();
      await input.waitFor(); await page.waitForTimeout(100);
      await input.fill('New work in another visit');
    }
    await page.getByRole('button',{name:scenario === 'failure' ? 'Fail command' : 'Finish command',exact:true}).click();
    await page.waitForFunction(expected => document.querySelector('#command-result')?.textContent === expected, scenario === 'failure' ? 'failed:status' : 'completed:status');
    await page.waitForTimeout(100);
    const expected = scenario === 'success' ? '' : scenario === 'failure' ? '/status' : scenario === 'edit-pending' ? 'New work while status is pending' : 'New work in another visit';
    assert.equal((await input.innerText()).trim(),expected);
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByRole('button',{name:'Back to chat',exact:true}).click();
    await input.waitFor(); await page.waitForTimeout(200);
    assert.equal((await input.innerText()).trim(),expected,'navigation preserves only unfinished work');
    await page.reload(); await input.waitFor(); await page.waitForTimeout(200);
    assert.equal((await input.innerText()).trim(),expected,'reload preserves only unfinished work');
    if (scenario === 'failure') {
      await page.getByRole('button',{name:'Send message',exact:true}).click();
      await page.waitForFunction(() => document.querySelector('#command-result')?.textContent === 'started:status');
      await page.getByRole('button',{name:'Finish command',exact:true}).click();
      await page.waitForTimeout(100);
      assert.equal((await input.innerText()).trim(),'','retry success clears the failed command');
    }
    assert.deepEqual(errors,[]); console.log('PASS runtime-command',scenario); await page.close();
  }
} finally { await browser.close(); }
