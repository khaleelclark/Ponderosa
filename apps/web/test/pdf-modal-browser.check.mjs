import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRsbuild } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { ProjectFileAuthority, registerProjectFileRoutes } from '../../server/dist/routes/project-files.js';
import { registerFilesRoute } from '../../server/dist/routes/workspace-files.js';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = require('fastify');
const playwright = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? require.resolve('playwright-core'));
const engine = process.env.PONDEROSA_TEST_BROWSER ?? 'chromium';
const web = process.env.PONDEROSA_PDF_SOURCE_ROOT ? path.join(process.env.PONDEROSA_PDF_SOURCE_ROOT, 'apps/web')
  : fileURLToPath(new URL('..', import.meta.url));
const pdfjs = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-pdf-modal-'));
const output = path.join(root, 'web');
const before = process.env.PONDEROSA_EXPECT_PDF_LOOP === '1';
const app = Fastify();
let browser;
let stalledBodies = 0, closedBodies = 0, stallEnabled = true;
function pdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const [i, name] of pages.entries()) {
    const text = `BT /F1 24 Tf 30 700 Td (${name}) Tj ET\n${i ? '0 0 1' : '1 0 0'} rg 30 30 80 80 re f`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`);
  }
  let body = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
try {
  await writeFile(path.join(root, 'report.pdf'), pdf(['Single page qualification']));
  await writeFile(path.join(root, 'multipage.pdf'), pdf(['First page qualification', 'Second page qualification']));
  await writeFile(path.join(root, 'stalled.pdf'), pdf(['Recovered document qualification']));
  await writeFile(path.join(root, 'broken.pdf'), Buffer.from('%PDF-1.4\nnot a valid document\n'));
  const store = { getProject: id => id === 'project' ? { id, hostPath: root } : undefined, getAgent: () => undefined,
    getConversation: id => id === 'chat' ? { id, projectId: 'project', workingDirectory: root } : undefined,
    projectHasArtifactSourcePath: () => false };
  app.addHook('onRequest', async (request, reply) => {
    const target = new URL(request.url, 'http://localhost');
    if (stallEnabled && target.pathname.endsWith('/workspace-files/preview') && target.searchParams.get('path') === 'stalled.pdf') {
      reply.hijack(); reply.raw.writeHead(200, { 'content-type': 'application/pdf' }); reply.raw.write('%PDF-1.4\n');
      stalledBodies++; reply.raw.on('close', () => { stalledBodies--; closedBodies++; });
    }
  });
  registerProjectFileRoutes(app, new ProjectFileAuthority(store, {}), store);
  registerFilesRoute(app, { store });
  const build = await createRsbuild({ cwd: web, rsbuildConfig: { plugins: [pluginReact()], source: { transformImport: [], entry: {
    modal: path.join(web, 'test/ui-audit-browser-entry.tsx'), standalone: path.join(web, 'test/qualification-followups-entry.tsx'),
  }, ...(!before ? { alias: {
    'pdfjs-dist/legacy/build/pdf.mjs$': fileURLToPath(new URL('./fixtures/pdf-lifecycle-probe.ts', import.meta.url)),
    '@qualification-real-pdfjs': path.join(pdfjs, 'legacy/build/pdf.mjs'),
  } } : {}) }, output: { distPath: { root: output }, copy: [
    { from: path.join(pdfjs, 'cmaps'), to: 'static/pdfjs/6.3.289/cmaps' },
    { from: path.join(pdfjs, 'standard_fonts'), to: 'static/pdfjs/6.3.289/standard_fonts' },
  ] }, logLevel: 'error' } });
  await build.build();
  app.addHook('onSend', async (_request, reply, payload) => {
    if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    return payload;
  });
  app.get('/api/pdf/good', async (_request, reply) => reply.type('application/pdf').send(await readFile(path.join(root, 'multipage.pdf'))));
  app.get('/api/pdf/single', async (_request, reply) => reply.type('application/pdf').send(await readFile(path.join(root, 'report.pdf'))));
  app.get('/test/pdf-lifecycle', async request => {
    if (new URL(request.url, 'http://localhost').searchParams.get('release') === '1') stallEnabled = false;
    return { stalledBodies, closedBodies };
  });
  app.get('/*', async (request, reply) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = path.resolve(output, '.' + pathname);
    if (!file.startsWith(output + '/')) return reply.code(404).send();
    try { return reply.type(file.endsWith('.html') ? 'text/html' : /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream').send(await readFile(file)); }
    catch { return reply.code(404).send(); }
  });
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' ? { executablePath: process.env.PONDEROSA_CHROMIUM_PATH,
    args: process.env.PONDEROSA_CLASSIC_SCROLLBARS === '1' ? ['--disable-features=OverlayScrollbar,OverlayScrollbars,FluentOverlayScrollbar'] : [] } : {}) });
  console.log(JSON.stringify({ engine, browserVersion: browser.version(), node: process.version, platform: process.platform, arch: process.arch,
    baselineReproduction: before, sourceRoot: web }));
  for (const width of before ? [1440] : [390, 768, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 640 } });
    await instrument(page);
    await page.goto(`${origin}/modal.html?case=preview`);
    // Exercise the supported classic-scrollbar geometry, not a made-up resize
    // callback. A portrait page genuinely overflows the actual DialogContent.
    await page.addStyleTag({ content: '.MuiDialogContent-root::-webkit-scrollbar{width:17px}' });
    await page.getByText('report.pdf', { exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.waitFor();
    if (before) {
      await page.waitForTimeout(2000);
      const trace = await page.evaluate(() => window.pdfGeometry);
      console.log(JSON.stringify({ engine, width, trace, scrolling: await dialog.locator('.MuiDialogContent-root').evaluate(e => ({
        scrollHeight: e.scrollHeight, clientHeight: e.clientHeight, clientWidth: e.clientWidth, offsetWidth: e.offsetWidth })) }));
      await page.screenshot({ path: `/tmp/remaining-pdf-before-${engine}-${width}.png` });
      assert(trace.length > 8, 'baseline must reproduce repeated resize/render churn');
      assert(new Set(trace.map(event => Math.floor(event.width))).size > 1, 'scrollbar width repeatedly changes');
      assert(trace.some(event => event.display === 'none') && trace.some(event => event.display === 'block'),
        'the preview repeatedly hides and briefly shows the canvas rather than stabilizing');
      assert(trace.at(-1).at - trace[0].at > 1500, 'render churn continues throughout the observation, not only at startup');
    } else {
      await painted(dialog, 'Single page qualification', 'red');
      assert(await dialog.locator('.MuiDialogContent-root').evaluate(e => e.scrollHeight > e.clientHeight), 'portrait fixture exercises actual modal overflow');
      await page.waitForTimeout(2000);
      assert((await page.evaluate(() => window.pdfGeometry)).length < 8, 'paint stabilizes instead of cycling with scrollbar width');
      await page.screenshot({ path: `/tmp/remaining-pdf-after-${engine}-${width}.png` });
      for (const resized of [width === 390 ? 844 : 390, width, 768, width]) {
        await page.setViewportSize({ width: resized, height: 640 });
        await page.waitForTimeout(100); // Allow ResizeObserver/React to replace the old paint.
        await painted(dialog, 'Single page qualification', 'red');
      }
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await closed(page, dialog);
      await page.getByText('multipage.pdf', { exact: true }).click();
      await painted(dialog, 'First page qualification', 'red');
      await dialog.getByRole('button', { name: 'Next page', exact: true }).click();
      await painted(dialog, 'Second page qualification', 'blue');
      // Delay page 1, select page 2, then release the stale page result.
      await page.evaluate(() => { window.pdfLifecycle.delayPage = 1; });
      await dialog.getByRole('button', { name: 'Previous page', exact: true }).click();
      await page.waitForFunction(() => window.pdfLifecycle.delayedPages.length === 1);
      await dialog.getByRole('button', { name: 'Next page', exact: true }).click();
      await painted(dialog, 'Second page qualification', 'blue');
      await page.evaluate(() => { window.pdfLifecycle.delayPage = 0; window.pdfLifecycle.releasePages(); });
      await painted(dialog, 'Second page qualification', 'blue');
      // Navigation remains available during a pending render, not only after it.
      await page.evaluate(() => { window.pdfLifecycle.mode = 'stall'; });
      await dialog.getByRole('button', { name: 'Previous page', exact: true }).click();
      await page.waitForFunction(() => window.pdfLifecycle.activeRenders === 1);
      await page.evaluate(() => { window.pdfLifecycle.mode = 'normal'; });
      await dialog.getByRole('button', { name: 'Next page', exact: true }).click();
      await painted(dialog, 'Second page qualification', 'blue');
      assert(await page.evaluate(() => window.pdfLifecycle.cancelled > 0), 'page switch cancels the previous render');
      assert(await dialog.evaluate(element => element.contains(document.activeElement)), 'page-boundary navigation retains focus inside the dialog');
      await page.keyboard.press('Escape'); await closed(page, dialog);
      // Same exact valid bytes in the shared standalone viewer.
      for (const [name, marker] of [['single', 'Single page qualification'], ['good', 'First page qualification']]) {
        await page.goto(`${origin}/standalone.html`);
        if (name === 'single') await page.route('**/api/pdf/good', route => route.fulfill({ body: pdf(['Single page qualification']), contentType: 'application/pdf' }));
        await page.reload();
        await painted(page, marker, 'red');
        if (name === 'good') {
          await page.getByRole('button', { name: 'Next page', exact: true }).click();
          await painted(page, 'Second page qualification', 'blue');
        }
        await page.unroute('**/api/pdf/good');
      }
      console.log(`PASS ${engine} ${width}: actual Workspace Files modal + same-byte standalone, single/multipage nontransparent paint, classic overflow, resize/orientation-width, delayed page fencing and pending-render navigation`);
    }
    if (before) { await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => window.pdfObservers), 0, 'closing disconnects the PDF resize observer'); }
    await page.close();
  }
  if (!before) await lifecycle(browser, origin);
} finally { await browser?.close(); await app.close(); await rm(root, { recursive: true, force: true }); }

async function painted(scope, marker, colour) {
  const canvas = scope.locator('canvas'); await canvas.waitFor({ state: 'visible', timeout: 10_000 });
  await scope.getByText(marker, { exact: true }).waitFor();
  const read = () => canvas.evaluate(c => {
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let red = 0, blue = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 0) {
      if (data[i] > 180 && data[i + 1] < 80 && data[i + 2] < 80) red++;
      if (data[i + 2] > 180 && data[i] < 80 && data[i + 1] < 80) blue++;
    }
    return { red, blue, pixels: c.width * c.height };
  });
  let pixels;
  for (let i = 0; i < 100; i++) {
    pixels = await read();
    if (pixels[colour] > 100 && pixels[colour === 'red' ? 'blue' : 'red'] === 0) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert(pixels[colour] > 100 && pixels[colour === 'red' ? 'blue' : 'red'] === 0, `exact selected page paints ${colour}, not transparent or stale pixels: ${JSON.stringify(pixels)}`);
  assert(pixels.pixels <= 4_000_000, 'the actual canvas retains its four-million-pixel limit');
}
async function closed(page, dialog) {
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.pdfObservers === 0 && window.pdfLifecycle.activeDocuments === 0 && window.pdfLifecycle.activeRenders === 0 && window.pdfLifecycle.textReaders === 0);
}
async function lifecycle(browser, origin) {
  const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await instrument(page);
  await page.goto(`${origin}/modal.html?case=preview`);
  // Install before loading the lazy preview, then advance the unchanged real
  // 30-second deadline rather than extending it or changing production timers.
  await page.clock.install();
  await page.getByText('multipage.pdf', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await painted(dialog, 'First page qualification', 'red');
  await page.evaluate(() => { window.pdfLifecycle.mode = 'stall'; });
  await dialog.getByRole('button', { name: 'Next page', exact: true }).click();
  await page.waitForFunction(() => window.pdfLifecycle.activeRenders === 1);
  for (const width of [430, 390, 768, 390]) {
    await page.clock.runFor(7000);
    await page.setViewportSize({ width, height: 640 });
    await page.waitForFunction(() => window.pdfLifecycle.activeRenders === 1);
  }
  await page.clock.runFor(2001);
  await dialog.getByRole('alert').filter({ hasText: 'took too long to process' }).waitFor();
  await page.screenshot({ path: `/tmp/remaining-pdf-error-${engine}-390.png` });
  assert.equal(await page.evaluate(() => window.pdfLifecycle.activeRenders), 0, 'overall deadline cancels the last resize replacement');
  const attempts = await page.evaluate(() => window.pdfLifecycle.renders);
  await page.setViewportSize({ width: 430, height: 640 }); await page.clock.runFor(35_000);
  assert.equal(await page.evaluate(() => window.pdfLifecycle.renders), attempts, 'terminal error cannot automatically retry on resize');
  await page.evaluate(() => { window.pdfLifecycle.mode = 'normal'; });
  await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
  await painted(dialog, 'First page qualification', 'red');
  await page.evaluate(() => { window.pdfLifecycle.mode = 'fail'; });
  await dialog.getByRole('button', { name: 'Next page', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: 'could not be displayed' }).waitFor();
  await page.keyboard.press('Escape'); await page.clock.runFor(500); await closedLifecycle(page, dialog);
  await page.evaluate(() => { window.pdfLifecycle.mode = 'normal'; });
  await page.getByText('broken.pdf', { exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: 'could not be loaded' }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Try again', exact: true }).count(), 1);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click(); await page.clock.runFor(500); await closedLifecycle(page, dialog);
  for (const action of ['close', 'deadline']) {
    await page.getByText('stalled.pdf', { exact: true }).click();
    await dialog.getByText('Loading PDF…', { exact: true }).waitFor();
    await pollBodies(page, origin, state => state.stalledBodies === 1);
    if (action === 'close') { await page.keyboard.press('Escape'); await page.clock.runFor(500); await closedLifecycle(page, dialog); }
    else {
      await page.clock.runFor(30_001);
      await dialog.getByRole('alert').filter({ hasText: 'took too long to load' }).waitFor();
    }
    await pollBodies(page, origin, state => state.stalledBodies === 0);
  }
  await page.request.get(`${origin}/test/pdf-lifecycle?release=1`);
  await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
  await painted(dialog, 'Recovered document qualification', 'red');
  await page.keyboard.press('Escape'); await page.clock.runFor(500); await closedLifecycle(page, dialog);
  // Initial document decoding and paint share the same deadline; completing
  // decoding late must not silently grant another thirty seconds to paint.
  await page.evaluate(() => { window.pdfLifecycle.delayDocument = true; window.pdfLifecycle.mode = 'stall'; });
  await page.getByText('report.pdf', { exact: true }).click();
  await page.waitForFunction(() => window.pdfLifecycle.delayedDocuments.length === 1);
  await page.clock.runFor(20_000);
  await page.evaluate(() => { window.pdfLifecycle.delayDocument = false; window.pdfLifecycle.releaseDocuments(); });
  await page.waitForFunction(() => window.pdfLifecycle.activeRenders === 1);
  await page.clock.runFor(10_001);
  await dialog.getByRole('alert').filter({ hasText: 'took too long to process' }).waitFor();
  await page.keyboard.press('Escape'); await page.clock.runFor(500); await closedLifecycle(page, dialog);
  // Closing while getPage is unresolved, then opening another file must fence
  // its late result. It must not replace the new file's exact text/pixels.
  await page.evaluate(() => { window.pdfLifecycle.mode = 'normal'; window.pdfLifecycle.delayPage = 1; });
  await page.getByText('multipage.pdf', { exact: true }).click();
  await page.waitForFunction(() => window.pdfLifecycle.delayedPages.length === 1);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.clock.runFor(500); await closedLifecycle(page, dialog);
  await page.evaluate(() => { window.pdfLifecycle.delayPage = 0; });
  await page.getByText('report.pdf', { exact: true }).click(); await painted(dialog, 'Single page qualification', 'red');
  await page.evaluate(() => window.pdfLifecycle.releasePages()); await painted(dialog, 'Single page qualification', 'red');
  await page.evaluate(() => { window.pdfLifecycle.mode = 'text-stall'; });
  await dialog.getByRole('button', { name: 'Try again', exact: true }).count().then(count => assert.equal(count, 0));
  await page.keyboard.press('Escape'); await page.clock.runFor(500); await closedLifecycle(page, dialog);
  await page.getByText('report.pdf', { exact: true }).click();
  await page.waitForFunction(() => window.pdfLifecycle.textReaders === 1);
  await page.keyboard.press('Escape'); await page.clock.runFor(500); await closedLifecycle(page, dialog);
  await page.clock.runFor(60_000);
  assert.equal(await page.getByRole('dialog').count(), 0, 'closed previews cannot resurrect after former deadlines');
  assert(await page.evaluate(() => window.pdfLifecycle.options.every(o => o.enableXfa === false && o.maxImageSize === 4_000_000 && o.stopAtErrors === true && o.useWasm === false)), 'decoder safety options are preserved');
  assert.deepEqual(errors, []);
  console.log(`PASS ${engine}: unchanged30s overall render budget despite four resizes, terminal retry/failure, page/file fencing, Close/Escape, cancelled document/render/text tasks, observer teardown and no late timer resurrection`);
  await page.close();
}
async function closedLifecycle(page, dialog) {
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.pdfObservers === 0 && window.pdfLifecycle.activeDocuments === 0 && window.pdfLifecycle.activeRenders === 0 && window.pdfLifecycle.textReaders === 0);
}
async function pollBodies(page, origin, predicate) {
  for (let i = 0; i < 100; i++) {
    const state = await (await page.request.get(`${origin}/test/pdf-lifecycle`)).json();
    if (predicate(state)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('the actual pending PDF HTTP body must start/abort within its fixture bound');
}
async function instrument(page) {
  await page.addInitScript(() => {
    window.pdfGeometry = []; window.pdfObservers = 0;
    const Native = ResizeObserver;
    window.ResizeObserver = class extends Native {
      pdf = false;
      constructor(callback) { super((entries, observer) => {
        for (const entry of entries) if (entry.target.closest('[aria-label^="PDF preview:"]')) {
          const canvas = entry.target.querySelector('canvas');
          if (window.pdfGeometry.length < 200) window.pdfGeometry.push({ at: performance.now(), width: entry.contentRect.width,
            canvas: canvas && [canvas.width, canvas.height], display: canvas && getComputedStyle(canvas).display });
        }
        callback(entries, observer);
      }); }
      observe(element, options) { if (!this.pdf && element.closest('[aria-label^="PDF preview:"]')) { this.pdf = true; window.pdfObservers++; } return super.observe(element, options); }
      disconnect() { if (this.pdf) { this.pdf = false; window.pdfObservers--; } return super.disconnect(); }
    };
  });
}
