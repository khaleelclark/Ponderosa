import test from 'node:test';
import assert from 'node:assert/strict';
import { composerCapabilities, parseCodexMcpList } from '@ponderosa/engines';
import { discoverCliMcps, parseCodexMcpDiscovery } from '../../packages/engines/dist/capabilities.js';

test('check 24: configured but unusable MCP is not presented as an available composer connector', () => {
  const configured = parseCodexMcpList(JSON.stringify([{ name: 'fixture', enabled: true }]));
  assert.equal(configured[0].configured, true); assert.equal(configured[0].usable, false);
  assert.deepEqual(composerCapabilities([], [], configured, '$'), []);
});
test('check 25: provider failure prose does not become a configured MCP server', () => {
  assert.deepEqual(parseCodexMcpList('Error: authentication failed while listing MCP servers'), []);
});


test('MCP discovery preserves JSON configured/disabled state without claiming usability', () => {
  const entries = parseCodexMcpList(JSON.stringify([
    { name: 'enabled', enabled: true, transport: { type: 'stdio', command: 'fixture' } },
    { name: 'disabled', enabled: false, disabled_reason: 'Fixture policy' },
    { name: 'disabled-default', enabled: false },
  ]));
  assert.deepEqual(entries.map(x => x.name), ['enabled', 'disabled', 'disabled-default']);
  assert.ok(entries.every(x => x.configured && !x.usable && !x.toolsDiscovered && x.initialization === 'not_initialized'));
  assert.equal(entries[1].detail, 'Fixture policy');
  assert.equal(entries[2].detail, 'Disabled in the provider configuration');
  assert.deepEqual(parseCodexMcpDiscovery('[]'), []);
  assert.deepEqual(parseCodexMcpDiscovery('No MCP servers configured yet. Try `codex mcp add my-tool -- my-command`.'), []);
});

test('MCP discovery accepts supported legacy transport tables and retains disabled reasons', () => {
  const legacy = 'Name  Command  Args  Env\nfixture  node  --fixture  -';
  assert.equal(parseCodexMcpDiscovery(legacy)[0].name, 'fixture');
  const tables = 'Name  Command  Args  Env  Cwd  Status  Auth\nlocal  node  --fixture  -  -  enabled  Unsupported\n\nName  Url  Bearer Token Env Var  Status  Auth\nremote  https://fixture.invalid  -  disabled: Fixture policy  Unsupported';
  const entries = parseCodexMcpDiscovery(tables);
  assert.deepEqual(entries.map(x => x.name), ['local', 'remote']);
  assert.ok(entries.every(x => x.configured && !x.usable));
  assert.equal(entries[1].detail, 'Fixture policy');
  const header=['Name','Command','Args','Env','Cwd','Status','Auth'];
  const row=['with-spaces','node','one  two','-','-','enabled','Unsupported'];
  const widths=header.map((cell,index)=>Math.max(cell.length,row[index].length));
  const render=cells=>cells.map((cell,index)=>cell.padEnd(widths[index])).join('  ');
  assert.equal(parseCodexMcpDiscovery(render(header)+'\n'+render(row))[0].name,'with-spaces');
});

test('diagnostic prose, malformed JSON and malformed table rows are never successful MCP inventories', () => {
  for (const output of ['Error: authentication failed while listing MCP servers', 'Warning: discovery unavailable', 'No MCP servers configured because authentication failed',
    '', '{bad', '{}', '[null]', '[{"name":"Error: authentication failed"}]', '[{"name":""}]', '[{"name":"fixture","enabled":"false"}]',
    'fixture  node  --fixture  -', 'Name  Command  Args  Env\nError:  authentication failed',
    'Name  Command  Args  Env\nError:  authentication  failed  now']) {
    assert.deepEqual(parseCodexMcpList(output), [], output);
    assert.throws(() => parseCodexMcpDiscovery(output), /invalid inventory/, output);
  }
});

for (const managed of [false, true]) test('CLI MCP '+(managed ? 'managed' : 'ordinary')+' discovery reports failures and separates stderr from inventory', async () => {
  const handles = [], controller = new AbortController();
  const lifecycle = managed ? { signal: controller.signal, onRuntimeSpawned: h => handles.push(h) } : undefined;
  const invoke = script => discoverCliMcps(process.execPath, ['-e', script], process.cwd(), parseCodexMcpDiscovery, lifecycle);
  const result = await invoke('process.stdout.write(JSON.stringify([{name:"fixture",enabled:true}]));process.stderr.write("Warning: fixture diagnostic");');
  assert.equal(result[0].name, 'fixture'); assert.equal(result[0].usable, false);
  assert.deepEqual(await invoke('process.stdout.write("[]");process.stderr.write("Warning: fixture diagnostic");'), []);
  await assert.rejects(invoke('process.stdout.write("[]");process.stderr.write("Error: authentication failed");process.exitCode=7;'), /MCP discovery failed/);
  await assert.rejects(invoke('process.stdout.write("Error: authentication failed while listing MCP servers");'), /invalid inventory/);
  await assert.rejects(invoke('process.stdout.write("{malformed");'), /invalid inventory/);
  await assert.rejects(discoverCliMcps('nonexistent-fixture-cli-'+process.pid, [], process.cwd(), parseCodexMcpDiscovery, lifecycle), /MCP discovery failed/);
  assert.ok(handles.every(handle => !handle.isAlive()), 'Discovery retained a live owned root');
});

test('aborted managed MCP discovery reports cancellation and observes owned root exit', async () => {
  const controller = new AbortController(), handles = [];
  const task = discoverCliMcps(process.execPath, ['-e', 'setInterval(()=>{},1000)'], process.cwd(), parseCodexMcpDiscovery, {
    signal: controller.signal, onRuntimeSpawned: handle => { handles.push(handle); queueMicrotask(() => controller.abort()); },
  });
  await assert.rejects(task, /MCP discovery aborted/);
  assert.ok(handles.every(handle => !handle.isAlive()));
});
