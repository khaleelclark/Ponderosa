import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { AgentStore } from '@ponderosa/agents';
import { PONDEROSA_HISTORY_TOOL } from '@ponderosa/core';
import { artifactIdsIntersectingTextRange } from '../../apps/server/dist/artifact-refs.js';
import { readableArtifactReferences } from '../../apps/server/dist/communication-artifacts.js';
import { registerAgentRuntimeToolRoutes } from '../../apps/server/dist/routes/agent-runtime-tools.js';

test('history keeps linked messages searchable and reads complete text with bounded authorized file metadata', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-history-file-metadata-'));
  const store = new AgentStore(root), app = Fastify();
  let passed = false;
  try {
    const project = store.createProject({ label: 'History metadata', hostPath: root, defaultEngine: 'codex' });
    const chat = store.createConversation(project.id, { title: 'History metadata' });
    const agent = store.createAgent(project.id, { title: 'Reader', engine: 'codex', conversationId: chat.id });
    const ids = Array.from({ length: 120 }, (_, index) => `linked-file-${index}`);
    const body = 'Amber compass retained files 😀\n' + ids.map(id => `[Complete file ${id}](ponderosa://artifact/${id})`).join('\n') + '\nEND 東京';
    const event = { schemaVersion: 2, eventId: randomUUID(), projectId: project.id, conversationId: chat.id,
      sender: { kind: 'user', userId: 'operator' }, intent: 'user_dm', audience: { kind: 'user_agent', userId: 'operator', agentId: agent.id },
      text: body, artifactIds: ['restricted-file'], createdAt: new Date().toISOString(),
      document: { id: 'primary-document', artifactId: 'primary-document', title: 'Complete document', mediaType: 'text/markdown', byteLength: 123, createdAt: new Date().toISOString() } };
    store.appendCommunicationEvent(event);
    const token = 'owned-history-metadata-token', run = { runId: 'owned-run', executionId: 'owned-execution', messageCapability: token, conversationId: chat.id, controller: new AbortController() };
    const capability = { agentId: agent.id, runId: run.runId, conversationId: chat.id, historyRetrievalBoundary: store.communicationHistoryBoundary(project.id),
      historyRetrievalExcludedCommunicationEventIds: [], availableToolNames: [PONDEROSA_HISTORY_TOOL.name] };
    const resolved = [];
    // The established authorization/storage owners are controlled here; other
    // Files & Results checks qualify the real managed file bytes and hashes.
    store.getProjectArtifact = (owner, id) => owner === project.id ? { id, projectId: owner } : undefined;
    store.agentCanReadProjectArtifact = (owner, id, reader) => owner === project.id && reader === agent.id && id !== 'restricted-file';
    const assets = { pendingGeneratedArtifactImports: () => [], authoritativeManagedProjectArtifact: (owner, artifact) => {
      assert.equal(owner, project.id); assert.notEqual(artifact.id, 'restricted-file'); resolved.push(artifact.id);
      return { localPath: path.join(root, ...Array(16).fill('verified-managed-path'.repeat(4)), artifact.id), byteLength: 123, contentHash: 'a'.repeat(64) };
    } };
    registerAgentRuntimeToolRoutes(app, { store, assets, agentMessageCapabilities: new Map([[token, capability]]), activeRuns: new Map([[agent.id, run]]),
      deletingProjectIds: new Set(), deletingAgentIds: new Set(), deletingConversationIds: new Set(), capabilityOwnsAuthoritativeRun: (c, r) => c.runId === r?.runId });
    const call = async payload => {
      const result = await app.inject({ method: 'POST', url: '/api/agent-history', headers: { authorization: `Bearer ${token}` }, payload });
      assert.equal(result.statusCode, 200, result.body); const data = result.json();
      assert.equal(data.utf8Bytes, Buffer.byteLength(JSON.stringify(data))); return data;
    };
    const found = await call({ action: 'search', query: 'Amber compass' });
    assert.equal(found.hits.length, 1); assert.ok(found.utf8Bytes <= 6_000);
    assert.equal(found.hits[0].referencedFiles, undefined); assert.equal(resolved.length, 0, 'Search must not resolve full-file metadata');
    let continuation, offset = 0, reconstructed = '', omitted = 0;
    do {
      const page = await call({ action: 'read', communicationEventId: event.eventId, before: 0, after: 0, ...(continuation ? { continuation } : {}) });
      const message = page.messages[0]; assert.ok(page.utf8Bytes <= 8_000); assert.equal(message.startCodePoint, offset); assert.ok(message.endCodePoint > offset);
      assert.equal(message.referencedFiles[0].artifactId, 'primary-document'); assert.equal(message.referencedFiles[0].sha256, 'a'.repeat(64));
      const supplemental = message.referencedFiles.filter(file => file.artifactId !== 'primary-document');
      assert.ok(Buffer.byteLength(JSON.stringify(supplemental)) <= 2_048);
      const start = [...body].slice(0, message.startCodePoint).join('').length, end = [...body].slice(0, message.endCodePoint).join('').length;
      const relevant = new Set(artifactIdsIntersectingTextRange(body, start, end));
      assert.ok(supplemental.every(file => file.artifactId === 'restricted-file' ? file.available === false : relevant.has(file.artifactId)));
      omitted += message.referencedFilesOmitted ?? 0;
      reconstructed += message.text; offset = message.endCodePoint; continuation = message.continuation;
    } while (continuation);
    assert.equal(reconstructed, body); assert.equal(offset, [...body].length); assert.ok(omitted > 0);
    assert.throws(() => readableArtifactReferences({ projectId: project.id, agentId: agent.id, store, assets, artifactIds: ids }), /too many referenced artifacts/, 'Prompt resolver keeps its existing 100-file refusal');
    assets.authoritativeManagedProjectArtifact = () => ({ localPath: '/' + 'oversized-primary-path'.repeat(500), byteLength: 123, contentHash: 'a'.repeat(64) });
    const oversized = await app.inject({ method: 'POST', url: '/api/agent-history', headers: { authorization: `Bearer ${token}` },
      payload: { action: 'read', communicationEventId: event.eventId, before: 0, after: 0 } });
    assert.equal(oversized.statusCode, 400); assert.match(oversized.json().error, /metadata exceeds the response budget/);
    passed = true;
  } finally {
    await app.close(); store.close();
    if (passed) await rm(root, { recursive: true, force: true }); else t.diagnostic(`Retained owned metadata fixture: ${root}`);
  }
});

test('chunk reference ranges retain split links and exclude adjacent complete links', () => {
  const reference = 'ponderosa://artifact/' + 'a'.repeat(256), before = 'ponderosa://artifact/before ';
  const text = before + reference + ' ponderosa://artifact/after';
  const midpoint = before.length + 70;
  assert.deepEqual(artifactIdsIntersectingTextRange(text, midpoint, midpoint + 10), ['a'.repeat(256)]);
  assert.deepEqual(artifactIdsIntersectingTextRange(text, before.length, before.length + reference.length), ['a'.repeat(256)]);
});
