// Test-only native Windows adapter for the maintained PWA assertions.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { spawnWindowsContainedProcess } from '../../packages/engines/dist/windows-job-process.js';
import { runtimeProcessHandle } from '../../packages/engines/dist/process-termination.js';
import { openQualificationBrowser, combinedQualificationFailure } from '../../packaging/qualification/persistent-pwa-upgrade.mjs';
import { setTimeout as delay } from 'node:timers/promises';

export async function openWindowsPwaBrowser(executable, profileDir) {
  assert.equal(process.platform, 'win32');
  await mkdir(profileDir, { recursive: true });
  return openQualificationBrowser(executable, profileDir, async () => {
    const args = ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profileDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-component-update', '--disable-dev-shm-usage',
      '--disable-features=Translate,OptimizationHints', 'about:blank'];
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL',
      'SystemRoot', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']
      .flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
    const { child, authority } = spawnWindowsContainedProcess({ bin: executable, args,
      cwd: profileDir, env, stdin: 'pipe', browserPipe: true });
    const handle = runtimeProcessHandle(child, { label: 'Owned PWA qualification browser', termGraceMs: 5000 }, authority);
    let launchError = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => { launchError = `${launchError}${chunk}`.slice(-4000); });
    const close = async connection => {
      await connection?.send('Browser.close').catch(() => undefined);
      // Match the maintained POSIX qualifier: let Chrome flush its owned
      // persistent profile before escalating a stuck tree to Job termination.
      const gracefulDeadline = Date.now() + 5000;
      while (handle.isAlive() && Date.now() < gracefulDeadline) await delay(25);
      await handle.close();
      const deadline = Date.now() + 5000;
      while (handle.isAlive() && Date.now() < deadline) await delay(25);
      assert.equal(handle.isAlive(), false, 'Owned PWA browser remains alive after shutdown');
    };
    try {
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      assert.ok(child.stdin && child.stdout, 'Native contained browser debugging pipes unavailable');
      return { child, input: child.stdin, output: child.stdout, launchError: () => launchError, close };
    } catch (error) {
      const cleanupErrors = [];
      try { await close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      throw combinedQualificationFailure(error, cleanupErrors, 'Windows PWA browser startup and cleanup failed');
    }
  });
}
