import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const recoveryTestFiles = [
  'apps/server/test/gui-qualification-pid.test.mjs',
  'apps/server/test/recovery-coverage.test.mjs',
  'apps/server/test/browser-drain-cancellation.test.mjs',
  'apps/server/test/browser-session-residue.test.mjs',
  'apps/server/test/browser-grant-release.test.mjs',
  'apps/server/test/dependency-process-restart.test.mjs',
  'apps/server/test/branch-mixed-restart.test.mjs',
];
export const speechBrowserFiles = [
  'apps/web/test/speech-browser.check.mjs',
  'apps/web/test/speech-browser-entry.ts',
  'apps/web/test/voice-conversation-browser.check.mjs',
  'apps/web/test/voice-conversation-browser-entry.tsx',
];

export async function verifyRecoveryFiles(root) {
  // Node 24 can accept a partially matched list of test paths. Check every
  // required suite explicitly before starting any test or browser process.
  const missing = [];
  for (const file of [...recoveryTestFiles, ...speechBrowserFiles]) {
    try {
      const stat = await lstat(path.join(root, file));
      if (!stat.isFile() || stat.size === 0) missing.push(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push(file);
    }
  }
  if (missing.length) throw new Error(`Required recovery coverage is missing or empty:\n${missing.join('\n')}`);
}

async function main() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  await verifyRecoveryFiles(root);
  const env = { ...process.env };
  // Match the server test runner: constructed servers must never claim the
  // operator's broker, data directory or hosted browser session.
  for (const key of [
    'PONDEROSA_BROWSER_SERVICE_SOCKET', 'PONDEROSA_DATA_DIR',
    'PONDEROSA_LAUNCHER_DATA_DIR', 'PONDEROSA_PROXY_SOCKET_PATH',
    'PONDEROSA_BROWSER_MULTI_PAGE', 'PONDEROSA_BROWSER_FILE_UPLOAD',
    'PONDEROSA_BROWSER_HOSTED_HEADED',
  ]) delete env[key];
  for (const args of [
    ['--test', '--test-concurrency=1', ...recoveryTestFiles],
    ['apps/web/test/speech-browser.check.mjs'],
    ['apps/web/test/voice-conversation-browser.check.mjs'],
  ]) {
    console.log(`Recovery coverage: node ${args.join(' ')}`);
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
    const forwarders = ['SIGINT', 'SIGTERM'].map(signal => {
      const forward = () => child.kill(signal);
      process.on(signal, forward);
      return [signal, forward];
    });
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve([code, signal]));
    });
    for (const [name, forward] of forwarders) process.off(name, forward);
    if (signal || code !== 0) throw new Error(`Recovery check failed: ${args.join(' ')} (${signal ?? code})`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
