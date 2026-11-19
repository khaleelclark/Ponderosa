import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const testsRoot = path.join(root, 'tests');
const inventory = JSON.parse(readFileSync(new URL('./inventory.json', import.meta.url), 'utf8'));
const owners = new Map(inventory.tests.map(entry => [entry.path, entry]));
const { values, positionals } = parseArgs({ options: { lane: { type: 'string' }, list: { type: 'boolean' } }, allowPositionals: true });
if (positionals.length > 1 || (values.lane && positionals.length)) throw new Error('Choose one feature or one legacy lane');
const feature = positionals[0];
const files = readdirSync(testsRoot, { recursive: true }).filter(file => file.endsWith('.test.mjs')).map(file => 'tests/' + file.split(path.sep).join('/')).sort();
const missing = files.filter(file => !owners.has(file));
const absent = [...owners.keys()].filter(file => !files.includes(file));
if (missing.length || absent.length || owners.size !== inventory.tests.length) throw new Error(`Inventory/discovery mismatch: unregistered=${missing}, absent=${absent}`);
const selected = files.filter(file => (!feature || file.startsWith(`tests/${feature}/`)) && (!values.lane || owners.get(file)?.lane === values.lane));
if (!selected.length) throw new Error(`No tests found for ${feature ?? values.lane ?? 'all'}`);
if (values.list) {
  for (const file of selected) console.log(file);
} else {
  // Preserve the former package lanes: server serializes its files; web and
  // tooling retain Node's default process isolation/concurrency. Root runs each
  // lane once rather than calling both compatibility scripts and feature runs.
  const lanes = Map.groupBy(selected, file => owners.get(file)?.lane ?? 'unregistered');
  const temp = mkdtempSync(path.join(tmpdir(), 'ponderosa-tests-'));
  const deadline = setTimeout(() => stop(124), 30 * 60_000);
  let active;
  let exitCode;
  const stop = code => {
    exitCode ??= code;
    signalLane('SIGKILL');
  };
  const signalLane = signal => {
    if (!active?.pid) return;
    try { process.kill(process.platform === 'win32' ? active.pid : -active.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const interrupt = () => stop(130);
  const terminate = () => stop(143);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    for (const [lane, tests] of lanes) {
      const args = ['--import', pathToFileURL(path.join(testsRoot, 'shared/workspace-resolution.mjs')).href, '--test'];
      if (lane === 'web') args.unshift('--experimental-transform-types', '--import', pathToFileURL(path.join(testsRoot, 'shared/resolve-typescript.mjs')).href);
      if (lane === 'server') args.push('--test-concurrency=1');
      args.push(...tests.map(file => path.join(root, file)));
      console.log(`Test lane ${lane}: ${tests.join(', ')}`);
      active = spawn(process.execPath, args, {
        cwd: root, stdio: 'inherit', detached: process.platform !== 'win32',
        env: { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp },
      });
      const status = await new Promise((resolve, reject) => {
        active.once('error', reject);
        active.once('exit', resolve);
      });
      active = undefined;
      exitCode ??= status === 0 ? undefined : status ?? 1;
      if (exitCode !== undefined) break;
    }
  } finally {
    clearTimeout(deadline);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    if (process.env.KEEP_TEST_TMP === '1') console.log(`Retained disposable test directory: ${temp}`);
    else rmSync(temp, { recursive: true, force: true });
  }
  process.exitCode = exitCode ?? 0;
}
