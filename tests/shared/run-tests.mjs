import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  for (const [lane, tests] of lanes) {
    const args = ['--import', pathToFileURL(path.join(testsRoot, 'shared/workspace-resolution.mjs')).href, '--test'];
    if (lane === 'web') args.unshift('--experimental-transform-types', '--import', pathToFileURL(path.join(testsRoot, 'shared/resolve-typescript.mjs')).href);
    if (lane === 'server') args.push('--test-concurrency=1');
    args.push(...tests.map(file => path.join(root, file)));
    console.log(`Test lane ${lane}: ${tests.join(', ')}`);
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
  }
}
