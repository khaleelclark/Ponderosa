import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { PONDEROSA_RUNTIME_TOOLS, PONDEROSA_IMPORT_FILE_TOOL, PONDEROSA_MESSAGE_TOOL, PONDEROSA_HISTORY_TOOL } from '@ponderosa/core';
import { ClaudeStreamSession } from '../dist/claude-stream-session.js';
import { encodeSessionTools, decodeSessionTools } from '../dist/ponderosa-mcp-contract.js';

const project = tools => tools.map(({ name, description, inputSchema }) => ({ name: name.replace(/^ponderosa_/, ''), description, inputSchema }));
const frozen = { ...structuredClone(PONDEROSA_IMPORT_FILE_TOOL), description: 'Exact frozen publication policy, not the current build description.' };
const pack = value => deflateRawSync(JSON.stringify(value)).toString('base64');
async function mcp(t, environment) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/ponderosa-mcp.js', import.meta.url))], {
    env: { PATH: process.env.PATH, ...environment }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = once(child, 'exit');
  const responses = new Map();
  createInterface({ input: child.stdout }).on('line', line => {
    const response = JSON.parse(line); responses.get(response.id)?.(response.result);
  });
  t.after(async () => { child.stdin.end(); assert.equal((await exited)[0], 0); });
  let id = 0;
  return (method, params) => new Promise((resolve, reject) => {
    const current = ++id, timer = setTimeout(() => reject(Error('MCP protocol timeout')), 5000);
    responses.set(current, value => { clearTimeout(timer); responses.delete(current); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method, ...(params ? { params } : {}) }) + '\n');
  });
}

test('MCP session codec preserves selected descriptions, schemas and order without mutating canonical tools', () => {
  const tools = [frozen, PONDEROSA_MESSAGE_TOOL, PONDEROSA_HISTORY_TOOL];
  tools[0] = structuredClone(frozen); tools[0].inputSchema.properties.path.maxLength = 32;
  assert.deepEqual(decodeSessionTools(encodeSessionTools(tools)), tools);
  assert.deepEqual(decodeSessionTools(encodeSessionTools(PONDEROSA_RUNTIME_TOOLS)), PONDEROSA_RUNTIME_TOOLS);
  assert.notEqual(PONDEROSA_IMPORT_FILE_TOOL.description, frozen.description);
  assert.equal(PONDEROSA_IMPORT_FILE_TOOL.inputSchema.properties.path.maxLength, 4096);
});

test('supplied malformed, unknown, duplicate, oversized and overnested definitions fail closed', () => {
  let nested = { type: 'object' };
  for (let depth = 0; depth < 20; depth++) nested = { type: 'object', nested };
  const cases = [null, {}, [null], [{ ...frozen, name: 'ponderosa_arbitrary' }], [frozen, frozen],
    [{ ...frozen, extra: true }], [{ ...frozen, description: 1 }], [{ ...frozen, description: 'x'.repeat(8193) }],
    [{ ...frozen, description: 'unsafe\0control' }], [{ ...frozen, inputSchema: [] }], [{ ...frozen, inputSchema: { type: 'string' } }],
    [{ ...frozen, inputSchema: nested }], [{ ...frozen, inputSchema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 4100 }, (_, i) => [`p${i}`, ''])) } }],
  ];
  for (const value of cases) assert.deepEqual(decodeSessionTools(pack(value)), []);
  const invalidUtf8 = Buffer.concat([Buffer.from('[{"name":"ponderosa_import_file","description":"'), Buffer.from([255]), Buffer.from('","inputSchema":{"type":"object"}}]')]);
  for (const raw of ['', 'not-base64', 'AAAA!', 'A'.repeat(16388), deflateRawSync(Buffer.alloc(65537, 32)).toString('base64'), deflateRawSync(invalidUtf8).toString('base64')]) {
    assert.deepEqual(decodeSessionTools(raw), []);
  }
  assert.equal(decodeSessionTools(undefined), undefined, 'absent standalone transport retains legacy behavior');
  assert.deepEqual(decodeSessionTools(encodeSessionTools([])), [], 'explicit empty selection does not fall back');
  assert.throws(() => encodeSessionTools([{ ...frozen, name: 'ponderosa_arbitrary' }]));
});

test('actual MCP tools/list uses selected definitions but retains capability filtering and disabled-call rejection', async t => {
  const rpc = await mcp(t, { PONDEROSA_AGENT_TOOL_DEFINITIONS: encodeSessionTools([frozen, PONDEROSA_MESSAGE_TOOL]),
    PONDEROSA_AGENT_TOOL_NAMES: JSON.stringify(['ponderosa_import_file']), PONDEROSA_AGENT_MESSAGE_TOKEN: 'disposable-no-authority' });
  assert.deepEqual((await rpc('tools/list')).tools, project([frozen]));
  const disabled = await rpc('tools/call', { name: 'message', arguments: { text: 'must not be sent' } });
  assert.equal(disabled.isError, true); assert.match(disabled.content[0].text, /unavailable for this Run/);
  const unknown = await rpc('tools/call', { name: 'arbitrary', arguments: {} });
  assert.equal(unknown.isError, true);
});

test('actual MCP malformed supplied contract cannot fall back to canonical enabled tools', async t => {
  const rpc = await mcp(t, { PONDEROSA_AGENT_TOOL_DEFINITIONS: 'malformed', PONDEROSA_AGENT_TOOL_NAMES: JSON.stringify(['ponderosa_import_file']) });
  assert.deepEqual((await rpc('tools/list')).tools, []);
  assert.equal((await rpc('tools/call', { name: 'import_file', arguments: { path: '/must-not-read' } })).isError, true);
});

test('Claude adapter supplies frozen definitions to its actual configured MCP process, overriding inherited definitions', { timeout: 10000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'mcp-session-'))), capture = join(directory, 'tools.json');
  const session = new ClaudeStreamSession({
    bin: fileURLToPath(new URL('./fixtures/claude-context-stream.mjs', import.meta.url)), permissionMode: 'default', killGraceMs: 100,
    agentId: 'disposable', cwd: directory, history: [], resumeSessionId: 'frozen-session',
    signal: new AbortController().signal, onRuntimeSpawned() {}, dynamicTools: [frozen, PONDEROSA_MESSAGE_TOOL],
    environment: { PONDEROSA_AGENT_MESSAGE_URL: 'http://127.0.0.1:1/unavailable', PONDEROSA_AGENT_MESSAGE_TOKEN: 'disposable-no-authority',
      PONDEROSA_AGENT_TOOL_NAMES: JSON.stringify(['ponderosa_import_file']),
      PONDEROSA_AGENT_TOOL_DEFINITIONS: encodeSessionTools(PONDEROSA_RUNTIME_TOOLS), PONDEROSA_CLAUDE_FIXTURE_MCP_CAPTURE: capture },
  });
  try {
    await session.startTurn({ prompt: 'Disposable protocol boundary probe', kind: 'system', clientMessageId: 'probe' });
    for await (const event of session.events) { if (event.type === 'turn_done') break; }
    assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), project([frozen]));
  } finally { await session.close(); await rm(directory, { recursive: true, force: true }); }
});
