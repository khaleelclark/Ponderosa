import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { serveFixture } from '../shared/serve-ui-fixture.mjs';

const { chromium } = createRequire(new URL('../../apps/server/package.json', import.meta.url))('playwright-core');
const { fixture } = await import('../shared/fixture.mjs');
const f = await fixture();
let web, browser;
const failures = [];
const post = async (url, body) => f.ok(await f.api('POST', url, body));
const chatPath = chat => `/projects/${chat.projectId}/chats/${chat.id}`;
const button = (page, name) => page.getByRole('button', { name, exact: true });
const style = locator => locator.evaluate(element => {
  const css = getComputedStyle(element);
  return { focused: document.activeElement === element, ring: css.outlineStyle !== 'none' && parseFloat(css.outlineWidth) > 0 };
});

async function check(label, viewport, touch, run) {
  const context = await browser.newContext({ viewport, isMobile: touch, hasTouch: touch, serviceWorkers: 'block' });
  try {
    await context.route('**/*', route => new URL(route.request().url()).origin === web.origin ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    await run(page);
    console.log('PASS', label);
  } catch (error) {
    failures.push(error);
    console.error('FAIL', label, error);
  } finally {
    await context.close();
  }
}

async function keyboardFocus(page, target) {
  await page.keyboard.press('Tab');
  await target.focus();
  assert.deepEqual(await style(target), { focused: true, ring: true });
}

try {
  const chat = await f.createChat('Tooltip first chat');
  await f.createIdleAgent(chat, 'Tooltip agent');
  await f.createChat('Tooltip second chat');
  const branch = await post('/api/branches', { name: 'Tooltip first workflow', idempotencyKey: randomUUID() });
  await post('/api/branches', { name: 'Tooltip second workflow', idempotencyKey: randomUUID() });
  await post('/api/branches/deploy', {
    branchId: branch.id, chatId: branch.chatId, expectedVersionId: branch.versionId, idempotencyKey: randomUUID(),
    definition: {
      schema: 'ponderosa.branch.v1', name: branch.name, trigger: { kind: 'manual' }, entry: 'script',
      steps: [{ id: 'script', kind: 'script', label: 'Inspect this step', runtime: 'node', source: 'process.stdout.write("fixture")', cwdRef: 'workspace', timeoutMs: 1000 }],
      controls: [], edges: [], policy: { maxConcurrentExecutions: 1, failure: { action: 'stop' } },
    },
    bindings: { agents: {}, directories: { workspace: f.root } },
  });
  const workflowPath = '/branches?branch=' + branch.id + '&tab=workflow';
  const desktop = { width: 1440, height: 900 };
  web = await serveFixture(f);
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });

  for (const product of ['Chat', 'Workflow']) {
    const workflow = product === 'Workflow';
    await check(product + ' sidebar tooltip ownership and dismissal', desktop, false, async page => {
      await page.goto(web.origin + (workflow ? workflowPath : chatPath(chat)));
      const row = index => page.getByRole('link', { name: `Open ${product} Tooltip ${index} ${product.toLowerCase()}`, exact: true });
      const first = row('first'), second = row('second');
      const status = first.locator('..').locator('[data-sidebar-column=activity]');
      const tooltip = page.getByRole('tooltip');
      const outside = workflow ? page.getByRole('heading', { name: 'Tooltip first workflow', exact: true }).first() : page.getByRole('textbox', { name: 'Message', exact: true });
      await outside.waitFor();
      await keyboardFocus(page, first);
      await tooltip.filter({ hasText: 'Tooltip first' }).waitFor();
      await page.keyboard.press('Tab');
      assert.equal(await status.evaluate(element => document.activeElement === element), true);
      await tooltip.filter({ hasText: workflow ? 'Workflow Runs' : /Agent status|confirmed/ }).waitFor();
      assert.equal(await tooltip.count(), 1, JSON.stringify(await tooltip.allTextContents()));
      await status.hover();
      await outside.hover();
      assert.equal(await tooltip.count(), 1, 'Keyboard focus keeps the status help after hover leaves');
      await second.hover();
      await tooltip.filter({ hasText: 'Tooltip second' }).waitFor();
      assert.equal(await tooltip.count(), 1, 'Hovering a different row replaces the still-focused status tooltip');
      assert.equal(await status.evaluate(element => document.activeElement === element), true);
      await page.keyboard.press('Escape');
      await tooltip.waitFor({ state: 'hidden' });
      assert.equal(await status.evaluate(element => document.activeElement === element), true, 'Escape leaves focus in place');

      // Dispatch events together so dismissal occurs inside the opening delay.
      await first.evaluate(element => {
        element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
        element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
      });
      await page.waitForTimeout(180);
      assert.equal(await tooltip.count(), 0, 'Escape cancels a pending tooltip before it opens');
      await first.dispatchEvent('pointerout', { pointerType: 'mouse' });
      await first.dispatchEvent('pointerover', { pointerType: 'mouse' });
      await second.dispatchEvent('pointerover', { pointerType: 'mouse' });
      await tooltip.filter({ hasText: 'Tooltip second' }).waitFor();
      assert.equal(await tooltip.count(), 1, 'An older pending open cannot overtake the current trigger');
      await outside.click();
      await tooltip.waitFor({ state: 'hidden' });
      if (!workflow) {
        assert.equal(await outside.evaluate(element => element === document.activeElement), true);
        await outside.fill('Preserve selected composer text');
        await outside.press('Home');
        await outside.press('Shift+End');
        assert.equal(await outside.evaluate(() => window.getSelection()?.toString()), 'Preserve selected composer text');
      }

      await first.hover();
      await tooltip.filter({ hasText: 'Tooltip first' }).waitFor();
      // Exercise trigger removal independently of the outside-pointer listener.
      await button(page, 'Collapse Sidebar').evaluate(element => element.click());
      await first.waitFor({ state: 'hidden' });
      await tooltip.waitFor({ state: 'hidden' });
    });
  }

  await check('desktop checkbox focus and checked styling', desktop, false, async page => {
    await page.goto(web.origin + workflowPath.replace('tab=workflow', 'tab=executions'));
    await page.getByRole('button', { name: /^Filter runs/ }).click();
    const checkbox = page.getByRole('dialog', { name: 'Filter runs' }).getByRole('checkbox').first();
    const wrapper = checkbox.locator('xpath=..');
    await page.keyboard.press('Tab');
    await checkbox.focus();
    assert.equal((await style(wrapper)).ring, true, 'A keyboard-focused input can ring its shared button wrapper');
    const checked = await checkbox.isChecked();
    await checkbox.click();
    assert.equal(await checkbox.evaluate(element => document.activeElement === element), true);
    assert.equal((await style(wrapper)).ring, false);
    assert.equal(await checkbox.isChecked(), !checked);
    assert.equal(await wrapper.evaluate(element => element.classList.contains('Mui-checked')), !checked);
    await page.keyboard.press('Escape');
  });

  await check('desktop Outline, header and Canvas focus', desktop, false, async page => {
    await page.goto(web.origin + workflowPath);
    const outline = button(page, 'Outline'), canvas = button(page, 'Canvas');
    await keyboardFocus(page, outline);
    await outline.click();
    assert.deepEqual(await style(outline), { focused: true, ring: false });
    await page.getByRole('region', { name: 'Workflow Outline' }).waitFor();
    assert.equal(await outline.getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Tab');
    assert.equal(await style(page.locator(':focus')).then(value => value.ring), true);
    await canvas.click();

    const node = page.locator('.react-flow__node[data-id=script]');
    const card = node.getByText('Inspect this step', { exact: true });
    const stepInspector = page.getByRole('region', { name: 'Workflow inspector' });
    await card.waitFor();
    const visual = () => card.evaluate(element => {
      const card = element.closest('.react-flow__node').firstElementChild;
      const css = getComputedStyle(card);
      return { border: css.borderTopWidth, color: css.borderTopColor, shadow: css.boxShadow };
    });
    const unselected = await visual();
    await card.click();
    await stepInspector.getByRole('textbox', { name: 'Name', exact: true }).waitFor();
    const selected = await visual();
    assert.notEqual(selected.color, unselected.color);
    assert.equal(selected.border, unselected.border);
    assert.equal(selected.shadow, unselected.shadow, 'Selection changes the border without adding another ring');
    assert.equal((await style(node)).ring, false);
    await keyboardFocus(page, node);
    assert.deepEqual(await visual(), selected);
    await node.press('Enter');
    await stepInspector.getByRole('textbox', { name: 'Name', exact: true }).waitFor();

    // Header toggle replaces the focused element in the DOM.
    const collapse = button(page, 'Collapse Workspace Header'), expand = button(page, 'Expand Workspace Header');
    await collapse.click();
    await keyboardFocus(page, expand);
    await expand.click();
    assert.deepEqual(await style(collapse), { focused: true, ring: false });
    await keyboardFocus(page, collapse);
    await collapse.press('Enter');
    assert.deepEqual(await style(expand), { focused: true, ring: true });
    await expand.click();

    const advanced = stepInspector.getByRole('button', { name: 'Advanced', exact: true });
    if (await advanced.getAttribute('aria-expanded') !== 'true') await advanced.click();
    await stepInspector.getByRole('spinbutton', { name: 'Timeout (Seconds)', exact: true }).fill('0');
    await button(page, 'Review changes').click();
    await node.getByText('Needs Attention', { exact: true }).waitFor();
    assert.notEqual((await visual()).color, selected.color, 'Validation retains a different border color');
    await keyboardFocus(page, node);
    assert.equal((await visual()).border, '1px');
  });

  for (const width of [390, 320]) for (const product of ['Chats', 'Workflows']) {
    await check(`${width}px emulated touch ${product} drawer focus`, { width, height: width === 390 ? 844 : 640 }, true, async page => {
      await page.goto(web.origin + (product === 'Chats' ? chatPath(chat) : workflowPath));
      const opener = button(page, 'Open Workspace Navigation');
      const close = button(page, 'Close Workspace Navigation');
      const drawer = page.locator('.MuiDrawer-paper').filter({ has: close });
      const returned = async ring => {
        await close.waitFor({ state: 'hidden' });
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Open Workspace Navigation');
        assert.deepEqual(await style(opener), { focused: true, ring });
      };
      // Exercise touch activation when mousedown does not focus the opener.
      await opener.evaluate(element => element.addEventListener('mousedown', event => event.preventDefault(), { once: true }));
      await opener.tap();
      await close.waitFor();
      assert.equal((await style(drawer)).ring, false);
      await close.tap();
      await returned(false);

      await opener.tap();
      await close.waitFor();
      const rowName = product === 'Chats' ? 'Open Chat Tooltip first chat' : 'Open Workflow Tooltip first workflow';
      const status = drawer.getByRole('link', { name: rowName, exact: true }).locator('..').locator('[data-sidebar-column=activity]');
      await status.scrollIntoViewIfNeeded();
      const { x, y, width: badgeWidth, height: badgeHeight } = await status.boundingBox();
      const touch = await page.context().newCDPSession(page);
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x + badgeWidth / 2, y: y + badgeHeight / 2 }] });
      const tooltip = page.getByRole('tooltip');
      await tooltip.waitFor();
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.touchscreen.tap(width - 3, 200);
      await tooltip.waitFor({ state: 'hidden' });
      await returned(false);

      await keyboardFocus(page, opener);
      await opener.press('Enter');
      await close.waitFor();
      for (const key of ['Tab', 'Shift+Tab']) {
        await page.keyboard.press(key);
        assert.equal(await drawer.evaluate(element => element.contains(document.activeElement)), true, 'Open drawer traps keyboard focus');
      }
      await page.keyboard.press('Escape');
      await returned(true);
    });
  }
} finally {
  await browser?.close();
  await web?.close();
  await f.dispose();
}
assert.equal(failures.length, 0, 'All sidebar, Canvas and navigation focus checks must pass');
