import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromeBrowserDriverFactory } from '../../apps/server/dist/chrome-cdp-driver.js';
import { until } from '../shared/fixture.mjs';

const enabled = process.env.PONDEROSA_REGRESSION_NATIVE_BROWSER === '1';
test('checks 103, 104 (4 on Linux): host Chrome acts, reads the selected upload and shuts down safely', {
  timeout: 120000,
  skip: !enabled ? 'Set PONDEROSA_REGRESSION_NATIVE_BROWSER=1 with an existing host browser' : false,
}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-native-browser-'));
  const marker = `upload-${randomUUID()}`, uploaded = path.join(root, 'selected.txt'), survivor = path.join(root, 'user-file.txt');
  await writeFile(uploaded, marker); await writeFile(survivor, 'Preserved user working bytes');
  let submissions = 0, driver, passed = false;
  const handles = [];
  const server = createServer((request, response) => {
    if (request.url === '/submit') { submissions++; response.end('Submission received'); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><title>Owned browser qualification</title>
      <main><label>Message <input id="message"></label><button id="apply" onclick="document.getElementById('result').textContent=document.getElementById('message').value">Apply</button><output id="result"></output>
      <form action="/submit" method="post"><label>Selected file <input id="chosen" type="file" accept="text/plain"></label><label>Other file <input id="other" type="file"></label><output id="upload-result"></output><button type="submit">Submit</button></form></main>
      <script>document.getElementById('chosen').onchange=async e=>{const f=e.target.files[0];document.getElementById('upload-result').textContent=f?await f.text():''};</script>`);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    driver = await chromeBrowserDriverFactory(root)(randomUUID(), () => {}, handle => handles.push(handle), undefined,
      { owner: { version: 1, kind: 'chat', conversationId: randomUUID() }, nativeManual: process.platform === 'linux', connectOnOpen: true, initialUrl: url });
    await driver.navigate(url);
    await driver.fill('#message', 'Harmless typed value'); await driver.click('#apply');
    assert.match(await driver.inspect('#result'), /Harmless typed value/);
    if (process.platform === 'linux') {
      const processBefore = { ...driver.processIdentity };
      assert.ok(processBefore.pid, 'Native pause has no observed browser process identity');
      await driver.pauseAutomation(); assert.equal(driver.manualState(), 'manual');
      await assert.rejects(async () => driver.click('#apply'), 'Automation continued while manual control owned the browser');
      await driver.resumeAutomation(); assert.equal(driver.manualState(), 'automation');
      assert.deepEqual(driver.processIdentity, processBefore, 'Resume replaced the browser process');
      assert.match(await driver.inspect('#message'), /Harmless typed value/, 'Resume lost the existing page state');
    } else t.diagnostic(`${process.platform} uses actual isolated headless Chrome; native manual desktop control is Linux-only. Native UI/manual control remains unqualified.`);
    assert.equal(driver.isAlive(), true);
    await driver.fill('#message', 'Resumed value'); await driver.click('#apply');
    assert.match(await driver.inspect('#result'), /Resumed value/);
    const result = await driver.upload({ uploadId: randomUUID(), selector: '#chosen', stagedPath: uploaded, expectedName: 'selected.txt', expectedSize: Buffer.byteLength(marker), expectedMediaType: 'text/plain' });
    assert.equal(result.input.name, 'selected.txt'); assert.equal(result.input.count, 1); assert.equal(result.input.size, Buffer.byteLength(marker));
    await until(async () => (await driver.inspect('#upload-result')).includes(marker), 'selected file bytes reached actual browser input');
    const other = JSON.parse(await driver.inspect('#other'));
    assert.ok(!JSON.stringify(other).includes('selected.txt'), 'The unselected input received the fixture file');
    assert.equal(submissions, 0, 'Setting a file unexpectedly submitted the website form');
    const pixels = await driver.capture(); assert.deepEqual([...pixels.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    if (process.env.PONDEROSA_REGRESSION_EVIDENCE_DIR) {
      await mkdir(process.env.PONDEROSA_REGRESSION_EVIDENCE_DIR, { recursive: true });
      await writeFile(path.join(process.env.PONDEROSA_REGRESSION_EVIDENCE_DIR, `native-browser-${process.platform}.png`), pixels);
    }
    await driver.close(); assert.equal(driver.isAlive(), false); assert.ok(handles.every(handle => !handle.isAlive()), 'Owned native process authority remains alive');
    assert.equal(await readFile(survivor, 'utf8'), 'Preserved user working bytes');
    t.diagnostic(`Native ${process.platform}/${process.arch} browser: navigation, selector actions, selected upload, PNG capture and observed owned shutdown`);
    passed = true;
  } catch (error) { t.diagnostic(`Assertion before cleanup: ${error.stack ?? error}`); throw error; }
  finally {
    try {
      if (driver?.isAlive()) await driver.close();
      else if (!driver) await Promise.all(handles.map(handle => handle.close()));
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (passed) await rm(root, { recursive: true, force: true }); else t.diagnostic(`Failed native browser fixture retained: ${root}`);
    }
  }
});
