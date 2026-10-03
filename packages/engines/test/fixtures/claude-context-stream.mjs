#!/usr/bin/env node
// Disposable raw CLI transport. Never invokes a provider or reads a profile.
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
if (process.env.PONDEROSA_CLAUDE_FIXTURE_MCP_CAPTURE) {
  // Behave like the provider: start the configured MCP process and observe its
  // actual protocol response, not the adapter's pre-transport options.
  const config = JSON.parse(process.argv[process.argv.indexOf('--mcp-config') + 1]).mcpServers.ponderosa;
  const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error(`MCP exited ${code}`))); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const response = JSON.parse(line);
      if (response.id === 1) {
        await writeFile(process.env.PONDEROSA_CLAUDE_FIXTURE_MCP_CAPTURE, JSON.stringify(response.result.tools));
        break;
      }
    }
  } finally { child.stdin.end(); await exited; }
}
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let count = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type !== 'user') continue;
  count++;
  send({ type: 'system', subtype: 'init', session_id: frame.session_id });
  const input = Number(process.env.PONDEROSA_CLAUDE_FIXTURE_TOKENS ?? 150001);
  const assistant = (id, overrides = {}) => ({ type: 'assistant', session_id: frame.session_id,
    parent_tool_use_id: null, message: { id, role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'Disposable continuation: preserve objective, constraints, and exact next action.' }],
      ...(process.env.PONDEROSA_CLAUDE_FIXTURE_MISSING === '1' ? {} : {
        usage: { input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 8 },
      }) }, ...overrides });
  send(assistant(`before-current-${count}`));
  send({ ...frame, parent_tool_use_id: null, isReplay: true });
  if (process.env.PONDEROSA_CLAUDE_FIXTURE_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.PONDEROSA_CLAUDE_FIXTURE_DELAY)));
  const current = assistant(`current-${count}`);
  const mode = process.env.PONDEROSA_CLAUDE_FIXTURE_OBSERVATION;
  if (mode === 'missing') delete current.message.usage;
  if (mode === 'malformed') current.message.usage.input_tokens = -1;
  if (mode === 'stale') current.session_id = 'old-session';
  if (mode === 'subagent') current.parent_tool_use_id = 'native-helper';
  if (mode === 'replay') current.isReplay = true;
  if (mode === 'high') current.message.usage.input_tokens = 100000;
  send(current);
  send(current);
  send(assistant(`helper-${count}`, { parent_tool_use_id: 'native-helper' }));
  send(assistant(`old-${count}`, { session_id: 'old-session' }));
  send({ type: 'assistant', session_id: frame.session_id, parent_tool_use_id: null,
    message: { id: `synthetic-${count}`, role: 'assistant', model: '<synthetic>', content: [],
      usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } } });
  if (process.env.PONDEROSA_CLAUDE_FIXTURE_REPLY === '1' &&
      !JSON.stringify(frame.message).includes('context_rollover_') &&
      JSON.stringify(frame.message).includes('Disposable seed for manual refresh')) {
    // Exercise the real scoped capability, not a test-only receipt override.
    await new Promise(resolve => setTimeout(resolve, 30));
    const injectionId = JSON.stringify(frame.message).match(/Prompt injection fence: ([a-f0-9-]+)\./)?.[1];
    const response = await fetch(process.env.PONDEROSA_AGENT_MESSAGE_URL, { method: 'POST',
      headers: { authorization: `Bearer ${process.env.PONDEROSA_AGENT_MESSAGE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Disposable canonical seed reply', steeringInjectionId: injectionId }) });
    if (!response.ok) throw Error(`Disposable capability failed (${response.status})`);
  }
  send({ type: 'result', subtype: 'success', session_id: frame.session_id, is_error: false,
    result: 'Disposable result', usage: { input_tokens: 9999999, output_tokens: 8 } });
}
