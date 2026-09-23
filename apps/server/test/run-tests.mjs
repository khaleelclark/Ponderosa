import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';

// Tests may run inside an Agent that inherited the host application's env.
// Never let a constructed test server claim its browser broker or data root.
const env = { ...process.env };
for (const key of [
  'PONDEROSA_BROWSER_SERVICE_SOCKET',
  'PONDEROSA_DATA_DIR',
  'PONDEROSA_LAUNCHER_DATA_DIR',
  'PONDEROSA_PROXY_SOCKET_PATH',
  'PONDEROSA_BROWSER_MULTI_PAGE',
  'PONDEROSA_BROWSER_FILE_UPLOAD',
  'PONDEROSA_BROWSER_HOSTED_HEADED',
]) delete env[key];

const files = (await readdir(new URL('.', import.meta.url)))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => `test/${name}`);
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  cwd: new URL('..', import.meta.url),
  env,
  stdio: 'inherit',
});
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
if (signal) process.kill(process.pid, signal);
else process.exitCode = code ?? 1;
