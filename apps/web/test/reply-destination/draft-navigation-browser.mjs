import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {chromium} = createRequire(process.env.PLAYWRIGHT_PACKAGE || import.meta.url)('playwright');
const browser = await chromium.launch({headless:true, ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {})});
try {
  for (const scenario of ['navigate-return', 'sent-not-restored', 'competing-revision', 'delayed-empty-save']) {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let draft = {conversationId:'diagnostic-chat', ownerId:'', text:'Persisted first line\nPersisted second line', attachmentIds:[], mentionBindings:[], revision:4, clientId:'earlier-visit', updatedAt:new Date().toISOString()};
    let conflict;
    let acceptEmpty, releaseEmpty;
    const emptyAccepted = new Promise(resolve => { acceptEmpty = resolve; });
    const emptyResponse = new Promise(resolve => { releaseEmpty = resolve; });
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.endsWith('/draft')) {
        if (request.method() === 'PUT') {
          const body = request.postDataJSON();
          if (body.expectedRevision !== draft.revision) {
            conflict = {id:'conflict-1', displaced:{...body}, current:{...draft}, createdAt:new Date().toISOString()};
            return route.fulfill({status:409,json:{error:'draft revision conflict'}});
          }
          draft = {...draft, ...body, revision:draft.revision+1};
          if (scenario === 'delayed-empty-save' && body.text === '' && draft.revision === 5) {
            acceptEmpty();
            await emptyResponse;
            // Reload aborts this request before the old Composer acknowledges it.
            return route.fulfill({json:draft}).catch(() => undefined);
          }
        }
        return route.fulfill({json:{...draft, ownerId:draft.ownerId || url.searchParams.get('ownerId')}});
      }
      if (url.pathname.endsWith('/draft-conflicts')) return route.fulfill({json:{conflicts:conflict ? [conflict] : []}});
      return route.fulfill({json:{}});
    });
    await page.goto('http://127.0.0.1:21845/?durable=1&navigation=1');
    const input = page.locator('.composer-editor-input');
    await input.waitFor();
    await page.waitForFunction(() => document.querySelector('.composer-editor-input')?.textContent.includes('Persisted second line'));
    if (scenario === 'delayed-empty-save') {
      await input.fill('');
      await Promise.race([emptyAccepted, new Promise((_, reject) => setTimeout(() => reject(new Error('empty PUT did not start')), 5_000))]);
      assert.equal(draft.revision,5);
      assert.equal(draft.text,'');
      await input.fill('New work typed after clearing');
      await page.reload();
      await input.waitFor();
      await page.waitForFunction(() => document.querySelector('.composer-editor-input')?.textContent.includes('New work typed after clearing'), null, {timeout:5_000});
      await page.getByText('This draft changed elsewhere. Your version is preserved.',{exact:false}).waitFor();
      assert.equal(draft.text,'','ambiguous recovery must not overwrite the accepted empty draft');
      assert.equal(conflict.displaced.expectedRevision,4);
      assert.equal(conflict.displaced.text,'New work typed after clearing');
      releaseEmpty();
      assert.deepEqual(errors,[]);
      console.log('PASS',scenario); await page.close(); continue;
    }
    const updated = 'Persisted first line\nPersisted second line\nLatest edit before immediate navigation';
    await input.fill(updated);
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    assert.equal(draft.revision,4,'navigation must precede debounce');
    if (scenario === 'competing-revision') draft = {...draft,text:'Another browser edit',revision:5,clientId:'another-browser'};
    await page.getByRole('button',{name:'Back to chat',exact:true}).click();
    await input.waitFor();
    await page.waitForFunction(() => document.querySelector('.composer-editor-input')?.textContent.includes('Latest edit before immediate navigation'));
    if (scenario === 'competing-revision') {
      await page.getByText('This draft changed elsewhere. Your version is preserved.',{exact:false}).waitFor();
      assert.equal(draft.text,'Another browser edit');
      assert.equal(conflict.displaced.expectedRevision,4);
      assert.equal(conflict.displaced.text,updated);
    } else {
      await page.waitForTimeout(750);
      assert.equal(draft.text,updated);
      if (scenario === 'sent-not-restored') {
        await input.focus(); await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('#sent')?.textContent.includes('Latest edit'));
        await page.waitForTimeout(300);
        assert.equal(draft.text,'');
        await page.getByRole('button',{name:'Settings',exact:true}).click();
        await page.getByRole('button',{name:'Back to chat',exact:true}).click();
        await input.waitFor(); await page.waitForTimeout(650);
        assert.ok(!(await input.innerText()).includes('Latest edit'));
        assert.equal(draft.text,'');
      }
    }
    assert.deepEqual(errors,[]);
    console.log('PASS',scenario); await page.close();
  }
} finally { await browser.close(); }
