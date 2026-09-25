import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const { chromium, webkit, devices } = createRequire(process.env.PLAYWRIGHT_PACKAGE || import.meta.url)('playwright');
const engine = process.env.BROWSER === 'webkit' ? webkit : chromium;
const executablePath = engine === webkit ? process.env.WEBKIT_PATH : process.env.CHROMIUM_PATH;
const browser = await engine.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

try {
  for (const width of [320, 390, 412]) {
    const context = await browser.newContext({ ...devices['Pixel 7'], viewport: { width, height: 915 } });
    const page = await context.newPage();
    await page.route('**/api/**', route => route.fulfill({ json: { items: [], total: 0, activeCount: 0, enabledCount: 0 } }));
    await page.goto('http://127.0.0.1:21848/?actions');

    const names = ['Copy action', 'Read aloud action', 'Mention action'];
    const boxes = await Promise.all(names.map(async name => page.getByRole('button', { name }).boundingBox()));
    const media = await page.evaluate(() => ({ coarse: matchMedia('(pointer: coarse)').matches, touch: navigator.maxTouchPoints }));
    assert.ok(boxes.every(box => box && box.width >= 28 && box.width <= 32 && box.height >= 44),
      `${width}px: message actions retain compact horizontal spacing and tall touch targets: ${JSON.stringify({ boxes, media })}`);
    for (let index = 1; index < boxes.length; index++) {
      const distance = boxes[index].x - boxes[index - 1].x;
      assert.ok(distance >= 28 && distance <= 34, `${width}px: action spacing is ${distance}px`);
    }

    for (const name of names) await page.getByRole('button', { name }).click();
    assert.deepEqual(JSON.parse(await page.locator('#message-actions').textContent()), ['copy', 'read', 'mention']);
    console.log(`PASS mobile message-action spacing and taps at ${width}px`);
    await context.close();
  }
} finally {
  await browser.close();
}
