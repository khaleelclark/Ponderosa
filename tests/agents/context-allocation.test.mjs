import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { compileActivationPrompt } from '../../apps/server/dist/coordination-v3-scheduler.js';
import { resolveCoordinationResultArtifacts } from '../../apps/server/dist/coordination-scheduler-service.js';

// Execute the actual synchronous registration prefix, before HTTP handlers.
// Controlled stores expose scan counts and failures without a provider Run.
const ts = createRequire(new URL('../../apps/web/package.json', import.meta.url))('typescript');
const source = ts.createSourceFile('routes.ts', readFileSync(new URL('../../apps/server/src/routes/agent-runtime-tools.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const register = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'registerAgentRuntimeToolRoutes');
const prefix = [];
for (const statement of register.body.statements) {
  if (ts.isExpressionStatement(statement) && statement.getText(source).startsWith('app.post')) break;
  prefix.push(statement.getText(source));
}
const recover = vm.runInNewContext(ts.transpileModule(`(context) => { ${prefix.join('\n')} return projectImportReceipt; }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText);
const receipt = (id, agentId = 'agent') => ({ runId: 'run', artifact: { id, agentId, projectId: 'project', createdAt: '2026-10-19T00:00:00Z' } });
function recovery(pending, options = {}) {
  const logs = new Map(), scans = [], appended = [], catalog = [], marked = [], published = [], quarantined = [];
  const context = {
    store: {
      getProject: id => id === 'project' ? {} : undefined,
      getAgent: id => id !== 'missing' ? { id } : undefined,
      readEvents: id => { scans.push(id); return [...(logs.get(id) ?? [])]; },
      appendEvent: (id, event) => {
        if (options.appendError) throw options.appendError;
        const stored = { event }; appended.push(stored); logs.set(id, [...(logs.get(id) ?? []), stored]); return stored;
      },
      recordProjectArtifact: artifact => catalog.push(artifact),
    },
    assets: {
      pendingGeneratedArtifactImports: () => pending,
      generatedArtifactImportIsAvailable: r => r.artifact.id !== 'unavailable',
      quarantineGeneratedArtifactImport: r => quarantined.push(r),
      markGeneratedArtifactImportProjected: r => marked.push(r),
    },
    publish: (id, stored) => published.push(stored),
  };
  options.seed?.(logs);
  return { project: () => recover(context), logs, scans, appended, catalog, marked, published, quarantined };
}
test('startup projects thirty receipts with one history scan per Agent and no duplicate event', () => {
  const pending = Array.from({ length: 30 }, (_, i) => receipt('artifact-' + i));
  pending.push(receipt('artifact-0'), receipt('artifact-0', 'second'));
  const f = recovery(pending, { seed: logs => logs.set('agent', [{ event: { type: 'text', text: 'artifact-0' } }, { event: { type: 'generated_artifact', artifactId: 'artifact-0' } }]) });
  f.project(); assert.deepEqual(f.scans, ['agent', 'second']); assert.equal(f.appended.length, 30);
  assert.equal(f.catalog.length, 32); assert.equal(f.marked.length, 32); assert.equal(f.published.length, 30);
});
test('later receipt operations reread current history instead of retaining recovery cache', () => {
  const f = recovery([receipt('old')]), project = f.project();
  f.logs.set('agent', [...f.logs.get('agent'), { event: { type: 'generated_artifact', artifactId: 'external' } }]);
  project(receipt('external')); project(receipt('new')); project(receipt('new'));
  assert.equal(f.scans.length, 4); assert.equal(f.appended.length, 2);
});
test('invalid recovery owners and unavailable bytes quarantine before reading history', () => {
  const f = recovery([receipt('unavailable'), receipt('x', 'missing'), { ...receipt('wrong'), artifact: { ...receipt('wrong').artifact, projectId: 'foreign' } }]);
  f.project(); assert.equal(f.quarantined.length, 3); assert.equal(f.scans.length, 0); assert.equal(f.appended.length, 0);
});
test('failed durable append never marks, catalogs or publishes a receipt', () => {
  const failure = Error('owned append failure'), f = recovery([receipt('new')], { appendError: failure });
  assert.throws(f.project, error => error === failure); assert.equal(f.marked.length + f.catalog.length + f.published.length, 0);
});
const activation = (id = 'activation', payload = {}) => ({ id, kind: 'coordination_outcome', priority: 0, promptClass: 'coordination', payload });
const lease = activations => ({ runId: 'run', injectionId: 'injection', activations });
function material(id, text, onRead = () => {}) {
  return { artifactId: id, title: 'Unicode 😀 "result"', mediaType: 'text/plain', byteLength: Buffer.byteLength(text), sha256: 'a'.repeat(64), localPath: '/owned/' + id, get content() { onRead(); return text; } };
}
test('oversized multi-result packet falls back without reading any content getter', () => {
  const activations = Array.from({ length: 24 }, (_, i) => activation('a' + i)); let reads = 0;
  const packet = compileActivationPrompt(lease(activations), { maxUtf8Bytes: 256 * 1024, resolveResultArtifacts: a => [material(a.id, 'x'.repeat(64 * 1024), () => reads++)] });
  assert.equal(reads, 0); assert.match(packet.prompt, /completeCorrelatedResultFile:/); assert.ok(Buffer.byteLength(packet.prompt) <= 256 * 1024);
  assert.equal((packet.prompt.match(/localPath:/g) ?? []).length, 24);
});
test('small Unicode results remain complete, deduplicated and byte exact with default envelope', () => {
  let reads = 0; const text = 'complete résultat 😀\n', value = material('same', text, () => reads++);
  const packet = compileActivationPrompt(lease([activation('a'), activation('b')]), { resolveResultArtifacts: () => [value] });
  assert.equal(reads, 1); assert.equal(packet.prompt.split(text).length - 1, 1); assert.match(packet.prompt, /BEGIN COMPLETE CORRELATED RESULT/);
});
test('exact envelope includes scaffolding, Unicode titles and escaped payload bytes', () => {
  const value = material('one', '😀'.repeat(2000)); const input = lease([activation('a', { text: '\\"😀'.repeat(20) })]);
  const full = compileActivationPrompt(input, { resolveResultArtifacts: () => [value] }).prompt;
  assert.equal(compileActivationPrompt(input, { maxUtf8Bytes: Buffer.byteLength(full), resolveResultArtifacts: () => [value] }).prompt, full);
  const fallback = compileActivationPrompt(input, { maxUtf8Bytes: Buffer.byteLength(full) - 1, resolveResultArtifacts: () => [value] }).prompt;
  assert.match(fallback, /completeCorrelatedResultFile:/); assert.ok(Buffer.byteLength(fallback) < Buffer.byteLength(full));
});
test('oversized file fallback and ordinary payload still fail closed', () => {
  const input = lease([activation()]);
  assert.throws(() => compileActivationPrompt(input, { maxUtf8Bytes: 1, resolveResultArtifacts: () => [material('a', 'x'.repeat(100))] }), /activation_payload_too_large/);
  assert.throws(() => compileActivationPrompt(input, { maxUtf8Bytes: 1 }), /activation_payload_too_large/);
});
test('aborted preparation never decodes an artifact', () => {
  const controller = new AbortController(); controller.abort(); let reads = 0;
  assert.throws(() => compileActivationPrompt(lease([activation()]), { signal: controller.signal, resolveResultArtifacts: () => [material('a', 'x', () => reads++)] }));
  assert.equal(reads, 0);
});
const runtimeArtifact = { id: 'result', projectId: 'project', ownerKind: 'request_update', ownerId: 'update', title: 'Exact result', mediaType: 'text/plain' };
const resultActivation = activation('exact', { updateId: 'update', update: { resultArtifactId: 'ponderosa://artifact/result' } });
test('resolver verifies every exact result before fallback but defers UTF8 materialization', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'ponderosa-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const localPath = path.join(root, 'result');
  const body = Buffer.from('verified 😀'.repeat(30000)); let verified = 0, decoded = 0;
  writeFileSync(localPath, body);
  const original = body.toString; body.toString = function(...args) { decoded++; return original.apply(this, args); };
  const values = await resolveCoordinationResultArtifacts({ activation: resultActivation, projectId: 'project', runtimeArtifact: () => runtimeArtifact, authoritative: async () => { verified++; return { body, byteLength: body.length, contentHash: 'a'.repeat(64), localPath }; } });
  assert.equal(verified, 1); assert.equal(decoded, 0); assert.equal(values.length, 1);
  const packet = compileActivationPrompt(lease([resultActivation]), { maxUtf8Bytes: 256 * 1024, resolveResultArtifacts: () => values });
  assert.match(packet.prompt, /completeCorrelatedResultFile:/); assert.equal(decoded, 0);
  assert.equal(values[0].content, original.call(body, 'utf8')); assert.equal(decoded, 1);
});
for (const [label, artifact] of [['foreign project', { ...runtimeArtifact, projectId: 'foreign' }], ['foreign owner', { ...runtimeArtifact, ownerId: 'other' }], ['wrong owner kind', { ...runtimeArtifact, ownerKind: 'communication' }], ['missing', undefined]]) {
  test(`resolver rejects ${label} before byte reads`, async () => {
    let reads = 0;
    await assert.rejects(resolveCoordinationResultArtifacts({ activation: resultActivation, projectId: 'project', runtimeArtifact: () => artifact, authoritative: async () => { reads++; } }), /exact_artifact_contract_mismatch/);
    assert.equal(reads, 0);
  });
}
test('unavailable verified bytes reject even if an oversized file fallback would fit', async () => {
  await assert.rejects(resolveCoordinationResultArtifacts({ activation: resultActivation, projectId: 'project', runtimeArtifact: () => runtimeArtifact, authoritative: async () => undefined }), /correlated_artifact_unavailable/);
});
test('large first result cannot bypass verification of a later correlated result', async () => {
  const activation = { ...resultActivation, payload: { updateId: 'update', update: { results: [{ resultArtifactId: 'ponderosa://artifact/result' }, { resultArtifactId: 'ponderosa://artifact/second' }] } } };
  const reads = [], body = Buffer.alloc(300000, 'x');
  const input = { activation, projectId: 'project', runtimeArtifact: id => ({ ...runtimeArtifact, id }), authoritative: async artifact => {
    reads.push(artifact.id);
    return artifact.id === 'result' ? { body, byteLength: body.length, contentHash: 'a'.repeat(64), localPath: process.execPath } : undefined;
  } };
  await assert.rejects(resolveCoordinationResultArtifacts(input), /correlated_artifact_unavailable/);
  assert.deepEqual(reads, ['result', 'second']);
});


test('complete input accounting distinguishes context policy, verified capacity and exact-session occupancy', async () => {
  const { providerInputBudget, estimateProviderInput } = await import('../../apps/server/dist/context-rollover-pressure.js');
  const policy = { contextRolloverTokens: 150000, contextRolloverWindowFraction: 0.7 };
  const unknown = providerInputBudget(policy);
  assert.equal(unknown.basis, 'context_policy'); assert.equal(unknown.windowTokens, undefined);
  assert.equal(unknown.inputCeilingTokens, 90000);
  assert.equal(unknown.responseHeadroomTokens, 60000);
  assert.equal(unknown.responseHeadroomBasis, 'policy_low_water_margin');
  const usage = { usedTokens: 1200, windowTokens: 200000, aggregateTokens: 900000, providerSessionGeneration: 'live' };
  const exact = providerInputBudget(policy, usage, { resumeSessionId: 'live' });
  assert.equal(exact.inputCeilingTokens, 140000); assert.equal(exact.responseHeadroomTokens, 60000);
  assert.equal(exact.occupancyTokens, 1200); assert.equal(exact.occupancyBasis, 'exact_session');
  const system = 'Required instructions 😀', tools = [{ name: 'fixture', description: 'Uncompressed schema \"' }], prompt = 'Current work 😀';
  const fresh = estimateProviderInput(providerInputBudget(policy, usage), system, tools, prompt);
  assert.equal(fresh.occupancyTokens, 0); assert.equal(fresh.occupancyBasis, 'fresh_session');
  assert.equal(fresh.submittedUtf8Bytes, Buffer.byteLength(JSON.stringify({ systemPrompt: system, tools, input: prompt })));
  const resumed = estimateProviderInput(exact, system, tools, prompt);
  assert.equal(resumed.estimatedInputTokens, 1200 + Buffer.byteLength(JSON.stringify({ input: prompt })));
  assert.throws(() => providerInputBudget(policy, usage, { resumeSessionId: 'discarded' }),
    error => error.statusCode === 413 && /context.*unavailable/i.test(error.message), 'Unknown retained occupancy cannot become zero');
  const hostEstimate = estimateProviderInput(providerInputBudget(policy, undefined, {
    resumeSessionId: 'legacy', estimatedSessionUtf8Bytes: 5000,
    occupancyObservation: { source: 'accepted_input_estimate', providerSessionId: 'legacy' },
  }), system, tools, prompt);
  assert.equal(hostEstimate.occupancyBasis, 'estimated_session'); assert.equal(hostEstimate.occupancyTokens, 5000);
  assert.equal(hostEstimate.submittedUtf8Bytes, Buffer.byteLength(JSON.stringify({ input: prompt })));
  const smallKnown = providerInputBudget(policy, { usedTokens: 0, windowTokens: 10000 });
  assert.equal(smallKnown.inputCeilingTokens, 7000); assert.equal(smallKnown.responseHeadroomTokens, 3000);
  const replacement = providerInputBudget(policy, usage, { replacementLowWaterMark: 50000 });
  assert.equal(replacement.inputCeilingTokens, 49999);
});


test('near-full handoff accounts for its real remaining window without inventing unknown capacity', async () => {
  const { providerInputBudget, estimateProviderInput } = await import('../../apps/server/dist/context-rollover-pressure.js');
  const policy = { contextRolloverTokens: 150000, contextRolloverWindowFraction: 0.7 };
  const live = { usedTokens: 160000, windowTokens: 200000, providerSessionGeneration: 'handoff' };
  const known = estimateProviderInput(providerInputBudget(policy, live, { resumeSessionId: 'handoff', handoff: true }),
    'Retained instructions', [{ name: 'retained_tools' }], 'Write the required canonical handoff');
  assert.equal(known.occupancyTokens, 160000);
  assert.equal(known.responseHeadroomBasis, 'handoff_remaining_window');
  assert.equal(known.responseHeadroomTokens, 200000 - known.estimatedInputTokens);
  assert.ok(known.responseHeadroomTokens > 0);
  assert.ok(known.estimatedInputTokens > 140000 && known.estimatedInputTokens < 200000);
  const unknown = estimateProviderInput(providerInputBudget(policy,
    { usedTokens: 160000, providerSessionGeneration: 'handoff' }, { resumeSessionId: 'handoff', handoff: true }),
    'Retained instructions', [], 'Write the required canonical handoff');
  assert.equal(unknown.windowTokens, undefined);
  assert.equal(unknown.inputCeilingTokens + unknown.responseHeadroomTokens, 150000);
  assert.ok(unknown.estimatedInputTokens > unknown.inputCeilingTokens);
});
