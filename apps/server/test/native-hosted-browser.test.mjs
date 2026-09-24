import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { createNativeHostedBrowser } from '../dist/native-hosted-browser.js';
import { ApprovedChromeConnection } from '../dist/approved-chrome-connection.js';

test('native manual browser uses a private desktop socket, blocks automation and closes every process', { skip: process.env.PONDEROSA_TEST_NATIVE_BROWSER !== '1', timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-browser-test-'));
  const handles = [];
  let driver;
  try {
    driver = await createNativeHostedBrowser('/usr/bin/google-chrome', join(root, 'profile'), () => {}, handle => handles.push(handle), () => {}, {});
    assert.equal(driver.manualState(), 'manual');
    assert.equal(handles.length, 4, 'Xvfb, Chrome, writable display and read-only display are all supervised');
    assert.ok(handles.every(handle => handle.terminationAuthority === driver.terminationAuthority));
    const socketPath = driver.manualSocket();
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    const greeting = await new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.setTimeout(3000, () => socket.destroy(new Error('Desktop handshake timeout')));
      socket.once('error', reject);
      socket.once('data', data => { resolve(data.toString()); socket.destroy(); });
    });
    assert.match(greeting, /^RFB 003\./);
    assert.throws(() => driver.inspect(), /manual mode/);
    assert.throws(() => driver.capture(), /manual mode/);
    const revision = driver.controlRevision();
    await driver.pauseAutomation();
    assert.ok(driver.controlRevision() > revision);
    assert.equal(driver.isAlive(), true);
    assert.equal(driver.paused, undefined);
    assert.equal(driver.activity, undefined);
    await assert.rejects(driver.resumeAutomation());
    assert.equal(driver.manualState(), 'manual');
    assert.equal(driver.isAlive(), true);
    const originalConnect = ApprovedChromeConnection.connect;
    const attempts = [];
    ApprovedChromeConnection.connect = () => new Promise((_resolve, reject) => attempts.push(reject));
    try {
      const first = driver.resumeAutomation();
      await driver.pauseAutomation();
      const second = driver.resumeAutomation();
      attempts[0](new Error('old cancelled attempt'));
      await assert.rejects(first, /old cancelled/);
      assert.equal(driver.manualState(), 'connecting', 'a cancelled attempt cannot cancel a newer resume');
      attempts[1](new Error('new attempt denied'));
      await assert.rejects(second, /new attempt denied/);
      assert.equal(driver.manualState(), 'manual');
    } finally { ApprovedChromeConnection.connect = originalConnect; }
    await driver.close();
    assert.equal(driver.isAlive(), false);
    assert.ok(handles.every(handle => !handle.isAlive()));
    await assert.rejects(access(socketPath));
  } finally {
    if (driver) await driver.close();
    else for (const handle of handles) await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('owned Chrome opens in Ponderosa mode and returns there after private sign-in without replacing tabs', { skip: process.env.PONDEROSA_TEST_NATIVE_BROWSER !== '1', timeout: 45000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-connected-browser-test-'));
  const handles = [];
  let driver;
  try {
    driver = await createNativeHostedBrowser('/usr/bin/google-chrome', join(root, 'profile'), () => {}, handle => handles.push(handle), () => {}, { connectOnOpen: true });
    assert.equal(driver.manualState(), 'automation');
    assert.ok((await driver.pages()).pages.length >= 1);
    const screenshot = await driver.capture();
    assert.ok(screenshot.length > 100, 'the custom page viewport receives actual Chrome pixels');
    const page = (await driver.pages()).pages[0];
    await driver.pauseAutomation();
    assert.equal(driver.manualState(), 'manual');
    assert.throws(() => driver.capture(), /manual mode/);
    await driver.resumeAutomation();
    assert.equal(driver.manualState(), 'automation');
    assert.equal((await driver.pages()).pages[0].url, page.url, 'private sign-in preserved the current tab');
    assert.equal(driver.isAlive(), true);
  } finally {
    if (driver) await driver.close();
    else for (const handle of handles) await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});
